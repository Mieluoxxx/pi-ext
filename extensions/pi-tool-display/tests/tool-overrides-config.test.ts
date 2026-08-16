import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createMcpToolExecutionPatchOptions,
	registerToolDisplayOverrides,
} from "../src/tool-overrides.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG, type ToolDisplayConfig } from "../src/types.ts";

interface RenderThemeLike {
	fg(color: string, value: string): string;
	bold(value: string): string;
}

interface RenderComponentLike {
	render(width: number): string[];
}

interface RenderCallContextLike {
	lastComponent?: unknown;
	state?: Record<string, unknown>;
	invalidate(): void;
	executionStarted: boolean;
	isPartial: boolean;
	expanded?: boolean;
}

interface RegisteredToolLike {
	name: string;
	description?: string;
	parameters?: unknown;
	promptSnippet?: string;
	promptGuidelines?: string[];
	renderShell?: "default" | "self";
	renderCall?: (args: unknown, theme: RenderThemeLike, context: RenderCallContextLike) => RenderComponentLike;
	renderResult?: (
		result: unknown,
		options: unknown,
		theme: unknown,
		context?: { isError?: boolean },
	) => RenderComponentLike;
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

function withDefaultBuiltInOwners(tools: unknown[] = []): unknown[] {
	const names = new Set(
		tools
			.map((tool) => (tool as { name?: unknown }).name)
			.filter((name): name is string => typeof name === "string"),
	);
	const defaults = ["read", "grep", "find", "ls", "bash", "edit", "write"]
		.filter((name) => !names.has(name))
		.map((name) => ({ name, sourceInfo: { source: "builtin", path: `<builtin:${name}>` } }));
	return [...defaults, ...tools];
}

function createExtensionApiStub(allTools: Array<RegisteredToolLike & Record<string, unknown>> = []): {
	api: ExtensionAPI;
	registeredTools: RegisteredToolLike[];
	runtimeTools: Array<RegisteredToolLike & Record<string, unknown>>;
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
			return withDefaultBuiltInOwners(allTools);
		},
	} as unknown as ExtensionAPI;

	return { api, registeredTools, runtimeTools: allTools, eventHandlers };
}

async function runLifecycle(eventHandlers: ToolEventHandlers): Promise<void> {
	await eventHandlers.session_start?.();
	await eventHandlers.before_agent_start?.();
}

function createTheme(): RenderThemeLike {
	return {
		fg: (_color: string, value: string): string => value,
		bold: (value: string): string => value,
	};
}

