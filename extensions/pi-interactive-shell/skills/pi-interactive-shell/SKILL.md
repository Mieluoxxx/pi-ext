---
name: pi-interactive-shell
description: Use interactive_shell to operate interactive CLIs, supervise user-authorized coding agents, or monitor long-running processes. Covers mode selection, minimal calls, session control, and cleanup. Use bash for ordinary commands.
---

# Pi Interactive Shell

## Before calling

- Use `bash` for ordinary commands; use `interactive_shell` for interactive CLIs, supervised agents, and event-driven process monitoring.
- If unavailable, call `enable_interactive_shell` first; the tool becomes callable on the next turn. After reload or session replacement, check availability again.
- Launch coding agents only with user authorization. Default to `pi` unless the user names another agent; prefer structured `spawn` with an isolated `cwd` or `worktree: true` for unattended coding.
- Choose one explicit `action`. For `start`, use `command` OR `spawn`; for existing sessions, use `sessionId`.
- Copy the smallest matching example. Omit unused fields, or use `null` under strict sampling; never invent empty strings, zeroes, `false`, or placeholder objects.

## Choose a mode

| Need | Mode | Behavior |
| --- | --- | --- |
| Drive an editor, REPL, or interactive CLI | `interactive` (default) | Opens an overlay and returns a `sessionId` immediately |
| Supervise a task with progress updates | `hands-free` | Opens an overlay; the user can take control |
| Delegate a finite task and await completion | `dispatch` | Notifies on completion; no polling needed |
| Watch a server, logs, tests, or files | `monitor` | Runs headlessly and notifies on matching events |

Dispatch defaults to quiet auto-close (8s of silence after a 15s startup grace period, configurable), not proof of task completion. Use `handsFree: { autoExitOnQuiet: false }` when silence must not terminate the process. Check the completion reason and actual result before claiming success.

## Start

```typescript
// Interactive CLI; set cwd when it differs from the current project.
interactive_shell({ action: "start", command: "vim package.json", mode: "interactive" })

// User-authorized delegation; background: true means no overlay.
interactive_shell({
  action: "start",
  spawn: { agent: "pi", prompt: "Review the current changes", worktree: true },
  mode: "dispatch",
  background: true
})
```

Use `command` for arbitrary CLIs, `spawn` for coding agents. `reason` is an optional UI label, not a subprocess prompt; pass instructions in `spawn.prompt` or the CLI command itself. Structured spawn also supports `codex`, `claude`, `cursor`, and configured agent keys.

## Monitor

```typescript
interactive_shell({
  action: "start",
  command: "npm run dev",
  mode: "monitor",
  monitor: { strategy: "stream", triggers: [{ id: "ready", kind: "literal", pattern: "Local:" }] }
})
```

- Each trigger needs an `id`, one `kind`, and a non-empty `pattern`.
- For regex matching, use `{ id: "error", kind: "regex", pattern: "/error|warn/i" }`.
- For numeric comparisons use `kind: "numeric"` with required `threshold: { captureGroup: 1, op: "gte", value: 0 }`. Omit `threshold` for literal/regex matching.
- Omit `poll`, `fileWatch`, and `detector` unless using them. For file-watch examples, read [README](../../README.md#monitor-a-process); file-watch can omit `command`. For `poll-diff` options, use the tool parameter descriptions.
- A validation error starts no monitor. Do not retry unchanged arguments or change modes just to bypass validation. Rebuild the minimal call; if the exposed schema prevents it, report the mismatch rather than inventing placeholders.

## Control the returned session

Replace `shell-1` with the actual returned ID. Do not include `command` or `spawn` in follow-up calls.

```typescript
interactive_shell({ action: "send", sessionId: "shell-1", input: "/help", submit: true })
interactive_shell({ action: "send", sessionId: "shell-1", inputKeys: ["ctrl+c"] })
interactive_shell({ action: "query", sessionId: "shell-1", outputLines: 50 })
interactive_shell({ action: "configure", sessionId: "shell-1", settings: { quietThreshold: 8000 } })
interactive_shell({ action: "background", sessionId: "shell-1" })
interactive_shell({ action: "attach", sessionId: "shell-1", mode: "hands-free" })
interactive_shell({ action: "monitor_events", sessionId: "shell-1" })
```

Raw `input` only types text; use `submit: true` or `inputKeys: ["enter"]` to submit. For multiline input, use `inputPaste`. Query output only when needed (default rate limit: 60s); dispatch/monitor notifications avoid polling. `drain: true` reads new raw output, while `incremental: true` paginates rendered output.

## Finish or hand off

- When the user takes control, stop sending input. They can return control with `Ctrl+G`; `Ctrl+B` backgrounds the overlay and `Ctrl+T` transfers output.
- Verify the task result, not merely that the session launched or became quiet.
- End temporary sessions after verification. Keep a server alive only while needed for the current task or when the user requests it.

```typescript
interactive_shell({ action: "kill", sessionId: "shell-1" })
interactive_shell({ action: "list" })
interactive_shell({ action: "dismiss", sessionId: "shell-1" })
```

Clean up only sessions created for this task; do not use `action: "dismiss", all: true` to remove unrelated sessions.

Read [README](../../README.md) only for installation, configuration, slash commands, or keyboard shortcuts. Use tool parameter descriptions for advanced options; do not populate them unless needed.
