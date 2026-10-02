import type { Message } from "@earendil-works/pi-ai";
import { homedir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	buildSessionEntries,
	chained,
	createMockCtx,
	createMockPi,
	makeAssistantMessage,
	makeToolResult,
	makeUserMessage,
} from "./test/helpers.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>();
	return {
		...actual,
		getSupportedThinkingLevels: vi.fn(() => ["off", "minimal", "low", "medium", "high"]),
	};
});

// completeSimple lives on /compat since pi 0.80 (see test/setup.ts).
vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai/compat")>();
	return {
		...actual,
		completeSimple: vi.fn(),
	};
});

import { completeSimple } from "@earendil-works/pi-ai/compat";
import { ADVISOR_ANCHOR_ENTRY } from "./advisor/anchor.js";
import { executeAdvisor } from "./advisor/execute.js";
import { registerAdvisorTool, setAdvisorModel } from "./advisor/index.js";

function resp(input: { text?: string; stopReason?: "done" | "aborted" | "error" | "toolUse"; errorMessage?: string }) {
	return {
		role: "assistant",
		content: input.text ? [{ type: "text", text: input.text }] : [],
		timestamp: Date.now(),
		stopReason: input.stopReason ?? "done",
		errorMessage: input.errorMessage,
	};
}

beforeEach(() => {
	vi.mocked(completeSimple).mockReset();
});

