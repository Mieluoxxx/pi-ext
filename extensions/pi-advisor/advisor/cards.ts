/**
 * cards — per-entry compilation of the executor's branch into ledger blocks.
 *
 * Every function here is a pure function of ONE session entry (plus the tool
 * results that belong to it). That is what makes the rendered history
 * append-only: compiling entry k can never depend on entry k+1, so the text
 * produced for a prefix of the branch is a prefix of the text produced for the
 * whole branch — the property provider prompt caching matches on.
 *
 * Raw tool I/O dominates an advisor payload (measured: tool results 75.7%,
 * tool-call arguments 16.9%, executor thinking 4.8%, the user's own words 0.1%
 * across 12 large sessions), so older rounds are compiled to one-line cards and
 * only the tail keeps its verbatim text.
 */

import type { TextContent, ToolCall } from "@earendil-works/pi-ai";

/**
 * Any message shape a session entry can hold — pi's `AgentMessage`, which is
 * wider than pi-ai's `Message` (it adds the bashExecution / custom / summary
 * roles). Derived from the entry type rather than imported, because it lives in
 * pi-agent-core and this package declares no dependency on it.
 */
type AnyMessage = (SessionEntry & { type: "message" })["message"];
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { ADVISOR_TOOL_NAME } from "./messages.js";

/** Marker for a value the advisor can retrieve verbatim with advisor_expand. */
export const EXPANDABLE = "expand";

export interface LedgerLimits {
	/** Verbatim cap for one tail tool result / argument block. */
	tailMaxChars: number;
	/** Cap for one user message; longer keeps head+tail with a marked gap. */
	userMessageMaxChars: number;
	/** Preview cap for an extension-authored custom message. */
	customPreviewChars: number;
}

export const DEFAULT_LEDGER_LIMITS: LedgerLimits = {
	tailMaxChars: 8000,
	userMessageMaxChars: 20000,
	customPreviewChars: 500,
};

/** One rendered unit of the ledger. `id` is the session entry id when known. */
export interface LedgerBlock {
	kind: "user" | "assistant" | "card" | "summary" | "custom" | "bash" | "advice" | "question";
	/** Session entry id — the handle advisor_expand resolves. */
	id?: string;
	text: string;
}

const ARG_PREVIEW_CHARS = 120;
const ERROR_PREVIEW_CHARS = 200;

/**
 * Argument keys tried in order when naming what a tool call acted on. The list
 * is ordered most- to least-specific so `edit({path, old, new})` shows its path
 * rather than its first string argument. An unknown shape falls back to the
 * first string value, which keeps third-party tools readable without a
 * per-tool adapter.
 */
const PRIMARY_ARG_KEYS = [
	"file_path",
	"path",
	"filePath",
	"file",
	"command",
	"url",
	"pattern",
	"query",
	"name",
	"id",
];

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

export function clip(value: string, max: number): string {
	const flat = oneLine(value);
	return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/**
 * Keep the head and tail of an oversized value with a marked gap. Used for the
 * user's own words, which are never dropped: the largest single user message in
 * the measured corpus was 238k chars (a paste), and a gap marker plus an
 * expandable id preserves intent while bounding cost.
 */
export function clipMiddle(value: string, max: number, id?: string): string {
	if (value.length <= max) return value;
	const keep = Math.floor((max - 1) / 2);
	const omitted = value.length - keep * 2;
	const marker = id
		? `\n[… ${omitted} chars omitted — advisor_expand("${id}") for the full text …]\n`
		: `\n[… ${omitted} chars omitted …]\n`;
	return `${value.slice(0, keep)}${marker}${value.slice(-keep)}`;
}

export function messageText(message: AnyMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c): c is TextContent => !!c && typeof c === "object" && (c as { type?: string }).type === "text")
		.map((c) => c.text)
		.join("\n");
}

function imageCount(message: AnyMessage): number {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return 0;
	return content.filter((c) => !!c && typeof c === "object" && (c as { type?: string }).type === "image").length;
}

export function assistantToolCalls(message: AnyMessage): ToolCall[] {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
	return message.content.filter((c): c is ToolCall => c.type === "toolCall");
}

function thinkingText(message: AnyMessage): string {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.filter((c): c is { type: "thinking"; thinking: string } => c.type === "thinking")
		.map((c) => c.thinking)
		.join("\n");
}

