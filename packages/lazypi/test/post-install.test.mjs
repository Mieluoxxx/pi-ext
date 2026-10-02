import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const CLI_PATH = resolve("bin/lazypi.mjs");

function createWorkspace(t) {
	const root = mkdtempSync(join(tmpdir(), "lazypi-post-install-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	const bin = join(root, "bin");
	const agentDir = join(home, ".pi", "agent");
	mkdirSync(home, { recursive: true });
	mkdirSync(workspace, { recursive: true });
	mkdirSync(bin, { recursive: true });
	return { root, home, workspace, bin, agentDir };
}

function writeSettings(agentDir, packages) {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages }, null, 2) + "\n");
}

function writeFakePi(bin) {
	if (process.platform === "win32") {
		const piPath = join(bin, "pi.cmd");
		writeFileSync(piPath, "@echo off\r\nif \"%1\"==\"--version\" (echo pi test & exit /b 0)\r\nif defined PI_TEST_CALLS echo %*>>\"%PI_TEST_CALLS%\"\r\nif defined PI_TEST_FAIL_SOURCE echo %* | findstr /C:\"%PI_TEST_FAIL_SOURCE%\" >nul && exit /b 1\r\nexit /b 0\r\n");
		return;
	}
	const piPath = join(bin, "pi");
	writeFileSync(piPath, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'pi test'; exit 0; fi\nif [ -n \"$PI_TEST_CALLS\" ]; then printf '%s\\n' \"$*\" >> \"$PI_TEST_CALLS\"; fi\nif [ -n \"$PI_TEST_FAIL_SOURCE\" ]; then\n  case \"$*\" in\n    *\"$PI_TEST_FAIL_SOURCE\"*) exit 1 ;;\n  esac\nfi\nexit 0\n");
	chmodSync(piPath, 0o755);
}

function runCli(args, { workspace, home, agentDir, bin, callsPath, failSource } = {}) {
	const env = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: agentDir,
		PATH: [bin, process.env.PATH].filter(Boolean).join(delimiter),
	};
	if (callsPath) env.PI_TEST_CALLS = callsPath;
	if (failSource) env.PI_TEST_FAIL_SOURCE = failSource;
	const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
		cwd: workspace,
		env,
		encoding: "utf8",
		timeout: 60_000,
	});
	if (result.error) throw result.error;
	return result;
}

function globalConfigPath(agentDir) {
	return join(agentDir, "extensions", "pi-tool-display", "config.json");
}

function localConfigPath(workspace) {
	return join(workspace, ".pi", "extensions", "pi-tool-display", "config.json");
}

function installBoth(workspaceState, extraArgs = []) {
	return runCli(["--yes", "--only", "tool-display,hashline-edit-pro", ...extraArgs], workspaceState);
}

