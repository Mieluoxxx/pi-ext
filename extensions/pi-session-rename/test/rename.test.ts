import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "../src/config.js";
import {
	appendDebugLog,
	getEmptyNameReason,
	isDebugEnabled,
	summarizeNamingResponse,
} from "../src/debug.js";
import {
	buildNamingOptions,
	extractSessionName,
	getRenameArgumentCompletions,
	parseModelRef,
	parseRenameCommand,
	resolveThinkingLevel,
	sanitizeName,
	shouldApplyAutoName,
	stripQuotes,
} from "../src/rename.js";
import { showSettings } from "../src/settings.js";

describe("parseRenameCommand", () => {
	it("parses bare /rename as generate", () => {
		expect(parseRenameCommand("")).toEqual({ kind: "generate" });
		expect(parseRenameCommand("   ")).toEqual({ kind: "generate" });
	});

	it("keeps settings as the only subcommand", () => {
		expect(parseRenameCommand("settings")).toEqual({ kind: "settings" });
		expect(parseRenameCommand("  settings  ")).toEqual({ kind: "settings" });
	});

	it("parses /rename \"<name>\" as set-name", () => {
		expect(parseRenameCommand('"Billing schema migration"')).toEqual({
			kind: "set-name",
			name: "Billing schema migration",
		});
	});

	it("parses unquoted names as set-name", () => {
		expect(parseRenameCommand("My Session")).toEqual({
			kind: "set-name",
			name: "My Session",
		});
	});

	it("treats former subcommands as literal manual names", () => {
		for (const name of [
			"auto",
			"config",
			"model",
			"model anthropic/claude-haiku-4-5",
		]) {
			expect(parseRenameCommand(name)).toEqual({ kind: "set-name", name });
		}
	});

	it("allows the reserved settings word as a quoted manual name", () => {
		expect(parseRenameCommand('"settings"')).toEqual({
			kind: "set-name",
			name: "settings",
		});
	});
});

describe("getRenameArgumentCompletions", () => {
	it("completes the settings subcommand", () => {
		const settingsCompletion = {
			value: "settings",
			label: "settings",
			description: "Open session rename settings",
		};
		expect(getRenameArgumentCompletions("")).toEqual([settingsCompletion]);
		expect(getRenameArgumentCompletions("set")).toEqual([settingsCompletion]);
	});

	it("returns null for a manual session name", () => {
		expect(getRenameArgumentCompletions("release")).toBeNull();
	});
});

describe("showSettings", () => {
	it("shows model controls without a prompt editor", async () => {
		const menus: string[][] = [];
		await showSettings({
			mode: "tui",
			ui: {
				notify: () => undefined,
				select: async (_title: string, options: string[]) => {
					menus.push(options);
					return "Done";
				},
			},
		} as any);

		const [menu = []] = menus;
		expect(menu.some((item) => item.startsWith("model:"))).toBe(true);
		expect(menu.some((item) => item.startsWith("thinkingLevel:"))).toBe(true);
		expect(menu.some((item) => item.startsWith("afterSteps:"))).toBe(true);
		expect(menu).toContain("Done");
		expect(menu.some((item) => item.startsWith("prompt:"))).toBe(false);
	});
});

describe("stripQuotes", () => {
	it("strips matching double quotes", () => {
		expect(stripQuotes('"abc"')).toBe("abc");
		expect(stripQuotes('"a b c"')).toBe("a b c");
	});

	it("strips matching single quotes", () => {
		expect(stripQuotes("'abc'")).toBe("abc");
	});

	it("leaves unbalanced quotes and plain text alone", () => {
		expect(stripQuotes("abc")).toBe("abc");
		expect(stripQuotes('"abc')).toBe('"abc');
		expect(stripQuotes('a"b"c')).toBe('a"b"c');
	});

	it("trims surrounding whitespace", () => {
		expect(stripQuotes('  "abc"  ')).toBe("abc");
	});
});

describe("sanitizeName", () => {
	it("returns the first non-empty line with collapsed whitespace", () => {
		expect(sanitizeName("  Refactor   auth  ")).toBe("Refactor auth");
	});

	it("drops trailing lines", () => {
		expect(sanitizeName("Fix login test\nHere is the reasoning")).toBe("Fix login test");
	});

	it("truncates to 80 characters", () => {
		const long = "x".repeat(100);
		expect(sanitizeName(long)?.length).toBe(80);
	});

	it("returns undefined for empty input", () => {
		expect(sanitizeName("   ")).toBeUndefined();
		expect(sanitizeName("")).toBeUndefined();
	});
});

