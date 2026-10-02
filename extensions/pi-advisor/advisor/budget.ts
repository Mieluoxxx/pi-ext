import { createHash } from "node:crypto";
import type { Api, Message, Model, ThinkingLevel, Usage } from "@earendil-works/pi-ai";
import { type ExtensionContext, estimateTokens, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AdvisorBudget } from "./config.js";
import { ADVISOR_TOOL_NAME } from "./messages.js";

export interface AdvisorRequest {
	hash: string;
	messageCount: number;
	estimatedTokens: number;
	timestamp: number;
	payloadHash?: string;
	/**
	 * Fingerprint of the append-only prefix only — every message except the last,
	 * which carries the verbatim tail and the current question.
	 *
	 * The tail is re-rendered on every consultation by design (older rounds
	 * collapse to cards), so `hash` over the whole message list never matches
	 * twice and would price every request as cold. Cache reuse is predicted from
	 * this prefix instead. Absent on records written before the ledger, which
	 * are therefore priced cold.
	 */
	stableHash?: string;
	stableMessageCount?: number;
	/** Estimated tokens of that prefix, for scaling the prior measured prompt. */
	stableEstimatedTokens?: number;
	/** Ledger render version; a bump invalidates cross-version comparison. */
	ledgerVersion?: number;
}

export const ADVISOR_WARMING_USAGE = "advisor-cache-warming";
/** Native usage kind of a background completion review; its note carries the envelope details. */
export const ADVISOR_REVIEW_USAGE = "advisor-completion-review";

export interface AdvisorEstimate {
	promptTokens: number;
	cacheReadTokens: number;
	outputTokens: number;
	costUsd: number;
	coldCostUsd: number;
	sessionUsd: number;
}

export interface AdvisorAttempt {
	usage?: Usage;
	stopReason: string;
	errorMessage?: string;
}

