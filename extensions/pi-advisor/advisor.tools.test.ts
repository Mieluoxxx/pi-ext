import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateAdvisorTools } from "./advisor/config.js";
import {
	createAdvisorToolRuntime,
	EXPAND_TOOL,
	GIT_DIFF_TOOL,
	resolveInsideCwd,
	splitToolResult,
} from "./advisor/tools.js";
import { createMockCtx, createMockPi, makeToolResult } from "./test/helpers.js";

const config = validateAdvisorTools(undefined);
let cwd: string;
let outside: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "advisor-tools-"));
	outside = mkdtempSync(join(tmpdir(), "advisor-outside-"));
	writeFileSync(join(cwd, "app.ts"), "export const answer = 42;\n");
	writeFileSync(join(outside, "secrets.txt"), "TOP SECRET\n");
	writeFileSync(join(cwd, ".env"), "API_KEY=live\n");
});
afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
});

describe("resolveInsideCwd", () => {
	it("accepts paths inside the workspace, relative or absolute", () => {
		expect(resolveInsideCwd(cwd, "app.ts", [])).toHaveProperty("path");
		expect(resolveInsideCwd(cwd, join(cwd, "app.ts"), [])).toHaveProperty("path");
		expect(resolveInsideCwd(cwd, "nested/new-file.ts", [])).toHaveProperty("path");
	});

	it("rejects traversal and absolute paths outside the workspace", () => {
		expect(resolveInsideCwd(cwd, "../../etc/passwd", [])).toHaveProperty("error");
		expect(resolveInsideCwd(cwd, join(outside, "secrets.txt"), [])).toHaveProperty("error");
	});

	it("rejects a symlink that escapes the workspace", () => {
		// A prefix check on the unresolved path would follow this link out.
		symlinkSync(outside, join(cwd, "escape"));
		expect(resolveInsideCwd(cwd, "escape/secrets.txt", [])).toHaveProperty("error");
	});

	it("rejects a symlinked DIRECTORY escape even when the leaf does not exist", () => {
		symlinkSync(outside, join(cwd, "escape"));
		expect(resolveInsideCwd(cwd, "escape/not-created-yet.txt", [])).toHaveProperty("error");
	});

	it("denies credential-shaped files by policy", () => {
		for (const path of [".env", ".env.local", "server.pem", "id_rsa", "cert.key"]) {
			const result = resolveInsideCwd(cwd, path, config.denyPatterns);
			expect(result).toHaveProperty("error");
			expect((result as { error: string }).error).toContain("denied");
		}
		expect(resolveInsideCwd(cwd, "nested/.env", config.denyPatterns)).toHaveProperty("error");
		expect(resolveInsideCwd(cwd, "environment.ts", config.denyPatterns)).toHaveProperty("path");
	});
});

describe("splitToolResult — how an image reaches the advisor", () => {
	// This is the ONLY route an image reaches the advisor: it asked for a specific
	// file, so the bytes stay inside one investigation round instead of being
	// pinned into the ledger prefix that later consultations reuse.
	const imageResult = {
		content: [
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "image", data: "PNGDATA", mimeType: "image/png" },
		],
	};

	it("forwards the image to a vision-capable advisor", () => {
		const { text, images } = splitToolResult(imageResult, 12000, true);
		expect(text).toContain("Read image file");
		expect(images).toEqual([{ type: "image", data: "PNGDATA", mimeType: "image/png" }]);
	});

	it("downgrades it to a marker for a text-only advisor, which would reject it", () => {
		const { text, images } = splitToolResult(imageResult, 12000, false);
		expect(images).toEqual([]);
		expect(text).toContain("accepts text only");
		expect(text).not.toContain("PNGDATA");
	});

	it("caps text and tolerates a string body", () => {
		expect(splitToolResult({ content: "x".repeat(50000) }, 500, true).text.length).toBeLessThan(700);
		expect(splitToolResult({}, 500, true)).toEqual({ text: "", images: [] });
	});
});

