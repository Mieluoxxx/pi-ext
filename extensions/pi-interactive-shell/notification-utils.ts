import type { InteractiveShellResult, HandsFreeUpdate, MonitorEventPayload, MonitorSessionState, PiSettlementResult } from "./types.ts";
import type { HeadlessCompletionInfo } from "./headless-monitor.ts";
import { formatDurationMs } from "./types.ts";

const BRIEF_TAIL_LINES = 5;

export function buildDispatchNotification(
	sessionId: string,
	info: HeadlessCompletionInfo,
	duration: string,
	options: { omitClosingText?: boolean } = {},
): string {
	const parts = [buildDispatchStatusLine(sessionId, info, duration)];
	if (info.settlement) {
		// The child's own closing answer beats a terminal tail: it is what it meant to say.
		if (options.omitClosingText) {
			parts.push("\nIts closing message was already delivered to you.");
		} else if (info.settlement.text) {
			parts.push(`\nClosing message (${info.settlement.stopReason}):\n\n${info.settlement.text}`);
		} else {
			parts.push(`\nThe child left no closing message (${info.settlement.stopReason}).`);
		}
		return parts.join("");
	}
	if (info.completionOutput && info.completionOutput.totalLines > 0) {
		parts.push(` ${info.completionOutput.totalLines} lines of output.`);
	}
	appendTailBlock(parts, info.completionOutput?.lines, BRIEF_TAIL_LINES);
	parts.push(`\n\nAttach to review full output: interactive_shell({ action: "attach", sessionId: "${sessionId}" })`);
	return parts.join("");
}

export function buildResultNotification(
	sessionId: string,
	result: InteractiveShellResult,
	options: { omitClosingText?: boolean } = {},
): string {
	const parts = [buildResultStatusLine(sessionId, result)];
	if (result.settlement) {
		if (options.omitClosingText) {
			parts.push("\nIts closing message was already delivered to you.");
		} else if (result.settlement.text) {
			parts.push(`\nClosing message (${result.settlement.stopReason}):\n\n${result.settlement.text}`);
		} else {
			parts.push(`\nThe child left no closing message (${result.settlement.stopReason}).`);
		}
		return parts.join("");
	}
	if (result.completionOutput && result.completionOutput.lines.length > 0) {
		const truncNote = result.completionOutput.truncated
			? ` (truncated from ${result.completionOutput.totalLines} total lines)`
			: "";
		parts.push(`\nOutput (${result.completionOutput.lines.length} lines${truncNote}):\n\n${result.completionOutput.lines.join("\n")}`);
	}
	return parts.join("");
}

/**
 * A turn that ended early is not a finished task. The stop reason is the only
 * honest word for it, and a parent that reads "finished" will act on a partial
 * answer as if it were complete.
 */
function endingPhrase(stopReason: string): string {
	switch (stopReason) {
		case "stop": return "finished its turn";
		case "length": return "hit its output limit mid-turn";
		case "error": return "failed mid-turn";
		case "aborted": return "was interrupted mid-turn";
		case "deferred": return "deferred its turn";
		default: return `ended its turn early (${stopReason})`;
	}
}

/**
 * The runtime's own account of a spawned child finishing a turn. Deliberately
 * separate from the child's text: this states what became of the child, the
 * closing message is what the child chose to say.
 *
 * `continuable` must match the mode: only a child that is still alive can take
 * follow-up work, and promising `send` to a session that is about to stop is a
 * lie the parent will act on.
 */
export function buildSettlementNotice(
	sessionId: string,
	turn: PiSettlementResult,
	options: { continuable?: boolean } = {},
): string {
	const ending = endingPhrase(turn.stopReason);
	const headline = options.continuable === false
		? `Subagent ${sessionId} ${ending}. This dispatch session stops now that it is done;`
			+ ` read its output with interactive_shell({ action: "attach", sessionId: "${sessionId}" }) within five minutes.`
		: `Subagent ${sessionId} ${ending}. It will do no further work unless you send it more:`
			+ ` interactive_shell({ action: "send", sessionId: "${sessionId}", input: "...", submit: true })`;
	const body = turn.text.length > 0 ? `\n\nIts closing message (${turn.stopReason}):\n\n${turn.text}` : "\n\nIt left no closing message.";
	return `${headline}${body}`;
}

