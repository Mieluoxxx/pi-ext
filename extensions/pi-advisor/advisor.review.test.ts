import type { Message, Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { ADVISOR_REVIEW_USAGE, advisorBranchUsage } from "./advisor/budget.js";
import { validateAdvisorLedger } from "./advisor/config.js";
import { REVIEW_INSTRUCTION, renderLedger } from "./advisor/ledger.js";
import { ADVISOR_REVIEW_TYPE, ADVISOR_TOOL_NAME } from "./advisor/messages.js";
import {
	DEFAULT_PROMPT_GUIDELINES,
	parseAdvisorSeverity,
	REVIEW_PROMPT_GUIDELINES,
	registerAdvisorReview,
	registerAdvisorTool,
	reviewableRun,
	setAdvisorModel,
} from "./advisor/index.js";
import { chained, createMockCtx, createMockPi, makeAssistantMessage, makeToolResult, makeUserMessage } from "./test/helpers.js";

const usage: Usage = {
	input: 1000,
	output: 50,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 1050,
	cost: { input: 0.01, output: 0.0025, cacheRead: 0, cacheWrite: 0, total: 0.0125 },
};

const answer = (text: string) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	stopReason: "stop",
	usage,
	timestamp: Date.now(),
});

const msg = (message: Message | object) => ({ type: "message", message }) as never;
const withStop = (message: Message, stopReason: string) => ({ ...message, stopReason }) as Message;

/** user → one tool round → final text answer */
function workedRun(final = "Done: the fix is in a.ts.") {
	return chained([
		msg(makeUserMessage("fix the bug")),
		msg(makeAssistantMessage({ toolCalls: [{ id: "t1", name: "edit", arguments: { path: "a.ts" } }] })),
		msg(makeToolResult({ toolCallId: "t1", toolName: "edit", text: "ok" })),
		msg(withStop(makeAssistantMessage({ text: final }), "stop")),
	]);
}

function writeConfig(data: Record<string, unknown>) {
	const path = join(homedir(), ".config/rpiv-advisor/advisor.json");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(data));
}

function harness(options: { branch?: SessionEntry[]; idle?: () => boolean; recorder?: boolean } = {}) {
	const branch = options.branch ?? workedRun();
	const sendMessage = vi.fn();
	const { pi, captured } = createMockPi({ sendMessage } as never);
	registerAdvisorReview(pi);
	const ctx = createMockCtx({ branch, hasUI: true });
	const appendUsage = vi.fn();
	if (options.recorder !== false) Object.assign(ctx.sessionManager, { appendUsage });
	if (options.idle) vi.mocked(ctx.isIdle).mockImplementation(options.idle);
	const fire = async (name: string) => {
		for (const handler of captured.events.get(name) ?? []) await handler({ type: name }, ctx);
	};
	return { pi, ctx, sendMessage, appendUsage, fire, settle: () => fire("agent_settled") };
}

beforeEach(() => {
	vi.mocked(completeSimple).mockReset();
	setAdvisorModel({ provider: "a", id: "m" } as never);
});

describe("parseAdvisorSeverity", () => {
	it("reads the verdict line and returns the guidance after it", () => {
		expect(parseAdvisorSeverity("Severity: concern\n- check x")).toEqual({ severity: "concern", body: "- check x" });
		expect(parseAdvisorSeverity("**Severity:** Blocker\nstop")).toEqual({ severity: "blocker", body: "stop" });
		expect(parseAdvisorSeverity("  Severity: none")).toEqual({ severity: "none", body: "" });
	});

	it("returns no severity when the advisor ignored the format", () => {
		expect(parseAdvisorSeverity("Looks fine.\nSeverity: none")).toEqual({ body: "Looks fine.\nSeverity: none" });
	});
});

