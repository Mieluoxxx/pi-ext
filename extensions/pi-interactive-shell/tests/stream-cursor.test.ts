import { describe, expect, it } from "vitest";
import { PtyTerminalSession } from "../pty-session.ts";
import { MAX_RAW_OUTPUT_SIZE, trimRawOutput } from "../pty-log.ts";

/**
 * Cursor semantics across buffer trimming.
 *
 * `trimRawOutput` drops the FRONT of the buffer once it exceeds 1MB. A reader
 * that stores an absolute offset would silently lose bytes: the surviving data
 * shifts down, and a cursor pointing into the tail clamps to the new end and
 * skips everything still unread.
 */
interface RawInternals {
	rawOutput: string;
	trimBase: number;
	readStreamFrom(options?: { from?: number; stripAnsi?: boolean }): { output: string; nextOffset: number };
}

// The PTY is never started: only the offset bookkeeping is under test.
function makeSession(): RawInternals & Pick<PtyTerminalSession, "readStreamFrom"> {
	const session = Object.create(PtyTerminalSession.prototype) as unknown as RawInternals & Pick<PtyTerminalSession, "readStreamFrom">;
	session.rawOutput = "";
	session.trimBase = 0;
	return session;
}

function appendRaw(session: RawInternals, text: string): void {
	session.rawOutput += text;
	const trimmed = trimRawOutput(session.rawOutput);
	session.rawOutput = trimmed.rawOutput;
	session.trimBase += trimmed.trimAmount;
}

describe("trimRawOutput", () => {
	it("keeps half the ceiling and reports what it dropped", () => {
		const big = "a".repeat(MAX_RAW_OUTPUT_SIZE + 1000);
		const trimmed = trimRawOutput(big);
		expect(trimmed.rawOutput.length).toBe(Math.floor(MAX_RAW_OUTPUT_SIZE / 2));
		expect(trimmed.trimAmount).toBe(big.length - trimmed.rawOutput.length);
	});

	it("reports no drop while under the ceiling", () => {
		const trimmed = trimRawOutput("small");
		expect(trimmed.trimAmount).toBe(0);
		expect(trimmed.rawOutput).toBe("small");
	});
});

describe("readStreamFrom across a trim", () => {
	it("does not skip unread bytes when the cursor points into the surviving tail", () => {
		const session = makeSession();
		appendRaw(session, "head\n");
		const first = session.readStreamFrom({ from: 0 });
		expect(first.output).toBe("head\n");

		// Fill past the ceiling so the front is dropped, then add the bytes the
		// reader is actually waiting for.
		appendRaw(session, "x".repeat(MAX_RAW_OUTPUT_SIZE + 5000));
		expect(session.trimBase).toBeGreaterThan(0);
		const afterFill = session.readStreamFrom({ from: first.nextOffset });
		expect(afterFill.output.length).toBeGreaterThan(0);

		appendRaw(session, "TAILMARK\n");
		const next = session.readStreamFrom({ from: afterFill.nextOffset });
		// The old absolute-offset implementation returned "" or a gap here.
		expect(next.output).toContain("TAILMARK");
	});

	it("resumes at the buffer head for a cursor that fell off the trimmed front", () => {
		const session = makeSession();
		appendRaw(session, "ancient\n");
		const stale = session.readStreamFrom({ from: 0 });
		appendRaw(session, "y".repeat(MAX_RAW_OUTPUT_SIZE + 5000));

		const read = session.readStreamFrom({ from: stale.nextOffset });
		// Not "" and not a byte-shifted slice: the reader gets the surviving window.
		expect(read.output.length).toBe(session.rawOutput.length);
		expect(read.nextOffset).toBe(session.trimBase + session.rawOutput.length);
	});

	it("gives two independent readers their own bytes", () => {
		const session = makeSession();
		appendRaw(session, "both read this\n");
		const a = session.readStreamFrom({ from: 0 });
		const b = session.readStreamFrom({ from: 0 });
		expect(a.output).toBe(b.output);
		expect(a.nextOffset).toBe(b.nextOffset);

		appendRaw(session, "second\n");
		const a2 = session.readStreamFrom({ from: a.nextOffset });
		const b2 = session.readStreamFrom({ from: b.nextOffset });
		expect(a2.output).toBe("second\n");
		expect(b2.output).toBe("second\n");
	});

	it("measures nextOffset in raw bytes even when ANSI stripping shortens the output", () => {
		const session = makeSession();
		appendRaw(session, "\u001b[31mred\u001b[0m\n");
		const read = session.readStreamFrom({ from: 0 });
		expect(read.output).toBe("red\n");
		expect(read.nextOffset).toBe(session.rawOutput.length);
	});
});
