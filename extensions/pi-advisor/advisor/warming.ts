import { createHash } from "node:crypto";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	ThinkingLevel,
	Usage,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ADVISOR_WARMING_USAGE, type AdvisorRequest, advisorBranchUsage, refreshAdvisorStatus } from "./budget.js";
import { type AdvisorWarming, loadAdvisorConfig, validateAdvisorBudget, validateAdvisorWarming } from "./config.js";
import { getInventoryMessage, stableStringify } from "./inventory.js";
import { getRuntimeUsageRecorder } from "./pi-compat.js";
import { isExecutorBlocked } from "./policy.js";
import { getAdvisorEffort, getAdvisorModel } from "./state.js";

export function advisorPayloadHash(payload: unknown): string {
	const p = payload as Record<string, unknown>;
	return createHash("sha256")
		.update(
			stableStringify({
				model: p.model,
				system: p.system,
				instructions: p.instructions,
				input: p.input,
				messages: p.messages,
				tools: p.tools,
				thinking: p.thinking,
				reasoning: p.reasoning,
			}),
		)
		.digest("hex");
}

export function advisorWarmingEconomics(model: Model<Api>, usage: Usage, config: AdvisorWarming) {
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	const refreshUsd = (promptTokens * model.cost.cacheRead + 16 * model.cost.output) / 1e6;
	const writePrice =
		model.api === "anthropic-messages" && process.env.PI_CACHE_RETENTION === "long"
			? Math.max(model.cost.cacheWrite, model.cost.input * 2)
			: model.cost.cacheWrite;
	const coldUsd = (promptTokens * Math.max(model.cost.input, writePrice) + 16 * model.cost.output) / 1e6;
	// ponytail: fixed reuse probability; calibrate from usage reports before adding adaptive scheduling.
	const expectedSavingsUsd =
		(config.continueProbability * promptTokens * (model.cost.input - model.cost.cacheRead)) / 1e6 - refreshUsd;
	return { promptTokens, refreshUsd, coldUsd, expectedSavingsUsd };
}

interface Candidate {
	ctx: ExtensionContext;
	model: Model<Api>;
	effort?: ThinkingLevel;
	context: Context;
	options: SimpleStreamOptions;
	request: AdvisorRequest;
	usage: Usage;
	complete: (model: Model<Api>, context: Context, options: SimpleStreamOptions) => Promise<AssistantMessage>;
}

interface Warmer {
	stop(): Promise<void>;
	remember(candidate: Candidate): void;
}
const warmers = new WeakMap<ExtensionAPI, Warmer>();

export async function stopAdvisorWarming(pi: ExtensionAPI): Promise<void> {
	await warmers.get(pi)?.stop();
}
export function rememberAdvisorRequest(pi: ExtensionAPI, candidate: Candidate): void {
	try {
		warmers.get(pi)?.remember(candidate);
	} catch {
		/* Optional maintenance must not replace a successful consultation result. */
	}
}

