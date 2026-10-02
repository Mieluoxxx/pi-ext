import type { Message } from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { clipMiddle, primaryArgument, renderCard, renderVerbatimRound } from "./advisor/cards.js";
import { validateAdvisorLedger } from "./advisor/config.js";
import { expandEntry, type LedgerOptions, LOG_CLOSE, LOG_OPEN, renderLedger } from "./advisor/ledger.js";
import { makeAssistantMessage, makeToolResult, makeUserMessage } from "./test/helpers.js";

const limits = validateAdvisorLedger(undefined);
const options: LedgerOptions = { limits, tailToolCalls: limits.tailToolCalls };
const noTail: LedgerOptions = { limits, tailToolCalls: 0 };

let seq = 0;
const entry = (partial: Partial<SessionEntry> & { type: string }): SessionEntry =>
	({ id: `e${++seq}`, parentId: null, timestamp: new Date().toISOString(), ...partial }) as SessionEntry;
const msg = (message: Message | object): SessionEntry => entry({ type: "message", message } as never);
const call = (id: string, name: string, args: object = {}) =>
	msg(makeAssistantMessage({ toolCalls: [{ id, name, arguments: args as never }] }));
const result = (id: string, name: string, text: string, isError = false) =>
	msg(makeToolResult({ toolCallId: id, toolName: name, text, isError }));
const ask = (id: string, question = "what now?") =>
	msg(makeAssistantMessage({ text: question, toolCalls: [{ id, name: "advisor", arguments: {} }] }));

const text = (messages: Message[]) => JSON.stringify(messages);
/** pi walks the branch by parentId, so a fixture must be a real chain. */
const chain = (branch: SessionEntry[]) => {
	branch.forEach((e, i) => {
		(e as { parentId: string | null }).parentId = i === 0 ? null : branch[i - 1].id;
	});
	return branch;
};
const render = (branch: SessionEntry[], opts = options) => {
	chain(branch);
	return renderLedger(branch, branch.at(-1)?.id ?? null, opts);
};

describe("ledger — append-only prefix", () => {
	it("renders the history of a prefix as a prefix of the fuller render", () => {
		const branch: SessionEntry[] = [msg(makeUserMessage("build the thing"))];
		let previous: Message[] = [];
		for (let round = 0; round < 4; round++) {
			branch.push(call(`c${round}`, "read", { path: `src/${round}.ts` }));
			branch.push(result(`c${round}`, "read", `contents ${round} `.repeat(50)));
			branch.push(ask(`a${round}`, `question ${round}`));
			const view = render(branch);
			// Every message before the last is the cacheable prefix; each new
			// consultation must extend it rather than rewrite it.
			const stable = view.messages.slice(0, view.stableMessageCount);
			expect(text(stable.slice(0, previous.length))).toBe(text(previous));
			previous = stable;
			branch.push(result(`a${round}`, "advisor", `advice ${round}`));
			branch.push(msg(makeUserMessage(`follow-up ${round}`)));
		}
		expect(text(previous)).toContain("advice 0");
		expect(text(previous)).toContain("question 0");
	});

	it("keeps the tail out of the stable prefix so re-rendering it cannot break the cache", () => {
		const branch = [
			msg(makeUserMessage("task")),
			call("c1", "bash", { command: "npm test" }),
			result("c1", "bash", "FAILED here", true),
			ask("a1"),
		];
		const view = render(branch);
		const stable = text(view.messages.slice(0, view.stableMessageCount));
		expect(stable).not.toContain("FAILED here");
		expect(text(view.messages)).toContain("FAILED here");
	});
});

