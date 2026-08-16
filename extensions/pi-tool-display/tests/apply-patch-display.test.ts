import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	extractApplyPatchTargets,
	renderApplyPatchCall,
	renderApplyPatchResult,
} from "../src/apply-patch-display.ts";
import { createMcpToolExecutionPatchOptions } from "../src/tool-overrides.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG, type ToolDisplayConfig } from "../src/types.ts";

interface RenderComponentLike {
	render(width: number): string[];
}

const identityTheme = {
	fg: (_color: string, text: string): string => text,
	bg: (_color: string, text: string): string => text,
	bold: (text: string): string => text,
};

function renderLines(component: unknown, width = 100): string[] {
	return (component as RenderComponentLike).render(width).map((line) => line.trimEnd());
}

function renderText(component: unknown, width = 100): string {
	return renderLines(component, width).join("\n").trim();
}

function buildConfig(overrides: Partial<ToolDisplayConfig> = {}): ToolDisplayConfig {
	return {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		...overrides,
		registerToolOverrides: {
			...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides,
			...overrides.registerToolOverrides,
		},
		customToolOverrides: {
			...DEFAULT_TOOL_DISPLAY_CONFIG.customToolOverrides,
			...overrides.customToolOverrides,
		},
	};
}

function createPreviewFile(
	filePath: string,
	diff: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		filePath,
		operation: "update",
		diff,
		added: diff.split("\n").filter((line) => line.startsWith("+")).length,
		removed: diff.split("\n").filter((line) => line.startsWith("-")).length,
		...overrides,
	};
}

test("apply_patch call rendering supports freeform arguments, moves, and multi-file summaries", () => {
	const movedPatch = `*** Begin Patch
*** Update File: src/old.ts
*** Move to: src/new.ts
@@
-old
+new
*** End Patch`;
	const multiPatch = `*** Begin Patch
*** Update File: src/a.ts
@@
-a
+A
*** Add File: src/b.ts
+B
*** End Patch`;

	assert.deepEqual(extractApplyPatchTargets(movedPatch), [
		{ filePath: "src/old.ts", movePath: "src/new.ts", operation: "update" },
	]);
	assert.equal(
		renderText(renderApplyPatchCall(movedPatch, identityTheme, { cwd: "/workspace" })),
		"apply_patch src/old.ts -> src/new.ts",
	);
	assert.equal(
		renderText(renderApplyPatchCall({ input: multiPatch }, identityTheme, { cwd: "/workspace" })),
		"apply_patch 2 files",
	);
});

test("single-file apply_patch results render through the existing edit diff engine", () => {
	const component = renderApplyPatchResult(
		{
			content: [{ type: "text", text: "update: src/example.ts" }],
			details: {
				preview: {
					files: [createPreviewFile("src/example.ts", "-1 const oldValue = 1;\n+1 const newValue = 1;\n 2 same();")],
					added: 1,
					removed: 1,
				},
				result: { appliedFiles: ["src/example.ts"], failures: [], hasPartialSuccess: false },
			},
		},
		{ expanded: false, isPartial: false },
		buildConfig({ diffViewMode: "unified" }),
		identityTheme,
		{ cwd: "/workspace" },
	);
	const rendered = renderText(component);

	assert.match(rendered, /diff .*\+1 .*\-1/);
	assert.match(rendered, /oldValue/);
	assert.match(rendered, /newValue/);
	assert.doesNotMatch(rendered, /update: src\/example\.ts/);
});

test("collapsed apply_patch previews keep late canonical changes visible", () => {
	const diff = Array.from({ length: 70 }, (_, index) => {
		const lineNumber = index + 1;
		if (lineNumber === 40) {
			return [
				"-40 export const target = 'before';",
				"+40 export const target = 'after';",
			];
		}
		return [` ${String(lineNumber).padStart(2, " ")} export const unchanged${lineNumber} = true;`];
	}).flat().join("\n");
	const result = {
		content: [{ type: "text", text: "update: src/late-change.ts" }],
		details: {
			preview: {
				files: [createPreviewFile("src/late-change.ts", diff)],
				added: 1,
				removed: 1,
			},
			result: { appliedFiles: ["src/late-change.ts"], failures: [], hasPartialSuccess: false },
		},
	};

	for (const diffViewMode of ["split", "unified"] as const) {
		const rendered = renderText(
			renderApplyPatchResult(
				result,
				{ expanded: false, isPartial: false },
				buildConfig({ diffViewMode, diffCollapsedLines: 24, diffWordWrap: true }),
				identityTheme,
				{ cwd: "/workspace" },
			),
			160,
		);

		assert.match(rendered, /before/, `${diffViewMode} preview should show removed text`);
		assert.match(rendered, /after/, `${diffViewMode} preview should show added text`);
		assert.doesNotMatch(rendered, /unchanged1 = true/, `${diffViewMode} preview should focus on the change`);
		assert.match(rendered, /Ctrl\+O to expand/);
		if (diffViewMode === "split") {
			assert.match(rendered, /\bold\b.*\bnew\b/, "split preview should preserve its column headers");
		}
	}
});

