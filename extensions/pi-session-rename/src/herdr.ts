import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface HerdrTabInfo {
	readonly id: string;
	readonly label?: string;
	readonly number?: number;
}

export type HerdrSyncResult =
	| { readonly status: "unavailable" }
	| { readonly status: "renamed" }
	| { readonly status: "failed"; readonly error: string };

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

/** Whether the current process runs inside a Herdr pane. */
export function isHerdrPaneAvailable(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return Boolean(env["HERDR_PANE_ID"]?.trim());
}

/** Extracts the tab id from `herdr pane get` output. */
export function extractTabId(stdout: string): string | undefined {
	try {
		const parsed = asRecord(JSON.parse(stdout) as unknown);
		const result = asRecord(parsed?.["result"]);
		const pane = asRecord(result?.["pane"]);
		const tabId = pane?.["tab_id"];
		return typeof tabId === "string" && tabId.trim() ? tabId : undefined;
	} catch {
		return undefined;
	}
}

/** Extracts tab id, label, and number from `herdr tab get` output. */
export function extractTabInfo(stdout: string): HerdrTabInfo | undefined {
	try {
		const parsed = asRecord(JSON.parse(stdout) as unknown);
		const result = asRecord(parsed?.["result"]);
		const tab = asRecord(result?.["tab"]);
		const tabId = tab?.["tab_id"];
		if (typeof tabId !== "string" || !tabId.trim()) return undefined;

		const label = tab?.["label"];
		const number = tab?.["number"];
		return {
			id: tabId,
			...(typeof label === "string" ? { label } : {}),
			...(typeof number === "number" ? { number } : {}),
		};
	} catch {
		return undefined;
	}
}

/** True when the tab still uses its default Herdr label (empty or the tab number). */
export function isDefaultHerdrTabLabel(tab: HerdrTabInfo): boolean {
	const label = tab.label?.trim();
	if (!label) return true;
	return typeof tab.number === "number" && label === String(tab.number);
}

async function getCurrentHerdrTabId(): Promise<string | undefined> {
	const paneId = process.env["HERDR_PANE_ID"]?.trim();
	if (!paneId) return undefined;
	try {
		const { stdout } = await execFileAsync("herdr", ["pane", "get", paneId]);
		return extractTabId(stdout);
	} catch {
		return undefined;
	}
}

async function getCurrentHerdrTabInfo(): Promise<HerdrTabInfo | undefined> {
	const tabId = await getCurrentHerdrTabId();
	if (!tabId) return undefined;
	try {
		const { stdout } = await execFileAsync("herdr", ["tab", "get", tabId]);
		return extractTabInfo(stdout);
	} catch {
		return undefined;
	}
}

/**
 * Renames the current Herdr tab unconditionally.
 * Never throws: Herdr sync is best-effort and must not break renaming.
 */
export async function renameCurrentHerdrTab(
	name: string,
): Promise<HerdrSyncResult> {
	const tabId = await getCurrentHerdrTabId();
	if (!tabId) return { status: "unavailable" };
	try {
		await execFileAsync("herdr", ["tab", "rename", tabId, name]);
		return { status: "renamed" };
	} catch (error) {
		return {
			status: "failed",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Renames the current Herdr tab only when it still has its default label,
 * so a custom Herdr label is never overwritten. Silently does nothing
 * when Herdr is unavailable or the rename fails.
 */
export async function renameCurrentHerdrTabIfDefault(name: string): Promise<void> {
	const tab = await getCurrentHerdrTabInfo();
	if (!tab || tab.label?.trim() === name || !isDefaultHerdrTabLabel(tab)) {
		return;
	}
	await renameCurrentHerdrTab(name);
}