export function sumAdvisorUsage(usages: (Usage | undefined)[]): Usage | undefined {
	let total: Usage | undefined;
	for (const usage of usages) {
		if (!usage) continue;
		total ??= {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		for (const key of [
			"input",
			"output",
			"cacheRead",
			"cacheWrite",
			"totalTokens",
			"cacheWrite1h",
			"reasoning",
		] as const) {
			if (usage[key] !== undefined) total[key] = (total[key] ?? 0) + usage[key];
		}
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
			total.cost[key] += usage.cost[key];
	}
	return total;
}

function advisorRecords(branch: readonly SessionEntry[]) {
	return branch.flatMap((entry) => {
		const metered = entry as unknown as {
			type: string;
			kind?: string;
			provider?: string;
			model?: string;
			usage?: Usage;
			note?: string;
		};
		if (metered.type === "usage" && metered.kind === ADVISOR_WARMING_USAGE) {
			let note: { request?: AdvisorRequest; stopReason?: string } = {};
			try {
				note = JSON.parse(metered.note ?? "{}");
			} catch {
				/* Older records may have a plain-text note. */
			}
			return [
				{
					usage: metered.usage,
					details: {
						advisorModel: `${metered.provider}:${metered.model}`,
						request: note.request,
						warming: true,
						attempts: [{ usage: metered.usage, stopReason: note.stopReason ?? "error" }],
					},
				},
			];
		}
		if (metered.type === "usage" && metered.kind === ADVISOR_REVIEW_USAGE) {
			let note: { request?: AdvisorRequest; effort?: ThinkingLevel; attempts?: AdvisorAttempt[]; skipped?: boolean } =
				{};
			try {
				note = JSON.parse(metered.note ?? "{}");
			} catch {
				/* A malformed note still bills; it just cannot seed cache estimation. */
			}
			return [
				{
					usage: metered.usage,
					details: {
						advisorModel: `${metered.provider}:${metered.model}`,
						effort: note.effort,
						request: note.request,
						attempts: note.attempts ?? [{ usage: metered.usage, stopReason: "error" }],
						skipped: note.skipped,
					},
				},
			];
		}
		if (
			entry.type !== "message" ||
			entry.message.role !== "toolResult" ||
			entry.message.toolName !== ADVISOR_TOOL_NAME
		)
			return [];
		// Top-level tool usage was added in Pi 0.86. Older transcripts only have details.usage.
		const message = entry.message as typeof entry.message & { usage?: Usage };
		const details = message.details as
			| {
					advisorModel?: string;
					effort?: ThinkingLevel;
					usage?: Usage;
					attempts?: AdvisorAttempt[];
					request?: AdvisorRequest;
					skipped?: boolean;
					warming?: boolean;
			  }
			| undefined;
		return [{ usage: message.usage ?? details?.usage, details }];
	});
}

export function advisorBranchUsage(branch: readonly SessionEntry[]): Usage | undefined {
	return sumAdvisorUsage(advisorRecords(branch).map((record) => record.usage));
}

export function refreshAdvisorStatus(ctx: ExtensionContext, pending?: Usage): void {
	try {
		if (!ctx.hasUI) return;
		const usage = sumAdvisorUsage([advisorBranchUsage(ctx.sessionManager.getBranch()), pending]);
		const prompt = usage ? usage.input + usage.cacheRead + usage.cacheWrite : 0;
		ctx.ui.setStatus(
			"advisor",
			usage
				? `Advisor $${usage.cost.total.toFixed(2)} · cache ${prompt ? `${Math.round((100 * usage.cacheRead) / prompt)}%` : "n/a"}`
				: undefined,
		);
	} catch {
		// A replaced session UI must not discard already billed side-call usage.
	}
}

export function estimateAdvisorRequest(
	branch: readonly SessionEntry[],
	messages: Message[],
	systemPrompt: string,
	model: Model<Api>,
	effort: ThinkingLevel | undefined,
	budget: AdvisorBudget,
	sessionId: string,
	now = Date.now(),
	/** Length of the append-only prefix; defaults to the whole list. */
	stableMessageCount = messages.length,
	ledgerVersion?: number,
): { estimate: AdvisorEstimate; request: AdvisorRequest } {
	const modelLabel = `${model.provider}:${model.id}`;
	const records = advisorRecords(branch);
	let boundary = -1;
	for (let i = 0; i < branch.length; i++) {
		if (branch[i].type === "compaction" || branch[i].type === "branch_summary") boundary = i;
	}
	const previous = advisorRecords(branch.slice(boundary + 1))
		.reverse()
		.find((r) => r.details?.request);
	const prior = previous?.details?.request;
	// A prior record from a different ledger version describes a different
	// rendering of the same branch; its hash cannot be compared to this one.
	const comparable = prior && prior.ledgerVersion === ledgerVersion;
	const priorStableCount = comparable ? (prior.stableMessageCount ?? prior.messageCount) : undefined;
	const priorStableHash = comparable ? (prior.stableHash ?? prior.hash) : undefined;
	const hash = createHash("sha256").update(
		JSON.stringify([systemPrompt, modelLabel, model.api, model.baseUrl, effort, sessionId]),
	);
	let prefixHash: string | undefined;
	let stableHash: string | undefined;
	let estimatedTokens = Math.ceil(systemPrompt.length / 4);
	let stableTokens = estimatedTokens;
	if (priorStableCount === 0) prefixHash = hash.copy().digest("hex");
	if (stableMessageCount === 0) stableHash = hash.copy().digest("hex");
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		// Exclude bookkeeping (usage/details/timestamps) from the prompt fingerprint.
		hash.update(
			JSON.stringify(
				m.role === "assistant"
					? [m.role, m.content, m.api, m.provider, m.model, m.stopReason]
					: m.role === "toolResult"
						? [m.role, m.content, m.toolCallId, m.toolName, m.isError]
						: [m.role, m.content],
			),
		);
		estimatedTokens += estimateTokens(m);
		if (i + 1 === priorStableCount) prefixHash = hash.copy().digest("hex");
		if (i + 1 === stableMessageCount) {
			stableHash = hash.copy().digest("hex");
			stableTokens = estimatedTokens;
		}
	}
	const samePrefix =
		prior && priorStableHash !== undefined && priorStableHash === prefixHash &&
		previous?.details?.advisorModel === modelLabel;
	const priorUsage = previous?.details?.attempts?.at(-1)?.usage ?? previous?.usage;
	const priorPrompt = priorUsage ? priorUsage.input + priorUsage.cacheRead + priorUsage.cacheWrite : 0;
	// ponytail: host chars/4 heuristic with 20% headroom; calibrate from actual prompt usage when the prefix matches.
	const promptTokens = Math.ceil(
		samePrefix && priorPrompt > 0
			? priorPrompt + Math.max(0, estimatedTokens - prior.estimatedTokens) * 1.2
			: estimatedTokens * 1.2,
	);
	const lastAttempt = previous?.details?.attempts?.at(-1);
	const completed =
		!previous?.details?.skipped && lastAttempt?.stopReason !== "error" && lastAttempt?.stopReason !== "aborted";
	// Only the shared prefix can be read from cache: the prior request's own tail
	// was re-rendered for this one, so `priorPrompt` (its whole measured prompt)
	// overstates reuse. Scale it by the prefix share the SAME estimator computed
	// for that request, so the chars/4 bias cancels instead of compounding.
	const priorShare =
		prior?.stableEstimatedTokens !== undefined && prior.estimatedTokens > 0
			? Math.min(1, prior.stableEstimatedTokens / prior.estimatedTokens)
			: 1;
	const reusableTokens = Math.floor(priorPrompt * priorShare);
	const cacheReadTokens =
		completed && samePrefix && now >= prior.timestamp && now - prior.timestamp < budget.warmWindowSec * 1000
			? Math.min(promptTokens, reusableTokens)
			: 0;
	const outputs = records
		.filter((r) => !r.details?.warming && r.details?.advisorModel === modelLabel && r.details?.effort === effort)
		.flatMap((r) => r.details?.attempts?.map((a) => a.usage?.output) ?? [r.usage?.output])
		.filter((n): n is number => n !== undefined && n > 0)
		.slice(-5);
	// Without matching consultation history, estimate input cost only; maxTokens is
	// not an expected output length.
	const outputTokens = outputs.length ? Math.ceil(outputs.reduce((a, b) => a + b, 0) / outputs.length) : 0;
	const cost = model.cost ?? { input: 0, cacheRead: 0, output: 0 };
	const coldCostUsd = (promptTokens * cost.input + outputTokens * cost.output) / 1e6;
	return {
		request: {
			hash: hash.digest("hex"),
			messageCount: messages.length,
			estimatedTokens,
			timestamp: now,
			...(stableHash === undefined ? {} : { stableHash }),
			stableMessageCount,
			stableEstimatedTokens: stableTokens,
			...(ledgerVersion === undefined ? {} : { ledgerVersion }),
		},
		estimate: {
			promptTokens,
			cacheReadTokens,
			outputTokens,
			coldCostUsd,
			costUsd:
				((promptTokens - cacheReadTokens) * cost.input +
					cacheReadTokens * cost.cacheRead +
					outputTokens * cost.output) /
				1e6,
			sessionUsd: advisorBranchUsage(branch)?.cost.total ?? 0,
		},
	};
}

export async function approveAdvisorCost(
	ctx: ExtensionContext,
	estimate: AdvisorEstimate,
	budget: AdvisorBudget,
	spent = 0,
): Promise<boolean> {
	if (
		estimate.costUsd + spent <= budget.perCallHardUsd &&
		estimate.sessionUsd + spent + estimate.costUsd <= budget.sessionUsd
	)
		return true;
	return (
		ctx.hasUI &&
		budget.onExceed === "confirm" &&
		(await ctx.ui.confirm(
			"Advisor budget",
			`Estimated next request: $${estimate.costUsd.toFixed(2)} (cold cache: $${estimate.coldCostUsd.toFixed(2)}). ` +
				`Call including attempts: $${(spent + estimate.costUsd).toFixed(2)} / $${budget.perCallHardUsd.toFixed(2)}; ` +
				`branch including this request: $${(estimate.sessionUsd + spent + estimate.costUsd).toFixed(2)} / $${budget.sessionUsd.toFixed(2)}. Continue?`,
		))
	);
}
