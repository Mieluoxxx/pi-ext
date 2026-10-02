/**
 * execute — the advisor side-call. Compiles the executor's branch into a
 * ledger (older tool rounds as one-line cards, the last few verbatim), runs the
 * bounded tool loop against the advisor model, and returns a structured tool
 * result. Every result branch (success / abort / error / empty) and the
 * pre-call error paths funnel through buildAdvisorResult so the envelope is
 * built in exactly one place.
 */

import type { Context, Message, StopReason, ThinkingLevel, Usage } from "@earendil-works/pi-ai";
import {
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ADVISOR_ANCHOR_ENTRY, type AdvisorAnchor, advisorAnchorBoundary, advisorSavedAnchor } from "./anchor.js";
import {
	type AdvisorAttempt,
	type AdvisorEstimate,
	type AdvisorRequest,
	approveAdvisorCost,
	estimateAdvisorRequest,
	refreshAdvisorStatus,
	sumAdvisorUsage,
} from "./budget.js";
import {
	loadAdvisorConfig,
	validateAdvisorBudget,
	validateAdvisorLedger,
	validateAdvisorTools,
} from "./config.js";
import { getInventoryMessage } from "./inventory.js";
import { LEDGER_VERSION, type LedgerView, renderLedger } from "./ledger.js";
import { runAdvisorLoop, type AdvisorLoopRound } from "./loop.js";
import {
	ERR_ABORTED_DETAIL,
	ERR_CALL_ABORTED,
	ERR_EMPTY_RESPONSE,
	ERR_EMPTY_RESPONSE_DETAIL,
	ERR_NO_MODEL,
	ERR_NO_MODEL_SELECTED,
	errCallFailed,
	errCallThrew,
	errMisconfigured,
	errNoApiKey,
	errNoApiKeyDetail,
	msgConsulting,
} from "./messages.js";
import { getRuntimeCompleteSimple, loadCompleteSimple } from "./pi-compat.js";
import { ADVISOR_SYSTEM_PROMPT } from "./prompt.js";
import { getAdvisorEffort, getAdvisorModel } from "./state.js";
import { createAdvisorToolRuntime } from "./tools.js";
import { advisorPayloadHash, rememberAdvisorRequest, stopAdvisorWarming } from "./warming.js";

interface AdvisorDetails {
	context?: {
		trimmed: boolean;
		anchorEntryId?: string;
		originalPromptTokens: number;
		/** Rendered message count, for offline payload comparison. */
		messageCount?: number;
	};
	attempts?: AdvisorAttempt[];
	estimate?: AdvisorEstimate;
	request?: AdvisorRequest;
	skipped?: boolean;
	advisorModel?: string;
	effort?: ThinkingLevel;
	usage?: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
	/** What the advisor investigated before answering. */
	rounds?: AdvisorLoopRound[];
	budgetExhausted?: boolean;
}

// Single result-envelope builder — every executeAdvisor branch and the pre-call
// error paths funnel through here. `effort` is snapshotted once at executeAdvisor
// entry and threaded through every call so the returned details.effort always
// matches the value sent as `reasoning` to completeSimple, even if module-level
// state is mutated during the await window.
type AdvisorResult = AgentToolResult<AdvisorDetails> & { usage?: Usage };

function buildAdvisorResult(opts: {
	text: string;
	context?: AdvisorDetails["context"];
	attempts?: AdvisorAttempt[];
	estimate?: AdvisorEstimate;
	request?: AdvisorRequest;
	skipped?: boolean;
	effort: ThinkingLevel | undefined;
	advisorLabel?: string;
	usage?: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
	rounds?: AdvisorLoopRound[];
	budgetExhausted?: boolean;
}): AdvisorResult {
	const details: AdvisorDetails = { effort: opts.effort };
	if (opts.context) details.context = opts.context;
	if (opts.attempts) details.attempts = opts.attempts;
	if (opts.estimate) details.estimate = opts.estimate;
	if (opts.request) details.request = opts.request;
	if (opts.skipped) details.skipped = true;
	if (opts.advisorLabel !== undefined) details.advisorModel = opts.advisorLabel;
	if (opts.usage !== undefined) details.usage = opts.usage;
	if (opts.stopReason !== undefined) details.stopReason = opts.stopReason;
	if (opts.errorMessage !== undefined) details.errorMessage = opts.errorMessage;
	if (opts.rounds?.length) details.rounds = opts.rounds;
	if (opts.budgetExhausted) details.budgetExhausted = true;
	return { content: [{ type: "text", text: opts.text }], details, ...(opts.usage ? { usage: opts.usage } : {}) };
}

function buildErrorResult(
	advisorLabel: string | undefined,
	effort: ThinkingLevel | undefined,
	userText: string,
	errorMessage: string,
): AgentToolResult<AdvisorDetails> {
	return buildAdvisorResult({ text: userText, effort, advisorLabel, errorMessage });
}

