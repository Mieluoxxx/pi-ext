# 🏷️ pi-session-rename — Automatic Session Naming

[![npm](https://img.shields.io/npm/v/@moguw/pi-session-rename)](https://www.npmjs.com/package/@moguw/pi-session-rename) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@moguw/pi-session-rename` is a native [Pi coding agent](https://pi.dev) extension that automatically
names Pi sessions from conversation context. An unnamed session gets a concise, specific title after a
configurable amount of conversation, and `/rename` gives you full manual control.

## ✨ Features

- Auto-renames an unnamed session after a configurable number of user-agent turns.
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
/rename                              -> "Refactor auth middleware"
/rename "Billing schema migration"   -> sets the name directly
```

## ⚙️ Configuration

`/rename settings` edits `~/.pi/agent/rename.json`.

```json
{
  "afterSteps": 3,
  "model": "",
  "thinkingLevel": "minimal"
}
```

Fields:

- `afterSteps`: user-agent turns before auto-renaming an unnamed session. `0` disables this trigger.
- `model`: naming model as `provider/model`. Empty uses the current session model.
- `thinkingLevel`: thinking level for the naming request. One of `off`, `minimal`, `low`, `medium`,
  `high`, `xhigh`, `max`. `off` omits the reasoning option.

The previous `~/.pi/agent/pi-session.json` path is not read or migrated.

## 🧠 Behavior

- Naming uses the configured model, or the current session model when `model` is empty, through `pi-ai`.
- Naming instructions and the tagged output contract are built in and are not user-configurable.
- The request reuses the session transport, websocket connect timeout, session id, and configured naming thinking level.
- Naming requests have a 60-second timeout and do not set an output-token limit.
- The model must return `<session_name>...</session_name>` with fewer than 20 words.
- Only text response blocks are parsed; thinking blocks are ignored.
- Automatic naming only sets a name when the session has none and never overwrites a manually set name.
- Manual renames (`/rename` and `/rename "<name>"`) rename the current Herdr tab unconditionally.
- Automatic renames and session startup/resume only rename Herdr tabs that still have their default label (empty or the tab number), never a custom Herdr label.
- Herdr sync is best-effort: when Herdr is unavailable or a command fails, session renaming still succeeds.

## 🔧 Development

```bash
npm install
npm run typecheck
npm test
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
