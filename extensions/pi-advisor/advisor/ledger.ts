/**
 * ledger — assembles the advisor request from the executor's branch.
 *
 * Shape of one request:
 *   [system] [tool catalogue]
 *   [<executor_log> … cards … </executor_log>] [question 1] [advice 1]
 *   [<executor_log> … </executor_log>] [question 2] [advice 2] …
 *   [<executor_log> … cards … verbatim tail …</executor_log>] [question]
 *
 * Two invariants hold the design together:
 *
 * 1. APPEND-ONLY HISTORY. Everything before the current question is compiled
 *    per-entry (see cards.ts), so rendering a prefix of the branch yields a
 *    prefix of the full render. Consecutive consultations therefore share a
 *    byte-identical leading prefix, which is what OpenAI/Anthropic prompt
 *    caching matches on. The verbatim tail is the only part that changes shape
 *    between calls, and it sits last.
 *
 * 2. ROLE SEPARATION. The executor's activity is DATA inside a user-role
 *    <executor_log>; only the advisor's own past answers take the assistant
 *    role. Replaying executor turns as assistant turns invites the reviewer to
 *    continue the transcript instead of answering it, and to narrate the
 *    executor's work as its own. The request also always ends on an
 *    instruction, never on a pending action.
 */

import type { AssistantMessage, Message, TextContent } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildContextEntries } from "@earendil-works/pi-coding-agent";
import {
	assistantToolCalls,
	type LedgerBlock,
	type LedgerLimits,
	clipMiddle,
	isAdvisorCall,
	messageText,
	renderAdvice,
	renderAssistantText,
	renderAssistantThinking,
	renderBashExecution,
	renderCard,
	renderCustomMessage,
	renderSummary,
	renderUserMessage,
	renderVerbatimRound,
	type ToolRound,
} from "./cards.js";
import { ADVISOR_REVIEW_TYPE, ADVISOR_TOOL_NAME } from "./messages.js";

/** Bumped when the rendered shape changes, so cost estimation never compares
 *  a stable-prefix hash across two different ledger formats. */
export const LEDGER_VERSION = 2;

export const LOG_OPEN = "<executor_log>";
export const LOG_CLOSE = "</executor_log>";

const TAIL_HEADER = "Most recent work, verbatim:";
const FINAL_INSTRUCTION =
	"Advise the executor on the situation above. Ground every claim in the log; do not invent executor actions.";
/** Closing instruction of a completion review, in place of FINAL_INSTRUCTION. */
export const REVIEW_INSTRUCTION =
	"The executor has just delivered its final answer to the user: the last [executor] text above. Review the delivered work, not the plan. Is the answer correct, and is the work it reports actually done and verified? When files changed, run git_diff before judging completeness. `Severity: none` means the answer stands as delivered; then stop. Ground every claim in the log or in what you read; do not invent executor actions.";
/** Replaces the question line of a past completion-review segment. */
const REVIEW_MARKER = "Completion review: the executor had just delivered the answer above.";
const PRE_BOUNDARY_HEADER =
	"The user's own words before the summary boundary (verbatim, in order — these are the authoritative statement of intent):";
const TRIM_HEADER =
	"The user's own words from the omitted span (verbatim, in order — these are the authoritative statement of intent):";
const OMISSION =
	"[Earlier executor activity omitted to fit the cost budget. The user's words above are complete; use advisor_expand or the read-only tools if you need omitted detail.]";

export interface LedgerOptions {
	limits: LedgerLimits;
	/** Tool rounds kept verbatim at the tail. */
	tailToolCalls: number;
	/** Cap for the whole rendered ledger, in estimated tokens. 0 disables. */
	tokenBudget?: number;
	/**
	 * Entry id a previous trim settled on. Rendering resumes from it so a warm
	 * follow-up reproduces the same prefix instead of re-deriving a boundary that
	 * drifts as the branch grows.
	 */
	anchorEntryId?: string;
	/** Closing instruction; defaults to the consultation instruction. */
	instruction?: string;
}

