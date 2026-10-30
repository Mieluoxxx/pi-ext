import { describe, expect, it } from "vitest";
import { createSessionQueryState, getSessionOutput } from "../session-query.ts";
import type { InteractiveShellConfig } from "../config.ts";

const config: InteractiveShellConfig = {
	defer: false,
	exitAutoCloseDelay: 10,
	overlayWidthPercent: 95,
	overlayHeightPercent: 60,
	overlayAnchor: "center",
	focusShortcut: "alt+shift+f",
	spawn: {
		defaultAgent: "pi",
		shortcut: "alt+shift+p",
		commands: { pi: "pi", codex: "codex", claude: "claude", cursor: "agent" },
		defaultArgs: { pi: [], codex: [], claude: [], cursor: [] },
		worktree: false,
		worktreeBaseDir: undefined,
	},
	scrollbackLines: 5000,
	ansiReemit: true,
	handoffPreviewEnabled: true,
	handoffPreviewLines: 30,
	handoffPreviewMaxChars: 2000,
	handoffSnapshotEnabled: false,
	handoffSnapshotLines: 200,
	handoffSnapshotMaxChars: 12000,
	transferLines: 200,
	transferMaxChars: 20000,
	completionNotifyLines: 50,
	completionNotifyMaxChars: 5000,
	handsFreeUpdateMode: "on-quiet",
	handsFreeUpdateInterval: 60000,
	handsFreeQuietThreshold: 8000,
	autoExitGracePeriod: 15000,
	handsFreeUpdateMaxChars: 1500,
	handsFreeMaxTotalChars: 100000,
	minQueryIntervalSeconds: 60,
};

function makeSession() {
	return {
		getTailLines: ({ lines, maxChars }: { lines: number; maxChars?: number }) => ({
			lines: ["alpha", "beta", "gamma"].slice(-lines),
			totalLinesInBuffer: 3,
			truncatedByChars: Boolean(maxChars && maxChars < 5),
		}),
		readStreamFrom: ({ from = 0 }: { from?: number }) => {
			const raw = "alpha\nbeta\ngammadelta\nepsilon";
			return { output: raw.substring(from), nextOffset: raw.length };
		},
		getLogSlice: ({ offset = 0, limit = 50 }: { offset?: number; limit?: number }) => {
			const lines = ["zero", "one", "two", "three"];
			const selected = lines.slice(offset, offset + limit);
			return {
				slice: selected.join("\n"),
				totalLines: lines.length,
				totalChars: lines.join("\n").length,
				sliceLineCount: selected.length,
			};
		},
	} as any;
}

describe("getSessionOutput", () => {
	it("returns completion output immediately for finished sessions", () => {
		const state = createSessionQueryState();
		const result = getSessionOutput(makeSession(), config, state, false, {
			lines: ["done"],
			totalLines: 1,
			truncated: false,
		});
		expect(result).toEqual({ output: "done", truncated: false, totalBytes: 4, totalLines: 1 });
	});

	it("supports incremental pagination with tracked position", () => {
		const state = createSessionQueryState();
		const session = makeSession();
		expect(getSessionOutput(session, config, state, { incremental: true, lines: 2 })).toMatchObject({
			output: "zero\none",
			totalLines: 4,
			hasMore: true,
		});
		expect(getSessionOutput(session, config, state, { incremental: true, lines: 2, skipRateLimit: true })).toMatchObject({
			output: "two\nthree",
			totalLines: 4,
			hasMore: false,
		});
	});

	it("supports drain mode and offset mode", () => {
		const state = createSessionQueryState();
		const session = makeSession();
		expect(getSessionOutput(session, config, state, { drain: true, maxChars: 5 })).toEqual({
			output: "silon",
			truncated: true,
			totalBytes: 5,
		});
		expect(getSessionOutput(session, config, state, { offset: 1, lines: 2, skipRateLimit: true })).toMatchObject({
			output: "one\ntwo",
			totalLines: 4,
			hasMore: true,
			truncated: true,
		});
	});

	it("falls back for non-finite output query limits", () => {
		const state = createSessionQueryState();
		let captured: { lines: number; maxChars?: number } | undefined;
		const session = {
			getTailLines: (options: { lines: number; maxChars?: number }) => {
				captured = options;
				return { lines: ["alpha"], totalLinesInBuffer: 1, truncatedByChars: false };
			},
			readStreamFrom: () => ({ output: "", nextOffset: 0 }),
			getLogSlice: () => ({ slice: "", totalLines: 0, totalChars: 0, sliceLineCount: 0 }),
		} as any;

		getSessionOutput(session, config, state, {
			lines: Number.NaN,
			maxChars: Number.POSITIVE_INFINITY,
		});

		expect(captured).toMatchObject({ lines: 20, maxChars: 5120 });
	});

	it("rate limits repeated queries until enough time has passed", () => {
		const state = createSessionQueryState();
		const session = makeSession();
		const first = getSessionOutput(session, config, state);
		expect(first.output).toBe("alpha\nbeta\ngamma");
		const second = getSessionOutput(session, config, state);
		expect(second.rateLimited).toBe(true);
		expect(second.waitSeconds).toBeGreaterThan(0);
	});
});

describe("drain and hands-free updates own separate cursors", () => {
	// The bug this locks down: `getRawStream({ sinceLast: true })` advanced one
	// field on the terminal, so whichever reader ran first consumed the bytes the
	// other still needed, and the loss was silent.
	function makeCursorSession() {
		let raw = "";
		return {
			append(text: string) { raw += text; },
			readStreamFrom({ from = 0 }: { from?: number } = {}) {
				const offset = Math.max(0, Math.min(from, raw.length));
				return { output: raw.substring(offset), nextOffset: raw.length };
			},
			getTailLines: () => ({ lines: [], totalLinesInBuffer: 0, truncatedByChars: false }),
			getLogSlice: () => ({ slice: "", totalLines: 0, totalChars: 0, sliceLineCount: 0 }),
		} as any;
	}

	it("gives drain its own cursor, so a later reader still sees new bytes", () => {
		const session = makeCursorSession();
		const queryState = createSessionQueryState();
		const handsFreeCursor = { offset: 0 };

		session.append("first batch\n");
		const drained = getSessionOutput(session, config, queryState, { drain: true, skipRateLimit: true }).output;
		expect(drained).toContain("first batch");

		session.append("second batch\n");
		const update = session.readStreamFrom({ from: handsFreeCursor.offset });
		handsFreeCursor.offset = update.nextOffset;
		// The old shared cursor returned "" here; the bytes are what the bug ate.
		expect(update.output).toContain("second batch");

		// And drain resumes where it left off, not at the hands-free position.
		const drainedAgain = getSessionOutput(session, config, queryState, { drain: true, skipRateLimit: true }).output;
		expect(drainedAgain).toContain("second batch");
	});

	it("keeps the hands-free cursor independent of a drain in between", () => {
		const session = makeCursorSession();
		const queryState = createSessionQueryState();
		let handsFreeOffset = 0;

		session.append("alpha\n");
		const first = session.readStreamFrom({ from: handsFreeOffset });
		handsFreeOffset = first.nextOffset;
		expect(first.output).toContain("alpha");

		session.append("beta\n");
		getSessionOutput(session, config, queryState, { drain: true, skipRateLimit: true });

		const next = session.readStreamFrom({ from: handsFreeOffset });
		handsFreeOffset = next.nextOffset;
		expect(next.output).toContain("beta");
		expect(next.output).not.toContain("alpha");
	});
});
