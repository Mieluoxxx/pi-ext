import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	initTheme,
	type ExtensionAPI,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { disposeAll, resetDisposed } from "../src/disposable.ts";
import { registerToolDisplayOverrides } from "../src/tool-overrides.ts";
import type { PatchableToolExecutionPrototype } from "../src/mcp-tool-execution-patch.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../src/types.ts";

const TOOL_DISPLAY_PENDING_DECORATIONS_KEY = Symbol.for("pi-tool-display.pendingDecorations.v1");

interface RegisteredToolLike {
	name: string;
	description: string;
	parameters: unknown;
	renderShell?: "default" | "self";
	promptSnippet?: string;
	promptGuidelines?: string[];
	renderCall?: (...args: unknown[]) => unknown;
	renderResult?: (...args: unknown[]) => unknown;
}

interface ToolEventHandlers {
	session_start?: () => Promise<void> | void;
	before_agent_start?: () => Promise<void> | void;
}

interface ExecutableToolLike extends RegisteredToolLike {
	execute: (...args: unknown[]) => Promise<{ content?: Array<{ type: string; text?: string }> }>;
}

async function withTempDir(name: string, run: (dir: string) => Promise<void> | void): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), name));
	try {
		await run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function getTextOutput(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (result.content ?? [])
		.filter((entry) => entry.type === "text")
		.map((entry) => entry.text ?? "")
		.join("");
}

function withDefaultReadEditOwners(tools: unknown[] = []): unknown[] {
	const names = new Set(
		tools
			.map((tool) => (tool as { name?: unknown }).name)
			.filter((name): name is string => typeof name === "string"),
	);
	const defaults = ["read", "edit"]
		.filter((name) => !names.has(name))
		.map((name) => ({ name, sourceInfo: { source: "builtin", path: `<builtin:${name}>` } }));
	return [...defaults, ...tools];
}

function createExtensionApiStub(allTools: unknown[] = []): {
	api: ExtensionAPI;
	registeredTools: RegisteredToolLike[];
	eventHandlers: ToolEventHandlers;
} {
	const registeredTools: RegisteredToolLike[] = [];
	const eventHandlers: ToolEventHandlers = {};
	const api = {
		registerTool(tool: RegisteredToolLike): void {
			registeredTools.push(tool);
		},
		on(event: keyof ToolEventHandlers, handler: () => Promise<void> | void): void {
			eventHandlers[event] = handler;
		},
		getAllTools(): unknown[] {
			return withDefaultReadEditOwners(allTools);
		},
	} as unknown as ExtensionAPI;

	return { api, registeredTools, eventHandlers };
}

test("registerToolDisplayOverrides copies built-in prompt metadata onto overridden tools", async () => {
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();

	registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
	assert.deepEqual(
		registeredTools.map((tool) => tool.name).sort(),
		["bash", "edit", "find", "grep", "ls", "read", "write"],
	);
	await eventHandlers.before_agent_start?.();

	assert.equal(registeredTools.length, 7);

	const byName = new Map(registeredTools.map((tool) => [tool.name, tool]));
	const cwd = process.cwd();
	const builtInTools = {
		read: createReadTool(cwd),
		grep: createGrepTool(cwd),
		find: createFindTool(cwd),
		ls: createLsTool(cwd),
		bash: createBashTool(cwd),
		edit: createEditTool(cwd),
		write: createWriteTool(cwd),
	};

	for (const [name, builtInTool] of Object.entries(builtInTools)) {
		const registeredTool = byName.get(name);
		const builtInMetadata = builtInTool as unknown as RegisteredToolLike;
		assert.ok(registeredTool, `expected '${name}' to be registered`);
		assert.equal(registeredTool.promptSnippet, builtInMetadata.promptSnippet);
		assert.deepEqual(registeredTool.promptGuidelines, builtInMetadata.promptGuidelines);
	}
});

test("registerToolDisplayOverrides registers built-in display renderers during extension load for pre-bind history rendering", () => {
	const { api, registeredTools } = createExtensionApiStub();

	registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);

	const byName = new Map(registeredTools.map((tool) => [tool.name, tool]));
	for (const name of ["read", "grep", "find", "ls", "bash", "edit", "write"] as const) {
		const registeredTool = byName.get(name);
		assert.ok(registeredTool, `expected '${name}' to be available before session_start`);
		assert.equal(typeof registeredTool.renderCall, "function", `${name} has renderCall before session_start`);
		assert.equal(typeof registeredTool.renderResult, "function", `${name} has renderResult before session_start`);
	}
});