describe("executeAdvisor — 4 StopReason branches", () => {
	it("happy path returns advisor text", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		vi.mocked(completeSimple).mockResolvedValueOnce(resp({ text: "advice" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx({
			branch: buildSessionEntries([makeUserMessage("q"), makeAssistantMessage({ text: "a" })]),
		});
		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(r?.content[0]).toMatchObject({ type: "text", text: "advice" });
		expect(r?.details).toMatchObject({ advisorModel: "a:m" });
		// R6.4 guard: a non-empty first attempt does NOT retry.
		expect(completeSimple).toHaveBeenCalledTimes(1);
	});

	it("uses Pi's auth-aware runtime completion when the host exposes it", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx();
		const runtime = {
			completeSimple: vi.fn(function (this: unknown, ..._args: unknown[]) {
				expect(this).toBe(runtime);
				return Promise.resolve(resp({ text: "runtime advice" }));
			}),
		};
		// Pi keeps ModelRuntime behind ModelRegistry's runtime-private slot. Keep
		// this test non-enumerable to mirror that host shape.
		Object.defineProperty(ctx.modelRegistry, "runtime", { value: runtime });

		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(r?.content[0]).toMatchObject({ type: "text", text: "runtime advice" });
		expect(runtime.completeSimple).toHaveBeenCalledTimes(1);
		expect(completeSimple).not.toHaveBeenCalled();
		const options = runtime.completeSimple.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
		expect(options).toHaveProperty("sessionId", "advisor:test-session");
		// The consultation deadline is always armed by default.
		expect(options?.signal).toBeInstanceOf(AbortSignal);
		expect(options).toHaveProperty("reasoning", undefined);
		expect(options).not.toHaveProperty("apiKey");
		expect(options).not.toHaveProperty("headers");
	});

	it("uses the legacy completion path when the host has no runtime facade", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		vi.mocked(completeSimple).mockResolvedValueOnce(resp({ text: "legacy advice" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx();

		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(r?.content[0]).toMatchObject({ type: "text", text: "legacy advice" });
		expect(completeSimple).toHaveBeenCalledTimes(1);
		const options = vi.mocked(completeSimple).mock.calls[0]?.[2] as Record<string, unknown> | undefined;
		expect(options).toMatchObject({ apiKey: "test-key", headers: {}, sessionId: "advisor:test-session" });
	});

	it("recovers the user's pre-compaction words that pi's summary would have replaced", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		vi.mocked(completeSimple).mockResolvedValueOnce(resp({ text: "advice" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		// The ledger reads the RAW branch, so the user's own words survive a
		// compaction that pi's context builder would have replaced with a summary.
		const branch = chained([
			{ type: "message", message: makeUserMessage("ORIGINAL USER REQUEST") },
			{ type: "message", message: makeAssistantMessage({ text: "old raw assistant detail" }) },
			{ type: "compaction", summary: "PI SUMMARY OF EARLIER WORK", firstKeptEntryId: "", tokensBefore: 1 },
			{ type: "message", message: makeUserMessage("kept user message") },
			{ type: "message", message: makeAssistantMessage({ text: "post-compaction assistant" }) },
		]);
		const ctx = createMockCtx({ branch });

		await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);

		const payload = vi.mocked(completeSimple).mock.calls[0]?.[1] as { messages?: unknown[] };
		const serialized = JSON.stringify(payload.messages);
		expect(serialized).toContain("ORIGINAL USER REQUEST");
		expect(serialized).toContain("PI SUMMARY OF EARLIER WORK");
		expect(serialized).toContain("kept user message");
		expect(serialized).toContain("post-compaction assistant");
		// The summary is labelled as secondhand so it is not mistaken for intent.
		expect(serialized).toContain("not the user's words");
	});

	it("aborted stopReason returns cancel envelope", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		vi.mocked(completeSimple).mockResolvedValueOnce(resp({ stopReason: "aborted" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx();
		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(r?.details).toMatchObject({ stopReason: "aborted", errorMessage: "aborted" });
	});

	it("error stopReason returns wrapped errorMessage", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		const deterministic = "context_too_large: Your input exceeds the context window";
		vi.mocked(completeSimple).mockResolvedValueOnce(resp({ stopReason: "error", errorMessage: deterministic }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx();
		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("context_too_large") });
		expect(r?.details).toMatchObject({ stopReason: "error", errorMessage: deterministic });
		// R6.4 guard: a non-transient error short-circuits — NOT retried.
		expect(completeSimple).toHaveBeenCalledTimes(1);
	});

	it("re-sends a transient provider failure once and returns the retried answer", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		vi.mocked(completeSimple)
			.mockResolvedValueOnce(
				resp({ stopReason: "error", errorMessage: "server_error: Upstream stream ended before a terminal response event." }) as never,
			)
			.mockResolvedValueOnce(resp({ text: "advice after retry" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx();
		vi.useFakeTimers();
		try {
			const pending = captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
			await vi.advanceTimersByTimeAsync(2000);
			const r = await pending;
			expect(r?.content[0]).toMatchObject({ text: "advice after retry" });
			expect((r?.details as { attempts?: unknown[] }).attempts).toHaveLength(2);
			expect(completeSimple).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("retries a transient failure at most once", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		vi.mocked(completeSimple).mockResolvedValue(resp({ stopReason: "error", errorMessage: "502 Bad Gateway" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx();
		vi.useFakeTimers();
		try {
			const pending = captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
			await vi.advanceTimersByTimeAsync(2000);
			const r = await pending;
			expect(r?.details).toMatchObject({ stopReason: "error", errorMessage: "502 Bad Gateway" });
			expect(completeSimple).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
			vi.mocked(completeSimple).mockReset();
		}
	});

	it("returns a timeout result when the consultation deadline fires", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		writeBudget({ timeoutSec: 5 });
		vi.mocked(completeSimple).mockImplementationOnce(
			(_model, _context, options) =>
				new Promise((resolve) => {
					const signal = (options as { signal?: AbortSignal }).signal;
					signal?.addEventListener("abort", () => resolve(resp({ stopReason: "aborted", errorMessage: "aborted" }) as never));
				}),
		);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx();
		vi.useFakeTimers();
		try {
			const pending = captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
			await vi.advanceTimersByTimeAsync(5000);
			const r = await pending;
			expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("timed out after 5s") });
			expect(r?.details).toMatchObject({ stopReason: "error", errorMessage: "deadline exceeded" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("reports a user cancel as aborted, not as a timeout", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		const controller = new AbortController();
		vi.mocked(completeSimple).mockImplementationOnce(async () => {
			controller.abort();
			return resp({ stopReason: "aborted", errorMessage: "aborted" }) as never;
		});
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx();
		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, controller.signal, undefined as never, ctx);
		expect(r?.content[0]).toMatchObject({ text: "Advisor call was cancelled before it completed." });
		expect(r?.details).toMatchObject({ stopReason: "aborted" });
	});

	it("empty-response retries once then surfaces ERR_EMPTY_RESPONSE envelope", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		// Two consecutive empty resolutions — the second is what makes the retry
		// bounded and deterministic (without it the exhausted mock returns
		// `undefined` and the unit would throw into the catch arm).
		vi.mocked(completeSimple)
			.mockResolvedValueOnce(resp({ text: "   " }) as never)
			.mockResolvedValueOnce(resp({ text: "" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx();
		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(completeSimple).toHaveBeenCalledTimes(2);
		expect(r?.details).toMatchObject({ errorMessage: "empty response" });
	});

	it("retry succeeds when the second attempt returns advice", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		vi.mocked(completeSimple)
			.mockResolvedValueOnce(resp({ text: "   " }) as never)
			.mockResolvedValueOnce(resp({ text: "recovered advice" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx();
		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(r?.content[0]).toMatchObject({ type: "text", text: "recovered advice" });
		expect(completeSimple).toHaveBeenCalledTimes(2);
	});

	it("retries once on the runtime facade path too", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx();
		// getRuntimeCompleteSimple() returns completeSimple.bind(runtime), so the
		// two mockReturnValueOnce resolutions are consumed by the bound method.
		const runtime = {
			completeSimple: vi
				.fn()
				.mockResolvedValueOnce(resp({ text: "" }) as never)
				.mockResolvedValueOnce(resp({ text: "runtime recovered" }) as never),
		};
		// Pi keeps ModelRuntime behind ModelRegistry's runtime-private slot. Keep
		// this test non-enumerable to mirror that host shape.
		Object.defineProperty(ctx.modelRegistry, "runtime", { value: runtime });

		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(r?.content[0]).toMatchObject({ type: "text", text: "runtime recovered" });
		expect(runtime.completeSimple).toHaveBeenCalledTimes(2);
		expect(completeSimple).not.toHaveBeenCalled();
	});

	it("thrown error is caught and wrapped in details.errorMessage", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		vi.mocked(completeSimple).mockRejectedValueOnce(new Error("boom"));
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx();
		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("boom") });
		expect(r?.details).toMatchObject({ errorMessage: "boom" });
	});
});

describe("executeAdvisor — auth envelopes", () => {
	it("returns no-model envelope when advisor is not configured", async () => {
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx();
		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(r?.details).toMatchObject({ errorMessage: "no advisor model selected" });
	});

	it("wraps misconfigured auth into details.errorMessage", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx();
		(ctx.modelRegistry.getApiKeyAndHeaders as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			ok: false,
			error: "bad config",
		});
		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("bad config") });
		expect(r?.details).toMatchObject({ errorMessage: "bad config", advisorModel: "a:m" });
	});

	it("returns no-api-key envelope when apiKey is missing and the host has no runtime facade", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx();
		(ctx.modelRegistry.getApiKeyAndHeaders as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			ok: true,
			apiKey: undefined,
			headers: {},
		});
		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("no API key") });
		expect(r?.details).toMatchObject({ errorMessage: "no API key for a", advisorModel: "a:m" });
	});

	it("proceeds via the runtime facade when OAuth auth resolves ok without an apiKey", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx();
		// OAuth-backed providers (e.g. kimi-coding) resolve ok with no literal key;
		// credentials are applied inside Pi's runtime facade.
		(ctx.modelRegistry.getApiKeyAndHeaders as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			ok: true,
		});
		const runtime = {
			completeSimple: vi.fn((..._args: unknown[]) => Promise.resolve(resp({ text: "oauth advice" }))),
		};
		Object.defineProperty(ctx.modelRegistry, "runtime", { value: runtime });

		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(r?.content[0]).toMatchObject({ type: "text", text: "oauth advice" });
		expect(completeSimple).not.toHaveBeenCalled();
		const options = runtime.completeSimple.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
		expect(options).not.toHaveProperty("apiKey");
		expect(options).not.toHaveProperty("headers");
	});
});

const meteredUsage = {
	input: 100,
	output: 10,
	cacheRead: 50,
	cacheWrite: 0,
	totalTokens: 160,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.05, cacheWrite: 0, total: 0.35 },
};
const pricedModel = {
	provider: "a",
	id: "m",
	api: "openai-responses",
	maxTokens: 100,
	cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
};
function writeBudget(budget: unknown) {
	const path = join(homedir(), ".config/rpiv-advisor/advisor.json");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({ budget }));
}

