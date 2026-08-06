# 🚚 pi-session-migrate — Session Migration for Moved Projects

[![npm](https://img.shields.io/npm/v/@moguw/pi-session-migrate)](https://www.npmjs.com/package/@moguw/pi-session-migrate) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@moguw/pi-session-migrate` is a native [Pi coding agent](https://pi.dev) extension that migrates a
project's Pi sessions after the project moves to a new path.

When you move a project directory, Pi still keeps that project's sessions under the old path.
`pi-session-migrate` finds those "dangling" sessions (their header `cwd` no longer exists), groups
them by old project path, and copies the group you pick into the current project — rewriting each
session's `cwd` header so Pi opens them from the new location without the missing-cwd error.

## ✨ Features

- `/migrate` scans every session under `~/.pi/agent/sessions/` and finds "dangling" sessions whose
  header `cwd` no longer exists — no need to remember the old path.
- Groups dangling sessions by old project path, so an entire project's history migrates in one step.
- **Every group is listed** with advisory markers; nothing is filtered or auto-selected:
  - `same name` — the old project's directory name matches the current project (zero-cost match).
  - `claim: …` — a configured claim model judged the group (`likely from this project` /
    `different project` / `unclear`).
- `/migrate <old-path>` migrates a specific old path explicitly (supports `~` expansion).
- Rewrites each session's header `cwd` and `parentSession`, skips sessions whose id already exists
  in the target, and keeps the source directory as a backup.
- Historical message content is copied verbatim — never rewritten.

## 📦 Install

```bash
pi install npm:@moguw/pi-session-migrate
```

Try without installing permanently:

```bash
pi -e npm:@moguw/pi-session-migrate
```

For local development from the `pi-ext` repository root:

```bash
pi -e ./extensions/pi-session-migrate
```

## 🚀 Usage

```text
/migrate                     Scan for dangling sessions and migrate the group you choose
/migrate <old-path>          Migrate sessions of a specific old project path
/migrate settings            Configure the claim model
```

### `/migrate` (scan mode)

Scans every session directory under `~/.pi/agent/sessions/`, finds sessions whose header `cwd` no
longer exists on disk, and groups them by old project path. Every group is listed:

```text
/Users/you/code/old-app   ·  9 sessions  ·  same name
/Users/you/code/old-demo  ·  3 sessions  ·  claim: likely from this project
```

Pick a group, confirm, and the sessions are copied into the current project. The source directory
is kept as a backup.

### `/migrate <old-path>` (explicit mode)

Migrate a specific old path (supports `~` expansion). Useful when the old sessions directory still
exists but the path is not dangling yet (pre-move), or when you already know the exact old path.

## ⚙️ Configuration

`/migrate settings` configures the claim model used for the `claim:` annotations:

```json
{
  "model": "",
  "thinkingLevel": "minimal"
}
```

- `model`: claim model as `provider/model`. Empty uses the current session model.
- `thinkingLevel`: thinking level for the claim request.

The model runs only for groups that do **not** have a same-name match and only when a claim model is
configured. Its verdict is advisory — you always choose.

## 🧠 Behavior

What a migration does for each copied session file (`<timestamp>_<id>.jsonl`):

1. Header `cwd` is rewritten to the current project path — without this, Pi throws a missing-cwd
   error on open.
2. `parentSession` references that pointed into the old project's session directory are rewritten
   to the new one.
3. Sessions whose id already exists in the target project are skipped and reported.
4. Message content is copied verbatim. Historical absolute paths inside messages are **not**
   rewritten.

Notes:

- The source session directory is left untouched (backup). Delete it manually once you have
  confirmed the migrated sessions work.
- Path trust (`~/.pi/agent/trust.json`) is intentionally **not** migrated — trust is a security
  decision for the current path, so confirm it yourself when Pi prompts.
- The session directory encoding mirrors Pi's internal layout (`--<encoded-cwd>--`). If the target
  directory already exists, conflict detection is per session id, never a directory overwrite.

## 🔧 Development

```bash
npm install
npm run typecheck
npm test
```

## 🗂️ Package layout

```text
src/index.ts     Pi package entrypoint
src/migrate.ts   Command parsing, claim logic, and migration flow
src/storage.ts   Storage adapter: path encoding, dangling scan, atomic header rewrite
src/config.ts    Configuration loading and persistence
src/settings.ts  Interactive settings UI
test/            Deterministic unit and integration tests
```

## 🔎 Keywords

Pi extension, Pi coding agent, session migration, project relocation, dangling sessions, session backup, TypeScript Pi package.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
