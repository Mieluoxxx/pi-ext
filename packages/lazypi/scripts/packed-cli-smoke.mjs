import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function npmExecutable(platformName = process.platform) {
	return platformName === "win32" ? "npm.cmd" : "npm";
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { encoding: "utf8", shell: process.platform === "win32", ...options });
	if (result.error) throw result.error;
	return result;
}

function resultSummary(result) {
	return `exit=${result.status ?? "null"}\nSTDOUT:\n${result.stdout ?? ""}\nSTDERR:\n${result.stderr ?? ""}`;
}

export function runPackedCliSmoke({ cwd = process.cwd() } = {}) {
	const npm = npmExecutable();
	const sandbox = mkdtempSync(join(tmpdir(), "lazypi-packed-presets-"));
	try {
		const pack = run(npm, ["pack", "--json", "--pack-destination", sandbox], { cwd });
		assert.equal(pack.status, 0, `npm pack failed\n${resultSummary(pack)}`);
		// npm 12 returns a name-keyed object; older npm versions return an array.
		const [artifact] = Object.values(JSON.parse(pack.stdout));
		assert.ok(artifact?.filename, "npm pack did not return an artifact");
		const tarballPath = resolve(sandbox, artifact.filename);
		assert.equal(existsSync(tarballPath), true, `packed tarball was not created at ${tarballPath}`);
		const paths = artifact.files.map((file) => file.path);
		for (const name of ["base", "ui", "workflow"]) assert.ok(paths.includes(`presets/${name}/preset.json`));
		assert.ok(paths.includes("lib/presets.mjs"));
		assert.ok(paths.every((path) => /^(package\.json$|README\.md$|LICENSE$|bin\/|lib\/|agent\/|themes\/|presets\/(base|ui|workflow)\/)/.test(path)), "unexpected published file");
		assert.ok(paths.every((path) => !/(auth\.json|models\.json|\.bak|\.lazypi\.|\.env)/i.test(path)), "private configuration or backup in package");
		const smoke = run(npm, ["exec", "--yes", `--package=${tarballPath}`, "--call", "lazypi --help"], { cwd });
		assert.equal(smoke.status, 0, `packed CLI smoke failed\n${resultSummary(smoke)}`);
		assert.match(smoke.stdout, /lazypi — personal Pi extension manager/);
		assert.match(smoke.stdout, /Usage:/);
		const agent = join(sandbox, "agent");
		mkdirSync(agent);
		writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: ["npm:keep"], defaultModel: "keep-model", defaultThinkingLevel: "low" }));
		writeFileSync(join(agent, "AGENTS.md"), "# old instructions\n");
		writeFileSync(join(agent, "models.json"), '\uFEFF// model definitions\n{"providers":{"custom":{"apiKey":"$TEST_MODEL_KEY","models":[{"id":"keep"},{"id":"selected","contextWindow":4000},],},},}', { mode: 0o600 });
		const manifest = join(sandbox, "preset.json");
		writeFileSync(manifest, JSON.stringify({ version: 1, files: [
			{ from: "settings.fragment.json", to: "agent/settings.json", mode: "merge" },
			{ from: "models.fragment.json", to: "agent/models.json", mode: "merge-models" },
		] }));
		writeFileSync(join(sandbox, "settings.fragment.json"), JSON.stringify({ defaultThinkingLevel: "high" }));
		writeFileSync(join(sandbox, "models.fragment.json"), JSON.stringify({ providers: { custom: { models: [{ id: "selected", contextWindow: 8000 }] } } }));
		const env = { ...process.env, HOME: sandbox, USERPROFILE: sandbox, PI_CODING_AGENT_DIR: agent, XDG_CONFIG_HOME: join(sandbox, "xdg") };
		const invoke = (command) => run(npm, ["exec", "--yes", `--package=${tarballPath}`, "--call", `lazypi ${command} --preset base --preset "${manifest}"`], { cwd: sandbox, env });
		const preview = invoke("install --dry-run");
		assert.equal(preview.status, 0, resultSummary(preview));
		assert.equal(JSON.parse(readFileSync(join(agent, "settings.json"), "utf8")).defaultThinkingLevel, "low");
		assert.match(readFileSync(join(agent, "models.json"), "utf8"), /4000/);
		for (let attempt = 0; attempt < 2; attempt++) {
			const install = invoke("install --yes");
			assert.equal(install.status, 0, resultSummary(install));
		}
		assert.deepEqual(JSON.parse(readFileSync(join(agent, "settings.json"), "utf8")), { packages: ["npm:keep"], defaultModel: "keep-model", defaultThinkingLevel: "high" });
		assert.deepEqual(JSON.parse(readFileSync(join(agent, "keybindings.json"), "utf8")), { "tui.altScreen.search": "ctrl+shift+f" });
		assert.equal(readFileSync(join(agent, "AGENTS.md"), "utf8"), readFileSync(join(cwd, "agent", "AGENTS.md"), "utf8"));
		assert.deepEqual(JSON.parse(readFileSync(join(agent, "models.json"), "utf8")), { providers: { custom: { apiKey: "$TEST_MODEL_KEY", models: [{ id: "keep" }, { id: "selected", contextWindow: 8000 }] } } });
		assert.equal(readdirSync(agent).filter((path) => path.endsWith(".bak")).length, 3);
		const status = invoke("status");
		assert.equal(status.status, 0, resultSummary(status));
		return { pack, smoke, tarballPath };
	} finally {
		rmSync(sandbox, { recursive: true, force: true });
	}
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;

if (entrypoint === import.meta.url) {
	const { smoke } = runPackedCliSmoke();
	process.stdout.write(smoke.stdout);
}
