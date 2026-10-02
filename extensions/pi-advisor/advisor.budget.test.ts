import type { Api, Message, Model, Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildSessionEntries, createMockCtx, makeToolResult, makeUserMessage } from "./test/helpers.js";
import { describe, expect, it, vi } from "vitest";
import {
	advisorBranchUsage,
	approveAdvisorCost,
	estimateAdvisorRequest,
	refreshAdvisorStatus,
	sumAdvisorUsage,
} from "./advisor/budget.js";
import { validateAdvisorBudget } from "./advisor/config.js";

const model = {
	provider: "p",
	id: "m",
	api: "openai-responses",
	maxTokens: 1000,
	cost: { input: 10, cacheRead: 1, cacheWrite: 12.5, output: 50 },
} as Model<Api>;
const budget = validateAdvisorBudget(undefined);
const usage: Usage = {
	input: 10000,
	output: 500,
	cacheRead: 90000,
	cacheWrite: 0,
	totalTokens: 100500,
	cost: { input: 0.1, output: 0.025, cacheRead: 0.09, cacheWrite: 0, total: 0.215 },
};
const messages = [makeUserMessage("task")];
const first = estimateAdvisorRequest([], messages, "system", model, "high", budget, "advisor:session", 1000);
const result = makeToolResult({
	toolName: "advisor",
	details: {
		advisorModel: "p:m",
		effort: "high",
		usage,
		request: first.request,
		attempts: [{ usage, stopReason: "stop" }],
	},
});
const branch = buildSessionEntries([result]);
const estimate = (
	entries = branch,
	view: Message[] = [...messages, makeUserMessage("more")],
	now = 2000,
	currentModel = model,
	sessionId = "advisor:session",
	system = "system",
) => estimateAdvisorRequest(entries, view, system, currentModel, "high", budget, sessionId, now).estimate;

describe("advisor budget", () => {
	it("prices cold input without output history, then calibrates a matching warm prefix from actual usage", () => {
		expect(first.estimate.cacheReadTokens).toBe(0);
		// maxTokens (1000) is not treated as an expected output length.
		expect(first.estimate.outputTokens).toBe(0);
		expect(first.estimate.costUsd).toBeCloseTo((first.estimate.promptTokens * 10) / 1e6);
		const warm = estimate();
		expect(warm.promptTokens).toBe(100002);
		expect(warm.cacheReadTokens).toBe(100000);
		expect(warm.outputTokens).toBe(500);
		expect(warm.costUsd).toBeCloseTo((2 * 10 + 100000 + 500 * 50) / 1e6);
		expect(warm.sessionUsd).toBe(usage.cost.total);
	});

	it("treats expired, changed, compacted, forked, and unrelated prefixes as cold", () => {
		for (const cold of [
			estimate(branch, undefined, 1801000),
			estimate(branch, [makeUserMessage("changed inventory"), ...messages]),
			estimate([...branch, { type: "compaction" } as SessionEntry]),
			estimate([...branch, { type: "branch_summary" } as SessionEntry]),
			estimate([], messages),
			estimate(branch, undefined, 2000, { ...model, id: "other" }),
			estimate(branch, undefined, 2000, model, "advisor:fork"),
			estimate(branch, undefined, 2000, model, "advisor:session", "changed system"),
		])
			expect(cold.cacheReadTokens).toBe(0);
	});

	it("uses last-attempt prompt tokens, not the sum of retry inputs", () => {
		const retry = makeToolResult({
			toolName: "advisor",
			details: {
				advisorModel: "p:m",
				request: first.request,
				usage: sumAdvisorUsage([usage, usage]),
				attempts: [{ usage }, { usage }],
			},
		});
		expect(estimate(buildSessionEntries([retry])).cacheReadTokens).toBe(100000);
	});

	it("derives the ledger from the selected branch, counts errors, and never doubles top-level plus details usage", () => {
		const modern = { ...result, usage };
		const failed = makeToolResult({ toolName: "advisor", isError: true, details: { usage } });
		const other = makeToolResult({ toolName: "read", details: { usage } });
		expect(advisorBranchUsage(buildSessionEntries([modern, failed, other]))?.cost.total).toBeCloseTo(0.43);
		expect(advisorBranchUsage(buildSessionEntries([modern]))?.cost.total).toBe(0.215);
		expect(advisorBranchUsage([])).toBeUndefined();
	});

	it("adds all token and cost fields, including optional breakdowns, without mutating inputs", () => {
		const rich = { ...usage, reasoning: 3, cacheWrite1h: 4 };
		const summed = sumAdvisorUsage([undefined, rich, rich]);
		expect(summed).toMatchObject({
			input: 20000,
			output: 1000,
			cacheRead: 180000,
			totalTokens: 201000,
			reasoning: 6,
			cacheWrite1h: 8,
			cost: { input: 0.2, output: 0.05, cacheRead: 0.18, total: 0.43 },
		});
		expect(rich.cost.total).toBe(0.215);
	});

	it("confirms or skips hard and session limits, including the cost already spent on a retry", async () => {
		const ctx = createMockCtx({ hasUI: true });
		const cheap = estimate();
		expect(await approveAdvisorCost(ctx, cheap, budget)).toBe(true);
		expect(ctx.ui.confirm).not.toHaveBeenCalled();
		expect(await approveAdvisorCost(ctx, { ...cheap, costUsd: 4 }, budget)).toBe(true);
		expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
		vi.mocked(ctx.ui.confirm).mockResolvedValue(false);
		expect(await approveAdvisorCost(ctx, { ...cheap, sessionUsd: 20 }, budget)).toBe(false);
		expect(await approveAdvisorCost(ctx, cheap, budget, 3)).toBe(false);
		expect(await approveAdvisorCost(createMockCtx(), { ...cheap, costUsd: 4 }, budget)).toBe(false);
		expect(await approveAdvisorCost(ctx, { ...cheap, costUsd: 4 }, { ...budget, onExceed: "skip" })).toBe(false);
	});

	it("validates budget input and refreshes branch cost and cache share from persisted usage", () => {
		expect(
			validateAdvisorBudget({ perCallHardUsd: -1, sessionUsd: "10", warmWindowSec: Infinity, onExceed: "invalid" }),
		).toEqual(budget);
		expect(
			validateAdvisorBudget({ perCallHardUsd: 0, sessionUsd: 2, warmWindowSec: 0, timeoutSec: 0, onExceed: "skip" }),
		).toEqual({
			perCallSoftUsd: 1,
			contextBudgetTokens: 250000,
			perCallHardUsd: 0,
			sessionUsd: 2,
			warmWindowSec: 0,
			timeoutSec: 0,
			onExceed: "skip",
		});
		expect(validateAdvisorBudget(undefined).timeoutSec).toBe(420);
		expect(validateAdvisorBudget({ timeoutSec: -5 }).timeoutSec).toBe(420);
		const ctx = createMockCtx({ hasUI: true, branch });
		refreshAdvisorStatus(ctx);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("advisor", "Advisor $0.21 · cache 90%");
		vi.mocked(ctx.sessionManager.getBranch).mockReturnValue([]);
		refreshAdvisorStatus(ctx);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("advisor", undefined);
	});
});

it.each(["error", "aborted"])("does not budget cache hits from a %s response", (stopReason) => {
	const failed = makeToolResult({
		toolName: "advisor",
		details: { advisorModel: "p:m", request: first.request, usage, attempts: [{ usage, stopReason }] },
	});
	expect(estimate(buildSessionEntries([failed])).cacheReadTokens).toBe(0);
});
