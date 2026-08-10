import { describe, expect, it, vi } from "vitest";
import {
	collectForkEnvironment,
	forkToPane,
	forkToTab,
	preflightFork,
} from "../src/fork.js";
import type { HerdrCli } from "../src/herdr.js";

function sessionManagerWith(file: string | undefined) {
	return { getSessionFile: () => file } as never;
}

describe("collectForkEnvironment", () => {
	it("collects mode, pane, workspace and session file", () => {
		const env = {
			HERDR_ENV: "1",
			HERDR_PANE_ID: "pane-7",
			HERDR_WORKSPACE_ID: "ws-7",
		} as NodeJS.ProcessEnv;
		const environment = collectForkEnvironment(
			{ mode: "tui", sessionManager: sessionManagerWith("/s/s.json") } as never,
			env,
		);
		expect(environment).toEqual({
			mode: "tui",
			herdrAvailable: true,
			currentPaneId: "pane-7",
			workspaceId: "ws-7",
			sessionFile: "/s/s.json",
		});
	});

	it("reports Herdr unavailable without pane id", () => {
		const environment = collectForkEnvironment(
			{ mode: "tui", sessionManager: sessionManagerWith("/s/s.json") } as never,
			{ HERDR_ENV: "1" } as NodeJS.ProcessEnv,
		);
		expect(environment.herdrAvailable).toBe(false);
	});
});

describe("preflightFork", () => {
	const base = {
		mode: "tui",
		herdrAvailable: true,
		currentPaneId: "pane-1",
		workspaceId: "ws-1",
		sessionFile: "/s/s.json",
	};

	it("passes when everything is in place", () => {
		const result = preflightFork(base);
		expect(result.ok).toBe(true);
	});

	it("rejects non-TUI modes", () => {
		const result = preflightFork({ ...base, mode: "print" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("interactive");
	});

	it("rejects when not inside Herdr", () => {
		const result = preflightFork({ ...base, herdrAvailable: false });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("Herdr");
	});

	it("rejects ephemeral sessions", () => {
		const result = preflightFork({ ...base, sessionFile: undefined });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("ephemeral");
	});
});

describe("forkToPane", () => {
	const environment = {
		mode: "tui",
		herdrAvailable: true,
		currentPaneId: "pane-parent",
		workspaceId: "ws-1",
		sessionFile: "/s/s.json",
	};

	it("splits a pane and runs the fork command", async () => {
		const calls: string[][] = [];
		const cli: HerdrCli = {
			run: vi.fn(async (args) => {
				calls.push(args);
				if (args[1] === "split") {
					return {
						code: 0,
						stdout: JSON.stringify({ result: { pane: { pane_id: "pane-child" } } }),
						stderr: "",
					};
				}
				return { code: 0, stdout: "", stderr: "" };
			}),
		};

		const outcome = await forkToPane(cli, environment, "right");
		expect(outcome.status).toBe("forked");
		if (outcome.status === "forked") expect(outcome.paneId).toBe("pane-child");

		expect(calls[0]?.[1]).toBe("split");
		expect(calls[0]).toContain("--pane");
		expect(calls[0]).toContain("pane-parent");
		expect(calls[1]?.[1]).toBe("run");
		expect(calls[1]?.[2]).toBe("pane-child");
		expect(calls[1]?.[3]).toContain("pi --fork");
	});

	it("closes the pane when the fork command fails", async () => {
		const calls: string[][] = [];
		const cli: HerdrCli = {
			run: vi.fn(async (args) => {
				calls.push(args);
				if (args[1] === "split") {
					return {
						code: 0,
						stdout: JSON.stringify({ result: { pane: { pane_id: "pane-child" } } }),
						stderr: "",
					};
				}
				return { code: 1, stdout: "", stderr: "nope" };
			}),
		};

		const outcome = await forkToPane(cli, environment, "right");
		expect(outcome.status).toBe("failed");
		if (outcome.status === "failed") expect(outcome.error).toContain("nope");
		expect(calls.some((args) => args[1] === "close")).toBe(true);
	});

	it("fails without closing when the split fails", async () => {
		const calls: string[][] = [];
		const cli: HerdrCli = {
			run: vi.fn(async (args) => {
				calls.push(args);
				return { code: 1, stdout: "", stderr: "split exploded" };
			}),
		};

		const outcome = await forkToPane(cli, environment, "right");
		expect(outcome.status).toBe("failed");
		if (outcome.status === "failed") expect(outcome.error).toContain("split exploded");
		expect(calls.some((args) => args[1] === "close")).toBe(false);
	});
});

describe("forkToTab", () => {
	const environment = {
		mode: "tui",
		herdrAvailable: true,
		currentPaneId: "pane-parent",
		workspaceId: "ws-1",
		sessionFile: "/s/s.json",
	};

	it("creates a tab and runs the fork in its root pane", async () => {
		const calls: string[][] = [];
		const cli: HerdrCli = {
			run: vi.fn(async (args) => {
				calls.push(args);
				if (args[0] === "tab") {
					return {
						code: 0,
						stdout: JSON.stringify({
							result: {
								tab: { tab_id: "tab-new" },
								root_pane: { pane_id: "pane-root" },
							},
						}),
						stderr: "",
					};
				}
				return { code: 0, stdout: "", stderr: "" };
			}),
		};

		const outcome = await forkToTab(cli, environment, "my fork");
		expect(outcome.status).toBe("forked");
		if (outcome.status === "forked") expect(outcome.paneId).toBe("pane-root");

		const tabCall = calls.find((args) => args[0] === "tab");
		expect(tabCall).toContain("--label");
		expect(tabCall).toContain("my fork");
		const runCall = calls.find((args) => args[1] === "run");
		expect(runCall?.[2]).toBe("pane-root");
	});

	it("closes the tab when the fork command fails", async () => {
		const calls: string[][] = [];
		const cli: HerdrCli = {
			run: vi.fn(async (args) => {
				calls.push(args);
				if (args[0] === "tab") {
					return {
						code: 0,
						stdout: JSON.stringify({
							result: {
								tab: { tab_id: "tab-new" },
								root_pane: { pane_id: "pane-root" },
							},
						}),
						stderr: "",
					};
				}
				return { code: 1, stdout: "", stderr: "run failed" };
			}),
		};

		const outcome = await forkToTab(cli, environment);
		expect(outcome.status).toBe("failed");
		if (outcome.status === "failed") expect(outcome.error).toContain("run failed");
		expect(calls.some((args) => args[0] === "tab" && args[1] === "close")).toBe(true);
	});
});
