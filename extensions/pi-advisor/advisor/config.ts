/**
 * config — persisted advisor config (~/.config/rpiv-advisor/advisor.json) and
 * the provider:id key codec. Owns the AdvisorConfig shape and load/validate/save.
 * The modelKey (join) / parseModelKey (split) inverse pair the codec relies on
 * lives in ./settings.ts.
 */

import type { GuidanceFields } from "./settings.js";
import { configPath, loadJsonConfigWithLegacyFallback, saveJsonConfig } from "./settings.js";
import { EFFORT_ORDINAL, type GradedEffort } from "./messages.js";

const ADVISOR_CONFIG_PATH = configPath("rpiv-advisor", "advisor.json");

export type DisabledForModelsEntry = string | { model: string; minEffort?: GradedEffort };

export interface AdvisorBudget {
	perCallSoftUsd: number;
	perCallHardUsd: number;
	sessionUsd: number;
	warmWindowSec: number;
	contextBudgetTokens: number;
	onExceed: "confirm" | "skip";
}

export function validateAdvisorBudget(value: unknown): AdvisorBudget {
	const budget: AdvisorBudget = {
		perCallSoftUsd: 1,
		perCallHardUsd: 3,
		sessionUsd: 20,
		warmWindowSec: 1800,
		contextBudgetTokens: 250000,
		onExceed: "confirm",
	};
	if (!value || typeof value !== "object") return budget;
	const raw = value as Record<string, unknown>;
	for (const key of [
		"perCallSoftUsd",
		"perCallHardUsd",
		"sessionUsd",
		"warmWindowSec",
		"contextBudgetTokens",
	] as const) {
		const number = raw[key];
		if (typeof number === "number" && Number.isFinite(number) && number >= 0) budget[key] = number;
	}
	if (raw.onExceed === "skip") budget.onExceed = "skip";
	return budget;
}

export interface AdvisorWarming {
	enabled: boolean;
	ttlSec: number;
	minPromptTokens: number;
	continueProbability: number;
	minSavingsUsd: number;
	maxDurationSec: number;
}

export function validateAdvisorWarming(value: unknown): AdvisorWarming {
	const warming: AdvisorWarming = {
		enabled: true,
		ttlSec: 0,
		minPromptTokens: 100000,
		continueProbability: 0.2,
		minSavingsUsd: 0.05,
		maxDurationSec: 3600,
	};
	if (!value || typeof value !== "object") return warming;
	const raw = value as Record<string, unknown>;
	if (typeof raw.enabled === "boolean") warming.enabled = raw.enabled;
	for (const key of ["ttlSec", "minPromptTokens", "continueProbability", "minSavingsUsd", "maxDurationSec"] as const) {
		const number = raw[key];
		if (typeof number === "number" && Number.isFinite(number) && number >= 0) warming[key] = number;
	}
	warming.continueProbability = Math.min(1, warming.continueProbability);
	return warming;
}

/**
 * How the executor's branch is compiled for the advisor. Older tool rounds
 * become one-line cards; only `tailToolCalls` rounds stay verbatim.
 */
export interface AdvisorLedger {
	tailToolCalls: number;
	tailMaxChars: number;
	userMessageMaxChars: number;
	customPreviewChars: number;
}

export function validateAdvisorLedger(value: unknown): AdvisorLedger {
	const ledger: AdvisorLedger = {
		tailToolCalls: 2,
		tailMaxChars: 8000,
		userMessageMaxChars: 20000,
		customPreviewChars: 500,
	};
	if (!value || typeof value !== "object") return ledger;
	const raw = value as Record<string, unknown>;
	for (const key of ["tailToolCalls", "tailMaxChars", "userMessageMaxChars", "customPreviewChars"] as const) {
		const number = raw[key];
		if (typeof number === "number" && Number.isFinite(number) && number >= 0) ledger[key] = Math.floor(number);
	}
	return ledger;
}

/**
 * The advisor's read-only investigation tools. `maxRounds` bounds how many
 * extra model requests one consultation may spend; every round is priced
 * against the same per-call and branch budgets as the first.
 */
export interface AdvisorTools {
	enabled: boolean;
	maxRounds: number;
	maxResultChars: number;
	repo: boolean;
	denyPatterns: string[];
}

const DEFAULT_DENY_PATTERNS = [".env", ".env.*", "*.pem", "*.key", "id_rsa*", "*.p12", "*.pfx"];

export function validateAdvisorTools(value: unknown): AdvisorTools {
	const tools: AdvisorTools = {
		enabled: true,
		maxRounds: 3,
		maxResultChars: 12000,
		repo: true,
		denyPatterns: [...DEFAULT_DENY_PATTERNS],
	};
	if (!value || typeof value !== "object") return tools;
	const raw = value as Record<string, unknown>;
	if (typeof raw.enabled === "boolean") tools.enabled = raw.enabled;
	if (typeof raw.repo === "boolean") tools.repo = raw.repo;
	for (const key of ["maxRounds", "maxResultChars"] as const) {
		const number = raw[key];
		if (typeof number === "number" && Number.isFinite(number) && number >= 0) tools[key] = Math.floor(number);
	}
	// A configured list REPLACES the defaults so an operator can widen access
	// deliberately; it is never merged, which would make removal impossible.
	if (Array.isArray(raw.denyPatterns) && raw.denyPatterns.every((p) => typeof p === "string"))
		tools.denyPatterns = raw.denyPatterns as string[];
	return tools;
}

interface AdvisorConfig {
	modelKey?: string;
	effort?: GradedEffort;
	guidance?: GuidanceFields;
	disabledForModels?: DisabledForModelsEntry[];
	budget?: Partial<AdvisorBudget>;
	warming?: Partial<AdvisorWarming>;
	ledger?: Partial<AdvisorLedger>;
	tools?: Partial<AdvisorTools>;
}

export function loadAdvisorConfig(): AdvisorConfig {
	return loadJsonConfigWithLegacyFallback<AdvisorConfig>("rpiv-advisor", "advisor.json");
}

export function validateDisabledForModels(value: unknown): DisabledForModelsEntry[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is DisabledForModelsEntry => {
		if (typeof entry === "string") return entry.length > 0;
		if (typeof entry !== "object" || entry === null) return false;
		const obj = entry as Record<string, unknown>;
		if (typeof obj.model !== "string" || obj.model.length === 0) return false;
		if (obj.minEffort !== undefined && !EFFORT_ORDINAL.includes(obj.minEffort as GradedEffort)) {
			// Warn before dropping — the entry's model identity is discarded along
			// with the bad threshold (mirrors models-config's warn-on-miss posture).
			console.warn(
				`[rpiv-advisor] advisor.json: unknown minEffort "${String(obj.minEffort)}" — dropping disabledForModels entry for "${obj.model}"`,
			);
			return false;
		}
		return true;
	});
}

export function saveAdvisorConfig(key: string | undefined, effort: GradedEffort | undefined): boolean {
	const existing = loadAdvisorConfig();
	const config: AdvisorConfig = { ...existing };
	// Delete (rather than omit) to clear fields that may exist in the spread
	// from a prior read. JSON.parse always produces configurable properties,
	// so delete is safe in strict mode.
	if (key) config.modelKey = key;
	else delete config.modelKey;
	if (effort) config.effort = effort;
	else delete config.effort;
	return saveJsonConfig(ADVISOR_CONFIG_PATH, config);
}
