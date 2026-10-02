/**
 * tools — the advisor's read-only investigation surface.
 *
 * The ledger hands the advisor one-line cards for older work, so it needs a way
 * back to the evidence. Two kinds:
 *   - advisor_expand: the verbatim text of a past session entry (what happened).
 *   - read / grep / find / ls / git_diff: the workspace as it is NOW (what is).
 *
 * Everything here is read-only and confined to the session cwd. The advisor is
 * a second provider seeing this repository, so credential-shaped files are
 * denied by default even though the executor's own read tool would serve them.
 */

import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ImageContent, Tool } from "@earendil-works/pi-ai";
import {
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AdvisorTools } from "./config.js";
import { clipMiddle } from "./cards.js";
import { expandEntry } from "./ledger.js";

export const EXPAND_TOOL = "advisor_expand";
export const GIT_DIFF_TOOL = "git_diff";

/** Result of one advisor tool invocation. `isError` is reported to the model
 *  rather than thrown so a refusal costs one round, not the consultation. */
export interface AdvisorToolResult {
	text: string;
	isError?: boolean;
	/**
	 * Images the tool returned. This is the ONLY way an image reaches the advisor:
	 * it asked for a specific file, so the bytes arrive inside one investigation
	 * round instead of being pinned into the append-only ledger prefix.
	 */
	images?: ImageContent[];
}

export interface AdvisorToolRuntime {
	/** Declarations sent to the provider. Must be byte-identical across every
	 *  round of every consultation, or the cached prefix breaks. */
	declarations: Tool[];
	run(name: string, args: unknown, signal?: AbortSignal): Promise<AdvisorToolResult>;
}

function globToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
	return new RegExp(`^${escaped}$`);
}

/**
 * Resolve a model-supplied path inside `cwd`, or explain the refusal.
 *
 * realpath runs on the deepest existing ancestor so a symlink that escapes the
 * workspace is caught even when the leaf does not exist yet — a plain
 * `resolve()` prefix check would follow the link.
 */
export function resolveInsideCwd(cwd: string, input: string, deny: string[]): { path: string } | { error: string } {
	const candidate = isAbsolute(input) ? input : resolve(cwd, input);
	let root = cwd;
	try {
		root = realpathSync(cwd);
	} catch {
		// A cwd that cannot be resolved is compared literally.
	}
	let probe = candidate;
	let resolved = candidate;
	for (let depth = 0; depth < 64; depth++) {
		try {
			resolved = resolve(realpathSync(probe), relative(probe, candidate));
			break;
		} catch {
			const parent = resolve(probe, "..");
			if (parent === probe) break;
			probe = parent;
		}
	}
	const rel = relative(root, resolved);
	if (rel.startsWith("..") || isAbsolute(rel))
		return { error: `Path is outside the session workspace: ${input}` };
	const posix = rel.split(sep).join("/");
	const base = posix.slice(posix.lastIndexOf("/") + 1);
	for (const pattern of deny) {
		const re = globToRegExp(pattern);
		if (re.test(base) || re.test(posix)) return { error: `Path is denied to the advisor by policy: ${input}` };
	}
	return { path: resolved };
}

const expandSchema = Type.Object({
	ids: Type.Array(Type.String(), {
		description: "Session entry ids from the ledger, written without the leading '#'.",
	}),
});

const gitDiffSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Limit the diff to this path." })),
	patch: Type.Optional(Type.Boolean({ description: "Include the patch body, not just the stat. Default false." })),
	staged: Type.Optional(Type.Boolean({ description: "Diff the index instead of the working tree." })),
});

const EXPAND_DESCRIPTION =
	"Retrieve the verbatim text behind a ledger card. The executor log summarises older tool calls as one-line " +
	"cards; pass their ids here to read what the tool actually returned. Use this for what HAPPENED; use read/grep " +
	"for the workspace's CURRENT state.";

const GIT_DIFF_DESCRIPTION =
	"Show the workspace's net change as git sees it. Returns --stat by default; set patch:true for the diff body. " +
	"Call this before judging whether work is complete or reviewing what changed — the log records individual " +
	"edits, not the net result.";

/**
 * Split a pi tool result into text and images. pi's own tools already truncate
 * their output; the extra cap here is tighter because the advisor pays for it
 * inside a consultation budget.
 *
 * Images are kept when the advisor model accepts image input — `read` on a
 * screenshot is exactly how the advisor sees a picture without any image ever
 * entering the ledger. A text-only model would reject them, so they are replaced
 * with a marker instead.
 */
