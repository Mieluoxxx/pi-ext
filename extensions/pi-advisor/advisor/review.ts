/**
 * review — background completion review. When the executor settles on a final
 * answer, the advisor reviews the delivered work while nobody waits on it: a
 * synchronous "before declaring done" consultation blocked the executor ~60s
 * each time. Only a blocker wakes the executor; any other finding lands as a
 * visible card it reads on its next turn, and `Severity: none` stays silent.
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { ADVISOR_REVIEW_USAGE, refreshAdvisorStatus } from "./budget.js";
import { assistantToolCalls } from "./cards.js";
import { loadAdvisorConfig, validateAdvisorReview } from "./config.js";
import { type AdvisorDetails, executeAdvisor } from "./execute.js";
import { ADVISOR_REVIEW_TYPE, ADVISOR_TOOL_NAME, MSG_REVIEWING, REVIEW_STATUS_KEY } from "./messages.js";
import { getRuntimeUsageRecorder } from "./pi-compat.js";
import { isExecutorBlocked } from "./policy.js";
import { getAdvisorModel } from "./state.js";

export type AdvisorSeverity = "none" | "nit" | "concern" | "blocker";

const SEVERITY_LINE = /^[\s*_`]*severity[\s*_`]*:[\s*_`]*(none|nit|concern|blocker)\b/i;

/** The severity the advisor opened with, and the guidance after that line. */
export function parseAdvisorSeverity(text: string): { severity?: AdvisorSeverity; body: string } {
	const [first = "", ...rest] = text.trimStart().split("\n");
	const match = SEVERITY_LINE.exec(first);
	if (!match) return { body: text.trim() };
	return { severity: match[1].toLowerCase() as AdvisorSeverity, body: rest.join("\n").trim() };
}

export interface ReviewableRun {
	/** The executor's final answer; a review is keyed to it. */
	finalEntryId: string;
	/** The user prompt that started the run. */
	userEntryId: string;
}

/**
 * The run that just settled, when it ended in a reviewable final answer: the
 * last executor message is text with no tool calls and no failure, the run did
 * at least `minToolCalls` tool calls of real work, and the executor did not
 * already consult the advisor after the last of them.
 */
export function reviewableRun(branch: readonly SessionEntry[], minToolCalls: number): ReviewableRun | undefined {
	let start = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message" && entry.message.role === "user") {
			start = i;
			break;
		}
	}
	if (start < 0) return undefined;

	let final: (SessionEntry & { type: "message" }) | undefined;
	let work = 0;
	let lastWork = -1;
	let lastConsult = -1;
	for (let i = start + 1; i < branch.length; i++) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		final = entry;
		if (entry.message.role !== "assistant") continue;
		for (const call of assistantToolCalls(entry.message)) {
			if (call.name === ADVISOR_TOOL_NAME) lastConsult = i;
			else {
				work++;
				lastWork = i;
			}
		}
	}
	if (!final || final.message.role !== "assistant") return undefined;
	const message = final.message;
	if (message.stopReason === "error" || message.stopReason === "aborted") return undefined;
	if (assistantToolCalls(message).length) return undefined;
	const hasText = message.content.some((c) => c.type === "text" && c.text.trim());
	if (!hasText || work < minToolCalls || lastConsult > lastWork) return undefined;
	return { finalEntryId: final.id, userEntryId: branch[start].id };
}

function formatAdvisory(severity: AdvisorSeverity, body: string): string {
	return `<advisory severity="${severity}" source="completion review" guidance="weigh, don't blindly obey">\n${body}\n</advisory>`;
}

type UsageRecorder = NonNullable<ReturnType<typeof getRuntimeUsageRecorder>>;

/** Bill the review to the session first: a failed or aborted review may still have spent. */
function recordReviewUsage(recordUsage: UsageRecorder, details: AdvisorDetails, usage: AdvisorDetails["usage"]): void {
	const label = details.advisorModel;
	if (!usage || !label) return;
	const split = label.indexOf(":");
	recordUsage(
		ADVISOR_REVIEW_USAGE,
		label.slice(0, split),
		label.slice(split + 1),
		usage,
		JSON.stringify({
			request: details.request,
			effort: details.effort,
			attempts: details.attempts,
			...(details.skipped ? { skipped: true } : {}),
		}),
	);
}

