import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
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

test("new tool packages install from npm and skip already-installed sources", (t) => {
	const state = createWorkspace(t);
	writeFakePi(state.bin);
	const callsPath = join(state.root, "pi-calls.log");
	const sources = ["npm:@moguw/pi-advisor", "npm:@getpipher/vision"];
	const args = ["--yes", "--only", "vision,advisor"];
	const first = runCli(args, { ...state, callsPath });
	assert.equal(first.status, 0, `STDOUT:\n${first.stdout}\nSTDERR:\n${first.stderr}`);
	const calls = readFileSync(callsPath, "utf8");
	assert.deepEqual(calls.trim().split(/\r?\n/), sources.map((source) => `install ${source}`));
	writeSettings(state.agentDir, sources);
	const second = runCli(args, { ...state, callsPath });
	assert.equal(second.status, 0, `STDOUT:\n${second.stdout}\nSTDERR:\n${second.stderr}`);
	assert.equal(readFileSync(callsPath, "utf8"), calls);
});
