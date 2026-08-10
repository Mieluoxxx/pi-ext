# @moguw/pi-session-fork

Fork the current [Pi](https://pi.dev) session into a [Herdr](https://herdr.dev) pane or tab, and run side questions inline (entering the context) or outline (staying outside the context).

```text
/btw                        fork the current session into a right-hand Herdr pane
/btw inline [question]      ask in this session, entering the context
/btw outline [question]     ask in this session, staying outside the context
/btw tab                    fork the current session into a new Herdr tab
/btw help                   show usage
```

## Requirements

- Pi interactive TUI mode
- Pi running inside Herdr (a pane with `HERDR_ENV=1`)
- A persisted Pi session (not `--no-session`)
- `herdr` and `pi` on `PATH`

## Install

```bash
pi install npm:@moguw/pi-session-fork
```

From this repository:

```bash
pi install /path/to/pi-ext/extensions/pi-session-fork
```

Then reload Pi (`/reload`).

## Commands

### `/btw` — fork into a right-hand pane

Splits the current Herdr pane to the right and starts `pi --fork <session>` in the new pane. The original session keeps running untouched; the fork gets its own persisted session file derived from the current state.

### `/btw tab` — fork into a new tab

Creates a new Herdr tab in the current workspace and starts `pi --fork <session>` in its root pane.

### `/btw inline [question]` — ask in-context

Submits the question as a regular user message in the current session: it appears in the transcript, enters the context, and triggers a normal agent turn. With no question argument, a dialog collects it first. Anything not matching a subcommand is treated as an inline question, so `/btw why does this fail` just works.

### `/btw outline [question]` — ask out-of-context

Answers the question with a direct model call that never touches the session context:

- The current, compaction-aware conversation is snapshotted and passed as read-only reference context.
- The answer inherits the current model and thinking level.
- The result is appended as a custom entry (`pi.appendEntry`), which renders in the transcript — collapsed to a one-line preview, expandable to the full answer — but **does not participate in LLM context** (per Pi's custom-entry semantics).
- No user or assistant messages are added to the session, and no context is consumed on subsequent turns.

## How it works

- Herdr interaction goes through the `herdr` CLI (`pane split`, `tab create`, `pane run`) with JSON-envelope parsing, following the same conventions as the other `@moguw` session packages.
- Forking uses `pi --fork <session-file>` deliberately, not Pi's `ctx.fork()`: the original pane keeps its session and its running agent.
- The outline renderer registers under the `pi-session-fork.outline` custom entry type.

## Development

```bash
npm install
npm run check
```

## License

MIT
