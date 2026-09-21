import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	DEFAULT_COMPACTION_CONFIG,
	DEFAULT_TOOLKIT_CONFIG,
	DEFAULT_IMAGE_GENERATION_CONFIG,
	DEFAULT_IMAGE_GENERATION_MODEL,
	DEFAULT_NATIVE_FALLBACK_CONFIG,
	RESPONSES_COMPACT_CAPABLE_APIS,
	THINKING_LEVELS,
	type CompactionConfig,
	type ContextManagementMode,
	type ImageGenerationConfig,
	type LoadedToolkitConfig,
	type NativeFallbackConfig,
	type ToolkitConfig,
} from "./types";
import { MAX_IMAGE_MODEL_ID_CHARS } from "./image-generation/types";

export const CONFIG_DIR = path.join(os.homedir(), ".pi", "agent", "extensions", "pi-openai-tools");
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

const TOP_LEVEL_FIELDS = new Set(["compaction", "imageGeneration"]);
const COMPACTION_FIELDS = new Set([
	"enabled",
	"contextManagement",
	"allowCompactionContinuityBreak",
	"remoteCompactModel",
	"nativeFallback",
	"responsesApis",
	"gatewayContextModels",
	"contextReminderThresholdPercent",
	"notifyOnLoad",
	"debug",
	"logProviderPayloads",
	"logCompactResponses",
	"redactSensitiveData",
	"artifactRoot",
]);
const NATIVE_FALLBACK_FIELDS = new Set(["enabled", "model", "thinkingLevel"]);
const IMAGE_GENERATION_FIELDS = new Set(["enabled", "models"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isFile(filePath: string): boolean {
	try {
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}

function readJsonObject(filePath: string, warnings: string[]): Record<string, unknown> | undefined {
	if (!isFile(filePath)) return undefined;

	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
		if (isRecord(parsed)) return parsed;
		warnings.push(`Ignoring ${filePath}: expected a JSON object at the top level.`);
		return undefined;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		warnings.push(`Ignoring ${filePath}: ${message}`);
		return undefined;
	}
}

function resolveConfiguredPath(rawPath: string, baseDir: string): string {
	if (rawPath.startsWith("~/")) {
		return path.join(os.homedir(), rawPath.slice(2));
	}
	if (path.isAbsolute(rawPath)) {
		return path.resolve(rawPath);
	}
	return path.resolve(baseDir, rawPath);
}

function warnUnknownFields(
	value: Record<string, unknown>,
	knownFields: ReadonlySet<string>,
	fieldPath: string,
	warnings: string[],
): void {
	for (const key of Object.keys(value)) {
		if (!knownFields.has(key)) {
			warnings.push(`Ignoring ${fieldPath ? `${fieldPath}.` : ""}${key}: unknown field.`);
		}
	}
}

function toBoolean(value: unknown, fieldPath: string, warnings: string[]): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "boolean") return value;
	warnings.push(`Ignoring ${fieldPath}: expected a boolean.`);
	return undefined;
}

function toContextManagementMode(
	value: unknown,
	fieldPath: string,
	warnings: string[],
): ContextManagementMode | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") {
		const normalized = value.trim();
		if (normalized === "off" || normalized === "remote") return normalized;
	}
	warnings.push(`Ignoring ${fieldPath}: expected one of off, remote.`);
	return undefined;
}

function toModelSpec(value: unknown, fieldPath: string, warnings: string[]): string | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (typeof value === "string" && value.trim().length > 0) {
		return value.trim();
	}
	warnings.push(`Ignoring ${fieldPath}: expected "provider/model-id" or null.`);
	return undefined;
}

function toThinkingLevel(value: unknown, fieldPath: string, warnings: string[]): ThinkingLevel | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)) {
		return value as ThinkingLevel;
	}
	warnings.push(`Ignoring ${fieldPath}: expected one of ${THINKING_LEVELS.join(", ")}.`);
	return undefined;
}

function toBoundedInteger(
	value: unknown,
	fieldPath: string,
	warnings: string[],
	min: number,
	max: number,
): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number" && Number.isInteger(value) && Number.isFinite(value) && value >= min && value <= max) {
		return value;
	}
	warnings.push(`Ignoring ${fieldPath}: expected an integer between ${min} and ${max}.`);
	return undefined;
}

