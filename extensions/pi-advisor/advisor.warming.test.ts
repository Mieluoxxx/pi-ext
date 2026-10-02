import { homedir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { createMockCtx, createMockPi, makeUserMessage } from "./test/helpers.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { advisorBranchUsage, estimateAdvisorRequest } from "./advisor/budget.js";
import { validateAdvisorBudget, validateAdvisorWarming } from "./advisor/config.js";
import { setAdvisorModel } from "./advisor/state.js";
import {
	advisorPayloadHash,
	advisorWarmingEconomics,
	registerAdvisorWarming,
	rememberAdvisorRequest,
	stopAdvisorWarming,
} from "./advisor/warming.js";

const model = {
	provider: "p",
	id: "reviewer",
	api: "openai-responses",
	maxTokens: 1000,
	cost: { input: 10, cacheRead: 1, cacheWrite: 12.5, output: 50 },
	promptCache: { short: 60 },
} as unknown as Model<Api>;
const usage: Usage = {
	input: 0,
	output: 16,
	cacheRead: 200000,
	cacheWrite: 0,
	totalTokens: 200016,
	cost: { input: 0, output: 0.0008, cacheRead: 0.2, cacheWrite: 0, total: 0.2008 },
};
const payload = { model: model.id, input: [{ role: "user", content: "question" }], tools: [], max_output_tokens: 1000 };
const response = { role: "assistant", content: [], stopReason: "length", usage } as unknown as AssistantMessage;
const writeConfig = (config: unknown) => {
	const path = join(homedir(), ".config/rpiv-advisor/advisor.json");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(config));
};
afterEach(() => {
	vi.useRealTimers();
});

async function setup(withRecorder = true) {
	vi.useFakeTimers();
	vi.setSystemTime(100000);
	setAdvisorModel(model);
	const branch: SessionEntry[] = [];
	const { pi, captured } = createMockPi();
	const ctx = createMockCtx({ branch, hasUI: true, model: { ...model, id: "executor" } });
	vi.mocked(ctx.isIdle).mockReturnValue(false);
	const appendUsage = vi.fn((kind, provider, id, usage, note) => {
		branch.push({ type: "usage", kind, provider, model: id, usage, note } as unknown as SessionEntry);
	});
	if (withRecorder) Object.assign(ctx.sessionManager, { appendUsage });
	const complete = vi.fn(async (_model, _context, options) => {
		const p = structuredClone(payload);
		await options.onPayload?.(p);
		expect(p.max_output_tokens).toBe(16);
		return response;
	});
	registerAdvisorWarming(pi);
	await captured.events.get("agent_start")?.[0]({}, ctx);
	const context = { systemPrompt: "review", messages: [makeUserMessage("question")], tools: [] };
	const measured = estimateAdvisorRequest(
		branch,
		context.messages,
		context.systemPrompt,
		model,
		undefined,
		validateAdvisorBudget(undefined),
		"advisor:test-session",
	);
	const candidate = {
		ctx,
		model,
		context,
		options: { sessionId: "advisor:test-session" },
		request: { ...measured.request, payloadHash: advisorPayloadHash(payload) },
		usage,
		complete,
	};
	return { pi, captured, ctx, branch, appendUsage, complete, candidate };
}

