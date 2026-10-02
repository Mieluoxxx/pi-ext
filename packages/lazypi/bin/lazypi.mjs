#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";
import { spawnSync } from "node:child_process";
import { argv, cwd, exit, stdout, stderr } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyConfiguration, loadPresets, mergeJsonObjects, planConfiguration } from "../lib/presets.mjs";
import {
	cancel as clackCancel,
	confirm as clackConfirm,
	intro,
	isCancel,
	log,
	note,
	outro,
	select,
} from "@clack/prompts";

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

// Customize this array; it is the only extension catalog used by the CLI.
export const PACKAGES = [
	// core
	{ id: "web-access", category: "core", source: "npm:@moguw/pi-web-access", description: "网页搜索与页面抓取", hint: "为 Pi 提供 WebSearch 和 WebFetch 能力；个人偏好通过 workflow 预设安装。", loadBefore: ["lazy-tools"] },
	{ id: "advisor", category: "core", source: "npm:pi-omp-advisor", description: "实时会话顾问", hint: "通过 /advisor 管理观察者，WATCHDOG.yml 定制模型与行为；默认随主会话观察，会产生额外模型调用。", conflicts: ["npm:@juicesharp/rpiv-advisor"] },
	{ id: "workspace-history", category: "core", source: "npm:pi-workspace-history", description: "工作区回溯", hint: "回滚的不只是聊天记录——导航历史时同步恢复工作区文件，支持 /undo、/redo 与 /tree。" },
	{ id: "goal", category: "core", source: "npm:@narumitw/pi-goal", description: "长期目标模式", hint: "用 /goal 设定目标，Pi 跨回合自主推进直至完成，支持暂停、恢复与队列。" },
	{ id: "vision", category: "core", source: "npm:@getpipher/vision", description: "视觉能力", hint: "按主模型能力自动路由：多模态直读图片，纯文本模型才委托视觉模型分析。" },
	// ui
	{ id: "zentui", category: "ui", source: "npm:pi-zentui", description: "终端界面美化", hint: "Opencode 风格编辑框与消息样式，Starship 风格状态栏，四类界面元素独立配置。" },
	{ id: "tool-display", category: "ui", source: "npm:@moguw/pi-tool-display", description: "工具输出渲染", hint: "紧凑渲染工具调用与 diff，自动折叠截断冗长输出，让终端更清爽。", postInstall: [{ requiresSelected: ["hashline-edit-pro"], jsonMerge: { path: "extensions/pi-tool-display/config.json", value: { registerToolOverrides: { read: false } } } }] },
	// tools
	{ id: "interactive-shell", category: "tools", source: "npm:@moguw/pi-interactive-shell", description: "交互式 Shell 覆盖层", hint: "在可观察的覆盖层中运行长时间 CLI 与终端工作流。" },
	{ id: "fff", category: "tools", source: "npm:@ff-labs/pi-fff", description: "模糊文件搜索", hint: "基于 FFF 的模糊文件与内容搜索，快速定位文件和代码；workflow 预设使用 tools-and-ui 模式。", loadBefore: ["hashline-edit-pro", "lazy-tools"] },
	{ id: "hashline-edit-pro", category: "tools", source: "npm:@moguw/pi-hashline-edit-pro", description: "哈希锚点编辑", hint: "用行级哈希锚点做精确的读取与编辑。", loadBefore: ["lazy-tools"] },
	{ id: "ponytail", category: "tools", source: "git:github.com/DietrichGebert/ponytail@v4.9.0", description: "极简编码准则", hint: "懒惰资深工程师模式：能不写的代码就不写，优先复用现有实现，保持安全底线。" },
	{ id: "computer-use", category: "tools", source: "npm:@injaneity/pi-computer-use", description: "桌面界面操作", hint: "通过 /computer-use 检查桌面工具配置；macOS 需辅助功能与录屏权限，其他系统需可用的图形会话。", loadBefore: ["lazy-tools"] },
	{ id: "lazy-tools", category: "tools", source: "npm:@moguw/pi-lazy-tools", description: "按需启用工具组", hint: "读取对应 Skill 后按需启用已注册工具；/capability 手动启用，/tools-status 查看状态，不自动安装缺失能力。" },
	// herdr
	{ id: "session-rename", category: "herdr", source: "npm:@moguw/pi-session-rename", description: "会话自动命名", hint: "根据对话上下文自动给会话起名，/rename 随时手动管理。" },
	{ id: "session-migrate", category: "herdr", source: "npm:@moguw/pi-session-migrate", description: "会话迁移", hint: "项目挪路径后找回遗留会话，改写 cwd 迁入新位置，用 /migrate 执行。" },
	{ id: "session-fork", category: "herdr", source: "npm:@moguw/pi-session-fork", description: "会话分叉", hint: "把当前会话分叉到 Herdr 窗格或标签页，/btw 内联或旁路追问。" },
	// codex
	{ id: "openai-tools", category: "codex", source: "npm:@moguw/pi-openai-tools", description: "OpenAI 上下文与补丁工具", hint: "整合上下文管理、远程压缩、Astra 兼容和 apply_patch；图像生成默认关闭，不应与独立 pi-apply-patch 同时加载。", loadBefore: ["lazy-tools"], conflicts: ["git:github.com/code-yeongyu/pi-apply-patch", "https://github.com/code-yeongyu/pi-apply-patch"] },
	// themes
	{ id: "vesper-dark", category: "themes", themeFiles: ["themes/vesper-dark.json"], description: "Vesper 暗色主题", hint: "暖桃与薄荷色调的近黑暗色主题；将 settings.theme 设为 \"vesper-dark\" 启用。" },
	{ id: "vesper-light", category: "themes", themeFiles: ["themes/vesper-light.json"], description: "Vesper 亮色主题", hint: "暖米色底的亮色变体，桃色强调、薄荷点缀；将 settings.theme 设为 \"vesper-light\" 启用。" },
	// config
	{ id: "global-agents", category: "config", agentFiles: ["agent/AGENTS.md"], description: "全局 AGENTS.md", hint: "安装全局 agent 配置文件到 ~/.pi/agent/AGENTS.md，覆盖前自动备份。" },
];
const CATEGORIES = [...new Set(PACKAGES.map((pkg) => pkg.category))];