describe("ledger — the user's words are never dropped", () => {
	it("keeps every user message verbatim through a heavy trim", () => {
		const branch: SessionEntry[] = [];
		for (let i = 0; i < 6; i++) {
			branch.push(msg(makeUserMessage(`user requirement ${i}`)));
			branch.push(call(`c${i}`, "read", { path: `f${i}.ts` }));
			branch.push(result(`c${i}`, "read", "x".repeat(4000)));
		}
		branch.push(ask("a1"));
		const trimmed = render(branch, { ...options, tokenBudget: 400 });
		expect(trimmed.trimmed).toBe(true);
		for (let i = 0; i < 6; i++) expect(text(trimmed.messages)).toContain(`user requirement ${i}`);
	});

	it("recovers pre-compaction user messages that pi's summary would have replaced", () => {
		const early = msg(makeUserMessage("ORIGINAL REQUEST the summary paraphrases"));
		const kept = msg(makeUserMessage("later request"));
		const branch: SessionEntry[] = [
			early,
			call("c0", "read", { path: "a.ts" }),
			result("c0", "read", "old detail"),
			entry({ type: "compaction", summary: "pi's paraphrase", firstKeptEntryId: "", tokensBefore: 1 } as never),
			kept,
			ask("a1"),
		];
		const view = render(branch);
		const out = text(view.messages);
		expect(out).toContain("ORIGINAL REQUEST the summary paraphrases");
		expect(out).toContain("pi's paraphrase");
		expect(out).toContain("not the user's words");
	});

	it("keeps a user message that follows a completed consultation", () => {
		// Regression: round indices address the CURRENT segment's block array. When
		// they leaked across a consultation boundary, a stale index could collide
		// with a later block's position and replace a user message with the
		// verbatim rendering of an earlier round. Found by replaying real sessions.
		const branch = [
			msg(makeUserMessage("first request")),
			call("c0", "read", { path: "a.ts" }),
			result("c0", "read", "body"),
			ask("a1", "q1"),
			result("a1", "advisor", "advice 1"),
			msg(makeUserMessage("SECOND REQUEST AFTER ADVICE")),
			msg(makeUserMessage("THIRD REQUEST")),
			ask("a2", "q2"),
		];
		const out = text(render(branch).messages);
		expect(out).toContain("first request");
		expect(out).toContain("SECOND REQUEST AFTER ADVICE");
		expect(out).toContain("THIRD REQUEST");
	});

	it("names a pasted image without embedding its bytes", () => {
		// pi's ImageContent is {data, mimeType} with no path, so a terminal paste
		// cannot be handed to the advisor as a file. Inlining the base64 would pin
		// it into the append-only prefix of every later consultation instead.
		const withImage = makeUserMessage("look at this");
		(withImage.content as unknown[]).push({ type: "image", data: "A".repeat(200000), mimeType: "image/png" });
		const out = text(render([msg(withImage), ask("a1")]).messages);
		expect(out).toContain("look at this");
		expect(out).toContain("1 image(s) the user pasted");
		expect(out).not.toContain("AAAAAAAAAA");
	});

	it("points at the file path for a tool-produced image", () => {
		// A tool image DOES live on disk, and the card already names it, so the
		// advisor can load it with `read` rather than being handed the bytes.
		const branch = [
			msg(makeUserMessage("task")),
			call("c1", "read", { path: "docs/screenshot.png" }),
			msg(
				makeToolResult({
					toolCallId: "c1",
					toolName: "read",
					text: "Read image file [image/png]",
				}),
			),
			ask("a1"),
		];
		(branch[2] as { message: { content: unknown[] } }).message.content.push({
			type: "image",
			data: "B".repeat(50000),
			mimeType: "image/png",
		});
		const out = text(render(branch, noTail).messages);
		expect(out).toContain("docs/screenshot.png");
		expect(out).toContain("1 image");
		expect(out).toContain("read the path above to view");
		expect(out).not.toContain("BBBBBBBBBB");
	});

	it("keeps head and tail of an oversized user message with a marked, expandable gap", () => {
		const huge = "A".repeat(30000) + "ZEBRA" + "B".repeat(30000);
		const branch = [msg(makeUserMessage(huge)), ask("a1")];
		const out = text(render(branch).messages);
		expect(out).toContain("chars omitted");
		expect(out).toContain("advisor_expand");
		expect(out).not.toContain("ZEBRA");
		expect(out.length).toBeLessThan(huge.length);
	});
});

describe("ledger — cards", () => {
	it("summarizes a completed round and surfaces the first error line", () => {
		const card = renderCard({
			entryId: "e9",
			call: { type: "toolCall", id: "c", name: "bash", arguments: { command: "npm test" } },
			result: { entryId: "r9", text: "TypeError: x is undefined\nat foo\nat bar", isError: true, images: 0 },
		});
		expect(card.text).toBe("#r9 bash · npm test · error · 3 lines · ✗ TypeError: x is undefined");
	});

	it("reports edit shape and a still-running call", () => {
		const edit = renderCard({
			call: { type: "toolCall", id: "c", name: "edit", arguments: { path: "a.ts", old_string: "a\nb", new_string: "a\nb\nc" } },
			result: { text: "ok", isError: false, images: 0 },
		});
		expect(edit.text).toContain("a.ts · +3 −2");
		const running = renderCard({ call: { type: "toolCall", id: "c", name: "read", arguments: { path: "x" } } });
		expect(running.text).toContain("running");
	});

	it("names the primary argument for known and unknown tool shapes", () => {
		expect(primaryArgument({ file_path: "a.ts", extra: "no" })).toBe("a.ts");
		expect(primaryArgument({ weird: "value" })).toBe("value");
		expect(primaryArgument({})).toBe("");
	});

	it("caps each part of a verbatim tail round independently", () => {
		const round = {
			entryId: "e1",
			call: { type: "toolCall" as const, id: "c", name: "read", arguments: { path: "x" } },
			result: { entryId: "r1", text: "y".repeat(50000), isError: false, images: 2 },
		};
		const block = renderVerbatimRound(round, limits);
		expect(block.text.length).toBeLessThan(limits.tailMaxChars + 500);
		expect(block.text).toContain("2 image(s) omitted");
	});

	it("replaces the middle of an oversized value, never the ends", () => {
		expect(clipMiddle("abcdef", 100)).toBe("abcdef");
		const out = clipMiddle("x".repeat(100) + "y".repeat(100), 40);
		expect(out.startsWith("x")).toBe(true);
		expect(out.endsWith("y")).toBe(true);
		expect(out).toContain("omitted");
	});
});

