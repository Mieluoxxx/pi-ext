import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const PACKED_CLI_SMOKE_COMMAND = "node scripts/packed-cli-smoke.mjs";

function readWorkflow(path) {
	return readFileSync(path, "utf8");
}

test("packed CLI smoke script exists", () => {
	assert.equal(existsSync("scripts/packed-cli-smoke.mjs"), true);
});

test("linux CI workflow smoke-tests the packed CLI artifact", () => {
	const workflow = readWorkflow(".github/workflows/test.yml");
	assert.equal(workflow.includes(PACKED_CLI_SMOKE_COMMAND), true);
});

test("windows CI workflow smoke-tests the packed CLI artifact", () => {
	const workflow = readWorkflow(".github/workflows/windows-smoke.yml");
	assert.equal(workflow.includes(PACKED_CLI_SMOKE_COMMAND), true);
	assert.doesNotMatch(workflow, /compound|bun/i);
});