describe("reviewableRun", () => {
	it("accepts a run that did tool work and ended in a text answer", () => {
		const branch = workedRun();
		expect(reviewableRun(branch, 1)).toEqual({ finalEntryId: branch[3].id, userEntryId: branch[0].id });
	});

	it("skips pure chat below the tool-call floor", () => {
		const branch = chained([msg(makeUserMessage("hi")), msg(withStop(makeAssistantMessage({ text: "hello" }), "stop"))]);
		expect(reviewableRun(branch, 1)).toBeUndefined();
		expect(reviewableRun(branch, 0)).toBeDefined();
	});

	it("skips a run that ended aborted, in error, or mid tool call", () => {
		const base = workedRun().slice(0, 3);
		for (const last of [
			withStop(makeAssistantMessage({ text: "partial" }), "aborted"),
			withStop(makeAssistantMessage({ text: "failed" }), "error"),
			makeAssistantMessage({ text: "next", toolCalls: [{ id: "t2", name: "read", arguments: {} }] }),
		])
			expect(reviewableRun(chained([...base, msg(last)]), 1)).toBeUndefined();
	});

	it("skips when the executor already consulted the advisor after its last work", () => {
		const branch = chained([
			...workedRun().slice(0, 3),
			msg(makeAssistantMessage({ toolCalls: [{ id: "a1", name: ADVISOR_TOOL_NAME, arguments: {} }] })),
			msg(makeToolResult({ toolCallId: "a1", toolName: ADVISOR_TOOL_NAME, text: "Severity: none" })),
			msg(withStop(makeAssistantMessage({ text: "done" }), "stop")),
		]);
		expect(reviewableRun(branch, 1)).toBeUndefined();
	});

	it("still reviews when more work followed the last consultation", () => {
		const branch = chained([
			msg(makeUserMessage("fix the bug")),
			msg(makeAssistantMessage({ toolCalls: [{ id: "a1", name: ADVISOR_TOOL_NAME, arguments: {} }] })),
			msg(makeToolResult({ toolCallId: "a1", toolName: ADVISOR_TOOL_NAME, text: "plan" })),
			msg(makeAssistantMessage({ toolCalls: [{ id: "t1", name: "edit", arguments: {} }] })),
			msg(makeToolResult({ toolCallId: "t1", toolName: "edit", text: "ok" })),
			msg(withStop(makeAssistantMessage({ text: "done" }), "stop")),
		]);
		expect(reviewableRun(branch, 1)).toBeDefined();
	});
});

describe("registerAdvisorReview", () => {
	it("does nothing while review is disabled", async () => {
		const h = harness();
		await h.settle();
		await new Promise((r) => setTimeout(r, 0));
		expect(completeSimple).not.toHaveBeenCalled();
	});

	it("wakes the executor for a blocker and bills the review natively", async () => {
		writeConfig({ review: { enabled: true } });
		vi.mocked(completeSimple).mockResolvedValueOnce(answer("Severity: blocker\nTests were never run.") as never);
		const h = harness();
		await h.settle();
		await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledTimes(1));
		const [message, options] = h.sendMessage.mock.calls[0];
		expect(message).toMatchObject({ customType: ADVISOR_REVIEW_TYPE, display: true });
		expect(message.content).toContain('<advisory severity="blocker" source="completion review"');
		expect(message.content).toContain("Tests were never run.");
		expect(message.details).toMatchObject({ severity: "blocker", advice: "Severity: blocker\nTests were never run." });
		expect(options).toEqual({ triggerTurn: true });
		expect(h.appendUsage).toHaveBeenCalledWith(ADVISOR_REVIEW_USAGE, "a", "m", expect.objectContaining({ input: 1000 }), expect.any(String));
		// The review request closes on the review instruction, not the consultation one.
		const context = vi.mocked(completeSimple).mock.calls[0][1];
		expect(JSON.stringify(context.messages)).toContain("Review the delivered work");
	});

	it("shows a concern as a card without starting a turn", async () => {
		writeConfig({ review: { enabled: true } });
		vi.mocked(completeSimple).mockResolvedValueOnce(answer("Severity: concern\nCheck the null path.") as never);
		const h = harness();
		await h.settle();
		await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledTimes(1));
		expect(h.sendMessage.mock.calls[0][1]).toBeUndefined();
	});

	it("stays silent on `none` but still records the spend", async () => {
		writeConfig({ review: { enabled: true } });
		vi.mocked(completeSimple).mockResolvedValueOnce(answer("Severity: none\nThe answer holds.") as never);
		const h = harness();
		await h.settle();
		await vi.waitFor(() => expect(h.appendUsage).toHaveBeenCalledTimes(1));
		expect(h.sendMessage).not.toHaveBeenCalled();
	});

	it("holds a review for the next prompt once the user has started another run", async () => {
		writeConfig({ review: { enabled: true } });
		vi.mocked(completeSimple).mockResolvedValueOnce(answer("Severity: blocker\nBroken.") as never);
		let idle = true;
		const h = harness({ idle: () => idle });
		await h.settle();
		idle = false;
		await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledTimes(1));
		expect(h.sendMessage.mock.calls[0][1]).toEqual({ deliverAs: "nextTurn" });
	});

	it("never starts a paid review on a host without native usage recording", async () => {
		writeConfig({ review: { enabled: true } });
		const h = harness({ recorder: false });
		await h.settle();
		await new Promise((r) => setTimeout(r, 0));
		expect(completeSimple).not.toHaveBeenCalled();
	});

	it("reviews one final answer once and wakes at most once per user prompt", async () => {
		writeConfig({ review: { enabled: true } });
		vi.mocked(completeSimple).mockResolvedValue(answer("Severity: blocker\nStill broken.") as never);
		const branch = workedRun();
		const h = harness({ branch });
		await h.settle();
		await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledTimes(1));
		await h.settle();
		await new Promise((r) => setTimeout(r, 0));
		expect(completeSimple).toHaveBeenCalledTimes(1);

		// The woken turn produced a new answer to the same prompt: review it, but do not wake again.
		branch.push(...chained([msg(withStop(makeAssistantMessage({ text: "fixed?" }), "stop"))]).map((e) => ({
			...e,
			id: "entry-retry",
			parentId: branch.at(-1)!.id,
		})));
		await h.settle();
		await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledTimes(2));
		expect(h.sendMessage.mock.calls[1][1]).toBeUndefined();
	});

	it("drops an in-flight review when the session switches", async () => {
		writeConfig({ review: { enabled: true } });
		vi.mocked(completeSimple).mockImplementationOnce(
			(_model, _context, options) =>
				new Promise((resolve) => {
					(options as { signal?: AbortSignal }).signal?.addEventListener("abort", () =>
						resolve({ ...answer(""), stopReason: "aborted", content: [] } as never),
					);
				}),
		);
		const h = harness();
		await h.settle();
		await vi.waitFor(() => expect(completeSimple).toHaveBeenCalledTimes(1));
		await h.fire("session_before_switch");
		await new Promise((r) => setTimeout(r, 0));
		expect(h.sendMessage).not.toHaveBeenCalled();
	});
});