describe("advisor tool runtime", () => {
	const branch = (): SessionEntry[] => [
		{
			type: "message",
			id: "r1",
			parentId: null,
			timestamp: "",
			message: makeToolResult({ toolCallId: "c1", toolName: "read", text: "THE FULL BODY" }),
		} as unknown as SessionEntry,
	];

	const runtime = (overrides = {}) => {
		const { pi } = createMockPi();
		const ctx = createMockCtx({ cwd });
		return {
			pi,
			rt: createAdvisorToolRuntime(ctx, pi, { ...config, ...overrides }, branch),
		};
	};

	it("declares expand plus the read-only repo surface", () => {
		const names = runtime().rt.declarations.map((d) => d.name);
		expect(names).toEqual(expect.arrayContaining([EXPAND_TOOL, "read", "grep", "find", "ls", GIT_DIFF_TOOL]));
		// No mutating tool may ever be declared to the advisor.
		expect(names).not.toEqual(expect.arrayContaining(["edit", "write", "bash"]));
	});

	it("declares only expand when repo access is off", () => {
		expect(runtime({ repo: false }).rt.declarations.map((d) => d.name)).toEqual([EXPAND_TOOL]);
	});

	it("expands a ledger id and reports a missing one without failing the round", async () => {
		const { rt } = runtime();
		const hit = await rt.run(EXPAND_TOOL, { ids: ["r1"] });
		expect(hit.text).toContain("THE FULL BODY");
		const miss = await rt.run(EXPAND_TOOL, { ids: ["nope"] });
		expect(miss.text).toContain("not found");
		expect(miss.isError).toBeUndefined();
	});

	it("tolerates a leading # and rejects a malformed argument", async () => {
		const { rt } = runtime();
		expect((await rt.run(EXPAND_TOOL, { ids: ["#r1"] })).text).toContain("THE FULL BODY");
		expect((await rt.run(EXPAND_TOOL, { ids: "r1" })).isError).toBe(true);
	});

	it("reads a workspace file but refuses one outside it", async () => {
		const { rt } = runtime();
		expect((await rt.run("read", { path: "app.ts" })).text).toContain("answer = 42");
		const escape = await rt.run("read", { path: join(outside, "secrets.txt") });
		expect(escape.isError).toBe(true);
		expect(escape.text).not.toContain("TOP SECRET");
	});

	it("refuses a denied file even though it is inside the workspace", async () => {
		const denied = await runtime().rt.run("read", { path: ".env" });
		expect(denied.isError).toBe(true);
		expect(denied.text).not.toContain("live");
	});

	it("runs git_diff with fixed argv and no shell", async () => {
		const { pi } = createMockPi();
		const exec = vi.fn(async () => ({ stdout: " app.ts | 2 +-\n", stderr: "", code: 0, killed: false }));
		Object.assign(pi, { exec });
		const rt = createAdvisorToolRuntime(createMockCtx({ cwd }), pi, config, branch);
		expect((await rt.run(GIT_DIFF_TOOL, {})).text).toContain("app.ts");
		expect(exec).toHaveBeenCalledWith("git", ["diff", "--stat"], expect.objectContaining({ cwd }));
		await rt.run(GIT_DIFF_TOOL, { patch: true, staged: true });
		expect(exec).toHaveBeenLastCalledWith("git", ["diff", "--staged"], expect.anything());
	});

	it("never passes an unvalidated path to git", async () => {
		const { pi } = createMockPi();
		const exec = vi.fn(async () => ({ stdout: "", stderr: "", code: 0, killed: false }));
		Object.assign(pi, { exec });
		const rt = createAdvisorToolRuntime(createMockCtx({ cwd }), pi, config, branch);
		const result = await rt.run(GIT_DIFF_TOOL, { path: "../../etc" });
		expect(result.isError).toBe(true);
		expect(exec).not.toHaveBeenCalled();
	});

	it("reports a git failure instead of throwing", async () => {
		const { pi } = createMockPi();
		Object.assign(pi, {
			exec: vi.fn(async () => ({ stdout: "", stderr: "not a git repository", code: 128, killed: false })),
		});
		const rt = createAdvisorToolRuntime(createMockCtx({ cwd }), pi, config, branch);
		const result = await rt.run(GIT_DIFF_TOOL, {});
		expect(result.isError).toBe(true);
		expect(result.text).toContain("not a git repository");
	});

	it("caps a large result", async () => {
		mkdirSync(join(cwd, "big"), { recursive: true });
		writeFileSync(join(cwd, "big/huge.txt"), "w".repeat(80000));
		const result = await runtime({ maxResultChars: 1000 }).rt.run("read", { path: "big/huge.txt" });
		expect(result.text.length).toBeLessThan(2000);
	});

	it("rejects an unknown tool name", async () => {
		expect((await runtime().rt.run("rm", {})).isError).toBe(true);
	});
});
