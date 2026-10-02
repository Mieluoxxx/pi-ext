import type { Api, AssistantMessage, Context, Model, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { AdvisorAttempt } from "./advisor/budget.js";
import { type AdvisorLoopRound, runAdvisorLoop } from "./advisor/loop.js";
import type { AdvisorToolRuntime } from "./advisor/tools.js";
import { makeUserMessage } from "./test/helpers.js";

const model = { provider: "p", id: "reviewer", api: "openai-responses" } as Model<Api>;
const usage: Usage = {
	input: 100,
	output: 10,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 110,
	cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.2 },
};

const answer = (text: string): AssistantMessage =>
	({ role: "assistant", content: [{ type: "text", text }], stopReason: "done", usage, timestamp: 0 }) as never;
const callTool = (name: string, args: object = {}, id = "t1"): AssistantMessage =>
	({
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		stopReason: "toolUse",
		usage,
		timestamp: 0,
	}) as never;

function harness(options: { tools?: Partial<AdvisorToolRuntime>; maxRounds?: number } = {}) {
	const attempts: AdvisorAttempt[] = [];
	const rounds: AdvisorLoopRound[] = [];
	const declarations = [
		{ name: "advisor_expand", description: "d", parameters: { type: "object" } as never },
		{ name: "read", description: "d", parameters: { type: "object" } as never },
	];
	const run = vi.fn(async () => ({ text: "tool output" }));
	const tools: AdvisorToolRuntime = { declarations, run, ...options.tools } as AdvisorToolRuntime;
	const complete = vi.fn<(m: Model<Api>, c: Context) => Promise<AssistantMessage>>();
	const base: Context = { systemPrompt: "review", messages: [makeUserMessage("question")], tools: declarations };
	return {
		attempts,
		rounds,
		run,
		complete,
		tools,
		invoke: (over: Partial<Parameters<typeof runAdvisorLoop>[0]> = {}) =>
			runAdvisorLoop({
				model,
				base,
				requestOptions: { sessionId: "advisor:test" },
				complete: complete as never,
				tools,
				maxRounds: options.maxRounds ?? 2,
				approve: async () => true,
				attempts,
				rounds,
				...over,
			}),
	};
}

