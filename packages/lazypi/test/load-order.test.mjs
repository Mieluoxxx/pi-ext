import test from "node:test";
import assert from "node:assert/strict";

import { normalizePackageLoadOrderInSettings } from "../bin/lazypi.mjs";

const catalog = [
	{ id: "settings", source: "npm:settings", loadBefore: ["powerbar"] },
	{ id: "powerbar", source: "npm:powerbar" },
];

test("catalog load constraints repair settings while preserving unrelated order", () => {
	const unrelatedBefore = "npm:unrelated-before";
	const unrelatedAfter = "npm:unrelated-after";
	const settings = {
		packages: [unrelatedBefore, "npm:powerbar", "npm:settings", unrelatedAfter],
	};

	assert.equal(normalizePackageLoadOrderInSettings(settings, catalog), true);
	assert.deepEqual(settings.packages, [
		unrelatedBefore,
		"npm:settings",
		"npm:powerbar",
		unrelatedAfter,
	]);
});

test("catalog load constraints leave valid settings unchanged", () => {
	const settings = { packages: ["npm:settings", "npm:powerbar", "npm:other"] };
	assert.equal(normalizePackageLoadOrderInSettings(settings, catalog), false);
	assert.deepEqual(settings.packages, ["npm:settings", "npm:powerbar", "npm:other"]);
});

test("catalog load constraints detect cycles without reordering", () => {
	const cyclicCatalog = [
		{ id: "a", source: "npm:a", loadBefore: ["b"] },
		{ id: "b", source: "npm:b", loadBefore: ["a"] },
	];
	const settings = { packages: ["npm:b", "npm:a"] };
	assert.equal(normalizePackageLoadOrderInSettings(settings, cyclicCatalog), false);
	assert.deepEqual(settings.packages, ["npm:b", "npm:a"]);
});