export function buildMonitorEventNotification(event: MonitorEventPayload): string {
	return [
		`Monitor Event (${event.sessionId}) #${event.eventId}`,
		`Time: ${event.timestamp}`,
		`Strategy: ${event.strategy}`,
		`Trigger: ${event.triggerId}`,
		`Matched: ${event.matchedText}`,
		`${event.strategy === "poll-diff" ? "Diff" : "Line"}: ${event.lineOrDiff}`,
	].join("\n");
}

export function buildMonitorLifecycleNotification(state: MonitorSessionState): string {
	const reason = state.terminalReason ?? "stopped";
	let headline: string;
	if (reason === "stream-ended") {
		headline = `Monitor ${state.sessionId} stream ended.`;
	} else if (reason === "timed-out") {
		headline = `Monitor ${state.sessionId} timed out.`;
	} else if (reason === "script-failed") {
		headline = `Monitor ${state.sessionId} script failed.`;
	} else {
		headline = `Monitor ${state.sessionId} stopped.`;
	}

	const details: string[] = [
		headline,
		`Strategy: ${state.strategy}`,
		`Events: ${state.eventCount}`,
		state.lastEventAt ? `Last event: #${state.lastEventId} at ${state.lastEventAt}` : "Last event: none",
	];

	if (state.exitCode !== undefined && state.exitCode !== null) {
		details.push(`Exit code: ${state.exitCode}`);
	}
	if (state.signal !== undefined) {
		details.push(`Signal: ${state.signal}`);
	}

	return details.join("\n");
}

export function buildHandsFreeUpdateMessage(update: HandsFreeUpdate): { content: string; details: HandsFreeUpdate } | null {
	if (update.status === "running") return null;

	const tail = update.tail.length > 0 ? `\n\n${update.tail.join("\n")}` : "";
	let statusLine: string;
	switch (update.status) {
		case "exited":
			statusLine = `Session ${update.sessionId} exited (${formatDurationMs(update.runtime)})`;
			break;
		case "settled":
			statusLine = `Session ${update.sessionId} finished its turn (${formatDurationMs(update.runtime)})`;
			break;
		case "killed":
			statusLine = `Session ${update.sessionId} killed (${formatDurationMs(update.runtime)})`;
			break;
		case "user-takeover":
			statusLine = `Session ${update.sessionId}: user took over (${formatDurationMs(update.runtime)})`;
			break;
		case "agent-resumed":
			statusLine = `Session ${update.sessionId}: agent resumed monitoring (${formatDurationMs(update.runtime)})`;
			break;
		default:
			statusLine = `Session ${update.sessionId} update (${formatDurationMs(update.runtime)})`;
	}
	return { content: statusLine + tail, details: update };
}

export function summarizeInteractiveResult(command: string, result: InteractiveShellResult, timeout?: number, reason?: string): string {
	let summary = buildInteractiveSummary(result, timeout);

	if (result.userTookOver) {
		summary += "\n\nNote: User took over control during hands-free mode.";
	}

	if (!result.transferred && result.handoffPreview?.type === "tail" && result.handoffPreview.lines.length > 0) {
		summary += `\n\nOverlay tail (${result.handoffPreview.when}, last ${result.handoffPreview.lines.length} lines):\n${result.handoffPreview.lines.join("\n")}`;
	}

	const warning = buildIdlePromptWarning(command, reason);
	if (warning) {
		summary += `\n\n${warning}`;
	}

	return summary;
}

