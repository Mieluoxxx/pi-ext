/**
 * Turn-completion notices for spawned pi children.
 *
 * A spawned pi child keeps running after it answers: its TUI stays open, so
 * nothing on the terminal says "I am done with this task". The child's own
 * session transcript does, which is why this watcher exists separately from
 * teardown. A finished turn is announced to the parent exactly once and the
 * session is left alive, so the parent can send follow-up work.
 *
 * Announcing is keyed by the closing entry id, so a new turn re-arms the
 * watcher without announcing the same answer twice.
 */
import { statSync } from "node:fs";
import { findPiSessionFile, readPiSettlement } from "./pi-settlement.ts";
import type { PiSettlementResult } from "./types.ts";

/** How often a running child's transcript is re-read. */
export const DEFAULT_PI_SETTLEMENT_POLL_MS = 1000;

export interface PiSettlementWatchOptions {
	/** The private `--session-dir` given to the child. */
	sessionDir: string;
	/** Called once per finished turn, with the child's closing answer. */
	onSettled: (turn: PiSettlementResult) => void;
	intervalMs?: number;
	/** Return false once the child process is gone; watching then stops on its own. */
	isAlive?: () => boolean;
}

/**
 * Watch a spawned pi child's transcript and report each finished turn.
 * @returns a stop function; idempotent and cheap to call on teardown.
 */
export function watchPiSettlement(options: PiSettlementWatchOptions): () => void {
	let stopped = false;
	// A forked child's private session begins as a copy of its parent's, so an
	// answer that already existed when the watcher started belongs to the parent,
	// not to this child. Recording it as the baseline is what keeps the child's
	// inherited history from being announced as its first turn.
	const inherited = readPiSettlement(options.sessionDir);
	let lastSignature: string | undefined;
	let announcedEntryId: string | undefined = inherited.state === "settled" ? inherited.entryId : undefined;

	const tick = (): void => {
		if (stopped) return;
		// Liveness is evaluated after reading, never before: a child that answers and
		// exits within one poll interval must still have that turn announced.
		const alive = options.isAlive ? options.isAlive() : true;
		try {
			readAndAnnounce();
		} catch (error) {
			// A throwing parent callback must not escape setInterval and kill the host.
			console.error("interactive-shell: settlement watcher error:", error);
		}
		if (!alive) stop();
	};

	const readAndAnnounce = (): void => {
		const file = findPiSessionFile(options.sessionDir);
		if (!file) return;
		// A stat gate keeps a long-running child from re-parsing its file every second.
		let signature: string;
		try {
			const { size, mtimeMs } = statSync(file);
			signature = `${file}\u0000${size}\u0000${mtimeMs}`;
		} catch {
			return;
		}
		if (signature === lastSignature) return;

		const settlement = readPiSettlement(options.sessionDir);
		// Only a definite verdict may consume the signature: an `unknown` or a
		// mid-turn read is a transient state, and retrying costs one stat.
		if (settlement.state === "unknown") return;
		lastSignature = signature;

		if (settlement.state !== "settled" || settlement.entryId === announcedEntryId) return;
		announcedEntryId = settlement.entryId;
		options.onSettled({
			text: settlement.text,
			stopReason: settlement.stopReason,
			entryId: settlement.entryId,
		});
	};

	const timer = setInterval(tick, options.intervalMs ?? DEFAULT_PI_SETTLEMENT_POLL_MS);
	timer.unref();
	const stop = (): void => {
		if (stopped) return;
		stopped = true;
		clearInterval(timer);
	};
	return stop;
}
