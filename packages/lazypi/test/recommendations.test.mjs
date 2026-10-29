import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const CLI = resolve("bin/lazypi.mjs");

function workspace(t) {
	const root = mkdtempSync(join(tmpdir(), "lazypi-recommendations-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const state = { root, home: join(root, "home"), agentDir: join(root, "agent"), cwd: join(root, "work"), bin: join(root, "bin") };
	for (const path of [state.home, state.cwd, state.bin, state.agentDir]) mkdirSync(path);
	const script = join(state.bin, "fake-pi.mjs");
	writeFileSync(script, `
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('1.3.0'); process.exit(0); }
if (args[0] !== 'install') process.exit(0);
const file = join(process.env.PI_CODING_AGENT_DIR, 'settings.json');
const settings = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
settings.packages = [...(settings.packages ?? []), args.at(-1)];
writeFileSync(file, JSON.stringify(settings) + '\\n');
`);
	const command = join(state.bin, process.platform === "win32" ? "pi.cmd" : "pi");
	writeFileSync(command, process.platform === "win32"
		? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
		: `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
	chmodSync(command, 0o755);
	return state;
}

function run(state, args) {
	const env = {
		...process.env,
		HOME: state.home,
		USERPROFILE: state.home,
		PI_CODING_AGENT_DIR: state.agentDir,
		XDG_CONFIG_HOME: "",
		PATH: `${state.bin}${delimiter}${process.env.PATH}`,
	};
	const result = spawnSync(process.execPath, [CLI, ...args], { cwd: state.cwd, env, encoding: "utf8", timeout: 30_000 });
	assert.ifError(result.error);
	return result;
}

const writeJson = (path, value) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
};

test("doctor reports every unconfigured MCP server and skill", (t) => {
	const state = workspace(t);
	writeJson(join(state.agentDir, "settings.json"), {});
	const { stdout, status } = run(state, ["doctor"]);
	assert.equal(status, 0);
	for (const server of ["context7", "exa", "firecrawl", "cua"]) assert.match(stdout, new RegExp(`mcp ${server} not configured`));
	assert.match(stdout, /skill anthropic-skills not installed/);
	assert.match(stdout, /skill pi-skills not installed/);
	assert.match(stdout, /skill impeccable not installed/);
	assert.match(stdout, /skill pstack not installed/);
	assert.match(stdout, /pi mcp add exa --url https:\/\/mcp\.exa\.ai\/mcp --bearer-token-env-var EXA_API_KEY/);
});

test("doctor accepts user-level and registered/copied recommendations", (t) => {
	const state = workspace(t);
	writeJson(join(state.agentDir, "mcp.json"), { mcpServers: { context7: {}, exa: {}, firecrawl: {}, cua: {} } });
	writeJson(join(state.agentDir, "settings.json"), { packages: ["git:github.com/anthropics/skills@main"] });
	for (const dir of ["pi-skills", "impeccable", "pstack"]) mkdirSync(join(state.home, ".agents", "skills", dir), { recursive: true });
	const { stdout, status } = run(state, ["doctor"]);
	assert.equal(status, 0);
	assert.doesNotMatch(stdout, /not configured/);
	assert.doesNotMatch(stdout, /not installed/);
	assert.match(stdout, /All recommended MCP servers and skills are present/);
});

test("a project-level mcp.json also counts as configured", (t) => {
	const state = workspace(t);
	writeJson(join(state.agentDir, "settings.json"), {});
	writeJson(join(state.cwd, ".pi", "mcp.json"), { mcpServers: { exa: {} } });
	const { stdout } = run(state, ["doctor"]);
	assert.doesNotMatch(stdout, /mcp exa not configured/);
	assert.match(stdout, /mcp context7 not configured/);
});

test("install prints the recommended commands after installation", (t) => {
	const state = workspace(t);
	const { stdout, status } = run(state, ["--only", "global-agents", "--yes"]);
	assert.equal(status, 0);
	assert.match(stdout, /Recommended integrations:/);
	assert.match(stdout, /pi mcp add firecrawl /);
	assert.match(stdout, /git clone --depth 1 https:\/\/github\.com\/badlogic\/pi-skills ~\/\.agents\/skills\/pi-skills/);
	assert.match(stdout, /npx impeccable install/);
	assert.match(stdout, /sparse-checkout set pstack/);
});

test("install stays quiet when every recommendation is present", (t) => {
	const state = workspace(t);
	writeJson(join(state.agentDir, "mcp.json"), { mcpServers: { context7: {}, exa: {}, firecrawl: {}, cua: {} } });
	for (const dir of ["pi-skills", "impeccable", "pstack"]) mkdirSync(join(state.home, ".agents", "skills", dir), { recursive: true });
	writeJson(join(state.agentDir, "settings.json"), { packages: ["git:github.com/anthropics/skills"] });
	const { stdout, status } = run(state, ["--only", "global-agents", "--yes"]);
	assert.equal(status, 0);
	assert.doesNotMatch(stdout, /Recommended integrations/);
});
