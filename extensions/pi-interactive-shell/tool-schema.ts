import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

export const TOOL_NAME = "interactive_shell";
export const TOOL_LABEL = "Interactive Shell";
export const ENABLE_TOOL_NAME = "enable_interactive_shell";
export const ENABLE_TOOL_LABEL = "Enable Interactive Shell";
export const ENABLE_TOOL_DESCRIPTION = "Enable interactive_shell for interactive CLIs, user-authorized coding agents, and process monitors. It becomes callable on the next turn.";
export const enableToolParameters = Type.Object({});

export const TOOL_DESCRIPTION = `Run interactive CLIs, supervise user-authorized coding agents, and monitor processes. Use bash for ordinary commands.

Choose exactly one action. Supply only its parameters; omit unused optional fields, or use null under strict structured sampling. Never invent empty strings, zeroes, false, or placeholder objects to fill the schema.
- start: command OR spawn; optional mode (interactive, hands-free, dispatch, monitor), cwd, name, reason, background, handsFree, handoffPreview, handoffSnapshot, timeout. mode=monitor requires monitor. A file-watch monitor uses fileWatch instead of command/spawn.
- query: sessionId and optional outputLines/outputMaxChars/outputOffset/drain/incremental. Read-only.
- send: sessionId and input/inputKeys/inputHex/inputPaste/submit. Raw input only types text; submit=true appends Enter. inputPaste uses bracketed paste.
- configure: sessionId and non-empty settings.
- kill: sessionId and optional output query parameters; returns final output.
- background: sessionId; dismisses the overlay without stopping the process.
- attach: sessionId and optional mode (not monitor), cwd, reason, handsFree, handoffPreview, handoffSnapshot, timeout.
- list: no other parameters.
- dismiss: sessionId OR all=true. Never dismiss unrelated sessions.
- monitor_status: sessionId.
- monitor_events: sessionId and optional monitorEventLimit/monitorEventOffset/monitorSinceEventId/monitorTriggerId.

Minimal examples:
interactive_shell({ action: "start", command: "vim package.json" })
interactive_shell({ action: "start", spawn: { agent: "pi", prompt: "Fix the bug", worktree: true }, mode: "dispatch" })
interactive_shell({ action: "query", sessionId: "shell-1" })
interactive_shell({ action: "send", sessionId: "shell-1", input: "/compact", submit: true })
interactive_shell({ action: "kill", sessionId: "shell-1" })
interactive_shell({ action: "start", command: "npm test --watch", mode: "monitor", monitor: { strategy: "stream", triggers: [{ id: "fail", kind: "literal", pattern: "FAIL" }] } })
interactive_shell({ action: "start", mode: "monitor", monitor: { strategy: "file-watch", fileWatch: { path: "./uploads" }, triggers: [{ id: "pdf", kind: "regex", pattern: "/\\.pdf$/i" }] } })

Monitor triggers have one kind and one pattern: literal (exact substring), regex (/pattern/flags or bare regex), or numeric (regex plus required threshold). Omit threshold for literal/regex; use kind=numeric for captureGroup>=1 comparisons. poll is only for poll-diff; fileWatch is only for file-watch. Do not send inactive strategy options.

interactive and hands-free return immediately with a sessionId. dispatch notifies on completion without polling; background=true runs dispatch headlessly. Dispatch defaults autoExitOnQuiet to true and reports that completion reason separately from a user kill. Use handsFree.autoExitOnQuiet=false when silence must not stop the process. Monitor mode emits events and lifecycle notifications; it does not auto-close on quiet unless requested.
Query output only when needed (default rate limit: 60s). The user can take over, background, transfer output, or return control. Stop sending input during user takeover. Clean up only sessions created for the task.

Structured spawn supports a prompt field for Pi, Codex, Claude, and Cursor using native CLI startup forms, or any custom key configured by the user. Raw command must include the CLI's startup prompt itself. reason is only a UI label. Prefer isolated worktrees for unattended agents.
Validation errors perform no operation. Correct the parameters; do not retry unchanged arguments, bypass validation by changing modes, or claim success. Launch failures may leave a worktree; follow the reported resource status.`;

const outputFields = {
	outputLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Output lines (default: 20)." })),
	outputMaxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 50000, description: "Output character limit (default: 5000)." })),
	outputOffset: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based output offset." })),
	drain: Type.Optional(Type.Boolean({ description: "Read only new raw output." })),
	incremental: Type.Optional(Type.Boolean({ description: "Advance the rendered-output cursor." })),
};

