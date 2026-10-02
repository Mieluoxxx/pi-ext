import test from "node:test";
import assert from "node:assert/strict";

import { selectPackagesOneByOne } from "../bin/lazypi.mjs";

test("package selection asks in order and forwards initial values", async () => {
	const packages = [
		{ id: "first", category: "core", description: "First package", hint: "It is useful first." },
		{ id: "second", category: "tools", description: "Second package", hint: "It adds a tool." },
		{ id: "third", category: "ui", description: "Third package", hint: "It improves the UI." },
	];
	const answers = [true, false, true];
	const prompts = [];
	const selected = await selectPackagesOneByOne(packages, new Set(["first", "third"]), async (message, initial) => {
		prompts.push({ message, initial });
		return answers[prompts.length - 1];
	});

	assert.deepEqual(prompts.map(({ message }) => message.split("\n")[0]), [
		"Install [core] first?",
		"Install [tools] second?",
		"Install [ui] third?",
	]);
	assert.deepEqual(prompts.map(({ initial }) => initial), [true, false, true]);
	assert.match(prompts[0].message, /Recommended because: It is useful first\./);
	assert.deepEqual([...selected], ["first", "third"]);
});
