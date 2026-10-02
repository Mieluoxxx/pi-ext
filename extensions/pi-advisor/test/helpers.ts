// Adapted from rpiv-mono test-utils (MIT); see NOTICE.
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionToolContext, ExtensionUIContext, RegisteredCommand, SessionEntry, ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
export * from "./session.js";

export function createMockPi(overrides: Partial<ExtensionAPI> = {}) {
	const captured = {
		tools: new Map<string, ToolDefinition>(),
		commands: new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>(),
		events: new Map<string, Array<(...args: any[]) => unknown>>(),
		activeTools: [] as string[],
		allTools: [] as ToolInfo[],
	};
	const pi = {
		registerTool: vi.fn((tool: ToolDefinition) => {
			captured.tools.set(tool.name, tool);
			if (!captured.activeTools.includes(tool.name)) captured.activeTools.push(tool.name);
		}),
		registerCommand: vi.fn((name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => captured.commands.set(name, command)),
		on: vi.fn((name: string, handler: (...args: any[]) => unknown) => {
			const handlers = captured.events.get(name) ?? [];
			handlers.push(handler);
			captured.events.set(name, handlers);
		}),
		getActiveTools: vi.fn(() => [...captured.activeTools]),
		setActiveTools: vi.fn((tools: string[]) => { captured.activeTools = [...tools]; }),
		getAllTools: vi.fn(() => [...captured.allTools]),
		getThinkingLevel: vi.fn(() => "medium"),
		appendEntry: vi.fn(),
		...overrides,
	} as unknown as ExtensionAPI;
	return { pi, captured };
}

export function createMockCtx(options: {
	hasUI?: boolean;
	cwd?: string;
	model?: Model<Api>;
	models?: Model<Api>[];
	branch?: SessionEntry[];
	sessionId?: string;
	ui?: Partial<ExtensionUIContext>;
} = {}): ExtensionToolContext {
	const branch = options.branch ?? [];
	const models = options.models ?? [];
	return {
		hasUI: options.hasUI ?? false,
		cwd: options.cwd ?? "/tmp/advisor-test",
		model: options.model,
		ui: {
			notify: vi.fn(), confirm: vi.fn(async () => true), setStatus: vi.fn(),
			input: vi.fn(async () => ""), select: vi.fn(async () => undefined), ...options.ui,
		},
		sessionManager: {
			getBranch: vi.fn(() => branch), getEntries: vi.fn(() => branch),
			getLeafId: vi.fn(() => branch.at(-1)?.id ?? null),
			getSessionId: vi.fn(() => options.sessionId ?? "test-session"),
			getSessionFile: vi.fn(() => "/tmp/advisor-test.jsonl"),
		},
		modelRegistry: {
			find: vi.fn((provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id)),
			getAvailable: vi.fn(() => [...models]),
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "test-key", headers: {} })),
		},
		isIdle: vi.fn(() => true),
		tools: [],
		executeTool: vi.fn(),
	} as unknown as ExtensionToolContext;
}
