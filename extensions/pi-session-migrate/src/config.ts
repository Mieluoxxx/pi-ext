import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export type ThinkingLevelValue = (typeof THINKING_LEVELS)[number];

export type MigrateConfig = {
	/** Claim model as `provider/model`. Empty uses the current session model. */
	model: string;
	/** Thinking level for the claim request. "off" disables reasoning. */
	thinkingLevel: string;
};

export const DEFAULT_CONFIG: MigrateConfig = {
	model: "",
	thinkingLevel: "minimal",
};

export function configPath(): string {
	return join(getAgentDir(), "migrate.json");
}

export function loadConfig(
	path = configPath(),
): { value: MigrateConfig; warnings: string[] } {
	const value: MigrateConfig = { ...DEFAULT_CONFIG };
	const warnings: string[] = [];

	try {
		const content = readFileSync(path, "utf8");
		const parsed = JSON.parse(content) as Record<string, unknown>;

		const model = parsed.model;
		if (model !== undefined) {
			if (typeof model === "string" && (model === "" || model.includes("/"))) {
				value.model = model;
			} else {
				warnings.push(`Ignoring invalid model in ${path}`);
			}
		}

		const thinkingLevel = parsed.thinkingLevel;
		if (thinkingLevel !== undefined) {
			if (
				typeof thinkingLevel === "string" &&
				(THINKING_LEVELS as readonly string[]).includes(thinkingLevel)
			) {
				value.thinkingLevel = thinkingLevel;
			} else {
				warnings.push(`Ignoring invalid thinkingLevel in ${path}`);
			}
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			warnings.push(`Failed to read ${path}: ${(error as Error).message}`);
		}
	}

	return { value, warnings };
}

export function saveConfig(
	patch: Partial<MigrateConfig>,
	path = configPath(),
): void {
	const { value: current } = loadConfig(path);
	const next: MigrateConfig = { ...current, ...patch };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}