describe("extractSessionName", () => {
	it("extracts a tagged session name", () => {
		expect(extractSessionName("<session_name>Fix auth middleware</session_name>")).toBe(
			"Fix auth middleware",
		);
	});

	it("ignores text outside the first session-name tag", () => {
		expect(
			extractSessionName(
				"Explanation before <session_name>Billing schema migration</session_name> after",
			),
		).toBe("Billing schema migration");
	});

	it("does not fall back to untagged text", () => {
		expect(extractSessionName("Billing schema migration")).toBeUndefined();
	});

	it("rejects an empty tag", () => {
		expect(extractSessionName("<session_name>  \n </session_name>")).toBeUndefined();
	});

	it("collapses multiline tag content", () => {
		expect(
			extractSessionName("<session_name>Fix auth\n  middleware tests</session_name>"),
		).toBe("Fix auth middleware tests");
	});

	it("limits generated names to fewer than 20 words", () => {
		const words = Array.from({ length: 24 }, (_, index) => `w${index + 1}`);
		const name = extractSessionName(`<session_name>${words.join(" ")}</session_name>`);
		expect(name?.split(/\s+/)).toHaveLength(19);
		expect(name).toBe(words.slice(0, 19).join(" "));
	});
});

describe("naming response diagnostics", () => {
	it("summarizes normal text output", () => {
		const summary = summarizeNamingResponse({
			stopReason: "stop",
			content: [{ type: "text", text: "Billing schema migration" }],
			usage: { input: 12, output: 4, totalTokens: 16 },
		});

		expect(summary.contentBlockTypes).toEqual(["text"]);
		expect(summary.textBlockCount).toBe(1);
		expect(summary.textCharacters).toBe(24);
		expect(summary.textPreview).toBe("Billing schema migration");
		expect(summary.usage).toEqual({ input: 12, output: 4, totalTokens: 16 });
	});

	it("distinguishes whitespace-only text", () => {
		const summary = summarizeNamingResponse({
			stopReason: "stop",
			content: [{ type: "text", text: " \n\t" }],
		});

		expect(summary.textBlockCount).toBe(1);
		expect(summary.textCharacters).toBe(3);
		expect(summary.textPreview).toBe("");
		expect(getEmptyNameReason(" \n\t", summary.textBlockCount)).toBe(
			"text-whitespace-only",
		);
	});

	it("distinguishes thinking-only output", () => {
		const summary = summarizeNamingResponse({
			stopReason: "stop",
			content: [{ type: "thinking", thinking: "I should name this session" }],
		});

		expect(summary.contentBlockTypes).toEqual(["thinking"]);
		expect(summary.textBlockCount).toBe(0);
		expect(summary.thinkingCharacters).toBe(26);
		expect(getEmptyNameReason("", summary.textBlockCount)).toBe("no-text-block");
	});

	it("distinguishes missing and empty session-name tags", () => {
		expect(getEmptyNameReason("Billing schema migration", 1)).toBe(
			"missing-session-name-tag",
		);
		expect(getEmptyNameReason("<session_name> \n </session_name>", 1)).toBe(
			"empty-session-name-tag",
		);
	});


	it("preserves error and length stop reasons", () => {
		expect(
			summarizeNamingResponse({
				stopReason: "error",
				errorMessage: "provider failed",
				content: [],
			}),
		).toMatchObject({ stopReason: "error", errorMessage: "provider failed" });
		expect(
			summarizeNamingResponse({ stopReason: "length", content: [] }),
		).toMatchObject({ stopReason: "length", contentBlockTypes: [] });
	});
});

describe("debug logging", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("is disabled unless PI_SESSION_RENAME_DEBUG is enabled", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-session-rename-debug-"));
		dirs.push(dir);
		expect(isDebugEnabled({})).toBe(false);
		expect(appendDebugLog(dir, "response", { stopReason: "stop" }, {})).toBeUndefined();
	});

	it("appends structured records to the current directory log", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-session-rename-debug-"));
		dirs.push(dir);
		const path = appendDebugLog(
			dir,
			"empty-name",
			{ reason: "no-text-block", textCharacters: 0 },
			{ PI_SESSION_RENAME_DEBUG: "1" },
		);

		expect(path).toBe(join(dir, "debug.log"));
		const record = JSON.parse(readFileSync(path!, "utf8")) as Record<string, unknown>;
		expect(record.event).toBe("empty-name");
		expect(record.reason).toBe("no-text-block");
	});
});

describe("parseModelRef", () => {
	it("parses provider/model", () => {
		expect(parseModelRef("anthropic/claude-haiku-4-5")).toEqual({
			provider: "anthropic",
			id: "claude-haiku-4-5",
		});
	});

	it("trims surrounding whitespace", () => {
		expect(parseModelRef("  openai/gpt-4o-mini  ")).toEqual({
			provider: "openai",
			id: "gpt-4o-mini",
		});
	});

	it("rejects refs without a valid slash", () => {
		expect(parseModelRef("anthropic")).toBeNull();
		expect(parseModelRef("/claude")).toBeNull();
		expect(parseModelRef("anthropic/")).toBeNull();
		expect(parseModelRef("")).toBeNull();
	});
});

