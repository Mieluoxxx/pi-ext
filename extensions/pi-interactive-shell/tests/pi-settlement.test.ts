import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let agentDir: string;
let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "interactive-shell-settlement-"));
	agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	vi.resetModules();
	vi.doMock("@earendil-works/pi-coding-agent", () => ({
		getAgentDir: () => agentDir,
		getShellConfig: () => ({ shell: "/bin/bash", args: ["-c"] }),
		SettingsManager: { create: () => ({ getShellPath: () => undefined }) },
	}));
});

afterEach(() => {
	vi.doUnmock("@earendil-works/pi-coding-agent");
	rmSync(root, { recursive: true, force: true });
});

interface Entry {
	type: string;
	id: string;
	parentId: string | null;
	message?: unknown;
	targetId?: string;
	replacement?: unknown;
}

function writeSession(dir: string, entries: Array<Omit<Entry, "id" | "parentId"> & { id?: string; parentId?: string | null }>, tail = ""): string {
	mkdirSync(dir, { recursive: true });
	const lines: string[] = [JSON.stringify({ type: "session", version: 3, id: "child", timestamp: "2026-01-01T00:00:00.000Z", cwd: dir })];
	let previous: string | null = null;
	entries.forEach((entry, index) => {
		const id = entry.id ?? `e${index}`;
		lines.push(JSON.stringify({ ...entry, id, parentId: entry.parentId === undefined ? previous : entry.parentId }));
		previous = id;
	});
	writeFileSync(join(dir, "2026-01-01T00-00-00-000Z_child.jsonl"), `${lines.join("\n")}\n${tail}`);
	return dir;
}

const user = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (text: string, stopReason: string) => ({
	type: "message",
	message: { role: "assistant", stopReason, content: [{ type: "text", text }] },
});

describe("pi settlement reader", () => {
	it("reports unknown until pi has written a message", async () => {
		const { readPiSettlement } = await import("../pi-settlement.ts");
		expect(readPiSettlement(undefined)).toEqual({ state: "unknown" });
		expect(readPiSettlement(join(root, "missing"))).toEqual({ state: "unknown" });
		writeSession(join(root, "settings-only"), [
			{ type: "model_change", message: undefined },
			{ type: "thinking_level_change", message: undefined },
		]);
		expect(readPiSettlement(join(root, "settings-only"))).toEqual({ state: "unknown" });
	});

	it("reports running while the model owes an answer", async () => {
		const { readPiSettlement } = await import("../pi-settlement.ts");
		writeSession(join(root, "pending"), [user("do the thing")]);
		expect(readPiSettlement(join(root, "pending"))).toEqual({ state: "running" });

		writeSession(join(root, "tool-use"), [user("do the thing"), assistant("reading files", "toolUse")]);
		expect(readPiSettlement(join(root, "tool-use"))).toEqual({ state: "running", stopReason: "toolUse" });
	});

	it("reports a settled turn with its closing text and stop reason", async () => {
		const { readPiSettlement } = await import("../pi-settlement.ts");
		writeSession(join(root, "done"), [user("do the thing"), assistant("All tests pass.\nDone.", "stop")]);
		expect(readPiSettlement(join(root, "done"))).toEqual({
			state: "settled",
			text: "All tests pass.\nDone.",
			stopReason: "stop",
			entryId: "e1",
		});

		for (const stopReason of ["length", "aborted", "error", "deferred"]) {
			const dir = writeSession(join(root, `stop-${stopReason}`), [user("go"), assistant("partial", stopReason)]);
			expect(readPiSettlement(dir).state).toBe("settled");
		}
	});

	it("follows the active branch instead of an abandoned one", async () => {
		const { readPiSettlement } = await import("../pi-settlement.ts");
		const dir = writeSession(join(root, "branched"), [
			user("try approach A"),
			{ ...assistant("A finished", "stop"), id: "abandoned" },
			// A rewind returns the leaf to the user message and a new turn starts from it.
			{ ...user("try approach B"), id: "retry", parentId: "e0" },
			{ ...assistant("B is still running", "toolUse"), id: "active", parentId: "retry" },
		]);
		expect(readPiSettlement(dir)).toEqual({ state: "running", stopReason: "toolUse" });
	});

	it("reads a half-written trailing record as a turn in progress", async () => {
		const { readPiSettlement } = await import("../pi-settlement.ts");
		// pi appends one record per turn with a trailing newline, so a file that does
		// not end in one is mid-write: the previous verdict is already stale.
		const tornAssistant = writeSession(
			join(root, "torn-assistant"),
			[user("go"), assistant("done", "stop")],
			'{"type":"message","id":"e9","parentId":"e1","message":{"role":"assis',
		);
		expect(readPiSettlement(tornAssistant).state).toBe("running");

		const tornUser = writeSession(
			join(root, "torn-user"),
			[user("go"), assistant("first round", "stop")],
			'{"type":"message","id":"e9","parentId":"e1","message":{"role":"user","content":[{"type":"te',
		);
		expect(readPiSettlement(tornUser).state).toBe("running");
	});

	it("reads a retried failed attempt as still running", async () => {
		const { readPiSettlement } = await import("../pi-settlement.ts");
		// pi keeps a failed attempt in the file but removes it from the model
		// projection with a null context edit before retrying. An auto-close that
		// trusts the raw last message would kill a child that is actively retrying.
		const dir = writeSession(join(root, "retrying"), [
			user("go"),
			assistant("provider blew up", "error"),
			{ type: "context_edit", targetId: "e1", replacement: null },
		]);
		expect(readPiSettlement(dir)).toEqual({ state: "running", stopReason: "retrying" });
	});
});