describe("advisor usage, session routing and budget integration", () => {
	it.each(["success", "empty", "aborted", "error", "throw"])(
		"retains all billed attempts when retry ends with %s",
		async (outcome) => {
			setAdvisorModel(pricedModel as never);
			vi.mocked(completeSimple).mockResolvedValueOnce({ ...resp({}), usage: meteredUsage } as never);
			if (outcome === "throw") vi.mocked(completeSimple).mockRejectedValueOnce(new Error("transport"));
			else
				vi.mocked(completeSimple).mockResolvedValueOnce({
					...resp({
						text: outcome === "success" ? "advice" : "",
						stopReason: outcome === "aborted" || outcome === "error" ? outcome : "done",
					}),
					usage: meteredUsage,
				} as never);
			const ctx = createMockCtx({ hasUI: true });
			const result = await executeAdvisor(ctx, createMockPi().pi, undefined, undefined);
			const total = outcome === "throw" ? 0.35 : 0.7;
			expect(result).toHaveProperty("usage.cost.total", total);
			expect(result.details.usage?.cost.total).toBe(total);
			expect(result.details.attempts).toHaveLength(2);
			expect(result.details.estimate).toBeDefined();
			expect(vi.mocked(completeSimple).mock.calls[0][1]).toEqual(vi.mocked(completeSimple).mock.calls[1][1]);
			expect(vi.mocked(completeSimple).mock.calls[0][2]).toBe(vi.mocked(completeSimple).mock.calls[1][2]);
			expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("advisor", expect.stringContaining(`$${total.toFixed(2)}`));
		},
	);

	it("reuses the routing key in a session and isolates another session", async () => {
		setAdvisorModel(pricedModel as never);
		vi.mocked(completeSimple).mockResolvedValue(resp({ text: "advice" }) as never);
		for (const sessionId of ["one", "one", "two"]) {
			await executeAdvisor(createMockCtx({ sessionId }), createMockPi().pi, undefined, undefined);
		}
		expect(vi.mocked(completeSimple).mock.calls.map((call) => call[2]?.sessionId)).toEqual([
			"advisor:one",
			"advisor:one",
			"advisor:two",
		]);
	});

	it.each(["headless", "declined", "approved", "skip"])("applies the hard gate: %s", async (mode) => {
		setAdvisorModel(pricedModel as never);
		writeBudget({ perCallHardUsd: 0, onExceed: mode === "skip" ? "skip" : "confirm" });
		vi.mocked(completeSimple).mockResolvedValue(resp({ text: "advice" }) as never);
		const ctx = createMockCtx({
			hasUI: mode !== "headless",
			ui: { confirm: vi.fn(async () => mode !== "declined") },
		});
		const result = await executeAdvisor(ctx, createMockPi().pi, undefined, undefined);
		expect(completeSimple).toHaveBeenCalledTimes(mode === "approved" ? 1 : 0);
		if (mode !== "approved") {
			expect(result.details.skipped).toBe(true);
			expect(result.content[0]).toMatchObject({ text: expect.stringContaining("do not retry") });
		}
	});

	it("checks the session budget from legacy branch usage before sending", async () => {
		setAdvisorModel(pricedModel as never);
		writeBudget({ sessionUsd: 0.35 });
		const ctx = createMockCtx({
			branch: [
				{
					type: "message",
					message: { role: "toolResult", toolName: "advisor", content: [], details: { usage: meteredUsage } },
				},
			] as never,
		});
		const result = await executeAdvisor(ctx, createMockPi().pi, undefined, undefined);
		expect(result.details.skipped).toBe(true);
		expect(completeSimple).not.toHaveBeenCalled();
	});

	it("does not let an automatic retry bypass the budget, and keeps the first charge", async () => {
		setAdvisorModel(pricedModel as never);
		writeBudget({ perCallHardUsd: 0.1 });
		vi.mocked(completeSimple).mockResolvedValueOnce({ ...resp({}), usage: meteredUsage } as never);
		const result = await executeAdvisor(createMockCtx(), createMockPi().pi, undefined, undefined);
		expect(completeSimple).toHaveBeenCalledTimes(1);
		expect(result.details.skipped).toBe(true);
		expect(result).toHaveProperty("usage.cost.total", 0.35);
	});
});

