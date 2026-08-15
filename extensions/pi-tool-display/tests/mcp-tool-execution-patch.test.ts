import assert from "node:assert/strict";
import test from "node:test";
import {
	patchMcpToolExecutionPrototype,
	type McpToolExecutionPatchOptions,
	type PatchableToolExecutionInstance,
	type PatchableToolExecutionPrototype,
	unregisterMcpToolExecutionPatch,
} from "../src/mcp-tool-execution-patch.ts";

function createPrototype(): PatchableToolExecutionPrototype {
	return {
		getRenderShell() {
			return `shell:${String(this.toolName)}`;
		},
		getCallRenderer() {
			return `call:${String(this.toolName)}`;
		},
		getResultRenderer() {
			return `result:${String(this.toolName)}`;
		},
	};
}

function createOptions(prefix: string): McpToolExecutionPatchOptions {
	return {
		matches(instance) {
			return instance.toolName === "mcp";
		},
		createCallRenderer(instance) {
			return `${prefix}:call:${String(instance.toolName)}`;
		},
		createResultRenderer(instance) {
			return `${prefix}:result:${String(instance.toolName)}`;
		},
	};
}

test("MCP execution patch replaces the shell and renderers only for matching tools", () => {
	const prototype = createPrototype();
	const options = createOptions("decorated");
	const mcp = { toolName: "mcp" } as PatchableToolExecutionInstance;
	const read = { toolName: "read" } as PatchableToolExecutionInstance;

	assert.equal(patchMcpToolExecutionPrototype(prototype, options), true);
	assert.equal(prototype.getRenderShell.call(mcp), "default");
	assert.equal(prototype.getCallRenderer.call(mcp), "decorated:call:mcp");
	assert.equal(prototype.getResultRenderer.call(mcp), "decorated:result:mcp");
	assert.equal(prototype.getRenderShell.call(read), "shell:read");
	assert.equal(prototype.getCallRenderer.call(read), "call:read");
	assert.equal(prototype.getResultRenderer.call(read), "result:read");
});

test("MCP execution patch updates in place without wrapping twice", () => {
	const prototype = createPrototype();
	const first = createOptions("first");
	const second = createOptions("second");
	const mcp = { toolName: "mcp" } as PatchableToolExecutionInstance;

	assert.equal(patchMcpToolExecutionPrototype(prototype, first), true);
	const patchedGetRenderShell = prototype.getRenderShell;
	assert.equal(patchMcpToolExecutionPrototype(prototype, second), true);
	assert.equal(prototype.getRenderShell, patchedGetRenderShell);
	assert.equal(prototype.getCallRenderer.call(mcp), "second:call:mcp");

	unregisterMcpToolExecutionPatch(prototype, first);
	assert.equal(prototype.getRenderShell.call(mcp), "default", "stale cleanup must not remove the current patch");
	unregisterMcpToolExecutionPatch(prototype, second);
	assert.equal(prototype.getRenderShell.call(mcp), "shell:mcp");
	assert.equal(prototype.getCallRenderer.call(mcp), "call:mcp");
	assert.equal(prototype.getResultRenderer.call(mcp), "result:mcp");
});

test("MCP execution patch falls back to Pi renderers when matching throws", () => {
	const prototype = createPrototype();
	const options: McpToolExecutionPatchOptions = {
		matches() {
			throw new Error("malformed runtime metadata");
		},
		createCallRenderer() {
			throw new Error("not reached");
		},
		createResultRenderer() {
			throw new Error("not reached");
		},
	};
	const instance = { toolName: "mcp" } as PatchableToolExecutionInstance;

	assert.equal(patchMcpToolExecutionPrototype(prototype, options), true);
	assert.equal(prototype.getRenderShell.call(instance), "shell:mcp");
	assert.equal(prototype.getCallRenderer.call(instance), "call:mcp");
	assert.equal(prototype.getResultRenderer.call(instance), "result:mcp");
});

test("MCP execution patch refuses incompatible Pi renderer prototypes", () => {
	const prototype = {
		getRenderShell(): string {
			return "self";
		},
	} as unknown as PatchableToolExecutionPrototype;

	assert.equal(patchMcpToolExecutionPrototype(prototype, createOptions("unused")), false);
});
