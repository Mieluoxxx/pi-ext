import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("real monitor lifecycle", () => {
	let root: string;
	let tool: any;
	let shutdown: (() => void) | undefined;
	let messages: any[];
	const command = (script: string) => `${JSON.stringify(process.execPath)} -e '${script.replaceAll("'", "'\\''")}'`;
	const call = (params: unknown) => tool.execute("fixture", params, undefined, undefined, { cwd: root, hasUI: false, ui: {} });

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "pi-monitor-contract-"));
		messages = [];
		vi.resetModules();
		vi.doMock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => root }));
		const { default: extension } = await import("../index.ts");
		extension({
			registerTool(definition: any) { if (definition.name === "interactive_shell") tool = definition; },
			registerCommand() {}, registerShortcut() {},
			on(name: string, handler: () => void) { if (name === "session_shutdown") shutdown = handler; },
			events: { emit() {} }, sendMessage(message: unknown) { messages.push(message); },
		} as any);
	});

	afterEach(() => {
		shutdown?.();
		vi.doUnmock("@earendil-works/pi-coding-agent");
		rmSync(root, { recursive: true, force: true });
	});

	it.each(["stream", "poll-diff", "file-watch"])("starts, emits, queries and stops a real %s monitor", async (strategy) => {
		const started = await call({
			action: "start", mode: "monitor", timeout: 10000,
			...(strategy === "file-watch" ? {} : { command: command(strategy === "stream" ? 'setInterval(()=>console.log("READY"),40)' : "console.log(Date.now())") }),
			monitor: {
				strategy,
				triggers: [{ id: "ready", kind: "regex", pattern: strategy === "stream" ? "READY" : strategy === "file-watch" ? "ready.txt" : "[0-9]+" }],
				...(strategy === "file-watch" ? { fileWatch: { path: root } } : strategy === "poll-diff" ? { poll: { intervalMs: 250 } } : {}),
			},
		});
		const sessionId = started.details.sessionId;
		const writer = strategy === "file-watch" ? setInterval(() => writeFileSync(join(root, "ready.txt"), String(Date.now())), 40) : undefined;
		try {
			await vi.waitFor(() => expect(messages.some(message => message.customType === "interactive-shell-monitor-event")).toBe(true), { timeout: 5000, interval: 20 });
			const events = await call({ action: "monitor_events", sessionId });
			expect(events.details.events[0].triggerId).toBe("ready");
			await call({ action: "kill", sessionId });
			await vi.waitFor(async () => expect((await call({ action: "monitor_status", sessionId })).details.state.status).toBe("stopped"), { timeout: 5000, interval: 20 });
			await call({ action: "dismiss", sessionId });
			expect((await call({ action: "list" })).content[0].text).toBe("No background sessions.");
		} finally {
			if (writer) clearInterval(writer);
		}
	});

	it("reports a started process exiting unsuccessfully as a lifecycle failure", async () => {
		const started = await call({ action: "start", command: command("process.exit(7)"), mode: "monitor", monitor: { triggers: [{ id: "unused", kind: "literal", pattern: "READY" }] } });
		await vi.waitFor(() => expect(messages.some(message => message.customType === "interactive-shell-monitor-lifecycle")).toBe(true), { timeout: 5000 });
		const status = await call({ action: "monitor_status", sessionId: started.details.sessionId });
		expect(status.details.state).toMatchObject({ terminalReason: "script-failed", exitCode: 7 });
		await call({ action: "dismiss", sessionId: started.details.sessionId });
	});
});
