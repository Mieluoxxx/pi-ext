// Adapted from @juicesharp/rpiv-config (MIT); see NOTICE and LICENSE.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export function configPath(name: string, file = "config.json"): string {
	const raw = process.env.XDG_CONFIG_HOME?.trim();
	const expanded = raw === "~" ? homedir() : raw?.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
	return join(expanded && isAbsolute(expanded) ? expanded : join(homedir(), ".config"), name, file);
}

export function loadJsonConfigWithLegacyFallback<T>(name: string, file = "config.json"): T {
	const configured = configPath(name, file);
	const path = existsSync(configured) ? configured : join(homedir(), ".config", name, file);
	if (!existsSync(path)) return {} as T;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as T : {} as T;
	} catch (error) {
		console.warn(`pi-advisor: invalid JSON at ${path}, using defaults — ${String(error)}`);
		return {} as T;
	}
}

export function saveJsonConfig(path: string, data: unknown): boolean {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	} catch { return false; }
	try { chmodSync(path, 0o600); } catch { /* Some filesystems cannot enforce Unix modes. */ }
	return true;
}

export interface GuidanceFields {
	promptSnippet?: string;
	promptGuidelines?: string[];
	description?: string;
}

export function validateGuidanceFields(fields: unknown): GuidanceFields {
	if (!fields || typeof fields !== "object") return {};
	const g = fields as Record<string, unknown>;
	const result: GuidanceFields = {};
	if (typeof g.promptSnippet === "string" && g.promptSnippet.length > 0) result.promptSnippet = g.promptSnippet;
	if (Array.isArray(g.promptGuidelines) && g.promptGuidelines.length > 0 &&
		g.promptGuidelines.every((s) => typeof s === "string" && s.length > 0)) result.promptGuidelines = g.promptGuidelines;
	if (typeof g.description === "string" && g.description.length > 0) result.description = g.description;
	return result;
}

export function parseModelKey(key: string): { provider: string; modelId: string } | undefined {
	const slash = key.indexOf("/");
	if (slash >= 1) return { provider: key.slice(0, slash), modelId: key.slice(slash + 1) };
	const colon = key.indexOf(":");
	if (colon >= 1) return { provider: key.slice(0, colon), modelId: key.slice(colon + 1) };
	return undefined;
}

export function modelKey(model: { provider: string; id: string }): string { return `${model.provider}/${model.id}`; }