describe("shouldApplyAutoName", () => {
	it("applies when the session epoch is unchanged and the name is still unset", () => {
		expect(shouldApplyAutoName(1, 1, undefined)).toBe(true);
	});

	it("skips when the session was replaced during generation", () => {
		expect(shouldApplyAutoName(1, 2, undefined)).toBe(false);
	});

	it("skips when a name was set while generation was pending", () => {
		expect(shouldApplyAutoName(1, 1, "Manually set")).toBe(false);
	});
});

describe("resolveThinkingLevel", () => {
	it("maps valid levels", () => {
		expect(resolveThinkingLevel("minimal")).toBe("minimal");
		expect(resolveThinkingLevel("high")).toBe("high");
		expect(resolveThinkingLevel("max")).toBe("max");
	});

	it("returns undefined for off and empty", () => {
		expect(resolveThinkingLevel("off")).toBeUndefined();
		expect(resolveThinkingLevel("")).toBeUndefined();
		expect(resolveThinkingLevel("  ")).toBeUndefined();
	});

	it("returns undefined for unknown values", () => {
		expect(resolveThinkingLevel("ultra")).toBeUndefined();
	});

	it("trims surrounding whitespace", () => {
		expect(resolveThinkingLevel("  minimal  ")).toBe("minimal");
	});
});

describe("buildNamingOptions", () => {
	it("sets a wall-clock timeout without setting maxTokens", () => {
		const options = buildNamingOptions({ sessionId: "session-1" }, "off");
		expect(options).toMatchObject({ sessionId: "session-1", timeoutMs: 60_000 });
		expect(options).not.toHaveProperty("maxTokens");
		expect(options).not.toHaveProperty("reasoning");
	});

	it("preserves the configured thinking level", () => {
		const options = buildNamingOptions({}, "high");
		expect(options.reasoning).toBe("high");
		expect(options).not.toHaveProperty("maxTokens");
	});
});

describe("config", () => {
	const dirs: string[] = [];

	function tempConfig(contents?: string): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-session-rename-test-"));
		dirs.push(dir);
		const path = join(dir, "rename.json");
		if (contents !== undefined) writeFileSync(path, contents, "utf8");
		return path;
	}

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns defaults without warnings when the config file is missing", () => {
		const path = tempConfig();
		const { value, warnings } = loadConfig(path);
		expect(value).toEqual(DEFAULT_CONFIG);
		expect(warnings).toEqual([]);
	});

	it("merges partial config over defaults", () => {
		const path = tempConfig(JSON.stringify({ afterSteps: 1, model: "openai/gpt-4o-mini" }));
		const { value, warnings } = loadConfig(path);
		expect(value.afterSteps).toBe(1);
		expect(value.model).toBe("openai/gpt-4o-mini");
		expect(value.thinkingLevel).toBe(DEFAULT_CONFIG.thinkingLevel);
		expect(warnings).toEqual([]);
	});

	it("silently drops legacy afterTokens and prompt fields when saving", () => {
		const path = tempConfig(
			JSON.stringify({ afterSteps: 1, afterTokens: 999, prompt: "Old custom prompt" }),
		);
		const { value, warnings } = loadConfig(path);

		expect(value).not.toHaveProperty("afterTokens");
		expect(value).not.toHaveProperty("prompt");
		expect(warnings).toEqual([]);

		saveConfig({ model: "openai/gpt-4o-mini" }, path);
		const saved = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		expect(saved).not.toHaveProperty("afterTokens");
		expect(saved).not.toHaveProperty("prompt");
	});
	it("loads a custom thinkingLevel", () => {
		const path = tempConfig(JSON.stringify({ thinkingLevel: "high" }));
		const { value, warnings } = loadConfig(path);
		expect(value.thinkingLevel).toBe("high");
		expect(warnings).toEqual([]);
	});

	it("reports invalid thinkingLevel as a warning and keeps the default", () => {
		const path = tempConfig(JSON.stringify({ thinkingLevel: "ultra" }));
		const { value, warnings } = loadConfig(path);
		expect(value.thinkingLevel).toBe(DEFAULT_CONFIG.thinkingLevel);
		expect(warnings.length).toBe(1);
	});

	it("reports invalid values as warnings and keeps defaults", () => {
		const path = tempConfig(JSON.stringify({ afterSteps: -1, model: 42 }));
		const { value, warnings } = loadConfig(path);
		expect(value.afterSteps).toBe(DEFAULT_CONFIG.afterSteps);
		expect(value.model).toBe(DEFAULT_CONFIG.model);
		expect(warnings.length).toBe(2);
	});

	it("saveConfig writes merged values back", () => {
		const path = tempConfig(JSON.stringify({ afterSteps: 1 }));
		saveConfig({ model: "openai/gpt-4o-mini" }, path);
		const { value } = loadConfig(path);
		expect(value.afterSteps).toBe(1);
		expect(value.model).toBe("openai/gpt-4o-mini");
	});
});