async function runReview(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	run: ReviewableRun,
	signal: AbortSignal,
	recordUsage: UsageRecorder,
	wokenFor: Set<string>,
): Promise<void> {
	const sessionId = ctx.sessionManager.getSessionId();
	const leafAtStart = ctx.sessionManager.getLeafId();
	const result = await executeAdvisor(ctx, pi, signal, undefined, { review: true });
	const details = (result.details ?? {}) as AdvisorDetails;
	recordReviewUsage(recordUsage, details, details.usage);
	refreshAdvisorStatus(ctx);

	if (signal.aborted || ctx.sessionManager.getSessionId() !== sessionId) return;
	// A failed or skipped review stays quiet; its spend already shows in the status line.
	if (details.errorMessage || details.skipped) return;
	const text = result.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();
	const { severity, body } = parseAdvisorSeverity(text);
	if (!text || severity === "none") return;
	// An answer that ignored the format is still shown, but never wakes the executor.
	const level = severity ?? "nit";
	const idle = ctx.isIdle();
	// One woken turn per user prompt, so a blocker the fix does not clear cannot loop.
	const wake =
		level === "blocker" && idle && ctx.sessionManager.getLeafId() === leafAtStart && !wokenFor.has(run.userEntryId);
	if (wake) wokenFor.add(run.userEntryId);
	pi.sendMessage(
		{
			customType: ADVISOR_REVIEW_TYPE,
			content: formatAdvisory(level, body || text),
			display: true,
			details: {
				severity: level,
				advice: text,
				reviewedEntryId: run.finalEntryId,
				advisorModel: details.advisorModel,
				effort: details.effort,
			},
		},
		// The user already moved on: hold the review for their next prompt instead of
		// injecting it into an unrelated run.
		wake ? { triggerTurn: true } : idle ? undefined : { deliverAs: "nextTurn" },
	);
}

export function registerAdvisorReview(pi: ExtensionAPI): void {
	let controller: AbortController | undefined;
	const reviewed = new Set<string>();
	const wokenFor = new Set<string>();
	const stop = () => {
		controller?.abort();
		controller = undefined;
	};

	pi.on("agent_settled", (_event, ctx) => {
		if (controller) return;
		const config = validateAdvisorReview(loadAdvisorConfig().review);
		if (!config.enabled) return;
		if (!getAdvisorModel() || isExecutorBlocked(ctx, pi.getThinkingLevel())) return;
		// Never start a paid background call on a host that cannot record its usage:
		// it would sit outside the budget ledger.
		const recordUsage = getRuntimeUsageRecorder(ctx.sessionManager);
		if (!recordUsage) return;
		const run = reviewableRun(ctx.sessionManager.getBranch(), config.minToolCalls);
		if (!run || reviewed.has(run.finalEntryId)) return;
		reviewed.add(run.finalEntryId);

		const own = new AbortController();
		controller = own;
		if (ctx.hasUI) ctx.ui.setStatus(REVIEW_STATUS_KEY, MSG_REVIEWING);
		// Not awaited: settling must not wait on the review.
		void runReview(pi, ctx, run, own.signal, recordUsage, wokenFor)
			.catch((error) => {
				console.warn(
					`[rpiv-advisor] completion review failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			})
			.finally(() => {
				if (controller === own) controller = undefined;
				try {
					if (ctx.hasUI) ctx.ui.setStatus(REVIEW_STATUS_KEY, undefined);
				} catch {
					/* A replaced session UI has nothing left to clear. */
				}
			});
	});
	pi.on("session_before_compact", stop);
	pi.on("session_before_tree", stop);
	pi.on("session_before_switch", stop);
	pi.on("session_before_fork", stop);
	pi.on("session_shutdown", stop);
}
