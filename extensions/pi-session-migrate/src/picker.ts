import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	Input,
	decodeKittyPrintable,
	type Component,
	type Focusable,
	type KeybindingsManager,
	truncateToWidth,
} from "@earendil-works/pi-tui";

export interface MigratePickerItem {
	oldCwd: string;
	sessionCount: number;
	marker?: string;
}

export type MigratePickerMode = "browse" | "search";

export interface MigratePickerState {
	mode: MigratePickerMode;
	query: string;
	selectedIndex: number;
}

export function createMigratePickerState(): MigratePickerState {
	return { mode: "browse", query: "", selectedIndex: 0 };
}

export function startMigratePickerSearch(state: MigratePickerState): MigratePickerState {
	return { ...state, mode: "search" };
}

export function clearMigratePickerSearch(state: MigratePickerState): MigratePickerState {
	return { mode: "browse", query: "", selectedIndex: 0 };
}

export function clampMigratePickerIndex(index: number, itemCount: number): number {
	if (itemCount <= 0) return 0;
	return Math.max(0, Math.min(index, itemCount - 1));
}

export function moveMigratePickerIndex(index: number, itemCount: number, direction: -1 | 1): number {
	if (itemCount <= 0) return 0;
	return (clampMigratePickerIndex(index, itemCount) + direction + itemCount) % itemCount;
}

export function filterMigratePickerItems<T extends MigratePickerItem>(items: T[], query: string): T[] {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) return items;
	return items.filter((item) => item.oldCwd.toLowerCase().includes(normalizedQuery));
}

export interface MigratePickerTheme {
	title(text: string): string;
	selected(text: string): string;
	muted(text: string): string;
	warning(text: string): string;
}

export class SearchableMigratePicker<T extends MigratePickerItem> implements Component, Focusable {
	private readonly searchInput = new Input();
	private state = createMigratePickerState();
	private filteredItems: T[];
	private isFocused = false;

	get focused(): boolean {
		return this.isFocused;
	}

	set focused(value: boolean) {
		this.isFocused = value;
		this.searchInput.focused = value;
	}

	constructor(
		private readonly items: T[],
		private readonly keybindings: KeybindingsManager,
		private readonly theme: MigratePickerTheme,
		private readonly onSelect: (item: T) => void,
		private readonly onCancel: () => void,
	) {
		this.filteredItems = items;
	}

	getState(): Readonly<MigratePickerState> {
		return this.state;
	}

	getFilteredItems(): readonly T[] {
		return this.filteredItems;
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.state = {
				...this.state,
				selectedIndex: moveMigratePickerIndex(this.state.selectedIndex, this.filteredItems.length, -1),
			};
			return;
		}

		if (this.keybindings.matches(data, "tui.select.down")) {
			this.state = {
				...this.state,
				selectedIndex: moveMigratePickerIndex(this.state.selectedIndex, this.filteredItems.length, 1),
			};
			return;
		}

		if (this.keybindings.matches(data, "tui.select.confirm")) {
			const selected = this.filteredItems[this.state.selectedIndex];
			if (selected) this.onSelect(selected);
			return;
		}

		if (this.keybindings.matches(data, "tui.select.cancel")) {
			if (this.state.mode === "search") {
				this.searchInput.setValue("");
				this.filteredItems = this.items;
				this.state = clearMigratePickerSearch(this.state);
			} else {
				this.onCancel();
			}
			return;
		}

		if (this.state.mode === "browse" && (data === "/" || decodeKittyPrintable(data) === "/")) {
			this.state = startMigratePickerSearch(this.state);
			return;
		}

		if (this.state.mode === "search") {
			this.searchInput.handleInput(data);
			this.state = {
				...this.state,
				query: this.searchInput.getValue(),
				selectedIndex: 0,
			};
			this.filteredItems = filterMigratePickerItems(this.items, this.state.query);
		}
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const lines = [truncateToWidth(this.theme.title("Migrate which old project into this one?"), safeWidth, "")];

		if (this.state.mode === "search") {
			const inputLine = this.searchInput.render(safeWidth)[0] ?? "/ ";
			lines.push(inputLine.startsWith("> ") ? `/ ${inputLine.slice(2)}` : inputLine);
		}

		if (this.filteredItems.length === 0) {
			lines.push(truncateToWidth(this.theme.warning("No matching projects"), safeWidth, ""));
		} else {
			const maxVisible = 8;
			const startIndex = Math.max(
				0,
				Math.min(
					this.state.selectedIndex - Math.floor(maxVisible / 2),
					this.filteredItems.length - maxVisible,
				),
			);
			const endIndex = Math.min(startIndex + maxVisible, this.filteredItems.length);

			for (let index = startIndex; index < endIndex; index += 1) {
				const item = this.filteredItems[index];
				if (!item) continue;
				const prefix = index === this.state.selectedIndex ? "> " : "  ";
				const marker = item.marker ? ` | ${item.marker}` : "";
				const count = `${item.sessionCount} session${item.sessionCount === 1 ? "" : "s"}`;
				const row = `${prefix}${item.oldCwd} | ${count}${marker}`;
				const text = truncateToWidth(row, safeWidth, "");
				lines.push(index === this.state.selectedIndex ? this.theme.selected(text) : text);
			}

			if (startIndex > 0 || endIndex < this.filteredItems.length) {
				lines.push(
					truncateToWidth(
						this.theme.muted(`(${this.state.selectedIndex + 1}/${this.filteredItems.length})`),
						safeWidth,
						"",
					),
				);
			}
		}

		const hint =
			this.state.mode === "search"
				? "up/down navigate | enter select | esc clear search"
				: "up/down navigate | enter select | / search | esc cancel";
		lines.push(truncateToWidth(this.theme.muted(hint), safeWidth, ""));
		return lines;
	}

	invalidate(): void {
		this.searchInput.invalidate();
	}
}

export async function pickSearchableMigrateGroup<T extends MigratePickerItem>(
	items: T[],
	ctx: ExtensionCommandContext,
): Promise<T | undefined> {
	return ctx.ui.custom<T | undefined>((tui, theme, keybindings, done) => {
		const picker = new SearchableMigratePicker(
			items,
			keybindings,
			{
				title: (text) => theme.fg("accent", theme.bold(text)),
				selected: (text) => theme.fg("accent", text),
				muted: (text) => theme.fg("muted", text),
				warning: (text) => theme.fg("warning", text),
			},
			done,
			() => done(undefined),
		);

		return {
			render: (width) => picker.render(width),
			invalidate: () => picker.invalidate(),
			get focused() {
				return picker.focused;
			},
			set focused(value: boolean) {
				picker.focused = value;
			},
			handleInput: (data) => {
				picker.handleInput(data);
				tui.requestRender();
			},
		};
	});
}
