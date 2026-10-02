import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { PACKAGES } from "../bin/lazypi.mjs";

const CLI_PATH = resolve("bin/lazypi.mjs");
const REPO_THEME_DIR = resolve("themes");
const REPO_AGENT_DIR = resolve("agent");

function themeEntries() {
	return PACKAGES.filter((pkg) => Array.isArray(pkg.themeFiles) && pkg.themeFiles.length > 0);
}

function createWorkspace(t) {
	const root = mkdtempSync(join(tmpdir(), "lazypi-themes-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	const bin = join(root, "bin");
	const agentDir = join(home, ".pi", "agent");
	mkdirSync(home, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(workspace, { recursive: true });
	mkdirSync(bin, { recursive: true });
	return { root, home, workspace, bin, agentDir };
}

function writeFakePi(bin) {
	if (process.platform === "win32") {
		const piPath = join(bin, "pi.cmd");
		writeFileSync(piPath, "@echo off\r\nif \"%1\"==\"--version\" (echo pi test & exit /b 0)\r\nexit /b 0\r\n");
		return;
	}
	const piPath = join(bin, "pi");
	writeFileSync(piPath, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'pi test'; exit 0; fi\nexit 0\n");
	chmodSync(piPath, 0o755);
}

function runCli(args, { workspace, home, agentDir, bin } = {}) {
	const env = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: agentDir,
		PATH: [bin, process.env.PATH].filter(Boolean).join(delimiter),
	};
	const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
		cwd: workspace,
		env,
		encoding: "utf8",
		timeout: 60_000,
	});
	if (result.error) throw result.error;
	return result;
}

test("catalog exposes file-based theme entries", () => {
	const themes = themeEntries();
	assert.equal(themes.length, 2);
	for (const theme of themes) {
		assert.equal(theme.category, "themes");
		assert.equal(theme.source, undefined);
	}
});

test("install copies theme files into the agent themes directory", (t) => {
	const { home, workspace, bin, agentDir } = createWorkspace(t);
	writeFakePi(bin);

	const result = runCli(["install", "--only", "vesper-dark", "--yes"], { workspace, home, agentDir, bin });
	assert.equal(result.status, 0, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
	assert.match(result.stdout, /Installed theme vesper-dark\.json/);

	const target = join(agentDir, "themes", "vesper-dark.json");
	assert.equal(existsSync(target), true);
	assert.deepEqual(
		JSON.parse(readFileSync(target, "utf8")),
		JSON.parse(readFileSync(join(REPO_THEME_DIR, "vesper-dark.json"), "utf8")),
	);
});

test("install backs up an existing theme file before overwriting", (t) => {
	const { home, workspace, bin, agentDir } = createWorkspace(t);
	writeFakePi(bin);

	const themesDir = join(agentDir, "themes");
	mkdirSync(themesDir, { recursive: true });
	writeFileSync(join(themesDir, "vesper-dark.json"), "{ \"name\": \"old-vesper\" }\n");

	const result = runCli(["install", "--only", "vesper-dark", "--yes"], { workspace, home, agentDir, bin });
	assert.equal(result.status, 0, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
	assert.match(result.stdout, /Backup:/);

	const backups = readdirSync(themesDir).filter((name) => name.startsWith("vesper-dark.json.lazypi.") && name.endsWith(".bak"));
	assert.equal(backups.length, 1);
	assert.equal(JSON.parse(readFileSync(join(themesDir, backups[0]), "utf8")).name, "old-vesper");
});

test("install reports nothing to do when the theme is already present", (t) => {
	const { home, workspace, bin, agentDir } = createWorkspace(t);
	writeFakePi(bin);

	const themesDir = join(agentDir, "themes");
	mkdirSync(themesDir, { recursive: true });
	writeFileSync(join(themesDir, "vesper-dark.json"), readFileSync(join(REPO_THEME_DIR, "vesper-dark.json"), "utf8"));

	const result = runCli(["install", "--only", "vesper-dark", "--yes"], { workspace, home, agentDir, bin });
	assert.equal(result.status, 0, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
	assert.match(result.stdout, /Nothing to do/);
	assert.equal(readdirSync(themesDir).filter((name) => name.endsWith(".bak")).length, 0);
});

test("status reports a missing theme and an installed theme", (t) => {
	const { home, workspace, bin, agentDir } = createWorkspace(t);
	writeFakePi(bin);

	// nothing installed yet — both themes missing
	let result = runCli(["status"], { workspace, home, agentDir, bin });
	assert.equal(result.status, 0);
	assert.match(result.stdout, /\[themes\] vesper-dark/);
	assert.match(result.stdout, /Missing from LazyPi catalog/);

	// install one theme, then it shows under Installed
	const install = runCli(["install", "--only", "vesper-light", "--yes"], { workspace, home, agentDir, bin });
	assert.equal(install.status, 0, `STDOUT:\n${install.stdout}\nSTDERR:\n${install.stderr}`);

	result = runCli(["status"], { workspace, home, agentDir, bin });
	assert.equal(result.status, 0);
	// vesper-light must appear inside the Installed section, not in Missing
	assert.match(result.stdout, /Installed from LazyPi catalog \(\d+\/\d+\):[\s\S]*?\[themes\] vesper-light/);
	assert.doesNotMatch(result.stdout, /Missing from LazyPi catalog \([\s\S]*\[themes\] vesper-light/);
});

test("remove deletes the installed theme file", (t) => {
	const { home, workspace, bin, agentDir } = createWorkspace(t);
	writeFakePi(bin);

	const themesDir = join(agentDir, "themes");
	mkdirSync(themesDir, { recursive: true });
	writeFileSync(join(themesDir, "vesper-dark.json"), "{ \"name\": \"vesper-dark\" }\n");

	const result = runCli(["remove", "vesper-dark"], { workspace, home, agentDir, bin });
	assert.equal(result.status, 0, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
	assert.match(result.stdout, /Removed theme vesper-dark\.json/);
	assert.equal(existsSync(join(themesDir, "vesper-dark.json")), false);
});

test("install copies an agent config file to the agent root", (t) => {
	const { home, workspace, bin, agentDir } = createWorkspace(t);
	writeFakePi(bin);

	const result = runCli(["install", "--only", "global-agents", "--yes"], { workspace, home, agentDir, bin });
	assert.equal(result.status, 0, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
	assert.match(result.stdout, /Installed agent file AGENTS\.md/);

	const target = join(agentDir, "AGENTS.md");
	assert.equal(existsSync(target), true);
	assert.equal(readFileSync(target, "utf8"), readFileSync(join(REPO_AGENT_DIR, "AGENTS.md"), "utf8"));
});

test("install backs up an existing agent config file before overwriting", (t) => {
	const { home, workspace, bin, agentDir } = createWorkspace(t);
	writeFakePi(bin);

	writeFileSync(join(agentDir, "AGENTS.md"), "# old global config\n");

	const result = runCli(["install", "--only", "global-agents", "--yes"], { workspace, home, agentDir, bin });
	assert.equal(result.status, 0, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
	assert.match(result.stdout, /Backup:/);

	const backups = readdirSync(agentDir).filter((name) => name.startsWith("AGENTS.md.lazypi.") && name.endsWith(".bak"));
	assert.equal(backups.length, 1);
	assert.equal(readFileSync(join(agentDir, backups[0]), "utf8"), "# old global config\n");
});

test("remove deletes an installed agent config file", (t) => {
	const { home, workspace, bin, agentDir } = createWorkspace(t);
	writeFakePi(bin);

	writeFileSync(join(agentDir, "AGENTS.md"), "# global config\n");

	const result = runCli(["remove", "global-agents"], { workspace, home, agentDir, bin });
	assert.equal(result.status, 0, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
	assert.match(result.stdout, /Removed agent file AGENTS\.md/);
	assert.equal(existsSync(join(agentDir, "AGENTS.md")), false);
});