describe("advisor cache maintenance", () => {
	it("refreshes before TTL, preserves context and route, caps output, and records fees once", async () => {
		const s = await setup();
		rememberAdvisorRequest(s.pi, s.candidate);
		await vi.advanceTimersByTimeAsync(49999);
		expect(s.complete).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(s.complete).toHaveBeenCalledTimes(1);
		expect(s.complete.mock.calls[0][1]).toBe(s.candidate.context);
		expect(s.complete.mock.calls[0][2]).toMatchObject({
			sessionId: "advisor:test-session",
			maxTokens: 16,
			maxRetries: 0,
		});
		expect(s.appendUsage).toHaveBeenCalledTimes(1);
		expect(advisorBranchUsage(s.branch)?.cost.total).toBe(usage.cost.total);
		const next = estimateAdvisorRequest(
			s.branch,
			s.candidate.context.messages,
			"review",
			model,
			undefined,
			validateAdvisorBudget(undefined),
			"advisor:test-session",
		);
		expect(next.estimate.cacheReadTokens).toBe(200000);
		expect(next.estimate.outputTokens).toBe(0); // maintenance outputs do not bias consultation estimates
		await stopAdvisorWarming(s.pi);
	});

	it.each([
		"no-recorder",
		"idle",
		"same-model",
		"budget",
		"no-benefit",
		"small",
		"disabled",
		"unknown-ttl",
		"inventory",
		"expired",
	])("skips a refresh when %s", async (reason) => {
		const s = await setup(reason !== "no-recorder");
		if (reason === "idle") vi.mocked(s.ctx.isIdle).mockReturnValue(true);
		if (reason === "same-model") s.ctx.model = model;
		if (reason === "budget") writeConfig({ budget: { sessionUsd: 1 } });
		if (reason === "no-benefit") writeConfig({ warming: { continueProbability: 0 } });
		if (reason === "disabled") writeConfig({ warming: { enabled: false } });
		if (reason === "small") s.candidate.usage = { ...usage, cacheRead: 100 };
		if (reason === "unknown-ttl") s.candidate.model = { ...model, promptCache: undefined } as Model<Api>;
		rememberAdvisorRequest(s.pi, s.candidate);
		if (reason === "inventory")
			s.captured.allTools.push({ name: "new", description: "new", parameters: {} } as never);
		if (reason === "expired") vi.setSystemTime(200000);
		await vi.advanceTimersByTimeAsync(50000);
		expect(s.complete).not.toHaveBeenCalled();
		await stopAdvisorWarming(s.pi);
	});

	it.each([
		"agent_end",
		"session_before_compact",
		"session_before_tree",
		"session_before_switch",
		"session_before_fork",
		"session_shutdown",
		"model_select",
		"thinking_level_select",
	])("cancels scheduling on %s", async (event) => {
		const s = await setup();
		rememberAdvisorRequest(s.pi, s.candidate);
		await s.captured.events.get(event)?.[0]({}, s.ctx);
		await vi.advanceTimersByTimeAsync(60000);
		expect(s.complete).not.toHaveBeenCalled();
	});

	it("aborts and records an in-flight refresh before branch navigation finishes", async () => {
		const s = await setup();
		s.complete.mockImplementationOnce(
			async (_m, _c, options) =>
				new Promise((resolve) => {
					options.signal.addEventListener("abort", () => resolve({ ...response, stopReason: "aborted" }));
				}),
		);
		rememberAdvisorRequest(s.pi, s.candidate);
		await vi.advanceTimersByTimeAsync(50000);
		await s.captured.events.get("session_before_tree")?.[0]({}, s.ctx);
		expect(s.appendUsage).toHaveBeenCalledTimes(1);
		expect(JSON.parse(s.appendUsage.mock.calls[0][4]).stopReason).toBe("aborted");
		await vi.advanceTimersByTimeAsync(60000);
		expect(s.complete).toHaveBeenCalledTimes(1);
	});

	it("stops after a cache miss and still records its full cost", async () => {
		const s = await setup();
		s.complete.mockResolvedValueOnce({ ...response, usage: { ...usage, input: 200000, cacheRead: 0 } });
		rememberAdvisorRequest(s.pi, s.candidate);
		await vi.advanceTimersByTimeAsync(200000);
		expect(s.complete).toHaveBeenCalledTimes(1);
		expect(s.appendUsage).toHaveBeenCalledTimes(1);
		await stopAdvisorWarming(s.pi);
	});

	it("rejects changed provider payloads before a paid dispatch", async () => {
		const s = await setup();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		s.complete.mockImplementationOnce(async (_m, _c, options) => {
			await options.onPayload({ ...payload, input: [{ role: "user", content: "changed" }] });
			throw new Error("must not reach network");
		});
		rememberAdvisorRequest(s.pi, s.candidate);
		await vi.advanceTimersByTimeAsync(50000);
		expect(s.appendUsage).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("prompt changed"));
		warn.mockRestore();
		await stopAdvisorWarming(s.pi);
	});

	it("validates tuning parameters and computes net expected savings", () => {
		const config = validateAdvisorWarming({ continueProbability: 2, ttlSec: -2, minSavingsUsd: "0" });
		expect(config).toMatchObject({ enabled: true, continueProbability: 1, ttlSec: 0, minSavingsUsd: 0.05 });
		const economics = advisorWarmingEconomics(model, usage, validateAdvisorWarming(undefined));
		expect(economics.refreshUsd).toBeCloseTo(0.2008);
		expect(economics.expectedSavingsUsd).toBeCloseTo(0.1592);
	});
});

it.each(["openai-responses", "anthropic-messages", "openai-completions"] as const)(
	"keeps real %s serialization identical when only the refresh output cap changes",
	async (api) => {
		const { streamSimple } = await import(`@earendil-works/pi-ai/api/${api}`);
		const actualModel = {
			...model,
			api,
			name: "test",
			baseUrl: "http://127.0.0.1:1",
			reasoning: false,
			input: ["text"],
			contextWindow: 100000,
		};
		const hashes: string[] = [];
		for (const maxTokens of [1000, 16]) {
			await streamSimple(
				actualModel,
				{ systemPrompt: "review", messages: [makeUserMessage("question")], tools: [] },
				{
					apiKey: "test",
					sessionId: "advisor:test",
					maxTokens,
					onPayload(p: unknown) {
						hashes.push(advisorPayloadHash(p));
						throw new Error("captured before network");
					},
				},
			).result();
		}
		expect(hashes).toHaveLength(2);
		expect(hashes[0]).toBe(hashes[1]);
	},
);
