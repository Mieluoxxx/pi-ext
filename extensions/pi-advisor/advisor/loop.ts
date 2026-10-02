/**
 * loop — the advisor's bounded tool-use loop.
 *
 * Implemented directly over `completeSimple` rather than a nested AgentSession
 * on purpose: this module owns the request prefix (so prompt caching keeps
 * working across consultations) and every round is priced against the caller's
 * budget before it is sent. A nested session would also inherit pi's
 * auto-compaction, whose summariser is written for an executor and rewrites a
 * reviewer's transcript into "the task I am working on".
 *
 * Two rules keep the cache intact:
 *   - The tool DECLARATIONS never change between rounds. Running out of rounds
 *     appends an instruction; it does not withdraw the tools, which would
 *     rewrite the head of the prefix and cold-start the next request.
 *   - Investigation rounds are not replayed into later consultations. The
 *     ledger carries only the final advice, so the next request diverges from
 *     this one only after the question.
 */

import type {
	Api,
	AssistantMessage,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	StopReason,
	ToolCall,
	Usage,
} from "@earendil-works/pi-ai";
import type { AdvisorAttempt } from "./budget.js";
import type { AdvisorToolRuntime } from "./tools.js";

const BUDGET_EXHAUSTED =
	"Your investigation budget is spent. Do not call any more tools — answer now with the guidance the executor needs, " +
	"based on what you already have. Say plainly where evidence was missing rather than guessing.";

const REFUSED_AFTER_BUDGET = "Tool budget exhausted — no further tool calls will run. Answer with what you have.";

const TRANSIENT_RETRY_DELAY_MS = 2000;