export function splitToolResult(
	result: { content?: unknown },
	maxChars: number,
	allowImages: boolean,
): { text: string; images: ImageContent[] } {
	const content = result.content;
	if (typeof content === "string") return { text: clipMiddle(content, maxChars), images: [] };
	if (!Array.isArray(content)) return { text: "", images: [] };
	const parts: string[] = [];
	const images: ImageContent[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const typed = block as { type?: string; text?: string };
		if (typed.type === "text" && typed.text) parts.push(typed.text);
		else if (typed.type === "image") {
			if (allowImages) images.push(block as ImageContent);
			else parts.push("[image omitted — this advisor model accepts text only]");
		}
	}
	return { text: clipMiddle(parts.join("\n"), maxChars), images };
}

/**
 * Build the advisor's tool runtime.
 *
 * `branch` is read through a callback so an expand during a long consultation
 * sees the session as it is at that moment, not a snapshot from dispatch.
 */
export function createAdvisorToolRuntime(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	config: AdvisorTools,
	getBranch: () => readonly SessionEntry[],
	/** True when the advisor model accepts image input. */
	allowImages = false,
): AdvisorToolRuntime {
	const cwd = ctx.cwd;
	const cap = config.maxResultChars;
	const declarations: Tool[] = [
		{ name: EXPAND_TOOL, description: EXPAND_DESCRIPTION, parameters: expandSchema },
	];

	const repoTools = new Map<string, { execute: (id: string, params: never, signal?: AbortSignal) => Promise<unknown> }>();
	if (config.repo) {
		const built = {
			read: createReadTool(cwd),
			grep: createGrepTool(cwd),
			find: createFindTool(cwd),
			ls: createLsTool(cwd),
		};
		for (const [name, tool] of Object.entries(built)) {
			declarations.push({ name, description: tool.description, parameters: tool.parameters });
			repoTools.set(name, tool as never);
		}
		declarations.push({ name: GIT_DIFF_TOOL, description: GIT_DIFF_DESCRIPTION, parameters: gitDiffSchema });
	}

	const runExpand = (args: unknown): AdvisorToolResult => {
		const ids = (args as { ids?: unknown })?.ids;
		if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))
			return { text: "advisor_expand requires `ids`: an array of ledger entry ids.", isError: true };
		const branch = getBranch();
		// Split the cap across the requested ids so one huge entry cannot starve
		// the rest of the batch.
		const per = Math.max(512, Math.floor(cap / Math.max(1, ids.length)));
		const parts = (ids as string[]).map((raw) => {
			const id = raw.replace(/^#/, "");
			const text = expandEntry(branch, id, per);
			return text === undefined ? `#${id}: not found in this session branch.` : `#${id}:\n${text}`;
		});
		return { text: parts.join("\n\n") };
	};

	const runGitDiff = async (args: unknown, signal?: AbortSignal): Promise<AdvisorToolResult> => {
		const input = (args ?? {}) as { path?: unknown; patch?: unknown; staged?: unknown };
		const argv = ["diff"];
		if (input.staged === true) argv.push("--staged");
		if (input.patch !== true) argv.push("--stat");
		if (typeof input.path === "string" && input.path.trim()) {
			const resolved = resolveInsideCwd(cwd, input.path, config.denyPatterns);
			if ("error" in resolved) return { text: resolved.error, isError: true };
			argv.push("--", resolved.path);
		}
		// Fixed argv through pi.exec, which spawns with shell: false — a
		// model-supplied path can never become shell syntax.
		const result = await pi.exec("git", argv, { cwd, signal, timeout: 20000 });
		if (result.code !== 0 && !result.stdout.trim())
			return { text: `git ${argv.join(" ")} failed: ${clipMiddle(result.stderr || "no output", 2000)}`, isError: true };
		const body = result.stdout.trim() || "(no changes)";
		return { text: clipMiddle(body, cap) };
	};

	const runRepoTool = async (name: string, args: unknown, signal?: AbortSignal): Promise<AdvisorToolResult> => {
		const tool = repoTools.get(name);
		if (!tool) return { text: `Unknown tool: ${name}`, isError: true };
		const target = (args as { path?: unknown })?.path;
		if (typeof target === "string" && target.trim()) {
			const resolved = resolveInsideCwd(cwd, target, config.denyPatterns);
			if ("error" in resolved) return { text: resolved.error, isError: true };
			args = { ...(args as object), path: resolved.path };
		}
		try {
			const result = await tool.execute(`advisor-${name}`, args as never, signal);
			const { text, images } = splitToolResult(result as { content?: unknown }, cap, allowImages);
			return { text, ...(images.length ? { images } : {}) };
		} catch (error) {
			return { text: `${name} failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
		}
	};

	return {
		declarations,
		async run(name, args, signal) {
			if (name === EXPAND_TOOL) return runExpand(args);
			if (name === GIT_DIFF_TOOL) return config.repo
				? runGitDiff(args, signal)
				: { text: "Repository tools are disabled for the advisor.", isError: true };
			return runRepoTool(name, args, signal);
		},
	};
}
