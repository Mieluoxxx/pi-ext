// 一次性集成验证：用真实 pi session 文件副本验证 scan → migrate 全流程。
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeSessionDir, getSessionsRoot, migrateGroup, readSessionHeader, scanDanglingGroups } from "../src/storage.js";

const REAL_SESSION = "/Users/moguw/.pi/agent/sessions/--Users-moguw-workspace-LazyPi--/2026-08-05T05-14-27-138Z_019fd058-2bc2-7d65-a966-cef6a7a7fec5.jsonl";

describe("real-data integration", () => {
	it("scans and migrates a copy of a real Pi session file", () => {
		if (!existsSync(REAL_SESSION)) return; // 真实文件不可用时跳过

		const root = join(tmpdir(), `pi-session-migrate-real-${process.pid}`);
		rmSync(root, { recursive: true, force: true });
		mkdirSync(root, { recursive: true });

		const sessionsRoot = getSessionsRoot(root);
		const oldEncoded = encodeSessionDir("/old/now-gone/LazyPi");
		const oldDir = join(sessionsRoot, oldEncoded);
		mkdirSync(oldDir, { recursive: true });
		const copied = join(oldDir, "2026-08-05T05-14-27-138Z_019fd058-2bc2-7d65-a966-cef6a7a7fec5.jsonl");
		copyFileSync(REAL_SESSION, copied);
		// 模拟项目已移走：把副本 header 的 cwd 改写为已不存在的旧路径
		const raw = readFileSync(copied, "utf8");
		const newlineIndex = raw.indexOf("\n");
		const firstLine = JSON.parse(raw.slice(0, newlineIndex)) as Record<string, unknown>;
		firstLine.cwd = "/old/now-gone/LazyPi";
		writeFileSync(copied, `${JSON.stringify(firstLine)}\n${raw.slice(newlineIndex + 1)}`, "utf8");
		const targetCwd = resolve(root, "new-home/LazyPi");

		const groups = scanDanglingGroups(sessionsRoot);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.oldCwd).toBe("/old/now-gone/LazyPi");
		expect(groups[0]?.sessions).toHaveLength(1);

		const result = migrateGroup(groups[0]!, targetCwd, sessionsRoot);
		expect(result.migrated).toHaveLength(1);

		const targetFile = join(sessionsRoot, encodeSessionDir(targetCwd), "2026-08-05T05-14-27-138Z_019fd058-2bc2-7d65-a966-cef6a7a7fec5.jsonl");
		const header = readSessionHeader(targetFile);
		expect(header?.cwd).toBe(resolve(targetCwd));

		// 除首行外其余行应逐字节一致
		const src = readFileSync(join(oldDir, "2026-08-05T05-14-27-138Z_019fd058-2bc2-7d65-a966-cef6a7a7fec5.jsonl"), "utf8");
		const dst = readFileSync(targetFile, "utf8");
		expect(dst.split("\n").slice(1).join("\n")).toBe(src.split("\n").slice(1).join("\n"));

		rmSync(root, { recursive: true, force: true });
	});
});