describe("review in the ledger and the budget", () => {
	const limits = validateAdvisorLedger(undefined);

	it("replays a delivered review as the advisor's own past answer", () => {
		const branch = chained([
			...workedRun(),
			{
				type: "custom_message",
				customType: ADVISOR_REVIEW_TYPE,
				content: '<advisory severity="concern">Check the null path.</advisory>',
				display: true,
				details: { severity: "concern", advice: "Severity: concern\nCheck the null path." },
			} as never,
			msg(makeUserMessage("ok, continue")),
		]);
		const view = renderLedger(branch, branch.at(-1)!.id, { limits, tailToolCalls: 0 });
		const advice = view.messages.find((m) => m.role === "assistant");
		expect(JSON.stringify(advice?.content)).toContain("Severity: concern\\nCheck the null path.");
		const serialized = JSON.stringify(view.messages);
		expect(serialized).toContain("Completion review: the executor had just delivered the answer above.");
		expect(serialized).not.toContain("[extension message: advisor-review]");
	});

	it("closes a review request on the review instruction", () => {
		const branch = workedRun();
		const view = renderLedger(branch, branch.at(-1)!.id, { limits, tailToolCalls: 2, instruction: REVIEW_INSTRUCTION });
		expect(JSON.stringify(view.messages.at(-1))).toContain("Review the delivered work");
		expect(JSON.stringify(view.messages.at(-1))).toContain("Done: the fix is in a.ts.");
	});

	it("counts native review usage toward the branch spend", () => {
		const branch = chained([
			...workedRun(),
			{ type: "usage", kind: ADVISOR_REVIEW_USAGE, provider: "a", model: "m", usage, note: "{}" } as never,
		]);
		expect(advisorBranchUsage(branch)?.cost.total).toBeCloseTo(0.0125);
	});
});

describe("executor guidance with review enabled", () => {
	it("drops the before-done consultation guideline", () => {
		writeConfig({ review: { enabled: true } });
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const tool = captured.tools.get(ADVISOR_TOOL_NAME)!;
		expect(tool.promptGuidelines).toBe(REVIEW_PROMPT_GUIDELINES);
		expect(tool.promptSnippet).not.toContain("before declaring done");
		expect(REVIEW_PROMPT_GUIDELINES.join(" ")).not.toContain("when you believe the task is complete");
		expect(DEFAULT_PROMPT_GUIDELINES.join(" ")).toContain("when you believe the task is complete");
	});
});
