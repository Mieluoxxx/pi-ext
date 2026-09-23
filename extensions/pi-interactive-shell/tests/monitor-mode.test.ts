import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "@earendil-works/pi-agent-core";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

type MonitorOptionsCapture = {
	monitor?: {
		strategy: "stream" | "poll-diff" | "file-watch";
		triggers: Array<{ id: string; match: (input: string) => string | undefined; cooldownMs?: number }>;
		pollIntervalMs: number;
		dedupeExactLine: boolean;
		cooldownMs?: number;
	};
	onMonitorEvent?: (event: unknown) => void | Promise<void>;
} | null;

async function setupHarness(failMonitor = false) {
	let toolDef: any;
	let monitorOptions: MonitorOptionsCapture = null;
	let launchedCommand: string | undefined;
	let monitorCompleteCallback: ((info: unknown) => void) | undefined;
	const sendMessage = vi.fn();
	const disposePty = vi.fn();
	const handlers = new Map<string, (...args: any[]) => any>();
	const execFileSync = vi.fn(() => { throw new Error("git must not run for invalid requests"); });

	vi.resetModules();
	vi.doMock("node:child_process", () => ({ execFileSync, spawn: vi.fn() }));
	vi.doMock("@earendil-works/pi-coding-agent", () => ({
		getAgentDir: () => "/tmp/pi-agent",
	}));
	vi.doMock("@earendil-works/pi-tui", () => ({
		isKeyRelease: () => false,
		isKeyRepeat: () => false,
		matchesKey: () => false,
		truncateToWidth: (value: string) => value,
		visibleWidth: (value: string) => value.length,
	}));
	vi.doMock("../config.ts", async () => {
		const actual = await vi.importActual<typeof import("../config.ts")>("../config.ts");
		return {
			...actual,
			loadConfig: vi.fn(() => ({
				exitAutoCloseDelay: 10,
				overlayWidthPercent: 95,
				overlayHeightPercent: 60,
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
			})),
		};
	});
	vi.doMock("../overlay-component.ts", () => ({
		InteractiveShellOverlay: class MockInteractiveShellOverlay {},
	}));
	vi.doMock("../reattach-overlay.ts", () => ({
		ReattachOverlay: class MockReattachOverlay {},
	}));
	vi.doMock("../pty-session.ts", () => ({
		PtyTerminalSession: class MockPtyTerminalSession {
			exited = false;
			exitCode: number | null = null;
			signal: number | undefined;
			constructor(options: { command: string }) {
				launchedCommand = options.command;
			}
			addDataListener(_cb: (data: string) => void) { return () => {}; }
			addExitListener(_cb: (exitCode: number | null, signal?: number) => void) { return () => {}; }
			getTailLines() { return { lines: [], totalLinesInBuffer: 0, truncatedByChars: false }; }
			write() {}
			kill() {}
			setEventHandlers() {}
			dispose() { disposePty(); }
			getRawStream() { return ""; }
		},
	}));
	vi.doMock("../headless-monitor.ts", () => ({
		HeadlessDispatchMonitor: class MockHeadlessDispatchMonitor {
			disposed = false;
			constructor(
				_session: unknown,
				_config: unknown,
				options: MonitorOptionsCapture,
				onComplete: (info: unknown) => void,
			) {
				monitorOptions = options;
				if (failMonitor) throw new Error("monitor initialization failed");
				monitorCompleteCallback = onComplete;
			}
			getResult() { return undefined; }
			registerCompleteCallback() {}
			dispose() { this.disposed = true; }
		},
	}));
	vi.doMock("../session-manager.ts", () => ({
		sessionManager: {
			getActive: vi.fn(() => undefined),
			unregisterActive: vi.fn(),
			registerActive: vi.fn(),
			list: vi.fn(() => []),
			add: vi.fn(() => "monitor-1"),
			take: vi.fn(() => undefined),
			get: vi.fn(() => undefined),
			restore: vi.fn(),
			remove: vi.fn(),
			scheduleCleanup: vi.fn(),
			restartAutoCleanup: vi.fn(),
			killAll: vi.fn(),
			onChange: vi.fn(() => () => {}),
			setActiveUpdateInterval: vi.fn(() => false),
			setActiveQuietThreshold: vi.fn(() => false),
			writeToActive: vi.fn(() => false),
		},
		generateSessionId: vi.fn(() => "monitor-1"),
	}));

	const extensionModule = await import("../index.ts");
	extensionModule.default({
		registerShortcut: vi.fn(),
		registerCommand: vi.fn(),
		registerTool: vi.fn((definition: any) => {
			toolDef = definition;
		}),
		on: vi.fn((name, handler) => handlers.set(name, handler)),
		events: { emit: vi.fn() },
		sendMessage,
	} as any);

	return {
		toolDef,
		disposePty,
		handlers,
		execFileSync,
		getMonitorOptions: () => monitorOptions,
		getLaunchedCommand: () => launchedCommand,
		getMonitorCompleteCallback: () => monitorCompleteCallback,
		sendMessage,
	};
}

