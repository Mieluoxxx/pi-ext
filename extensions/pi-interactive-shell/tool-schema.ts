import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

export const TOOL_NAME = "interactive_shell";
export const TOOL_LABEL = "Interactive Shell";
export const ENABLE_TOOL_NAME = "enable_interactive_shell";
export const ENABLE_TOOL_LABEL = "Enable Interactive Shell";
export const ENABLE_TOOL_DESCRIPTION = "Enable interactive_shell for interactive CLIs, user-authorized coding agents, and process monitors. It becomes callable on the next turn.";
export const enableToolParameters = Type.Object({});

export const TOOL_DESCRIPTION = `Run interactive CLIs, supervise coding agents, and watch processes. Use bash for ordinary commands.

Pass one \`action\` with only its own parameters. Omit unused fields (or send null under strict sampling); never send empty-string, zero, or false placeholders. A validation error performs no operation, so rebuild the call instead of retrying it unchanged. Clean up only the sessions this task created.

What the schema cannot show:
- start takes \`command\` XOR \`spawn\`. A monitor requires \`monitor\`; the file-watch strategy may omit \`command\`. \`background: true\` is start-only and only meaningful for dispatch and monitor.
- attach accepts a \`mode\` different from the one the session started with.
- dispatch defaults autoExitOnQuiet to true (8s of silence after a 15s startup grace period, both configurable) and hands-free defaults to false. The completion notification reports that completion reason separately from a user kill, and a quiet auto-close is not proof of task completion.
- A spawned pi child in dispatch or hands-free reports its finished turn rather than having it inferred from silence: an interactive-shell-settled message carries its closing text before any quiet timeout. Write \`spawn.prompt\` so that closing message is a self-contained result, because it is what the parent receives. hands-free keeps the child alive for \`send\`; a dispatch child stops shortly after its turn settles, leaving its output reachable only through \`attach\` for five minutes. Other agents and raw commands keep the quiet heuristic.
- Monitor event payloads arrive with the notification; query only when that payload is not enough. Output queries are rate-limited (60s by default); \`drain\` reads new raw output and \`incremental\` paginates rendered output.

Monitor triggers each have one \`kind\` and one \`pattern\`. \`threshold\` applies only to numeric, \`poll\` only to poll-diff, \`fileWatch\` only to file-watch; do not send options belonging to another strategy.

Examples:
interactive_shell({ action: "start", command: "vim package.json" })
interactive_shell({ action: "start", spawn: { agent: "pi", prompt: "Fix the bug", worktree: true }, mode: "dispatch", background: true })
interactive_shell({ action: "send", sessionId: "shell-1", input: "/compact", submit: true })
interactive_shell({ action: "start", command: "npm run dev", mode: "monitor", monitor: { triggers: [{ id: "ready", kind: "literal", pattern: "Local:" }] } })
interactive_shell({ action: "start", mode: "monitor", monitor: { strategy: "file-watch", fileWatch: { path: "./uploads" }, triggers: [{ id: "pdf", kind: "regex", pattern: "/\\.pdf$/i" }] } })

Structured spawn supports a prompt field for Pi, Codex, Claude, and Cursor, or any custom key configured by the user. A raw \`command\` must include the CLI's own startup prompt. \`reason\` is a UI label, not a subprocess prompt. Prefer worktrees for unattended agents.`;

const outputFields = {
	outputLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Output lines (default: 20)." })),
	outputMaxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 50000, description: "Output character limit (default: 5000)." })),
	outputOffset: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based output offset." })),
	drain: Type.Optional(Type.Boolean({ description: "Read only new raw output." })),
	incremental: Type.Optional(Type.Boolean({ description: "Advance the rendered-output cursor." })),
};

export const toolParameters = Type.Object({
	action: StringEnum(["start", "query", "send", "configure", "kill", "background", "attach", "list", "dismiss", "monitor_status", "monitor_events"] as const),
	command: Type.Optional(Type.String({ minLength: 1, description: "start only; exclusive with spawn." })),
	spawn: Type.Optional(Type.Object({
		agent: Type.Optional(Type.String({ minLength: 1, description: "Configured agent key; defaults to pi." })),
		mode: Type.Optional(StringEnum(["fresh", "fork"] as const)),
		worktree: Type.Optional(Type.Boolean()),
		prompt: Type.Optional(Type.String({ minLength: 1, description: "Startup prompt for the spawned CLI." })),
	}, { additionalProperties: false })),
	sessionId: Type.Optional(Type.String({ minLength: 1, description: "Existing session; never combine with command/spawn." })),
	all: Type.Optional(Type.Boolean({ description: "dismiss only: every background session instead of one." })),
	...outputFields,
	settings: Type.Optional(Type.Object({
		updateInterval: Type.Optional(Type.Integer({ minimum: 1 })),
		quietThreshold: Type.Optional(Type.Integer({ minimum: 1 })),
	}, { additionalProperties: false })),
	input: Type.Optional(Type.String({ description: "send only. This only types the text; it does not submit it." })),
	submit: Type.Optional(Type.Boolean({ description: "send only: append Enter; submit:true alone sends Enter." })),
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
	background: Type.Optional(Type.Boolean({ description: "start only: headless dispatch/monitor. For an existing session use action=background." })),
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
		autoExitOnQuiet: Type.Optional(Type.Boolean({ description: "Auto-close after quiet. Defaults to true in dispatch mode and false in hands-free mode." })),
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
