import type { Model, SimpleStreamOptions, ThinkingLevel } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, type RenameConfig } from "./config.js";
import { appendDebugLog, getEmptyNameReason, summarizeNamingResponse } from "./debug.js";
import {
	renameCurrentHerdrTab,
	renameCurrentHerdrTabIfDefault,
	type HerdrSyncResult,
} from "./herdr.js";
import { showSettings } from "./settings.js";

const STATUS_KEY = "rename";
const MAX_CONVERSATION_CHARS = 60_000;

const NAMING_SYSTEM_PROMPT = `You name coding-agent sessions.
Focus only on choosing a concise, specific session name.
Name the session after the user's primary intent or desired outcome, not incidental recent progress.
Use the same language as the user. Preserve useful file, package, command, model, and error names.
You may think internally, but never expose your reasoning in the final response.
Your final response must contain exactly one <session_name>...</session_name> tag and no other text.
Use fewer than 20 words inside the tag. Avoid generic names like "Coding Session" or "Project Work".`;

const NAMING_OUTPUT_CONTRACT = `Final output contract: return exactly one tag in this format and nothing else:
<session_name>title with fewer than 20 words</session_name>
Do not return explanations, reasoning, markdown, quotes, or text outside the tag.`;

const NAMING_TIMEOUT_MS = 60_000;
function getSessionStreamOptions(
	ctx: ExtensionContext,
): Pick<SimpleStreamOptions, "transport" | "websocketConnectTimeoutMs" | "sessionId"> {
	const settings = SettingsManager.create(ctx.cwd, undefined, {
		projectTrusted: ctx.isProjectTrusted(),
	});
	const websocketConnectTimeoutMs = settings.getWebSocketConnectTimeoutMs();
	return {
		sessionId: ctx.sessionManager.getSessionId(),
		transport: settings.getTransport(),
		...(websocketConnectTimeoutMs === undefined ? {} : { websocketConnectTimeoutMs }),
	};
}

export function buildNamingOptions(
	sessionOptions: Partial<Pick<SimpleStreamOptions, "transport" | "websocketConnectTimeoutMs" | "sessionId">>,
	configuredThinkingLevel: string,
): SimpleStreamOptions {
	const options: SimpleStreamOptions = {
		...sessionOptions,
		timeoutMs: NAMING_TIMEOUT_MS,
	};
	const reasoning = resolveThinkingLevel(configuredThinkingLevel);
	if (reasoning !== undefined) options.reasoning = reasoning;
	return options;
}
function messageText(content: unknown): string {
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
		.join("\n");
}

export function buildConversationText(branch: readonly SessionEntry[]): string {
	const sections: string[] = [];

	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const message = entry.message;

		if (message.role === "user") {
			const text = messageText(message.content).trim();
			if (text) sections.push(`User: ${text}`);
			continue;
		}

		if (message.role === "assistant") {
			const lines: string[] = [];
			const text = messageText(message.content).trim();
			if (text) lines.push(`Assistant: ${text}`);
			lines.push(
				...message.content
					.flatMap((block) =>
						block.type === "toolCall"
							? [
									`Tool ${block.name} called with args ${JSON.stringify(block.arguments)}`,
								]
							: [],
					),
			);
			if (lines.length > 0) sections.push(lines.join("\n"));
		}
	}

	const conversation = sections.join("\n\n");
	if (conversation.length <= MAX_CONVERSATION_CHARS) return conversation;
	return `[Earlier conversation omitted]\n${conversation.slice(-MAX_CONVERSATION_CHARS)}`;
}

export function sanitizeName(text: string): string | undefined {
	const [firstLine = ""] = text.trim().split(/\r?\n/);
	const name = firstLine.replace(/\s+/g, " ").slice(0, 80).trim();
	return name || undefined;
}

const SESSION_NAME_TAG = /<session_name>([\s\S]*?)<\/session_name>/i;

export function extractSessionName(text: string): string | undefined {
	const match = SESSION_NAME_TAG.exec(text);
	const normalized = (match?.[1] ?? "").replace(/\s+/g, " ");
	const name = sanitizeName(normalized);
	if (!name) return undefined;
	return name.split(/\s+/).slice(0, 19).join(" ");
}
export function stripQuotes(text: string): string {
	const trimmed = text.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1).trim();
	}
	return trimmed;
}

