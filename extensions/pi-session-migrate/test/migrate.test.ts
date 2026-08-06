import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	encodeSessionDir,
	getSessionsRoot,
	migrateGroup,
	parseSessionHeader,
	readSessionDirAsGroup,
	readSessionHeader,
	scanDanglingGroups,
	sessionIdFromFileName,
	type DanglingGroup,
} from "../src/storage.js";
import {
	buildGroupSummary,
	CLAIM_SYSTEM_PROMPT,
	extractClaim,
	expandUserPath,
	parseMigrateCommand,
	parseModelRef,
	readSessionPreview,
	resolveThinkingLevel,
	stripQuotes,
} from "../src/migrate.js";

const tempRoots: string[] = [];

function makeTempRoot(): string {
	const root = join(tmpdir(), `pi-session-migrate-test-${process.pid}-${tempRoots.length}`);
	rmSync(root, { recursive: true, force: true });
	mkdirSync(root, { recursive: true });
	tempRoots.push(root);
	return root;
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function writeSessionFile(dir: string, fileName: string, header: Record<string, unknown>, entries: unknown[] = []): string {
	const lines = [JSON.stringify(header), ...entries.map((entry) => JSON.stringify(entry))];
	const filePath = join(dir, fileName);
	writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
	return filePath;
}

const SESSION_ID = "019fd07e-782e-70f4-90ef-7bc6324d9e05";

// ── Path encoding ───────────────────────────────────────────────────────────

describe("encodeSessionDir", () => {
	it("mirrors Pi's directory encoding", () => {
		expect(encodeSessionDir("/Users/moguw/workspace/LazyPi")).toBe("--Users-moguw-workspace-LazyPi--");
		expect(encodeSessionDir("/Users/moguw/pi-space/pi-ext")).toBe("--Users-moguw-pi-space-pi-ext--");
	});

	it("handles a POSIX absolute path with a leading slash", () => {
		expect(encodeSessionDir("/var/tmp/deep/nested")).toBe("--var-tmp-deep-nested--");
	});
});

describe("getSessionsRoot", () => {
	it("joins the agent dir with sessions", () => {
		expect(getSessionsRoot("/x/.pi/agent")).toBe("/x/.pi/agent/sessions");
	});
});

// ── Session header ──────────────────────────────────────────────────────────

describe("parseSessionHeader", () => {
	it("parses a valid header line", () => {
		const header = parseSessionHeader(
			'{"type":"session","version":3,"id":"abc","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/old/path"}',
		);
		expect(header?.cwd).toBe("/old/path");
		expect(header?.id).toBe("abc");
	});

	it("returns null for invalid JSON", () => {
		expect(parseSessionHeader("not json")).toBeNull();
		expect(parseSessionHeader("[1,2,3]")).toBeNull();
	});
});

describe("sessionIdFromFileName", () => {
	it("extracts the id after the timestamp prefix", () => {
		expect(sessionIdFromFileName(`2026-08-05T05-56-17-070Z_${SESSION_ID}.jsonl`)).toBe(SESSION_ID);
	});

	it("falls back to the whole base name without an underscore", () => {
		expect(sessionIdFromFileName(`${SESSION_ID}.jsonl`)).toBe(SESSION_ID);
	});
});

// ── Dangling scan ───────────────────────────────────────────────────────────

describe("scanDanglingGroups", () => {
	it("groups dangling sessions by old cwd and skips live ones", () => {
		const root = makeTempRoot();
		const sessionsRoot = getSessionsRoot(root);
		const oldEncoded = encodeSessionDir("/old/now-gone/LazyPi");
		const oldDir = join(sessionsRoot, oldEncoded);
		mkdirSync(oldDir, { recursive: true });

		writeSessionFile(oldDir, `2026-08-05T00-00-00-000Z_${SESSION_ID}.jsonl`, {
			type: "session",
			version: 3,
			id: SESSION_ID,
			timestamp: "2026-08-05T00:00:00.000Z",
			cwd: "/old/now-gone/LazyPi",
		});
		writeSessionFile(oldDir, `2026-08-05T01-00-00-000Z_019fcfae-4cf2-7841-9e59-8380399ed3b2.jsonl`, {
			type: "session",
			version: 3,
			id: "019fcfae-4cf2-7841-9e59-8380399ed3b2",
			timestamp: "2026-08-05T01:00:00.000Z",
			cwd: "/old/now-gone/LazyPi",
		});

		// A live project's session must not be reported as dangling.
		const liveDir = join(sessionsRoot, encodeSessionDir(root));
		mkdirSync(liveDir, { recursive: true });
		writeSessionFile(liveDir, `2026-08-05T02-00-00-000Z_019fcfce-5d78-7511-9956-f1f534fcc69a.jsonl`, {
			type: "session",
			version: 3,
			id: "019fcfce-5d78-7511-9956-f1f534fcc69a",
			timestamp: "2026-08-05T02:00:00.000Z",
			cwd: root,
		});

		const groups = scanDanglingGroups(sessionsRoot);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.oldCwd).toBe("/old/now-gone/LazyPi");
		expect(groups[0]?.sessions).toHaveLength(2);
		expect(groups[0]?.encodedDir).toBe(oldEncoded);
	});

	it("returns [] when the sessions root does not exist", () => {
		expect(scanDanglingGroups(join(makeTempRoot(), "missing"))).toEqual([]);
	});
});

