import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { collectForkEnvironment, forkToPane, forkToTab, preflightFork } from "./fork.js";
import { createHerdrCli } from "./herdr.js";
import {
	answerOutline,
	collectQuestion,
	OUTLINE_ENTRY_TYPE,
	previewOutline,
	type OutlineEntryData,
	type OutlineResult,
} from "./outline.js";

const USAGE = [
	"Usage:",
	"  /btw                        fork the current session into a right-hand Herdr pane",
	"  /btw inline [question]      ask in this session, entering the context",
	"  /btw outline [question]     ask in this session, staying outside the context",
	"  /btw tab                    fork the current session into a new Herdr tab",
	"  /btw help                   show this help",
].join("\n");

type BtwRoute =
	| { readonly kind: "fork" }
	| { readonly kind: "fork-tab" }
	| { readonly kind: "inline"; readonly question: string }
	| { readonly kind: "outline"; readonly question: string }
	| { readonly kind: "help" };

export function parseBtwRoute(rawArgs: string): BtwRoute {
	const text = rawArgs.trim();
	if (!text || text === "fork") return { kind: "fork" };
	if (text === "tab") return { kind: "fork-tab" };
	if (text === "help" || text === "-h" || text === "--help") return { kind: "help" };

	const [first = "", ...rest] = text.split(/\s+/);
	if (first === "inline") return { kind: "inline", question: rest.join(" ").trim() };
	if (first === "outline") return { kind: "outline", question: rest.join(" ").trim() };
	return { kind: "inline", question: text };
}

function notify(
	ctx: Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1],
	message: string,
	level: "info" | "warning" | "error" = "info",
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
		return;
	}
	const stream = level === "error" ? process.stderr : process.stdout;
	stream.write(`${message}\n`);
}

export default function (pi: ExtensionAPI): void {
	const cli = createHerdrCli(pi);

	pi.registerEntryRenderer(OUTLINE_ENTRY_TYPE, (entry, { expanded }, theme) => {
		const data = entry.data as OutlineEntryData | undefined;
		if (!data) return new Text("(empty outline entry)", 0, 0);

		const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg("accent", theme.bold("outline"))));
		box.addChild(new Text(theme.fg("muted", ` ${data.question}`)));
		if (expanded) {
			box.addChild(new Text(""));
			box.addChild(new Text(data.answer));
			if (data.model) box.addChild(new Text(theme.fg("dim", `— ${data.model}`)));
		} else {
			box.addChild(new Text(theme.fg("dim", ` ${previewOutline(data)}`)));
		}
		return box;
	});

	pi.registerCommand("btw", {
		description: "Fork the session into a Herdr pane/tab, or ask inline/outline",
		handler: async (args, ctx) => {
			const route = parseBtwRoute(args);

			if (route.kind === "help") {
				notify(ctx, USAGE);
				return;
			}

			if (route.kind === "fork" || route.kind === "fork-tab") {
				const environment = collectForkEnvironment(ctx);
				const preflight = preflightFork(environment);
				if (!preflight.ok) {
					notify(ctx, preflight.reason, "error");
					return;
				}

				const outcome =
					route.kind === "fork"
						? await forkToPane(cli, preflight.environment, "right", ctx.cwd)
						: await forkToTab(cli, preflight.environment, undefined, ctx.cwd);

				if (outcome.status === "failed") {
					notify(ctx, outcome.error, "error");
					return;
				}
				notify(
					ctx,
					route.kind === "fork"
						? `Forked the current session into Herdr pane ${outcome.paneId}.`
						: `Forked the current session into a new Herdr tab (pane ${outcome.paneId}).`,
				);
				return;
			}

			if (route.kind === "inline") {
				const question = await collectQuestion(ctx, route.question, "Inline question:");
				if (!question) {
					notify(ctx, "Inline question cancelled.", "info");
					return;
				}
				if (ctx.isIdle()) {
					pi.sendUserMessage(question);
				} else {
					// The agent is streaming; sendUserMessage requires a delivery mode.
					pi.sendUserMessage(question, { deliverAs: "steer" });
				}
				return;
			}

			const question = await collectQuestion(ctx, route.question, "Outline question:");
			if (!question) {
				notify(ctx, "Outline question cancelled.", "info");
				return;
			}

			if (ctx.mode !== "tui") {
				notify(ctx, "/btw outline requires Pi interactive TUI mode.", "error");
				return;
			}

			ctx.ui.setWorkingMessage("Answering outline question…");
			let result: OutlineResult;
			try {
				result = await answerOutline(ctx, question);
			} finally {
				ctx.ui.setWorkingMessage();
			}
			if (result.status === "cancelled") {
				notify(ctx, "Outline question cancelled.", "info");
				return;
			}
			if (result.status === "failed") {
				notify(ctx, `Outline failed: ${result.error}`, "error");
				return;
			}
			pi.appendEntry(OUTLINE_ENTRY_TYPE, result.entry);
		},
	});
}