it("returns billed usage even if the status UI has been replaced", async () => {
	setAdvisorModel(pricedModel as never);
	vi.mocked(completeSimple).mockResolvedValue({ ...resp({ text: "advice" }), usage: meteredUsage } as never);
	const ctx = createMockCtx({
		hasUI: true,
		ui: {
			setStatus: vi.fn(() => {
				throw new Error("stale UI");
			}),
		},
	});
	const result = await executeAdvisor(ctx, createMockPi().pi, undefined, undefined);
	expect(result).toHaveProperty("usage.cost.total", 0.35);
	expect(result.details.errorMessage).toBeUndefined();
});

it("never resolves auth or sends a side request to the executor's own model", async () => {
	setAdvisorModel(pricedModel as never);
	const ctx = createMockCtx({ model: { ...pricedModel, provider: "other-provider" } as never });
	const result = await executeAdvisor(ctx, createMockPi().pi, undefined, undefined);
	expect(result.details).toMatchObject({ skipped: true, errorMessage: "same model as executor" });
	expect(ctx.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();
	expect(completeSimple).not.toHaveBeenCalled();
});

it("checks a model switch during confirmation before dispatch", async () => {
	setAdvisorModel(pricedModel as never);
	writeBudget({ perCallHardUsd: 0 });
	const ctx = createMockCtx({ hasUI: true });
	vi.mocked(ctx.ui.confirm).mockImplementation(async () => {
		ctx.model = pricedModel as never;
		return true;
	});
	const result = await executeAdvisor(ctx, createMockPi().pi, undefined, undefined);
	expect(result.details.errorMessage).toBe("same model as executor");
	expect(completeSimple).not.toHaveBeenCalled();
});

it("trims a cold oversized request, persists its anchor, then retains the warm request prefix", async () => {
	setAdvisorModel(pricedModel as never);
	writeBudget({ perCallSoftUsd: 0, contextBudgetTokens: 2600 });
	// A ledger grows by ACCUMULATING rounds: one huge tool body is already capped
	// by the verbatim-tail limit, so an oversized cold request means many cards.
	const raw: Message[] = [makeUserMessage("task")];
	for (let i = 0; i < 150; i++) {
		raw.push(
			makeAssistantMessage({
				toolCalls: [{ id: `r${i}`, name: "read", arguments: { path: `src/old-middle-${i}.ts` } }],
			}),
		);
		raw.push(makeToolResult({ toolCallId: `r${i}`, toolName: "read", text: `body ${i}` }));
	}
	raw.push(makeAssistantMessage({ text: "question", toolCalls: [{ id: "a1", name: "advisor", arguments: {} }] }));
	const branch = buildSessionEntries(raw);
	const appendEntry = vi.fn((customType, data) => {
		branch.push({ type: "custom", id: "anchor", parentId: branch.at(-1)?.id, customType, data } as never);
	});
	const { pi } = createMockPi({ appendEntry });
	const ctx = createMockCtx({ branch });
	vi.mocked(completeSimple).mockResolvedValue({ ...resp({ text: "advice" }), usage: meteredUsage } as never);
	const result = await executeAdvisor(ctx, pi, undefined, undefined);
	expect(result.details.context?.trimmed).toBe(true);
	expect(appendEntry).toHaveBeenCalledWith(ADVISOR_ANCHOR_ENTRY, {
		entryId: expect.any(String),
		boundaryId: null,
	});
	const first = vi.mocked(completeSimple).mock.calls[0][1].messages;
	expect(JSON.stringify(first)).not.toContain("old-middle-0.ts");
	// The user's own words survive the trim even though the tool body did not.
	expect(JSON.stringify(first)).toContain("task");
	branch.push({
		type: "message",
		id: "result",
		parentId: branch.at(-1)?.id,
		message: makeToolResult({ toolCallId: "a1", toolName: "advisor", text: "advice", details: result.details }),
	} as never);
	branch.push({
		type: "message",
		id: "next",
		parentId: "result",
		message: makeAssistantMessage({
			text: "next question",
			toolCalls: [{ id: "a2", name: "advisor", arguments: {} }],
		}),
	} as never);
	await executeAdvisor(ctx, pi, undefined, undefined);
	// The saved anchor is replayed, so the boundary does not move and the second
	// request extends the first prefix instead of rewriting it.
	expect(appendEntry).toHaveBeenCalledTimes(1);
	const second = vi.mocked(completeSimple).mock.calls[1][1].messages;
	const firstStable = first.slice(0, first.length - 1);
	expect(second.slice(0, firstStable.length)).toEqual(firstStable);
});

it("skips an indivisible oversized question instead of dropping its content", async () => {
	setAdvisorModel(pricedModel as never);
	writeBudget({ perCallSoftUsd: 0, contextBudgetTokens: 100 });
	const ctx = createMockCtx({ branch: buildSessionEntries([makeUserMessage("question ".repeat(10000))]) });
	const result = await executeAdvisor(ctx, createMockPi().pi, undefined, undefined);
	expect(result.details).toMatchObject({ skipped: true, errorMessage: "context budget exceeded" });
	expect(completeSimple).not.toHaveBeenCalled();
});

it("does not replay Pi 0.86 executor system/tool snapshots into the advisor", async () => {
	setAdvisorModel(pricedModel as never);
	const branch = chained([
		{
			type: "message",
			message: { role: "system", content: "EXECUTOR SYSTEM", tools: [{ name: "dangerous-tool" }], timestamp: 0 } as never,
		},
		{ type: "message", message: makeUserMessage("task") },
	]);
	vi.mocked(completeSimple).mockResolvedValueOnce(resp({ text: "advice" }) as never);
	await executeAdvisor(createMockCtx({ branch }), createMockPi().pi, undefined, undefined);
	const sent = vi.mocked(completeSimple).mock.calls[0][1];
	// The advisor declares its own read-only surface and never the executor's.
	const declared = (sent.tools ?? []).map((t) => t.name);
	expect(declared).toContain("advisor_expand");
	expect(declared).not.toContain("dangerous-tool");
	for (const mutating of ["edit", "write", "bash"]) expect(declared).not.toContain(mutating);
	expect(JSON.stringify(sent.messages)).not.toContain("EXECUTOR SYSTEM");
	expect(JSON.stringify(sent.messages)).not.toContain("dangerous-tool");
});