describe("readSessionDirAsGroup", () => {
	it("reads every session under an encoded dir without a dangling filter", () => {
		const root = makeTempRoot();
		const sessionsRoot = getSessionsRoot(root);
		const encoded = encodeSessionDir("/some/place");
		const dir = join(sessionsRoot, encoded);
		mkdirSync(dir, { recursive: true });
		writeSessionFile(dir, `2026-08-05T00-00-00-000Z_${SESSION_ID}.jsonl`, {
			type: "session",
			version: 3,
			id: SESSION_ID,
			timestamp: "2026-08-05T00:00:00.000Z",
			cwd: "/some/place",
		});

		const group = readSessionDirAsGroup(encoded, sessionsRoot, "/some/place");
		expect(group?.sessions).toHaveLength(1);
		expect(group?.oldCwd).toBe("/some/place");

		expect(readSessionDirAsGroup(encodeSessionDir("/nowhere"), sessionsRoot, "/nowhere")).toBeNull();
	});
});

// ── Migration ───────────────────────────────────────────────────────────────

describe("migrateGroup", () => {
	function makeGroup(root: string, sessionsRoot: string): { group: DanglingGroup; sourceFile: string } {
		const oldEncoded = encodeSessionDir("/old/now-gone/LazyPi");
		const oldDir = join(sessionsRoot, oldEncoded);
		mkdirSync(oldDir, { recursive: true });
		const sourceFile = writeSessionFile(
			oldDir,
			`2026-08-05T00-00-00-000Z_${SESSION_ID}.jsonl`,
			{
				type: "session",
				version: 3,
				id: SESSION_ID,
				timestamp: "2026-08-05T00:00:00.000Z",
				cwd: "/old/now-gone/LazyPi",
				parentSession: join(sessionsRoot, oldEncoded, "2026-08-01T00-00-00-000Z_parent.jsonl"),
			},
			[{ type: "message", id: "1234", parentId: null, timestamp: "2026-08-05T00:00:01.000Z", message: { role: "user", content: "hello" } }],
		);
		return {
			group: { oldCwd: "/old/now-gone/LazyPi", encodedDir: oldEncoded, sessions: [{ id: SESSION_ID, filePath: sourceFile }] },
			sourceFile,
		};
	}

	it("rewrites header cwd and parentSession into the target project", () => {
		const root = makeTempRoot();
		const sessionsRoot = getSessionsRoot(root);
		const targetCwd = resolve(root, "new-home/LazyPi");
		const { group } = makeGroup(root, sessionsRoot);

		const result = migrateGroup(group, targetCwd, sessionsRoot);
		expect(result.migrated).toHaveLength(1);
		expect(result.skipped).toHaveLength(0);

		const targetDir = join(sessionsRoot, encodeSessionDir(targetCwd));
		const targetFile = join(targetDir, `2026-08-05T00-00-00-000Z_${SESSION_ID}.jsonl`);
		expect(existsSync(targetFile)).toBe(true);

		const header = readSessionHeader(targetFile);
		expect(header?.cwd).toBe(resolve(targetCwd));
		expect(header?.parentSession).toBe(
			join(join(sessionsRoot, encodeSessionDir(targetCwd)), "2026-08-01T00-00-00-000Z_parent.jsonl"),
		);

		// Message entries are preserved verbatim.
		const content = readFileSync(targetFile, "utf8");
		expect(content).toContain('"message":{"role":"user","content":"hello"}');
	});

	it("keeps the source directory as a backup", () => {
		const root = makeTempRoot();
		const sessionsRoot = getSessionsRoot(root);
		const { sourceFile } = makeGroup(root, sessionsRoot);
		migrateGroup({ oldCwd: "/old/now-gone/LazyPi", encodedDir: encodeSessionDir("/old/now-gone/LazyPi"), sessions: [{ id: SESSION_ID, filePath: sourceFile }] }, resolve(root, "dest"), sessionsRoot);
		expect(existsSync(sourceFile)).toBe(true);
	});

	it("skips sessions whose id already exists in the target", () => {
		const root = makeTempRoot();
		const sessionsRoot = getSessionsRoot(root);
		const targetCwd = resolve(root, "dest");
		const { group } = makeGroup(root, sessionsRoot);

		// Pre-create a session with the same id in the target dir.
		const targetDir = join(sessionsRoot, encodeSessionDir(targetCwd));
		mkdirSync(targetDir, { recursive: true });
		writeSessionFile(targetDir, `2026-08-05T00-00-00-000Z_${SESSION_ID}.jsonl`, {
			type: "session",
			version: 3,
			id: SESSION_ID,
			timestamp: "2026-08-05T00:00:00.000Z",
			cwd: targetCwd,
		});

		const result = migrateGroup(group, targetCwd, sessionsRoot);
		expect(result.migrated).toHaveLength(0);
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0]?.id).toBe(SESSION_ID);
	});
});