function normalizeRenderedText(component: RenderComponentLike): string {
	return component
		.render(120)
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

interface ToolResultInput {
	text?: string;
	content?: unknown[];
	details?: unknown;
	expanded?: boolean;
	isPartial?: boolean;
	isError?: boolean;
	contextIsError?: boolean;
}

function renderToolResult(tool: RegisteredToolLike | undefined, input: string | ToolResultInput): string {
	assert.ok(tool?.renderResult, `expected renderResult for tool '${tool?.name ?? "unknown"}'`);
	const payload: ToolResultInput = typeof input === "string" ? { text: input } : input;
	return normalizeRenderedText(
		tool.renderResult(
			{
				content: payload.content ?? [{ type: "text", text: payload.text ?? "" }],
				details: payload.details ?? {},
				isError: payload.isError ?? false,
			},
			{ isPartial: payload.isPartial ?? false, expanded: payload.expanded ?? false },
			createTheme(),
			{ isError: payload.contextIsError ?? false },
		),
	);
}

function renderToolCall(
	tool: RegisteredToolLike | undefined,
	args: Record<string, unknown>,
	contextOverrides: Partial<RenderCallContextLike> = {},
): { output: string; component: RenderComponentLike; context: RenderCallContextLike } {
	assert.ok(tool?.renderCall, `expected renderCall for tool '${tool?.name ?? "unknown"}'`);
	const context: RenderCallContextLike = {
		lastComponent: contextOverrides.lastComponent,
		state: contextOverrides.state ?? {},
		invalidate: contextOverrides.invalidate ?? (() => {}),
		executionStarted: contextOverrides.executionStarted ?? false,
		isPartial: contextOverrides.isPartial ?? false,
		expanded: contextOverrides.expanded ?? false,
	};
	const component = tool.renderCall(args, createTheme(), context);
	return {
		output: normalizeRenderedText(component),
		component,
		context,
	};
}

function createNativeToolView(
	tool: (RegisteredToolLike & Record<string, unknown>) | undefined,
	getConfig: () => ToolDisplayConfig,
): RegisteredToolLike | undefined {
	if (!tool) {
		return undefined;
	}
	const patch = createMcpToolExecutionPatchOptions(getConfig);
	const instance = { toolName: tool.name, toolDefinition: tool };
	if (!patch.matches(instance)) {
		return tool;
	}
	return {
		...tool,
		renderShell: patch.useDefaultShell?.(instance) ? "default" : tool.renderShell,
		renderCall: patch.createCallRenderer(instance) as RegisteredToolLike["renderCall"],
		renderResult: patch.createResultRenderer(instance) as RegisteredToolLike["renderResult"],
	};
}

function createNativeToolMap(
	tools: Array<RegisteredToolLike & Record<string, unknown>>,
	getConfig: () => ToolDisplayConfig,
): Map<string, RegisteredToolLike> {
	return new Map(tools.map((tool) => [tool.name, createNativeToolView(tool, getConfig) as RegisteredToolLike]));
}

test("current local-style config keeps read/search/MCP output modes distinct", async () => {
	const config = buildConfig({
		readOutputMode: "summary",
		searchOutputMode: "count",
		mcpOutputMode: "summary",
	});
	const { api, registeredTools, runtimeTools, eventHandlers } = createExtensionApiStub([
		{
			name: "mcp",
			description: "Unified MCP gateway for status, discovery, reconnects, and proxy tool calls.",
			parameters: {},
			execute(): void {
				// No-op test stub.
			},
		},
	]);

	registerToolDisplayOverrides(api, () => config);
	await runLifecycle(eventHandlers);

	const registeredNames = new Set(registeredTools.map((tool) => tool.name));
	const mcpTool = createNativeToolView(runtimeTools.find((tool) => tool.name === "mcp"), () => config);
	assert.ok(registeredNames.has("read"));
	assert.ok(registeredNames.has("grep"));
	assert.ok(registeredNames.has("find"));
	assert.ok(registeredNames.has("ls"));
	assert.ok(registeredNames.has("bash"));
	assert.ok(registeredNames.has("edit"));
	assert.ok(registeredNames.has("write"));
	assert.ok(mcpTool?.renderResult);

	assert.equal(
		renderToolResult(registeredTools.find((tool) => tool.name === "read"), "alpha\nbeta\n"),
		"↳ loaded 2 lines • Ctrl+O to expand",
	);
	assert.equal(
		renderToolResult(registeredTools.find((tool) => tool.name === "grep"), "a.txt:1\nb.txt:2\n"),
		"↳ 2 matches returned • Ctrl+O to expand",
	);
	assert.equal(
		renderToolResult(registeredTools.find((tool) => tool.name === "find"), "a.txt\nb.txt\n"),
		"↳ 2 results returned • Ctrl+O to expand",
	);
	assert.equal(
		renderToolResult(registeredTools.find((tool) => tool.name === "ls"), "a.txt\nb.txt\n"),
		"↳ 2 entries returned • Ctrl+O to expand",
	);
	assert.equal(
		renderToolResult(mcpTool, "one\ntwo\n"),
		"↳ 2 lines returned • Ctrl+O to expand",
	);
	assert.equal(
		renderToolResult(registeredTools.find((tool) => tool.name === "read"), {
			text: "alpha\nbeta\n",
			expanded: true,
		}),
		"alpha\nbeta",
	);
	assert.equal(
		renderToolResult(registeredTools.find((tool) => tool.name === "grep"), {
			text: "a.txt:1\nb.txt:2\n",
			expanded: true,
		}),
		"a.txt:1\nb.txt:2",
	);
	assert.equal(
		renderToolResult(mcpTool, {
			text: "one\ntwo\n",
			expanded: true,
		}),
		"one\ntwo",
	);
});

test("registerToolDisplayOverrides preserves MCP prompt metadata for proxy and direct wrappers", async () => {
	const { api, runtimeTools, eventHandlers } = createExtensionApiStub([
		{
			name: "mcp",
			description: "Unified MCP gateway for status, discovery, reconnects, and proxy tool calls.",
			parameters: {},
			promptSnippet: "Adapter-owned proxy prompt",
			promptGuidelines: ["Adapter-owned proxy guideline"],
			execute(): void {
				// No-op test stub.
			},
		},
		{
			name: "exa_web_search_exa",
			label: "MCP exa:web_search_exa",
			description:
				"Search the web for current information. Direct MCP wrapper for 'exa:web_search_exa'. Common args: query*.",
			parameters: {},
			promptSnippet: "Adapter-owned direct prompt",
			execute(): void {
				// No-op test stub.
			},
		},
	]);

	registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
	await runLifecycle(eventHandlers);

	const byName = new Map(runtimeTools.map((tool) => [tool.name, tool]));
	assert.equal(
		byName.get("mcp")?.promptSnippet,
		"Adapter-owned proxy prompt",
	);
	assert.deepEqual(byName.get("mcp")?.promptGuidelines, ["Adapter-owned proxy guideline"]);
	assert.equal(
		byName.get("exa_web_search_exa")?.promptSnippet,
		"Adapter-owned direct prompt",
	);
	assert.equal(byName.get("exa_web_search_exa")?.promptGuidelines, undefined);
});

test("MCP calls use semantic one-line headers and expanded arguments", async () => {
	const config = buildConfig({ mcpOutputMode: "preview" });
	const { api, runtimeTools, eventHandlers } = createExtensionApiStub([
		{
			name: "mcp",
			label: "MCP",
			description: "Unified MCP gateway for proxy calls.",
			parameters: {},
		},
		{
			name: "mcpScript",
			label: "MCP Script",
			description: "Run trusted JavaScript MCP calls.",
			parameters: {},
		},
		{
			name: "exa_web_search_exa",
			label: "MCP: web_search_exa",
			description: "Direct MCP wrapper for web search.",
			parameters: {},
		},
	]);
	registerToolDisplayOverrides(api, () => config);
	await runLifecycle(eventHandlers);
	const byName = createNativeToolMap(runtimeTools, () => config);
	const proxy = byName.get("mcp");

	assert.equal(
		renderToolCall(proxy, {
			tool: "explore",
			server: "codegraph",
			args: { query: "rendering", limit: 5 },
		}).output,
		"MCP call codegraph:explore (2 args)",
	);
	assert.equal(
		renderToolCall(
			proxy,
			{
				tool: "explore",
				server: "codegraph",
				args: '{"query":"rendering","limit":5}',
			},
			{ expanded: true },
		).output,
		'MCP call codegraph:explore (2 args)\n{\n  "query": "rendering",\n  "limit": 5\n}',
	);
	assert.equal(
		renderToolCall(proxy, { tool: "explore" }).output,
		"MCP call explore (no args)",
	);
	assert.equal(
		renderToolCall(proxy, { tool: "explore", args: "{invalid" }).output,
		"MCP call explore (args)",
	);
	assert.equal(
		renderToolCall(proxy, { tool: "explore", args: "{invalid" }, { expanded: true }).output,
		"MCP call explore (args)\n{invalid",
	);
	assert.equal(
		renderToolCall(byName.get("mcpScript"), { code: "emit('ok')", timeoutMs: 1000 }).output,
		"MCP Script (2 args)",
	);
	assert.equal(
		renderToolCall(byName.get("exa_web_search_exa"), { query: "pi" }).output,
		"MCP web_search_exa (1 arg)",
	);
	assert.equal(
		renderToolCall(
			byName.get("exa_web_search_exa"),
			{ query: "pi" },
			{ expanded: true },
		).output,
		'MCP web_search_exa (1 arg)\n{\n  "query": "pi"\n}',
	);
});

test("MCP proxy call headers cover every gateway operation", async () => {
	const { api, runtimeTools, eventHandlers } = createExtensionApiStub([
		{
			name: "mcp",
			label: "MCP",
			description: "Unified MCP gateway for proxy calls.",
			parameters: {},
		},
	]);
	registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
	await runLifecycle(eventHandlers);
	const proxy = createNativeToolView(
		runtimeTools.find((tool) => tool.name === "mcp"),
		() => DEFAULT_TOOL_DISPLAY_CONFIG,
	);
	const cases: Array<[Record<string, unknown>, string]> = [
		[{ connect: "codegraph" }, "MCP connect codegraph"],
		[{ describe: "explore", server: "codegraph" }, "MCP describe explore @ codegraph"],
		[{ instructions: "codegraph" }, "MCP instructions codegraph"],
		[
			{
				search: "render\nresults",
				server: "codegraph",
				regex: true,
				includeSchemas: false,
				limit: 20,
				offset: 4,
			},
			'MCP search "render results" @ codegraph regex schemas hidden limit 20 offset 4',
		],
		[{ server: "codegraph" }, "MCP tools codegraph"],
		[{ action: "ui-messages" }, "MCP ui-messages"],
		[{ action: "auth-start", server: "codegraph" }, "MCP auth-start @ codegraph"],
		[{}, "MCP status"],
	];

	for (const [args, expected] of cases) {
		assert.equal(renderToolCall(proxy, args).output, expected);
	}
});

test("MCP results share output modes, state handling, and non-text placeholders", async () => {
	let config = buildConfig({
		mcpOutputMode: "hidden",
		previewLines: 1,
		expandedPreviewMaxLines: 1,
	});
	const { api, runtimeTools, eventHandlers } = createExtensionApiStub([
		{
			name: "mcp",
			description: "Unified MCP gateway for proxy calls.",
			parameters: {},
		},
	]);
	registerToolDisplayOverrides(api, () => config);
	await runLifecycle(eventHandlers);
	const proxy = createNativeToolView(runtimeTools.find((tool) => tool.name === "mcp"), () => config);

	assert.equal(renderToolResult(proxy, "alpha"), "");
	assert.equal(renderToolResult(proxy, { text: "", isPartial: true }), "running...");
	assert.equal(renderToolResult(proxy, { text: "failure", isError: true }), "↳ MCP call failed\nfailure");
	assert.equal(
		renderToolResult(proxy, { text: "context failure", contextIsError: true }),
		"↳ MCP call failed\ncontext failure",
	);
	assert.equal(
		renderToolResult(proxy, { text: "detail failure", details: { error: "boom" } }),
		"↳ MCP call failed\ndetail failure",
	);
	assert.equal(renderToolResult(proxy, { text: "not an error", details: { error: false } }), "");

	config = { ...config, mcpOutputMode: "summary" };
	assert.equal(
		renderToolResult(proxy, "alpha\nbeta\n"),
		"↳ 2 lines returned • Ctrl+O to expand",
	);

	config = { ...config, mcpOutputMode: "preview" };
	assert.equal(
		renderToolResult(proxy, "alpha\nbeta\n"),
		"alpha\n... (1 more line • Ctrl+O to expand)",
	);
	assert.equal(
		renderToolResult(proxy, { content: [{ type: "image", mimeType: "image/png" }] }),
		"[image: image/png]",
	);
	assert.equal(renderToolResult(proxy, { content: [null] }), "[content]");
	assert.equal(
		renderToolResult(proxy, { text: "alpha\nbeta\n", expanded: true }),
		"alpha\n... (1 more line)\n(display capped at 1 lines by tool-display setting)",
	);
	config = { ...config, showTruncationHints: true };
	assert.equal(
		renderToolResult(proxy, {
			text: "alpha",
			details: {
				truncation: { truncated: true, fullOutputPath: "/tmp/mcp-full-output.txt" },
			},
		}),
		"alpha\n(truncated by backend limits • full output: /tmp/mcp-full-output.txt)",
	);
});

test("non-text placeholders remain confined to MCP output", async () => {
	const config = buildConfig({
		customToolOverrides: {
			generic_tool: { enabled: true, kind: "generic", outputMode: "preview" },
		},
	});
	const { api, runtimeTools, eventHandlers } = createExtensionApiStub([
		{
			name: "generic_tool",
			description: "Generic custom tool.",
			parameters: {},
		},
	]);
	registerToolDisplayOverrides(api, () => config);
	await runLifecycle(eventHandlers);

	assert.equal(
		renderToolResult(createNativeToolView(runtimeTools[0], () => config), { content: [{ type: "image", mimeType: "image/png" }] }),
		"↳ (no output)",
	);
});

test("read-only ownership keeps summary line counts confined to read", async () => {
	const config = buildConfig({
		registerToolOverrides: {
			read: true,
			grep: false,
			find: false,
			ls: false,
			bash: false,
			edit: false,
			write: false,
		},
		readOutputMode: "summary",
	});
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();

	registerToolDisplayOverrides(api, () => config);
	await eventHandlers.before_agent_start?.();

	assert.deepEqual(
		registeredTools.map((tool) => tool.name),
		["read"],
	);
	assert.equal(
		renderToolResult(registeredTools[0], "single line\n"),
		"↳ loaded 1 line • Ctrl+O to expand",
	);
});

test("showTruncationHints=false suppresses backend truncation summaries across read/search/MCP modes", async () => {
	const config = buildConfig({
		readOutputMode: "summary",
		searchOutputMode: "count",
		mcpOutputMode: "summary",
		showTruncationHints: false,
	});
	const { api, registeredTools, runtimeTools, eventHandlers } = createExtensionApiStub([
		{
			name: "mcp",
			description: "Unified MCP gateway for status, discovery, reconnects, and proxy tool calls.",
			parameters: {},
			execute(): void {
				// No-op test stub.
			},
		},
	]);

	registerToolDisplayOverrides(api, () => config);
	await runLifecycle(eventHandlers);
	const mcpTool = createNativeToolView(runtimeTools.find((tool) => tool.name === "mcp"), () => config);

	assert.equal(
		renderToolResult(registeredTools.find((tool) => tool.name === "read"), {
			text: "alpha\n",
			details: { truncation: { truncated: true } },
		}),
		"↳ loaded 1 line • Ctrl+O to expand",
	);
	assert.equal(
		renderToolResult(registeredTools.find((tool) => tool.name === "grep"), {
			text: "a.txt:1\n",
			details: { truncation: { truncated: true } },
		}),
		"↳ 1 match returned • Ctrl+O to expand",
	);
	assert.equal(
		renderToolResult(mcpTool, {
			text: "alpha\n",
			details: { truncation: { truncated: true } },
		}),
		"↳ 1 line returned • Ctrl+O to expand",
	);
});

test("showRtkCompactionHints stays independent from showTruncationHints for summary modes", async () => {
	const config = buildConfig({
		readOutputMode: "summary",
		searchOutputMode: "count",
		mcpOutputMode: "summary",
		showTruncationHints: false,
		showRtkCompactionHints: true,
	});
	const { api, registeredTools, runtimeTools, eventHandlers } = createExtensionApiStub([
		{
			name: "mcp",
			description: "Unified MCP gateway for status, discovery, reconnects, and proxy tool calls.",
			parameters: {},
			execute(): void {
				// No-op test stub.
			},
		},
	]);
	const rtkDetails = {
		rtkCompaction: {
			applied: true,
			techniques: ["trimmed context"],
		},
	};

	registerToolDisplayOverrides(api, () => config);
	await runLifecycle(eventHandlers);
	const mcpTool = createNativeToolView(runtimeTools.find((tool) => tool.name === "mcp"), () => config);

	assert.match(
		renderToolResult(registeredTools.find((tool) => tool.name === "read"), {
			text: "alpha\n",
			details: rtkDetails,
		}),
		/compacted by RTK • trimmed context/,
	);
	assert.match(
		renderToolResult(registeredTools.find((tool) => tool.name === "grep"), {
			text: "a.txt:1\n",
			details: rtkDetails,
		}),
		/compacted by RTK • trimmed context/,
	);
	assert.match(
		renderToolResult(mcpTool, {
			text: "alpha\n",
			details: rtkDetails,
		}),
		/compacted by RTK • trimmed context/,
	);
});

test("showRtkCompactionHints stays independent from showTruncationHints for preview modes", async () => {
	const config = buildConfig({
		readOutputMode: "preview",
		searchOutputMode: "preview",
		mcpOutputMode: "preview",
		previewLines: 1,
		showTruncationHints: false,
		showRtkCompactionHints: true,
	});
	const { api, registeredTools, runtimeTools, eventHandlers } = createExtensionApiStub([
		{
			name: "mcp",
			description: "Unified MCP gateway for status, discovery, reconnects, and proxy tool calls.",
			parameters: {},
			execute(): void {
				// No-op test stub.
			},
		},
	]);
	const rtkDetails = {
		rtkCompaction: {
			applied: true,
			techniques: ["trimmed context"],
			originalLineCount: 10,
			compactedLineCount: 1,
		},
	};

	registerToolDisplayOverrides(api, () => config);
	await runLifecycle(eventHandlers);
	const mcpTool = createNativeToolView(runtimeTools.find((tool) => tool.name === "mcp"), () => config);

	assert.match(
		renderToolResult(registeredTools.find((tool) => tool.name === "read"), {
			text: "alpha\nbeta\n",
			details: rtkDetails,
		}),
		/compacted by RTK: trimmed context • 1\/10 lines kept/,
	);
	assert.match(
		renderToolResult(registeredTools.find((tool) => tool.name === "grep"), {
			text: "a.txt:1\nb.txt:2\n",
			details: rtkDetails,
		}),
		/compacted by RTK: trimmed context • 1\/10 lines kept/,
	);
	assert.match(
		renderToolResult(mcpTool, {
			text: "alpha\nbeta\n",
			details: rtkDetails,
		}),
		/compacted by RTK: trimmed context • 1\/10 lines kept/,
	);
});

test("bash output modes stay distinct across opencode, summary, and preview", async () => {
	const output = "alpha\nbeta\ngamma\n";

	const opencodeConfig = buildConfig({
		bashOutputMode: "opencode",
		bashCollapsedLines: 1,
	});
	const opencodeStub = createExtensionApiStub();
	registerToolDisplayOverrides(opencodeStub.api, () => opencodeConfig);
	await opencodeStub.eventHandlers.before_agent_start?.();
	assert.equal(
		renderToolResult(opencodeStub.registeredTools.find((tool) => tool.name === "bash"), output),
		"alpha\n... (2 more lines • Ctrl+O to expand)",
	);

	const summaryConfig = buildConfig({
		bashOutputMode: "summary",
		bashCollapsedLines: 1,
	});
	const summaryStub = createExtensionApiStub();
	registerToolDisplayOverrides(summaryStub.api, () => summaryConfig);
	await summaryStub.eventHandlers.before_agent_start?.();
	assert.equal(
		renderToolResult(summaryStub.registeredTools.find((tool) => tool.name === "bash"), output),
		"↳ 3 lines returned • Ctrl+O to expand",
	);
	assert.equal(
		renderToolResult(summaryStub.registeredTools.find((tool) => tool.name === "bash"), {
			text: output,
			expanded: true,
		}),
		"alpha\nbeta\ngamma",
	);

	const previewConfig = buildConfig({
		bashOutputMode: "preview",
		previewLines: 2,
		bashCollapsedLines: 1,
	});
	const previewStub = createExtensionApiStub();
	registerToolDisplayOverrides(previewStub.api, () => previewConfig);
	await previewStub.eventHandlers.before_agent_start?.();
	assert.equal(
		renderToolResult(previewStub.registeredTools.find((tool) => tool.name === "bash"), output),
		"alpha\nbeta\n... (1 more line • Ctrl+O to expand)",
	);
});

test("bash collapses a single long physical line by character budget", async () => {
	const config = buildConfig({
		bashOutputMode: "opencode",
		bashCollapsedLines: 10,
		bashCollapsedMaxChars: 4,
	});
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => config);
	await eventHandlers.before_agent_start?.();

	assert.equal(
		renderToolResult(registeredTools.find((tool) => tool.name === "bash"), "abcdefghij"),
		"abcd\n... (6 more characters • Ctrl+O to expand)",
	);
});

