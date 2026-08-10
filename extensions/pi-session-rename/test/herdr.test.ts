import { describe, expect, it } from "vitest";
import {
	extractTabId,
	extractTabInfo,
	isDefaultHerdrTabLabel,
	isHerdrPaneAvailable,
} from "../src/herdr.js";

describe("isHerdrPaneAvailable", () => {
	it("is false without HERDR_PANE_ID", () => {
		expect(isHerdrPaneAvailable({})).toBe(false);
	});

	it("is true with a pane id", () => {
		expect(isHerdrPaneAvailable({ HERDR_PANE_ID: "w12:p1" })).toBe(true);
	});

	it("ignores blank pane ids", () => {
		expect(isHerdrPaneAvailable({ HERDR_PANE_ID: "  " })).toBe(false);
	});
});

describe("extractTabId", () => {
	function paneOutput(tabId: unknown): string {
		return JSON.stringify({ result: { pane: { tab_id: tabId } } });
	}

	it("extracts the tab id from pane output", () => {
		expect(extractTabId(paneOutput("w12:t1"))).toBe("w12:t1");
	});

	it("returns undefined for missing or blank tab ids", () => {
		expect(extractTabId(paneOutput(undefined))).toBeUndefined();
		expect(extractTabId(paneOutput(" "))).toBeUndefined();
	});

	it("returns undefined for malformed output", () => {
		expect(extractTabId("not json")).toBeUndefined();
		expect(extractTabId(JSON.stringify({ result: {} }))).toBeUndefined();
	});
});

describe("extractTabInfo", () => {
	function tabOutput(tab: Record<string, unknown> | undefined): string {
		return JSON.stringify({ result: { tab } });
	}

	it("extracts id, label, and number", () => {
		expect(
			extractTabInfo(tabOutput({ tab_id: "w12:t1", label: "1", number: 1 })),
		).toEqual({ id: "w12:t1", label: "1", number: 1 });
	});

	it("omits missing label and number", () => {
		expect(extractTabInfo(tabOutput({ tab_id: "w12:t1" }))).toEqual({
			id: "w12:t1",
		});
	});

	it("returns undefined without a tab id", () => {
		expect(extractTabInfo(tabOutput({ label: "1" }))).toBeUndefined();
		expect(extractTabInfo("not json")).toBeUndefined();
	});
});

describe("isDefaultHerdrTabLabel", () => {
	it("is true for an empty label", () => {
		expect(isDefaultHerdrTabLabel({ id: "w12:t1" })).toBe(true);
		expect(isDefaultHerdrTabLabel({ id: "w12:t1", label: "  " })).toBe(true);
	});

	it("is true when the label matches the tab number", () => {
		expect(
			isDefaultHerdrTabLabel({ id: "w12:t1", label: "1", number: 1 }),
		).toBe(true);
	});

	it("is false for a custom label", () => {
		expect(
			isDefaultHerdrTabLabel({ id: "w12:t1", label: "model test", number: 1 }),
		).toBe(false);
	});

	it("is false when the label differs from the number", () => {
		expect(
			isDefaultHerdrTabLabel({ id: "w12:t1", label: "2", number: 1 }),
		).toBe(false);
	});
});
