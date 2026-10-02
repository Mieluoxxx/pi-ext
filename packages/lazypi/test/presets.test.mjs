import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { PACKAGES } from "../bin/lazypi.mjs";
import { applyConfiguration, planConfiguration } from "../lib/presets.mjs";

const CLI = resolve("bin/lazypi.mjs");
const source = (id) => PACKAGES.find((pkg) => pkg.id === id).source;
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");

function workspace(t) {
	const root = mkdtempSync(join(tmpdir(), "lazypi-presets-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const state = { root, home: join(root, "home"), agentDir: join(root, "agent"), cwd: join(root, "work"), bin: join(root, "bin"), calls: join(root, "calls.jsonl") };
	for (const path of [state.home, state.cwd, state.bin, state.agentDir]) mkdirSync(path);
	const script = join(state.bin, "fake-pi.mjs");
	writeFileSync(script, `
import {appendFileSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.PI_TEST_CALLS, JSON.stringify(args)+'\\n');
if(args[0] !== 'install') process.exit(0);
const source = args.at(-1);
if(source === process.env.PI_TEST_FAIL_SOURCE) process.exit(1);
const file = join(process.env.PI_CODING_AGENT_DIR, 'settings.json');
const settings = existsSync(file) ? JSON.parse(readFileSync(file,'utf8')) : {};
settings.packages ??= [];
settings.packages.push(source);
settings.installerNote = 'preserve this new field';
if(process.env.PI_TEST_MUTATE) settings.defaultThinkingLevel = 'low';
writeFileSync(file, JSON.stringify(settings)+'\\n');
`);
	const command = join(state.bin, process.platform === "win32" ? "pi.cmd" : "pi");
	writeFileSync(command, process.platform === "win32"
		? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
		: `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
	chmodSync(command, 0o755);
	return state;
}

function run(state, args, overrides = {}) {
	const env = { ...process.env, HOME: state.home, USERPROFILE: state.home, PI_CODING_AGENT_DIR: state.agentDir, XDG_CONFIG_HOME: "", PATH: `${state.bin}${delimiter}${process.env.PATH}`, PI_TEST_CALLS: state.calls, PI_TEST_FAIL_SOURCE: "", PI_TEST_MUTATE: "", ...overrides };
	for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
	const result = spawnSync(process.execPath, [CLI, ...args], { cwd: state.cwd, env, encoding: "utf8", timeout: 30_000 });
	assert.ifError(result.error);
	return result;
}

function preset(state, name, files, packages = []) {
	const root = join(state.root, name);
	mkdirSync(root, { recursive: true });
	const manifest = { version: 1, packages, files: files.map(({ to, mode = "merge", value }, index) => {
		const from = `source-${index}.json`;
		writeFileSync(join(root, from), typeof value === "string" ? value : JSON.stringify(value));
		return { from, to, mode };
	}) };
	writeJson(join(root, "preset.json"), manifest);
	return join(root, "preset.json");
}

function success(result) {
	assert.equal(result.status, 0, result.stdout + result.stderr);
}

function backups(state) {
	return readdirSync(state.agentDir, { recursive: true }).filter((name) => name.endsWith(".bak")).sort();
}

test("built-in and external presets merge once, preserve resources, and detect drift", (t) => {
	const state = workspace(t);
	const ids = ["base", "ui", "workflow"].flatMap((name) => json(`presets/${name}/preset.json`).packages);
	const packages = [...new Set(ids.map(source).filter(Boolean))].reverse();
	const customPackage = { source: "npm:custom", extensions: [], skills: ["one"] };
	const settings = join(state.agentDir, "settings.json");
	writeJson(settings, { packages: [customPackage, ...packages], theme: "light", defaultModel: "private-model", other: { enabled: true } });
	const override = preset(state, "laptop", [{ to: "agent/settings.json", value: { theme: "light", defaultThinkingLevel: "high" } }, { to: "agent/zentui.json", value: { components: { footer: { styles: { starship: { compactMaxLines: 3 } } } } } }]);
	const args = ["--preset", "base", "--preset", "ui", "--preset", "workflow", "--preset", override];
	success(run(state, [...args, "--yes"]));
	const merged = json(settings);
	assert.equal(merged.theme, "light");
	assert.equal(merged.defaultThinkingLevel, "high");
	assert.equal(merged.defaultModel, "private-model");
	assert.deepEqual(merged.other, { enabled: true });
	assert.deepEqual(merged.packages[0], customPackage);
	assert.ok(merged.packages.indexOf(source("fff")) < merged.packages.indexOf(source("hashline-edit-pro")));
	assert.equal(json(join(state.agentDir, "zentui.json")).components.footer.styles.starship.compactMaxLines, 3);
	assert.equal(json(join(state.agentDir, "zentui.json")).components.workingLine.messages.values.length, 16);
	assert.equal(json(join(state.agentDir, "web-search.json")).shortcuts.curate, "ctrl+shift+s");
	assert.equal(json(join(state.agentDir, "extensions/pi-tool-display/config.json")).registerToolOverrides.read, false);
	assert.equal(readFileSync(join(state.agentDir, "AGENTS.md"), "utf8"), readFileSync("agent/AGENTS.md", "utf8"));
	assert.equal(backups(state).filter((name) => name.startsWith("settings.json.")).length, 1);
	const firstBackups = backups(state);
	const mtime = statSync(settings).mtimeMs;
	success(run(state, [...args, "--yes"]));
	assert.deepEqual(backups(state), firstBackups);
	assert.equal(statSync(settings).mtimeMs, mtime);
	success(run(state, ["status", ...args]));
	assert.equal(existsSync(state.calls), false);
	writeJson(settings, { ...merged, theme: "drift" });
	const drift = run(state, ["status", ...args]);
	assert.equal(drift.status, 1);
	assert.match(drift.stdout, /modify .*settings.json/);
	assert.equal(json(settings).theme, "drift");
});

test("dry-run works without Pi and performs no configuration writes", (t) => {
	const state = workspace(t);
	const result = run(state, ["--preset", "base", "--preset", "ui", "--dry-run"], { PATH: "" });
	success(result);
	assert.match(result.stdout, /Dry run/);
	assert.deepEqual(readdirSync(state.agentDir), []);
	assert.equal(existsSync(state.calls), false);
});

test("installs only preset requirements and rebases over Pi settings updates", (t) => {
	const state = workspace(t);
	writeJson(join(state.agentDir, "settings.json"), { packages: ["npm:keep"], defaultThinkingLevel: "medium" });
	const file = preset(state, "custom", [{ to: "agent/settings.json", value: { defaultThinkingLevel: "high" } }], ["fff"]);
	success(run(state, ["--preset", file, "--only", "goal", "--yes"]));
	const settings = json(join(state.agentDir, "settings.json"));
	assert.deepEqual(settings.packages, ["npm:keep", source("goal"), source("fff")]);
	assert.equal(settings.installerNote, "preserve this new field");
	assert.equal(settings.defaultThinkingLevel, "high");
	assert.equal(readFileSync(state.calls, "utf8").trim().split("\n").length, 2);
});

test("package failures and managed-field races leave all preset files unapplied", (t) => {
	for (const fail of [true, false]) {
		const state = workspace(t);
		writeJson(join(state.agentDir, "settings.json"), { defaultThinkingLevel: "medium" });
		const file = preset(state, "custom", [{ to: "agent/settings.json", value: { defaultThinkingLevel: "high" } }], ["fff"]);
		const result = run(state, ["--preset", "base", "--preset", file, "--yes"], fail ? { PI_TEST_FAIL_SOURCE: source("fff") } : { PI_TEST_MUTATE: "1" });
		assert.notEqual(result.status, 0);
		assert.equal(existsSync(join(state.agentDir, "AGENTS.md")), false);
		assert.equal(existsSync(join(state.agentDir, "keybindings.json")), false);
		assert.deepEqual(backups(state), []);
		assert.equal(json(join(state.agentDir, "settings.json")).defaultThinkingLevel, fail ? "medium" : "low");
	}
});

test("unsafe flags and exclusions fail before package or config operations", (t) => {
	const state = workspace(t);
	for (const args of [["--local"], ["--force"], ["--except", "global-agents"], ["--only", "fff", "--except", "fff"]]) {
		assert.notEqual(run(state, ["--preset", "base", ...args, "--yes"]).status, 0);
	}
	for (const args of [["update", "--preset", "base"], ["--preset"], ["--preset="], ["--dry-run"]]) assert.notEqual(run(state, args).status, 0);
	assert.deepEqual(readdirSync(state.agentDir), []);
	assert.equal(existsSync(state.calls), false);
});

test("preflight rejects unsafe targets, settings aliases, modes and private parse excerpts", (t) => {
	const state = workspace(t);
	const cases = [
		{ to: "agent/SETTINGS.json", mode: "copy", value: { packages: [] } },
		{ to: "agent/Settings.json", value: { defaultProjectTrust: "always" } },
		{ to: "agent/settings.json", mode: "copy", value: {} },
		{ to: "agent/settings.json", value: { packages: [] } },
		{ to: "agent/auth.json", value: {} },
		{ to: "agent/TRUST.json", value: {} },
		{ to: "agent/models.json", value: {} },
		{ to: "agent/../settings.json", value: {} },
		{ to: "agent/settings.json:stream", value: {} },
		{ to: "agent/settin~1.json", mode: "copy", value: {} },
		{ to: "agent/extensions/malicious.ts", mode: "copy", value: "code" },
		{ to: "agent/custom.json", value: '{"__proto__":{"polluted":true}}' },
		{ to: "agent/custom.json", value: '{"secret":"DO-NOT-PRINT-THIS" broken}' },
		{ to: "agent/custom.json", value: "[]" },
	];
	for (const entry of cases) {
		const file = preset(state, "invalid", [entry], ["fff"]);
		const result = run(state, ["--preset", file, "--yes"]);
		assert.notEqual(result.status, 0, JSON.stringify(entry));
		assert.doesNotMatch(result.stdout + result.stderr, /DO-NOT-PRINT-THIS/);
	}
	assert.deepEqual(readdirSync(state.agentDir), []);
	assert.equal(existsSync(state.calls), false);
});

test("target casing aliases, mixed modes and catalog compatibility conflicts are rejected", (t) => {
	const state = workspace(t);
	for (const files of [
		[{ to: "agent/Custom.json", value: {} }, { to: "agent/custom.json", value: {} }],
		[{ to: "agent/custom.json", value: {} }, { to: "agent/custom.json", mode: "copy", value: {} }],
		[{ to: "agent/extensions/pi-tool-display/config.json", value: { registerToolOverrides: { read: true } } }],
	]) {
		const file = preset(state, "conflict", files, ["tool-display", "hashline-edit-pro"]);
		assert.notEqual(run(state, ["--preset", file, "--yes"]).status, 0);
	}
	assert.deepEqual(readdirSync(state.agentDir), []);
	assert.equal(existsSync(state.calls), false);
});

test("manifest validation and source confinement happen before installation", (t) => {
	const state = workspace(t);
	const file = preset(state, "invalid", [{ to: "agent/custom.json", value: {} }], ["fff"]);
	const original = json(file);
	for (const manifest of [{ ...original, version: 2 }, { ...original, packages: ["unknown"] }, { ...original, execute: "command" }, { ...original, files: [{ ...original.files[0], from: "../outside.json" }] }]) {
		writeJson(file, manifest);
		assert.notEqual(run(state, ["--preset", file, "--yes"]).status, 0);
	}
	assert.equal(existsSync(state.calls), false);
	assert.deepEqual(readdirSync(state.agentDir), []);
});

test("source and target symlinks cannot escape the configured directories", { skip: process.platform === "win32" }, (t) => {
	const state = workspace(t);
	const outside = join(state.root, "outside.json");
	writeJson(outside, { unchanged: true });
	const file = preset(state, "links", [{ to: "agent/custom.json", value: { added: true } }]);
	symlinkSync(outside, join(state.agentDir, "custom.json"));
	assert.notEqual(run(state, ["--preset", file]).status, 0);
	rmSync(join(state.agentDir, "custom.json"));
	rmSync(join(dirname(file), "source-0.json"));
	symlinkSync(outside, join(dirname(file), "source-0.json"));
	assert.notEqual(run(state, ["--preset", file]).status, 0);
	assert.deepEqual(json(outside), { unchanged: true });
});

test("web-search follows the custom agent, XDG, and default roots", (t) => {
	for (const scope of ["agent", "xdg", "home"]) {
		const state = workspace(t);
		const file = preset(state, "web", [{ to: "web-search", value: { shortcuts: { curate: "ctrl+shift+s" } } }]);
		const xdg = join(state.root, "xdg");
		const result = run(state, ["--preset", file], { PI_CODING_AGENT_DIR: scope === "agent" ? state.agentDir : undefined, XDG_CONFIG_HOME: scope === "home" ? undefined : xdg });
		success(result);
		const target = join(scope === "agent" ? state.agentDir : scope === "xdg" ? join(xdg, "pi") : join(state.home, ".pi"), "web-search.json");
		assert.equal(json(target).shortcuts.curate, "ctrl+shift+s");
		assert.equal(existsSync(state.calls), false);
	}
});

test("configuration-only copy preserves permissions and creates distinct private backups", (t) => {
	const state = workspace(t);
	const target = join(state.agentDir, "WATCHDOG.yml");
	writeFileSync(target, "main: false\n", { mode: 0o600 });
	const file = preset(state, "watchdog", [{ to: "agent/WATCHDOG.yml", mode: "copy", value: "main: true\n" }]);
	success(run(state, ["--preset", file]));
	writeFileSync(target, "main: false\n");
	success(run(state, ["--preset", file]));
	assert.equal(backups(state).length, 2);
	if (process.platform !== "win32") {
		for (const path of [target, ...backups(state).map((name) => join(state.agentDir, name))]) assert.equal(statSync(path).mode & 0o777, 0o600);
	}
	assert.equal(existsSync(state.calls), false);
});

test("a stale plan refuses to overwrite concurrent edits", (t) => {
	const state = workspace(t);
	const target = join(state.agentDir, "custom.json");
	writeJson(target, { value: 1, other: true });
	const roots = { agentDir: state.agentDir, webSearchDir: state.agentDir };
	const operations = [{ to: "agent/custom.json", mode: "merge", value: { value: 2 }, owner: "test" }];
	const plan = planConfiguration(operations, roots);
	writeJson(target, { value: 1, other: "changed" });
	const rebased = planConfiguration(operations, roots, plan);
	assert.equal(JSON.parse(rebased[0].after).other, "changed");
	assert.throws(() => applyConfiguration(plan), /write stopped/);
	writeJson(target, { value: 3 });
	assert.throws(() => planConfiguration(operations, roots, plan), /changed during installation/);
	assert.deepEqual(json(target), { value: 3 });
	assert.deepEqual(backups(state), []);
	if (process.platform !== "win32") {
		chmodSync(target, 0o644);
		const beforeChmod = planConfiguration(operations, roots);
		chmodSync(target, 0o600);
		assert.throws(() => applyConfiguration(beforeChmod), /write stopped/);
		assert.equal(statSync(target).mode & 0o777, 0o600);
	}
});

test("ordered merges handle type replacements without resurrecting old fields", (t) => {
	const state = workspace(t);
	const target = join(state.agentDir, "custom.json");
	writeJson(target, { nested: { old: true }, untouched: true });
	const roots = { agentDir: state.agentDir, webSearchDir: state.agentDir };
	const operations = [
		{ to: "agent/custom.json", mode: "merge", value: { nested: null }, owner: "first" },
		{ to: "agent/custom.json", mode: "merge", value: { nested: { added: [1, 2], other: true } }, owner: "second" },
		{ to: "agent/custom.json", mode: "merge", value: { nested: { other: false } }, owner: "third" },
	];
	const plan = planConfiguration(operations, roots);
	assert.deepEqual(JSON.parse(plan[0].after), { nested: { added: [1, 2], other: false }, untouched: true });
	assert.equal(plan[0].origins.get("/nested/added"), "second");
	assert.equal(plan[0].origins.get("/nested/other"), "third");
	applyConfiguration(plan);
	assert.equal(planConfiguration(operations, roots)[0].changed, false);
});

test("local package duplicates block both preview and installation", (t) => {
	const state = workspace(t);
	const checkout = join(state.root, "local-fff");
	mkdirSync(checkout);
	writeJson(join(checkout, "package.json"), { name: "@ff-labs/pi-fff" });
	writeJson(join(state.agentDir, "settings.json"), { packages: [checkout] });
	const file = preset(state, "custom", [], ["fff"]);
	for (const flag of ["--dry-run", "--yes"]) {
		const result = run(state, ["--preset", file, flag]);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /migrate its source explicitly/);
	}
	assert.deepEqual(json(join(state.agentDir, "settings.json")).packages, [checkout]);
	assert.equal(existsSync(state.calls), false);
	assert.deepEqual(backups(state), []);
});

test("replacement packages refuse known legacy conflicts without uninstalling them", (t) => {
	const state = workspace(t);
	for (const [id, legacy] of [["advisor", "npm:@juicesharp/rpiv-advisor@1.0.0"], ["openai-tools", "git:github.com/code-yeongyu/pi-apply-patch@v0.1.2"], ["openai-tools", "https://github.com/code-yeongyu/pi-apply-patch.git@v0.1.2"]]) {
		writeJson(join(state.agentDir, "settings.json"), { packages: [legacy] });
		const file = preset(state, "legacy-conflict", [], [id]);
		for (const args of [["--only", id, "--yes"], ["--preset", file, "--dry-run"], ["--preset", file, "--yes"]]) {
			const result = run(state, args);
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /remove the old registration explicitly/);
		}
		assert.deepEqual(json(join(state.agentDir, "settings.json")).packages, [legacy]);
	}
	assert.equal(existsSync(state.calls), false);
	assert.deepEqual(backups(state), []);
});

test("known conflicts are checked across global and current-project scopes without rewriting either", (t) => {
	const state = workspace(t);
	const globalSettings = join(state.agentDir, "settings.json");
	const localSettings = join(state.cwd, ".pi", "settings.json");
	mkdirSync(dirname(localSettings));
	for (const local of [true, false]) {
		writeJson(globalSettings, { packages: local ? ["npm:@juicesharp/rpiv-advisor"] : ["npm:keep-global"] });
		writeJson(localSettings, { packages: local ? ["npm:keep-local"] : ["npm:@juicesharp/rpiv-advisor"] });
		const before = [readFileSync(globalSettings, "utf8"), readFileSync(localSettings, "utf8")];
		const result = run(state, ["--only", "advisor", "--yes", ...(local ? ["--local"] : [])]);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /conflicts with/);
		if (!local) {
			const file = preset(state, "cross-scope", [], ["advisor"]);
			assert.notEqual(run(state, ["--preset", file, "--dry-run"]).status, 0);
		}
		assert.deepEqual([readFileSync(globalSettings, "utf8"), readFileSync(localSettings, "utf8")], before);
	}
	assert.equal(existsSync(state.calls), false);
	assert.deepEqual(backups(state), []);
	assert.deepEqual(readdirSync(dirname(localSettings)), ["settings.json"]);
});

test("model presets merge by provider/id, accept Pi JSON syntax, and stay idempotent", (t) => {
	const state = workspace(t);
	const target = join(state.agentDir, "models.json");
	const initial = { providers: {
		custom: {
			api: "openai-responses", baseUrl: "https://example.invalid/a//b", apiKey: "PRIVATE-KEY-SENTINEL",
			models: [{ id: "keep", contextWindow: 4000 }, { id: "a/model", name: 'Quoted "name"', contextWindow: 8000, cost: { input: 1, output: 2 }, thinkingLevelMap: { off: null, high: "high" } }],
		},
		untouched: { apiKey: "OTHER-PRIVATE-KEY", models: [{ id: "other" }] },
	} };
	const original = "\uFEFF// Pi model definitions\n" + JSON.stringify(initial, null, 2).replace(/\n}$/, ",\n}");
	writeFileSync(target, original, { mode: 0o600 });
	const first = preset(state, "models-first", [{ to: "agent/models.json", mode: "merge-models", value: { providers: {
		custom: { models: [{ id: "a/model", contextWindow: 16000 }, { id: "new-first", input: ["text", "image"] }] },
		added: { api: "openai-completions", baseUrl: "http://localhost:11434/v1", apiKey: "$CPA_API_KEY", models: [{ id: "local" }] },
	} } }]);
	const second = preset(state, "models-second", [{ to: "agent/models.json", mode: "merge-models", value: '// device override\n{"providers":{"custom":{"models":[{"id":"a/model","cost":{"output":3}},{"id":"new-second"},],},},}' }]);
	const args = ["--preset", first, "--preset", second];
	const preview = run(state, [...args, "--dry-run"]);
	success(preview);
	assert.equal(readFileSync(target, "utf8"), original);
	assert.match(preview.stdout, /\/providers\/custom\/models\/a~1model\/contextWindow/);
	const result = run(state, args, { CPA_API_KEY: "DO-NOT-INLINE-ENV" });
	success(result);
	assert.doesNotMatch(preview.stdout + preview.stderr + result.stdout + result.stderr, /PRIVATE-KEY|DO-NOT-INLINE-ENV/);
	const value = json(target);
	assert.deepEqual(value.providers.custom.models.map((model) => model.id), ["keep", "a/model", "new-first", "new-second"]);
	assert.equal(value.providers.custom.baseUrl, initial.providers.custom.baseUrl);
	assert.equal(value.providers.custom.apiKey, initial.providers.custom.apiKey);
	assert.deepEqual(value.providers.untouched, initial.providers.untouched);
	assert.deepEqual(value.providers.custom.models[1], { ...initial.providers.custom.models[1], contextWindow: 16000, cost: { input: 1, output: 3 } });
	assert.equal(value.providers.added.apiKey, "$CPA_API_KEY");
	const backup = backups(state);
	assert.equal(backup.length, 1);
	assert.equal(readFileSync(join(state.agentDir, backup[0]), "utf8"), original);
	const mtime = statSync(target).mtimeMs;
	success(run(state, args));
	success(run(state, ["status", ...args]));
	assert.equal(statSync(target).mtimeMs, mtime);
	assert.deepEqual(backups(state), backup);
	value.providers.custom.models[0].contextWindow = 9999;
	writeJson(target, value);
	success(run(state, ["status", ...args]));
	value.providers.custom.models[1].contextWindow = 123;
	writeJson(target, value);
	assert.equal(run(state, ["status", ...args]).status, 1);
	assert.equal(existsSync(state.calls), false);
});

test("invalid model collections fail preflight without replacing existing data", (t) => {
	const state = workspace(t);
	const target = join(state.agentDir, "models.json");
	const original = '{"providers":{"keep":{"models":[{"id":"keep"}]}}}';
	writeFileSync(target, original);
	const invalid = [
		{ providers: null }, { providers: [] }, { providers: { broken: null } },
		{ providers: { broken: { models: null } } }, { providers: { broken: { models: {} } } },
		{ providers: { broken: { models: [null] } } }, { providers: { broken: { models: [{}] } } },
		{ providers: { broken: { models: [{ id: " " }] } } },
		{ providers: { broken: { models: [{ id: "same" }, { id: "same" }] } } },
		{ providers: { broken: { apiKey: null } } }, { providers: { broken: { headers: [] } } },
		{ unexpectedRoot: true }, '{"providers":{"constructor":{"models":[]}}}',
		'{"providers":{"secret":"PRIVATE-PARSE-SENTINEL" broken}}',
	];
	for (const value of invalid) {
		const file = preset(state, "invalid-models", [{ to: "agent/models.json", mode: "merge-models", value }], ["fff"]);
		const result = run(state, ["--preset", file, "--yes"]);
		assert.notEqual(result.status, 0);
		assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE-PARSE-SENTINEL/);
		assert.equal(readFileSync(target, "utf8"), original);
	}
	const valid = preset(state, "valid-models", [{ to: "agent/models.json", mode: "merge-models", value: { providers: { keep: { models: [] } } } }], ["fff"]);
	for (const value of ["{broken", '{"providers":{"keep":{"models":[{"id":"same"},{"id":"same"}]}}}']) {
		writeFileSync(target, value);
		assert.notEqual(run(state, ["--preset", "base", "--preset", valid, "--yes"]).status, 0);
		assert.equal(readFileSync(target, "utf8"), value);
		assert.equal(existsSync(join(state.agentDir, "AGENTS.md")), false);
	}
	assert.deepEqual(backups(state), []);
	assert.equal(existsSync(state.calls), false);
});

test("model files cannot bypass keyed merge using another mode or casing", (t) => {
	const state = workspace(t);
	for (const [to, mode] of [["agent/models.json", "merge"], ["agent/models.json", "copy"], ["agent/MODELS.json", "copy"], ["agent/Models.json", "merge-models"], ["agent/settings.json", "merge-models"], ["agent/extensions/models.json", "copy"]]) {
		const file = preset(state, "models-target", [{ to, mode, value: {} }]);
		assert.notEqual(run(state, ["--preset", file]).status, 0);
	}
	assert.deepEqual(readdirSync(state.agentDir), []);
});

test("model rebase watches selected ids, not unrelated list positions or fields", (t) => {
	const state = workspace(t);
	const target = join(state.agentDir, "models.json");
	writeJson(target, { providers: { custom: { apiKey: "keep", models: [{ id: "a", contextWindow: 4000, name: "original" }, { id: "b" }] } } });
	const roots = { agentDir: state.agentDir, webSearchDir: state.agentDir };
	const ops = [{ to: "agent/models.json", mode: "merge-models", value: { providers: { custom: { models: [{ id: "a", contextWindow: 8000 }] } } }, owner: "models" }];
	const plan = planConfiguration(ops, roots);
	const concurrent = json(target);
	concurrent.providers.custom.models = [{ id: "b", name: "changed" }, { id: "a", contextWindow: 4000, name: "keep-new-name" }, { id: "c" }];
	writeJson(target, concurrent);
	const rebased = planConfiguration(ops, roots, plan);
	const next = JSON.parse(rebased[0].after);
	assert.deepEqual(next.providers.custom.models.map((model) => model.id), ["b", "a", "c"]);
	assert.equal(next.providers.custom.models[1].name, "keep-new-name");
	assert.equal(next.providers.custom.models[1].contextWindow, 8000);
	concurrent.providers.custom.models[1].contextWindow = 6000;
	writeJson(target, concurrent);
	assert.throws(() => planConfiguration(ops, roots, plan), /changed during installation/);
	const empty = [{ ...ops[0], value: { providers: { custom: { models: [] } } } }];
	assert.equal(planConfiguration(empty, roots)[0].changed, false);
});

test("model credential commands are preserved but never executed by install or preview", (t) => {
	const state = workspace(t);
	const marker = join(state.root, "credential-executed");
	const script = join(state.root, "credential.cjs");
	writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`);
	const command = `!"${process.execPath}" "${script}"`;
	const file = preset(state, "credential-models", [{ to: "agent/models.json", mode: "merge-models", value: { providers: { custom: { apiKey: command, models: [{ id: "a" }] } } } }]);
	success(run(state, ["--preset", file, "--dry-run"]));
	success(run(state, ["--preset", file]));
	assert.equal(json(join(state.agentDir, "models.json")).providers.custom.apiKey, command);
	assert.equal(existsSync(marker), false);
	assert.equal(existsSync(state.calls), false);
});

test("provider names matching inherited object methods create own entries without mutation", (t) => {
	const state = workspace(t);
	const names = ["toString", "valueOf", "hasOwnProperty"];
	const methods = names.map((name) => [Object.prototype[name], Object.getOwnPropertyDescriptors(Object.prototype[name])]);
	const providers = Object.fromEntries(names.map((name) => [name, { api: "openai-responses", baseUrl: "https://example.invalid", models: [{ id: "a" }] }]));
	const roots = { agentDir: state.agentDir, webSearchDir: state.agentDir };
	const ops = [{ to: "agent/models.json", mode: "merge-models", value: { providers }, owner: "test" }];
	const plan = planConfiguration(ops, roots);
	assert.deepEqual(JSON.parse(plan[0].after), { providers });
	applyConfiguration(plan);
	assert.equal(planConfiguration(ops, roots)[0].changed, false);
	for (const [method, descriptors] of methods) assert.deepEqual(Object.getOwnPropertyDescriptors(method), descriptors);
});