test("bash reports both line and character omissions when both budgets are exceeded", async () => {
	const config = buildConfig({
		bashOutputMode: "opencode",
		bashCollapsedLines: 1,
		bashCollapsedMaxChars: 3,
	});
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => config);
	await eventHandlers.before_agent_start?.();

	assert.equal(
		renderToolResult(registeredTools.find((tool) => tool.name === "bash"), "abcdef\nsecond\nthird"),
		"abc\n... (2 more lines • 14 more characters • Ctrl+O to expand)",
	);
});

test("bash partial output respects the collapsed character budget", async () => {
	const config = buildConfig({
		bashOutputMode: "opencode",
		bashCollapsedLines: 10,
		bashCollapsedMaxChars: 3,
	});
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => config);
	await eventHandlers.before_agent_start?.();

	assert.equal(
		renderToolResult(registeredTools.find((tool) => tool.name === "bash"), {
			text: "abcdef",
			isPartial: true,
		}),
		"abc\n... (3 more characters • Ctrl+O to expand)",
	);
});

test("bash character truncation preserves ANSI sequences and Unicode code points", async () => {
	const config = buildConfig({
		bashOutputMode: "opencode",
		bashCollapsedLines: 10,
		bashCollapsedMaxChars: 2,
	});
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => config);
	await eventHandlers.before_agent_start?.();

	assert.equal(
		renderToolResult(registeredTools.find((tool) => tool.name === "bash"), "\x1b[31mA😀BC"),
		"\x1b[31mA😀\x1b[39;22;23;24;25;27;28;29;59m\n... (2 more characters • Ctrl+O to expand)",
	);
});