function toSupportedApis(
	value: unknown,
	fieldPath: string,
	capableApis: readonly string[],
	warnings: string[],
): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		warnings.push(`Ignoring ${fieldPath}: expected a string array.`);
		return undefined;
	}

	const capable = new Set(capableApis);
	const accepted: string[] = [];
	for (const item of new Set(value.map((entry) => entry.trim()).filter(Boolean))) {
		if (capable.has(item)) {
			accepted.push(item);
		} else {
			warnings.push(
				`Ignoring ${fieldPath} entry "${item}": only ${capableApis.join(", ")} are supported.`,
			);
		}
	}

	return accepted;
}

function toStringList(value: unknown, fieldPath: string, warnings: string[]): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		warnings.push(`Ignoring ${fieldPath}: expected a string array.`);
		return undefined;
	}

	return [...new Set(value.map((entry) => entry.trim()).filter(Boolean))];
}

function toImageGenerationModels(value: unknown, fieldPath: string, warnings: string[]): string[] | undefined {
	const models = toStringList(value, fieldPath, warnings);
	if (models === undefined) return undefined;
	if (models.some((model) => model.length > MAX_IMAGE_MODEL_ID_CHARS)) {
		warnings.push(
			`Ignoring ${fieldPath}: each model id must be at most ${MAX_IMAGE_MODEL_ID_CHARS} characters.`,
		);
		return undefined;
	}
	return models;
}

function cloneDefaults(): ToolkitConfig {
	return {
		compaction: {
			...DEFAULT_COMPACTION_CONFIG,
			nativeFallback: { ...DEFAULT_NATIVE_FALLBACK_CONFIG },
			responsesApis: [...DEFAULT_COMPACTION_CONFIG.responsesApis],
		},
		imageGeneration: {
			...DEFAULT_IMAGE_GENERATION_CONFIG,
			models: [...DEFAULT_IMAGE_GENERATION_CONFIG.models],
		},
	};
}

function applyNativeFallbackConfig(
	raw: Record<string, unknown>,
	resolved: NativeFallbackConfig,
	warnings: string[],
): void {
	warnUnknownFields(raw, NATIVE_FALLBACK_FIELDS, "compaction.nativeFallback", warnings);
	resolved.enabled =
		toBoolean(raw.enabled, "compaction.nativeFallback.enabled", warnings) ?? resolved.enabled;

	const modelSpec = toModelSpec(raw.model, "compaction.nativeFallback.model", warnings);
	if (modelSpec !== undefined) {
		resolved.model = modelSpec === null ? undefined : modelSpec;
	}

	resolved.thinkingLevel =
		toThinkingLevel(raw.thinkingLevel, "compaction.nativeFallback.thinkingLevel", warnings) ??
		resolved.thinkingLevel;
}

