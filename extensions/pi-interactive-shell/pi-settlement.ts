/**
 * Settlement detection for spawned pi children.
 *
 * A pi child writes its own session JSONL: the file appears with the first
 * user/assistant message and every entry is appended synchronously. The last
 * assistant message on the active branch says whether the child is still
 * working or finished a turn, which is a real signal. "The pty went quiet" is
 * not one: pi's TUI renders nothing while a model call is in flight, so a
 * quiet dispatch would otherwise kill a thinking child mid-turn.
 *
 * Every ending stays named: a child we read as finished reports `agent-settled`
 * and its closing text, a child we cannot read keeps the quiet heuristic and
 * still reports `auto-close-quiet`. Results are never upgraded by guesswork.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PiSettlementResult } from "./types.ts";

/** Stop reasons that end a turn with the child's final answer. */
const TERMINAL_STOP_REASONS = new Set(["stop", "length", "error", "aborted", "deferred"]);

/** How long a quiet child may keep working before the quiet heuristic wins anyway. */
export const DEFAULT_PI_SETTLEMENT_MAX_WAIT_MS = 30 * 60 * 1000;

export type PiSettlementState = "settled" | "running" | "unknown";

/** A finished turn: the child's closing answer, already narrowed. */
export interface SettledPiTurn extends PiSettlementResult {
	state: "settled";
}

export type PiSettlement =
	| SettledPiTurn
	| { state: "running"; stopReason?: string }
	| { state: "unknown" };

/** Verdict for a child we cannot observe: the quiet heuristic keeps its old meaning. */
export const UNKNOWN_SETTLEMENT: PiSettlement = { state: "unknown" };

/** What one quiet interval means for a spawned pi child. */
export interface QuietVerdict {
	/** Keep the session alive: the child is mid-turn and the wait cap is not reached. */
	wait: boolean;
	/** Present only when the child finished a turn and should be stopped now. */
	settled?: SettledPiTurn;
}

interface SessionEntry {
	type?: unknown;
	id?: unknown;
	parentId?: unknown;
	message?: unknown;
	targetId?: unknown;
	replacement?: unknown;
	timestamp?: unknown;
}

/** Newest session file in the child's private session directory, if pi created one yet. */
export function findPiSessionFile(sessionDir: string | undefined): string | undefined {
	if (!sessionDir) return undefined;
	let names: string[];
	try {
		names = readdirSync(sessionDir);
	} catch {
		return undefined;
	}
	let newest: string | undefined;
	let newestMtime = -1;
	for (const name of names) {
		if (!name.endsWith(".jsonl")) continue;
		const path = join(sessionDir, name);
		try {
			const { mtimeMs } = statSync(path);
			if (mtimeMs > newestMtime) {
				newest = path;
				newestMtime = mtimeMs;
			}
		} catch {
			// The file rotated between readdir and stat.
		}
	}
	return newest;
}

function parseEntries(content: string): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (typeof value === "object" && value !== null && typeof (value as SessionEntry).type === "string") {
				entries.push(value as SessionEntry);
			}
		} catch {
			// A partially appended trailing record is expected while pi is running.
		}
	}
	return entries;
}

/**
 * Follow parentId from the last appended entry.
 *
 * pi's `branch()` only moves the in-memory leaf and never rewrites the file, so
 * the last appended entry is the leaf for a live child but NOT a reliable one
 * after a rewind. Nothing in the format records the leaf, so this is the best
 * available reading, not a guarantee.
 */
function activeBranch(entries: SessionEntry[]): SessionEntry[] {
	const byId = new Map<string, SessionEntry>();
	for (const entry of entries) {
		if (typeof entry.id === "string") byId.set(entry.id, entry);
	}
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	let current: SessionEntry | undefined = entries.at(-1);
	while (current) {
		if (typeof current.id === "string") {
			if (seen.has(current.id)) break;
			seen.add(current.id);
		}
		branch.push(current);
		const parentId = current.parentId;
		current = typeof parentId === "string" ? byId.get(parentId) : undefined;
	}
	return branch.reverse();
}