export function parseModelRef(ref: string): { provider: string; id: string } | null {
	const trimmed = ref.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return null;
	return { provider: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
}

function resolveNamingModel(
	ctx: ExtensionContext,
	modelRef: string,
): { model: Model<any> | undefined; note?: string } {
	const ref = modelRef.trim();
	if (!ref) return { model: ctx.model };

	const parsed = parseModelRef(ref);
	if (!parsed) return { model: undefined, note: `Invalid model ref: ${ref}` };
	const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
	if (!model) return { model: undefined, note: `Model not found: ${ref}` };
	return { model };
}

export function resolveThinkingLevel(
	configured: string,
): ThinkingLevel | undefined {
	const level = configured.trim();
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

export type RenameCommand =
	| { kind: "settings" }
	| { kind: "generate" }
	| { kind: "set-name"; name: string };

export function parseRenameCommand(args: string): RenameCommand {
	const trimmed = args.trim();
	if (!trimmed) return { kind: "generate" };
	if (trimmed === "settings") return { kind: "settings" };
	return { kind: "set-name", name: stripQuotes(trimmed) };
}

export function shouldApplyAutoName(
	epoch: number,
	currentEpoch: number,
	currentName: string | undefined,
): boolean {
	return epoch === currentEpoch && !currentName;
}

function logDebugError(ctx: Pick<ExtensionContext, "cwd">, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	appendDebugLog(ctx.cwd, "error", {
		message,
		...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
	});
}


async function generateSessionName(
	ctx: ExtensionContext,
	config: RenameConfig,
): Promise<string> {
	const conversation = buildConversationText(ctx.sessionManager.getBranch());
	if (!conversation.trim()) throw new Error("No conversation found to name");

	const { model, note } = resolveNamingModel(ctx, config.model);
	if (!model) throw new Error(note ?? "No model selected");
	if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
		throw new Error(`No auth configured for ${model.provider}/${model.id}`);
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);

	const options = buildNamingOptions(getSessionStreamOptions(ctx), config.thinkingLevel);
	if (auth.apiKey) options.apiKey = auth.apiKey;
	if (auth.headers) options.headers = auth.headers;
	if (auth.env) options.env = auth.env;

	appendDebugLog(ctx.cwd, "request", {
		model: `${model.provider}/${model.id}`,
		configuredThinkingLevel: config.thinkingLevel,
		effectiveReasoning: options.reasoning ?? "off",
		timeoutMs: options.timeoutMs,
		conversationCharacters: conversation.length,
	});

	const response = await completeSimple(
		model,
		{
			systemPrompt: NAMING_SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: `Conversation:\n${conversation}\n\n${NAMING_OUTPUT_CONTRACT}`,
						},
					],
					timestamp: Date.now(),
				},
			],
		},
		options,
	);

	const responseSummary = summarizeNamingResponse(response);
	appendDebugLog(ctx.cwd, "response", {
		model: `${model.provider}/${model.id}`,
		...responseSummary,
	});

	if (response.stopReason === "error") {
		throw new Error(response.errorMessage || "Naming model returned an error");
	}
	if (response.stopReason === "aborted") throw new Error("Naming was aborted");

	const text = response.content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("\n");
	const name = extractSessionName(text);
	if (!name) {
		const reason = getEmptyNameReason(text, responseSummary.textBlockCount);
		const debugPath = appendDebugLog(ctx.cwd, "empty-name", {
			model: `${model.provider}/${model.id}`,
			reason,
			...responseSummary,
		});
		const suffix = debugPath ? ` (debug log: ${debugPath})` : "";
		throw new Error(`Naming model returned an empty name${suffix}`);
	}
	return name;
}

function notifyRenameResult(
	ctx: ExtensionCommandContext,
	name: string,
	herdr: HerdrSyncResult,
): void {
	if (herdr.status === "failed") {
		ctx.ui.notify(
			`Session name set, but Herdr tab rename failed: ${herdr.error}`,
			"warning",
		);
		return;
	}
	const suffix = herdr.status === "renamed" ? " · Herdr tab renamed" : "";
	ctx.ui.notify(`Session name set: ${name}${suffix}`, "info");
}

async function runRename(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<void> {
	await ctx.waitForIdle();

	const { value: config, warnings } = loadConfig();
	for (const warning of warnings) {
		ctx.ui.notify(warning, "warning");
	}

	ctx.ui.setStatus(STATUS_KEY, "renaming…");
	try {
		const name = await generateSessionName(ctx, config);
		pi.setSessionName(name);
		const herdr = await renameCurrentHerdrTab(name);
		notifyRenameResult(ctx, name, herdr);
	} catch (error) {
		logDebugError(ctx, error);
		ctx.ui.notify(
			error instanceof Error ? error.message : String(error),
			"error",
		);
	} finally {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
}

export default function (pi: ExtensionAPI) {
	let autoRenameRunning = false;
	let sessionEpoch = 0;

	pi.registerCommand("rename", {
		description: "Generate or set a session name",
			handler: async (args, ctx) => {
				const command = parseRenameCommand(args);
				switch (command.kind) {
					case "settings":
						await showSettings(ctx);
						return;


					case "set-name": {
						if (command.name) {
							pi.setSessionName(command.name);
							const herdr = await renameCurrentHerdrTab(command.name);
							notifyRenameResult(ctx, command.name, herdr);
						} else {
							ctx.ui.notify("Session name cannot be empty", "warning");
						}
						return;
					}

					case "generate":
						await runRename(pi, ctx);
						return;
				}
			},
		});

	pi.on("agent_end", async (_event, ctx) => {
		if (autoRenameRunning || pi.getSessionName()) return;
		const epoch = sessionEpoch;

		const { value: config, warnings } = loadConfig();
		for (const warning of warnings) {
			ctx.ui.notify(warning, "warning");
		}
		if (!config.afterSteps) return;

		let userAgentTurns = 0;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message" && entry.message.role === "user") {
				userAgentTurns += 1;
			}
		}

		const stepTrigger =
			config.afterSteps > 0 && userAgentTurns >= config.afterSteps;
		if (!stepTrigger) return;

		autoRenameRunning = true;
		ctx.ui.setStatus(STATUS_KEY, "renaming…");
		try {
			const name = await generateSessionName(ctx, config);
			if (!shouldApplyAutoName(epoch, sessionEpoch, pi.getSessionName())) return;
			pi.setSessionName(name);
			ctx.ui.notify(`Session name set: ${name}`, "info");
			await renameCurrentHerdrTabIfDefault(name);
		} catch (error) {
			logDebugError(ctx, error);
			ctx.ui.notify(
				`Auto-rename failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
				"warning",
			);
		} finally {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			autoRenameRunning = false;
		}
	});

	pi.on("session_start", async () => {
		const sessionName = pi.getSessionName()?.trim();
		if (!sessionName) return;
		await renameCurrentHerdrTabIfDefault(sessionName);
	});

	pi.on("session_shutdown", async () => {
		sessionEpoch += 1;
		autoRenameRunning = false;
	});
}