test("same-run selection creates the tool-display compatibility config", (t) => {
	const state = createWorkspace(t);
	writeFakePi(state.bin);
	const result = installBoth(state);
	assert.equal(result.status, 0, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
	assert.deepEqual(JSON.parse(readFileSync(globalConfigPath(state.agentDir), "utf8")), {
		registerToolOverrides: { read: false },
	});
	assert.match(result.stdout, /Applied post-install configuration for tool-display/);
});

test("selecting only one package does not run its post-install rule", (t) => {
	const state = createWorkspace(t);
	writeFakePi(state.bin);
	const result = runCli(["--yes", "--only", "tool-display"], state);
	assert.equal(result.status, 0, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
	assert.equal(existsSync(globalConfigPath(state.agentDir)), false);
});

test("a package installation failure does not write compatibility config", (t) => {
	const state = createWorkspace(t);
	writeFakePi(state.bin);
	const result = installBoth({ ...state, failSource: "npm:@moguw/pi-hashline-edit-pro" });
	assert.equal(result.status, 1, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
	assert.equal(existsSync(globalConfigPath(state.agentDir)), false);
});
test("an unrelated package failure does not suppress successful compatibility post-processing", (t) => {
	const state = createWorkspace(t);
	writeFakePi(state.bin);
	const result = runCli(["--yes", "--only", "tool-display,hashline-edit-pro,advisor"], { ...state, failSource: "npm:pi-omp-advisor" });
	assert.equal(result.status, 1, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
	assert.deepEqual(JSON.parse(readFileSync(globalConfigPath(state.agentDir), "utf8")), {
		registerToolOverrides: { read: false },
	});
	assert.match(`${result.stdout}\n${result.stderr}`, /failed to install advisor/);
});


test("post-install JSON merge preserves unrelated configuration and backs up changes", (t) => {
	const state = createWorkspace(t);
	writeFakePi(state.bin);
	const configPath = globalConfigPath(state.agentDir);
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(configPath, JSON.stringify({
		name: "custom",
		registerToolOverrides: { grep: true, read: true },
		other: { enabled: true },
	}, null, 2) + "\n");
	const result = installBoth(state);
	assert.equal(result.status, 0, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
	assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
		name: "custom",
		registerToolOverrides: { grep: true, read: false },
		other: { enabled: true },
	});
	assert.equal(readdirSync(dirname(configPath)).some((name) => name.includes(".lazypi.") && name.endsWith(".bak")), true);
});

test("an existing false value is idempotent and does not create a backup", (t) => {
	const state = createWorkspace(t);
	writeFakePi(state.bin);
	const configPath = globalConfigPath(state.agentDir);
	mkdirSync(dirname(configPath), { recursive: true });
	const original = JSON.stringify({ registerToolOverrides: { read: false } }, null, 2) + "\n";
	writeFileSync(configPath, original);
	const result = installBoth(state);
	assert.equal(result.status, 0, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
	assert.equal(readFileSync(configPath, "utf8"), original);
	assert.deepEqual(readdirSync(dirname(configPath)), ["config.json"]);
});

test("a non-object compatibility JSON root fails without overwriting the file", (t) => {
	const state = createWorkspace(t);
	writeFakePi(state.bin);
	const configPath = globalConfigPath(state.agentDir);
	mkdirSync(dirname(configPath), { recursive: true });
	const original = "[]\n";
	writeFileSync(configPath, original);
	const result = installBoth(state);
	assert.equal(result.status, 1, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
	assert.equal(readFileSync(configPath, "utf8"), original);
	assert.match(`${result.stdout}\n${result.stderr}`, /JSON root must be an object/);
});

test("malformed compatibility JSON fails without overwriting the file", (t) => {
	const state = createWorkspace(t);
	writeFakePi(state.bin);
	const configPath = globalConfigPath(state.agentDir);
	mkdirSync(dirname(configPath), { recursive: true });
	const original = "{ broken\n";
	writeFileSync(configPath, original);
	const result = installBoth(state);
	assert.equal(result.status, 1, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
	assert.equal(readFileSync(configPath, "utf8"), original);
	assert.match(`${result.stdout}\n${result.stderr}`, /Post-install configuration failed/);
});

test("local installation writes compatibility config under the project .pi root", (t) => {
	const state = createWorkspace(t);
	writeFakePi(state.bin);
	const result = installBoth(state, ["--local"]);
	assert.equal(result.status, 0, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
	assert.deepEqual(JSON.parse(readFileSync(localConfigPath(state.workspace), "utf8")), {
		registerToolOverrides: { read: false },
	});
	assert.equal(existsSync(globalConfigPath(state.agentDir)), false);
});

test("same-run selection reconciles before the already-installed early return", (t) => {
	const state = createWorkspace(t);
	writeFakePi(state.bin);
	writeSettings(state.agentDir, ["npm:@moguw/pi-tool-display", "npm:@moguw/pi-hashline-edit-pro"]);
	const callsPath = join(state.root, "pi-calls.log");
	const result = installBoth({ ...state, callsPath });
	assert.equal(result.status, 0, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
	assert.deepEqual(JSON.parse(readFileSync(globalConfigPath(state.agentDir), "utf8")), {
		registerToolOverrides: { read: false },
	});
	assert.equal(existsSync(callsPath), false);
});

test("FFF installation no longer recommends a mode that overrides preset configuration", (t) => {
	const state = createWorkspace(t);
	writeFakePi(state.bin);
	const result = runCli(["--yes", "--only", "fff"], state);
	assert.equal(result.status, 0, `STDOUT:\n${result.stdout}\n${result.stderr}`);
	assert.doesNotMatch(result.stdout, /export PI_FFF_MODE=override/);
	assert.match(result.stdout, /tools-and-ui/);
});

test("new tool packages install from npm and skip already-installed sources", (t) => {
	const state = createWorkspace(t);
	writeFakePi(state.bin);
	const callsPath = join(state.root, "pi-calls.log");
	const sources = ["npm:@injaneity/pi-computer-use", "npm:@moguw/pi-openai-tools"];
	const args = ["--yes", "--only", "computer-use,openai-tools"];
	const first = runCli(args, { ...state, callsPath });
	assert.equal(first.status, 0, `STDOUT:\n${first.stdout}\nSTDERR:\n${first.stderr}`);
	const calls = readFileSync(callsPath, "utf8");
	assert.deepEqual(calls.trim().split(/\r?\n/), sources.map((source) => `install ${source}`));
	writeSettings(state.agentDir, sources);
	const second = runCli(args, { ...state, callsPath });
	assert.equal(second.status, 0, `STDOUT:\n${second.stdout}\nSTDERR:\n${second.stderr}`);
	assert.equal(readFileSync(callsPath, "utf8"), calls);
	assert.equal(existsSync(globalConfigPath(state.agentDir)), false);
});