test("multi-file apply_patch results label sections and share the collapsed line budget", () => {
	const longDiff = (prefix: string): string => [
		...Array.from({ length: 8 }, (_, index) => `-${index + 1} ${prefix}-old-${index + 1}`),
		...Array.from({ length: 8 }, (_, index) => `+${index + 1} ${prefix}-new-${index + 1}`),
	].join("\n");
	const result = {
		content: [{ type: "text", text: "updated two files" }],
		details: {
			preview: {
				files: [
					createPreviewFile("src/a.ts", longDiff("a")),
					createPreviewFile("src/b.ts", longDiff("b"), { operation: "add" }),
				],
				added: 16,
				removed: 16,
			},
			result: { appliedFiles: ["src/a.ts", "src/b.ts"], failures: [], hasPartialSuccess: false },
		},
	};
	const config = buildConfig({ diffViewMode: "unified", diffCollapsedLines: 6, expandedPreviewMaxLines: 100 });
	const collapsed = renderText(
		renderApplyPatchResult(result, { expanded: false, isPartial: false }, config, identityTheme, { cwd: "/workspace" }),
	);
	const expanded = renderText(
		renderApplyPatchResult(result, { expanded: true, isPartial: false }, config, identityTheme, { cwd: "/workspace" }),
	);

	assert.match(collapsed, /edit src\/a\.ts/);
	assert.match(collapsed, /add src\/b\.ts/);
	assert.ok(collapsed.split("\n").length < expanded.split("\n").length);
	assert.match(collapsed, /Ctrl\+O to expand/);
});

test("partial progress and failures remain distinct from intended diff previews", () => {
	const preview = {
		files: [
			createPreviewFile("src/applied.ts", "-1 old\n+1 new"),
			createPreviewFile("src/failed.ts", "-1 before\n+1 after"),
		],
		added: 2,
		removed: 2,
	};
	const partial = renderText(renderApplyPatchResult(
		{ content: [], details: { preview, progress: { applied: 1, failed: 0, total: 2 } } },
		{ expanded: false, isPartial: true },
		buildConfig({ diffViewMode: "unified" }),
		identityTheme,
		{ cwd: "/workspace" },
	));
	assert.match(partial, /applying patch 1\/2/);

	const failed = renderText(renderApplyPatchResult(
		{
			content: [{ type: "text", text: "Recovery: MUST read src/failed.ts before retrying." }],
			details: {
				preview,
				result: {
					appliedFiles: ["src/applied.ts"],
					failures: [{ filePath: "src/failed.ts", message: "context mismatch" }],
					hasPartialSuccess: true,
				},
			},
		},
		{ expanded: true, isPartial: false },
		buildConfig({ diffViewMode: "unified" }),
		identityTheme,
		{ cwd: "/workspace" },
	));
	assert.match(failed, /patch partially applied \(1 applied, 1 failed\)/);
	assert.match(failed, /preview includes intended changes/);
	assert.match(failed, /failed src\/failed\.ts/);
	assert.match(failed, /Recovery: MUST read src\/failed\.ts/);
});

test("apply_patch rendering falls back to text and stays within the requested width", () => {
	const fallback = renderText(renderApplyPatchResult(
		{ content: [{ type: "text", text: "Applied patch without preview" }] },
		{ expanded: false, isPartial: false },
		buildConfig(),
		identityTheme,
	));
	assert.equal(fallback, "Applied patch without preview");

	const component = renderApplyPatchResult(
		{
			content: [],
			details: {
				preview: {
					files: [createPreviewFile("src/a-very-long-file-name-that-must-wrap.ts", "-1 before\n+1 after")],
					added: 1,
					removed: 1,
				},
			},
		},
		{ expanded: false, isPartial: false },
		buildConfig({ diffViewMode: "unified" }),
		identityTheme,
		{ cwd: "/workspace" },
	);
	for (const width of [8, 16, 40, 100]) {
		for (const line of renderLines(component, width)) {
			assert.ok(visibleWidth(line) <= width, `line exceeded width ${width}: ${line}`);
		}
	}
});

test("malformed structured previews fall back atomically and unstructured errors stay explicit", () => {
	const malformed = renderText(renderApplyPatchResult(
		{
			content: [{ type: "text", text: "raw fallback" }],
			details: {
				preview: {
					files: [
						createPreviewFile("src/valid.ts", "-1 old\n+1 new"),
						{ filePath: "src/malformed.ts", operation: "update" },
					],
				},
			},
		},
		{ expanded: false, isPartial: false },
		buildConfig(),
		identityTheme,
	));
	assert.equal(malformed, "raw fallback");

	const errored = renderText(renderApplyPatchResult(
		{
			content: [{ type: "text", text: "unexpected failure" }],
			details: {
				preview: {
					files: [createPreviewFile("src/example.ts", "-1 old\n+1 new")],
				},
			},
			isError: true,
		},
		{ expanded: true, isPartial: false },
		buildConfig({ diffViewMode: "unified" }),
		identityTheme,
	));
	assert.match(errored, /apply_patch failed • preview shows intended changes/);
	assert.match(errored, /unexpected failure/);
	assert.match(errored, /old/);
	assert.match(errored, /new/);
});

test("native renderer matching is exact and supports an explicit apply_patch opt-out", () => {
	const patch = createMcpToolExecutionPatchOptions(() => buildConfig());
	const applyPatchInstance = {
		toolName: "apply_patch",
		toolDefinition: { name: "apply_patch", label: "ApplyPatch" },
	};
	assert.equal(patch.matches(applyPatchInstance), true);
	assert.equal(patch.useDefaultShell?.(applyPatchInstance), true);
	assert.equal(patch.matches({ toolName: "apply_patch_preview", toolDefinition: {} }), false);

	const disabledConfig = buildConfig({
		customToolOverrides: {
			apply_patch: { enabled: false, kind: "generic", outputMode: "summary" },
		},
	});
	assert.equal(createMcpToolExecutionPatchOptions(() => disabledConfig).matches(applyPatchInstance), false);
});
