import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isMcpToolCandidate } from "../src/tool-metadata.ts";
import {
	createMcpToolExecutionPatchOptions,
	registerToolDisplayOverrides,
} from "../src/tool-overrides.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG, type ToolDisplayConfig } from "../src/types.ts";

interface RenderThemeLike {
	fg(color: string, value: string): string;
	bold(value: string): string;
}

interface ToolEventHandlers {
	session_start?: () => Promise<void> | void;
	before_agent_start?: () => Promise<void> | void;
}

function buildConfig(overrides: Partial<ToolDisplayConfig>): ToolDisplayConfig {
	return {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		...overrides,
		registerToolOverrides: {
			...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides,
			...overrides.registerToolOverrides,
		},
	};
}

function createTheme(): RenderThemeLike {
	return {
		fg: (_color: string, value: string): string => value,
		bold: (value: string): string => value,
	};
}

function renderToText(component: unknown): string {
	return (component as { render: (width: number) => string[] })
		.render(120)
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

function createInstance(
	toolName: string,
	toolDefinition: Record<string, unknown> = {},
): Record<string, unknown> {
	return { toolName, toolDefinition: { name: toolName, ...toolDefinition } };
}

test("isMcpToolCandidate recognises proxy, direct metadata, and adapter source info", () => {
	assert.equal(isMcpToolCandidate({ name: "mcp", description: "unified gateway" }), true);
	assert.equal(isMcpToolCandidate({ name: "web_search", description: "MCP tool for web search" }), true);
	assert.equal(isMcpToolCandidate({ name: "server_tool", label: "MCP: tool" }), true);
	assert.equal(
		isMcpToolCandidate({
			name: "xcodebuild_list_sims",
			description: "List available iOS simulators.",
			sourceInfo: { source: "local", path: "/extensions/pi-mcp-adapter/index.ts" },
		}),
		true,
	);
});

test("isMcpToolCandidate rejects malformed values and non-word MCP substrings", () => {
	assert.equal(isMcpToolCandidate(null), false);
	assert.equal(isMcpToolCandidate(undefined), false);
	assert.equal(isMcpToolCandidate("mcp"), false);
	assert.equal(isMcpToolCandidate({ name: "random_tool" }), false);
	assert.equal(isMcpToolCandidate({ name: "some_tool", description: "McPherson's tool" }), false);
	assert.equal(isMcpToolCandidate({ name: "some_tool", description: "mcpExample" }), false);
});

test("native MCP patch renders proxy calls and results with the shared semantic UI", () => {
	const config = buildConfig({ mcpOutputMode: "summary" });
	const patch = createMcpToolExecutionPatchOptions(() => config);
	const instance = createInstance("mcp", {
		label: "MCP",
		description: "Unified MCP gateway.",
		renderShell: "self",
	});

	assert.equal(patch.matches(instance), true);
	const renderCall = patch.createCallRenderer(instance) as (
		args: unknown,
		theme: RenderThemeLike,
		context?: { expanded?: boolean },
	) => unknown;
	const renderResult = patch.createResultRenderer(instance) as (
		result: unknown,
		options: { expanded: boolean },
		theme: RenderThemeLike,
	) => unknown;

	assert.equal(
		renderToText(renderCall({ tool: "read_file", server: "filesystem", args: { path: "a.txt" } }, createTheme())),
		"MCP call filesystem:read_file (1 arg)",
	);
	assert.equal(
		renderToText(renderCall({ tool: "read_file", args: { path: "a.txt" } }, createTheme(), { expanded: true })),
		'MCP call read_file (1 arg)\n{\n  "path": "a.txt"\n}',
	);
	assert.equal(
		renderToText(renderResult(
			{ content: [{ type: "text", text: "line 1\nline 2" }] },
			{ expanded: false },
			createTheme(),
		)),
		"↳ 2 lines returned • Ctrl+O to expand",
	);
});

test("native MCP patch covers mcpScript and direct wrappers", () => {
	const patch = createMcpToolExecutionPatchOptions(() => DEFAULT_TOOL_DISPLAY_CONFIG);
	const script = createInstance("mcpScript", {
		label: "MCP Script",
		description: "Run trusted JavaScript MCP calls.",
	});
	const direct = createInstance("codegraph_codegraph_explore", {
		label: "MCP: codegraph_explore",
		description: "Explore an indexed project.",
		renderShell: "self",
	});

	assert.equal(patch.matches(script), true);
	assert.equal(patch.matches(direct), true);

	const renderScriptCall = patch.createCallRenderer(script) as (args: unknown, theme: RenderThemeLike) => unknown;
	const renderDirectCall = patch.createCallRenderer(direct) as (args: unknown, theme: RenderThemeLike) => unknown;
	assert.equal(
		renderToText(renderScriptCall({ code: "return 1", timeoutMs: 1000 }, createTheme())),
		"MCP Script (2 args)",
	);
	assert.equal(
		renderToText(renderDirectCall({ query: "render shell" }, createTheme())),
		"MCP codegraph_explore (1 arg)",
	);
});

test("native MCP patch honors explicit custom MCP output mode", () => {
	const config = buildConfig({
		mcpOutputMode: "hidden",
		previewLines: 1,
		customToolOverrides: {
			custom_gateway: { enabled: true, kind: "mcp", outputMode: "preview" },
			generic_tool: { enabled: true, kind: "generic", outputMode: "preview" },
		},
	});
	const patch = createMcpToolExecutionPatchOptions(() => config);
	const customMcp = createInstance("custom_gateway", { description: "Custom gateway." });
	const generic = createInstance("generic_tool", { description: "Mentions MCP but remains generic." });

	assert.equal(patch.matches(customMcp), true);
	assert.equal(patch.matches(generic), true);
	assert.equal(patch.useDefaultShell?.(customMcp), true);
	assert.equal(patch.useDefaultShell?.(generic), false);

	const renderCall = patch.createCallRenderer(customMcp) as (args: unknown, theme: RenderThemeLike) => unknown;
	const renderResult = patch.createResultRenderer(customMcp) as (
		result: unknown,
		options: { expanded: boolean },
		theme: RenderThemeLike,
	) => unknown;
	assert.equal(renderToText(renderCall({ connect: "filesystem" }, createTheme())), "MCP connect filesystem");
	assert.equal(
		renderToText(renderResult(
			{ content: [{ type: "text", text: "first\nsecond" }] },
			{ expanded: false },
			createTheme(),
		)),
		"first\n... (1 more line • Ctrl+O to expand)",
	);
});

test("native MCP patch leaves unrelated tools and adapter execution metadata untouched", () => {
	const patch = createMcpToolExecutionPatchOptions(() => DEFAULT_TOOL_DISPLAY_CONFIG);
	const execute = (): string => "executed";
	const adapterCall = (): string => "adapter call";
	const adapterResult = (): string => "adapter result";
	const definition = {
		name: "mcp",
		label: "MCP",
		description: "Unified MCP gateway.",
		parameters: { type: "object" },
		promptSnippet: "Adapter prompt",
		promptGuidelines: ["Adapter guideline"],
		execute,
		renderShell: "self",
		renderCall: adapterCall,
		renderResult: adapterResult,
	};
	const unrelated = createInstance("local_formatter", {
		label: "Formatter",
		description: "Format local source files.",
	});

	assert.equal(patch.matches(createInstance("mcp", definition)), true);
	assert.equal(patch.matches(unrelated), false);
	assert.equal(definition.execute, execute);
	assert.equal(definition.renderCall, adapterCall);
	assert.equal(definition.renderResult, adapterResult);
	assert.equal(definition.renderShell, "self");
	assert.equal(definition.promptSnippet, "Adapter prompt");
	assert.deepEqual(definition.promptGuidelines, ["Adapter guideline"]);
});

test("MCP decoration does not mutate getAllTools metadata copies", async () => {
	const snapshots: Array<Record<string, unknown>> = [];
	const handlers: ToolEventHandlers = {};
	const api = {
		registerTool(): void {},
		on(event: keyof ToolEventHandlers, handler: () => Promise<void> | void): void {
			handlers[event] = handler;
		},
		getAllTools(): Array<Record<string, unknown>> {
			const snapshot = {
				name: "mcp",
				description: "Unified MCP gateway.",
				parameters: {},
				promptSnippet: "Adapter prompt",
				sourceInfo: { source: "extension", path: "/pi-mcp-adapter/index.ts" },
			};
			snapshots.push(snapshot);
			return [
				{ name: "read", sourceInfo: { source: "builtin" } },
				{ name: "edit", sourceInfo: { source: "builtin" } },
				snapshot,
			];
		},
	} as unknown as ExtensionAPI;

	registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
	await handlers.session_start?.();
	await handlers.before_agent_start?.();

	assert.ok(snapshots.length > 0);
	for (const snapshot of snapshots) {
		assert.equal("renderCall" in snapshot, false);
		assert.equal("renderResult" in snapshot, false);
		assert.equal("renderShell" in snapshot, false);
	}
});
