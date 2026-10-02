/**
 * register — the advisor tool registration: zero-param schema, curated
 * description / promptSnippet / promptGuidelines, and an execute that delegates
 * to executeAdvisor. The guidance overrides are read from persisted config.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validateGuidanceFields } from "./settings.js";
import { Type } from "typebox";
import { loadAdvisorConfig, validateAdvisorReview } from "./config.js";
import { executeAdvisor } from "./execute.js";
import { ADVISOR_TOOL_NAME, TOOL_LABEL } from "./messages.js";

const AdvisorParams = Type.Object({});

const ADVISOR_DESCRIPTION =
	"Escalate to a stronger reviewer model for guidance. When you need " +
	"stronger judgment — a complex decision, an ambiguous failure, a problem " +
	"you're circling without progress — escalate to the advisor model for " +
	"guidance, then resume. Takes NO parameters — when you call advisor(), " +
	"your conversation is forwarded automatically: every message the user wrote " +
	"verbatim, your most recent tool rounds in full, and earlier rounds summarized " +
	"to one line each. The advisor can pull up any summarized output and read the " +
	"current files itself, so you do not need to restate evidence. Write your " +
	"question as ordinary text alongside the call. The answer starts with " +
	"`Severity: none|nit|concern|blocker`; `none` means continue as planned. " +
	"If a consultation is skipped, continue without advisor and do not retry it.";

export const DEFAULT_PROMPT_SNIPPET =
	"Escalate to a stronger reviewer model for guidance when stuck, before substantive work, or before declaring done";
const REVIEW_PROMPT_SNIPPET =
	"Escalate to a stronger reviewer model for guidance when stuck or before substantive work";

const BEFORE_WORK =
	"Call `advisor` BEFORE substantive work — before writing, before committing to an interpretation, before building on an assumption. Orientation (finding files, fetching a source, seeing what's there) is not substantive work; writing, editing, and declaring an answer are.";
const BEFORE_DONE =
	"Also call `advisor` when you believe the task is complete. BEFORE this call, make your deliverable durable: write the file, save the result, commit the change. The advisor call takes time; if the session ends during it, a durable result persists and an unwritten one doesn't.";
const WHEN_STUCK =
	"Also call `advisor` when stuck — errors recurring, approach not converging, results that don't fit — or when considering a change of approach.";
const CADENCE_TAIL =
	"On short reactive tasks where the next action is dictated by tool output you just read, you don't need to keep calling — the advisor adds most of its value on the first call, before the approach crystallizes.";
const WEIGH =
	"Give the advisor's advice serious weight. If you follow a step and it fails empirically, or you have primary-source evidence that contradicts a specific claim, adapt — a passing self-test is not evidence the advice is wrong, it's evidence your test doesn't check what the advice is checking.";
const RECONCILE =
	"If you've already retrieved data pointing one way and the advisor points another, don't silently switch — surface the conflict in one more `advisor` call (\"I found X, you suggest Y, which constraint breaks the tie?\"). A reconcile call is cheaper than committing to the wrong branch.";
const SURFACE =
	"After each `advisor` result, put the advisor's key guidance into your next visible reply to the user before continuing — quote or paraphrase its severity and the plan or correction. The user often cannot see collapsed tool results; do not keep the advisor's words only in silent tool context.";

export const DEFAULT_PROMPT_GUIDELINES: string[] = [
	BEFORE_WORK,
	BEFORE_DONE,
	WHEN_STUCK,
	`On tasks longer than a few steps, call \`advisor\` at least once before committing to an approach and once before declaring done. ${CADENCE_TAIL}`,
	WEIGH,
	RECONCILE,
	SURFACE,
];

/** With completion review on, the "before declaring done" consultation moves to the background. */
export const REVIEW_PROMPT_GUIDELINES: string[] = [
	BEFORE_WORK,
	WHEN_STUCK,
	`On tasks longer than a few steps, call \`advisor\` at least once before committing to an approach. ${CADENCE_TAIL}`,
	"You do not need to call `advisor` before declaring done: the advisor reviews your final answer in the background. A later `<advisory source=\"completion review\">` message is that review — weigh it like any advice, and for a `blocker`, fix the problem or explain why it does not apply before finishing.",
	WEIGH,
	RECONCILE,
	SURFACE,
];

export function registerAdvisorTool(pi: ExtensionAPI): void {
	const config = loadAdvisorConfig();
	const guidance = validateGuidanceFields(config.guidance);
	const review = validateAdvisorReview(config.review).enabled;
	pi.registerTool({
		name: ADVISOR_TOOL_NAME,
		label: TOOL_LABEL,
		description: ADVISOR_DESCRIPTION,
		promptSnippet: guidance.promptSnippet ?? (review ? REVIEW_PROMPT_SNIPPET : DEFAULT_PROMPT_SNIPPET),
		promptGuidelines: guidance.promptGuidelines ?? (review ? REVIEW_PROMPT_GUIDELINES : DEFAULT_PROMPT_GUIDELINES),
		parameters: AdvisorParams,

		async execute(_toolCallId, _params, signal, onUpdate, ctx) {
			return executeAdvisor(ctx, pi, signal, onUpdate);
		},
	});
}