test("bash character budget is bypassed when expanded", async () => {
	const config = buildConfig({
		bashOutputMode: "opencode",
		bashCollapsedLines: 10,
		bashCollapsedMaxChars: 3,
	});
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => config);
	await eventHandlers.before_agent_start?.();
	const bashTool = registeredTools.find((tool) => tool.name === "bash");

	assert.equal(
		renderToolResult(bashTool, "abcdef"),
		"abc\n... (3 more characters • Ctrl+O to expand)",
	);
	assert.equal(
		renderToolResult(bashTool, { text: "abcdef", expanded: true }),
		"abcdef",
	);
});

test("bash hides partial output when its collapsed line budget is zero", async () => {
	const config = buildConfig({
		bashOutputMode: "opencode",
		bashCollapsedLines: 0,
		bashCollapsedMaxChars: 3,
	});
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => config);
	await eventHandlers.before_agent_start?.();

	assert.equal(
		renderToolResult(registeredTools.find((tool) => tool.name === "bash"), {
			text: "abcdef",
			isPartial: true,
		}),
		"",
	);
});

test("bash character budget can be disabled", async () => {
	const config = buildConfig({
		bashOutputMode: "opencode",
		bashCollapsedLines: 10,
		bashCollapsedMaxChars: 0,
	});
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => config);
	await eventHandlers.before_agent_start?.();

	assert.equal(renderToolResult(registeredTools.find((tool) => tool.name === "bash"), "abcdef"), "abcdef");
});

