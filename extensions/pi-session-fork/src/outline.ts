import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { buildOutlinePrompt, buildOutlineSnapshot } from "./context.js";

type CompleteSimpleOptions = NonNullable<Parameters<typeof completeSimple>[2]>;

type AiThinkingLevel = NonNullable<CompleteSimpleOptions["reasoning"]>;

/** Maps the session thinking level (may include "off") to pi-ai's reasoning. */
function toReasoning(level: string | undefined): AiThinkingLevel | undefined {
	if (!level || level === "off") return undefined;
	switch (level) {
		case "minimal":
		case "low":
		case "medium":
		case "high":
		case "xhigh":
		case "max":
			return level;
		default:
			return undefined;
	}
}

/** Custom entry type used to persist outline answers (not sent to the LLM). */
export const OUTLINE_ENTRY_TYPE = "pi-session-fork.outline";

export interface OutlineEntryData {
	readonly question: string;
	readonly answer: string;
	readonly createdAt: string;
	readonly model?: string;
}

export type OutlineResult =
	| { readonly status: "answered"; readonly entry: OutlineEntryData }
	| { readonly status: "cancelled" }
	| { readonly status: "failed"; readonly error: string };

/** Collects the question: from args, or via a dialog when omitted. */
export async function collectQuestion(
	ctx: ExtensionCommandContext,
	args: string,
	title: string,
): Promise<string | undefined> {
	const fromArgs = args.trim();
	if (fromArgs) return fromArgs;
	if (ctx.hasUI) {
		return ctx.ui.input(title);
	}
	return undefined;
}


/** Strips tool calls from an assistant answer for a clean entry. */
export function answerText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				block !== null &&
				typeof block === "object" &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("\n")
		.trim();
}

/**
 * Answers the question with a direct model call, outside the session context.
 * The answer is returned as entry data; the caller persists it with
 * `pi.appendEntry(OUTLINE_ENTRY_TYPE, data)` so it renders in the transcript
 * without ever participating in LLM context.
 */
export async function answerOutline(
	ctx: ExtensionCommandContext,
	question: string,
): Promise<OutlineResult> {
	try {
		if (!ctx.model) {
			return { status: "failed", error: "No active model for the outline answer." };
		}

		const snapshot = buildOutlineSnapshot(ctx.sessionManager, ctx.cwd);
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok) {
			return { status: "failed", error: auth.error };
		}

		const options: Parameters<typeof completeSimple>[2] = {
			timeoutMs: 120_000,
			sessionId: ctx.sessionManager.getSessionId(),
		};
		if (auth.apiKey) options.apiKey = auth.apiKey;
		if (auth.headers) options.headers = auth.headers;
		if (auth.env) options.env = auth.env;
		const reasoning = toReasoning(ctx.thinkingLevel);
		if (reasoning) options.reasoning = reasoning;

		const response = await completeSimple(
			ctx.model,
			{
				systemPrompt:
					"You answer one temporary side question about the current coding session. Use the parent-conversation snapshot as reference. Keep the answer focused and concise.",
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: buildOutlinePrompt(snapshot, question) }],
						timestamp: Date.now(),
					},
				],
			},
			options,
		);

		if (response.stopReason === "error") {
			return {
				status: "failed",
				error: response.errorMessage || "The model returned an error.",
			};
		}
		if (response.stopReason === "aborted") {
			return { status: "failed", error: "The outline answer was aborted." };
		}

		const answer = answerText(response.content);
		if (!answer) {
			return { status: "failed", error: "The model returned an empty answer." };
		}

		return {
			status: "answered",
			entry: {
				question,
				answer,
				createdAt: new Date().toISOString(),
				...(snapshot.model ? { model: snapshot.model } : {}),
			},
		};
	} catch (error) {
		return {
			status: "failed",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Convenience: shows a one-line preview of an outline entry for the renderer. */
export function previewOutline(entry: OutlineEntryData): string {
	const firstLine = entry.answer.split(/\r?\n/)[0] ?? "";
	return `${firstLine}${firstLine.length < entry.answer.length ? "…" : ""}`;
}
