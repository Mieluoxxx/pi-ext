import { closeSync, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SETTINGS_RESERVED = new Set(["packages", "extensions", "skills", "prompts", "themes", "lastChangelogVersion", "trackingId", "defaultProjectTrust"]);
const RESERVED_PATHS = new Set(["auth.json", "trust.json", "models.json", "models-store.json", "sessions", "missions", "state", "cache", "fff", "npm", "git", "bin", "backups", "logs", "artifacts", "generated-images"]);

function stat(path) {
	try { return lstatSync(path); } catch (error) {
		if (error.code === "ENOENT") return null;
		throw new Error(`Cannot inspect ${path} (${error.code ?? "filesystem error"})`);
	}
}

function checkJson(value) {
	if (value === null || typeof value !== "object") return;
	for (const [key, child] of Object.entries(value)) {
		if (UNSAFE_KEYS.has(key)) throw new Error("Unsafe JSON property is not allowed");
		checkJson(child);
	}
}

function parseObject(text, label, models = false) {
	let value;
	// Match Pi's models.json parser: line comments and trailing commas, not full JSON5.
	const input = models ? text
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => match[0] === '"' ? match : "")
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail) => tail ?? match) : text;
	try { value = JSON.parse(input.replace(/^\uFEFF/, "")); } catch {
		// JSON.parse errors can quote private configuration; never forward them.
		throw new Error(`Invalid JSON in ${label}`);
	}
	if (!isObject(value)) throw new Error(`JSON root must be an object in ${label}`);
	checkJson(value);
	return value;
}

function readText(path) {
	if (!stat(path)?.isFile()) throw new Error(`Expected a regular file: ${path}`);
	try { return readFileSync(path, "utf8"); } catch (error) {
		throw new Error(`Cannot read ${path} (${error.code ?? "filesystem error"})`);
	}
}

function relativeParts(path) {
	if (typeof path !== "string" || !path || /[\\:~*?"<>|\x00-\x1f]/.test(path)) throw new Error("Expected a safe relative configuration path");
	const parts = path.split("/");
	if (parts.some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part))) throw new Error(`Unsafe relative path: ${path}`);
	return parts;
}

// Resolve existing ancestors too: an agent directory need not exist during preview.
function canonicalRoot(root) {
	const path = resolve(root);
	const info = stat(path);
	if (!info) return join(canonicalRoot(dirname(path)), basename(path));
	const real = realpathSync(path);
	if (!stat(real)?.isDirectory()) throw new Error(`Expected a directory: ${path}`);
	return real;
}

function safePath(root, relative) {
	let path = canonicalRoot(root);
	const parts = relativeParts(relative);
	for (const [index, part] of parts.entries()) {
		path = join(path, part);
		const info = stat(path);
		if (info?.isSymbolicLink()) throw new Error(`Configuration symlinks are not supported: ${path}`);
		if (info && index < parts.length - 1 && !info.isDirectory()) throw new Error(`Expected a directory: ${path}`);
	}
	return path;
}

function validateTarget(to, mode) {
	if (!["merge", "merge-models", "copy"].includes(mode)) throw new Error("Supported preset modes: merge, merge-models, copy");
	if (to === "agent/models.json") {
		if (mode !== "merge-models") throw new Error("models.json requires merge-models mode");
		return;
	}
	if (mode === "merge-models") throw new Error("merge-models requires the canonical target agent/models.json");
	if (to === "web-search") {
		if (mode !== "merge") throw new Error("web-search requires merge mode");
		return;
	}
	if (typeof to !== "string" || !to.startsWith("agent/")) throw new Error("Target must start with agent/ or be web-search");
	const relative = to.slice(6);
	const parts = relativeParts(relative);
	if (relative.toLowerCase() === "settings.json" && relative !== "settings.json") throw new Error("Use the canonical target agent/settings.json");
	if (parts.some((part) => RESERVED_PATHS.has(part.toLowerCase()) || part.startsWith(".") || /\.bak|\.lazypi\./i.test(part))) {
		throw new Error(`Reserved configuration target: ${to}`);
	}
	if (![".json", ".md", ".yml", ".yaml"].includes(extname(relative))) throw new Error(`Unsupported configuration file type: ${to}`);
	if (mode === "merge" && extname(relative) !== ".json") throw new Error(`Merge requires a JSON target: ${to}`);
	if (relative === "settings.json" && mode !== "merge") throw new Error("settings.json requires merge mode");
}

