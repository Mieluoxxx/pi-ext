import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";

import initializeExtension from "../index.ts";
import { buildResearchArtifact, storeResearchArtifact } from "../source-check.ts";
import { clearResults, storeResult } from "../storage.ts";

function getContentTool() {
	clearResults();
	const tools = [];
	initializeExtension({
		registerTool(tool) { tools.push(tool); },
		registerCommand() {},
		registerShortcut() {},
		on() {},
	});
	const tool = tools.find((registered) => registered.name === "get_search_content");
	assert.ok(tool, "get_search_content tool was not registered");
	return tool;
}

function findContentTool() {
	clearResults();
	const tools = [];
	initializeExtension({
		registerTool(tool) { tools.push(tool); },
		registerCommand() {},
		registerShortcut() {},
		on() {},
	});
	const tool = tools.find((registered) => registered.name === "find_search_content");
	assert.ok(tool, "find_search_content tool was not registered");
	return tool;
}

function storeFetchedContent(content) {
	storeFetchedContents([{ url: "https://example.com/large", title: "Large Page", content, error: null }]);
}

function storeFetchedContents(urls) {
	storeResult("large-fetch", {
		id: "large-fetch",
		type: "fetch",
		timestamp: Date.now(),
		urls,
	});
}

function storeSearchContent() {
	storeResult("search-result", {
		id: "search-result",
		type: "search",
		timestamp: Date.now(),
		queries: [{
			query: "CotEditor scripts",
			answer: "",
			results: [
				{ title: "ScriptManager.swift", url: "https://example.com/script-manager", snippet: "UNIX script support" },
				{ title: "UNIX script", url: "https://example.com/unix-script", snippet: "Script support" },
				{ title: "ScriptMenu", url: "https://example.com/script-menu", snippet: "Menu integration" },
			],
			error: null,
		}],
	});
}

test("get_search_content schemas constrain numeric parameters", () => {
	const properties = getContentTool().parameters.properties;

	for (const name of ["contentIndex", "offset"]) {
		assert.equal(properties[name].type, "integer");
		assert.equal(properties[name].minimum, 0);
		assert.equal(properties[name].maximum, undefined);
		for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			assert.equal(Value.Check(properties[name], value), false, `${name} accepts ${value}`);
		}
	}

	assert.equal(properties.limit.type, "integer");
	assert.equal(properties.limit.minimum, 1);
	assert.equal(properties.limit.maximum, 30_000);
	for (const value of [0, 1.5, 30_001, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.equal(Value.Check(properties.limit, value), false, `limit accepts ${value}`);
	}
	for (const value of [1, 30_000]) {
		assert.equal(Value.Check(properties.limit, value), true, `limit rejects ${value}`);
	}
});

test("content retrieval actions expose separate model-facing schemas", () => {
	const getProperties = getContentTool().parameters.properties;
	const findProperties = findContentTool().parameters.properties;

	assert.equal(getProperties.findText, undefined);
	assert.equal(getProperties.findMode, undefined);
	assert.equal(getProperties.query, undefined);
	assert.equal(getProperties.queryIndex, undefined);
	assert.equal(getProperties.url, undefined);
	assert.equal(getProperties.urlIndex, undefined);
	assert.ok(getProperties.contentIndex);
	assert.equal(findProperties.offset, undefined);
	assert.equal(findProperties.limit, undefined);
	assert.ok(findProperties.contentIndex);
	assert.ok(findProperties.findText);
});

test("find_search_content resolves a stored URL by contentIndex", async () => {
	const tool = findContentTool();
	storeFetchedContent("prefix Installation requires Node 22.");

	const result = await tool.execute("call", {
		responseId: "large-fetch",
		contentIndex: 0,
		findText: "installation",
	});

	assert.equal(result.details.contentIndex, 0);
	assert.equal(result.details.matchCount, 1);
	assert.match(result.content[0].text, /Installation requires Node 22/);
});

test("multiple stored URLs require contentIndex and list the mapping", async () => {
	const tool = getContentTool();
	storeFetchedContents([
		{ url: "https://example.com/one", title: "One", content: "first", error: null },
		{ url: "https://example.com/two", title: "Two", content: "second", error: null },
	]);

	const missing = await tool.execute("call", { responseId: "large-fetch" });
	assert.equal(missing.details.error, "Content index required");
	assert.match(missing.content[0].text, /\[0\] One/);
	assert.match(missing.content[0].text, /\[1\] Two/);

	const selected = await tool.execute("call", { responseId: "large-fetch", contentIndex: 1 });
	assert.equal(selected.details.contentIndex, 1);
	assert.match(selected.content[0].text, /second/);
});

test("get_search_content returns a bounded first slice for large fetched content", async () => {
	const tool = getContentTool();
	storeFetchedContent("A".repeat(30_000) + "TAIL");

	const result = await tool.execute("call", { responseId: "large-fetch", contentIndex: 0 });
	const text = result.content[0].text;

	assert.equal(result.details.contentLength, 30_004);
	assert.equal(result.details.offset, 0);
	assert.equal(result.details.returnedChars, 30_000);
	assert.equal(result.details.nextOffset, 30_000);
	assert.equal(result.details.truncated, true);
	assert.match(text, /Showing chars 0-30000 of 30004/);
	assert.match(text, /offset: 30000/);
	assert.doesNotMatch(text, /TAIL/);
});