test("bash preserves backend truncation hints when character-collapsed", async () => {
	const config = buildConfig({
		bashOutputMode: "opencode",
		bashCollapsedLines: 10,
		bashCollapsedMaxChars: 3,
		showTruncationHints: true,
	});
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => config);
	await eventHandlers.before_agent_start?.();

	assert.equal(
		renderToolResult(registeredTools.find((tool) => tool.name === "bash"), {
			text: "abcdef",
			details: { truncation: { truncated: true } },
		}),
		"abc\n... (3 more characters • Ctrl+O to expand)\n(output truncated)",
	);
});

test("bash call spinner appears only while execution is active", async () => {
	const config = buildConfig({
		bashOutputMode: "summary",
	});
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => config);
	await eventHandlers.before_agent_start?.();

	const bashTool = registeredTools.find((tool) => tool.name === "bash");
	const idle = renderToolCall(bashTool, { command: "npm test" });
	assert.equal(idle.output, "$ npm test");

	let invalidateCount = 0;
	const running = renderToolCall(
		bashTool,
		{ command: "npm test" },
		{
			state: {},
			executionStarted: true,
			isPartial: true,
			invalidate: () => {
				invalidateCount++;
			},
		},
	);
	assert.match(running.output, /^⠋ \$ npm test · 0s$/);

	await new Promise((resolve) => setTimeout(resolve, 220));
	const animatedFrame = normalizeRenderedText(running.component);
	assert.notEqual(animatedFrame, running.output);
	assert.match(animatedFrame, /^⠙ \$ npm test · 0s$/);
	assert.ok(invalidateCount > 0);

	const complete = renderToolCall(
		bashTool,
		{ command: "npm test" },
		{
			state: running.context.state,
			lastComponent: running.component,
			executionStarted: true,
			isPartial: false,
		},
	);
	assert.equal(complete.output, "$ npm test");
});

