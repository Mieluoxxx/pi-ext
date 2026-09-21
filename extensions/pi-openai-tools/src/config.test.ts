import { afterEach, describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_PATH, loadToolkitConfig } from "./config";
import {
	DEFAULT_COMPACTION_CONFIG,
	DEFAULT_IMAGE_GENERATION_CONFIG,
	DEFAULT_NATIVE_FALLBACK_CONFIG,
} from "./types";

let tempDirs: string[] = [];

function writeTempConfig(content: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-openai-toolkit-config-"));
	tempDirs.push(dir);
	const configPath = path.join(dir, "config.json");
	fs.writeFileSync(configPath, content, "utf8");
	return configPath;
}

afterEach(() => {
	for (const dir of tempDirs) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	tempDirs = [];
});

describe("loadToolkitConfig", () => {
	test("uses the new canonical config path", () => {
		expect(CONFIG_PATH).toBe(
			path.join(os.homedir(), ".pi", "agent", "extensions", "pi-openai-tools", "config.json"),
		);
	});

	test("missing file yields independent defaults without warnings", () => {
		const missingPath = path.join(os.tmpdir(), "pi-openai-toolkit-missing", "config.json");
		const loaded = loadToolkitConfig(missingPath);

		expect(loaded.source).toBeUndefined();
		expect(loaded.warnings).toEqual([]);
		expect(loaded.config.compaction.enabled).toBe(true);
		expect(loaded.config.compaction.allowCompactionContinuityBreak).toBe(false);
		expect(loaded.config.compaction.contextManagement).toBe("off");
		expect(loaded.config.compaction.remoteCompactModel).toBeUndefined();
		expect(loaded.config.compaction.nativeFallback).toEqual({ ...DEFAULT_NATIVE_FALLBACK_CONFIG });
		expect(loaded.config.compaction).not.toHaveProperty("autoCompaction");
		expect(loaded.config.compaction.responsesApis).toEqual([
			...DEFAULT_COMPACTION_CONFIG.responsesApis,
		]);
		expect(loaded.config.compaction.gatewayContextModels).toEqual([]);
		expect(Object.keys(loaded.config).sort()).toEqual(["compaction", "imageGeneration"]);
		expect(loaded.config.imageGeneration).toEqual({ enabled: false, models: ["gpt-image-2.5"] });
		expect(loaded.config.imageGeneration.models).not.toBe(DEFAULT_IMAGE_GENERATION_CONFIG.models);
	});

	test("nested feature sections override defaults", () => {
		const configPath = writeTempConfig(
			JSON.stringify({
				compaction: {
					enabled: true,
					contextManagement: "remote",
					allowCompactionContinuityBreak: true,
					remoteCompactModel: " uwoacrimson/gpt-5.6-luna ",
					nativeFallback: {
						enabled: true,
						model: " google/gemini-2.5-flash ",
						thinkingLevel: "medium",
					},
					responsesApis: ["openai-responses"],
					gatewayContextModels: [" uwoacrimson/gpt-6-astra ", "uwoacrimson/gpt-5.6-luna", "uwoacrimson/gpt-6-astra", ""],
					debug: true,
					notifyOnLoad: true,
					artifactRoot: "~/artifacts/pot",
				},
				imageGeneration: {
					enabled: false,
					models: [" gpt-image-2 ", "grok-imagine-image-2.0", "", "grok-imagine-image-2.0"],
				},
			}),
		);

		const loaded = loadToolkitConfig(configPath);

		expect(loaded.source).toBe(configPath);
		expect(loaded.warnings).toEqual([]);
		expect(loaded.config.compaction.allowCompactionContinuityBreak).toBe(true);
		expect(loaded.config.compaction.contextManagement).toBe("remote");
		expect(loaded.config.compaction).not.toHaveProperty("codexGatewayModels");
		expect(loaded.config.compaction.remoteCompactModel).toBe("uwoacrimson/gpt-5.6-luna");
		expect(loaded.config.compaction.nativeFallback).toEqual({
			enabled: true,
			model: "google/gemini-2.5-flash",
			thinkingLevel: "medium",
		});
		expect(loaded.config.compaction).not.toHaveProperty("autoCompaction");
		expect(loaded.config.compaction.responsesApis).toEqual(["openai-responses"]);
		expect(loaded.config.compaction.gatewayContextModels).toEqual([
			"uwoacrimson/gpt-6-astra",
			"uwoacrimson/gpt-5.6-luna",
		]);
		expect(loaded.config.compaction.debug).toBe(true);
		expect(loaded.config.compaction.notifyOnLoad).toBe(true);
		expect(loaded.config.compaction.contextReminderThresholdPercent).toBe(5);
		expect(loaded.config.compaction.artifactRoot).toBe(path.join(os.homedir(), "artifacts/pot"));
		expect(loaded.config.imageGeneration).toEqual({
			enabled: false,
			models: ["gpt-image-2", "grok-imagine-image-2.0"],
		});
		expect(loaded.config).not.toHaveProperty("codexAstra");
	});

	test("a retired codexAstra section warns as an unknown field without crashing", () => {
		const configPath = writeTempConfig(
			JSON.stringify({
				codexAstra: {
					enabled: true,
					models: ["openai-codex/gpt-6-astra"],
				},
			}),
		);
		const loaded = loadToolkitConfig(configPath);

		expect(loaded.config).not.toHaveProperty("codexAstra");
		expect(loaded.warnings).toContain("Ignoring codexAstra: unknown field.");
	});

	test("contextReminderThresholdPercent accepts 0-100 and ignores out-of-range", () => {
		const configPath = writeTempConfig(
			JSON.stringify({
				compaction: { contextManagement: "remote", contextReminderThresholdPercent: 10 },
			}),
		);
		const loaded = loadToolkitConfig(configPath);
		expect(loaded.config.compaction.contextReminderThresholdPercent).toBe(10);
		expect(loaded.warnings).toEqual([]);

		const disabledPath = writeTempConfig(
			JSON.stringify({
				compaction: { contextManagement: "remote", contextReminderThresholdPercent: 0 },
			}),
		);
		const disabled = loadToolkitConfig(disabledPath);
		expect(disabled.config.compaction.contextReminderThresholdPercent).toBe(0);
		expect(disabled.warnings).toEqual([]);

		const invalidPath = writeTempConfig(
			JSON.stringify({
				compaction: { contextManagement: "remote", contextReminderThresholdPercent: 150 },
			}),
		);
		const invalid = loadToolkitConfig(invalidPath);
		expect(invalid.config.compaction.contextReminderThresholdPercent).toBe(5);
		expect(invalid.warnings).toEqual([
			"Ignoring compaction.contextReminderThresholdPercent: expected an integer between 0 and 100.",
		]);
	});

	test("null model specs preserve the default remote path and clear the fallback spec", () => {
		const configPath = writeTempConfig(
			JSON.stringify({
				compaction: { remoteCompactModel: null, nativeFallback: { model: null } },
			}),
		);
		const loaded = loadToolkitConfig(configPath);

		expect(loaded.config.compaction.remoteCompactModel).toBeUndefined();
		expect(loaded.config.compaction.nativeFallback.model).toBeUndefined();
		expect(loaded.config.compaction.nativeFallback.enabled).toBe(true);
		expect(loaded.warnings).toEqual([]);
	});

	test("invalid fields warn and fall back per field while valid API entries remain", () => {
		const configPath = writeTempConfig(
			JSON.stringify({
				compaction: {
					enabled: "yes",
					allowCompactionContinuityBreak: "yes",
					remoteCompactModel: { provider: "uwoacrimson" },
					nativeFallback: {
						enabled: "yes",
						model: 42,
						thinkingLevel: "ultra",
						futureOption: true,
					},
					responsesApis: ["openai-responses", "anthropic-messages"],
					gatewayContextModels: 42,
					artifactRoot: "",
				},
				imageGeneration: {
					enabled: "yes",
					models: "provider/image-model",
				},
			}),
		);

		const loaded = loadToolkitConfig(configPath);

		expect(loaded.config.compaction.enabled).toBe(true);
		expect(loaded.config.compaction.allowCompactionContinuityBreak).toBe(false);
		expect(loaded.config.compaction.remoteCompactModel).toBeUndefined();
		expect(loaded.config.compaction.nativeFallback).toEqual({ ...DEFAULT_NATIVE_FALLBACK_CONFIG });
		expect(loaded.config.compaction).not.toHaveProperty("autoCompaction");
		expect(loaded.config.compaction.responsesApis).toEqual(["openai-responses"]);
		expect(loaded.config.compaction.gatewayContextModels).toEqual([]);
		expect(loaded.config.imageGeneration).toEqual({ enabled: false, models: ["gpt-image-2.5"] });
		expect(loaded.warnings.length).toBeGreaterThanOrEqual(12);
	});

	test("unknown fields and malformed feature sections warn without changing defaults", () => {
		const configPath = writeTempConfig(
			JSON.stringify({
				legacyEnabled: false,
				compaction: false,
				webSearch: { futureOption: true, apis: ["openai-responses"] },
				imageGeneration: { futureOption: true, apis: ["openai-responses"], model: "openai/gpt-5" },
				autoMode: { futureOption: true, reviewer: "openai/gpt-5" },
			}),
		);
		const loaded = loadToolkitConfig(configPath);

		expect(loaded.config.compaction.enabled).toBe(true);
		expect(loaded.config).not.toHaveProperty("webSearch");
		expect(loaded.config.imageGeneration.enabled).toBe(false);
		expect(loaded.config.imageGeneration.models).toEqual(["gpt-image-2.5"]);
		expect(loaded.config).not.toHaveProperty("autoMode");
		expect(loaded.warnings).toEqual([
			"Ignoring legacyEnabled: unknown field.",
			"Ignoring webSearch: unknown field.",
			"Ignoring autoMode: unknown field.",
			"Ignoring compaction: expected a JSON object.",
			"Ignoring imageGeneration.futureOption: unknown field.",
			"Ignoring imageGeneration.apis: unknown field.",
			"Ignoring imageGeneration.model: unknown field.",
		]);
	});

	test("imageGeneration.models keeps order, normalizes entries, and falls back with warnings", () => {
		const customPath = writeTempConfig(
			JSON.stringify({
				imageGeneration: { enabled: true, models: ["grok-imagine-image-2.0", "gpt-image-2"] },
			}),
		);
		const custom = loadToolkitConfig(customPath);
		expect(custom.warnings).toEqual([]);
		expect(custom.config.imageGeneration).toEqual({
			enabled: true,
			models: ["grok-imagine-image-2.0", "gpt-image-2"],
		});

		const emptyPath = writeTempConfig(JSON.stringify({ imageGeneration: { models: [] } }));
		const empty = loadToolkitConfig(emptyPath);
		expect(empty.config.imageGeneration.models).toEqual(["gpt-image-2.5"]);
		expect(empty.warnings).toEqual([
			"Ignoring imageGeneration.models: expected at least one model id; using gpt-image-2.5.",
		]);

		const blankPath = writeTempConfig(JSON.stringify({ imageGeneration: { models: [" ", "\t"] } }));
		const blank = loadToolkitConfig(blankPath);
		expect(blank.config.imageGeneration.models).toEqual(["gpt-image-2.5"]);
		expect(blank.warnings).toEqual([
			"Ignoring imageGeneration.models: expected at least one model id; using gpt-image-2.5.",
		]);

		const malformedPath = writeTempConfig(
			JSON.stringify({ imageGeneration: { models: ["gpt-image-2", 42] } }),
		);
		const malformed = loadToolkitConfig(malformedPath);
		expect(malformed.config.imageGeneration.models).toEqual(["gpt-image-2.5"]);
		expect(malformed.warnings).toEqual([
			"Ignoring imageGeneration.models: expected a string array.",
		]);

		const oversizedPath = writeTempConfig(
			JSON.stringify({
				imageGeneration: { models: ["x".repeat(257), "grok-imagine-image-2.0"] },
			}),
		);
		const oversized = loadToolkitConfig(oversizedPath);
		expect(oversized.config.imageGeneration.models).toEqual(["gpt-image-2.5"]);
		expect(oversized.warnings).toEqual([
			"Ignoring imageGeneration.models: each model id must be at most 256 characters.",
		]);
	});

	test("legacy flat configuration is not treated as a runtime fallback", () => {
		const configPath = writeTempConfig(
			JSON.stringify({
				enabled: false,
				compactionModel: "google/gemini-2.5-flash",
				artifactRoot: "legacy-artifacts",
			}),
		);
		const loaded = loadToolkitConfig(configPath);

		expect(loaded.config.compaction.enabled).toBe(true);
		expect(loaded.config.compaction.nativeFallback.model).toBeUndefined();
		expect(loaded.config.compaction.artifactRoot).toContain(
			path.join(".pi", "agent", "artifacts", "pi-openai-toolkit", "compaction"),
		);
		expect(loaded.warnings).toHaveLength(3);
	});

	test("malformed JSON warns and yields defaults", () => {
		const configPath = writeTempConfig("{ not json");
		const loaded = loadToolkitConfig(configPath);

		expect(loaded.source).toBeUndefined();
		expect(loaded.warnings).toHaveLength(1);
		expect(loaded.config.compaction.enabled).toBe(true);
		expect(loaded.config).not.toHaveProperty("webSearch");
		expect(loaded.config.imageGeneration.enabled).toBe(false);
		expect(loaded.config).not.toHaveProperty("autoMode");
	});

	test("contextManagement accepts only trimmed off/remote values and warns for local/tree/invalid values", () => {
		const remotePath = writeTempConfig(JSON.stringify({ compaction: { contextManagement: " remote " } }));
		expect(loadToolkitConfig(remotePath).config.compaction.contextManagement).toBe("remote");

		const invalidPath = writeTempConfig(JSON.stringify({ compaction: { contextManagement: "local" } }));
		const invalid = loadToolkitConfig(invalidPath);
		expect(invalid.config.compaction.contextManagement).toBe("off");
		expect(invalid.warnings).toEqual([
			"Ignoring compaction.contextManagement: expected one of off, remote.",
		]);
	});

	test("contextManagement does not rewrite the config file", () => {
		const content = JSON.stringify({ compaction: { contextManagement: "tree" } });
		const configPath = writeTempConfig(content);
		loadToolkitConfig(configPath);
		expect(fs.readFileSync(configPath, "utf8")).toBe(content);
	});

	test("relative artifactRoot resolves against the config directory", () => {
		const configPath = writeTempConfig(
			JSON.stringify({ compaction: { artifactRoot: "artifacts" } }),
		);
		const loaded = loadToolkitConfig(configPath);

		expect(loaded.config.compaction.artifactRoot).toBe(
			path.resolve(path.dirname(configPath), "artifacts"),
		);
	});
});

test("retired autoCompaction configuration is ignored without rewriting user settings", () => {
	const content = JSON.stringify({ compaction: { autoCompaction: { enabled: true, continuation: "followUp", reserveTokens: 0 } } });
	const configPath = writeTempConfig(content);
	const loaded = loadToolkitConfig(configPath);
	expect(loaded.config.compaction).not.toHaveProperty("autoCompaction");
	expect(loaded.warnings).toEqual(["Ignoring compaction.autoCompaction: unknown field."]);
	expect(fs.readFileSync(configPath, "utf8")).toBe(content);
});