describe("quiet verdicts", () => {
	it("keeps a mid-turn child alive until the wait cap", async () => {
		const { judgeQuiet } = await import("../pi-settlement.ts");
		const dir = writeSession(join(root, "working"), [user("go"), assistant("thinking", "toolUse")]);
		// The cap bounds one turn, so it is anchored on the last transcript write and
		// cannot be spent by a session that merely started long ago.
		const now = Date.now();
		expect(judgeQuiet(dir, now, 60_000, now + 1_000)).toEqual({ wait: true });
		expect(judgeQuiet(dir, now, 60_000, now + 60_001)).toEqual({ wait: false });
		const longLived = writeSession(join(root, "long-lived"), [user("go"), assistant("thinking", "toolUse")]);
		expect(judgeQuiet(longLived, now - 3_600_000, 60_000, now + 1_000)).toEqual({ wait: true });
	});

	it("stops a settled child and leaves unobserved children to the quiet heuristic", async () => {
		const { judgeQuiet } = await import("../pi-settlement.ts");
		const dir = writeSession(join(root, "settled"), [user("go"), assistant("the answer", "stop")]);
		expect(judgeQuiet(dir, 0, 60_000)).toEqual({
			wait: false,
			settled: { state: "settled", text: "the answer", stopReason: "stop", entryId: "e1" },
		});
		expect(judgeQuiet(undefined, 0, 60_000)).toEqual({ wait: false });
		expect(judgeQuiet(join(root, "missing"), 0, 60_000)).toEqual({ wait: false });
	});
});