describe("advisor loop", () => {
	it("returns advice from a single request when no tool is called", async () => {
		const h = harness();
		h.complete.mockResolvedValueOnce(answer("advice"));
		const out = await h.invoke();
		expect(out.text).toBe("advice");
		expect(h.complete).toHaveBeenCalledTimes(1);
		expect(h.attempts).toHaveLength(1);
	});

	it("runs a tool, feeds the result back, and answers on the next request", async () => {
		const h = harness();
		h.complete.mockResolvedValueOnce(callTool("read", { path: "a.ts" })).mockResolvedValueOnce(answer("informed advice"));
		const out = await h.invoke();
		expect(out.text).toBe("informed advice");
		expect(h.run).toHaveBeenCalledWith("read", { path: "a.ts" }, undefined);
		expect(h.rounds).toEqual([{ tool: "read", argument: "a.ts", chars: 11, isError: undefined }]);
		// The tool result must reach the model as a paired toolResult message.
		const second = h.complete.mock.calls[1][1];
		expect(JSON.stringify(second.messages)).toContain("tool output");
	});

	it("keeps the tool declarations byte-identical on every request", async () => {
		const h = harness({ maxRounds: 1 });
		h.complete
			.mockResolvedValueOnce(callTool("read"))
			.mockResolvedValueOnce(callTool("read", {}, "t2"))
			.mockResolvedValueOnce(answer("done"));
		await h.invoke();
		const sent = h.complete.mock.calls.map((c) => JSON.stringify(c[1].tools));
		// A withdrawn tool list would rewrite the head of the cached prefix.
		expect(new Set(sent).size).toBe(1);
		expect(sent[0]).toContain("advisor_expand");
	});

	it("stops running tools past the round budget and tells the model in-band", async () => {
		const h = harness({ maxRounds: 1 });
		h.complete
			.mockResolvedValueOnce(callTool("read"))
			.mockResolvedValueOnce(callTool("read", {}, "t2"))
			.mockResolvedValueOnce(answer("final"));
		const out = await h.invoke();
		expect(out.text).toBe("final");
		expect(out.budgetExhausted).toBe(true);
		expect(h.run).toHaveBeenCalledTimes(1);
		// Every call still gets a result, so the transcript stays well-formed.
		const last = h.complete.mock.calls[2][1].messages;
		const serialized = JSON.stringify(last);
		expect(serialized).toContain("Tool budget exhausted");
		expect(serialized).toContain("investigation budget is spent");
	});

	it("prices every request against the caller's budget and stops when refused", async () => {
		const h = harness();
		h.complete.mockResolvedValueOnce(callTool("read")).mockResolvedValueOnce(answer("never reached"));
		const approve = vi.fn(async (spent: number) => spent === 0);
		const out = await h.invoke({ approve });
		expect(out.errorMessage).toBe("budget exceeded or declined");
		// Second request refused because the first attempt already cost money.
		expect(approve.mock.calls.map((c) => c[0])).toEqual([0, 0.2]);
		expect(h.complete).toHaveBeenCalledTimes(1);
	});

	it("aborts before dispatch when the signal is already set", async () => {
		const h = harness();
		const controller = new AbortController();
		controller.abort();
		const out = await h.invoke({ signal: controller.signal });
		expect(out.stopReason).toBe("aborted");
		expect(h.complete).not.toHaveBeenCalled();
	});

	it("surfaces provider error and aborted stop reasons without retrying", async () => {
		for (const stopReason of ["error", "aborted"] as const) {
			const h = harness();
			h.complete.mockResolvedValueOnce({ ...answer(""), stopReason, errorMessage: "502" } as never);
			const out = await h.invoke();
			expect(out.stopReason).toBe(stopReason);
			expect(h.complete).toHaveBeenCalledTimes(1);
		}
	});

	it("retries an empty response exactly once", async () => {
		const h = harness();
		h.complete.mockResolvedValueOnce(answer("  ")).mockResolvedValueOnce(answer("recovered"));
		expect((await h.invoke()).text).toBe("recovered");
		expect(h.complete).toHaveBeenCalledTimes(2);

		const h2 = harness();
		h2.complete.mockResolvedValue(answer(""));
		const out = await h2.invoke();
		expect(out.errorMessage).toBe("empty response");
		expect(h2.complete).toHaveBeenCalledTimes(2);
	});

	it("keeps billed attempts when the transport throws mid-loop", async () => {
		const h = harness();
		h.complete.mockResolvedValueOnce(callTool("read")).mockRejectedValueOnce(new Error("socket closed"));
		await expect(h.invoke()).rejects.toThrow("socket closed");
		// The caller owns the array, so the first paid attempt survives the throw.
		expect(h.attempts).toHaveLength(2);
		expect(h.attempts[0].usage?.cost.total).toBe(0.2);
		expect(h.attempts[1].stopReason).toBe("error");
	});

	it("reports the first request so its prefix can be kept warm", async () => {
		const h = harness();
		h.complete.mockResolvedValueOnce(callTool("read")).mockResolvedValueOnce(answer("advice"));
		const onFirstRequest = vi.fn();
		const out = await h.invoke({ onFirstRequest });
		expect(onFirstRequest).toHaveBeenCalledTimes(1);
		// The warm candidate is the consultation's opening request, not a
		// mid-investigation one whose transcript no later call will repeat.
		expect(JSON.stringify(out.firstRequest?.context.messages)).not.toContain("tool output");
	});

	it("records a tool error as a round without ending the consultation", async () => {
		const h = harness();
		h.run.mockResolvedValueOnce({ text: "denied by policy", isError: true } as never);
		h.complete.mockResolvedValueOnce(callTool("read", { path: ".env" })).mockResolvedValueOnce(answer("advice anyway"));
		const out = await h.invoke();
		expect(out.text).toBe("advice anyway");
		expect(h.rounds[0].isError).toBe(true);
	});

	it("refuses tool calls outright when no tool runtime is supplied", async () => {
		const h = harness();
		h.complete.mockResolvedValueOnce(callTool("read")).mockResolvedValueOnce(answer("text only"));
		const out = await h.invoke({ tools: undefined, maxRounds: 0 });
		expect(out.text).toBe("text only");
		expect(h.run).not.toHaveBeenCalled();
		expect(JSON.stringify(h.complete.mock.calls[0][1].tools)).toBe("[]");
	});
});
