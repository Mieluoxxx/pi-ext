import test from "node:test";
import assert from "node:assert/strict";

import { PACKAGES, normalizePackageLoadOrderInSettings } from "../bin/lazypi.mjs";

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

test("fff installs and loads before hashline-edit-pro", () => {
	const fffIndex = PACKAGES.findIndex((pkg) => pkg.id === "fff");
	const hashlineIndex = PACKAGES.findIndex((pkg) => pkg.id === "hashline-edit-pro");
	assert.ok(fffIndex < hashlineIndex, "fff should precede hashline-edit-pro in the catalog");
	assert.ok(PACKAGES[fffIndex].loadBefore?.includes("hashline-edit-pro"));
	const settings = { packages: ["npm:@moguw/pi-hashline-edit-pro", "npm:@ff-labs/pi-fff"] };
	assert.equal(normalizePackageLoadOrderInSettings(settings), true);
	assert.deepEqual(settings.packages, ["npm:@ff-labs/pi-fff", "npm:@moguw/pi-hashline-edit-pro"]);
});

test("tool providers load before lazy-tools while preserving package filters", () => {
	const gate = PACKAGES.find((pkg) => pkg.id === "lazy-tools").source;
	const providers = ["web-access", "fff", "hashline-edit-pro", "computer-use", "openai-tools"].map((id) => PACKAGES.find((pkg) => pkg.id === id).source);
	const filtered = { source: providers[0], skills: [] };
	const settings = { packages: [gate, filtered, ...providers.slice(1)] };
	assert.equal(normalizePackageLoadOrderInSettings(settings), true);
	const ordered = settings.packages.map((entry) => typeof entry === "string" ? entry : entry.source);
	for (const source of providers) assert.ok(ordered.indexOf(source) < ordered.indexOf(gate));
	assert.ok(settings.packages.includes(filtered));
	assert.equal(normalizePackageLoadOrderInSettings(settings), false);
});
