# AGENTS.md

## Project overview

LazyPi is a reusable Pi extension-manager template. It provides a catalog of Pi extensions and a Node CLI that installs, updates, checks, and removes them.

Customize the template in two places:

1. Change `name` in `package.json` to the package you will publish.
2. Replace `PACKAGES` in `bin/lazypi.mjs` with your extension catalog.

The CLI reads the package name from `package.json`, so help and error messages do not need a second package-name edit.

## Catalog conventions
Supported categories are derived automatically from the `category` values in `PACKAGES`.
`PACKAGES` is the source of truth for the distributed extension catalog; no separate category list needs editing.

Each entry has an `id`, `category`, `description`, and `hint`. Extension entries also declare a `source` (npm or Git Pi install source); file-based entries declare `themeFiles` and/or `agentFiles` instead. Optional `dependencies`, `loadBefore`, and `postInstall` fields express catalog relationships and selected-install configuration; `setupCommands` lists recommended commands printed after install for selected packages. Keep entries ordered by category and use the repository's existing formatting.
Catalog load-order metadata is applied to existing settings without discarding unrelated packages or fields. A timestamped backup is created before a settings file is rewritten.

The extension set follows the approved 17-extension `pi list` snapshot, with local pi-ext checkouts represented by npm sources. Keep the three file-based entries separately. `conflicts` lists known incompatible legacy sources (including pinned forms); install rejects conflicts instead of silently uninstalling user packages. Tool providers must precede `lazy-tools` via `loadBefore` metadata.

Selected-package `postInstall` JSON merges run only when their required package ids are selected in the same LazyPi install invocation. They preserve unrelated configuration and create a timestamped backup before changing an existing file.

File-based catalog entries ship JSON files installed into Pi's agent directory: `themes` entries copy from `themes/` into the agent themes directory; `config` entries with `agentFiles` (for example `agent/AGENTS.md`) copy to the agent root. An existing file is backed up with a timestamped `.lazypi.<timestamp>.bak` before being overwritten; identical files are skipped unless `--force` is used. These installs never modify settings such as `settings.theme`.

## Configuration presets

Opt-in presets live under `presets/{base,ui,workflow}/`; each `preset.json` declares catalog package ids and explicit configuration files. `lib/presets.mjs` loads and validates manifests, combines ordered preferences with catalog files/compatibility rules, and plans/backs up writes. Keep configuration payloads in files rather than adding personal preferences to `PACKAGES.postInstall`.

Repeated `--preset <name|manifest-path>` applies later values over earlier ones. With presets, only their requirements plus additional `--only` selections are installed; `--except` cannot exclude requirements. `--local` and `--force` are rejected. `install --dry-run` requires presets and must perform no writes or installs; `status --preset` reuses the same plan and returns nonzero for drift/missing packages.

Presets support object `merge`, whole-file `copy`, and `merge-models` exclusively for the canonical `agent/models.json` target. Model providers merge by name, model entries by exact id; preserve unrelated models, fields and credentials, reject duplicate ids/invalid collection shapes, and track drift/concurrency by id rather than array position. Only model mode accepts Pi-style line comments/trailing commas; no credential commands or environment interpolation are executed by LazyPi. Ordinary arrays replace by value and must remain idempotent. Resource/trust/runtime fields in settings are protected; auth, trust, state and executable files are not preset targets. Preserve package filter objects. Paths are confined and symlinks/casing aliases must not bypass protection. Use the Web Access target resolver instead of `../` paths.

Preset install tests must isolate HOME and `PI_CODING_AGENT_DIR`. The packed smoke must execute actual preset application from the npm artifact. Never copy private presets, secrets or backups into published directories.

Do not read or copy the maintainer's `models.json` to build catalog presets. No built-in CPA/model preset is shipped; generic model-merge tests use synthetic fixtures only.

## Settings boundaries

Global Pi settings are read from `~/.pi/agent/settings.json`, or from `PI_CODING_AGENT_DIR` when set. `--local` uses `.pi/settings.json` in the current working directory.

Do not replace a user's settings file wholesale. Preserve unrelated package entries and settings fields. Keep global and local paths independent.

## CLI commands

- `install` installs the selected catalog extensions, syncs file-based entries (themes and agent config files), and repairs declared package order.
- `install --force` removes every installed Pi extension (backing up `settings.json` first), then reinstalls the selected catalog packages and resyncs file-based entries with a backup before overwrite.
- `status` reports installed, missing, and extra Pi extensions.
- `update` delegates to Pi's overall update command; it does not select one extension.
- `doctor` checks Node, npm, git, Pi, settings, catalog order, and auth.
- `remove` removes a catalog id or raw Pi source.

Use `pi update <source>` when updating one extension directly.

`--force` also skips the interactive picker, so `npx @moguw/lazypi --force` removes all installed extensions (backed up first) and reinstalls the full catalog. Combine it with `--only` or `--except` to limit the selection.

## Testing

Run the local suite with:

```bash
npm ci
npm test
node scripts/packed-cli-smoke.mjs
```

The packed smoke test must continue to execute the published-style npm artifact, not only the source file.

## Git guidance

Use Conventional Commits, for example:

- `feat: add extension to catalog`
- `fix: preserve custom Pi settings`
- `docs: update CLI usage`
