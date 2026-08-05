import { appendFileSync } from "node:fs";
import { join } from "node:path";

export const DEBUG_FILE_NAME = "debug.log";
const DEBUG_ENV = "PI_SESSION_RENAME_DEBUG";
const PREVIEW_LENGTH = 120;

export type NamingResponseLike = {
	stopReason: string;
	errorMessage?: string;
	content: readonly unknown[];
	usage?: unknown;
};

export type NamingResponseSummary = {
	stopReason: string;
	errorMessage?: string;
	contentBlockTypes: string[];
	textBlockCount: number;
	textCharacters: number;
	thinkingCharacters: number;
	textPreview: string;
	thinkingPreview: string;
	usage: Record<string, number>;
};

export type EmptyNameReason =
	| "no-text-block"
	| "text-whitespace-only"
	| "missing-session-name-tag"
	| "empty-session-name-tag";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function preview(value: string): string {
	return value.replace(/\s+/g, " ").trim().slice(0, PREVIEW_LENGTH);
}

function summarizeUsage(usage: unknown): Record<string, number> {
	if (!isRecord(usage)) return {};

	const result: Record<string, number> = {};
	for (const key of [
		"input",
		"output",
		"cacheRead",
		"cacheWrite",
		"cacheWrite1h",
		"reasoning",
		"totalTokens",
	]) {
		const value = usage[key];
		if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
	}
	return result;
}

export function isDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env[DEBUG_ENV]?.trim().toLowerCase();
	return value === "1" || value === "true" || value === "yes";
}

export function debugLogPath(cwd: string): string {
	return join(cwd, DEBUG_FILE_NAME);
}

/** Best-effort developer logging. A logging failure must never break renaming. */
export function appendDebugLog(
	cwd: string,
	event: string,
	fields: Record<string, unknown>,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	if (!isDebugEnabled(env)) return undefined;

	const path = debugLogPath(cwd);
	try {
		const record = {
			timestamp: new Date().toISOString(),
			event,
			...fields,
		};
		appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
		return path;
	} catch {
		return undefined;
	}
}

export function summarizeNamingResponse(
	response: NamingResponseLike,
): NamingResponseSummary {
	const content = Array.isArray(response.content) ? response.content : [];
	const contentBlockTypes: string[] = [];
	const textParts: string[] = [];
	const thinkingParts: string[] = [];
	let textBlockCount = 0;

	for (const block of content) {
		if (!isRecord(block)) {
			contentBlockTypes.push("unknown");
			continue;
		}

		const type = typeof block.type === "string" ? block.type : "unknown";
		contentBlockTypes.push(type);
		if (type === "text" && typeof block.text === "string") {
			textBlockCount += 1;
			textParts.push(block.text);
		}
		if (type === "thinking" && typeof block.thinking === "string") {
			thinkingParts.push(block.thinking);
		}
	}

	const text = textParts.join("\n");
	const thinking = thinkingParts.join("\n");
	return {
		stopReason: response.stopReason,
		...(response.errorMessage ? { errorMessage: response.errorMessage } : {}),
		contentBlockTypes,
		textBlockCount,
		textCharacters: text.length,
		thinkingCharacters: thinking.length,
		textPreview: preview(text),
		thinkingPreview: preview(thinking),
		usage: summarizeUsage(response.usage),
	};
}

export function getEmptyNameReason(
	text: string,
	textBlockCount: number,
): EmptyNameReason {
	if (textBlockCount === 0) return "no-text-block";
	if (!text.trim()) return "text-whitespace-only";
	const match = /<session_name>([\s\S]*?)<\/session_name>/i.exec(text);
	if (!match) return "missing-session-name-tag";
	return match[1]?.trim() ? "missing-session-name-tag" : "empty-session-name-tag";
}
