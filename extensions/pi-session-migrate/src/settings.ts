import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig, THINKING_LEVELS, type MigrateConfig } from "./config.js";

async function selectThinkingLevel(
	ctx: ExtensionCommandContext,
	current: string,
): Promise<string | undefined> {
	const options: string[] = [...THINKING_LEVELS];
	if (current && !options.includes(current)) options.push(current);
	return ctx.ui.select("Claim thinking level", options);
}

/**
 * Interactive /migrate settings editor.
 * Uses Pi's built-in dialog UI (`select`) — no custom component.
 */
export async function showSettings(ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/migrate settings requires interactive TUI mode", "error");
		return;
	}

	for (;;) {
		const config = loadConfig().value;
		const choice = await ctx.ui.select("pi-session-migrate settings", [
			`model: ${config.model || "(current session model)"}`,
			`thinkingLevel: ${config.thinkingLevel}`,
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
			const selected = await ctx.ui.select("Claim model", options);
			if (selected === undefined) continue;
			const model = selected === "(current session model)" ? "" : selected;

			const level = await selectThinkingLevel(ctx, config.thinkingLevel);
			const patch: Partial<MigrateConfig> = { model };
			if (level !== undefined) patch.thinkingLevel = level;
			saveConfig(patch);
			ctx.ui.notify(
				`Claim model set to ${model || "(current session model)"} · thinking ${
					patch.thinkingLevel ?? config.thinkingLevel
				}`,
				"info",
			);
		} else if (choice.startsWith("thinkingLevel:")) {
			const level = await selectThinkingLevel(ctx, config.thinkingLevel);
			if (level === undefined) continue;
			saveConfig({ thinkingLevel: level });
			ctx.ui.notify(`Thinking level set to ${level}`, "info");
		}
	}
}