describe("ledger — role separation and structure", () => {
	it("lets Pi estimate a follow-up consultation with replayed advice", () => {
		const view = render([
			ask("a1", "first question"),
			result("a1", "advisor", "PRIOR ADVICE"),
			ask("a2", "second question"),
		]);
		expect(view.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
		// Exercise the real SDK estimator, not the mocked completion facade.
		const estimate = estimateContextTokens(view.messages);
		expect(estimate.tokens).toBeGreaterThan(0);
		// Replayed text must be estimated, not treated as a measured prompt prefix.
		expect(estimate).toMatchObject({ usageTokens: 0, lastUsageIndex: null });
	});

	it("places executor activity in user-role logs and only advice in assistant turns", () => {
		const branch = [
			msg(makeUserMessage("task")),
			call("c1", "read", { path: "a.ts" }),
			result("c1", "read", "body"),
			ask("a1", "first question"),
			result("a1", "advisor", "PRIOR ADVICE"),
			msg(makeUserMessage("next")),
			ask("a2", "second question"),
		];
		const view = render(branch);
		const assistants = view.messages.filter((m) => m.role === "assistant");
		expect(assistants).toHaveLength(1);
		expect(text(assistants)).toContain("PRIOR ADVICE");
		// No executor turn may occupy the assistant role.
		expect(text(assistants)).not.toContain("read");
		expect(view.messages.every((m) => m.role === "user" || m.role === "assistant")).toBe(true);
	});

	it("ends on an instruction, never on a pending action", () => {
		const branch = [msg(makeUserMessage("task")), call("c1", "read", { path: "a" }), ask("a1")];
		const view = render(branch);
		const last = view.messages.at(-1);
		expect(last?.role).toBe("user");
		expect(text([last as Message])).toContain("Advise the executor");
	});

	it("carries the in-flight call's prose as the current question", () => {
		const branch = [msg(makeUserMessage("task")), ask("a1", "SHOULD I REFACTOR?")];
		expect(text(render(branch).messages)).toContain("SHOULD I REFACTOR?");
	});

	it("omits a failed or skipped consultation's text while keeping its question", () => {
		for (const failure of [
			{ isError: true },
			{ details: { errorMessage: "boom" } },
			{ details: { skipped: true } },
			{ details: { stopReason: "aborted" } },
		]) {
			const branch = [
				msg(makeUserMessage("task")),
				ask("a1", "the question"),
				msg(makeToolResult({ toolCallId: "a1", toolName: "advisor", text: "FAILURE TEXT", ...failure })),
				ask("a2"),
			];
			const out = text(render(branch).messages);
			expect(out).not.toContain("FAILURE TEXT");
			expect(out).toContain("the question");
		}
	});

	it("wraps executor activity in an explicit log delimiter", () => {
		const branch = [msg(makeUserMessage("task")), call("c1", "read", { path: "a" }), ask("a1")];
		const out = text(render(branch).messages);
		expect(out).toContain(LOG_OPEN);
		expect(out).toContain(LOG_CLOSE);
	});
});

describe("ledger — non-message entries", () => {
	it("hides custom messages the user never saw and previews the ones they did", () => {
		const branch = [
			msg(makeUserMessage("task")),
			entry({ type: "custom_message", customType: "note", content: "VISIBLE NOTE", display: true } as never),
			entry({ type: "custom_message", customType: "secret", content: "HIDDEN NOTE", display: false } as never),
			ask("a1"),
		];
		const out = text(render(branch).messages);
		expect(out).toContain("VISIBLE NOTE");
		expect(out).not.toContain("HIDDEN NOTE");
	});

	it("shows a `!` shell run and skips a `!!` run the executor never saw", () => {
		const branch = [
			msg(makeUserMessage("task")),
			msg({ role: "bashExecution", command: "ls -la", output: "files", exitCode: 0 }),
			msg({ role: "bashExecution", command: "SECRET", output: "x", exitCode: 0, excludeFromContext: true }),
			ask("a1"),
		];
		const out = text(render(branch).messages);
		expect(out).toContain("ls -la");
		expect(out).toContain("exit 0");
		expect(out).not.toContain("SECRET");
	});

	it("ignores extension state entries such as the persisted anchor", () => {
		const branch = [
			msg(makeUserMessage("task")),
			entry({ type: "custom", customType: "advisor-context-anchor", data: { entryId: "x" } } as never),
			ask("a1"),
		];
		expect(text(render(branch).messages)).not.toContain("advisor-context-anchor");
	});
});

describe("ledger — tail promotion", () => {
	it("keeps the configured number of rounds verbatim and cards the rest", () => {
		const branch: SessionEntry[] = [msg(makeUserMessage("task"))];
		for (let i = 0; i < 5; i++) {
			branch.push(call(`c${i}`, "read", { path: `f${i}.ts` }));
			branch.push(result(`c${i}`, "read", `UNIQUE_BODY_${i}`));
		}
		branch.push(ask("a1"));
		const out = text(render(branch).messages);
		// Last two rounds verbatim; earlier bodies summarized away.
		expect(out).toContain("UNIQUE_BODY_4");
		expect(out).toContain("UNIQUE_BODY_3");
		expect(out).not.toContain("UNIQUE_BODY_0");
		expect(out).toContain("f0.ts");
	});

	it("cards every round when the tail is disabled", () => {
		const branch = [
			msg(makeUserMessage("task")),
			call("c1", "read", { path: "a.ts" }),
			result("c1", "read", "SHOULD_NOT_APPEAR"),
			ask("a1"),
		];
		const out = text(render(branch, noTail).messages);
		expect(out).not.toContain("SHOULD_NOT_APPEAR");
		expect(out).toContain("a.ts");
	});
});

describe("ledger — trimming and the sticky anchor", () => {
	const wide = () => {
		const branch: SessionEntry[] = [msg(makeUserMessage("task"))];
		for (let i = 0; i < 8; i++) {
			branch.push(call(`c${i}`, "read", { path: `file-${i}-with-a-long-name.ts` }));
			branch.push(result(`c${i}`, "read", "z".repeat(2000)));
			branch.push(ask(`a${i}`, `question ${i}`));
			branch.push(result(`a${i}`, "advisor", `advice ${i}`));
		}
		branch.push(ask("final"));
		return branch;
	};

	it("marks the omission, reports an anchor, and fits the budget", () => {
		const branch = wide();
		const view = render(branch, { ...options, tokenBudget: 120 });
		expect(view.trimmed).toBe(true);
		expect(view.trimAnchorId).toBeDefined();
		expect(text(view.messages)).toContain("omitted to fit the cost budget");
	});

	it("reproduces the same boundary when replaying a saved anchor", () => {
		const branch = wide();
		const first = render(branch, { ...options, tokenBudget: 120 });
		const replayed = render(branch, { ...options, anchorEntryId: first.trimAnchorId });
		expect(replayed.trimmed).toBe(true);
		expect(replayed.trimAnchorId).toBe(first.trimAnchorId);
	});

	it("never drops the current segment, even under an impossible budget", () => {
		const branch = [msg(makeUserMessage("IRREDUCIBLE TASK")), ask("a1", "CURRENT QUESTION")];
		const view = render(branch, { ...options, tokenBudget: 1 });
		const out = text(view.messages);
		expect(out).toContain("IRREDUCIBLE TASK");
		expect(out).toContain("CURRENT QUESTION");
	});
});

describe("expandEntry", () => {
	it("returns verbatim text per entry kind and undefined for an unknown id", () => {
		const branch = [
			msg(makeUserMessage("user words")),
			result("c1", "read", "the full tool body"),
			msg({ role: "bashExecution", command: "make", output: "build log", exitCode: 2 }),
			entry({ type: "custom_message", customType: "note", content: "note body", display: true } as never),
		];
		chain(branch);
		expect(expandEntry(branch, branch[0].id, 1000)).toContain("user words");
		expect(expandEntry(branch, branch[1].id, 1000)).toBe("the full tool body");
		expect(expandEntry(branch, branch[2].id, 1000)).toContain("build log");
		expect(expandEntry(branch, branch[3].id, 1000)).toBe("note body");
		expect(expandEntry(branch, "missing", 1000)).toBeUndefined();
	});

	it("caps what it returns", () => {
		const branch = [result("c1", "read", "q".repeat(9000))];
		expect(expandEntry(branch, branch[0].id, 500)?.length).toBeLessThan(700);
	});
});
