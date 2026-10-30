import { afterEach, describe, expect, it, vi } from "vitest";

// The extension graph is imported once here; Pi's modules are mocked before that
// import happens so no host runtime is required.
vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => "/tmp/pi-agent",
	getShellConfig: () => ({ shell: "/bin/bash", args: ["-c"] }),
	SettingsManager: { create: () => ({ getShellPath: () => undefined }) },
}));
vi.mock("@earendil-works/pi-tui", () => ({
	matchesKey: () => false,
	truncateToWidth: (value: string) => value,
	visibleWidth: (value: string) => value.length,
}));
vi.mock("../overlay-component.ts", () => ({
	InteractiveShellOverlay: class MockInteractiveShellOverlay {},
}));
vi.mock("../reattach-overlay.ts", () => ({
	ReattachOverlay: class MockReattachOverlay {},
}));

const { default: interactiveShellExtension } = await import("../index.ts");
const { sessionManager } = await import("../session-manager.ts");

function createFakePty(lines: string[] = ["ping-alive"]) {
	return {
		exited: false,
		exitCode: null as number | null,
		signal: undefined as number | undefined,
		setEventHandlers: vi.fn(),
		addExitListener: vi.fn(() => () => {}),
		write: vi.fn(),
		kill: vi.fn(),
		dispose: vi.fn(),
		getTailLines: vi.fn(() => ({ lines, totalLinesInBuffer: lines.length, truncatedByChars: false })),
		getRawStream: vi.fn(() => lines.join("\n")),
		getLogSlice: vi.fn(() => ({
			slice: lines.join("\n"),
			totalLines: lines.length,
			totalChars: lines.join("\n").length,
			sliceLineCount: lines.length,
		})),
	};
}

type FakePty = ReturnType<typeof createFakePty>;

const SESSION_ID = "ping-alive";

/** Only `action: "list"` knows this session; the active table never holds it. */
function setupHarness(pty: FakePty) {
	sessionManager.add("bash ping.sh", pty as any, SESSION_ID, "health check", { id: SESSION_ID, noAutoCleanup: true });

	let toolDef: { execute: (...args: any[]) => Promise<any> } | undefined;
	interactiveShellExtension({
		registerShortcut: vi.fn(),
		registerCommand: vi.fn(),
		registerTool: vi.fn((definition: { execute: (...args: any[]) => Promise<any> }) => {
			toolDef = definition;
		}),
		on: vi.fn(),
		events: { emit: vi.fn() },
		sendMessage: vi.fn(),
	} as any);
	if (!toolDef) throw new Error("interactive_shell was not registered");

	return {
		tool: toolDef,
		ctx: { hasUI: false, cwd: "/tmp/project", ui: {} } as any,
	};
}

async function run(tool: { execute: (...args: any[]) => Promise<any> }, ctx: any, params: Record<string, unknown>) {
	return tool.execute("tc", params, undefined, undefined, ctx);
}

describe("interactive_shell actions on a background-only session", () => {
	afterEach(() => {
		for (const entry of sessionManager.list()) sessionManager.remove(entry.id);
		vi.useRealTimers();
	});

	it("kills a session that only action:list reports, disposing its PTY once", async () => {
		const pty = createFakePty(["ping-alive still running"]);
		const { tool, ctx } = setupHarness(pty);
		expect(sessionManager.getActive(SESSION_ID)).toBeUndefined();
		expect(sessionManager.list().map((entry) => entry.id)).toEqual([SESSION_ID]);

		const result = await run(tool, ctx, { action: "kill", sessionId: SESSION_ID });

		expect(result.isError).not.toBe(true);
		expect(result.content[0].text).toContain(`Session ${SESSION_ID} killed`);
		expect(result.content[0].text).toContain("ping-alive still running");
		expect(pty.kill).toHaveBeenCalledTimes(1);
		expect(pty.dispose).toHaveBeenCalledTimes(1);
		expect(sessionManager.list()).toHaveLength(0);
	});

	it("disposes once when a session with a pending cleanup is killed", async () => {
		vi.useFakeTimers();
		const pty = createFakePty();
		const { tool, ctx } = setupHarness(pty);
		// An ended dispatch session keeps its entry until the delayed cleanup fires.
		sessionManager.scheduleCleanup(SESSION_ID, 5 * 60 * 1000);

		const result = await run(tool, ctx, { action: "kill", sessionId: SESSION_ID });

		expect(result.isError).not.toBe(true);
		expect(result.content[0].text).toContain("killed");
		expect(pty.dispose).toHaveBeenCalledTimes(1);
		expect(sessionManager.list()).toHaveLength(0);

		// The cancelled cleanup timer must not dispose the PTY a second time.
		vi.advanceTimersByTime(10 * 60 * 1000);
		expect(pty.dispose).toHaveBeenCalledTimes(1);
	});

	it("queries and writes to a background session without taking it out of the table", async () => {
		const pty = createFakePty(["scan: 42 files"]);
		const { tool, ctx } = setupHarness(pty);

		const query = await run(tool, ctx, { action: "query", sessionId: SESSION_ID });
		expect(query.isError).not.toBe(true);
		expect(query.content[0].text).toContain(`${SESSION_ID} running`);
		expect(query.content[0].text).toContain("scan: 42 files");
		expect(sessionManager.list()).toHaveLength(1);

		const send = await run(tool, ctx, { action: "send", sessionId: SESSION_ID, input: "/compact", submit: true });
		expect(send.isError).not.toBe(true);
		expect(pty.write).toHaveBeenCalledWith("/compact\r");
		expect(sessionManager.list()).toHaveLength(1);
		expect(pty.dispose).not.toHaveBeenCalled();
	});

	it("reports a background session as already backgrounded instead of erroring", async () => {
		const pty = createFakePty();
		const { tool, ctx } = setupHarness(pty);

		const result = await run(tool, ctx, { action: "background", sessionId: SESSION_ID });

		expect(result.isError).not.toBe(true);
		expect(result.content[0].text).toContain(`Session ${SESSION_ID} is already in the background (running)`);
		expect(sessionManager.list()).toHaveLength(1);
		expect(pty.kill).not.toHaveBeenCalled();
	});

	it("rejects configuration for a background session with the unsupported-settings error", async () => {
		const pty = createFakePty();
		const { tool, ctx } = setupHarness(pty);

		await expect(run(tool, ctx, { action: "configure", sessionId: SESSION_ID, settings: { quietThreshold: 8000 } }))
			.rejects.toThrow("Session does not support the requested configuration");
	});

	it("errors for an id that exists in neither table and points at action:list", async () => {
		const pty = createFakePty();
		const { tool, ctx } = setupHarness(pty);

		await expect(run(tool, ctx, { action: "kill", sessionId: "ghost" }))
			.rejects.toThrow(/Session not found: ghost[\s\S]*action: "list"/);
	});
});