export function buildIdlePromptWarning(command: string, reason: string | undefined): string | null {
	if (!reason) return null;

	const tasky = /\b(scan|check|review|summariz|analyz|inspect|audit|find|fix|refactor|debug|investigat|explore|enumerat|list)\b/i;
	if (!tasky.test(reason)) return null;

	const trimmed = command.trim();
	const binaries = ["pi", "claude", "codex", "gemini", "agent"] as const;
	const bin = binaries.find((candidate) => trimmed === candidate || trimmed.startsWith(`${candidate} `));
	if (!bin) return null;

	const rest = trimmed === bin ? "" : trimmed.slice(bin.length).trim();
	const hasQuotedPrompt = /["']/.test(rest);
	const hasKnownPromptFlag =
		/\b(-p|--print|--prompt|--prompt-interactive|-i|exec)\b/.test(rest) ||
		(bin === "pi" && /\b-p\b/.test(rest)) ||
		(bin === "codex" && /\bexec\b/.test(rest));

	if (hasQuotedPrompt || hasKnownPromptFlag) return null;
	if (!looksLikeIdleCommand(rest)) return null;

	const examplePrompt = reason.replace(/\s+/g, " ").trim();
	const clipped = examplePrompt.length > 120 ? `${examplePrompt.slice(0, 117)}...` : examplePrompt;
	return `Note: \`reason\` is UI-only. This command likely started the agent idle. If you intended an initial prompt, embed it in \`command\`, e.g. \`${bin} "${clipped}"\`.`;
}

function buildDispatchStatusLine(sessionId: string, info: HeadlessCompletionInfo, duration: string): string {
	if (info.timedOut) return `Session ${sessionId} timed out (${duration}).`;
	if (info.completionReason === "agent-settled") {
		return `Session ${sessionId} ${endingPhrase(info.settlement?.stopReason ?? "stop")} (${duration}).`;
	}
	if (info.completionReason === "auto-close-quiet") return `Session ${sessionId} auto-closed after quiet (${duration}). This is not a terminal command verdict.`;
	if (info.cancelled) return `Session ${sessionId} was killed (${duration}).`;
	if (info.exitCode === 0) return `Session ${sessionId} completed successfully (${duration}).`;
	return `Session ${sessionId} exited with code ${info.exitCode} (${duration}).`;
}

function buildResultStatusLine(sessionId: string, result: InteractiveShellResult): string {
	if (result.timedOut) return `Session ${sessionId} timed out.`;
	if (result.completionReason === "agent-settled") {
		return `Session ${sessionId} ${endingPhrase(result.settlement?.stopReason ?? "stop")}.`;
	}
	if (result.completionReason === "auto-close-quiet") return `Session ${sessionId} auto-closed after quiet. This is not a terminal command verdict.`;
	if (result.cancelled) return `Session ${sessionId} was killed.`;
	if (result.exitCode === 0) return `Session ${sessionId} completed successfully.`;
	return `Session ${sessionId} exited with code ${result.exitCode}.`;
}

function buildInteractiveSummary(result: InteractiveShellResult, timeout?: number): string {
	if (result.transferred) {
		const truncatedNote = result.transferred.truncated ? ` (truncated from ${result.transferred.totalLines} total lines)` : "";
		return `Session output transferred (${result.transferred.lines.length} lines${truncatedNote}):\n\n${result.transferred.lines.join("\n")}`;
	}
	if (result.backgrounded) {
		return `Session running in background (id: ${result.backgroundId}). User can reattach with /attach ${result.backgroundId}`;
	}
	if (result.cancelled) return "User killed the interactive session";
	if (result.timedOut) return `Session killed after timeout (${timeout ?? "?"}ms)`;
	const status = result.exitCode === 0 ? "successfully" : `with code ${result.exitCode}`;
	return `Session ended ${status}`;
}

function appendTailBlock(parts: string[], lines: string[] | undefined, tailLines: number): void {
	if (!lines || lines.length === 0) return;
	let end = lines.length;
	while (end > 0 && lines[end - 1].trim() === "") end--;
	const tail = lines.slice(Math.max(0, end - tailLines), end);
	if (tail.length > 0) {
		parts.push(`\n\n${tail.join("\n")}`);
	}
}

function looksLikeIdleCommand(rest: string): boolean {
	return rest.length === 0 || /^(-{1,2}[A-Za-z0-9][A-Za-z0-9-]*(?:=[^\s]+|\s+[^\s-][^\s]*)?\s*)+$/.test(rest);
}