// ── Command parsing ─────────────────────────────────────────────────────────

describe("parseMigrateCommand", () => {
	it("parses bare /migrate as scan", () => {
		expect(parseMigrateCommand("", "/cwd")).toEqual({ kind: "scan" });
		expect(parseMigrateCommand("   ", "/cwd")).toEqual({ kind: "scan" });
	});

	it("keeps settings as the only subcommand", () => {
		expect(parseMigrateCommand("settings", "/cwd")).toEqual({ kind: "settings" });
		expect(parseMigrateCommand("  settings ", "/cwd")).toEqual({ kind: "settings" });
	});

	it("resolves an explicit old path", () => {
		expect(parseMigrateCommand("/Users/x/old-proj", "/cwd")).toEqual({
			kind: "explicit",
			oldCwd: "/Users/x/old-proj",
		});
		expect(parseMigrateCommand('"/Users/x/old proj"', "/cwd")).toEqual({
			kind: "explicit",
			oldCwd: "/Users/x/old proj",
		});
	});
});

describe("expandUserPath", () => {
	it("expands a leading tilde to the home directory", () => {
		const home = process.env.HOME ?? "";
		expect(expandUserPath("~/proj")).toBe(join(home, "proj"));
		expect(expandUserPath("/abs/path")).toBe("/abs/path");
		expect(expandUserPath("~other/proj")).toBe("~other/proj");
	});
});

describe("stripQuotes", () => {
	it("strips matching outer quotes", () => {
		expect(stripQuotes('"hello"')).toBe("hello");
		expect(stripQuotes("'hello'")).toBe("hello");
		expect(stripQuotes("hello")).toBe("hello");
	});
});

describe("parseModelRef / resolveThinkingLevel", () => {
	it("parses provider/model refs", () => {
		expect(parseModelRef("openai/gpt-4o")).toEqual({ provider: "openai", id: "gpt-4o" });
		expect(parseModelRef("nope")).toBeNull();
		expect(parseModelRef("a/")).toBeNull();
		expect(parseModelRef("/b")).toBeNull();
	});

	it("resolves thinking levels", () => {
		expect(resolveThinkingLevel("minimal")).toBe("minimal");
		expect(resolveThinkingLevel("off")).toBeUndefined();
		expect(resolveThinkingLevel("")).toBeUndefined();
		expect(resolveThinkingLevel("bogus")).toBeUndefined();
	});
});

// ── Claim ───────────────────────────────────────────────────────────────────

describe("extractClaim", () => {
	it("parses the claim tag", () => {
		expect(extractClaim("<claim>belongs</claim>")).toBe("belongs");
		expect(extractClaim("Prefix <claim> unknown </claim> suffix")).toBe("unknown");
		expect(extractClaim("<claim>other</claim>")).toBe("other");
		expect(extractClaim("no tag here")).toBeUndefined();
		expect(extractClaim("<claim>maybe</claim>")).toBeUndefined();
	});
});

describe("readSessionPreview / buildGroupSummary", () => {
	it("extracts user messages from a session file", () => {
		const root = makeTempRoot();
		const dir = join(root, "s");
		mkdirSync(dir, { recursive: true });
		const file = writeSessionFile(
			dir,
			`2026-08-05T00-00-00-000Z_${SESSION_ID}.jsonl`,
			{ type: "session", version: 3, id: SESSION_ID, timestamp: "2026-08-05T00:00:00.000Z", cwd: "/old" },
			[
				{ type: "message", id: "1", parentId: null, timestamp: "t", message: { role: "user", content: "fix the auth flow" } },
				{ type: "message", id: "2", parentId: null, timestamp: "t", message: { role: "assistant", content: "done" } },
			],
		);
		expect(readSessionPreview(file)).toContain("fix the auth flow");
		expect(readSessionPreview(file)).not.toContain("done");

		const group: DanglingGroup = { oldCwd: "/old", encodedDir: "x", sessions: [{ id: SESSION_ID, filePath: file }] };
		const summary = buildGroupSummary(group);
		expect(summary).toContain("fix the auth flow");
		expect(summary).toContain(SESSION_ID.slice(0, 8));
	});

	it("returns empty for unreadable files", () => {
		expect(readSessionPreview(join(makeTempRoot(), "missing.jsonl"))).toBe("");
	});
});

describe("CLAIM_SYSTEM_PROMPT", () => {
	it("mentions the three claim outcomes", () => {
		expect(CLAIM_SYSTEM_PROMPT).toContain("belongs");
		expect(CLAIM_SYSTEM_PROMPT).toContain("other");
		expect(CLAIM_SYSTEM_PROMPT).toContain("unknown");
	});
});