test("bash render keeps the running result area empty until output exists", async () => {
	const config = buildConfig({
		bashOutputMode: "summary",
	});
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => config);
	await eventHandlers.before_agent_start?.();

	const bashTool = registeredTools.find((tool) => tool.name === "bash");
	assert.equal(
		renderToolResult(bashTool, { text: "", isPartial: true }),
		"",
	);
});

test("bash render shows live partial output once streaming begins", async () => {
	const config = buildConfig({
		bashOutputMode: "summary",
		previewLines: 2,
	});
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => config);
	await eventHandlers.before_agent_start?.();

	const bashTool = registeredTools.find((tool) => tool.name === "bash");
	assert.equal(
		renderToolResult(bashTool, {
			text: "alpha\nbeta\ngamma\n",
			isPartial: true,
		}),
		"alpha\nbeta\n... (1 more line • Ctrl+O to expand)",
	);
});

test("bash live partial output respects opencode collapse settings", async () => {
	const config = buildConfig({
		bashOutputMode: "opencode",
		bashCollapsedLines: 1,
		previewLines: 4,
	});
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => config);
	await eventHandlers.before_agent_start?.();

	const bashTool = registeredTools.find((tool) => tool.name === "bash");
	assert.equal(
		renderToolResult(bashTool, {
			text: "alpha\nbeta\ngamma\n",
			isPartial: true,
		}),
		"alpha\n... (2 more lines • Ctrl+O to expand)",
	);
});

test("bash errors render with an explicit failure header and preview", async () => {
	const config = buildConfig({
		bashOutputMode: "summary",
		previewLines: 2,
	});
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => config);
	await eventHandlers.before_agent_start?.();

	const bashTool = registeredTools.find((tool) => tool.name === "bash");
	assert.equal(
		renderToolResult(bashTool, {
			text: "npm ERR! missing script: test\nSee npm help run-script\n",
			isError: true,
		}),
		"↳ command failed\nnpm ERR! missing script: test\nSee npm help run-script",
	);
});