test("registerToolDisplayOverrides clones built-in parameter schemas so Pi TUI keeps extension renderers active", async () => {
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();

	registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
	await eventHandlers.before_agent_start?.();

	const byName = new Map(registeredTools.map((tool) => [tool.name, tool]));
	const cwd = process.cwd();
	const builtInTools = {
		read: createReadTool(cwd),
		grep: createGrepTool(cwd),
		find: createFindTool(cwd),
		ls: createLsTool(cwd),
		bash: createBashTool(cwd),
		edit: createEditTool(cwd),
		write: createWriteTool(cwd),
	};

	for (const [name, builtInTool] of Object.entries(builtInTools)) {
		const registeredTool = byName.get(name);
		assert.ok(registeredTool, `expected '${name}' to be registered`);
		assert.notEqual(
			registeredTool.parameters,
			builtInTool.parameters,
			`expected '${name}' to use a cloned parameter object`,
		);
		assert.deepEqual(registeredTool.parameters, builtInTool.parameters);
	}
});

test("registerToolDisplayOverrides forces edit into the default render shell so tool backgrounds fill the full row", async () => {
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();

	registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
	await eventHandlers.before_agent_start?.();

	const byName = new Map(registeredTools.map((tool) => [tool.name, tool]));
	assert.equal(byName.get("edit")?.renderShell, "default");
});

test("registerToolDisplayOverrides leaves externally owned read/edit/grep tools active", async () => {
	const { api, registeredTools, eventHandlers } = createExtensionApiStub([
		{ name: "read", sourceInfo: { source: "local", path: "agent/extensions/example-read/src/read.ts" } },
		{ name: "edit", sourceInfo: { source: "local", path: "agent/extensions/example-edit/src/edit.ts" } },
		{ name: "grep", sourceInfo: { source: "local", path: "agent/extensions/example-grep/src/grep.ts" } },
	]);

	registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
	await eventHandlers.before_agent_start?.();

	const registeredNames = new Set(registeredTools.map((tool) => tool.name));
	assert.equal(registeredNames.has("read"), false);
	assert.equal(registeredNames.has("edit"), false);
	assert.equal(registeredNames.has("grep"), false);
	assert.equal(registeredNames.has("find"), true);
	assert.equal(registeredNames.has("ls"), true);
	assert.equal(registeredNames.has("bash"), true);
	assert.equal(registeredNames.has("write"), true);
});

test("bash override uses shellPath from Pi settings", async () => {
	await withTempDir("pi-tool-display-shellpath-", async (dir) => {
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({ shellPath: "/definitely/missing/bash" }),
			"utf8",
		);

		try {
			const { api, registeredTools, eventHandlers } = createExtensionApiStub();
			registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
			await eventHandlers.before_agent_start?.();

			const bashTool = registeredTools.find((tool) => tool.name === "bash") as ExecutableToolLike | undefined;
			assert.ok(bashTool, "expected bash override to be registered");
			await assert.rejects(
				bashTool.execute("tool-call-1", { command: "printf test" }, undefined, undefined, { cwd: process.cwd() }),
				/custom shell path not found/i,
			);
			assert.equal(bashTool.description.length > 0, true);
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			}
		}
	});
});

test("bash override uses shellCommandPrefix from Pi settings", async () => {
	await withTempDir("pi-tool-display-shellprefix-", async (dir) => {
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({ shellCommandPrefix: "printf 'prefix-output\\n'" }),
			"utf8",
		);

		try {
			const { api, registeredTools, eventHandlers } = createExtensionApiStub();
			registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
			await eventHandlers.before_agent_start?.();

			const bashTool = registeredTools.find((tool) => tool.name === "bash") as ExecutableToolLike | undefined;
			assert.ok(bashTool, "expected bash override to be registered");
			const result = await bashTool.execute(
				"tool-call-2",
				{ command: "printf 'command-output\\n'" },
				undefined,
				undefined,
				{ cwd: process.cwd() },
			);
			assert.equal(getTextOutput(result).trim(), "prefix-output\ncommand-output");
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			}
		}
	});
});