/** Name what a tool call acted on, for the card's second field. */
export function primaryArgument(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const record = args as Record<string, unknown>;
	for (const key of PRIMARY_ARG_KEYS) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return clip(value, ARG_PREVIEW_CHARS);
		if (typeof value === "number") return String(value);
	}
	for (const value of Object.values(record)) {
		if (typeof value === "string" && value.trim()) return clip(value, ARG_PREVIEW_CHARS);
	}
	return "";
}

/** Size of a tool result, in whichever unit is more informative. */
function resultSize(text: string, imageCount: number): string {
	const parts: string[] = [];
	if (text) {
		const lines = text.split("\n").length;
		parts.push(lines > 1 ? `${lines} lines` : `${text.length} chars`);
	}
	if (imageCount > 0) parts.push(`${imageCount} image${imageCount === 1 ? "" : "s"}`);
	return parts.join(", ");
}

function firstErrorLine(text: string): string {
	const line = text.split("\n").find((l) => l.trim());
	return line ? clip(line, ERROR_PREVIEW_CHARS) : "";
}

/** Edit/write detail: added/removed line counts derived from the arguments. */
function editShape(name: string, args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const record = args as Record<string, unknown>;
	const countLines = (value: unknown) => (typeof value === "string" ? value.split("\n").length : 0);
	if (name.includes("write") && typeof record.content === "string") return `${countLines(record.content)} lines written`;
	const removed = countLines(record.old_string ?? record.oldString ?? record.old);
	const added = countLines(record.new_string ?? record.newString ?? record.new);
	if (removed || added) return `+${added} −${removed}`;
	return undefined;
}

export interface ToolRound {
	/** The assistant entry that issued the calls. */
	entryId?: string;
	call: ToolCall;
	result?: { entryId?: string; text: string; isError: boolean; images: number };
}

/**
 * One-line summary of a completed (or still-running) tool round.
 *
 * Shape: `#<id> <tool> · <primary arg> · <status> · <size> [· ✗ <first error line>]`
 * The id is the session entry id of the RESULT when present (that is what
 * advisor_expand resolves), else the issuing assistant entry.
 */