export interface LedgerView {
	messages: Message[];
	/** Message count of the append-only prefix, excluding the changing tail. */
	stableMessageCount: number;
	/** True when any executor activity was dropped to fit the budget. */
	trimmed: boolean;
	/**
	 * Last entry id the trim DROPPED. Replaying it resumes just after it, which
	 * stays well-defined even when every card was dropped (the retained span can
	 * be empty; the dropped span never is).
	 */
	trimAnchorId?: string;
	/** Ids of every block, so advisor_expand can validate a requested id. */
	blockIds: string[];
}

/**
 * Ledger messages are text only. Images are never embedded: an attachment is
 * named, and the advisor loads it on demand with `read` when a path exists. Bytes
 * in a message would sit in the append-only prefix of every later consultation
 * and be re-uploaded on every request.
 */
function userMessage(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 } as Message;
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "advisor-ledger",
		provider: "advisor",
		model: "ledger",
		// Original usage cannot describe this compiled prefix; let Pi estimate it.
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

/** A segment of the request: executor activity, then optionally the question
 *  that closed it and the advice that answered it. */
interface Segment {
	blocks: LedgerBlock[];
	question?: string;
	advice?: string;
	/** Closed by a background completion review rather than an executor question. */
	review?: boolean;
}

interface Compiled {
	segments: Segment[];
	/** Verbatim tail rounds plus the executor prose/thinking after them. */
	tail: LedgerBlock[];
	/** The question of the in-flight consultation, if any. */
	pendingQuestion?: string;
	/** Pre-boundary user blocks re-stated after a compaction. */
	preBoundaryUser: LedgerBlock[];
}

/**
 * Walk the compaction-aware entry path once, pairing tool calls with their
 * results and splitting at each completed consultation.
 *
 * Pre-compaction user messages are recovered from the RAW branch: pi's context
 * builder replaces them with its summary, and that summary is a paraphrase
 * written for the executor. The user's literal words are the only direct
 * evidence of intent, so they are re-stated verbatim ahead of the summary.
 */