test("get_search_content returns requested fetched content slices", async () => {
	const tool = getContentTool();
	storeFetchedContent("A".repeat(30_000) + "BCDEFGHIJ");

	const result = await tool.execute("call", {
		responseId: "large-fetch",
		contentIndex: 0,
		offset: 30_000,
		limit: 5,
	});
	const text = result.content[0].text;

	assert.equal(result.details.offset, 30_000);
	assert.equal(result.details.limit, 5);
	assert.equal(result.details.returnedChars, 5);
	assert.equal(result.details.nextOffset, 30_005);
	assert.match(text, /BCDEF/);
	assert.doesNotMatch(text, /GHIJ/);
	assert.match(text, /contentIndex: 0, offset: 30005, limit: 5/);
});

test("get_search_content rejects unsafe fetched content ranges", async () => {
	const tool = getContentTool();
	storeFetchedContent("short content");

	const tooLarge = await tool.execute("call", { responseId: "large-fetch", contentIndex: 0, limit: 30_001 });
	assert.equal(tooLarge.details.error, "Invalid limit");
	assert.match(tooLarge.content[0].text, /received 30001/);
	assert.match(tooLarge.content[0].text, /limit must be an integer from 1 to 30000/);

	const invalidOffset = await tool.execute("call", { responseId: "large-fetch", contentIndex: 0, offset: 1.5 });
	assert.equal(invalidOffset.details.error, "Invalid offset");
	assert.match(invalidOffset.content[0].text, /received 1\.5/);
	assert.match(invalidOffset.content[0].text, /Use 0 or a larger integer/);

	const outOfRange = await tool.execute("call", { responseId: "large-fetch", contentIndex: 0, offset: 99 });
	assert.equal(outOfRange.details.error, "Offset out of range");
	assert.match(outOfRange.content[0].text, /Received offset 99/);
	assert.match(outOfRange.content[0].text, /valid range is 0-13/);

	const artifact = buildResearchArtifact({
		query: "stored claim",
		results: [{ url: "https://example.com/research", title: "Research source", snippet: "The bridge defaults match this research passage.", rank: 1 }],
		summary: "Unique bridge research summary marker.",
	});
	artifact.id = "stored-research";
	storeResearchArtifact(artifact);
	const researchInvalidLimit = await tool.execute("call", { responseId: "stored-research", contentIndex: 0, limit: 30_001 });
	assert.equal(researchInvalidLimit.details.error, "Invalid limit");
	assert.match(researchInvalidLimit.content[0].text, /received 30001/);
	assert.match(researchInvalidLimit.content[0].text, /limit must be an integer from 1 to 30000/);

	const researchOutOfRange = await tool.execute("call", { responseId: "stored-research", contentIndex: 0, offset: 99_999 });
	assert.equal(researchOutOfRange.details.error, "Offset out of range");
	assert.match(researchOutOfRange.content[0].text, /responseId "stored-research"/);
	assert.match(researchOutOfRange.content[0].text, /valid range is 0-/);

	const researchFind = await findContentTool().execute("call", {
		responseId: "stored-research",
		contentIndex: 0,
		findText: "Unique bridge research summary marker",
	});
	assert.equal(researchFind.details.type, "research");
	assert.equal(researchFind.details.findMode, "case-insensitive");
	assert.equal(researchFind.details.matchCount, 1);
	assert.match(researchFind.content[0].text, /^Text matches \(case-insensitive\)/);
	assert.match(researchFind.content[0].text, /Unique bridge research summary marker/);
});

test("get_search_content normalizes bridge defaults for search matches", async () => {
	const tool = getContentTool();
	storeSearchContent();

	const result = await findContentTool().execute("call", {
		responseId: "search-result",
		contentIndex: 0,
		findText: ["ScriptManager.swift", "UNIX script", "ScriptMenu"],
		findMode: "case-insensitive",
	});

	assert.equal(result.details.findMode, "case-insensitive");
	assert.equal(result.details.matchCount, 3);
	assert.match(result.content[0].text, /ScriptManager\.swift/);
	assert.match(result.content[0].text, /ScriptMenu/);
});

test("get_search_content returns small fetched content without continuation noise", async () => {
	const tool = getContentTool();
	storeFetchedContent("small content");

	const result = await tool.execute("call", { responseId: "large-fetch", contentIndex: 0 });
	const text = result.content[0].text;

	assert.equal(result.details.returnedChars, "small content".length);
	assert.equal(result.details.nextOffset, null);
	assert.match(text, /small content/);
	assert.doesNotMatch(text, /Showing chars/);
});

test("get_search_content finds bounded passages in stored fetched content", async () => {
	const tool = getContentTool();
	storeFetchedContent(`prefix ${"A".repeat(2_000)} Installation requires Node 22. ${"B".repeat(2_000)} suffix`);

	const result = await findContentTool().execute("call", {
		responseId: "large-fetch",
		contentIndex: 0,
		findText: "installation",
	});

	assert.equal(result.details.matchCount, 1);
	assert.equal(result.details.findMode, "case-insensitive");
	assert.match(result.content[0].text, /Installation requires Node 22/);
	assert.ok(result.content[0].text.length < 1_000);
});
