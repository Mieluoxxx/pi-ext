import { describe, expect, it } from "vitest";
import {
	buildForkCommand,
	buildPaneSplitArgs,
	buildTabCreateArgs,
	extractCreatedTab,
	extractHerdrError,
	extractPaneId,
	shellQuote,
} from "../src/herdr.js";

describe("extractPaneId", () => {
	it("extracts the pane id from a split envelope", () => {
		const stdout = JSON.stringify({
			result: { pane: { pane_id: "pane-123" } },
		});
		expect(extractPaneId(stdout)).toBe("pane-123");
	});

	it("returns undefined for missing pane id", () => {
		expect(extractPaneId(JSON.stringify({ result: {} }))).toBeUndefined();
		expect(extractPaneId(JSON.stringify({ result: { pane: {} } }))).toBeUndefined();
	});

	it("returns undefined for invalid JSON", () => {
		expect(extractPaneId("not json")).toBeUndefined();
		expect(extractPaneId("")).toBeUndefined();
	});
});

describe("extractCreatedTab", () => {
	it("extracts tab id and root pane id", () => {
		const stdout = JSON.stringify({
			result: {
				tab: { tab_id: "tab-9" },
				root_pane: { pane_id: "pane-9" },
			},
		});
		expect(extractCreatedTab(stdout)).toEqual({
			tab_id: "tab-9",
			root_pane_id: "pane-9",
		});
	});

	it("returns undefined when either id is missing", () => {
		expect(
			extractCreatedTab(JSON.stringify({ result: { tab: { tab_id: "t" } } })),
		).toBeUndefined();
		expect(
			extractCreatedTab(JSON.stringify({ result: { root_pane: { pane_id: "p" } } })),
		).toBeUndefined();
	});
});

describe("extractHerdrError", () => {
	it("prefers stderr JSON error messages", () => {
		const stderr = JSON.stringify({ error: { code: "E", message: "boom" } });
		expect(extractHerdrError("", stderr, "fallback")).toBe("boom");
	});

	it("falls back to raw text and then the fallback", () => {
		expect(extractHerdrError("", "raw problem", "fallback")).toBe("raw problem");
		expect(extractHerdrError("", "", "fallback")).toBe("fallback");
	});
});

describe("buildPaneSplitArgs", () => {
	it("builds args with an explicit parent pane", () => {
		expect(
			buildPaneSplitArgs({
				parentPaneId: "pane-1",
				direction: "right",
				cwd: "/tmp/proj",
			}),
		).toEqual([
			"pane",
			"split",
			"--pane",
			"pane-1",
			"--direction",
			"right",
			"--cwd",
			"/tmp/proj",
			"--focus",
		]);
	});

	it("uses --current and --no-focus when configured", () => {
		expect(
			buildPaneSplitArgs({
				direction: "down",
				cwd: "/tmp",
				focus: false,
			}),
		).toEqual([
			"pane",
			"split",
			"--current",
			"--direction",
			"down",
			"--cwd",
			"/tmp",
			"--no-focus",
		]);
	});

	it("appends env pairs", () => {
		const args = buildPaneSplitArgs({
			direction: "right",
			cwd: "/tmp",
			env: { A: "1", B: "two words" },
		});
		expect(args).toContain("--env");
		expect(args).toContain("A=1");
		expect(args).toContain("B=two words");
	});
});

describe("buildTabCreateArgs", () => {
	it("builds args with workspace, cwd, label and focus", () => {
		expect(
			buildTabCreateArgs({
				workspaceId: "ws-1",
				cwd: "/tmp/proj",
				label: "fork",
			}),
		).toEqual([
			"tab",
			"create",
			"--workspace",
			"ws-1",
			"--cwd",
			"/tmp/proj",
			"--label",
			"fork",
			"--focus",
		]);
	});

	it("omits optional fields", () => {
		expect(buildTabCreateArgs({ workspaceId: "ws-1", cwd: "/tmp" })).toEqual([
			"tab",
			"create",
			"--workspace",
			"ws-1",
			"--cwd",
			"/tmp",
			"--focus",
		]);
	});
});

describe("shellQuote / buildForkCommand", () => {
	it("quotes simple paths", () => {
		expect(shellQuote("/tmp/a b/session.json")).toBe("'/tmp/a b/session.json'");
	});

	it("quotes embedded single quotes", () => {
		expect(shellQuote("/tmp/it's/s.json")).toBe(`'/tmp/it'\\''s/s.json'`);
	});

	it("builds a fork command with a quoted session file", () => {
		expect(buildForkCommand("/tmp/a b/s.json")).toBe(
			"pi --fork '/tmp/a b/s.json'",
		);
	});
});