describe("monitor mode", () => {
	it.each([
		{ triggers: [{ id: "price", kind: "numeric", pattern: "price", threshold: { captureGroup: 1, op: "gte", value: 0 } }] },
		{ triggers: [{ id: "ready", kind: "literal", pattern: "READY" }], detector: { detectorCommand: "   " } },
	])("rejects impossible numeric captures and blank detector commands before launch: %j", async (monitor) => {
		const harness = await setupHarness();
		await expect(harness.toolDef.execute("invalid-monitor", { action: "start", command: "echo READY", mode: "monitor", monitor }, undefined, undefined, { hasUI: false, cwd: "/tmp/project", ui: {} })).rejects.toThrow();
		expect(harness.getLaunchedCommand()).toBeUndefined();
	});

	it.each(["monitor", "dispatch"])("cleans up the launched PTY when %s initialization fails", async (mode) => {
		const harness = await setupHarness(true);
		const ctx = { hasUI: false, cwd: "/tmp/project", ui: {} };
		await expect(harness.toolDef.execute("failed-start", {
			action: "start", command: "echo READY", mode, background: true,
			...(mode === "monitor" ? { monitor: { triggers: [{ id: "ready", kind: "literal", pattern: "READY" }] } } : {}),
		}, undefined, undefined, ctx)).rejects.toThrow("monitor initialization failed");
		expect(harness.disposePty).toHaveBeenCalledOnce();
		const state = await harness.toolDef.execute("status", { action: "monitor_status", sessionId: "monitor-1" }, undefined, undefined, ctx);
		expect(state.details.state).toBeNull();
	});

	it("records runtime validation failures as real Pi tool errors", async () => {
		const harness = await setupHarness();
		const faux = createFauxCore({});
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("interactive_shell", {
				action: "start", command: "echo READY", mode: "monitor",
				monitor: { triggers: [{ id: "ready", kind: "regex", pattern: "[fixture-secret" }] },
			}), { stopReason: "toolUse" }),
			fauxAssistantMessage("observed"),
		]);
		const ctx = { hasUI: false, cwd: "/tmp/project", ui: {} };
		const agent = new Agent({
			streamFn: faux.streamSimple,
			initialState: { model: faux.getModel(), tools: [{ ...harness.toolDef, execute: (...args: any[]) => harness.toolDef.execute(...args, ctx) }] },
		});
		await agent.prompt("fixture");
		const result = agent.state.messages.find(message => message.role === "toolResult");
		expect(result?.isError).toBe(true);
		expect(JSON.stringify(result?.content)).toContain("Invalid regular expression");
		expect(JSON.stringify(result?.content)).not.toContain("fixture-secret");
		expect(harness.getLaunchedCommand()).toBeUndefined();
	});

	it("sets explicit non-strict sampling only on its own Responses tool declarations", async () => {
		const harness = await setupHarness();
		const hook = harness.handlers.get("before_provider_request");
		expect(hook).toBeDefined();
		const own = { type: "function", name: "interactive_shell", parameters: {} };
		const other = { type: "function", name: "other", parameters: {} };
		const payload = { tools: [own, other], input: [{ type: "additional_tools", tools: [{ ...own, strict: null }] }] };
		const result = hook!({ payload }, { model: { api: "openai-responses" } });
		expect(result.tools[0].strict).toBe(false);
		expect(result.input[0].tools[0].strict).toBe(false);
		expect(result.tools[1]).toBe(other);
		expect(own).not.toHaveProperty("strict");
		expect(hook!({ payload }, { model: { api: "anthropic-messages" } })).toBeUndefined();
		const strict = { tools: [{ ...own, strict: true }] };
		expect(hook!({ payload: strict }, { model: { api: "openai-responses" } })).toBeUndefined();
	});

	it("starts a canonical single-pattern literal monitor", async () => {
		const harness = await setupHarness();
		const result = await harness.toolDef.execute("canonical", {
			action: "start", command: "echo READY", mode: "monitor",
			monitor: { triggers: [{ id: "ready", kind: "literal", pattern: "READY" }] },
		}, undefined, undefined, { hasUI: false, cwd: "/tmp/project", ui: {} });
		expect(result.details.mode).toBe("monitor");
		expect(harness.getMonitorOptions()?.monitor?.triggers[0]?.match("READY")).toBe("READY");
	});

	it("validates monitor semantics before even invoking git for a spawn worktree", async () => {
		const harness = await setupHarness();
		await expect(harness.toolDef.execute("invalid-worktree", {
			action: "start", spawn: { worktree: true }, mode: "monitor",
			monitor: { strategy: "stream", poll: { intervalMs: 5000 }, triggers: [{ id: "ready", kind: "literal", pattern: "READY" }] },
		}, undefined, undefined, { hasUI: false, cwd: "/tmp/project", ui: {} })).rejects.toThrow("monitor.poll");
		expect(harness.execFileSync).not.toHaveBeenCalled();
		expect(harness.getLaunchedCommand()).toBeUndefined();
	});

	it("throws at the tool boundary when monitor validation fails", async () => {
		const { toolDef } = await setupHarness();
		await expect(toolDef.execute("invalid", { command: "echo READY", mode: "monitor" }, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		})).rejects.toThrow("requires monitor configuration");
	});

	afterEach(() => {
		vi.doUnmock("node:child_process");
		vi.doUnmock("@earendil-works/pi-coding-agent");
		vi.doUnmock("@earendil-works/pi-tui");
		vi.doUnmock("../config.ts");
		vi.doUnmock("../overlay-component.ts");
		vi.doUnmock("../reattach-overlay.ts");
		vi.doUnmock("../pty-session.ts");
		vi.doUnmock("../headless-monitor.ts");
		vi.doUnmock("../session-manager.ts");
	});

	it("requires monitor object when mode is monitor", async () => {
		const { toolDef } = await setupHarness();
		await expect(toolDef.execute("call-1", {
			command: "npm test",
			mode: "monitor",
		}, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any)).rejects.toThrow("requires monitor configuration");
	});

	it("wires compiled monitor config and callback for monitor mode", async () => {
		const harness = await setupHarness();
		const result = await harness.toolDef.execute("call-1", {
			command: "npm test --watch",
			mode: "monitor",
			monitor: {
				strategy: "stream",
				triggers: [{ id: "error", regex: "/ERROR/i" }],
			},
		}, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any);

		expect(result.isError).not.toBe(true);
		expect(result.details.mode).toBe("monitor");
		expect(result.details.monitor.strategy).toBe("stream");
		expect(harness.getMonitorOptions()?.monitor?.strategy).toBe("stream");
		expect(harness.getMonitorOptions()?.monitor?.triggers[0]?.id).toBe("error");
		expect(typeof harness.getMonitorOptions()?.onMonitorEvent).toBe("function");
	});

	it.each([
		{ name: "both matchers", trigger: { id: "ready", literal: "fixture-secret-literal", regex: "/fixture-secret-regex/" }, received: "Received both literal and regex string fields." },
		{ name: "two empty placeholders", trigger: { id: "ready", literal: "", regex: "" }, received: "Received both literal and regex string fields." },
		{ name: "missing matcher", trigger: { id: "ready" }, received: "Received neither literal nor regex as a string." },
	])("rejects ambiguous legacy $name without launching or echoing matcher values", async ({ trigger }) => {
		const harness = await setupHarness();
		const ctx = {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any;
		const result = harness.toolDef.execute("invalid", {
			command: "echo READY",
			mode: "monitor",
			monitor: { strategy: "stream", triggers: [trigger] },
		}, undefined, undefined, ctx);

		await expect(result).rejects.toThrow("unambiguous matcher");
		await expect(result).rejects.not.toThrow("fixture-secret");
		expect(harness.getLaunchedCommand()).toBeUndefined();
		expect(harness.getMonitorOptions()).toBeNull();

		// Both canonical repairs must remain executable.
		for (const kind of ["literal", "regex"]) {
			const example = { id: "ready", kind, pattern: "READY" };
			const repaired = await harness.toolDef.execute(`repaired-${kind}`, {
				command: "echo READY",
				mode: "monitor",
				monitor: { strategy: "stream", triggers: [example] },
			}, undefined, undefined, ctx);
			expect(repaired.isError).not.toBe(true);
			expect(harness.getMonitorOptions()?.monitor?.triggers[0]?.match("READY")).toBe("READY");
		}
	});
	it.each([{ id: "ready", literal: "READY", regex: "" }, { id: "ready", literal: "", regex: "/READY/" }])("migrates a legacy matcher with one empty counterpart: %j", async (trigger) => {
		const harness = await setupHarness();
		await harness.toolDef.execute("legacy", { command: "echo READY", mode: "monitor", monitor: { triggers: [trigger] } }, undefined, undefined, { hasUI: false, cwd: "/tmp/project", ui: {} });
		expect(harness.getMonitorOptions()?.monitor?.triggers[0]?.match("READY")).toBe("READY");
	});

	it("rejects legacy monitorFilter usage after hard cutover", async () => {
		const { toolDef } = await setupHarness();
		await expect(toolDef.execute("call-1", {
			command: "tail -f logs/dev.log",
			mode: "monitor",
			monitorFilter: "/tmp/log",
		}, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any)).rejects.toThrow("monitorFilter was removed");
	});

	it("requires target session when querying monitorEvents", async () => {
		const { toolDef } = await setupHarness();
		await expect(toolDef.execute("call-1", {
			monitorEvents: true,
		}, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any)).rejects.toThrow("monitor_events requires sessionId");
	});

	it("wraps poll-diff monitor command into a recurring loop", async () => {
		const harness = await setupHarness();
		const result = await harness.toolDef.execute("call-1", {
			command: "echo health",
			mode: "monitor",
			monitor: {
				strategy: "poll-diff",
				triggers: [{ id: "changed", regex: "/./" }],
				poll: { intervalMs: 5000 },
			},
		}, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any);

		expect(result.isError).not.toBe(true);
		expect(harness.getLaunchedCommand()).toContain("while true; do");
		expect(harness.getLaunchedCommand()).toContain("echo health");
	});

	it("supports regex capture thresholds in triggers", async () => {
		const harness = await setupHarness();
		const result = await harness.toolDef.execute("call-1", {
			command: "echo prices",
			mode: "monitor",
			monitor: {
				strategy: "stream",
				triggers: [{
					id: "nvda-below",
					regex: "/NVDA:\\s*\\$?(\\d+(?:\\.\\d+)?)/",
					threshold: { captureGroup: 1, op: "lt", value: 120 },
				}],
			},
		}, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any);

		expect(result.isError).not.toBe(true);
		const match = harness.getMonitorOptions()?.monitor?.triggers[0]?.match;
		expect(match?.("NVDA: $119.50")).toBe("NVDA: $119.50");
		expect(match?.("NVDA: $120.50")).toBeUndefined();
	});

	it("rejects threshold config on literal triggers", async () => {
		const { toolDef } = await setupHarness();
		await expect(toolDef.execute("call-1", {
			command: "echo test",
			mode: "monitor",
			monitor: {
				strategy: "stream",
				triggers: [{
					id: "bad-threshold",
					literal: "NVDA",
					threshold: { captureGroup: 1, op: "lt", value: 120 },
				}],
			},
		}, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any)).rejects.toThrow("threshold is only allowed for kind=numeric");
	});

	it("explains that captureGroup zero is not a numeric capture and starts no monitor", async () => {
		const harness = await setupHarness();
		await expect(harness.toolDef.execute("invalid-threshold", {
			command: "echo READY",
			mode: "monitor",
			monitor: {
				triggers: [{ id: "ready", regex: "/READY/", threshold: { captureGroup: 0, op: "gte", value: 0 } }],
			},
		}, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any)).rejects.toThrow("captureGroup");
		expect(harness.getLaunchedCommand()).toBeUndefined();
	});

	it("requires fileWatch config for file-watch strategy", async () => {
		const { toolDef } = await setupHarness();
		await expect(toolDef.execute("call-1", {
			mode: "monitor",
			monitor: {
				strategy: "file-watch",
				triggers: [{ id: "pdf", regex: "/\\.pdf$/i" }],
			},
		}, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any)).rejects.toThrow("monitor.fileWatch is required");
	});

	it("builds generated command for file-watch strategy beside an empty spawn placeholder", async () => {
		const harness = await setupHarness();
		const result = await harness.toolDef.execute("call-1", {
			mode: "monitor",
			spawn: {},
			monitor: {
				strategy: "file-watch",
				fileWatch: { path: "./uploads", recursive: true, events: ["rename"] },
				triggers: [{ id: "pdf", regex: "/\\.pdf$/i" }],
			},
		}, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any);

		expect(result.isError).not.toBe(true);
		expect(harness.getMonitorOptions()?.monitor?.strategy).toBe("file-watch");
		expect(harness.getLaunchedCommand()).toContain("-e");
		expect(harness.getLaunchedCommand()).toContain("uploads");
	});

	it("returns monitor status summaries", async () => {
		const harness = await setupHarness();
		const started = await harness.toolDef.execute("call-1", {
			command: "npm test --watch",
			mode: "monitor",
			monitor: {
				strategy: "stream",
				triggers: [{ id: "fail", literal: "FAIL" }],
			},
		}, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any);

		expect(started.isError).not.toBe(true);
		const status = await harness.toolDef.execute("call-2", {
			monitorStatus: true,
			monitorSessionId: "monitor-1",
		}, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any);

		expect(status.isError).not.toBe(true);
		expect(status.content[0].text).toContain("Monitor state for monitor-1");
		expect(status.content[0].text).toContain("Status: running");
	});

	it("supports monitorEvents filtering by trigger and sinceEventId", async () => {
		const harness = await setupHarness();
		await harness.toolDef.execute("call-1", {
			command: "npm test --watch",
			mode: "monitor",
			monitor: {
				strategy: "stream",
				triggers: [
					{ id: "fail", literal: "FAIL" },
					{ id: "warn", literal: "WARN" },
				],
			},
		}, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any);

		harness.getMonitorOptions()?.onMonitorEvent?.({
			strategy: "stream",
			triggerId: "fail",
			eventType: "fail",
			matchedText: "FAIL",
			lineOrDiff: "FAIL first",
			stream: "pty",
		});
		harness.getMonitorOptions()?.onMonitorEvent?.({
			strategy: "stream",
			triggerId: "warn",
			eventType: "warn",
			matchedText: "WARN",
			lineOrDiff: "WARN second",
			stream: "pty",
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		const filtered = await harness.toolDef.execute("call-2", {
			monitorEvents: true,
			monitorSessionId: "monitor-1",
			monitorTriggerId: "warn",
			monitorSinceEventId: 1,
		}, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any);

		expect(filtered.isError).not.toBe(true);
		expect(filtered.details.events).toHaveLength(1);
		expect(filtered.details.events[0]?.triggerId).toBe("warn");
		expect(filtered.details.sinceEventId).toBe(1);
		expect(filtered.details.triggerId).toBe("warn");
	});

	it("emits monitor lifecycle notification when monitor session completes", async () => {
		const harness = await setupHarness();
		await harness.toolDef.execute("call-1", {
			command: "npm test --watch",
			mode: "monitor",
			monitor: {
				strategy: "stream",
				triggers: [{ id: "fail", literal: "FAIL" }],
			},
		}, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any);

		harness.getMonitorCompleteCallback()?.({ exitCode: 1 });
		expect(harness.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "interactive-shell-monitor-lifecycle" }),
			expect.any(Object),
		);
	});
});