export function renderCard(round: ToolRound): LedgerBlock {
	const id = round.result?.entryId ?? round.entryId;
	const fields: string[] = [round.call.name];
	const arg = primaryArgument(round.call.arguments);
	if (arg) fields.push(arg);
	const shape = editShape(round.call.name, round.call.arguments);
	if (shape) fields.push(shape);
	if (!round.result) {
		fields.push("running");
	} else {
		fields.push(round.result.isError ? "error" : "ok");
		const size = resultSize(round.result.text, round.result.images);
		if (size) fields.push(size);
		// A tool-produced image lives on disk, and this card already names it, so
		// the advisor can load it with `read` instead of being handed the bytes.
		if (round.result.images > 0 && arg) fields.push("read the path above to view");
		if (round.result.isError) {
			const line = firstErrorLine(round.result.text);
			if (line) fields.push(`✗ ${line}`);
		}
	}
	return { kind: "card", id, text: `${id ? `#${id} ` : ""}${fields.join(" · ")}` };
}

/** Verbatim tail rendering of a tool round, each part capped independently. */
export function renderVerbatimRound(round: ToolRound, limits: LedgerLimits): LedgerBlock {
	const id = round.result?.entryId ?? round.entryId;
	const args = JSON.stringify(round.call.arguments ?? {});
	const head = `${id ? `#${id} ` : ""}${round.call.name}(${clipMiddle(args, limits.tailMaxChars, id)})`;
	if (!round.result) return { kind: "card", id, text: `${head}\n→ running` };
	const status = round.result.isError ? "error" : "ok";
	const body = clipMiddle(round.result.text, limits.tailMaxChars, id);
	const images = round.result.images > 0 ? `\n[${round.result.images} image(s) omitted]` : "";
	return { kind: "card", id, text: `${head}\n→ ${status}: ${body}${images}` };
}

/**
 * The user's own words, never dropped.
 *
 * Only 0.1% of a measured payload, and the only direct evidence of intent —
 * every other block is the executor's interpretation of it.
 *
 * A pasted image is named but not embedded. pi's `ImageContent` carries only
 * `{data, mimeType}` — there is no path to hand the advisor for a terminal paste,
 * and inlining the base64 would pin it into the prefix of every later
 * consultation. Tool-produced images are different: their card names the file, so
 * the advisor can `read` it.
 */
export function renderUserMessage(entry: SessionEntry & { type: "message" }, limits: LedgerLimits): LedgerBlock {
	const text = clipMiddle(messageText(entry.message), limits.userMessageMaxChars, entry.id);
	const images = imageCount(entry.message);
	const note =
		images > 0
			? ` [${images} image(s) the user pasted — no file path exists for them; ask the executor what they show if it matters]`
			: "";
	return { kind: "user", id: entry.id, text: `[user] ${text}${note}` };
}

export function renderAssistantText(entry: SessionEntry & { type: "message" }): LedgerBlock | undefined {
	const text = messageText(entry.message).trim();
	if (!text) return undefined;
	return { kind: "assistant", id: entry.id, text: `[executor] ${text}` };
}

/** Executor reasoning — dropped in history, kept only in the tail. */
export function renderAssistantThinking(
	entry: SessionEntry & { type: "message" },
	limits: LedgerLimits,
): LedgerBlock | undefined {
	const text = thinkingText(entry.message).trim();
	if (!text) return undefined;
	return {
		kind: "assistant",
		id: entry.id,
		text: `[executor thinking] ${clipMiddle(text, limits.tailMaxChars, entry.id)}`,
	};
}

/**
 * An extension-authored message. `display: false` entries are hidden from the
 * user, so they are hidden from the advisor too — a note the user never saw
 * must not become evidence the advisor reasons from.
 */
export function renderCustomMessage(
	entry: SessionEntry & { type: "custom_message" },
	limits: LedgerLimits,
): LedgerBlock | undefined {
	if (!entry.display) return undefined;
	const text = typeof entry.content === "string"
		? entry.content
		: (entry.content ?? [])
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("\n");
	if (!text.trim()) return undefined;
	return {
		kind: "custom",
		id: entry.id,
		text: `[extension message: ${entry.customType}] ${clip(text, limits.customPreviewChars)}`,
	};
}

/**
 * A `!` shell command the user ran. `excludeFromContext` marks `!!` runs, which
 * pi keeps out of the executor's own context; the advisor mirrors that.
 */
export function renderBashExecution(entry: SessionEntry & { type: "message" }): LedgerBlock | undefined {
	const message = entry.message as unknown as {
		role: string;
		command: string;
		output: string;
		exitCode?: number;
		excludeFromContext?: boolean;
	};
	if (message.excludeFromContext) return undefined;
	const size = resultSize(message.output ?? "", 0);
	const exit = message.exitCode === undefined ? "?" : String(message.exitCode);
	return {
		kind: "bash",
		id: entry.id,
		text: `#${entry.id} [user shell] ${clip(message.command ?? "", ARG_PREVIEW_CHARS)} · exit ${exit}${size ? ` · ${size}` : ""}`,
	};
}

/**
 * A compaction or branch-summary boundary. Labelled as a summary so the advisor
 * does not mistake pi's paraphrase of the task for the user's own words — the
 * ledger re-states the pre-boundary user messages separately for that.
 */
export function renderSummary(entry: SessionEntry): LedgerBlock | undefined {
	if (entry.type !== "compaction" && entry.type !== "branch_summary") return undefined;
	const summary = (entry as { summary?: string }).summary;
	if (!summary?.trim()) return undefined;
	const label = entry.type === "compaction" ? "compaction summary" : "branch summary";
	return { kind: "summary", id: entry.id, text: `[${label} — pi's paraphrase, not the user's words]\n${summary}` };
}

/** True when this assistant message is issuing an advisor consultation. */
export function isAdvisorCall(message: AnyMessage): boolean {
	return assistantToolCalls(message).some((c) => c.name === ADVISOR_TOOL_NAME);
}

/**
 * A past advisor consultation's own answer. Replayed in the assistant role —
 * the only blocks that are, so the advisor's history is its own words and
 * everything else is data it was shown.
 */
export function renderAdvice(entry: SessionEntry & { type: "message" }): LedgerBlock | undefined {
	const message = entry.message;
	if (message.role !== "toolResult" || message.toolName !== ADVISOR_TOOL_NAME) return undefined;
	const details = message.details as Record<string, unknown> | undefined;
	// A failed, aborted, or skipped consultation carries an operator-facing
	// error string, not advice; replaying it would teach the advisor to answer
	// with error text.
	if (
		message.isError ||
		details?.errorMessage ||
		details?.skipped ||
		details?.stopReason === "error" ||
		details?.stopReason === "aborted"
	)
		return undefined;
	const text = messageText(message).trim();
	if (!text) return undefined;
	return { kind: "advice", id: entry.id, text };
}
