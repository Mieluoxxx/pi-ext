# 🏷️ pi-session-rename — Automatic Session Naming

[![npm](https://img.shields.io/npm/v/@moguw/pi-session-rename)](https://www.npmjs.com/package/@moguw/pi-session-rename) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@moguw/pi-session-rename` is a native [Pi coding agent](https://pi.dev) extension that automatically
names Pi sessions from conversation context. The session gets a structured `MMDD｜TYPE｜Topic` title
after the first turn and the name is refreshed periodically as the conversation evolves, while
`/rename` gives you full manual control.

## ✨ Features

- Auto-names the session after a configurable number of user-agent turns (default: the first turn).
- Refreshes the name periodically as the conversation evolves (default: every 5 turns).
- Titles follow `MMDD｜TYPE｜Topic` — session start date, a type code, and a short topic.
- `/rename` generates a name from the conversation with the configured naming model.
- `/rename "<name>"` sets a session name directly, overriding any automatic naming.
- Automatic naming never overwrites a manually set name.
- Syncs the session name to the current Herdr tab when running inside Herdr.
- Naming model and thinking level are configurable per user (`~/.pi/agent/rename.json`).

## 📦 Install

```bash
pi install npm:@moguw/pi-session-rename
```

Try without installing permanently:

```bash
pi -e npm:@moguw/pi-session-rename
```

For local development from the `pi-ext` repository root:

```bash
pi -e ./extensions/pi-session-rename
```

## 🚀 Usage

The extension auto-renames an unnamed session after a configurable amount of conversation, and
provides `/rename` for manual control.

```text
/rename                  Generate a name with the configured naming model
/rename "<name>"         Set the session name directly
/rename settings         Configure model, thinking level, and auto-rename timing
```

For example:

```text
/rename                              -> "0903｜FEA｜Auth middleware refactor"
/rename "Billing schema migration"   -> sets the name directly
```

## ⚙️ Configuration

`/rename settings` edits `~/.pi/agent/rename.json`.

```json
{
  "afterSteps": 1,
  "everySteps": 5,
  "model": "",
  "thinkingLevel": "minimal"
}
```

Fields:

- `afterSteps`: user-agent turns before the first auto-rename. `0` disables auto-renaming.
- `everySteps`: re-run auto-rename every N user-agent turns after the first. `0` names once and
  never refreshes.
- `model`: naming model as `provider/model`. Empty uses the current session model.
- `thinkingLevel`: thinking level for the naming request. One of `off`, `minimal`, `low`, `medium`,
  `high`, `xhigh`, `max`. `off` omits the reasoning option.

The previous `~/.pi/agent/pi-session.json` path is not read or migrated.

## 🧠 Behavior

- Naming uses the configured model, or the current session model when `model` is empty, through `pi-ai`.
- Auto-rename fires on the `afterSteps`-th user-agent turn (default: the first), then again every
  `everySteps` turns (default: 5) so the title tracks how the conversation evolves.
- Titles follow `MMDD｜TYPE｜Topic`: the session start date in Asia/Shanghai, a type code — one of
  `FEA` (feature), `DES` (design), `FIX` (bug fix), `OPT` (optimization), `REL` (release), `EXP`
  (exploration), `DOC` (docs), `RES` (research) — and a short topic in the user's language.
- Naming instructions and the tagged output contract are built in and are not user-configurable.
- The request reuses the session transport, websocket connect timeout, session id, and configured naming thinking level.
- Naming requests have a 60-second timeout and do not set an output-token limit.
- The model must return `<session_name>...</session_name>` with fewer than 30 words; names are
  truncated to 120 characters.
- Only text response blocks are parsed; thinking blocks are ignored.
- Automatic naming never overwrites a manually set name (`/rename "<name>"`); it only refreshes
  names it generated itself.
- Manual renames (`/rename` and `/rename "<name>"`) rename the current Herdr tab unconditionally.
- Automatic renames and session startup/resume only rename Herdr tabs that still have their default label (empty or the tab number), never a custom Herdr label.
- Herdr sync is best-effort: when Herdr is unavailable or a command fails, session renaming still succeeds.

## 🔧 Development

```bash
pnpm install
pnpm run typecheck
pnpm test
```

Enable temporary naming diagnostics before starting Pi:

```bash
PI_SESSION_RENAME_DEBUG=1 pi -e ./extensions/pi-session-rename
```

The extension appends response diagnostics to `./debug.log` in Pi's working directory. The log
includes response block types, stop reason, token usage, short previews, and the reason an empty
name was rejected.

## 🗂️ Package layout

```text
src/index.ts     Pi package entrypoint
src/rename.ts    Rename command and automatic naming lifecycle
src/config.ts    Configuration loading and persistence
src/herdr.ts     Best-effort Herdr tab sync
src/settings.ts  Interactive settings UI
src/debug.ts     Opt-in response diagnostics
test/            Deterministic unit tests
```

## 🔎 Keywords

Pi extension, Pi coding agent, session naming, session rename, automatic naming, TypeScript Pi package.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