test("registerToolDisplayOverrides drains pending display decorations from early-loading extensions", () => {
	type GlobalWithPendingDecorations = typeof globalThis & {
		[TOOL_DISPLAY_PENDING_DECORATIONS_KEY]?: Array<{
			tool: Record<string, unknown>;
			adapter?: Record<string, unknown>;
		}>;
	};
	const globalWithPending = globalThis as GlobalWithPendingDecorations;
	const previousPending = globalWithPending[TOOL_DISPLAY_PENDING_DECORATIONS_KEY];
	const queuedTool: Record<string, unknown> = {
		name: "mcp",
		label: "MCP Proxy",
		description: "Unified MCP gateway.",
		parameters: {},
		execute(): void {
			// No-op test stub.
		},
	};
	globalWithPending[TOOL_DISPLAY_PENDING_DECORATIONS_KEY] = [
		{
			adapter: { kind: "mcp" },
			tool: queuedTool,
		},
	];

	try {
		const { api, registeredTools } = createExtensionApiStub();

		registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);

		assert.equal(registeredTools.some((tool) => tool.name === "mcp"), false);
		assert.equal(typeof queuedTool.renderCall, "function", "expected queued MCP tool to receive renderCall");
		assert.equal(typeof queuedTool.renderResult, "function", "expected queued MCP tool to receive renderResult");
		assert.equal(queuedTool.renderShell, "default", "expected queued MCP tool to use the default shell");
		assert.equal(globalWithPending[TOOL_DISPLAY_PENDING_DECORATIONS_KEY]?.length, 0);
	} finally {
		if (previousPending) {
			globalWithPending[TOOL_DISPLAY_PENDING_DECORATIONS_KEY] = previousPending;
		} else {
			delete globalWithPending[TOOL_DISPLAY_PENDING_DECORATIONS_KEY];
		}
	}
});

test("native MCP decoration covers replacement definitions and restores Pi methods on disposal", () => {
	disposeAll();
	resetDisposed();
	const prototype = ToolExecutionComponent.prototype as unknown as PatchableToolExecutionPrototype;
	const originalGetRenderShell = prototype.getRenderShell;
	const originalGetCallRenderer = prototype.getCallRenderer;
	const originalGetResultRenderer = prototype.getResultRenderer;
	const config = {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		customToolOverrides: {
			custom_mcp: { enabled: true, kind: "mcp" as const, outputMode: "preview" as const },
		},
	};
	const { api } = createExtensionApiStub();

	try {
		registerToolDisplayOverrides(api, () => config);
		const adapterCall = (): string => "adapter call";
		const adapterResult = (): string => "adapter result";
		const directDefinition = {
			name: "server_direct_tool",
			label: "MCP: direct_tool",
			description: "Direct wrapper.",
			renderShell: "self",
			renderCall: adapterCall,
			renderResult: adapterResult,
		};
		const replacementDefinition = {
			...directDefinition,
			renderCall: (): string => "replacement call",
		};
		const customDefinition = {
			name: "custom_mcp",
			label: "Custom gateway",
			description: "No MCP metadata.",
			renderShell: "self",
			renderCall: adapterCall,
			renderResult: adapterResult,
		};

		for (const [toolName, toolDefinition] of [
			["server_direct_tool", directDefinition],
			["server_direct_tool", replacementDefinition],
			["custom_mcp", customDefinition],
		] as const) {
			const instance = { toolName, toolDefinition };
			assert.equal(prototype.getRenderShell.call(instance), "default");
			assert.notEqual(prototype.getCallRenderer.call(instance), toolDefinition.renderCall);
			assert.notEqual(prototype.getResultRenderer.call(instance), toolDefinition.renderResult);
			assert.equal(toolDefinition.renderShell, "self", "adapter definition must remain untouched");
		}

		disposeAll();
		assert.equal(prototype.getRenderShell, originalGetRenderShell);
		assert.equal(prototype.getCallRenderer, originalGetCallRenderer);
		assert.equal(prototype.getResultRenderer, originalGetResultRenderer);
	} finally {
		disposeAll();
		resetDisposed();
	}
});

test("native MCP decoration renders proxy calls inside Pi's default result box", () => {
	disposeAll();
	resetDisposed();
	initTheme("dark");
	const config = { ...DEFAULT_TOOL_DISPLAY_CONFIG, mcpOutputMode: "preview" as const };
	const { api } = createExtensionApiStub();

	try {
		registerToolDisplayOverrides(api, () => config);
		const definition = {
			name: "mcp",
			label: "MCP",
			description: "Unified MCP gateway.",
			parameters: {},
			renderShell: "self" as const,
			renderCall: () => new Text("adapter inline call", 0, 0),
			renderResult: () => new Text("adapter inline result", 0, 0),
		};
		const component = new ToolExecutionComponent(
			"mcp",
			"mcp-call-1",
			{},
			{},
			definition as never,
			{ requestRender(): void {} } as never,
			process.cwd(),
		);
		component.setArgsComplete();
		component.markExecutionStarted();
		component.updateResult({
			content: [{ type: "text", text: "server output" }],
			details: {},
			isError: false,
		}, false);

		const lines = component.render(80);
		const plainText = lines.join("\n").replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "");
		assert.ok(lines.length >= 5, "default Box should add outer spacing and vertical padding");
		assert.match(plainText, /MCP status/);
		assert.match(plainText, /server output/);
		assert.doesNotMatch(plainText, /adapter inline/);
		assert.ok(lines.some((line) => line.includes("\x1b[48")), "default Box should paint the tool background");
	} finally {
		disposeAll();
		resetDisposed();
	}
});