function knownFields(value, allowed, label) {
	if (!isObject(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`Invalid fields in ${label}`);
}

export function loadPresets(refs, { builtinDir, catalog, cwd = process.cwd(), home }) {
	const presets = [];
	const seen = new Set();
	for (const ref of refs) {
		const builtin = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(ref);
		const input = builtin ? join(builtinDir, ref, "preset.json") : resolve(cwd, ref.startsWith("~/") ? join(home, ref.slice(2)) : ref);
		const path = safePath(dirname(input), basename(input));
		if (seen.has(path)) throw new Error(`Duplicate preset: ${ref}`);
		seen.add(path);
		const manifest = parseObject(readText(path), path);
		knownFields(manifest, ["version", "description", "packages", "files"], path);
		if (manifest.version !== 1 || (manifest.description !== undefined && typeof manifest.description !== "string") || !Array.isArray(manifest.files)) throw new Error(`Invalid preset manifest: ${path}`);
		const packages = manifest.packages ?? [];
		if (!Array.isArray(packages) || packages.some((id) => typeof id !== "string" || !catalog.some((pkg) => pkg.id === id))) throw new Error(`Unknown package id or invalid packages in ${path}`);
		const files = manifest.files.map((file) => {
			knownFields(file, ["from", "to", "mode"], path);
			validateTarget(file.to, file.mode);
			const source = safePath(dirname(path), file.from);
			const text = readText(source);
			const value = file.mode !== "copy" ? parseObject(text, source, file.mode === "merge-models") : text;
			if (file.mode === "merge-models") validateModels(value, source);
			if (file.mode === "copy" && extname(file.to) === ".json") parseObject(text, source);
			if (file.to === "agent/settings.json" && Object.keys(value).some((key) => SETTINGS_RESERVED.has(key))) throw new Error(`Preset cannot manage resource registrations, trust or runtime settings: ${source}`);
			return { to: file.to, mode: file.mode, value, owner: ref };
		});
		presets.push({ name: ref, packages, files });
	}
	return presets;
}

export function mergeJsonObjects(target, source) {
	checkJson(source);
	let changed = false;
	for (const [key, value] of Object.entries(source)) {
		if (isObject(value)) {
			if (!isObject(target[key])) { target[key] = {}; changed = true; }
			if (mergeJsonObjects(target[key], value)) changed = true;
		} else if (!isDeepStrictEqual(target[key], value)) {
			target[key] = structuredClone(value);
			changed = true;
		}
	}
	return changed;
}

function validateModels(value, label) {
	knownFields(value, ["providers"], label);
	checkJson(value);
	if (value.providers === undefined) return;
	if (!isObject(value.providers)) throw new Error(`providers must be an object in ${label}`);
	for (const [name, provider] of Object.entries(value.providers)) {
		if (!name.trim() || !isObject(provider)) throw new Error(`Invalid provider object in ${label}`);
		for (const field of ["baseUrl", "api", "apiKey"]) {
			if (provider[field] !== undefined && (typeof provider[field] !== "string" || !provider[field].trim())) throw new Error(`Invalid provider ${field} in ${label}`);
		}
		for (const field of ["compat", "headers", "modelOverrides"]) {
			if (provider[field] !== undefined && !isObject(provider[field])) throw new Error(`Invalid provider ${field} in ${label}`);
		}
		if (provider.models === undefined) continue;
		if (!Array.isArray(provider.models)) throw new Error(`models must be an array in ${label}`);
		const ids = new Set();
		for (const model of provider.models) {
			if (!isObject(model) || typeof model.id !== "string" || !model.id.trim() || ids.has(model.id)) throw new Error(`Model ids must be non-empty and unique within each provider in ${label}`);
			ids.add(model.id);
		}
	}
}

function mergeModels(target, source) {
	validateModels(target, "existing model configuration");
	validateModels(source, "model preset");
	if (source.providers === undefined) return;
	target.providers ??= {};
	for (const [name, patch] of Object.entries(source.providers)) {
		if (!Object.hasOwn(target.providers, name)) target.providers[name] = {};
		const provider = target.providers[name];
		const { models, ...fields } = patch;
		mergeJsonObjects(provider, fields);
		if (models === undefined) continue;
		provider.models ??= [];
		const byId = new Map(provider.models.map((model) => [model.id, model]));
		for (const model of models) {
			if (byId.has(model.id)) mergeJsonObjects(byId.get(model.id), model);
			else provider.models.push(structuredClone(model));
		}
	}
}

function managedModels(value, patch) {
	return Object.fromEntries(Object.entries(patch.providers ?? {}).map(([name, provider]) => {
		const current = Object.hasOwn(value.providers ?? {}, name) ? value.providers[name] : undefined;
		const { models, ...fields } = provider;
		const byId = new Map((current?.models ?? []).map((model) => [model.id, model]));
		return [name, {
			fields: managedFields(current, fields),
			models: models?.map((model) => ({ id: model.id, fields: managedFields(byId.get(model.id), model) })),
		}];
	}));
}

function modelOrigins(value) {
	return { providers: Object.fromEntries(Object.entries(value.providers ?? {}).map(([name, provider]) => {
		const { models, ...fields } = provider;
		return [name, { ...fields, ...(models === undefined ? {} : { models: Object.fromEntries(models.map((model) => [model.id, model])) }) }];
	})) };
}

function assertCompatible(preferences, constraint, path) {
	for (const [key, value] of Object.entries(constraint)) {
		if (!Object.hasOwn(preferences, key)) continue;
		if (isObject(value) && isObject(preferences[key])) assertCompatible(preferences[key], value, `${path}/${key}`);
		else if (!isDeepStrictEqual(preferences[key], value)) throw new Error(`Preset conflicts with catalog compatibility requirement: ${path}/${key}`);
	}
}

function managedFields(value, patch) {
	if (!isObject(patch) || !isObject(value)) return value;
	return Object.fromEntries(Object.entries(patch).map(([key, child]) => [key, managedFields(Object.hasOwn(value, key) ? value[key] : undefined, child)]));
}

function recordOrigins(origins, value, owner, prefix = "") {
	for (const [key, child] of Object.entries(value)) {
		const field = `${prefix}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
		if (isObject(child)) {
			origins.delete(field);
			if (Object.keys(child).length) recordOrigins(origins, child, owner, field);
			else if (![...origins.keys()].some((prior) => prior.startsWith(`${field}/`))) origins.set(field, owner);
		} else {
			for (const prior of origins.keys()) if (prior === field || prior.startsWith(`${field}/`)) origins.delete(prior);
			origins.set(field, owner);
		}
	}
}

function targetLocation(to, { agentDir, webSearchDir }) {
	const root = canonicalRoot(to === "web-search" ? webSearchDir : agentDir);
	const relative = to === "web-search" ? "web-search.json" : to.slice(6);
	return { root, relative, path: safePath(root, relative) };
}

function snapshot(entry) {
	if (safePath(entry.root, entry.relative) !== entry.path) throw new Error(`Configuration path changed: ${entry.path}`);
	const info = stat(entry.path);
	if (!info) return { before: null, permissions: 0o600 };
	return { before: readText(entry.path), permissions: info.mode & 0o777 };
}

export function planConfiguration(operations, roots, previous = []) {
	const grouped = new Map();
	for (const operation of operations) {
		validateTarget(operation.to, operation.mode);
		const location = targetLocation(operation.to, roots);
		const identity = location.path.toLowerCase();
		let entry = grouped.get(identity);
		if (entry && entry.path !== location.path) throw new Error(`Ambiguous target spelling: ${operation.to}; use identical casing across presets`);
		if (!entry) {
			entry = { ...location, to: operation.to, mode: operation.mode, patch: {}, layers: [], origins: new Map() };
			grouped.set(identity, entry);
		}
		if (entry.mode !== operation.mode) throw new Error(`Conflicting configuration modes: ${entry.path}`);
		if (operation.mode === "copy") {
			entry.patch = operation.value;
			entry.origins.set("/", operation.owner);
		} else {
			if (operation.constraint) assertCompatible(entry.patch, operation.value, entry.to);
			const merge = entry.mode === "merge-models" ? mergeModels : mergeJsonObjects;
			merge(entry.patch, operation.value);
			entry.layers.push(operation.value);
			recordOrigins(entry.origins, entry.mode === "merge-models" ? modelOrigins(operation.value) : operation.value, operation.owner);
		}
	}
	return [...grouped.values()].map((entry) => {
		Object.assign(entry, snapshot(entry));
		const current = entry.mode === "copy" ? entry.before : entry.before === null ? {} : parseObject(entry.before, entry.path, entry.mode === "merge-models");
		if (entry.mode === "merge-models") validateModels(current, entry.path);
		const prior = previous.find((item) => item.path === entry.path);
		const managed = entry.mode === "merge-models" ? managedModels : managedFields;
		entry.managed = entry.mode === "copy" ? current : entry.layers.map((layer) => managed(current, layer));
		if (previous.length && (!prior || !isDeepStrictEqual(prior.managed, entry.managed))) throw new Error(`Managed configuration changed during installation: ${entry.path}; retry after other writers stop`);
		if (entry.mode === "copy") {
			entry.after = entry.patch;
			entry.changed = entry.before !== entry.after;
		} else {
			const next = structuredClone(current);
			// Apply to the baseline in order: null -> object must not resurrect old keys.
			const merge = entry.mode === "merge-models" ? mergeModels : mergeJsonObjects;
			for (const layer of entry.layers) merge(next, layer);
			if (entry.to === "agent/settings.json") {
				if (next.packages !== undefined && !Array.isArray(next.packages)) throw new Error(`Invalid packages array in ${entry.path}`);
				roots.normalizeSettings?.(next);
			}
			entry.changed = !isDeepStrictEqual(current, next);
			entry.after = JSON.stringify(next, null, 2) + "\n";
		}
		return entry;
	});
}

function exclusiveWrite(path, content, permissions) {
	const fd = openSync(path, "wx", 0o600);
	try {
		writeFileSync(fd, content, "utf8");
		fchmodSync(fd, permissions);
	} finally { closeSync(fd); }
}

function assertUnchanged(entry) {
	if (!isDeepStrictEqual(snapshot(entry), { before: entry.before, permissions: entry.permissions })) throw new Error("concurrent change");
}

export function applyConfiguration(plan) {
	const changed = plan.filter((entry) => entry.changed);
	const prepared = [];
	const written = [];
	let active;
	try {
		for (const entry of plan) { active = entry; assertUnchanged(entry); }
		for (const entry of changed) {
			active = entry;
			mkdirSync(dirname(entry.path), { recursive: true });
			assertUnchanged(entry);
			const suffix = `${new Date().toISOString().replace(/[-:]/g, "")}.${randomUUID()}`;
			const item = { ...entry, backup: entry.before === null ? null : `${entry.path}.lazypi.${suffix}.bak`, temporary: `${entry.path}.lazypi.${suffix}.tmp` };
			prepared.push(item);
			if (item.backup) exclusiveWrite(item.backup, entry.before, 0o600);
			exclusiveWrite(item.temporary, entry.after, entry.permissions);
		}
		for (const item of prepared) {
			active = item;
			assertUnchanged(item);
			renameSync(item.temporary, item.path);
			written.push({ path: item.path, backup: item.backup });
		}
		return written;
	} catch (error) {
		throw new Error(`Configuration write stopped${active ? ` at ${active.path}` : ""} (${error.code ?? "concurrent change or write failure"}). Written: ${written.map((item) => item.path).join(", ") || "none"}. Backups: ${prepared.map((item) => item.backup).filter(Boolean).join(", ") || "none"}`);
	} finally {
		for (const item of prepared) rmSync(item.temporary, { force: true });
	}
}