export function registerAdvisorWarming(pi: ExtensionAPI): void {
	let active = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let controller: AbortController | undefined;
	let running: Promise<void> | undefined;
	let generation = 0;
	const stop = async () => {
		generation++;
		clearTimeout(timer);
		timer = undefined;
		controller?.abort();
		await running;
	};
	const remember = (candidate: Candidate) => {
		const { ctx, model, context, options, request, complete } = candidate;
		if (!active || !request.payloadHash || options.cacheRetention === "none") return;
		const recordUsage = getRuntimeUsageRecorder(ctx.sessionManager);
		if (!recordUsage) return;
		const started = Date.now();
		const sessionId = ctx.sessionManager.getSessionId();
		const inventory = JSON.stringify(getInventoryMessage(pi.getAllTools()));
		const modelSettings = JSON.stringify(model);
		const retentionSetting = process.env.PI_CACHE_RETENTION;
		const ticket = ++generation;
		let usage = candidate.usage;
		let lastRequest = request;
		const schedule = () => {
			const config = validateAdvisorWarming(loadAdvisorConfig().warming);
			const retention = process.env.PI_CACHE_RETENTION === "long" ? "long" : "short";
			const ttl =
				config.ttlSec ||
				(model as Model<Api> & { promptCache?: { short?: number; long?: number } }).promptCache?.[retention];
			if (!config.enabled || !ttl || ttl < 30 || !model.cost || !active || ticket !== generation) return;
			const delay = Math.max(0, lastRequest.timestamp + Math.min(ttl * 900, ttl * 1000 - 10000) - Date.now());
			if (delay > 2147483647) return;
			if (Date.now() + delay - started >= config.maxDurationSec * 1000) return;
			clearTimeout(timer);
			timer = setTimeout(() => {
				running = refresh(ttl)
					.catch((error) => {
						console.warn(
							`[rpiv-advisor] cache refresh stopped: ${error instanceof Error ? error.message : String(error)}`,
						);
					})
					.finally(() => {
						running = undefined;
						controller = undefined;
					});
			}, delay);
			timer.unref?.();
		};
		const refresh = async (ttl: number) => {
			const config = loadAdvisorConfig();
			const warming = validateAdvisorWarming(config.warming);
			const budget = validateAdvisorBudget(config.budget);
			const advisor = getAdvisorModel();
			if (
				!active ||
				ticket !== generation ||
				!warming.enabled ||
				ctx.isIdle() ||
				ctx.sessionManager.getSessionId() !== sessionId ||
				advisor?.id !== model.id ||
				advisor.provider !== model.provider ||
				JSON.stringify(advisor) !== modelSettings ||
				process.env.PI_CACHE_RETENTION !== retentionSetting ||
				getAdvisorEffort() !== candidate.effort ||
				isExecutorBlocked(ctx, pi.getThinkingLevel()) ||
				JSON.stringify(getInventoryMessage(pi.getAllTools())) !== inventory ||
				Date.now() - lastRequest.timestamp >= ttl * 1000 ||
				Date.now() - started >= warming.maxDurationSec * 1000
			)
				return;
			const economics = advisorWarmingEconomics(model, usage, warming);
			const spent = advisorBranchUsage(ctx.sessionManager.getBranch())?.cost.total ?? 0;
			if (
				economics.promptTokens < warming.minPromptTokens ||
				economics.expectedSavingsUsd <= 0 ||
				economics.expectedSavingsUsd < warming.minSavingsUsd ||
				economics.coldUsd > budget.perCallHardUsd ||
				spent + economics.coldUsd > budget.sessionUsd
			)
				return;
			controller = new AbortController();
			const sentAt = Date.now();
			const response = await complete(model, context, {
				...options,
				signal: controller.signal,
				maxTokens: 16,
				timeoutMs: 30000,
				maxRetries: 0,
				onPayload(payload) {
					const p = payload as Record<string, unknown>;
					if (advisorPayloadHash(payload) !== request.payloadHash)
						throw new Error("refresh prompt changed before dispatch");
					if (model.api === "anthropic-messages") {
						if (p.thinking && (p.thinking as { type?: string }).type !== "adaptive")
							throw new Error("budgeted thinking cannot be refreshed with a small output cap");
						p.max_tokens = 16;
					} else if (model.api === "openai-responses") p.max_output_tokens = 16;
					else if (model.api === "openai-completions") {
						if ("max_completion_tokens" in p) p.max_completion_tokens = 16;
						else p.max_tokens = 16;
					} else throw new Error("unsupported cache refresh API");
				},
			});
			if (response.usage) {
				lastRequest = { ...request, timestamp: sentAt };
				recordUsage(
					ADVISOR_WARMING_USAGE,
					model.provider,
					model.id,
					response.usage,
					JSON.stringify({ request: lastRequest, stopReason: response.stopReason, economics }),
				);
				refreshAdvisorStatus(ctx);
			}
			if (response.stopReason === "error" || response.stopReason === "aborted" || !response.usage?.cacheRead) return;
			usage = response.usage;
			schedule();
		};
		schedule();
	};
	warmers.set(pi, { stop, remember });
	pi.on("agent_start", () => {
		active = true;
	});
	pi.on("agent_end", async () => {
		active = false;
		await stop();
	});
	pi.on("session_before_compact", stop);
	pi.on("session_before_tree", stop);
	pi.on("session_before_switch", stop);
	pi.on("session_before_fork", stop);
	pi.on("session_shutdown", stop);
	pi.on("model_select", stop);
	pi.on("thinking_level_select", stop);
}