export async function executeAdvisor(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<AdvisorDetails> | undefined,
): Promise<AgentToolResult<AdvisorDetails>> {
	// Snapshot effort once at entry — every result envelope and the API call
	// itself use this same value so a concurrent setAdvisorEffort() during the
	// await window cannot desync details.effort from the `reasoning` actually sent.
	await stopAdvisorWarming(pi);
	const effort = getAdvisorEffort();
	const advisor = getAdvisorModel();
	if (!advisor) {
		return buildErrorResult(undefined, effort, ERR_NO_MODEL, ERR_NO_MODEL_SELECTED);
	}
	const advisorLabel = `${advisor.provider}:${advisor.id}`;
	if (ctx.model?.id === advisor.id) {
		return buildAdvisorResult({
			text: "Advisor skipped: the executor already uses the same model. Continue without advisor.",
			effort,
			advisorLabel,
			skipped: true,
			errorMessage: "same model as executor",
		});
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(advisor);
	if (!auth.ok) {
		return buildErrorResult(advisorLabel, effort, errMisconfigured(advisorLabel, auth.error), auth.error);
	}
	// OAuth-backed providers resolve `{ ok: true }` with no literal apiKey — their
	// credentials are applied inside Pi's runtime facade. A missing key is only
	// fatal on legacy hosts without that facade, where the global completion
	// fallback needs the key passed explicitly.
	const runtimeCompleteSimple = getRuntimeCompleteSimple(ctx.modelRegistry);
	if (!auth.apiKey && !runtimeCompleteSimple) {
		return buildErrorResult(advisorLabel, effort, errNoApiKey(advisorLabel), errNoApiKeyDetail(advisor.provider));
	}

	const config = loadAdvisorConfig();
	const budget = validateAdvisorBudget(config.budget);
	const ledgerConfig = validateAdvisorLedger(config.ledger);
	const toolConfig = validateAdvisorTools(config.tools);

	// Live-read every call — advisor runs mid-turn, so any message_end snapshot
	// is one turn stale. The RAW branch is the source (not buildSessionContext):
	// the ledger needs entry ids for its card handles, and it recovers the user's
	// pre-compaction words, which pi's context builder replaces with a summary.
	const branch = ctx.sessionManager.getBranch();
	const leafId = ctx.sessionManager.getLeafId();
	const inventoryMessage = getInventoryMessage(pi.getAllTools());
	const sessionId = `advisor:${ctx.sessionManager.getSessionId()}`;

	// A persisted anchor records where a previous oversized request began, so a
	// warm follow-up keeps the same starting point instead of re-trimming to a
	// different one and cold-starting the prefix.
	const boundaryId = advisorAnchorBoundary(branch);
	const savedAnchor = budget.contextBudgetTokens === 0 ? undefined : advisorSavedAnchor(branch, boundaryId);

	const render = (tokenBudget?: number): { view: LedgerView; messages: Message[] } => {
		const view = renderLedger(branch, leafId, {
			limits: ledgerConfig,
			tailToolCalls: ledgerConfig.tailToolCalls,
			...(tokenBudget === undefined ? {} : { tokenBudget }),
			...(savedAnchor ? { anchorEntryId: savedAnchor.entryId } : {}),
		});
		const messages = inventoryMessage ? [inventoryMessage, ...view.messages] : view.messages;
		return { view, messages };
	};

	let { view, messages } = render();
	// The catalogue is message 0 and never changes within a session, so it counts
	// toward the append-only prefix.
	const stableCount = (inventoryMessage ? 1 : 0) + view.stableMessageCount;
	const measure = (msgs: Message[], stable: number) =>
		estimateAdvisorRequest(
			branch,
			msgs,
			ADVISOR_SYSTEM_PROMPT,
			advisor,
			effort,
			budget,
			sessionId,
			Date.now(),
			stable,
			LEDGER_VERSION,
		);
	let { estimate, request } = measure(messages, stableCount);
	const originalPromptTokens = estimate.promptTokens;
	let stable = stableCount;

	// Trim only when the request is BOTH cold and over budget: a warm oversized
	// prefix is cheap to re-send and trimming it would throw the cache away.
	if (
		budget.contextBudgetTokens > 0 &&
		estimate.cacheReadTokens === 0 &&
		estimate.promptTokens > budget.contextBudgetTokens &&
		estimate.costUsd > budget.perCallSoftUsd
	) {
		const target = Math.max(
			0,
			Math.floor(budget.contextBudgetTokens / 1.2) - Math.ceil(ADVISOR_SYSTEM_PROMPT.length / 4),
		);
		({ view, messages } = render(target));
		stable = (inventoryMessage ? 1 : 0) + view.stableMessageCount;
		({ estimate, request } = measure(messages, stable));
	}

	const anchor: AdvisorAnchor | undefined = view.trimAnchorId
		? { entryId: view.trimAnchorId, boundaryId }
		: savedAnchor;

	const attempts: AdvisorAttempt[] = [];
	const rounds: AdvisorLoopRound[] = [];
	let budgetExhausted = false;
	// Set when the executor switched onto the advisor's model mid-consultation.
	let sameModel = false;
	const finish = (text: string, stopReason?: StopReason, errorMessage?: string, skipped = false): AdvisorResult => {
		const usage = sumAdvisorUsage(attempts.map((attempt) => attempt.usage));
		refreshAdvisorStatus(ctx, usage);
		return buildAdvisorResult({
			text,
			effort,
			advisorLabel,
			usage,
			stopReason,
			errorMessage,
			skipped,
			attempts,
			estimate,
			request,
			rounds,
			budgetExhausted,
			context: {
				trimmed: view.trimmed,
				...(anchor ? { anchorEntryId: anchor.entryId } : {}),
				originalPromptTokens,
				messageCount: messages.length,
			},
		});
	};
	const skip = () =>
		finish(
			`Advisor skipped: estimated $${estimate.costUsd.toFixed(2)} exceeds the budget or approval was declined. Continue without advisor; do not retry this consultation.`,
			undefined,
			"budget exceeded or declined",
			true,
		);

	try {
		if (
			budget.contextBudgetTokens > 0 &&
			estimate.cacheReadTokens === 0 &&
			estimate.costUsd > budget.perCallSoftUsd &&
			estimate.promptTokens > budget.contextBudgetTokens
		) {
			return finish(
				"Advisor skipped: the task and most recent complete tool round exceed the context budget. Continue without advisor; do not retry this consultation.",
				undefined,
				"context budget exceeded",
				true,
			);
		}
		if (signal?.aborted) return finish(ERR_CALL_ABORTED, "aborted", ERR_ABORTED_DETAIL);
		onUpdate?.({
			content: [{ type: "text", text: msgConsulting(advisorLabel, effort) }],
			details: { advisorModel: advisorLabel, effort, estimate },
		});

		// The runtime resolves OAuth credentials. Only legacy hosts need explicit auth overrides.
		const completeSimple = runtimeCompleteSimple ?? (await loadCompleteSimple());
		const onPayload = (payload: unknown) => {
			request.payloadHash = advisorPayloadHash(payload);
		};
		const requestOptions = runtimeCompleteSimple
			? { signal, reasoning: effort, sessionId, onPayload }
			: { apiKey: auth.apiKey, headers: auth.headers, signal, reasoning: effort, sessionId, onPayload };

		const toolRuntime = toolConfig.enabled && toolConfig.maxRounds > 0
			? createAdvisorToolRuntime(
					ctx,
					pi,
					toolConfig,
					() => ctx.sessionManager.getBranch(),
					// Only a vision-capable advisor may receive a file it read as an
					// image; a text-only model would reject the request.
					!!advisor.input?.includes("image"),
				)
			: undefined;
		const base: Context = { systemPrompt: ADVISOR_SYSTEM_PROMPT, messages, tools: toolRuntime?.declarations ?? [] };

		// Persist the anchor before dispatch so a crash mid-call still leaves the
		// next consultation pointing at the same trim boundary.
		if (view.trimAnchorId && view.trimAnchorId !== savedAnchor?.entryId) pi.appendEntry(ADVISOR_ANCHOR_ENTRY, anchor);

		const outcome = await runAdvisorLoop({
			model: advisor,
			base,
			requestOptions,
			complete: completeSimple,
			...(toolRuntime ? { tools: toolRuntime } : {}),
			maxRounds: toolRuntime ? toolConfig.maxRounds : 0,
			signal,
			attempts,
			rounds,
			approve: async (spent) => {
				if (!(await approveAdvisorCost(ctx, estimate, budget, spent))) return false;
				// Re-checked on every round, and AFTER the cost prompt: the budget
				// confirmation is an await window during which the user can /model
				// the executor onto the advisor's own model.
				if (ctx.model?.id === advisor.id) {
					sameModel = true;
					return false;
				}
				request.timestamp = Date.now();
				return true;
			},
			onProgress: (note) =>
				onUpdate?.({ content: [{ type: "text", text: note }], details: { advisorModel: advisorLabel, effort } }),
			onFirstRequest: (context, usage) =>
				rememberAdvisorRequest(pi, {
					ctx,
					model: advisor,
					effort,
					context,
					options: requestOptions,
					request,
					usage,
					complete: completeSimple,
				}),
		});
		budgetExhausted = !!outcome.budgetExhausted;

		if (outcome.errorMessage === "budget exceeded or declined") {
			if (sameModel)
				return finish(
					"Advisor skipped: the executor now uses the same model. Continue without advisor.",
					undefined,
					"same model as executor",
					true,
				);
			return skip();
		}
		if (outcome.stopReason === "aborted")
			return finish(ERR_CALL_ABORTED, "aborted", outcome.errorMessage ?? ERR_ABORTED_DETAIL);
		if (outcome.stopReason === "error")
			return finish(errCallFailed(outcome.errorMessage), "error", outcome.errorMessage ?? "unknown error");
		if (!outcome.text) return finish(ERR_EMPTY_RESPONSE, outcome.stopReason, ERR_EMPTY_RESPONSE_DETAIL);
		return finish(outcome.text, outcome.stopReason);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return finish(errCallThrew(message), undefined, message);
	}
}
