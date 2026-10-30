import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `/attach` and the tool's `attach` action share one overlay now.
 *
 * The behaviour that makes this safe: `/attach` keeps its entry in the background
 * table, so a host teardown (reload, new session) calls dispose() on a live
 * overlay. Killing the PTY there would SIGKILL a process the user still relies on,
 * which the deleted reattach overlay never did.
 */
const source = (file: string) => readFileSync(join(import.meta.dirname, "..", file), "utf8");

describe("attached overlay teardown", () => {
	it("detaches on dispose for every path, not only before completion", () => {
		const overlay = source("overlay-component.ts");
		const dispose = overlay.slice(overlay.indexOf("dispose(): void {"));
		const body = dispose.slice(0, dispose.indexOf("\n\t}") + 3);
		const guard = body.indexOf("if (this.options.detachOnDispose)");
		const kill = body.indexOf("this.session.kill()");

		expect(guard).toBeGreaterThan(-1);
		// The detach must not sit inside `if (!this.completionResult)`: an attached
		// session that already produced a result would then skip the detach branch.
		const completionGuard = body.indexOf("if (!this.completionResult)");
		expect(guard).toBeLessThan(completionGuard);
		expect(kill).toBeGreaterThan(completionGuard);
	});

	it("routes the /attach command through the shared overlay and keeps its entry", () => {
		const index = source("index.ts");
		const attach = index.slice(index.indexOf('pi.registerCommand("attach"'));
		const body = attach.slice(0, attach.indexOf('pi.registerCommand("dismiss"'));

		expect(body).toContain("new InteractiveShellOverlay");
		expect(body).toContain("detachOnDispose: true");
		// Keeping the entry lets kill/dismiss still find it; taking it out would
		// leave a disposed PTY referenced by the background table.
		expect(body).toContain("sessionManager.get(targetId)");
	});

	it("carries the fields a re-attach must not lose", () => {
		const index = source("index.ts");
		const attach = index.slice(index.indexOf('pi.registerCommand("attach"'));
		const body = attach.slice(0, attach.indexOf('pi.registerCommand("dismiss"'));
		// Losing these resets the displayed duration and kills pi-child turn notices.
		expect(body).toContain("startedAt: session.startedAt.getTime()");
		expect(body).toContain("piSessionDir: session.piSessionDir");
	});

	it("drops the background row when the attached session ends", () => {
		const index = source("index.ts");
		const attach = index.slice(index.indexOf('pi.registerCommand("attach"'));
		const body = attach.slice(0, attach.indexOf('pi.registerCommand("dismiss"'));
		// Not scheduleCleanup: a dead row must not linger in action:"list" for 30s.
		expect(body).toContain("sessionManager.remove(targetId)");
		expect(body).toContain("sessionManager.restartAutoCleanup(targetId)");
	});
});