describe("spawned pi session layout", () => {
	it("reserves a private session run under the agent directory", async () => {
		const { createPiSessionRun } = await import("../spawn.ts");
		const run = createPiSessionRun();
		expect(run.id).toMatch(/^shell-[0-9a-f]{8}$/);
		expect(run.dir.startsWith(join(agentDir, "interactive-shell", "pi-sessions"))).toBe(true);
		expect(() => writeFileSync(join(run.dir, "probe.jsonl"), "")).not.toThrow();
	});

	it("gives a spawned pi child an observable session and leaves other agents alone", async () => {
		const { createPiSessionRun, resolveSpawn } = await import("../spawn.ts");
		const { loadConfig } = await import("../config.ts");
		const config = loadConfig(join(root, "project"));
		const piSession = createPiSessionRun();

		const pi = resolveSpawn(config, "/tmp/project", { agent: "pi", prompt: "review" }, () => undefined, { piSession });
		expect(pi.ok && pi.spawn.piSessionDir).toBe(piSession.dir);
		expect(pi.ok && pi.spawn.command).toContain(`--session-dir ${piSession.dir} --session-id ${piSession.id}`);

		const codex = resolveSpawn(config, "/tmp/project", { agent: "codex", prompt: "review" }, () => undefined, { piSession });
		expect(codex.ok && codex.spawn.piSessionDir).toBeUndefined();
		expect(codex.ok && codex.spawn.command).not.toContain("--session-dir");
	});

	it("does not fight a user-chosen session but still combines with --fork", async () => {
		const { createPiSessionRun, resolveSpawn } = await import("../spawn.ts");
		const { loadConfig } = await import("../config.ts");
		const base = loadConfig(join(root, "project"));
		const piSession = createPiSessionRun();

		const ownSession = {
			...base,
			spawn: { ...base.spawn, defaultArgs: { ...base.spawn.defaultArgs, pi: ["--session", "/tmp/own.jsonl"] } },
		};
		const skipped = resolveSpawn(ownSession, "/tmp/project", { agent: "pi", prompt: "review" }, () => undefined, { piSession });
		expect(skipped.ok && skipped.spawn.piSessionDir).toBeUndefined();
		expect(skipped.ok && skipped.spawn.command).not.toContain(piSession.dir);

		const forked = resolveSpawn(base, "/tmp/project", { agent: "pi", mode: "fork", prompt: "review" }, () => "/tmp/parent.jsonl", { piSession });
		expect(forked.ok && forked.spawn.piSessionDir).toBe(piSession.dir);
		expect(forked.ok && forked.spawn.command).toContain("--fork /tmp/parent.jsonl");
		expect(forked.ok && forked.spawn.command).toContain(`--session-id ${piSession.id}`);
	});
});

