import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** A pane returned by Herdr CLI JSON output. */
export interface HerdrPane {
	readonly pane_id: string;
}

/** A tab returned by `herdr tab create`. */
export interface HerdrTab {
	readonly tab_id: string;
	/** Root pane of the new tab; the forked Pi runs here. */
	readonly root_pane_id: string;
}

export type SplitDirection = "right" | "down";

export interface SplitPaneOptions {
	/** Parent pane id. Defaults to the focused pane when omitted. */
	readonly parentPaneId?: string;
	readonly direction: SplitDirection;
	readonly cwd: string;
	readonly focus?: boolean;
	/** Extra environment variables for the launched process. */
	readonly env?: Record<string, string>;
}

export interface CreateTabOptions {
	readonly workspaceId: string;
	readonly cwd: string;
	readonly label?: string;
	readonly focus?: boolean;
}

export interface HerdrCli {
	/** Execute `herdr <args>` and return parsed stdout on success. */
	run(args: string[]): Promise<{ stdout: string; stderr: string; code: number }>;
}

/** Default CLI adapter backed by the Pi extension API. */
export function createHerdrCli(pi: ExtensionAPI): HerdrCli {
	return {
		async run(args) {
			const result = await pi.exec("herdr", args);
			return { stdout: result.stdout, stderr: result.stderr, code: result.code };
		},
	};
}

/** True when the current process runs inside a Herdr pane. */
export function isHerdrAvailable(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return Boolean(env["HERDR_ENV"] === "1" && env["HERDR_PANE_ID"]?.trim());
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

/** Extracts `result.pane.pane_id` from `herdr pane split` output. */
export function extractPaneId(stdout: string): string | undefined {
	try {
		const parsed = asRecord(JSON.parse(stdout) as unknown);
		const result = asRecord(parsed?.["result"]);
		const pane = asRecord(result?.["pane"]);
		const paneId = pane?.["pane_id"];
		return typeof paneId === "string" && paneId.trim() ? paneId : undefined;
	} catch {
		return undefined;
	}
}

/** Extracts `result.tab.tab_id` and `result.root_pane.pane_id` from `herdr tab create` output. */
export function extractCreatedTab(stdout: string): HerdrTab | undefined {
	try {
		const parsed = asRecord(JSON.parse(stdout) as unknown);
		const result = asRecord(parsed?.["result"]);
		const tab = asRecord(result?.["tab"]);
		const rootPane = asRecord(result?.["root_pane"]);
		const tabId = tab?.["tab_id"];
		const paneId = rootPane?.["pane_id"];
		if (typeof tabId !== "string" || !tabId.trim()) return undefined;
		if (typeof paneId !== "string" || !paneId.trim()) return undefined;
		return { tab_id: tabId, root_pane_id: paneId };
	} catch {
		return undefined;
	}
}

/** Extracts a human-readable error message from Herdr JSON error envelopes. */
export function extractHerdrError(
	stdout: string,
	stderr: string,
	fallback: string,
): string {
	const raw = stderr.trim() || stdout.trim();
	if (!raw) return fallback;
	try {
		const parsed = asRecord(JSON.parse(raw) as unknown);
		const error = asRecord(parsed?.["error"]);
		const message = error?.["message"];
		if (typeof message === "string" && message.trim()) {
			return message.trim().slice(0, 500);
		}
	} catch {
		// not JSON; fall through to raw text
	}
	return raw.slice(0, 500);
}

/** Builds `herdr pane split` args. */
export function buildPaneSplitArgs(options: SplitPaneOptions): string[] {
	const args = [
		"pane",
		"split",
		...(options.parentPaneId ? ["--pane", options.parentPaneId] : ["--current"]),
		"--direction",
		options.direction,
		"--cwd",
		options.cwd,
	];
	for (const [key, value] of Object.entries(options.env ?? {})) {
		args.push("--env", `${key}=${value}`);
	}
	args.push(options.focus === false ? "--no-focus" : "--focus");
	return args;
}

/** Builds `herdr tab create` args. */
export function buildTabCreateArgs(options: CreateTabOptions): string[] {
	const args = ["tab", "create"];
	if (options.workspaceId) args.push("--workspace", options.workspaceId);
	if (options.cwd) args.push("--cwd", options.cwd);
	if (options.label) args.push("--label", options.label);
	args.push(options.focus === false ? "--no-focus" : "--focus");
	return args;
}

/** Shell-quotes a single value for use inside a pane-run command line. */
export function shellQuote(value: string): string {
	if (process.platform === "win32") {
		return `"${value.replace(/"/g, '\\"')}"`;
	}
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Builds the command line that starts a forked Pi in a new pane. */
export function buildForkCommand(sessionFile: string): string {
	return `pi --fork ${shellQuote(sessionFile)}`;
}

/**
 * Splits a pane off the parent pane and returns the new pane id.
 * Throws with a user-readable message on failure.
 */
export async function splitPane(
	cli: HerdrCli,
	options: SplitPaneOptions,
): Promise<HerdrPane> {
	const result = await cli.run(buildPaneSplitArgs(options));
	if (result.code !== 0) {
		throw new Error(
			extractHerdrError(result.stdout, result.stderr, "Herdr failed to split a pane"),
		);
	}
	const paneId = extractPaneId(result.stdout);
	if (!paneId) {
		throw new Error("Herdr did not return the new pane ID");
	}
	return { pane_id: paneId };
}

/** Creates a new tab and returns its id and root pane id. */
export async function createTab(
	cli: HerdrCli,
	options: CreateTabOptions,
): Promise<HerdrTab> {
	const result = await cli.run(buildTabCreateArgs(options));
	if (result.code !== 0) {
		throw new Error(
			extractHerdrError(result.stdout, result.stderr, "Herdr failed to create a tab"),
		);
	}
	const tab = extractCreatedTab(result.stdout);
	if (!tab) {
		throw new Error("Herdr did not return the new tab and root pane");
	}
	return tab;
}

/** Runs a command in a pane. Returns the process exit code. */
export async function runInPane(
	cli: HerdrCli,
	paneId: string,
	command: string,
): Promise<{ code: number; detail: string }> {
	const result = await cli.run(["pane", "run", paneId, command]);
	if (result.code !== 0) {
		return {
			code: result.code,
			detail: extractHerdrError(
				result.stdout,
				result.stderr,
				"Herdr failed to run the command",
			),
		};
	}
	return { code: 0, detail: "" };
}

/** Best-effort cleanup: closes a pane, never throws. */
export async function closePane(cli: HerdrCli, paneId: string): Promise<void> {
	try {
		await cli.run(["pane", "close", paneId]);
	} catch {
		// cleanup is best-effort
	}
}

/** Best-effort cleanup: closes a tab, never throws. */
export async function closeTab(cli: HerdrCli, tabId: string): Promise<void> {
	try {
		await cli.run(["tab", "close", tabId]);
	} catch {
		// cleanup is best-effort
	}
}
