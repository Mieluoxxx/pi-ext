import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	THINKING_LEVELS,
	loadConfig,
	saveConfig,
	type RenameConfig,
} from "./config.js";

function parseNonNegativeInt(value: string | undefined): number | null {
	if (value === undefined) return null;
	const trimmed = value.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	const parsed = Number(trimmed);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

async function selectThinkingLevel(
	ctx: ExtensionCommandContext,
	current: string,
): Promise<string | undefined> {
	const options: string[] = [...THINKING_LEVELS];
	if (current && !options.includes(current)) options.push(current);
	return ctx.ui.select("Thinking level", options);
}

/**
 * Interactive /rename settings editor.
 * Uses Pi's built-in dialog UI (`select`, `input`) — no custom component.
 */
export async function showSettings(ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/rename settings requires interactive TUI mode", "error");
		return;
	}

	for (;;) {
		const config = loadConfig().value;
		const choice = await ctx.ui.select("pi-session-rename settings", [
			`model: ${config.model || "(current session model)"}`,
			`thinkingLevel: ${config.thinkingLevel}`,
			`afterSteps: ${config.afterSteps}`,
			"Done",
		]);

		if (!choice || choice === "Done") return;

		if (choice.startsWith("model:")) {
			const available = ctx.modelRegistry.getAvailable();
			const options: string[] = [
				"(current session model)",
				...available.map((model) => `${model.provider}/${model.id}`),
			];
			if (config.model && !options.includes(config.model)) {
				options.push(config.model);
			}
			const selected = await ctx.ui.select("Naming model", options);
			if (selected === undefined) continue;
			const model = selected === "(current session model)" ? "" : selected;

			// After picking the model, immediately choose the thinking level.
			const level = await selectThinkingLevel(ctx, config.thinkingLevel);
			const patch: Partial<RenameConfig> = { model };
			if (level !== undefined) patch.thinkingLevel = level;
			saveConfig(patch);
			ctx.ui.notify(
				`Naming model set to ${
					model || "(current session model)"
				} · thinking ${patch.thinkingLevel ?? config.thinkingLevel}`,
				"info",
			);
		} else if (choice.startsWith("thinkingLevel:")) {
			const level = await selectThinkingLevel(ctx, config.thinkingLevel);
			if (level === undefined) continue;
			saveConfig({ thinkingLevel: level });
			ctx.ui.notify(`Thinking level set to ${level}`, "info");
		} else if (choice.startsWith("afterSteps:")) {
			const value = await ctx.ui.input(
				"Auto-rename after user-agent turns (0 disables)",
				String(config.afterSteps),
			);
			const parsed = parseNonNegativeInt(value);
			if (parsed === null) {
				ctx.ui.notify("afterSteps must be a non-negative integer", "warning");
				continue;
			}
			saveConfig({ afterSteps: parsed });
			ctx.ui.notify(`Auto-rename after ${parsed} user-agent turns`, "info");
		}
	}
}