function compile(branch: readonly SessionEntry[], leafId: string | null, options: LedgerOptions): Compiled {
	const contextEntries = buildContextEntries(branch as SessionEntry[], leafId);
	const keptIds = new Set(contextEntries.map((entry) => entry.id));
	const boundary = contextEntries.some((entry) => entry.type === "compaction" || entry.type === "branch_summary");

	const preBoundaryUser: LedgerBlock[] = boundary
		? branch
				.filter(
					(entry): entry is SessionEntry & { type: "message" } =>
						entry.type === "message" && entry.message.role === "user" && !keptIds.has(entry.id),
				)
				.map((entry) => renderUserMessage(entry, options.limits))
		: [];

	// Index results by tool-call id so a card can be emitted at the call site
	// even when results arrive out of order (parallel tool execution).
	const resultByCallId = new Map<string, { entryId: string; text: string; isError: boolean; images: number }>();
	for (const entry of contextEntries) {
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		const message = entry.message;
		const images = Array.isArray(message.content)
			? message.content.filter((c) => (c as { type?: string }).type === "image").length
			: 0;
		resultByCallId.set(message.toolCallId, {
			entryId: entry.id,
			text: messageText(message),
			isError: !!message.isError,
			images,
		});
	}

	const segments: Segment[] = [];
	let current: Segment = { blocks: [] };
	const rounds: { index: number; round: ToolRound }[] = [];
	let pendingQuestion: string | undefined;

	const pushSegment = (question: string | undefined, advice: string | undefined, review = false) => {
		current.question = question;
		current.advice = advice;
		if (review) current.review = true;
		segments.push(current);
		current = { blocks: [] };
		// Round indices address `current.blocks`, which is a NEW array from here on.
		// Carrying them across a boundary let a stale index collide with a later
		// block's position, replacing (for example) a user message with the
		// verbatim rendering of a round from the previous segment.
		rounds.length = 0;
	};

	for (const entry of contextEntries) {
		const summary = renderSummary(entry);
		if (summary) {
			current.blocks.push(summary);
			continue;
		}
		if (entry.type === "custom_message" && entry.customType === ADVISOR_REVIEW_TYPE) {
			// A delivered review is the advisor's own answer: replay it in the
			// assistant role, not as an extension note the advisor was shown.
			const advice = reviewAdviceText(entry);
			if (advice) pushSegment(undefined, advice, true);
			continue;
		}
		if (entry.type === "custom_message") {
			const block = renderCustomMessage(entry, options.limits);
			if (block) current.blocks.push(block);
			continue;
		}
		if (entry.type !== "message") continue;

		const message = entry.message;
		if (message.role === "user") {
			current.blocks.push(renderUserMessage(entry, options.limits));
			continue;
		}
		if ((message.role as string) === "bashExecution") {
			const block = renderBashExecution(entry);
			if (block) current.blocks.push(block);
			continue;
		}
		if (message.role === "toolResult") {
			// Advice is replayed in the assistant role at its consultation
			// boundary; every other result is already carried by its call's card.
			continue;
		}
		if (message.role !== "assistant") continue;

		const calls = assistantToolCalls(message);
		const advisorCall = calls.find((c) => c.name === ADVISOR_TOOL_NAME);
		const text = renderAssistantText(entry);

		if (advisorCall) {
			const result = resultByCallId.get(advisorCall.id);
			// The executor's prose alongside an advisor() call IS its question.
			const question = messageText(message).trim();
			// Non-advisor siblings of a parallel batch still get their cards.
			for (const call of calls) {
				if (call.name === ADVISOR_TOOL_NAME) continue;
				const round: ToolRound = { entryId: entry.id, call, result: resultByCallId.get(call.id) };
				rounds.push({ index: current.blocks.length, round });
				current.blocks.push(renderCard(round));
			}
			if (!result) {
				// In-flight: this is the consultation being served right now.
				pendingQuestion = question;
				continue;
			}
			const resultEntry = branch.find(
				(e): e is SessionEntry & { type: "message" } => e.id === result.entryId && e.type === "message",
			);
			const advice = resultEntry ? renderAdvice(resultEntry)?.text : undefined;
			pushSegment(question || undefined, advice);
			continue;
		}

		if (text) current.blocks.push(text);
		for (const call of calls) {
			const round: ToolRound = { entryId: entry.id, call, result: resultByCallId.get(call.id) };
			rounds.push({ index: current.blocks.length, round });
			current.blocks.push(renderCard(round));
		}
	}

	// Promote the last N tool rounds of the open segment to verbatim form.
	// Everything from the earliest promoted round onward moves out of the card
	// list into the tail, so the cards that remain keep the append-only shape
	// the next request's cache prefix depends on.
	const tail: LedgerBlock[] = [];
	const promoted = options.tailToolCalls > 0
		? rounds.filter((r) => r.index < current.blocks.length).slice(-options.tailToolCalls)
		: [];
	if (promoted.length) {
		const from = Math.min(...promoted.map((r) => r.index));
		const trailing = current.blocks.slice(from);
		current.blocks = current.blocks.slice(0, from);
		trailing.forEach((block, offset) => {
			const match = promoted.find((r) => r.index === from + offset);
			tail.push(match ? renderVerbatimRound(match.round, options.limits) : block);
		});
		// Executor reasoning is dropped from history but kept in the tail: it is
		// what explains the decision that triggered this consultation.
		for (const entry of contextEntries) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			if (!isAdvisorCall(entry.message)) continue;
			const thinking = renderAssistantThinking(entry, options.limits);
			if (thinking) tail.push(thinking);
		}
	}

	segments.push(current);
	return { segments, tail, pendingQuestion, preBoundaryUser };
}

/** The advisor's raw review text; the delivered content also carries the advisory wrapper. */
function reviewAdviceText(entry: SessionEntry & { type: "custom_message" }): string | undefined {
	const advice = (entry.details as { advice?: unknown } | undefined)?.advice;
	if (typeof advice === "string" && advice.trim()) return advice.trim();
	const content = typeof entry.content === "string"
		? entry.content
		: entry.content.filter((c): c is TextContent => c.type === "text").map((c) => c.text).join("\n");
	return content.trim() || undefined;
}

function blockText(blocks: LedgerBlock[]): string {
	return blocks.map((b) => b.text).join("\n\n");
}

/**
 * Per-image token allowance, matching pi's own context accounting
 * (`ESTIMATED_IMAGE_CHARS = 4800` → 1200 tokens). Vision models price an image by
 * its dimensions, not by the length of its base64, so measuring the encoded bytes
 * overstates an attachment by orders of magnitude — enough to make the trim logic
 * discard history that costs nothing to keep.
 */
