import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	buildForkCommand,
	closePane,
	closeTab,
	createTab,
	runInPane,
	splitPane,
	type HerdrCli,
	type SplitDirection,
} from "./herdr.js";

export interface ForkEnvironment {
	readonly mode: string;
	readonly herdrAvailable: boolean;
	readonly currentPaneId?: string;
	readonly workspaceId?: string;
	readonly sessionFile?: string;
}

/** Collects the environment facts a fork needs. Testable without a live context. */
export function collectForkEnvironment(
	ctx: Pick<ExtensionCommandContext, "mode" | "sessionManager">,
	env: NodeJS.ProcessEnv = process.env,
): ForkEnvironment {
	return {
		mode: ctx.mode,
		herdrAvailable: env["HERDR_ENV"] === "1" && Boolean(env["HERDR_PANE_ID"]?.trim()),
		currentPaneId: env["HERDR_PANE_ID"]?.trim() || undefined,
		workspaceId: env["HERDR_WORKSPACE_ID"]?.trim() || undefined,
		sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
	};
}

export type ForkPreflight =
	| { readonly ok: true; readonly environment: ForkEnvironment }
	| { readonly ok: false; readonly reason: string };

/** Validates that a fork can proceed. Returns a user-readable reason on failure. */
export function preflightFork(environment: ForkEnvironment): ForkPreflight {
	if (environment.mode !== "tui") {
		return { ok: false, reason: "/btw requires Pi interactive TUI mode." };
	}
	if (!environment.herdrAvailable) {
		return { ok: false, reason: "Pi is not running inside Herdr." };
	}
	if (!environment.currentPaneId) {
		return { ok: false, reason: "HERDR_PANE_ID is not available." };
	}
	if (!environment.sessionFile) {
		return {
			ok: false,
			reason: "The current Pi session is ephemeral and cannot be forked. Start Pi without --no-session.",
		};
	}
	return { ok: true, environment };
}

export type ForkOutcome =
	| { readonly status: "forked"; readonly paneId: string }
	| { readonly status: "failed"; readonly error: string };

/**
 * Forks the current session into a new pane split off the current pane,
 * then starts `pi --fork <session>` in it. Closes the pane on failure.
 */
export async function forkToPane(
	cli: HerdrCli,
	environment: ForkEnvironment,
	direction: SplitDirection,
	cwd: string = process.cwd(),
): Promise<ForkOutcome> {
	if (!environment.currentPaneId || !environment.sessionFile) {
		return {
			status: "failed",
			error: "Missing pane id or session file for fork.",
		};
	}

	let paneId: string;
	try {
		const pane = await splitPane(cli, {
			parentPaneId: environment.currentPaneId,
			direction,
			cwd,
		});
		paneId = pane.pane_id;
	} catch (error) {
		return {
			status: "failed",
			error: error instanceof Error ? error.message : String(error),
		};
	}

	const run = await runInPane(cli, paneId, buildForkCommand(environment.sessionFile));
	if (run.code !== 0) {
		await closePane(cli, paneId);
		return {
			status: "failed",
			error: `Created pane ${paneId}, but failed to start the forked Pi session: ${run.detail}`,
		};
	}

	return { status: "forked", paneId };
}

/**
 * Forks the current session into a new Herdr tab, then starts
 * `pi --fork <session>` in the tab's root pane. Closes the tab on failure.
 */
export async function forkToTab(
	cli: HerdrCli,
	environment: ForkEnvironment,
	label?: string,
	cwd: string = process.cwd(),
): Promise<ForkOutcome> {
	if (!environment.workspaceId || !environment.sessionFile) {
		return {
			status: "failed",
			error: "Missing workspace id or session file for tab fork.",
		};
	}

	let tab;
	try {
		tab = await createTab(cli, {
			workspaceId: environment.workspaceId,
			cwd,
			label,
		});
	} catch (error) {
		return {
			status: "failed",
			error: error instanceof Error ? error.message : String(error),
		};
	}

	const run = await runInPane(
		cli,
		tab.root_pane_id,
		buildForkCommand(environment.sessionFile),
	);
	if (run.code !== 0) {
		await closeTab(cli, tab.tab_id);
		return {
			status: "failed",
			error: `Created tab ${tab.tab_id}, but failed to start the forked Pi session: ${run.detail}`,
		};
	}

	return { status: "forked", paneId: tab.root_pane_id };
}
