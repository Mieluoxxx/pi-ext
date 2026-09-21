// node verify-reload.mjs <已安装 Pi 包根目录>
// 在临时目录内，用真实扩展源码和 Pi 加载器复现同一进程中的源码更新/重载。
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

assert.ok(process.argv[2], "需要 Pi 包根目录");
globalThis.fetch = async () => { throw new Error("Network calls are forbidden in this verification"); };
const { clearExtensionCache, loadExtensionsCached } = await import(pathToFileURL(join(process.argv[2], "dist/core/extensions/loader.js")));
const { DefaultResourceLoader } = await import(pathToFileURL(join(process.argv[2], "dist/core/resource-loader.js")));
const { SettingsManager } = await import(pathToFileURL(join(process.argv[2], "dist/core/settings-manager.js")));
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const packageRoot = join(repo, "extensions/pi-lazy-tools");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const entry = manifest.pi.extensions[0];
const source = readFileSync(join(packageRoot, entry), "utf8");
const oldSource = source
  .replace('!(name === "grep" && active.includes("ffgrep"))', "true")
  .replace('!(name === "find" && active.includes("fffind"))', "true");
assert.notEqual(oldSource, source, "必须能构造去重规则加入前的版本");

const initial = ["read", "bash", "goal_complete", "goal_blocked", "goal_wait", "grep", "find", "enable_interactive_shell", "load_capability", "ffgrep", "fffind", "apply_patch"];
const runSessionStart = async (loaded) => {
  assert.deepEqual(loaded.errors, []);
  let active = [...initial];
  loaded.runtime.getActiveTools = () => active;
  loaded.runtime.setActiveTools = (names) => { active = names; };
  const ctx = { sessionManager: { getBranch: () => [] } };
  for (const extension of loaded.extensions) {
    for (const hook of extension.handlers.get("session_start") ?? []) await hook({ reason: "reload" }, ctx);
  }
  return active;
};
const root = mkdtempSync(join(tmpdir(), "pi-reload-repro-"));
try {
  writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
  const result = {};
  for (const suffix of ["js", "ts"]) {
    const dir = join(root, suffix);
    mkdirSync(dir);
    const file = join(dir, `index.${suffix}`);
    const snapshot = async () => {
      // Match ResourceLoader.reload(): clear Pi's factory cache, then load again.
      clearExtensionCache();
      return runSessionStart(await loadExtensionsCached([file], repo));
    };
    writeFileSync(file, oldSource);
    const before = await snapshot();
    assert.equal(before.length, 12);
    writeFileSync(file, source);
    const after = await snapshot();
    result[suffix] = { before: before.length, after: after.length, duplicateTools: after.filter((name) => name === "grep" || name === "find") };
  }
  console.log(JSON.stringify({ configuredEntry: entry, sameProcessReload: result }, null, 2));
  const configured = result[basename(entry).endsWith(".ts") ? "ts" : "js"];
  assert.equal(configured.after, 10, "已配置入口必须在同一进程重载后读取新的 FFF 去重规则");

  // Exercise the actual package-manifest discovery path used by /reload as well.
  const migration = join(root, "migration");
  mkdirSync(migration);
  const packageFile = join(migration, "package.json");
  writeFileSync(packageFile, JSON.stringify({ type: "module", pi: { extensions: ["./index.js"] } }));
  writeFileSync(join(migration, "index.js"), oldSource);
  const resources = new DefaultResourceLoader({
    cwd: migration, agentDir: join(root, "agent"),
    settingsManager: SettingsManager.inMemory({ packages: [migration] }),
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resources.reload();
  assert.equal((await runSessionStart(resources.getExtensions())).length, 12);
  writeFileSync(packageFile, JSON.stringify({ type: "module", pi: { extensions: [entry] } }));
  writeFileSync(join(migration, entry), source);
  if (entry !== "./index.js") rmSync(join(migration, "index.js"));
  await resources.reload();
  const migrated = await runSessionStart(resources.getExtensions());
  assert.equal(migrated.length, 10);
  assert.ok(migrated.includes("ffgrep") && migrated.includes("fffind"));
  assert.ok(!migrated.includes("grep") && !migrated.includes("find"));
  console.log("PASS: DefaultResourceLoader.reload() rediscovers the changed package entry; active tools 12 -> 10");
} finally {
  rmSync(root, { recursive: true, force: true });
}
