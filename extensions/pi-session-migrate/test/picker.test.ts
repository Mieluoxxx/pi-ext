import type { KeybindingsManager } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
	SearchableMigratePicker,
	clampMigratePickerIndex,
	clearMigratePickerSearch,
	createMigratePickerState,
	filterMigratePickerItems,
	moveMigratePickerIndex,
	startMigratePickerSearch,
	type MigratePickerItem,
} from "../src/picker.js";

const groups: MigratePickerItem[] = [
	{ oldCwd: "/archive/Legacy-App", sessionCount: 3 },
	{ oldCwd: "/workspaces/pi-ext", sessionCount: 1, marker: "same name" },
	{ oldCwd: "/projects/other-service", sessionCount: 2 },
];

const keybindings = {
	matches(data: string, keybinding: string): boolean {
		return data === keybinding.replace("tui.select.", "");
	},
} as unknown as KeybindingsManager;

const pickerTheme = {
	title: (text: string) => text,
	selected: (text: string) => text,
	muted: (text: string) => text,
	warning: (text: string) => text,
};

function createPicker(onSelect: (item: MigratePickerItem) => void, onCancel: () => void) {
	return new SearchableMigratePicker(groups, keybindings, pickerTheme, onSelect, onCancel);
}

describe("filterMigratePickerItems", () => {
	it("keeps the existing order when the query is empty", () => {
		expect(filterMigratePickerItems(groups, "")).toEqual(groups);
	});

	it("matches paths and project directory names without case sensitivity", () => {
		expect(filterMigratePickerItems(groups, "ARCHIVE")).toEqual([groups[0]]);
		expect(filterMigratePickerItems(groups, "legacy-app")).toEqual([groups[0]]);
	});

	it("returns no groups when the query has no match", () => {
		expect(filterMigratePickerItems(groups, "missing")).toEqual([]);
	});
});

describe("migrate picker state", () => {
	it("enters search mode when slash starts a search", () => {
		expect(startMigratePickerSearch(createMigratePickerState())).toEqual({
			mode: "search",
			query: "",
			selectedIndex: 0,
		});
	});

	it("clears search on the first escape before the next escape cancels", () => {
		expect(
			clearMigratePickerSearch({ mode: "search", query: "legacy", selectedIndex: 2 }),
		).toEqual({ mode: "browse", query: "", selectedIndex: 0 });
	});

	it("clamps and wraps navigation over available matches", () => {
		expect(clampMigratePickerIndex(10, 3)).toBe(2);
		expect(clampMigratePickerIndex(-1, 3)).toBe(0);
		expect(moveMigratePickerIndex(0, 3, -1)).toBe(2);
		expect(moveMigratePickerIndex(2, 3, 1)).toBe(0);
		expect(moveMigratePickerIndex(0, 0, 1)).toBe(0);
	});
});

describe("SearchableMigratePicker", () => {
	it.each(["/", "\x1b[47u"])("filters after %j and selects the highlighted result", (slash) => {
		let selected: MigratePickerItem | undefined;
		const picker = createPicker((item) => {
			selected = item;
		}, () => {});

		picker.handleInput(slash);
		picker.handleInput("l");
		picker.handleInput("e");
		picker.handleInput("g");

		expect(picker.getState()).toMatchObject({ mode: "search", query: "leg" });
		expect(picker.getFilteredItems()).toEqual([groups[0]]);

		picker.handleInput("confirm");
		expect(selected).toEqual(groups[0]);
	});

	it("does not select when a search produces no matches", () => {
		let selected: MigratePickerItem | undefined;
		const picker = createPicker((item) => {
			selected = item;
		}, () => {});

		picker.handleInput("/");
		for (const key of "missing") picker.handleInput(key);
		picker.handleInput("confirm");

		expect(picker.getFilteredItems()).toEqual([]);
		expect(selected).toBeUndefined();
	});

	it("clears search before cancelling on a second escape", () => {
		let cancelled = false;
		const picker = createPicker(() => {}, () => {
			cancelled = true;
		});

		picker.handleInput("/");
		picker.handleInput("l");
		picker.handleInput("cancel");

		expect(picker.getState()).toEqual(createMigratePickerState());
		expect(picker.getFilteredItems()).toEqual(groups);

		picker.handleInput("cancel");
		expect(cancelled).toBe(true);
	});
});
