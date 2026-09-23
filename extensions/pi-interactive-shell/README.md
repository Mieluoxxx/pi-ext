# @moguw/pi-interactive-shell

Run interactive CLIs inside observable [Pi](https://pi.dev) TUI overlays. Pi can drive the subprocess while you watch, and you can take control whenever needed.

## Requirements

- Node.js 22.19 or newer
- Pi 0.86.0 or newer (including pi-ai's optional-null normalization)
- Pi interactive TUI mode for overlays
- `zigpty` support for the current platform

## Install

```bash
pi install npm:@moguw/pi-interactive-shell
```

Install this workspace package directly during local development:

```bash
pi install /path/to/pi-ext/extensions/pi-interactive-shell
```

Run `/reload` after changing the installed package.

## Usage

Ask Pi to open or supervise a CLI, or use the slash commands directly:

```text
/spawn [agent]                              open an agent in an interactive overlay
/spawn codex "review the diffs" --dispatch  run a delegated task and report completion
/spawn cursor                               open Cursor in an interactive overlay
/spawn claude "review the diffs" --dispatch run a delegated Claude task
/attach [session-id]                        reattach a background session
/dismiss [session-id]                       dismiss one session, or choose from a list
```

`/spawn` supports `pi`, `codex`, `cursor`, `claude`, configured custom agents, Pi session forks, and isolated Git worktrees. Add `--worktree` to run the spawned agent in a separate worktree.

### Modes

| Mode | Use it for | Completion behavior |
| --- | --- | --- |
| `interactive` | Editors, REPLs, SSH, and manual CLI flows | Opens an overlay and returns a controllable `sessionId` |
| `hands-free` | Builds and long-running tasks that need progress updates | Opens an overlay and emits quiet or interval updates |
| `dispatch` | Fire-and-forget delegated work | Reports completion without polling |
| `monitor` | Logs, tests, polling, and file watchers | Wakes Pi only when a trigger matches |

Dispatch defaults `autoExitOnQuiet: true` — the session gets a 15s startup grace period before closing after output becomes quiet. The completion notification identifies this as a quiet auto-close, not a user kill.

### Start A Session

Choose an explicit `action`. For `start`, supply `command` or `spawn`, never both. Omit unused fields; strict structured calls may use `null` instead. Empty strings, zeroes, and `false` are values, not absence.

```typescript
interactive_shell({ action: "start", command: "vim package.json" })

interactive_shell({
  action: "start",
  spawn: { agent: "pi", prompt: "Review the current changes" },
  mode: "dispatch",
})

interactive_shell({
  action: "start",
  spawn: { agent: "cursor", prompt: "Review the diffs" },
  mode: "dispatch",
})

interactive_shell({
  action: "start",
  spawn: { agent: "claude", prompt: "Review the diffs" },
  mode: "hands-free",
})
```

Raw `command` is suitable for arbitrary CLIs. Structured `spawn` applies the configured agent command, default arguments, prompt format, and worktree behavior.

### Control A Session

Use the returned `sessionId` for every follow-up operation:

```typescript
interactive_shell({ action: "query", sessionId: "calm-reef" })
interactive_shell({ action: "send", sessionId: "calm-reef", input: "/compact", submit: true })
interactive_shell({ action: "send", sessionId: "calm-reef", inputKeys: ["ctrl+c"] })
interactive_shell({ action: "configure", sessionId: "calm-reef", settings: { quietThreshold: 8000 } })
interactive_shell({ action: "background", sessionId: "calm-reef" })
interactive_shell({ action: "kill", sessionId: "calm-reef" })
```

For editor-based TUIs, raw `input` only types text. It does not submit the prompt. Add `submit: true` or `inputKeys: ["enter"]` to submit it.

Background sessions can be listed, reattached, or dismissed:

```typescript
interactive_shell({ action: "list" })
interactive_shell({ action: "attach", sessionId: "calm-reef", mode: "hands-free" })
interactive_shell({ action: "dismiss", sessionId: "calm-reef" })
```

### Monitor A Process

Match output from a long-running command:

Each trigger has one `kind` (`literal`, `regex`, or `numeric`) and a non-empty `pattern`.
Only `numeric` accepts and requires `threshold`, with `captureGroup >= 1`.
Omit unused options, or use `null` under strict sampling; do not invent placeholders.
Validation finishes before any process or worktree is created. Correct invalid parameters before retrying.

```typescript
interactive_shell({
  action: "start",
  command: "pnpm test -- --watch",
  mode: "monitor",
  monitor: {
    strategy: "stream",
    triggers: [{ id: "failed", kind: "literal", pattern: "FAIL" }],
  },
})
```

Watch files without starting a command:

```typescript
interactive_shell({
  action: "start",
  mode: "monitor",
  monitor: {
    strategy: "file-watch",
    fileWatch: {
      path: "./uploads",
      recursive: true,
      events: ["rename", "change"],
    },
    triggers: [{ id: "pdf", kind: "regex", pattern: "/\\.pdf$/i" }],
  },
})
```

Query monitor state and events with the monitor session id:

```typescript
interactive_shell({ action: "monitor_status", sessionId: "calm-reef" })
interactive_shell({ action: "monitor_events", sessionId: "calm-reef" })
```

For polling, use `strategy: "poll-diff"` with `command` and optional `poll: { intervalMs: 5000 }`; do not include `fileWatch`. For numeric comparisons:

```typescript
interactive_shell({
  action: "start", command: "tail -f prices.log", mode: "monitor",
  monitor: { triggers: [{ id: "price", kind: "numeric", pattern: "/price=(\\d+)/", threshold: { captureGroup: 1, op: "gte", value: 0 } }] }
})
```

### Compatibility and errors

- Unambiguous pre-action calls are migrated by `prepareArguments`, including old `literal`/`regex` matchers. Conflicting selectors, two non-empty matchers, and dummy numeric comparisons are rejected rather than guessed away. The public schema exposes only the new contract.
- Strict-capable providers use Pi's preferred JSON-schema constrained sampling. Unused fields become nullable and Pi normalizes their `null` values before validation.
- On Responses APIs, this extension makes omitted/null `strict` explicitly `false` only on its own function declarations, including dynamically added tools. Explicit `strict: true`, other tools, and `compat.supportsStrictMode: false` are left untouched. It does not change global provider configuration. Gateways must honor the resulting schema; verify the wire request if a gateway still fills non-null placeholders.
- Tool errors are thrown so Pi records `isError: true`. A launch failure cleans up its unretained session resources; any worktree left in place is reported. A process that started and then failed instead emits a lifecycle notification with its exit status.
- After upgrading, run `/reload` to refresh both tool schemas and Skill instructions. Existing slash commands and session IDs are unchanged.

## Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `Alt+Shift+F` | Toggle focus between overlay and main chat |
| `Alt+Shift+P` | Launch the configured default spawn agent |
| `Ctrl+G` | Return control to Pi only after taking over a monitored hands-free or dispatch session |
| `Ctrl+B` | Move the current shell session to the background |
| `Ctrl+T` | Transfer terminal output back to Pi |
| `Ctrl+Q` | Open the transfer/background/kill menu |

## Configuration

Global and project configuration files are merged, with project values taking precedence:

- Global: `~/.pi/agent/interactive-shell.json`
- Project: `.pi/interactive-shell.json`

```json
{
  "defer": false,
  "overlayAnchor": "center",
  "focusShortcut": "alt+shift+f",
  "spawn": {
    "defaultAgent": "pi",
    "shortcut": "alt+shift+p",
    "commands": { "cursor": "agent" },
    "defaultArgs": { "cursor": ["--model", "composer-2-fast"] },
    "worktree": false
  },
  "minQueryIntervalSeconds": 60,
  "handsFreeQuietThreshold": 8000,
  "autoExitGracePeriod": 15000
}
```

Set `defer` to `true` to initially expose only `enable_interactive_shell`. Calling that loader activates `interactive_shell` for the current session; reload or session replacement resets availability. See [`skills/pi-interactive-shell/SKILL.md`](./skills/pi-interactive-shell/SKILL.md) for the concise agent workflow.

## Limitations

- macOS is tested; Linux support is experimental.
- Existing-session queries are rate-limited by default.
- Terminal applications may have rendering quirks in an overlay.

## Acknowledgments

Thanks to [Nico Bailon](https://github.com/nicobailon) for creating the original [pi-interactive-shell](https://github.com/nicobailon/pi-interactive-shell) project that this package is based on.
