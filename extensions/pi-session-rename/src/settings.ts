import {
	DynamicBorder,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import {
	THINKING_LEVELS,
	loadConfig,
	saveConfig,
	type RenameConfig,
} from "./config.js";

const CURRENT_SESSION_MODEL = "(current session model)";
export const MODEL_SELECTOR_MAX_VISIBLE = 10;

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

async function selectNamingModel(
	ctx: ExtensionCommandContext,
	options: string[],
): Promise<string | undefined> {
	const items: SelectItem[] = options.map((option) => ({
		value: option,
		label: option,
	}));

	const selected = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Naming model")), 1, 0));

		const selectList = new SelectList(
			items,
			Math.min(items.length, MODEL_SELECTOR_MAX_VISIBLE),
			{
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			},
		);
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);
		container.addChild(selectList);

		container.addChild(
			new Text(theme.fg("dim", "↑↓ navigate  enter select  escape/ctrl+c cancel"), 1, 0),
		);
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});

	return selected ?? undefined;
}

/**
 * Interactive /rename settings editor.
 * Uses a height-limited custom model picker and built-in dialogs for other settings.
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
				CURRENT_SESSION_MODEL,
				...available.map((model) => `${model.provider}/${model.id}`),
			];
			if (config.model && !options.includes(config.model)) {
				options.push(config.model);
			}
			const selected = await selectNamingModel(ctx, options);
			if (selected === undefined) continue;
			const model = selected === CURRENT_SESSION_MODEL ? "" : selected;

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