function applyCompactionConfig(
	raw: Record<string, unknown>,
	resolved: CompactionConfig,
	warnings: string[],
): void {
	warnUnknownFields(raw, COMPACTION_FIELDS, "compaction", warnings);

	resolved.enabled = toBoolean(raw.enabled, "compaction.enabled", warnings) ?? resolved.enabled;
	resolved.contextManagement =
		toContextManagementMode(raw.contextManagement, "compaction.contextManagement", warnings) ??
		resolved.contextManagement;
	resolved.allowCompactionContinuityBreak =
		toBoolean(
			raw.allowCompactionContinuityBreak,
			"compaction.allowCompactionContinuityBreak",
			warnings,
		) ?? resolved.allowCompactionContinuityBreak;
	resolved.notifyOnLoad =
		toBoolean(raw.notifyOnLoad, "compaction.notifyOnLoad", warnings) ?? resolved.notifyOnLoad;
	const reminderPercent = toBoundedInteger(
		raw.contextReminderThresholdPercent,
		"compaction.contextReminderThresholdPercent",
		warnings,
		0,
		100,
	);
	if (reminderPercent !== undefined) {
		resolved.contextReminderThresholdPercent = reminderPercent;
	}
	resolved.debug = toBoolean(raw.debug, "compaction.debug", warnings) ?? resolved.debug;
	resolved.logProviderPayloads =
		toBoolean(raw.logProviderPayloads, "compaction.logProviderPayloads", warnings) ??
		resolved.logProviderPayloads;
	resolved.logCompactResponses =
		toBoolean(raw.logCompactResponses, "compaction.logCompactResponses", warnings) ??
		resolved.logCompactResponses;
	resolved.redactSensitiveData =
		toBoolean(raw.redactSensitiveData, "compaction.redactSensitiveData", warnings) ??
		resolved.redactSensitiveData;

	const remoteCompactModelSpec = toModelSpec(
		raw.remoteCompactModel,
		"compaction.remoteCompactModel",
		warnings,
	);
	if (remoteCompactModelSpec !== undefined) {
		resolved.remoteCompactModel = remoteCompactModelSpec === null ? undefined : remoteCompactModelSpec;
	}

	if (raw.nativeFallback !== undefined) {
		if (isRecord(raw.nativeFallback)) {
			applyNativeFallbackConfig(raw.nativeFallback, resolved.nativeFallback, warnings);
		} else {
			warnings.push("Ignoring compaction.nativeFallback: expected a JSON object.");
		}
	}

	const apis = toSupportedApis(
		raw.responsesApis,
		"compaction.responsesApis",
		RESPONSES_COMPACT_CAPABLE_APIS,
		warnings,
	);
	if (apis !== undefined) {
		resolved.responsesApis = apis;
	}

	const gatewayContextModels = toStringList(
		raw.gatewayContextModels,
		"compaction.gatewayContextModels",
		warnings,
	);
	if (gatewayContextModels !== undefined) {
		resolved.gatewayContextModels = gatewayContextModels;
	}

	if (typeof raw.artifactRoot === "string" && raw.artifactRoot.trim().length > 0) {
		resolved.artifactRoot = raw.artifactRoot.trim();
	} else if (raw.artifactRoot !== undefined) {
		warnings.push("Ignoring compaction.artifactRoot: expected a non-empty string.");
	}
}

function applyImageGenerationConfig(
	raw: Record<string, unknown>,
	resolved: ImageGenerationConfig,
	warnings: string[],
): void {
	warnUnknownFields(raw, IMAGE_GENERATION_FIELDS, "imageGeneration", warnings);
	resolved.enabled =
		toBoolean(raw.enabled, "imageGeneration.enabled", warnings) ?? resolved.enabled;

	const models = toImageGenerationModels(raw.models, "imageGeneration.models", warnings);
	if (models !== undefined) {
		// An empty or blank-only list cannot express a default, so keep the shipped model.
		if (models.length === 0) {
			warnings.push(
				`Ignoring imageGeneration.models: expected at least one model id; using ${DEFAULT_IMAGE_GENERATION_MODEL}.`,
			);
		} else {
			resolved.models = models;
		}
	}
}

/**
 * Load the canonical toolkit config from
 * `~/.pi/agent/extensions/pi-openai-tools/config.json`.
 * A missing file silently yields defaults; legacy branded paths are never read.
 */
export function loadToolkitConfig(configPath: string = CONFIG_PATH): LoadedToolkitConfig {
	const warnings: string[] = [];
	const resolved = cloneDefaults();
	let source: string | undefined;

	const raw = readJsonObject(configPath, warnings);
	if (raw) {
		source = configPath;
		warnUnknownFields(raw, TOP_LEVEL_FIELDS, "", warnings);

		if (raw.compaction !== undefined) {
			if (isRecord(raw.compaction)) {
				applyCompactionConfig(raw.compaction, resolved.compaction, warnings);
			} else {
				warnings.push("Ignoring compaction: expected a JSON object.");
			}
		}

		if (raw.imageGeneration !== undefined) {
			if (isRecord(raw.imageGeneration)) {
				applyImageGenerationConfig(raw.imageGeneration, resolved.imageGeneration, warnings);
			} else {
				warnings.push("Ignoring imageGeneration: expected a JSON object.");
			}
		}

	}

	resolved.compaction.artifactRoot = resolveConfiguredPath(
		resolved.compaction.artifactRoot,
		path.dirname(configPath),
	);

	return {
		config: resolved,
		source,
		warnings,
	};
}

export { DEFAULT_TOOLKIT_CONFIG };