const IMAGE_TOKENS = 1200;

/**
 * Estimated token count of a rendered message list: chars/4 over the text, like
 * pi, plus a fixed allowance per image instead of its encoded length.
 */
function estimateChars(messages: Message[]): number {
	let chars = 0;
	let images = 0;
	for (const message of messages) {
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") {
			chars += content.length;
			continue;
		}
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			const typed = block as { type?: string; text?: string };
			if (typed.type === "image") images++;
			else if (typed.text) chars += typed.text.length;
		}
	}
	return Math.ceil(chars / 4) + images * IMAGE_TOKENS;
}

function assemble(compiled: Compiled, options: LedgerOptions, dropBefore: number): {
	messages: Message[];
	stableMessageCount: number;
	blockIds: string[];
	trimmed: boolean;
	trimAnchorId?: string;
} {
	const messages: Message[] = [];
	const blockIds: string[] = [];
	let trimmed = false;
	let trimAnchorId: string | undefined;

	const record = (blocks: LedgerBlock[]) => {
		for (const b of blocks) if (b.id) blockIds.push(b.id);
	};

	if (compiled.preBoundaryUser.length) {
		record(compiled.preBoundaryUser);
		messages.push(userMessage(`${PRE_BOUNDARY_HEADER}\n\n${blockText(compiled.preBoundaryUser)}`));
	}

	// Trimming drops executor activity but never the user's words. Resolve the
	// drop first, over the whole segment list, so the dropped span's user blocks
	// can be re-stated exactly once ahead of the omission marker.
	const segments = compiled.segments.map((segment, s) => ({
		...segment,
		isLast: s === compiled.segments.length - 1,
	}));
	const droppedUser: LedgerBlock[] = [];
	const droppedIds: string[] = [];
	if (dropBefore > 0) {
		let remaining = dropBefore;
		for (const segment of segments) {
			if (remaining <= 0) break;
			const take = Math.min(remaining, segment.blocks.length);
			const dropping = segment.blocks.slice(0, take);
			droppedUser.push(...dropping.filter((b) => b.kind === "user"));
			for (const block of dropping) if (block.id) droppedIds.push(block.id);
			trimmed = true;
			const fullyDropped = take === segment.blocks.length;
			segment.blocks = segment.blocks.slice(take);
			// A fully dropped segment loses its question/advice pair too, so the
			// advisor never sees an answer whose question is gone.
			if (fullyDropped) {
				segment.question = undefined;
				segment.advice = undefined;
			}
			remaining -= take;
		}
		// Anchor on the last DROPPED block: "resume after this entry". Anchoring on
		// the first retained one would be undefined whenever the trim consumed
		// every card, which is exactly the heaviest trim.
		trimAnchorId = droppedIds.at(-1);
	}
	if (trimmed) {
		if (droppedUser.length) {
			record(droppedUser);
			messages.push(userMessage(`${TRIM_HEADER}\n\n${blockText(droppedUser)}`));
		}
		messages.push(userMessage(OMISSION));
	}

	for (const segment of segments) {
		const { blocks, isLast } = segment;
		const parts: string[] = [];
		if (blocks.length) parts.push(`${LOG_OPEN}\n${blockText(blocks)}\n${LOG_CLOSE}`);
		if (isLast && compiled.tail.length) parts.push(`${TAIL_HEADER}\n${blockText(compiled.tail)}`);
		const question = isLast ? compiled.pendingQuestion : segment.question;
		if (!isLast && segment.review) parts.push(REVIEW_MARKER);
		else if (question) parts.push(`Executor's question: ${question}`);
		if (isLast) parts.push(options.instruction ?? FINAL_INSTRUCTION);

		record(blocks);
		if (isLast) record(compiled.tail);
		if (parts.length) messages.push(userMessage(parts.join("\n\n")));
		if (!isLast && segment.advice) messages.push(assistantMessage(segment.advice));
	}

	// The last user message carries the changing tail and question; everything
	// before it is the append-only prefix a warm cache can read.
	const stableMessageCount = Math.max(0, messages.length - 1);
	return { messages, stableMessageCount, blockIds, trimmed, trimAnchorId };
}

