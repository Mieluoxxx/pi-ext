import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

test("packed CLI smoke script exists", () => {
	assert.equal(existsSync("scripts/packed-cli-smoke.mjs"), true);
});