function assistantText(message: Record<string, unknown>): string {
	if (!Array.isArray(message.content)) return "";
	const parts: string[] = [];
	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		const item = block as Record<string, unknown>;
		if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
	}
	return parts.join("\n").trim();
}

/** True when a context edit removed this entry from the model's projection. */
function isOmittedEdit(entry: SessionEntry): boolean {
	return entry.type === "context_edit" && entry.replacement === null;
}

/**
 * Read what a spawned pi child's session says about the current turn.
 * @param sessionDir - the private `--session-dir` given to the child.
 * @returns `settled` with the closing text, `running` mid-turn, or `unknown`
 *   when nothing is readable yet (no file, no entries, or no messages).
 */
export function readPiSettlement(sessionDir: string | undefined): PiSettlement {
	const file = findPiSessionFile(sessionDir);
	if (!file) return UNKNOWN_SETTLEMENT;
	let content: string;
	try {
		content = readFileSync(file, "utf8");
	} catch {
		return UNKNOWN_SETTLEMENT;
	}
	// A record is being appended right now, so the last readable verdict is stale:
	// the next turn has already started. This is the narrow window where guessing
	// wrong kills a child that just received work.
	if (/[^\n]$/.test(content)) return { state: "running" };

	const entries = parseEntries(content);
	if (entries.length === 0) return UNKNOWN_SETTLEMENT;

	const branch = activeBranch(entries);
	// A failed attempt that pi is retrying is durably removed from the model
	// projection by a null context edit but stays in the file. Reading the last
	// assistant message would call that crash a finished turn.
	const omitted = new Set(branch.filter(isOmittedEdit).map((entry) => entry.targetId));

	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		// Model, thinking-level, usage, compaction, and context entries carry no verdict.
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (typeof message !== "object" || message === null) continue;
		const record = message as Record<string, unknown>;
		if (record.role !== "assistant") {
			// A user prompt or tool result is waiting on the model.
			return { state: "running" };
		}
		if (typeof entry.id === "string" && omitted.has(entry.id)) {
			return { state: "running", stopReason: "retrying" };
		}
		const stopReason = typeof record.stopReason === "string" ? record.stopReason : undefined;
		// An entry without a usable id cannot be deduplicated by the turn watcher.
		if (stopReason !== undefined && TERMINAL_STOP_REASONS.has(stopReason) && typeof entry.id === "string") {
			return { state: "settled", text: assistantText(record), stopReason, entryId: entry.id };
		}
		return { state: "running", stopReason };
	}
	return UNKNOWN_SETTLEMENT;
}

/**
 * Decide what one quiet interval means for a spawned pi child.
 * @param sessionDir - the child's private session directory, if we own its layout.
 * @param startedAt - epoch ms the session started, for the hard wait cap.
 * @param maxWaitMs - longest a still-running child may outlast the quiet heuristic.
 * @param now - current epoch ms.
 */
export function judgeQuiet(
	sessionDir: string | undefined,
	startedAt: number,
	maxWaitMs: number,
	now = Date.now(),
): QuietVerdict {
	if (!sessionDir) return { wait: false };
	const settlement = readPiSettlement(sessionDir);
	if (settlement.state === "settled") return { wait: false, settled: settlement };
	if (settlement.state === "running") {
		// A long-lived session must not spend its budget before the current turn: the
		// cap bounds one turn, so it starts at the last sign of progress.
		const anchor = Math.max(startedAt, lastProgressAt(sessionDir) ?? 0);
		if (now - anchor < maxWaitMs) return { wait: true };
	}
	return { wait: false };
}

/** Epoch ms of the child's last transcript write, if the file exists. */
function lastProgressAt(sessionDir: string): number | undefined {
	const file = findPiSessionFile(sessionDir);
	if (!file) return undefined;
	try {
		return statSync(file).mtimeMs;
	} catch {
		return undefined;
	}
}
