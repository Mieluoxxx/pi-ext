import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Wiring checks that a unit test of the settlement modules cannot catch.
 *
 * Both defects these lock down were shipped and only found by review: the
 * foreground overlay never forwarded the child's session directory, and the
 * watcher liveness test counted a killed session as alive.
 */
describe("settlement wiring", () => {
	it("forwards piSessionDir to every overlay that can auto-exit on quiet", () => {
		const source = readFileSync(join(import.meta.dirname, "..", "index.ts"), "utf8");
		const blocks = source.split("new InteractiveShellOverlay(").slice(1);
		expect(blocks.length).toBeGreaterThan(0);
		// The `/spawn` interactive overlay has no session and never auto-exits, so it is
		// out of scope; every quiet-capable overlay must hand the session directory over.
		const quietCapable = blocks.filter((block) => block.slice(0, block.indexOf("}, config, done)")).includes("autoExitOnQuiet"));
		expect(quietCapable.length).toBeGreaterThan(0);
		for (const block of quietCapable) {
			const optionObject = block.slice(0, block.indexOf("}, config, done)"));
			expect(optionObject).toContain("piSessionDir:");
		}
	});

	it("treats only running states as a live child, not a killed one", () => {
		const source = readFileSync(join(import.meta.dirname, "..", "index.ts"), "utf8");
		const watch = source.slice(source.indexOf("function startSettlementWatch"));
		const liveness = watch.slice(0, watch.indexOf("onSettled:"));
		// A killed or exited session must never keep the watcher polling.
		expect(liveness).toContain('"running"');
		expect(liveness).toContain('"monitoring"');
		expect(liveness).not.toContain('!== "exited"');
	});

	it("names an unfinished turn by its stop reason instead of claiming success", async () => {
		const { buildSettlementNotice } = await import("../notification-utils.ts");
		const base = { text: "partial", entryId: "e1" };
		expect(buildSettlementNotice("s", { ...base, stopReason: "stop" })).toContain("finished its turn");
		expect(buildSettlementNotice("s", { ...base, stopReason: "error" })).toContain("failed mid-turn");
		expect(buildSettlementNotice("s", { ...base, stopReason: "aborted" })).toContain("was interrupted mid-turn");
		expect(buildSettlementNotice("s", { ...base, stopReason: "length" })).toContain("hit its output limit mid-turn");
		// The closing text is still delivered; only the claim about it changes.
		expect(buildSettlementNotice("s", { ...base, stopReason: "error" })).toContain("partial");
	});
});

describe("natural exit keeps the reported turn", () => {
	it("carries the settlement out of finishWithExit", () => {
		const source = readFileSync(join(import.meta.dirname, "..", "overlay-component.ts"), "utf8");
		const exit = source.slice(source.indexOf("private finishWithExit"));
		const result = exit.slice(0, exit.indexOf("this.completionResult = result"));
		// Without this the caller cannot suppress a closing message the watcher sent.
		expect(result).toContain("readPiSettlement");
		expect(result).toContain("agent-settled");
	});
});