describe("turn watcher", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("announces a finished turn once and re-arms for the next one", async () => {
		const { watchPiSettlement } = await import("../pi-settlement-watcher.ts");
		const dir = join(root, "watched");
		// Real ordering: the watcher starts at spawn time, before the child writes.
		const seen: Array<{ text: string; entryId: string }> = [];
		const stop = watchPiSettlement({ sessionDir: dir, intervalMs: 100, onSettled: (turn) => seen.push({ text: turn.text, entryId: turn.entryId }) });

		writeSession(dir, [user("review"), assistant("first answer", "stop")]);
		vi.advanceTimersByTime(300);
		expect(seen).toEqual([{ text: "first answer", entryId: "e1" }]);

		// Same verdict again, a changed file: the entryId dedupe must stay quiet.
		const file = join(dir, "2026-01-01T00-00-00-000Z_child.jsonl");
		writeFileSync(file, `${readFileSync(file, "utf8")}${JSON.stringify({ type: "model_change", id: "m1", parentId: "e1", provider: "p", modelId: "m" })}\n`);
		vi.advanceTimersByTime(1000);
		expect(seen).toHaveLength(1);

		// A follow-up turn re-arms the watcher for its own closing answer.
		const next = [
			{ type: "message", id: "e2", parentId: "m1", message: { role: "user", content: [{ type: "text", text: "and again" }] } },
			{ type: "message", id: "e3", parentId: "e2", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "second answer" }] } },
		];
		writeFileSync(file, `${readFileSync(file, "utf8")}${next.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		vi.advanceTimersByTime(300);
		expect(seen).toEqual([
			{ text: "first answer", entryId: "e1" },
			{ text: "second answer", entryId: "e3" },
		]);

		stop();
		writeFileSync(file, `${readFileSync(file, "utf8")}${JSON.stringify({ type: "message", id: "e9", parentId: "e3", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "after stop" }] } })}\n`);
		vi.advanceTimersByTime(1000);
		expect(seen).toHaveLength(2);
	});

	it("does not announce an answer a forked child inherited from its parent", async () => {
		const { watchPiSettlement } = await import("../pi-settlement-watcher.ts");
		const dir = join(root, "forked");
		// A fork copies the parent's transcript before the watcher starts.
		writeSession(dir, [user("parent task"), assistant("parent answer", "stop")]);
		const onSettled = vi.fn();
		watchPiSettlement({ sessionDir: dir, intervalMs: 100, onSettled });

		vi.advanceTimersByTime(1000);
		expect(onSettled).not.toHaveBeenCalled();

		const file = join(dir, "2026-01-01T00-00-00-000Z_child.jsonl");
		writeFileSync(file, `${readFileSync(file, "utf8")}${JSON.stringify({ type: "message", id: "k1", parentId: "e1", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "child answer" }] } })}\n`);
		vi.advanceTimersByTime(300);
		expect(onSettled).toHaveBeenCalledTimes(1);
		expect(onSettled.mock.calls[0]?.[0]).toMatchObject({ text: "child answer", entryId: "k1" });
	});

	it("stays silent while the child is mid-turn", async () => {
		const { watchPiSettlement } = await import("../pi-settlement-watcher.ts");
		const dir = writeSession(join(root, "midturn"), [user("go"), assistant("thinking", "toolUse")]);
		const onSettled = vi.fn();
		watchPiSettlement({ sessionDir: dir, intervalMs: 100, onSettled });
		vi.advanceTimersByTime(2000);
		expect(onSettled).not.toHaveBeenCalled();
	});
});

describe("watcher lifetime", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps announcing after terminal monitoring stops, until the child dies", async () => {
		const { watchPiSettlement } = await import("../pi-settlement-watcher.ts");
		const dir = join(root, "outlives");
		const file = join(dir, "2026-01-01T00-00-00-000Z_child.jsonl");
		let alive = true;
		const seen: string[] = [];
		// Started at spawn time, before the child's first answer exists.
		const stop = watchPiSettlement({ sessionDir: dir, intervalMs: 100, isAlive: () => alive, onSettled: (turn) => seen.push(turn.text) });
		writeSession(dir, [user("first"), assistant("answer one", "stop")]);
		vi.advanceTimersByTime(200);
		expect(seen).toEqual(["answer one"]);

		// A backgrounded overlay stops terminal monitoring; the child is still alive.
		const appended = [
			{ type: "message", id: "e2", parentId: "e1", message: { role: "user", content: [{ type: "text", text: "ping" }] } },
			{ type: "message", id: "e3", parentId: "e2", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "answer two" }] } },
		];
		writeFileSync(file, `${readFileSync(file, "utf8")}${appended.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		vi.advanceTimersByTime(200);
		expect(seen).toEqual(["answer one", "answer two"]);

		alive = false;
		vi.advanceTimersByTime(200);
		// A turn written after the child died must not be announced: the watcher is gone.
		writeFileSync(file, `${readFileSync(file, "utf8")}${JSON.stringify({ type: "message", id: "e9", parentId: "e3", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "after death" }] } })}\n`);
		vi.advanceTimersByTime(1000);
		expect(seen).toEqual(["answer one", "answer two"]);
		stop();
	});

	it("stops watching once the child process is gone", async () => {
		const { watchPiSettlement } = await import("../pi-settlement-watcher.ts");
		const dir = writeSession(join(root, "dead"), [user("go"), assistant("done", "stop")]);
		const onSettled = vi.fn();
		watchPiSettlement({ sessionDir: dir, intervalMs: 100, isAlive: () => false, onSettled });
		vi.advanceTimersByTime(500);
		expect(onSettled).not.toHaveBeenCalled();
	});
});
