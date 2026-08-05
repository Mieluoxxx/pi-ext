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

export type RenameConfig = {
	/** User-agent turns before auto-renaming an unnamed session. 0 disables. */
	afterSteps: number;
	/** Naming model as `provider/model`. Empty uses the current session model. */
	model: string;
	/** Thinking level for the naming request. "off" disables reasoning. */
	thinkingLevel: string;
};

export const DEFAULT_CONFIG: RenameConfig = {
	afterSteps: 3,
	model: "",
	thinkingLevel: "minimal",
};

export function configPath(): string {
	return join(getAgentDir(), "rename.json");
}

export function loadConfig(
	path = configPath(),
): { value: RenameConfig; warnings: string[] } {
	const value: RenameConfig = { ...DEFAULT_CONFIG };
	const warnings: string[] = [];

	try {
		const content = readFileSync(path, "utf8");
		const parsed = JSON.parse(content) as Record<string, unknown>;

		const afterSteps = parsed.afterSteps;
		if (afterSteps !== undefined) {
			if (typeof afterSteps === "number" && Number.isFinite(afterSteps) && afterSteps >= 0) {
				value.afterSteps = Math.floor(afterSteps);
			} else {
				warnings.push(`Ignored invalid afterSteps: ${JSON.stringify(afterSteps)}`);
			}
		}

		const model = parsed.model;
		if (model !== undefined) {
			if (typeof model === "string") {
				value.model = model.trim();
			} else {
				warnings.push(`Ignored invalid model: ${JSON.stringify(model)}`);
			}
		}

		const thinkingLevel = parsed.thinkingLevel;
		if (thinkingLevel !== undefined) {
			if (
				typeof thinkingLevel === "string" &&
				(THINKING_LEVELS as readonly string[]).includes(thinkingLevel.trim())
			) {
				value.thinkingLevel = thinkingLevel.trim();
			} else {
				warnings.push(
					`Ignored invalid thinkingLevel: ${JSON.stringify(thinkingLevel)}`,
				);
			}
		}
	} catch (error) {
		// A missing config file is normal on first run — use defaults silently.
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
			return { value, warnings };
		}
		warnings.push(
			`Ignored unreadable config: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}

	return { value, warnings };
}

export function saveConfig(
	patch: Partial<RenameConfig>,
	path = configPath(),
): void {
	const { value } = loadConfig(path);
	const next = { ...value, ...patch };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}