export const toolParameters = Type.Object({
	action: StringEnum(["start", "query", "send", "configure", "kill", "background", "attach", "list", "dismiss", "monitor_status", "monitor_events"] as const),
	command: Type.Optional(Type.String({ minLength: 1, description: "start only: raw CLI command; mutually exclusive with spawn." })),
	spawn: Type.Optional(Type.Object({
		agent: Type.Optional(Type.String({ minLength: 1, description: "Configured agent key; defaults to pi." })),
		mode: Type.Optional(StringEnum(["fresh", "fork"] as const)),
		worktree: Type.Optional(Type.Boolean()),
		prompt: Type.Optional(Type.String({ minLength: 1, description: "Startup prompt for the spawned CLI." })),
	}, { additionalProperties: false })),
	sessionId: Type.Optional(Type.String({ minLength: 1, description: "Target an existing session; never combine with command/spawn." })),
	all: Type.Optional(Type.Boolean({ description: "dismiss only: explicitly dismiss all background sessions instead of one sessionId." })),
	...outputFields,
	settings: Type.Optional(Type.Object({
		updateInterval: Type.Optional(Type.Integer({ minimum: 1 })),
		quietThreshold: Type.Optional(Type.Integer({ minimum: 1 })),
	}, { additionalProperties: false })),
	input: Type.Optional(Type.String({ description: "send only. This only types the text; it does not submit it." })),
	submit: Type.Optional(Type.Boolean({ description: "send only: append Enter after input; submit:true alone sends Enter." })),
	inputKeys: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "Named keys: enter, escape, ctrl+c, up, etc." })),
	inputHex: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "Raw bytes, e.g. 0x1b." })),
	inputPaste: Type.Optional(Type.String({ description: "Bracketed paste; does not execute without submit:true." })),
	cwd: Type.Optional(Type.String({ minLength: 1 })),
	name: Type.Optional(Type.String({ minLength: 1 })),
	reason: Type.Optional(Type.String({ description: "UI label, not a subprocess prompt." })),
	mode: Type.Optional(StringEnum(["interactive", "hands-free", "dispatch", "monitor"] as const)),
	monitor: Type.Optional(Type.Object({
		strategy: Type.Optional(StringEnum(["stream", "poll-diff", "file-watch"] as const)),
		triggers: Type.Array(Type.Object({
			id: Type.String({ minLength: 1 }),
			kind: StringEnum(["literal", "regex", "numeric"] as const),
			pattern: Type.String({ minLength: 1, description: "Exact substring for literal; regex source or /pattern/flags otherwise." }),
			cooldownMs: Type.Optional(Type.Integer({ minimum: 0 })),
			threshold: Type.Optional(Type.Object({
				captureGroup: Type.Integer({ minimum: 1, description: "Index of a numeric (...) capture, starting at 1." }),
				op: StringEnum(["lt", "lte", "gt", "gte"] as const),
				value: Type.Number(),
			}, { additionalProperties: false, description: "Required for numeric; omit for literal/regex. Zero is a valid comparison value." })),
		}, { additionalProperties: false }), { minItems: 1 }),
		fileWatch: Type.Optional(Type.Object({
			path: Type.String({ minLength: 1 }),
			recursive: Type.Optional(Type.Boolean()),
			events: Type.Optional(Type.Array(StringEnum(["rename", "change"] as const), { minItems: 1 })),
		}, { additionalProperties: false })),
		poll: Type.Optional(Type.Object({
			intervalMs: Type.Optional(Type.Integer({ minimum: 250, description: "Polling interval (default: 5000ms)." })),
		}, { additionalProperties: false })),
		persistence: Type.Optional(Type.Object({
			stopAfterFirstEvent: Type.Optional(Type.Boolean()),
			maxEvents: Type.Optional(Type.Integer({ minimum: 1 })),
		}, { additionalProperties: false })),
		throttle: Type.Optional(Type.Object({
			dedupeExactLine: Type.Optional(Type.Boolean()),
			cooldownMs: Type.Optional(Type.Integer({ minimum: 0 })),
		}, { additionalProperties: false })),
		detector: Type.Optional(Type.Object({
			detectorCommand: Type.String({ minLength: 1 }),
			timeoutMs: Type.Optional(Type.Integer({ minimum: 100 })),
		}, { additionalProperties: false })),
	}, { additionalProperties: false })),
	background: Type.Optional(Type.Boolean({ description: "start only: headless dispatch/monitor. To background an existing session use action=background." })),
	monitorEventLimit: Type.Optional(Type.Integer({ minimum: 1 })),
	monitorEventOffset: Type.Optional(Type.Integer({ minimum: 0 })),
	monitorSinceEventId: Type.Optional(Type.Integer({ minimum: 0 })),
	monitorTriggerId: Type.Optional(Type.String({ minLength: 1 })),
	handsFree: Type.Optional(Type.Object({
		updateMode: Type.Optional(StringEnum(["on-quiet", "interval"] as const)),
		updateInterval: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum update interval (default: 60000ms)." })),
		quietThreshold: Type.Optional(Type.Integer({ minimum: 1, description: "Quiet duration (default: 8000ms)." })),
		gracePeriod: Type.Optional(Type.Integer({ minimum: 0, description: "Startup grace (default: 15000ms)." })),
		updateMaxChars: Type.Optional(Type.Integer({ minimum: 1 })),
		maxTotalChars: Type.Optional(Type.Integer({ minimum: 1 })),
		autoExitOnQuiet: Type.Optional(Type.Boolean()),
	}, { additionalProperties: false })),
	handoffPreview: Type.Optional(Type.Object({
		enabled: Type.Optional(Type.Boolean()),
		lines: Type.Optional(Type.Integer({ minimum: 1 })),
		maxChars: Type.Optional(Type.Integer({ minimum: 1 })),
	}, { additionalProperties: false })),
	handoffSnapshot: Type.Optional(Type.Object({
		enabled: Type.Optional(Type.Boolean()),
		lines: Type.Optional(Type.Integer({ minimum: 1 })),
		maxChars: Type.Optional(Type.Integer({ minimum: 1 })),
	}, { additionalProperties: false })),
	timeout: Type.Optional(Type.Integer({ minimum: 1, description: "Stop after this many milliseconds." })),
}, { additionalProperties: false });

/** Parsed tool parameters type, derived from the schema so the two cannot drift. */
export type ToolParams = Static<typeof toolParameters>;