// ---------------------------------------------------------------------------
// Agent files (theme and config file installation)
// ---------------------------------------------------------------------------
// Catalog entries can ship files that install into Pi's agent directory:
// `themeFiles` land under themes/, `agentFiles` land at the agent root.
// Installing copies each file, backing up any existing file with the same name.
function themeTargetDir() {
	return join(agentConfigDir(), "themes");
}
function repoFilePath(relativePath) {
	return join(dirname(fileURLToPath(import.meta.url)), "..", relativePath);
}
function entryFileTargets(pkg) {
	const targets = [];
	for (const file of pkg.themeFiles ?? []) {
		targets.push({
			kind: "theme",
			name: basename(file),
			sourcePath: repoFilePath(file),
			targetPath: join(themeTargetDir(), basename(file)),
		});
	}
	for (const file of pkg.agentFiles ?? []) {
		targets.push({
			kind: "agent-file",
			name: basename(file),
			sourcePath: repoFilePath(file),
			targetPath: join(agentConfigDir(), basename(file)),
		});
	}
	return targets;
}
function isFileInstall(pkg) {
	return entryFileTargets(pkg).length > 0;
}
function fileInstallLabel(pkg) {
	return [...(pkg.themeFiles ?? []), ...(pkg.agentFiles ?? [])].join(", ");
}
function fileNeedsSync(file) {
	if (!existsSync(file.sourcePath)) return true;
	if (!existsSync(file.targetPath)) return true;
	return readFileSync(file.sourcePath, "utf8") !== readFileSync(file.targetPath, "utf8");
}
function fileInstallNeeded(pkg) {
	return entryFileTargets(pkg).some(fileNeedsSync);
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------
const isTTY = Boolean(stdout.isTTY);
const c = (code) => (s) => (isTTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = c("1");
const dim = c("2");
const red = c("31");
const green = c("32");
const yellow = c("33");
const cyan = c("36");
const blue = c("94");
const white = c("1;97");
const PACKAGE_COMMAND = `npx ${(() => {
	try {
		return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).name || "lazypi";
	} catch {
		return "lazypi";
	}
})()}`;
function packageVersion() {
	try {
		return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version || "0.0.0";
	} catch {
		return "0.0.0";
	}
}
// Minimum Node version declared by `engines.node`, so the doctor check cannot drift from package.json.
const MIN_NODE = (() => {
	try {
		return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).engines?.node || "";
	} catch {
		return "";
	}
})();
export function meetsNodeRequirement(version, range = MIN_NODE) {
	const wanted = (String(range).match(/\d+(\.\d+)*/) || [""])[0].split(".").map(Number);
	if (!wanted[0]) return true;
	const have = String(version).split(".").map(Number);
	for (let i = 0; i < wanted.length; i++) {
		const got = have[i] ?? 0;
		if (got !== wanted[i]) return got > wanted[i];
	}
	return true;
}
function printHeader(text) {
	console.log(`\n${bold(text)}`);
}

// ASCII "Pi" logo: capital P + lowercase i, with a blue "zzz" cascade
// rising from where the dot of the "i" would be. Letters in bold white,
// sleep trail in blue.
function renderLogo() {
	const Z = (s) => blue(s);
	const P = (s) => white(s);
	return [
		"",
		"                 " + Z("z Z z"),
		"                " + Z("z Z"),
		"               " + Z("z"),
		"        " + P("____   "),
		"       " + P("|  _ \\(_)"),
		"       " + P("| |_) | |"),
		"       " + P("|  __/| |"),
		"       " + P("|_|   |_|"),
		"",
	].join("\n");
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------
const KNOWN_COMMANDS = new Set(["install", "status", "update", "doctor", "remove"]);

function parseArgs(args) {
	const flags = {
		command: "install",
		local: false,
		yes: false,
		force: false,
		dryRun: false,
		presets: [],
		help: false,
		version: false,
		only: null,
		except: null,
		targets: [],
	};

	let i = 0;
	if (args[0] && KNOWN_COMMANDS.has(args[0])) {
		flags.command = args[0];
		i = 1;
	}

	for (; i < args.length; i++) {
		const arg = args[i];
		if (arg === "-l" || arg === "--local") flags.local = true;
		else if (arg === "-y" || arg === "--yes") flags.yes = true;
		else if (arg === "--force") flags.force = true;
		else if (arg === "--dry-run") flags.dryRun = true;
		else if (arg === "--preset" || arg.startsWith("--preset=")) {
			const value = arg === "--preset" ? args[++i] : arg.slice("--preset=".length);
			if (!value || value.startsWith("-")) throw new Error("--preset requires a built-in name or a manifest path");
			flags.presets.push(value);
		}
		else if (arg === "-v" || arg === "--version") flags.version = true;
		else if (arg === "-h" || arg === "--help") flags.help = true;
		else if (arg === "--only") flags.only = parseList(args[++i]);
		else if (arg.startsWith("--only=")) flags.only = parseList(arg.slice("--only=".length));
		else if (arg === "--except") flags.except = parseList(args[++i]);
		else if (arg.startsWith("--except=")) flags.except = parseList(arg.slice("--except=".length));
		else if (flags.command === "remove" && !arg.startsWith("-")) flags.targets.push(arg);
		else {
			console.error(red(`Unknown argument: ${arg}`));
			flags.help = true;
			break;
		}
	}

	return flags;
}

function parseList(value) {
	if (!value) return [];
	return value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

function validateSelectors(list, label) {
	const ids = new Set(PACKAGES.map((p) => p.id));
	const bad = list.filter((name) => !CATEGORIES.includes(name) && !ids.has(name));
	if (bad.length > 0) {
		console.error(red(`Unknown ${label}: ${bad.join(", ")}`));
		console.error(`Valid categories: ${CATEGORIES.join(", ")}`);
		console.error(`Valid package ids:  ${[...ids].join(", ")}`);
		exit(2);
	}
}

function matchesSelector(pkg, selectors) {
	return selectors.some((name) => name === pkg.category || name === pkg.id);
}

function resolveSelection(flags) {
	if (flags.only) {
		validateSelectors(flags.only, "--only");
		return new Set(PACKAGES.filter((p) => matchesSelector(p, flags.only)).map((p) => p.id));
	}
	if (flags.except) {
		validateSelectors(flags.except, "--except");
		return new Set(PACKAGES.filter((p) => !matchesSelector(p, flags.except)).map((p) => p.id));
	}
	return new Set(PACKAGES.map((p) => p.id));
}

function expandPackageDependencies(selectedIds) {
	const expanded = new Set(selectedIds);
	let changed = true;
	while (changed) {
		changed = false;
		for (const pkg of PACKAGES) {
			if (!expanded.has(pkg.id) || !Array.isArray(pkg.dependencies)) continue;
			for (const dependencyId of pkg.dependencies) {
				if (expanded.has(dependencyId)) continue;
				expanded.add(dependencyId);
				changed = true;
			}
		}
	}
	return expanded;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------
function printHelp() {
	console.log(`${bold("lazypi")} — personal Pi extension manager

${bold("Usage:")}
  ${PACKAGE_COMMAND} [command] [options]

${bold("Commands:")}
  install   Install the selected extension catalog (default)
  remove    Remove a catalog extension by id or raw Pi source
  status    Show installed, missing, and extra Pi extensions
  update    Run the overall Pi extension update
  doctor    Check the Pi extension environment

${bold("Install options:")}
  --preset <name|file> Apply a built-in or external preset (repeatable; global only)
  --dry-run           Preview a preset installation without any writes or installs
  --only <list>       Install only the given categories or extension ids
  --except <list>     Install everything except the given categories or ids
	-l, --local         Install into the current project (.pi/settings.json)
	-y, --yes           Skip interactive selection and confirmation prompts
	--force             Remove all installed Pi extensions, then reinstall the catalog
	-v, --version       Show the current version
	-h, --help          Show this help

${bold("Default behaviour:")}
  - Every catalog extension is installed by default.
  - With --preset, only preset requirements and additional --only selections are installed.
  - Built-in presets: base, ui, workflow. Later presets override earlier preferences.
  - Presets cannot be combined with --local or --force; status --preset checks drift.
  - On a TTY, choose everything or review packages one by one with recommendation reasons.
  - With --yes, --force, --only, or --except interactive selection is skipped.
  - --force removes every installed Pi extension (settings backed up first), then reinstalls the selected catalog; file entries are resynced with a backup before overwrite.
  - update does not filter one extension; use pi update <source> for that.

${bold("Categories:")}
${CATEGORIES.map((category) => `  ${category}`).join("\n")}

${bold("Examples:")}
  ${PACKAGE_COMMAND}                              # everything
  ${PACKAGE_COMMAND} --yes                        # everything, no prompt
  ${PACKAGE_COMMAND} --force                      # force reinstall everything
  ${PACKAGE_COMMAND} --only core                  # core extensions
  ${PACKAGE_COMMAND} --only goal,advisor          # selected extensions
  ${PACKAGE_COMMAND} --only core --local          # project-local install
  ${PACKAGE_COMMAND} status
  ${PACKAGE_COMMAND} doctor`);
}

// ---------------------------------------------------------------------------
// Pi / settings plumbing
// ---------------------------------------------------------------------------
// On Windows, package-manager CLIs and global Node bins are usually `.cmd`
// shims. Node's child_process docs note that those need to be launched via a
// shell, so we route spawned commands through the platform shell there while
// keeping direct execution on Unix.
export function buildSpawnOptions(options = {}, platformName = platform()) {
	const resolved = { ...options };
	if (platformName === "win32" && resolved.shell == null) resolved.shell = true;
	return resolved;
}

export function spawnCommand(command, args = [], options = {}) {
	return spawnSync(command, args, buildSpawnOptions(options));
}

function hasCmd(name) {
	const probe = spawnCommand(platform() === "win32" ? "where" : "which", [name], { stdio: "ignore" });
	return probe.status === 0;
}

export function resolveAgentConfigDir(configured, home = homedir(), platformName = platform()) {
	const joinPath = platformName === "win32" ? win32.join : posix.join;
	if (!configured) return joinPath(home, ".pi", "agent");
	if (configured === "~") return home;
	if (configured.startsWith("~/") || (platformName === "win32" && configured.startsWith("~\\"))) {
		return joinPath(home, configured.slice(2));
	}
	return configured;
}

function agentConfigDir() {
	return resolveAgentConfigDir(process.env.PI_CODING_AGENT_DIR);
}

function settingsPath(local) {
	return local ? join(cwd(), ".pi", "settings.json") : join(agentConfigDir(), "settings.json");
}



function readSettings(local) {
	const path = settingsPath(local);
	if (!existsSync(path)) return { path, exists: false, parsed: null, error: null };
	try {
		return { path, exists: true, parsed: JSON.parse(readFileSync(path, "utf8")), error: null };
	} catch (err) {
		return { path, exists: true, parsed: null, error: err instanceof Error ? err.message : String(err) };
	}
}
function backupPath(path) {
	const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
	return `${path}.lazypi.${timestamp}.bak`;
}

function writeSettings(local, mutate) {
	const current = readSettings(local);
	if (current.error) return { ok: false, path: current.path, error: current.error };
	const settings = current.parsed ?? {};
	const changed = mutate(settings);
	if (!changed) return { ok: true, path: current.path, backup: null, changed: false };
	mkdirSync(dirname(current.path), { recursive: true });
	let backup = null;
	if (current.exists) {
		backup = backupPath(current.path);
		copyFileSync(current.path, backup);
	}
	writeFileSync(current.path, JSON.stringify(settings, null, 2) + "\n", "utf8");
	return { ok: true, path: current.path, backup, changed: true };
}
function installRoot(local) {
	return local ? join(cwd(), ".pi") : agentConfigDir();
}

function isJsonObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJsonObjectFile(path) {
	if (!existsSync(path)) return { exists: false, value: {} };
	try {
		const value = JSON.parse(readFileSync(path, "utf8"));
		if (!isJsonObject(value)) return { exists: true, error: "the JSON root must be an object" };
		return { exists: true, value };
	} catch (err) {
		return { exists: true, error: err instanceof Error ? err.message : String(err) };
	}
}

function applyJsonMergePostInstall(local, ownerId, rule) {
	const jsonMerge = rule?.jsonMerge;
	if (!isJsonObject(jsonMerge) || typeof jsonMerge.path !== "string" || !isJsonObject(jsonMerge.value)) {
		return { ok: false, error: `invalid postInstall jsonMerge metadata for ${ownerId}` };
	}
	const path = join(installRoot(local), jsonMerge.path);
	const current = readJsonObjectFile(path);
	if (current.error) return { ok: false, path, error: current.error };
	const changed = mergeJsonObjects(current.value, jsonMerge.value);
	if (!changed) return { ok: true, path, changed: false, backup: null };
	try {
		mkdirSync(dirname(path), { recursive: true });
		let backup = null;
		if (current.exists) {
			backup = backupPath(path);
			copyFileSync(path, backup);
		}
		writeFileSync(path, JSON.stringify(current.value, null, 2) + "\n", "utf8");
		return { ok: true, path, changed: true, backup };
	} catch (err) {
		return { ok: false, path, error: err instanceof Error ? err.message : String(err) };
	}
}

function runSelectedPostInstalls(selected, local, failedIds = new Set()) {
	const selectedIds = new Set(selected.map((pkg) => pkg.id));
	const results = [];
	for (const pkg of selected) {
		for (const rule of pkg.postInstall ?? []) {
			const required = Array.isArray(rule.requiresSelected) ? rule.requiresSelected : [];
			if (!required.every((id) => selectedIds.has(id))) continue;
			const involvedIds = [pkg.id, ...required];
			if (involvedIds.some((id) => failedIds.has(id))) continue;
			const result = applyJsonMergePostInstall(local, pkg.id, rule);
			const entry = { ownerId: pkg.id, ...result };
			results.push(entry);
			if (!result.ok) return { ok: false, results, failure: entry };
		}
	}
	return { ok: true, results };
}

function reportPostInstallResults(result, interactive) {
	if (!result.ok) {
		const message = `Post-install configuration failed after extension installation for ${result.failure.ownerId}${result.failure.path ? ` at ${result.failure.path}` : ""}: ${result.failure.error}`;
		if (interactive) log.error(message);
		else console.error(red(message));
		return false;
	}
	for (const entry of result.results) {
		if (!entry.changed) continue;
		const backup = entry.backup ? ` Backup: ${entry.backup}` : "";
		const message = `Applied post-install configuration for ${entry.ownerId}.${backup}`;
		if (interactive) log.success(message);
		else console.log(green(message));
	}
	return true;
}

function installAgentFiles(pkg, force = false) {
	const installed = [];
	const missingSource = [];
	for (const file of entryFileTargets(pkg)) {
		if (!existsSync(file.sourcePath)) {
			missingSource.push(file.name);
			continue;
		}
		if (!force && !fileNeedsSync(file)) continue;
		mkdirSync(dirname(file.targetPath), { recursive: true });
		let backup = null;
		if (existsSync(file.targetPath)) {
			backup = backupPath(file.targetPath);
			copyFileSync(file.targetPath, backup);
		}
		copyFileSync(file.sourcePath, file.targetPath);
		installed.push({ kind: file.kind, name: file.name, backup });
	}
	return { ok: missingSource.length === 0, installed, missingSource };
}

function reportAgentFileInstall(result, interactive) {
	for (const entry of result.installed) {
		const backup = entry.backup ? ` Backup: ${entry.backup}` : "";
		const kindLabel = entry.kind === "theme" ? "theme" : "agent file";
		const message = `Installed ${kindLabel} ${entry.name}.${backup}`;
		if (interactive) log.success(message);
		else console.log(green(message));
	}
	if (result.missingSource.length > 0) {
		const message = `Source file(s) missing from this repo: ${result.missingSource.join(", ")}`;
		if (interactive) log.error(message);
		else console.error(red(message));
	}
}




function packageEntrySource(entry) {
	if (typeof entry === "string") return entry;
	if (entry && typeof entry === "object" && typeof entry.source === "string") return entry.source;
	return null;
}

function readInstalledSources(local) {
	const current = readSettings(local);
	if (!current.exists) return { sources: new Set(), path: current.path, exists: false };
	if (current.error) return { sources: new Set(), path: current.path, exists: true, error: current.error };
	const sources = new Set();
	for (const entry of current.parsed?.packages ?? []) {
		const source = packageEntrySource(entry);
		if (source) sources.add(source);
	}
	return { sources, path: current.path, exists: true };
}
function normalizedPackageEntries(settings, catalog = PACKAGES) {
	if (!Array.isArray(settings?.packages)) return { ordered: null, constrained: false, cycle: false };
	const entries = settings.packages;
	const sources = entries.map(packageEntrySource);
	const indexes = new Map();
	for (const [index, source] of sources.entries()) if (source && !indexes.has(source)) indexes.set(source, index);
	const prerequisites = entries.map(() => new Set());
	let constrained = false;
	for (const pkg of catalog) {
		if (!Array.isArray(pkg.loadBefore)) continue;
		const from = indexes.get(pkg.source);
		if (from == null) continue;
		for (const targetRef of pkg.loadBefore) {
			const target = catalog.find((candidate) => candidate.id === targetRef || candidate.source === targetRef);
			const to = target ? indexes.get(target.source) : undefined;
			if (to == null || from === to || prerequisites[to].has(from)) continue;
			prerequisites[to].add(from);
			constrained = true;
		}
	}
	if (!constrained) return { ordered: entries, constrained: false, cycle: false };
	const state = entries.map(() => 0);
	const order = [];
	let cycle = false;
	const visit = (index) => {
		if (state[index] === 2 || cycle) return;
		if (state[index] === 1) {
			cycle = true;
			return;
		}
		state[index] = 1;
		for (const prerequisite of prerequisites[index]) visit(prerequisite);
		state[index] = 2;
		order.push(index);
	};
	for (let index = 0; index < entries.length; index++) visit(index);
	if (cycle) return { ordered: entries, constrained, cycle: true };
	return { ordered: order.map((index) => entries[index]), constrained, cycle: false };
}

export function normalizePackageLoadOrderInSettings(settings, catalog = PACKAGES) {
	const result = normalizedPackageEntries(settings, catalog);
	if (!result.constrained || result.cycle) return false;
	const changed = result.ordered.some((entry, index) => entry !== settings.packages[index]);
	if (changed) settings.packages = result.ordered;
	return changed;
}

function normalizePackageLoadOrder(local) {
	return writeSettings(local, normalizePackageLoadOrderInSettings);
}

function packageLoadOrderStatusFromSettings(settings, catalog = PACKAGES) {
	const result = normalizedPackageEntries(settings, catalog);
	if (!result.constrained) return { checked: false };
	return {
		checked: true,
		ok: !result.cycle && result.ordered.every((entry, index) => entry === settings.packages[index]),
		cycle: result.cycle,
	};
}

function packageLoadOrderStatus(local) {
	const current = readSettings(local);
	if (!current.exists) return { checked: false, path: current.path, exists: false };
	if (current.error) return { checked: false, path: current.path, exists: true, error: current.error };
	return { ...packageLoadOrderStatusFromSettings(current.parsed), path: current.path, exists: true };
}

function reportLoadOrderNormalization(result, interactive) {
	if (!result.ok) {
		const message = `Could not update package load order in ${result.path} — ${result.error}`;
		if (interactive) log.warn(message);
		else console.warn(yellow(message));
		return;
	}
	if (!result.changed) return;
	const backup = result.backup ? ` Backup: ${result.backup}` : "";
	const message = `Updated package load order from catalog metadata.${backup}`;
	if (interactive) log.success(message);
	else console.log(green(message));
}


function packageInstallStatus(pkg, installedPiSources) {
	if (isFileInstall(pkg)) {
		const installed = entryFileTargets(pkg).every((file) => existsSync(file.targetPath));
		return { installed, present: installed };
	}
	const installed = installedPiSources.has(pkg.source);
	return { installed, present: installed };
}

function isPackageInstalled(pkg, installedPiSources) {
	return packageInstallStatus(pkg, installedPiSources).installed;
}

function isPackagePresent(pkg, installedPiSources) {
	return packageInstallStatus(pkg, installedPiSources).present;
}




function clearInstalledSources(local) {
	const { sources, path, exists } = readInstalledSources(local);
	if (!exists || sources.size === 0) return { removed: [], failed: [], backup: null, error: null };
	let backup = null;
	try {
		backup = backupPath(path);
		copyFileSync(path, backup);
	} catch (err) {
		return { removed: [], failed: [], backup: null, error: err instanceof Error ? err.message : String(err) };
	}
	const failed = [];
	const piArgs = local ? ["remove", "-l"] : ["remove"];
	for (const source of sources) {
		const status = spawnCommand("pi", [...piArgs, source], { stdio: "inherit" }).status;
		if (status !== 0) failed.push(source);
	}
	return { removed: [...sources], failed, backup, error: null };
}

function runPi(args) {
	const result = spawnCommand("pi", args, { stdio: "inherit" });
	return result.status ?? 1;
}



// ---------------------------------------------------------------------------
// Pi / settings plumbing (shared helpers)
// ---------------------------------------------------------------------------
function readJsonSafe(path) {
	try {
		if (!existsSync(path)) return null;
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Auth detection (read-only)
// ---------------------------------------------------------------------------
// Pi reads credentials from auth.json in its agent config directory and also
// honors provider env vars. LazyPi reports available credentials so users
// know whether to run `pi /login` first.
const AUTH_ENV_VARS = [
	["ANTHROPIC_API_KEY", "anthropic"],
	["OPENAI_API_KEY", "openai"],
	["GOOGLE_API_KEY", "google"],
	["GEMINI_API_KEY", "google"],
	["OPENROUTER_API_KEY", "openrouter"],
	["TOGETHER_API_KEY", "together"],
	["GROQ_API_KEY", "groq"],
	["MISTRAL_API_KEY", "mistral"],
];

function authJsonPath() {
	return join(agentConfigDir(), "auth.json");
}

function detectAuth() {
	const envProviders = new Map(); // provider -> env var name
	for (const [name, provider] of AUTH_ENV_VARS) {
		if (process.env[name] && !envProviders.has(provider)) envProviders.set(provider, name);
	}
	const auth = readJsonSafe(authJsonPath()) ?? {};
	const fileProviders = Object.keys(auth);
	return {
		envProviders: [...envProviders.entries()].map(([provider, envVar]) => ({ provider, envVar })),
		fileProviders,
		path: authJsonPath(),
		authed: envProviders.size > 0 || fileProviders.length > 0,
	};
}

function formatAuthSummary(state) {
	const bits = [];
	for (const { provider, envVar } of state.envProviders) bits.push(`${provider} (${envVar})`);
	for (const provider of state.fileProviders) bits.push(`${provider} (auth.json)`);
	return bits.length > 0 ? bits.join(", ") : "none detected";
}

// ---------------------------------------------------------------------------
// Interactive prompts (powered by @clack/prompts)
// ---------------------------------------------------------------------------
function isInteractive() {
	return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function abortIfCancelled(value) {
	if (isCancel(value)) {
		clackCancel("Aborted.");
		exit(0);
	}
	return value;
}

async function confirm(message, initial = false) {
	const answer = await clackConfirm({ message, initialValue: initial });
	return abortIfCancelled(answer);
}

async function askLazyOrPick(totalCount) {
	const options = [
		{ value: "lazy", label: `Install everything`, hint: `all ${totalCount} packages` },
		{ value: "pick", label: "Review packages one by one", hint: "see each package's recommendation" },
	];

	const choice = await select({
		message: `Install all ${totalCount} Pi packages the lazy way, or pick them yourself?`,
		options,
		initialValue: "lazy",
	});
	return abortIfCancelled(choice);
}

export async function selectPackagesOneByOne(packages, initialSelected = new Set(), ask = confirm) {
	const selected = new Set();
	for (const pkg of packages) {
		const message = [
			`Install [${pkg.category}] ${pkg.id}?`,
			`  ${pkg.description}`,
			`  Recommended because: ${pkg.hint}`,
		].join("\n");
		if (await ask(message, initialSelected.has(pkg.id))) selected.add(pkg.id);
	}
	return selected;
}

async function runPicker(initialSelected) {
	return selectPackagesOneByOne(PACKAGES, initialSelected);
}

// ---------------------------------------------------------------------------
// Ensure Pi is present (offer to install)
// ---------------------------------------------------------------------------
async function ensurePi(flags) {
	if (hasCmd("pi")) return true;

	log.warn("Could not find the `pi` command on PATH.");
	const ok = flags.yes || flags.force || (await confirm("Install Pi now with `npm install -g @earendil-works/pi-coding-agent`?", true));
	if (!ok) {
		log.error(`Install Pi first, then re-run ${PACKAGE_COMMAND}.`);
		return false;
	}

	log.step("Installing Pi via `npm install -g @earendil-works/pi-coding-agent`");
	const code = spawnCommand("npm", ["install", "-g", "@earendil-works/pi-coding-agent"], { stdio: "inherit" }).status;
	if (code !== 0) {
		log.error("Failed to install Pi. On some systems a global npm install needs sudo:\n  sudo npm install -g @earendil-works/pi-coding-agent");
		return false;
	}

	if (!hasCmd("pi")) {
		log.error(`Installed Pi, but \`pi\` is still not on PATH. Open a new shell and re-run ${PACKAGE_COMMAND}.`);
		return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------
function installPiPackage(pkg, local = false) {
	const env = pkg.source.startsWith("git:") ? { ...process.env, npm_config_ignore_scripts: "true" } : process.env;
	return spawnCommand("pi", local ? ["install", "-l", pkg.source] : ["install", pkg.source], { stdio: "inherit", env }).status;
}

function assertNoPackageConflicts(selected, installedSources, local = false) {
	if (!selected.some((pkg) => pkg.conflicts?.length)) return;
	// Both scopes can load into the same Pi session; inspect, but never rewrite, the other scope.
	const other = readInstalledSources(!local);
	if (other.error) throw new Error(`Cannot check package conflicts in ${other.path}: invalid settings`);
	const sources = new Set([...installedSources, ...other.sources, ...selected.map((pkg) => pkg.source).filter(Boolean)]);
	for (const pkg of selected) {
		for (const conflict of pkg.conflicts ?? []) {
			if ([...sources].some((source) => source === conflict || source.startsWith(`${conflict}@`) || source === `${conflict}.git` || source.startsWith(`${conflict}.git@`))) {
				throw new Error(`${pkg.id} conflicts with ${conflict}; remove the old registration explicitly before installing its replacement`);
			}
		}
	}
}

async function cmdPresets(flags) {
	if (!flags.presets.length) throw new Error("--dry-run requires --preset");
	if (!["install", "status"].includes(flags.command)) throw new Error("--preset is supported by install and status only");
	if (flags.local || flags.force) throw new Error("--preset cannot be combined with --local or --force");
	if (flags.dryRun && flags.command !== "install") throw new Error("--dry-run is supported by install only");
	if (flags.only && flags.except) throw new Error("Preset selection cannot combine --only and --except");
	const presets = loadPresets(flags.presets, { builtinDir: repoFilePath("presets"), catalog: PACKAGES, home: homedir() });
	const required = new Set(presets.flatMap((preset) => preset.packages));
	const selectedIds = expandPackageDependencies(new Set([...required, ...(flags.only ? resolveSelection(flags) : [])]));
	if (flags.except) {
		validateSelectors(flags.except, "--except");
		for (const pkg of PACKAGES) {
			if (selectedIds.has(pkg.id) && matchesSelector(pkg, flags.except)) throw new Error(`--except conflicts with required package: ${pkg.id}`);
		}
	}
	const selected = PACKAGES.filter((pkg) => selectedIds.has(pkg.id));
	const roots = {
		agentDir: agentConfigDir(),
		webSearchDir: process.env.PI_CODING_AGENT_DIR ? agentConfigDir() : process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "pi") : join(homedir(), ".pi"),
		normalizeSettings: normalizePackageLoadOrderInSettings,
	};
	// One plan owns catalog files, user preferences and final compatibility constraints.
	const operations = selected.flatMap((pkg) => entryFileTargets(pkg).map((file) => ({
		to: file.kind === "theme" ? `agent/themes/${file.name}` : `agent/${file.name}`,
		mode: "copy", value: readFileSync(file.sourcePath, "utf8"), owner: `catalog:${pkg.id}`,
	})));
	operations.push({ to: "agent/settings.json", mode: "merge", value: {}, owner: "catalog:load-order" });
	operations.push(...presets.flatMap((preset) => preset.files));
	for (const pkg of selected) {
		for (const rule of pkg.postInstall ?? []) {
			if (!(rule.requiresSelected ?? []).every((id) => selectedIds.has(id))) continue;
			operations.push({ to: `agent/${rule.jsonMerge.path}`, mode: "merge", value: rule.jsonMerge.value, owner: `catalog:${pkg.id}`, constraint: true });
		}
	}
	const plan = planConfiguration(operations, roots);
	const installed = readInstalledSources(false);
	if (installed.error) throw new Error(`Cannot read package registrations in ${installed.path}`);
	assertNoPackageConflicts(selected, installed.sources);
	const missing = selected.filter((pkg) => pkg.source && !installed.sources.has(pkg.source));
	console.log(`Presets: ${presets.map((preset) => preset.name).join(" → ")}`);
	for (const pkg of selected) {
		const owners = presets.filter((preset) => preset.packages.includes(pkg.id)).map((preset) => preset.name);
		console.log(`  package ${pkg.id} (${owners.join(", ") || "selection/dependency"})${missing.includes(pkg) ? " — missing" : ""}`);
	}
	for (const entry of plan) {
		console.log(`  ${entry.changed ? entry.before === null ? "create" : "modify" : "unchanged"} ${entry.path}`);
		for (const [field, owner] of entry.origins) console.log(`    ${field} ← ${owner}`);
	}
	if (process.env.PI_FFF_MODE && operations.some((op) => op.to === "agent/pi-fff.json")) console.warn("PI_FFF_MODE overrides pi-fff.json; unset it to use the preset's mode.");
	if (flags.command === "status") return missing.length || plan.some((entry) => entry.changed) ? 1 : 0;
	// Local and npm registrations are distinct in Pi; do not silently load two copies.
	for (const source of installed.sources) {
		if (!source.startsWith(".") && !source.startsWith("/") && !source.startsWith("~") && !win32.isAbsolute(source)) continue;
		const directory = source.startsWith("~") ? resolveAgentConfigDir(source) : resolve(agentConfigDir(), source);
		const name = readJsonSafe(join(directory, "package.json"))?.name;
		if (name && missing.some((pkg) => pkg.source === `npm:${name}`)) throw new Error(`Local package ${name} is already registered; migrate its source explicitly before installing the npm preset requirement`);
	}
	if (flags.dryRun) {
		console.log("Dry run: no packages installed and no files written.");
		return 0;
	}
	if (missing.length && !(await ensurePi(flags))) return 127;
	for (const pkg of missing) {
		console.log(`→ pi install ${pkg.source}`);
		if (installPiPackage(pkg) !== 0) {
			console.error(`Failed to install ${pkg.id}; preset configuration was not written. Earlier package installs may have completed.`);
			return 1;
		}
	}
	const currentPlan = planConfiguration(operations, roots, plan);
	const written = applyConfiguration(currentPlan);
	for (const entry of written) console.log(`Applied ${entry.path}${entry.backup ? ` — Backup: ${entry.backup}` : ""}`);
	console.log(written.length ? `Applied ${written.length} configuration file(s). Restart Pi to load all changes.` : "Configuration unchanged; no backups created.");
	printSetupCommands(selected, false);
	return 0;
}

async function cmdInstall(flags) {
	let selectedIds = expandPackageDependencies(resolveSelection(flags));

	const usedSelectionFlag = Boolean(flags.only || flags.except);
	const interactive = !flags.yes && !flags.force && !usedSelectionFlag && isInteractive();

	if (interactive) {
		console.log(renderLogo());
		intro(bold("LazyPi"));
	}
	if (!(await ensurePi(flags))) return 127;

	let cleared = null;
	if (flags.force) {
		cleared = clearInstalledSources(flags.local);
		if (cleared.error) {
			console.error(red(`Could not back up settings before force reinstall: ${cleared.error}`));
		} else if (cleared.removed.length > 0) {
			if (interactive) log.step(`Removing ${cleared.removed.length} installed Pi extension(s)…`);
			else console.log(`\n→ Removing ${cleared.removed.length} installed Pi extension(s)…`);
		}
	}

	if (interactive) {
		const choice = await askLazyOrPick(PACKAGES.length);
		if (choice === "pick") selectedIds = expandPackageDependencies(await runPicker(selectedIds));
	}

	const selected = PACKAGES.filter((p) => selectedIds.has(p.id));
	if (selected.length === 0) {
		if (interactive) outro("Nothing selected — nothing to install.");
		else console.log(yellow("Nothing selected — nothing to install."));
		return 0;
	}

	const { sources: installedSources, error: settingsError } = readInstalledSources(flags.local);
	if (settingsError) log.warn(`Could not parse ${settingsPath(flags.local)} — ${settingsError}`);
	assertNoPackageConflicts(selected, installedSources, flags.local);
	reportLoadOrderNormalization(normalizePackageLoadOrder(flags.local), interactive);

	const toInstall = selected.filter((pkg) => flags.force || (isFileInstall(pkg) ? fileInstallNeeded(pkg) : !isPackageInstalled(pkg, installedSources)));
	const alreadyInstalled = selected.filter((pkg) => !(isFileInstall(pkg) ? fileInstallNeeded(pkg) : !isPackageInstalled(pkg, installedSources)));
	const scope = flags.local ? "project (.pi/settings.json)" : `global (${settingsPath(false)})`;
	const summary = [
		`Target:            ${scope}`,
		`Selected:          ${selected.length}/${PACKAGES.length}`,
		...(flags.force ? ["Mode:              force reinstall"] : []),
		`Already installed: ${alreadyInstalled.length}`,
		`Will install:      ${toInstall.length}`,
		`Pi credentials:    ${formatAuthSummary(detectAuth())}`,
	].join("\n");
	if (interactive) note(summary, "Plan");
	else console.log(summary);

	if (toInstall.length === 0) {
		const postInstall = runSelectedPostInstalls(selected, flags.local);
		if (!reportPostInstallResults(postInstall, interactive)) return 1;
		printCheatsheet(selected, interactive);
		printSetupCommands(selected, interactive);
		const done = "Nothing to do — every selected package is already installed.";
		if (interactive) log.success(green(done));
		else console.log(green(done));
		printNextSteps(detectAuth(), 0, interactive);
		return 0;
	}

	const failed = [];
	for (const pkg of toInstall) {
		if (isFileInstall(pkg)) {
			const action = pkg.category === "themes" ? `install theme ${pkg.id}` : `install agent file ${pkg.id}`;
			if (interactive) log.step(action);
			else console.log(`\n→ ${action}`);
			const themeResult = installAgentFiles(pkg, flags.force);
			if (!themeResult.ok) {
				failed.push(pkg);
				if (interactive) log.error(`failed to install ${pkg.id}`);
				else console.error(red(`  ✗ failed to install ${pkg.id}`));
			} else {
				reportAgentFileInstall(themeResult, interactive);
			}
			continue;
		}
		const action = `pi install ${pkg.source}`;
		if (interactive) log.step(action);
		else console.log(`\n→ ${action}`);
		const status = installPiPackage(pkg, flags.local);
		if (status !== 0) {
			failed.push(pkg);
			if (interactive) log.error(`failed to install ${pkg.id}`);
			else console.error(red(`  ✗ failed to install ${pkg.id}`));
		}
	}

	reportLoadOrderNormalization(normalizePackageLoadOrder(flags.local), interactive);
	const installedCount = toInstall.length - failed.length;
	const failedIds = new Set(failed.map((pkg) => pkg.id));
	const postInstall = runSelectedPostInstalls(selected, flags.local, failedIds);
	const postInstallOk = reportPostInstallResults(postInstall, interactive);
	const clearFailures = cleared && cleared.failed.length > 0 ? cleared.failed : [];
	if (failed.length === 0 && clearFailures.length === 0) {
		if (!postInstallOk) return 1;
		printCheatsheet(selected, interactive);
		printSetupCommands(selected, interactive);
		printNextSteps(detectAuth(), installedCount, interactive);
		return 0;
	}

	const failureList = failed.map((p) => `- ${p.id} (${isFileInstall(p) ? fileInstallLabel(p) : p.source})`).join("\n");
	const clearFailureList = clearFailures.map((s) => `- ${s}`).join("\n");
	const totalFailures = failed.length + clearFailures.length;
	if (interactive) {
		note([failureList, clearFailureList].filter(Boolean).join("\n"), "Failures");
		outro(red(`Finished with ${totalFailures} failure(s).`));
	} else {
		console.error(red(`\nLazyPi finished with ${totalFailures} failure(s):`));
		if (failureList) console.error(failureList);
		if (clearFailureList) console.error(red(`Failed to remove:\n${clearFailureList}`));
	}
	return 1;
}

function printSetupCommands(selected, interactive) {
	const lines = [];
	for (const pkg of selected) {
		for (const command of pkg.setupCommands ?? []) {
			lines.push(`${pkg.id} — add to your shell profile:`);
			lines.push(`  ${command}`);
		}
	}
	if (lines.length === 0) return;
	if (interactive) note(lines.join("\n"), "Recommended setup commands");
	else {
		printHeader("Recommended setup commands:");
		for (const line of lines) console.log(line);
	}
}

function printNextSteps(state, installedCount, interactive) {
	const lines = [];
	if (state.authed) {
		lines.push(`Pi credentials: ${formatAuthSummary(state)}`);
		lines.push("");
		lines.push("You're all set. Run `pi` to get started.");
	} else {
		lines.push("Pi credentials: none detected.");
		lines.push("");
		lines.push("Run `pi`, then type `/login` inside Pi to sign in, or set a provider API key.");
	}

	const title = installedCount > 0 ? `Installed ${installedCount} catalog item(s) — next steps` : "Next steps";
	const body = lines.join("\n");
	if (interactive) {
		note(body, title);
		outro(green("Done."));
	} else {
		printHeader(title + ":");
		console.log(body);
	}
}

function printCheatsheet(selected, interactive) {
	if (selected.length === 0) return;
	const lines = selected.map((p) => `${p.id.padEnd(20)} ${p.hint}`);
	if (interactive) note(lines.join("\n"), "What you've got");
	else {
		printHeader("What you've got:");
		for (const line of lines) console.log(`  ${line}`);
		console.log(dim("\nRemove catalog items with `lazypi remove <id>`."));
	}
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------
function cmdStatus(flags) {
	const { sources, path, exists, error } = readInstalledSources(flags.local);
	console.log(`Settings file: ${bold(path)}`);
	if (!exists) {
		console.log(yellow("  (not found — Pi has not written settings yet)"));
	} else if (error) {
		console.error(red(`  could not parse: ${error}`));
		return 1;
	}

	const catalogSources = new Set(PACKAGES.map((p) => p.source));
	const installed = PACKAGES.filter((pkg) => isPackageInstalled(pkg, sources));
	const missing = PACKAGES.filter((pkg) => !isPackagePresent(pkg, sources));
	const others = [...sources].filter((src) => !catalogSources.has(src));

	printHeader(`Installed from LazyPi catalog (${installed.length}/${PACKAGES.length}):`);
	if (installed.length === 0) console.log(dim("  none"));
	for (const pkg of installed) console.log(`  ${green("✓")} [${pkg.category}] ${pkg.id.padEnd(20)} ${dim(isFileInstall(pkg) ? fileInstallLabel(pkg) : pkg.source)}`);

	printHeader(`Missing from LazyPi catalog (${missing.length}):`);
	if (missing.length === 0) console.log(dim("  none — full catalog is installed"));
	for (const pkg of missing) console.log(`  ${dim("·")} [${pkg.category}] ${pkg.id.padEnd(20)} ${dim(isFileInstall(pkg) ? fileInstallLabel(pkg) : pkg.source)}`);

	printHeader(`Other Pi extensions outside the LazyPi catalog (${others.length}):`);
	if (others.length === 0) console.log(dim("  none"));
	for (const src of others) console.log(`  ${cyan("·")} ${src}`);

	return 0;
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------
async function cmdUpdate(flags) {
	if (flags.only || flags.except) {
		console.error(red("`update` does not filter individual extensions; use `pi update <source>` for one extension."));
		return 2;
	}
	if (!(await ensurePi(flags))) return 127;
	reportLoadOrderNormalization(normalizePackageLoadOrder(flags.local), false);
	console.log(bold(flags.local ? "pi update --extensions" : "pi update"));
	return runPi(flags.local ? ["update", "--extensions"] : ["update"]);
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------
function cmdDoctor(flags) {
	let problems = 0;
	let warnings = 0;
	const pass = (msg) => console.log(`  ${green("✓")} ${msg}`);
	const warn = (msg, { fatal = true } = {}) => {
		console.log(`  ${yellow("!")} ${msg}`);
		if (fatal) problems++;
		else warnings++;
	};
	const fail = (msg) => {
		console.log(`  ${red("✗")} ${msg}`);
		problems++;
	};

	printHeader("Environment");
	if (meetsNodeRequirement(process.versions.node)) pass(`Node ${process.versions.node}`);
	else fail(`Node ${process.versions.node} — LazyPi requires Node ${MIN_NODE || ">= 20"}`);
	if (hasCmd("npm")) pass("npm is on PATH");
	else fail("npm is not on PATH — LazyPi can't install Pi for you");
	if (hasCmd("git")) pass("git is on PATH");
	else warn("git is not on PATH — required by Git-based extensions");

	printHeader("Pi");
	if (hasCmd("pi")) {
		pass("`pi` is on PATH");
		const v = spawnCommand("pi", ["--version"], { encoding: "utf8" });
		const vout = (v.stdout ?? "").trim() || (v.stderr ?? "").trim();
		if (vout) pass(`pi --version: ${vout}`);
		else warn("Could not read `pi --version` output");
	} else fail(`\`pi\` is not on PATH — run ${PACKAGE_COMMAND} to install it`);

	printHeader("Settings");
	const settingsState = readInstalledSources(flags.local);
	if (!settingsState.exists) warn(`${settingsState.path} does not exist yet (Pi has not been run)`);
	else if (settingsState.error) fail(`${settingsState.path} is not valid JSON — ${settingsState.error}`);
	else {
		pass(`${settingsState.path} is readable`);
		const order = packageLoadOrderStatus(flags.local);
		if (order.cycle) fail("Catalog package load-order metadata contains a cycle");
		else if (order.checked && order.ok) pass("Catalog package load order is valid");
		else if (order.checked) warn("Catalog package load order is stale — run LazyPi install to repair it", { fatal: false });
	}

	printHeader("Catalog");
	const extensionCount = PACKAGES.filter((pkg) => !isFileInstall(pkg)).length;
	const fileEntryCount = PACKAGES.length - extensionCount;
	pass(`${extensionCount} Pi extension(s) and ${fileEntryCount} file-based item(s) configured`);

	printHeader("Auth");
	const auth = detectAuth();
	for (const { provider, envVar } of auth.envProviders) pass(`env var ${envVar} → ${provider}`);
	if (auth.fileProviders.length > 0) pass(`${auth.path} → ${auth.fileProviders.join(", ")}`);
	if (!auth.authed) warn("No credentials detected — run `pi` then `/login`, or export a provider API key", { fatal: false });

	console.log("");
	if (problems === 0 && warnings === 0) {
		console.log(green("All checks passed."));
		return 0;
	}
	if (problems === 0) {
		console.log(yellow(`${warnings} warning(s) found.`));
		return 0;
	}
	console.log(yellow(`${problems} problem(s) found${warnings ? `, ${warnings} warning(s)` : ""}.`));
	return 1;
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------
async function cmdRemove(flags, targets) {
	if (targets.length === 0) {
		if (!isInteractive()) {
			console.error(red(`Usage: ${PACKAGE_COMMAND} remove <id|source> [...]`));
			return 2;
		}
		const { sources } = readInstalledSources(flags.local);
		const installedPkgs = PACKAGES.filter((p) => isPackagePresent(p, sources));
		if (installedPkgs.length === 0) {
			console.log(yellow("No catalog extensions are installed."));
			return 0;
		}
		const idWidth = Math.max(...installedPkgs.map((p) => p.id.length));
		const { multiselect } = await import("@clack/prompts");
		const picked = await multiselect({
			message: "Select extensions to remove",
			options: installedPkgs.map((p) => ({ value: p.id, label: `${p.id.padEnd(idWidth + 2)}${p.description}` })),
			required: false,
		});
		abortIfCancelled(picked);
		if (!picked.length) {
			console.log(yellow("Nothing selected."));
			return 0;
		}
		targets = picked;
	}

	let exitCode = 0;
	for (const target of targets) {
		const pkg = PACKAGES.find((p) => p.id === target);
		if (pkg && isFileInstall(pkg)) {
			const files = entryFileTargets(pkg).filter((file) => existsSync(file.targetPath));
			if (files.length === 0) {
				console.log(yellow(`${pkg.category === "themes" ? "Theme" : "Agent file"} ${pkg.id} is not installed.`));
				continue;
			}
			for (const file of files) {
				rmSync(file.targetPath);
				const kindLabel = file.kind === "theme" ? "theme" : "agent file";
				console.log(green(`Removed ${kindLabel} ${file.name}.`));
			}
			continue;
		}
		const source = pkg ? pkg.source : target;
		const piArgs = flags.local ? ["remove", "-l", source] : ["remove", source];
		const result = spawnCommand("pi", piArgs, { stdio: "inherit" });
		if (result.status !== 0) {
			console.error(red(`Failed to remove ${target}`));
			exitCode = 1;
		}
	}
	return exitCode;
}


// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
	const flags = parseArgs(argv.slice(2));
	if (flags.help) {
		printHelp();
		return 0;
	}
	if (flags.version) {
		console.log(packageVersion());
		return 0;
	}
	if (flags.presets.length || flags.dryRun) return cmdPresets(flags);
	switch (flags.command) {
		case "install":
			return cmdInstall(flags);
		case "status":
			return cmdStatus(flags);
		case "update":
			return cmdUpdate(flags);
		case "doctor":
			return cmdDoctor(flags);
		case "remove":
			return cmdRemove(flags, flags.targets);
		default:
			printHelp();
			return 2;
	}
}

export function resolveEntrypointUrl(scriptPath) {
	if (!scriptPath) return null;
	try {
		return pathToFileURL(realpathSync(scriptPath)).href;
	} catch {
		return pathToFileURL(resolve(scriptPath)).href;
	}
}

const entrypoint = resolveEntrypointUrl(argv[1]);

if (entrypoint === import.meta.url) {
	main().then((code) => exit(code ?? 0)).catch((err) => {
		stderr.write(`${err?.stack || err}\n`);
		exit(1);
	});
}
