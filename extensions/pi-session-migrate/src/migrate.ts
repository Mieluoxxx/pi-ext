/**
 * pi-session-migrate command logic.
 *
 * `/migrate` scans Pi's sessions directory for "dangling" sessions (header
 * `cwd` no longer exists — the project moved or was deleted), groups them by
 * old project path, annotates each group (same-name match for free, LLM claim
 * when a claim model is configured), and lets the user pick what to migrate
 * into the current project. Every group is always listed; the user decides.
 */
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Model, SimpleStreamOptions, ThinkingLevel } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { loadConfig, type MigrateConfig } from "./config.js";
import { showSettings } from "./settings.js";
import {
	encodeSessionDir,
	getSessionsRoot,
	migrateGroup,
	readSessionDirAsGroup,
	scanDanglingGroups,
	type DanglingGroup,
} from "./storage.js";

// ── Command parsing ─────────────────────────────────────────────────────────

export type MigrateCommand =
	| { kind: "settings" }
	| { kind: "scan" }
	| { kind: "explicit"; oldCwd: string };

export function expandUserPath(value: string): string {
	return value === "~" || value.startsWith("~/") || value.startsWith("~\\")
		? join(homedir(), value.slice(1))
		: value;
}

export function parseMigrateCommand(args: string, cwd: string): MigrateCommand {
	const trimmed = args.trim();
	if (!trimmed) return { kind: "scan" };
	if (trimmed === "settings") return { kind: "settings" };
	const expanded = expandUserPath(stripQuotes(trimmed));
	return { kind: "explicit", oldCwd: resolve(cwd, expanded) };
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

// ── Claim model helpers (mirror pi-session-rename) ──────────────────────────

export function parseModelRef(ref: string): { provider: string; id: string } | null {
	const trimmed = ref.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return null;
	return { provider: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
}

export function resolveThinkingLevel(configured: string): ThinkingLevel | undefined {
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

function resolveClaimModel(
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

function claimStreamOptions(
	ctx: ExtensionContext,
	thinkingLevel: string,
): SimpleStreamOptions {
	const settings = SettingsManager.create(ctx.cwd, undefined, {
		projectTrusted: ctx.isProjectTrusted(),
	});
	const options: SimpleStreamOptions = {
		sessionId: ctx.sessionManager.getSessionId(),
		transport: settings.getTransport(),
		timeoutMs: 60_000,
	};
	const websocketConnectTimeoutMs = settings.getWebSocketConnectTimeoutMs();
	if (websocketConnectTimeoutMs !== undefined) options.websocketConnectTimeoutMs = websocketConnectTimeoutMs;
	const reasoning = resolveThinkingLevel(thinkingLevel);
	if (reasoning !== undefined) options.reasoning = reasoning;
	return options;
}
// ── Group summary for the claim request ─────────────────────────────────────

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

/** Extract a short preview of user messages from a session file. */
export function readSessionPreview(filePath: string, maxChars = 400): string {
	let content: string;
	try {
		content = readFileSync(filePath, "utf8");
	} catch {
		return "";
	}
	const texts: string[] = [];
	for (const line of content.split(/\r?\n/).slice(0, 60)) {
		try {
			const entry = JSON.parse(line) as Record<string, unknown>;
			if (entry.type !== "message") continue;
			const message = entry.message as { role?: unknown; content?: unknown } | undefined;
			if (message?.role !== "user") continue;
			const text = messageText(message.content);
			if (text) texts.push(text);
		} catch {
			// skip malformed line
		}
	}
	return texts.join(" | ").replace(/\s+/g, " ").trim().slice(0, maxChars);
}

export function buildGroupSummary(group: DanglingGroup, maxChars = 1200): string {
	const parts: string[] = [];
	for (const session of group.sessions) {
		const preview = readSessionPreview(session.filePath);
		if (!preview) continue;
		parts.push(`[${session.id.slice(0, 8)}] ${preview}`);
		if (parts.join("\n").length > maxChars) break;
	}
	return parts.join("\n");
}

function projectContext(cwd: string): string {
	const lines = [`path: ${cwd}`, `name: ${basename(cwd)}`];

	const packageJson = join(cwd, "package.json");
	try {
		const parsed = JSON.parse(readFileSync(packageJson, "utf8")) as Record<string, unknown>;
		if (typeof parsed.name === "string" && parsed.name) lines.push(`package name: ${parsed.name}`);
	} catch {
		// no package.json
	}

	const gitConfig = join(cwd, ".git", "config");
	try {
		const content = readFileSync(gitConfig, "utf8");
		const match = /\[remote "[^"]+"\]\s*url\s*=\s*([^\s]+)/.exec(content);
		if (match?.[1]) lines.push(`git remote: ${match[1]}`);
	} catch {
		// not a git repo
	}

	return lines.join("\n");
}

// ── Claim ───────────────────────────────────────────────────────────────────

export const CLAIM_SYSTEM_PROMPT = `You decide whether a group of coding-agent chat sessions belongs to the current project.
A session belongs to the current project when it was created in the same codebase that has since moved to the current path — same repository, same codebase, same ongoing work, just a different location.
Respond with exactly one <claim> tag containing one of:
- belongs: the sessions clearly come from the current project
- other: the sessions clearly come from a different project
- unknown: not enough evidence either way
You may think internally, but never expose your reasoning in the final response.
Final output contract: return exactly one tag and nothing else: <claim>belongs|unknown|other</claim>`;

export type Claim = "belongs" | "other" | "unknown";

const CLAIM_TAG = /<claim>([\s\S]*?)<\/claim>/i;

export function extractClaim(text: string): Claim | undefined {
	const match = CLAIM_TAG.exec(text);
	const value = match?.[1]?.trim().toLowerCase();
	if (value === "belongs" || value === "other" || value === "unknown") return value;
	return undefined;
}

export async function claimGroup(
	ctx: ExtensionContext,
	group: DanglingGroup,
	config: MigrateConfig,
	targetCwd: string,
): Promise<Claim | undefined> {
	const { model, note } = resolveClaimModel(ctx, config.model);
	if (!model) return undefined;

	if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
		return undefined;
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return undefined;

	const options = claimStreamOptions(ctx, config.thinkingLevel);
	if (auth.apiKey) options.apiKey = auth.apiKey;
	if (auth.headers) options.headers = auth.headers;
	if (auth.env) options.env = auth.env;

	const summary = buildGroupSummary(group);
	const messages: Array<{ role: "user"; content: Array<{ type: "text"; text: string }>; timestamp: number }> = [
		{
			role: "user",
			content: [
				{
					type: "text",
					text: `Current project:\n${projectContext(targetCwd)}\n\nSessions found with a now-missing cwd:\n- old path: ${group.oldCwd}\n- old name: ${basename(group.oldCwd)}\n- session count: ${group.sessions.length}\n- previews:\n${summary}`,
				},
			],
			timestamp: Date.now(),
		},
	];

	const response = await completeSimple(model, { systemPrompt: CLAIM_SYSTEM_PROMPT, messages }, options);
	if (response.stopReason === "error" || response.stopReason === "aborted") return undefined;

	const text = response.content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("\n");
	return extractClaim(text);
}

// ── Display ─────────────────────────────────────────────────────────────────

interface GroupDisplay {
	group: DanglingGroup;
	marker: string | undefined;
}

function isSameName(a: string, b: string): boolean {
	return basename(a) === basename(b);
}

function describeMarker(claim: Claim | undefined): string | undefined {
	if (claim === "belongs") return "claim: likely from this project";
	if (claim === "other") return "claim: different project";
	if (claim === "unknown") return "claim: unclear";
	return undefined;
}

function optionText(display: GroupDisplay): string {
	const suffix = display.marker ? `  ·  ${display.marker}` : "";
	return `${display.group.oldCwd}  ·  ${display.group.sessions.length} session${
		display.group.sessions.length === 1 ? "" : "s"
	}${suffix}`;
}

async function annotateGroups(
	ctx: ExtensionContext,
	groups: DanglingGroup[],
	config: MigrateConfig,
	targetCwd: string,
): Promise<GroupDisplay[]> {
	const displays: GroupDisplay[] = [];
	for (const group of groups) {
		let marker: string | undefined;
		if (isSameName(group.oldCwd, targetCwd)) {
			marker = "same name";
		} else if (config.model) {
			ctx.ui.setStatus("migrate", `claiming ${group.oldCwd}…`);
			try {
				marker = describeMarker(await claimGroup(ctx, group, config, targetCwd));
			} catch {
				marker = undefined;
			}
		}
		displays.push({ group, marker });
	}
	ctx.ui.setStatus("migrate", undefined);
	return displays;
}

async function pickGroup(
	displays: GroupDisplay[],
	ctx: ExtensionCommandContext,
): Promise<GroupDisplay | undefined> {
	if (displays.length === 1) return displays[0];
	const choice = await ctx.ui.select("Migrate which old project into this one?", displays.map(optionText));
	return displays.find((display) => optionText(display) === choice);
}

// ── Migration run ───────────────────────────────────────────────────────────

function reportResult(ctx: ExtensionCommandContext, result: { migrated: string[]; skipped: { id: string; reason: string }[] }): void {
	const skippedText =
		result.skipped.length > 0
			? `, skipped ${result.skipped.length} (id already exists in target)`
			: "";
	ctx.ui.notify(`Migrated ${result.migrated.length} session${result.migrated.length === 1 ? "" : "s"}${skippedText}`, "info");
}

async function migrateOneGroup(
	ctx: ExtensionCommandContext,
	display: GroupDisplay,
	targetCwd: string,
	sessionsRoot: string,
): Promise<void> {
	const ok = await ctx.ui.confirm(
		"Migrate sessions",
		`${display.group.oldCwd}\n\n${display.group.sessions.length} session${
			display.group.sessions.length === 1 ? "" : "s"
		} will be copied into the current project:\n${targetCwd}\n\nSource directory is kept as a backup.`,
	);
	if (!ok) {
		ctx.ui.notify("Migration cancelled", "warning");
		return;
	}

	ctx.ui.setStatus("migrate", "migrating…");
	try {
		const result = migrateGroup(display.group, targetCwd, sessionsRoot);
		reportResult(ctx, result);
	} finally {
		ctx.ui.setStatus("migrate", undefined);
	}
}

async function runScan(ctx: ExtensionCommandContext): Promise<void> {
	const sessionsRoot = getSessionsRoot(getAgentDir());
	const groups = scanDanglingGroups(sessionsRoot);
	if (groups.length === 0) {
		ctx.ui.notify("No dangling sessions found (projects whose path no longer exists)", "info");
		return;
	}

	const { value: config, warnings } = loadConfig();
	for (const warning of warnings) {
		ctx.ui.notify(warning, "warning");
	}

	const displays = await annotateGroups(ctx, groups, config, ctx.cwd);
	const selected = await pickGroup(displays, ctx);
	if (!selected) return;

	await migrateOneGroup(ctx, selected, ctx.cwd, sessionsRoot);
}

async function runExplicit(ctx: ExtensionCommandContext, oldCwd: string): Promise<void> {
	if (!existsSync(oldCwd)) {
		ctx.ui.notify(`Old path does not exist: ${oldCwd}`, "warning");
	}

	const sessionsRoot = getSessionsRoot(getAgentDir());
	const encodedDir = encodeSessionDir(oldCwd);
	const group = readSessionDirAsGroup(encodedDir, sessionsRoot, oldCwd);
	if (!group) {
		ctx.ui.notify(`No sessions found under ${oldCwd} (${encodedDir})`, "error");
		return;
	}

	await migrateOneGroup(ctx, { group, marker: undefined }, ctx.cwd, sessionsRoot);
}

// ── Entry point ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerCommand("migrate", {
		description: "Migrate sessions from a moved project into this project",
		handler: async (args, ctx) => {
			const command = parseMigrateCommand(args, ctx.cwd);
			switch (command.kind) {
				case "settings":
					await showSettings(ctx);
					return;
				case "scan":
					await runScan(ctx);
					return;
				case "explicit":
					await runExplicit(ctx, command.oldCwd);
					return;
			}
		},
	});
}
