import test from "node:test";
import assert from "node:assert/strict";

import { PACKAGES } from "../bin/lazypi.mjs";
import { expectedPackageSources, packageSourcesFromSettings } from "../scripts/assert-installed-packages.mjs";

test("expectedPackageSources matches the full catalog", () => {
	const expected = expectedPackageSources();
	assert.deepEqual(expected, PACKAGES.filter((pkg) => typeof pkg.source === "string").map((pkg) => pkg.source));
});

test("pi-ext catalog entries use the published moguw sources", () => {
	const expected = expectedPackageSources();
	for (const id of ["interactive-shell", "session-rename", "advisor"]) {
		const source = `npm:@moguw/pi-${id}`;
		assert.equal(PACKAGES.find((pkg) => pkg.id === id)?.source, source);
		assert.ok(expected.includes(source));
	}
});

test("catalog matches the normalized seven-extension pi list snapshot", () => {
	const expected = [
		"npm:pi-workspace-history", "npm:@getpipher/vision", "npm:pi-zentui",
		"npm:@moguw/pi-interactive-shell",
		"git:github.com/DietrichGebert/ponytail@v4.9.0",
		"npm:@moguw/pi-session-rename",
		"npm:@moguw/pi-advisor",
	];
	assert.deepEqual(expectedPackageSources().sort(), expected.sort());
	assert.equal(PACKAGES.find((pkg) => pkg.id === "advisor").source, "npm:@moguw/pi-advisor");
	assert.deepEqual(PACKAGES.filter((pkg) => !pkg.source).map((pkg) => pkg.id), ["vesper-dark", "vesper-light", "global-agents", "vision-config"]);
});

test("expectedPackageSources supports excluded package ids", () => {
	const extensionCount = PACKAGES.filter((pkg) => typeof pkg.source === "string").length;
	const excludedId = PACKAGES[0].id;
	const expected = expectedPackageSources({ except: [excludedId] });
	assert.equal(expected.includes(PACKAGES[0].source), false);
	assert.equal(expected.length, extensionCount - 1);
});

test("packageSourcesFromSettings reads string and object package entries", () => {
	const sources = packageSourcesFromSettings({
		packages: [
			"npm:pi-subagents",
			{ source: "npm:pi-ask-user" },
			{ source: "npm:pi-mcp-adapter", extra: true },
			{ nope: true },
		],
	});

	assert.deepEqual([...sources].sort(), ["npm:pi-ask-user", "npm:pi-mcp-adapter", "npm:pi-subagents"]);
});