/** Resolves false when the signal aborts before the delay elapses. */
function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
	if (signal?.aborted) return Promise.resolve(false);
	return new Promise((resolve) => {
		const onAbort = () => {
			clearTimeout(timer);
			resolve(false);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve(true);
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export interface AdvisorLoopRound {
	tool: string;
	/** Compact argument preview; full arguments stay out of the transcript. */
	argument?: string;
	chars: number;
	isError?: boolean;
	/** Images this round returned, counted for the result envelope. */
	images?: number;
}

export interface AdvisorLoopOutcome {
	text: string;
	stopReason?: StopReason;
	errorMessage?: string;
	attempts: AdvisorAttempt[];
	/** What the advisor looked at, for the result envelope and the UI. */
	rounds: AdvisorLoopRound[];
	/** The request as first dispatched — the prefix a warm cache reuses. */
	firstRequest?: { context: Context; usage: Usage };
	/** True when the loop stopped because its round budget ran out. */
	budgetExhausted?: boolean;
}

type CompleteSimple = (model: Model<Api>, context: Context, options: SimpleStreamOptions) => Promise<AssistantMessage>;

function textOf(response: AssistantMessage): string {
	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();
}

function toolCallsOf(response: AssistantMessage): ToolCall[] {
	return response.content.filter((c): c is ToolCall => c.type === "toolCall");
}

function preview(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	for (const value of Object.values(args as Record<string, unknown>)) {
		if (typeof value === "string" && value.trim()) return value.length > 80 ? `${value.slice(0, 80)}…` : value;
		if (Array.isArray(value) && value.length) return value.slice(0, 4).join(", ");
	}
	return undefined;
}

export interface AdvisorLoopOptions {
	model: Model<Api>;
	base: Context;
	requestOptions: SimpleStreamOptions;
	complete: CompleteSimple;
	tools?: AdvisorToolRuntime;
	/** Extra model requests the advisor may spend on investigation. */
	maxRounds: number;
	signal?: AbortSignal;
	/** Called before every request; false aborts the loop (budget refused). */
	approve: (spent: number) => Promise<boolean>;
	/** Progress line for the executor's tool card. */
	onProgress?: (note: string) => void;
	/** Marks the request whose prefix should be kept warm. */
	onFirstRequest?: (context: Context, usage: Usage) => void;
	/** True for a failed response worth re-sending; at most one per consultation. */
	isTransient?: (response: AssistantMessage) => boolean;
	/**
	 * Caller-owned sinks. The loop appends as it goes rather than returning them
	 * at the end, so a transport throw on round N still leaves rounds 1..N-1
	 * billed and visible to the caller's catch arm.
	 */
	attempts: AdvisorAttempt[];
	rounds: AdvisorLoopRound[];
}

/**
 * Run the consultation.
 *
 * Returns the final advice text, every billed attempt, and the investigation
 * trace. An empty response is retried exactly once — preserved from the
 * single-shot implementation, where an empty first reply was common enough to
 * be worth one retry and rare enough not to warrant more. A transient provider
 * failure is likewise re-sent once: the executor is blocked on this call, and
 * an error result after a long wait is the worst outcome it can get.
 */
export async function runAdvisorLoop(options: AdvisorLoopOptions): Promise<AdvisorLoopOutcome> {
	const { model, complete, tools, signal, attempts, rounds } = options;
	const declarations = tools?.declarations ?? [];
	const conversation: Message[] = [...options.base.messages];
	let budgetExhausted = false;
	let firstRequest: AdvisorLoopOutcome["firstRequest"];
	let emptyRetried = false;
	let transientRetried = false;

	const spent = () =>
		attempts.reduce((sum, attempt) => sum + (attempt.usage?.cost.total ?? 0), 0);

	const finish = (
		text: string,
		stopReason?: StopReason,
		errorMessage?: string,
	): AdvisorLoopOutcome => ({
		text,
		stopReason,
		errorMessage,
		attempts,
		rounds,
		firstRequest,
		...(budgetExhausted ? { budgetExhausted: true } : {}),
	});

	// One request per iteration; +3 covers the final answer turn, the single
	// empty-response retry and the single transient-error retry on top of the
	// investigation allowance.
	for (let request = 0; request <= options.maxRounds + 3; request++) {
		if (signal?.aborted) return finish("", "aborted", "aborted");
		if (!(await options.approve(spent()))) return finish("", undefined, "budget exceeded or declined");

		// Declarations are passed on every request, including after the budget
		// note, so the cached prefix head never changes shape.
		const context: Context = {
			systemPrompt: options.base.systemPrompt,
			messages: conversation,
			tools: declarations,
		};

		let response: AssistantMessage;
		try {
			response = await complete(model, context, options.requestOptions);
		} catch (error) {
			attempts.push({ stopReason: "error", errorMessage: error instanceof Error ? error.message : String(error) });
			throw error;
		}
		attempts.push({ usage: response.usage, stopReason: response.stopReason, errorMessage: response.errorMessage });
		// A failed attempt's usage does not describe a cached prefix; let the retry
		// (if any) be the request warming keeps alive.
		if (!firstRequest && response.usage && response.stopReason !== "error") {
			firstRequest = { context: { ...context, messages: [...conversation] }, usage: response.usage };
			options.onFirstRequest?.(firstRequest.context, response.usage);
		}

		if (response.stopReason === "aborted") return finish("", "aborted", response.errorMessage ?? "aborted");
		if (response.stopReason === "error") {
			if (!transientRetried && options.isTransient?.(response)) {
				transientRetried = true;
				// The loop head re-runs approve(), so the retry is priced like any request.
				if (!(await abortableDelay(TRANSIENT_RETRY_DELAY_MS, signal))) return finish("", "aborted", "aborted");
				continue;
			}
			return finish("", "error", response.errorMessage ?? "unknown error");
		}

		const calls = toolCallsOf(response);
		const text = textOf(response);

		if (calls.length === 0) {
			if (text) return finish(text, response.stopReason);
			if (emptyRetried) return finish("", response.stopReason, "empty response");
			emptyRetried = true;
			continue;
		}

		// Past the allowance: refuse the calls in-band. The model sees a tool
		// result telling it to answer, which keeps the transcript well-formed
		// (every call has a result) without another paid investigation.
		const allow = !budgetExhausted && rounds.length < options.maxRounds && !!tools;
		conversation.push(response);
		for (const call of calls) {
			if (!allow) {
				conversation.push({
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: REFUSED_AFTER_BUDGET }],
					isError: true,
					timestamp: 0,
				} as unknown as Message);
				continue;
			}
			const arg = preview(call.arguments);
			options.onProgress?.(`advisor: ${call.name}${arg ? ` ${arg}` : ""}`);
			const result = await tools.run(call.name, call.arguments, signal);
			rounds.push({
				tool: call.name,
				argument: arg,
				chars: result.text.length,
				isError: result.isError,
				...(result.images?.length ? { images: result.images.length } : {}),
			});
			conversation.push({
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				// An image only ever reaches the advisor here: it asked for this
				// specific file, and the bytes stay inside this consultation rather
				// than entering the ledger prefix that later requests reuse.
				content: [{ type: "text", text: result.text }, ...(result.images ?? [])],
				isError: !!result.isError,
				timestamp: 0,
			} as unknown as Message);
		}
		if (!allow) {
			budgetExhausted = true;
			conversation.push({ role: "user", content: [{ type: "text", text: BUDGET_EXHAUSTED }], timestamp: 0 } as Message);
		} else if (rounds.length >= options.maxRounds) {
			budgetExhausted = true;
			conversation.push({ role: "user", content: [{ type: "text", text: BUDGET_EXHAUSTED }], timestamp: 0 } as Message);
		}
	}

	return finish("", undefined, "empty response");
}
