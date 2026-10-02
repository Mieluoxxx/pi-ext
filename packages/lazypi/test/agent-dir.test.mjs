import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, posix, resolve, win32 } from "node:path";
import { spawnSync } from "node:child_process";

import { PACKAGES, resolveAgentConfigDir } from "../bin/lazypi.mjs";

const CLI_PATH = resolve("bin/lazypi.mjs");
const AUTH_ENV_VARS = [
	"ANTHROPIC_API_KEY",
	"OPENAI_API_KEY",
	"GOOGLE_API_KEY",
	"GEMINI_API_KEY",
	"OPENROUTER_API_KEY",
	"TOGETHER_API_KEY",
	"GROQ_API_KEY",
	"MISTRAL_API_KEY",
];

function createWorkspace(t) {
	const root = mkdtempSync(join(tmpdir(), "lazypi-agent-dir-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	const bin = join(root, "bin");
	mkdirSync(home, { recursive: true });
	mkdirSync(workspace, { recursive: true });
	mkdirSync(bin, { recursive: true });
	return { root, home, workspace, bin };
}

function writeSettings(path, packages) {
	mkdirSync(path, { recursive: true });
	writeFileSync(join(path, "settings.json"), JSON.stringify({ packages }, null, 2) + "\n");
}

function writeJson(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function writeFakePi(bin) {
	if (process.platform === "win32") {
		writeFileSync(join(bin, "pi.cmd"), "@echo off\r\nif \"%1\"==\"--version\" echo pi test\r\nif defined PI_TEST_CALLS echo %*>>\"%PI_TEST_CALLS%\"\r\nexit /b 0\r\n");
		return;
	}
	const piPath = join(bin, "pi");
	writeFileSync(piPath, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'pi test'; fi\nif [ -n \"$PI_TEST_CALLS\" ]; then printf '%s\\n' \"$*\" >> \"$PI_TEST_CALLS\"; fi\nexit 0\n");
	chmodSync(piPath, 0o755);
}

function runCli(args, { cwd, home, agentDir, bin, callsPath } = {}) {
	const env = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: agentDir,
	};
	if (bin) env.PATH = [bin, process.env.PATH].filter(Boolean).join(delimiter);
	if (callsPath) env.PI_TEST_CALLS = callsPath;
	for (const key of AUTH_ENV_VARS) delete env[key];
	const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
		cwd,
		env,
		encoding: "utf8",
		timeout: 60_000,
	});
	if (result.error) throw result.error;
	return result;
}

test("resolveAgentConfigDir matches Pi path semantics", () => {
	const posixHome = "/home/tester";
	const windowsHome = "C:\\Users\\tester";
	const cases = [
		["default POSIX", undefined, posixHome, "linux", "/home/tester/.pi/agent"],
		["tilde POSIX", "~/.pi/lazy", posixHome, "linux", "/home/tester/.pi/lazy"],
		["bare tilde POSIX", "~", posixHome, "linux", "/home/tester"],
		["absolute POSIX", "/tmp/pi-agent", posixHome, "linux", "/tmp/pi-agent"],
		["default Windows", undefined, windowsHome, "win32", "C:\\Users\\tester\\.pi\\agent"],
		["tilde Windows", "~\\.pi\\lazy", windowsHome, "win32", "C:\\Users\\tester\\.pi\\lazy"],
	];

	for (const [name, configured, home, platformName, expected] of cases) {
		assert.equal(resolveAgentConfigDir(configured, home, platformName), expected, name);
	}
});

test("status reads settings from PI_CODING_AGENT_DIR", (t) => {
	const { home, workspace } = createWorkspace(t);
	const customAgentDir = join(home, ".pi", "lazy");
	writeSettings(join(home, ".pi", "agent"), ["npm:pi-omp-advisor"]);
	writeSettings(customAgentDir, ["npm:@narumitw/pi-goal"]);

	const result = runCli(["status"], { cwd: workspace, home, agentDir: "~/.pi/lazy" });

	assert.equal(result.status, 0, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
	assert.ok(result.stdout.includes(`Settings file: ${join(customAgentDir, "settings.json")}`));
	assert.match(result.stdout, /✓ \[core\] goal/);
	assert.doesNotMatch(result.stdout, /✓ \[core\] advisor/);
});

test("install reads auth and uses the custom global settings", (t) => {
	const { root, home, workspace, bin } = createWorkspace(t);
	const defaultAgentDir = join(home, ".pi", "agent");
	const customAgentDir = join(home, ".pi", "lazy");
	const callsPath = join(root, "pi-calls.log");
	writeFakePi(bin);
	writeSettings(defaultAgentDir, ["npm:@narumitw/pi-goal"]);
	writeSettings(customAgentDir, ["npm:pi-mcp-adapter"]);
	writeJson(join(customAgentDir, "auth.json"), { anthropic: { type: "api_key", key: "custom" } });

	const result = runCli(["--yes", "--only", "goal"], { cwd: workspace, home, agentDir: customAgentDir, bin, callsPath });

	assert.equal(result.status, 0, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
	assert.match(result.stdout, /Pi credentials:\s+anthropic \(auth\.json\)/);
	assert.deepEqual(readFileSync(callsPath, "utf8").trim().split(/\r?\n/), ["install npm:@narumitw/pi-goal"]);
	assert.deepEqual(JSON.parse(readFileSync(join(defaultAgentDir, "settings.json"), "utf8")).packages, ["npm:@narumitw/pi-goal"]);
});

test("update and remove inspect the custom global settings", (t) => {
	const { root, home, workspace, bin } = createWorkspace(t);
	const callsPath = join(root, "pi-calls.log");
	const defaultAgentDir = join(home, ".pi", "agent");
	const customAgentDir = join(home, ".pi", "lazy");
	writeFakePi(bin);
	writeSettings(defaultAgentDir, ["npm:pi-subagents"]);
	writeSettings(customAgentDir, ["npm:pi-mcp-adapter", "npm:@moguw/pi-openai-tools"]);

	const updateResult = runCli(["update"], { cwd: workspace, home, agentDir: customAgentDir, bin, callsPath });
	assert.equal(updateResult.status, 0, `STDOUT:\n${updateResult.stdout}\nSTDERR:\n${updateResult.stderr}`);
	assert.deepEqual(JSON.parse(readFileSync(join(customAgentDir, "settings.json"), "utf8")).packages, ["npm:pi-mcp-adapter", "npm:@moguw/pi-openai-tools"]);
	assert.deepEqual(JSON.parse(readFileSync(join(defaultAgentDir, "settings.json"), "utf8")).packages, ["npm:pi-subagents"]);

	const removeResult = runCli(["remove", "openai-tools"], { cwd: workspace, home, agentDir: customAgentDir, bin, callsPath });
	assert.equal(removeResult.status, 0, `STDOUT:\n${removeResult.stdout}\nSTDERR:\n${removeResult.stderr}`);
	const calls = readFileSync(callsPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
	assert.deepEqual(calls, ["update", "remove npm:@moguw/pi-openai-tools"]);
});

test("--local settings remain independent of PI_CODING_AGENT_DIR", (t) => {
	const { home, workspace } = createWorkspace(t);
	const customAgentDir = join(home, ".pi", "lazy");
	writeSettings(customAgentDir, ["npm:@narumitw/pi-goal"]);
	writeSettings(join(workspace, ".pi"), ["npm:pi-omp-advisor"]);

	const result = runCli(["status", "--local"], { cwd: workspace, home, agentDir: customAgentDir });

	assert.equal(result.status, 0, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
	assert.ok(result.stdout.includes(`Settings file: ${realpathSync(join(workspace, ".pi", "settings.json"))}`));
	assert.match(result.stdout, /✓ \[core\] advisor/);
	assert.doesNotMatch(result.stdout, /✓ \[core\] goal/);
});

test("--force removes installed extensions then reinstalls the catalog", (t) => {
	const { root, home, workspace, bin } = createWorkspace(t);
	const agentDir = join(home, ".pi", "agent");
	const callsPath = join(root, "pi-calls.log");
	writeFakePi(bin);
	writeSettings(agentDir, ["npm:pi-mcp-adapter", "npm:pi-simplify", "npm:extra-not-in-catalog"]);

	const result = runCli(["--force"], { cwd: workspace, home, agentDir, bin, callsPath });

	assert.equal(result.status, 0, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
	const calls = readFileSync(callsPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
	// 1) every installed extension is removed first, catalog entries and extras alike
	assert.deepEqual(calls.slice(0, 3), [
		"remove npm:pi-mcp-adapter",
		"remove npm:pi-simplify",
		"remove npm:extra-not-in-catalog",
	]);
	// 2) then the whole catalog is reinstalled in catalog order (file entries excluded)
	const expectedInstalls = PACKAGES.filter((pkg) => typeof pkg.source === "string").map((pkg) => `install ${pkg.source}`);
	assert.deepEqual(calls.slice(3), expectedInstalls);
	// 3) settings.json was backed up before the wipe
	const backups = readdirSync(agentDir).filter((name) => name.startsWith("settings.json.lazypi.") && name.endsWith(".bak"));
	assert.equal(backups.length, 1);
});