/**
 * Render the advisor request. When `tokenBudget` is set and the full ledger
 * exceeds it, the oldest executor activity is dropped (binary search over the
 * drop count) while the user's words and the final segment are preserved.
 */
export function renderLedger(
	branch: readonly SessionEntry[],
	leafId: string | null,
	options: LedgerOptions,
): LedgerView {
	const compiled = compile(branch, leafId, options);
	// Every card is droppable, including the newest segment's: the verbatim tail
	// and the current question live outside `blocks`, so a full drop still leaves
	// a well-formed request. A session whose first consultation comes after a long
	// uninterrupted stretch of work is exactly the expensive cold case, and it has
	// only one segment — excluding it would leave that case untrimmable.
	const droppable = compiled.segments.reduce((sum, s) => sum + s.blocks.length, 0);

	// Honour a sticky anchor first: the number of blocks preceding it is the drop
	// count a previous consultation settled on.
	let floor = 0;
	if (options.anchorEntryId) {
		let seen = 0;
		outer: for (const segment of compiled.segments) {
			for (const block of segment.blocks) {
				seen++;
				if (block.id === options.anchorEntryId) {
					// The anchor was the last block dropped, so resume after it.
					floor = seen;
					break outer;
				}
			}
		}
	}

	const base = assemble(compiled, options, floor);
	const budget = options.tokenBudget ?? 0;
	if (budget <= 0 || estimateChars(base.messages) <= budget) return { ...base };

	// Choose the SMALLEST additional drop that fits, so the retained span stays
	// as long as the budget allows and the boundary moves as rarely as possible.
	let best = base;
	if (droppable > floor) {
		let lo = floor + 1;
		let hi = droppable;
		best = assemble(compiled, options, droppable);
		while (lo <= hi) {
			const mid = Math.floor((lo + hi) / 2);
			const candidate = assemble(compiled, options, mid);
			if (estimateChars(candidate.messages) <= budget) {
				best = candidate;
				hi = mid - 1;
			} else {
				lo = mid + 1;
			}
		}
		if (estimateChars(best.messages) <= budget) return { ...best };
	}

	// Cards alone could not free enough room: the verbatim tail is what does not
	// fit. Shrink its per-part cap rather than giving up — a truncated view of the
	// failing step is far more useful to the reviewer than no consultation at all.
	// The floor keeps enough to still show an error line.
	for (const cap of [4000, 2000, 1000, 500]) {
		if (cap >= options.limits.tailMaxChars) continue;
		const tightened: LedgerOptions = { ...options, limits: { ...options.limits, tailMaxChars: cap } };
		const candidate = assemble(compile(branch, leafId, tightened), tightened, droppable);
		if (estimateChars(candidate.messages) <= budget) return { ...candidate };
		best = candidate;
	}
	return { ...best };
}

/** Text of a specific session entry, for advisor_expand. */
export function expandEntry(branch: readonly SessionEntry[], id: string, maxChars: number): string | undefined {
	const entry = branch.find((e) => e.id === id);
	if (!entry) return undefined;
	if (entry.type === "custom_message") {
		const text = typeof entry.content === "string"
			? entry.content
			: (entry.content ?? [])
					.filter((c): c is TextContent => c.type === "text")
					.map((c) => c.text)
					.join("\n");
		return clipMiddle(text, maxChars);
	}
	if (entry.type === "compaction" || entry.type === "branch_summary") {
		return clipMiddle((entry as { summary?: string }).summary ?? "", maxChars);
	}
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	if ((message.role as string) === "bashExecution") {
		const bash = message as unknown as { command: string; output: string; exitCode?: number };
		return clipMiddle(`$ ${bash.command}\nexit ${bash.exitCode ?? "?"}\n${bash.output ?? ""}`, maxChars);
	}
	if (message.role === "assistant") {
		const calls = assistantToolCalls(message);
		const args = calls.map((c) => `${c.name}(${JSON.stringify(c.arguments ?? {})})`).join("\n");
		const text = messageText(message);
		return clipMiddle([text, args].filter(Boolean).join("\n"), maxChars);
	}
	return clipMiddle(messageText(message), maxChars);
}
