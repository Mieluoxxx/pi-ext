/**
 * Storage adapter for Pi session files.
 *
 * Mirrors Pi's internal session layout so the extension never depends on a
 * public "relocate project" API:
 *
 *   <agentDir>/sessions/--<encoded-cwd>--/<timestamp>_<session-id>.jsonl
 *
 * The encoding mirrors `getDefaultSessionDirPath` in
 * `@earendil-works/pi-coding-agent` core: strip the leading separator, replace
 * `/`, `\` and `:` with `-`, wrap in `--…--`.
 *
 * A session is "dangling" when its header `cwd` no longer exists on disk —
 * the usual state after a project is moved to a new path or deleted.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

// ── Path encoding ──────────────────────────────────────────────────────────

/** Encode a project absolute path into its Pi sessions directory name. */
export function encodeSessionDir(cwd: string): string {
	const resolvedCwd = resolve(cwd);
	return `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** Absolute path of the per-user sessions root (<agentDir>/sessions). */
export function getSessionsRoot(agentDir: string): string {
	return join(agentDir, "sessions");
}

// ── Session header ─────────────────────────────────────────────────────────

export interface SessionHeaderRecord {
	type?: unknown;
	id?: unknown;
	cwd?: unknown;
	parentSession?: unknown;
	[key: string]: unknown;
}

/** Parse a single JSON session-header line. Returns null on invalid JSON. */
export function parseSessionHeader(json: string): SessionHeaderRecord | null {
	try {
		const value: unknown = JSON.parse(json);
		if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			return value as SessionHeaderRecord;
		}
	} catch {
		// fall through
	}
	return null;
}

/** Read the first line of a session file as its header. Returns null on failure. */
export function readSessionHeader(filePath: string): SessionHeaderRecord | null {
	let content: string;
	try {
		content = readFileSync(filePath, "utf8");
	} catch {
		return null;
	}
	const newlineIndex = content.search(/\r?\n/);
	const firstLine = newlineIndex === -1 ? content : content.slice(0, newlineIndex);
	return parseSessionHeader(firstLine);
}

/** Extract the session id from a `<timestamp>_<id>.jsonl` file name. */
export function sessionIdFromFileName(fileName: string): string {
	const base = fileName.replace(/\.jsonl$/, "");
	const underscore = base.indexOf("_");
	return underscore === -1 ? base : base.slice(underscore + 1);
}

// ── Dangling scan ──────────────────────────────────────────────────────────

export interface DanglingSession {
	id: string;
	filePath: string;
}

export interface DanglingGroup {
	/** Header cwd of these sessions (the old, now-missing project path). */
	oldCwd: string;
	/** Encoded sessions directory name under <agentDir>/sessions. */
	encodedDir: string;
	sessions: DanglingSession[];
}

/** Scan every dangling session and group them by their old project cwd. */
export function scanDanglingGroups(sessionsRoot: string): DanglingGroup[] {
	if (!existsSync(sessionsRoot)) return [];

	const groups = new Map<string, DanglingGroup>();
	for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		const dirPath = join(sessionsRoot, entry.name);

		let files: string[];
		try {
			files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
		} catch {
			continue;
		}

		for (const file of files) {
			const filePath = join(dirPath, file);
			const header = readSessionHeader(filePath);
			const cwd = header?.cwd;
			if (typeof cwd !== "string" || !cwd || existsSync(cwd)) continue;

			const id = typeof header.id === "string" && header.id ? header.id : sessionIdFromFileName(file);
			let group = groups.get(cwd);
			if (!group) {
				group = { oldCwd: cwd, encodedDir: entry.name, sessions: [] };
				groups.set(cwd, group);
			}
			group.sessions.push({ id, filePath });
		}
	}

	return [...groups.values()].sort((a, b) => b.sessions.length - a.sessions.length);
}

/** Read every session under one encoded dir as a group (no dangling filter). */
export function readSessionDirAsGroup(
	encodedDir: string,
	sessionsRoot: string,
	fallbackCwd: string,
): DanglingGroup | null {
	const dirPath = join(sessionsRoot, encodedDir);
	if (!existsSync(dirPath)) return null;

	let files: string[];
	try {
		files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
	} catch {
		return null;
	}

	const sessions: DanglingSession[] = [];
	let firstCwd: string | undefined;
	for (const file of files) {
		const filePath = join(dirPath, file);
		const header = readSessionHeader(filePath);
		const cwd = typeof header?.cwd === "string" && header.cwd ? header.cwd : undefined;
		firstCwd ??= cwd;
		const id = typeof header?.id === "string" && header.id ? header.id : sessionIdFromFileName(file);
		sessions.push({ id, filePath });
	}

	if (sessions.length === 0) return null;
	return { oldCwd: firstCwd ?? resolve(fallbackCwd), encodedDir, sessions };
}

// ── Migration ──────────────────────────────────────────────────────────────

export interface MigrateResult {
	migrated: string[];
	skipped: { id: string; reason: string }[];
}

/**
 * Atomically copy a session file while rewriting the header's first line.
 * Writes to a temp file in the target directory, then renames into place.
 */
export function copySessionWithRewrittenHeader(
	sourcePath: string,
	targetPath: string,
	rewrite: (header: SessionHeaderRecord) => SessionHeaderRecord,
): void {
	const content = readFileSync(sourcePath, "utf8");
	const newline = content.includes("\r\n") ? "\r\n" : "\n";
	const lines = content.split(newline);
	const [first = ""] = lines;

	let headerLine = first;
	const parsed = parseSessionHeader(first);
	if (parsed) {
		headerLine = JSON.stringify(rewrite(parsed));
	}

	const rewritten = [headerLine, ...lines.slice(1)].join(newline);
	const tempPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(tempPath, rewritten, "utf8");
	renameSync(tempPath, targetPath);
}

/**
 * Migrate one dangling group into the target cwd's default sessions
 * directory. Sessions whose id already exists in the target are skipped.
 * The source directory is left untouched as a backup.
 */
export function migrateGroup(group: DanglingGroup, targetCwd: string, sessionsRoot: string): MigrateResult {
	const targetDir = join(sessionsRoot, encodeSessionDir(targetCwd));
	mkdirSync(targetDir, { recursive: true });

	const existingIds = new Set(
		readdirSync(targetDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => sessionIdFromFileName(f)),
	);

	const oldDirPrefix = join(sessionsRoot, group.encodedDir);
	const newDirPrefix = join(sessionsRoot, encodeSessionDir(targetCwd));

	const migrated: string[] = [];
	const skipped: { id: string; reason: string }[] = [];

	for (const session of group.sessions) {
		if (existingIds.has(session.id)) {
			skipped.push({ id: session.id, reason: "id already exists in target project" });
			continue;
		}

		const targetPath = join(targetDir, basename(session.filePath));
		copySessionWithRewrittenHeader(session.filePath, targetPath, (header) => {
			const rewritten: SessionHeaderRecord = { ...header };
			if (typeof rewritten.cwd === "string") rewritten.cwd = resolve(targetCwd);

			const parent = rewritten.parentSession;
			if (typeof parent === "string") {
				const prefix = `${oldDirPrefix}/`;
				if (parent.startsWith(prefix)) {
					rewritten.parentSession = join(newDirPrefix, parent.slice(prefix.length));
				}
			}
			return rewritten;
		});
		migrated.push(targetPath);
	}

	return { migrated, skipped };
}
