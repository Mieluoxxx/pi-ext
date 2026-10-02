import test from "node:test";
import assert from "node:assert/strict";

import { meetsNodeRequirement } from "../bin/lazypi.mjs";

test("doctor Node floor matches engines.node without lexicographic mistakes", () => {
	// Current engines.node is ">=20.12.0"; 20.9 must fail even though "20.9" > "20.12" as a string.
	assert.equal(meetsNodeRequirement("24.19.0"), true);
	assert.equal(meetsNodeRequirement("20.12.0"), true);
	assert.equal(meetsNodeRequirement("20.11.9"), false);
	assert.equal(meetsNodeRequirement("18.20.4"), false);
});

test("an unparsable or missing engine range never blocks the doctor", () => {
	assert.equal(meetsNodeRequirement("16.0.0", ""), true);
	assert.equal(meetsNodeRequirement("16.0.0", "latest"), true);
	assert.equal(meetsNodeRequirement("18.0.0", ">=20"), false);
});
