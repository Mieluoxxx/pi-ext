import { describe, expect, it } from "vitest";
import { buildOutlinePrompt, buildOutlineSnapshot } from "../src/context.js";
import { answerText, answerOutline, previewOutline } from "../src/outline.js";
import { parseBtwRoute } from "../src/index.js";

describe("parseBtwRoute", () => {
	it("defaults to fork", () => {
		expect(parseBtwRoute("")).toEqual({ kind: "fork" });
		expect(parseBtwRoute("fork")).toEqual({ kind: "fork" });
	});

	it("routes tab, help and questions", () => {
		expect(parseBtwRoute("tab")).toEqual({ kind: "fork-tab" });
		expect(parseBtwRoute("help")).toEqual({ kind: "help" });
		expect(parseBtwRoute("inline what is this?")).toEqual({
			kind: "inline",
			question: "what is this?",
		});
		expect(parseBtwRoute("outline why?")).toEqual({
			kind: "outline",
			question: "why?",
		});
	});

	it("treats unknown first words as inline questions", () => {
		expect(parseBtwRoute("why does this fail")).toEqual({
			kind: "inline",
			question: "why does this fail",
		});
	});
});

describe("buildOutlineSnapshot", () => {
	it("handles an empty session", () => {
		const snapshot = buildOutlineSnapshot(
			{ getEntries: () => [], getLeafId: () => null, getSessionId: () => "s1" } as never,
			"/tmp/proj",
		);
		expect(snapshot.conversation).toBe("");
		expect(snapshot.cwd).toBe("/tmp/proj");
		expect(snapshot.sessionId).toBe("s1");
	});

	it("includes model and thinking when present", () => {
		const entries = [
			{
				type: "model_change",
				id: "e1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				provider: "anthropic",
				modelId: "claude-sonnet-4",
			},
			{
				type: "thinking_level_change",
				id: "e2",
				parentId: "e1",
				timestamp: "2026-01-01T00:00:01.000Z",
				thinkingLevel: "high",
			},
		] as never;
		const snapshot = buildOutlineSnapshot(
			{ getEntries: () => entries, getLeafId: () => "e2", getSessionId: () => "s1" } as never,
			"/tmp/proj",
		);
		expect(snapshot.model).toBe("anthropic/claude-sonnet-4");
		expect(snapshot.thinkingLevel).toBe("high");
	});
});

describe("buildOutlinePrompt", () => {
	it("embeds the snapshot and question", () => {
		const prompt = buildOutlinePrompt(
			{
				conversation: "user: hi\nassistant: hello",
				model: "anthropic/claude-sonnet-4",
				sessionId: "s1",
				cwd: "/tmp/proj",
			},
			"What is the plan?",
		);
		expect(prompt).toContain("<parent-conversation>");
		expect(prompt).toContain("user: hi");
		expect(prompt).toContain("Question: What is the plan?");
		expect(prompt).toContain("NOT added to the session context");
	});

	it("marks an empty conversation", () => {
		const prompt = buildOutlinePrompt(
			{ conversation: "", cwd: "/tmp" },
			"Hello?",
		);
		expect(prompt).toContain("(No parent conversation yet.)");
	});
});

describe("answerText", () => {
	it("joins text blocks and trims ends", () => {
		expect(
			answerText([
				{ type: "text", text: "  first " },
				{ type: "toolCall", name: "ls", arguments: "{}" },
				{ type: "text", text: "second\n" },
			]),
		).toBe("first \nsecond");
	});

	it("passes plain strings through", () => {
		expect(answerText("plain answer")).toBe("plain answer");
	});

	it("returns empty for empty content", () => {
		expect(answerText("")).toBe("");
		expect(answerText([])).toBe("");
	});
});

describe("answerOutline", () => {
	it("returns failed when auth lookup rejects", async () => {
		const ctx = {
			model: { provider: "anthropic", id: "claude-sonnet-4" },
			modelRegistry: {
				getApiKeyAndHeaders: () => Promise.reject(new Error("auth boom")),
			},
			sessionManager: {
				getEntries: () => [],
				getLeafId: () => null,
				getSessionId: () => "s1",
			},
			cwd: "/tmp/proj",
			thinkingLevel: "high",
		} as never;

		const result = await answerOutline(ctx, "why?");
		expect(result.status).toBe("failed");
		if (result.status === "failed") expect(result.error).toContain("auth boom");
	});

	it("returns failed when the snapshot throws", async () => {
		const ctx = {
			model: { provider: "anthropic", id: "claude-sonnet-4" },
			modelRegistry: {
				getApiKeyAndHeaders: () => Promise.resolve({ ok: true }),
			},
			sessionManager: {
				getEntries: () => {
					throw new Error("snapshot boom");
				},
				getLeafId: () => null,
				getSessionId: () => "s1",
			},
			cwd: "/tmp/proj",
		} as never;

		const result = await answerOutline(ctx, "why?");
		expect(result.status).toBe("failed");
		if (result.status === "failed") expect(result.error).toContain("snapshot boom");
	});

	it("returns failed without a model", async () => {
		const ctx = {
			model: undefined,
		} as never;

		const result = await answerOutline(ctx, "why?");
		expect(result.status).toBe("failed");
		if (result.status === "failed") expect(result.error).toContain("No active model");
	});
});

describe("previewOutline", () => {
	it("elides multi-line answers", () => {
		const entry = {
			question: "q",
			answer: "line one\nline two",
			createdAt: new Date().toISOString(),
		};
		expect(previewOutline(entry)).toBe("line one…");
	});

	it("keeps single-line answers", () => {
		const entry = {
			question: "q",
			answer: "just this",
			createdAt: new Date().toISOString(),
		};
		expect(previewOutline(entry)).toBe("just this");
	});
});
