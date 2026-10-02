# LazyPi

LazyPi is a reusable Pi extension-manager template. One repository holds a curated `PACKAGES` catalog and an `npx` CLI that installs, audits, updates, and removes Pi extensions from that catalog.

The catalog is the only extension list you maintain. It lives in `PACKAGES` inside [`bin/lazypi.mjs`](bin/lazypi.mjs), and every CLI command — help, selection flow, install, status, doctor, remove — derives from it automatically.

Fork it, replace the catalog with your own Pi extensions, publish under your npm name, and you have a personal extension manager you can hand to any machine with `npx`.

## Use this catalog

The published package is `@moguw/lazypi`. You do not need to clone anything to use it:

```bash
npx @moguw/lazypi               # choose all or review packages one by one on a TTY
npx @moguw/lazypi --yes         # same, no prompts
npx @moguw/lazypi --force       # remove all installed extensions, then reinstall the catalog
npx @moguw/lazypi status        # installed / missing / extra extensions
npx @moguw/lazypi doctor        # check Node, npm, git, Pi, settings, catalog, auth
npx @moguw/lazypi update        # run Pi's overall extension update
npx @moguw/lazypi remove <id>   # remove a catalog extension by id
```

LazyPi installs Pi itself if it is not already on PATH, then installs the selected catalog extensions. Re-running is idempotent: extensions already present in Pi settings are skipped.

Use `--force` for a clean reinstall: LazyPi removes every installed Pi extension (backing up `settings.json` first), then installs the full catalog again. Themes and agent files are resynced with a backup before overwrite, so the final `settings.json` reflects exactly the catalog.

Select what gets installed:

```bash
npx @moguw/lazypi --only core              # only a category
npx @moguw/lazypi --only goal,advisor     # only specific extension ids
npx @moguw/lazypi --except tools           # everything but a category
npx @moguw/lazypi --local                  # install into .pi/settings.json of the current project
```

`update` does not update a single extension — for that use Pi directly: `pi update <source>`.

### Portable package sources

The extension set follows a 17-extension `pi list` snapshot, normalizing nine local [pi-ext](https://github.com/Mieluoxxx/pi-ext) checkouts to their `@moguw` npm package sources. Three existing file entries (AGENTS and the two Vesper themes) remain separate from that extension list. npm sources remain unpinned; package-name parity is not a guarantee of byte-for-byte version parity. Publish new package versions before releasing a LazyPi catalog that requires them.

| Catalog id | Category | Pi install source |
| --- | --- | --- |
| `web-access` | `core` | `npm:@moguw/pi-web-access` |
| `tool-display` | `ui` | `npm:@moguw/pi-tool-display` |
| `interactive-shell` | `tools` | `npm:@moguw/pi-interactive-shell` |
| `hashline-edit-pro` | `tools` | `npm:@moguw/pi-hashline-edit-pro` |
| `session-rename` | `herdr` | `npm:@moguw/pi-session-rename` |
| `session-migrate` | `herdr` | `npm:@moguw/pi-session-migrate` |
| `session-fork` | `herdr` | `npm:@moguw/pi-session-fork` |
| `openai-tools` | `codex` | `npm:@moguw/pi-openai-tools` |
| `lazy-tools` | `tools` | `npm:@moguw/pi-lazy-tools` |
| `computer-use` | `tools` | `npm:@injaneity/pi-computer-use` |
| `advisor` | `core` | `npm:pi-omp-advisor` |

The old `subagents`, TPS, Recap, CodeGraph extension, Simplify, Context7 and standalone `apply-patch` entries are no longer selected by this catalog; `advisor` now refers to `pi-omp-advisor`, not `@juicesharp/rpiv-advisor`. CodeGraph remains an independently installed CLI/Skill workflow, not a catalog extension.

Catalog updates do **not** migrate existing local-path registrations or uninstall removed entries. Migrate those registrations explicitly when ready; the catalog change does not alter your running Pi. Installs conservatively check global and current-project registrations for the declared old Advisor / standalone apply-patch sources (including pinned forms) when their replacements are selected; the other scope is only read, never rewritten. This is a guard for known source strings, not a detector for every local checkout, resource filter, trust decision or other project.

### Newly aligned tools

- **[OpenAI tools](https://github.com/Mieluoxxx/pi-ext/tree/main/extensions/pi-openai-tools)** combines context management, remote compaction, Astra compatibility and `apply_patch`. Image generation is disabled by default. Remove or disable standalone `pi-apply-patch` before loading this package; gateway/model support still needs separate verification.
- **[Lazy tools](https://github.com/Mieluoxxx/pi-ext/tree/main/extensions/pi-lazy-tools)** exposes `load_capability`; `/capability` enables an existing group and `/tools-status` reports its state. It ships its own Skills but does not install missing providers, copy credentials or grant permission to delegate. In this snapshot, dedicated Context7/subagent packages are not installed; their groups remain unavailable unless another host/package provides the tools. Available web, FFF, hashline, desktop and OpenAI providers load before this gate.
- **[Computer use](https://github.com/injaneity/pi-computer-use)** provides desktop inspection and interaction; `/computer-use` shows configuration. macOS requires Accessibility and Screen Recording permission, Windows an interactive desktop, and Linux a supported graphical/accessibility session. Installing a package does not grant OS permissions.
- **[OMP Advisor](https://github.com/Scott-Meyer/pi-omp-advisor)** watches the session and is controlled by `/advisor` and optional `WATCHDOG.yml`. It starts observation by default, incurs extra model usage, and sends observed context to its configured provider. Review its configuration before enabling it on another device.

LazyPi does not copy the maintainer's `models.json` and does not ship a CPA/model preset. Model configuration and credentials remain device-managed. The generic `merge-models` mode is available only for external files explicitly supplied by the user.

Web Access preferences now belong to the optional `workflow` preset, not the extension's post-install hook. Its `web-search` target follows the extension's lookup: `PI_CODING_AGENT_DIR/web-search.json`, otherwise `XDG_CONFIG_HOME/pi/web-search.json`, otherwise `~/.pi/web-search.json`. Installing the extension alone no longer changes these preferences.

## Composable configuration presets

Presets install their catalog requirements and apply configuration files in one invocation. They are opt-in: ordinary catalog installs do not apply them.

| Preset | Configuration |
| --- | --- |
| `base` | Global AGENTS.md, `xhigh` default thinking, transcript-search shortcut |
| `ui` | Zentui preferences, tool-display, Vesper theme files; selects the built-in `dark` theme |
| `workflow` | Workspace history, Goal (100 automatic turns), deferred interactive shell, FFF `tools-and-ui`, hashline editing, automatic naming, Web Search `ctrl+shift+s` |

```bash
# From this checkout, preview before applying (no installs or writes):
node bin/lazypi.mjs install --preset base --preset ui --preset workflow --dry-run
node bin/lazypi.mjs install --preset base --preset ui --preset workflow --yes

# Once using a release that includes presets:
npx @moguw/lazypi install --preset base --preset ui --preset workflow --yes
npx @moguw/lazypi status --preset base --preset ui --preset workflow
```

With `--preset`, the default package selection is the union of preset requirements, not the full catalog. `--only` adds catalog selections; `--except` cannot exclude a required package. Do not combine `--only` and `--except` in a preset invocation. Presets are global-only and reject `--local` and `--force` before any side effects. `--dry-run` requires `--preset`; `status --preset` returns 1 for drift or missing packages and 0 when aligned.

### Add your own preset

Keep private/device presets outside this repository, for example `~/.config/lazypi/laptop/`. Create a `preset.json` and its configuration fragments:

```json
{
  "version": 1,
  "description": "Laptop overrides",
  "packages": [],
  "files": [
    { "from": "settings.json", "to": "agent/settings.json", "mode": "merge" },
    { "from": "zentui.json", "to": "agent/zentui.json", "mode": "merge" }
  ]
}
```

For example, `settings.json` can contain only `{"defaultThinkingLevel":"high"}`. Source paths resolve relative to the manifest, regardless of the CLI's working directory. Only listed files are read. Package ids refer to `PACKAGES`; omit `packages` or use `[]` for a configuration-only preset.

```bash
node bin/lazypi.mjs install --preset base --preset ui \
  --preset ~/.config/lazypi/laptop/preset.json --dry-run
```

Presets apply left to right over existing configuration. Later presets override matching fields; unrelated fields remain. Use the same combination with `status` to check drift. Plans show target paths and field origins, not values. An external preset is loaded only when explicitly named; no implicit project/HOME scan or remote download occurs.

- `merge`: recursive JSON-object merge; arrays replace as a whole; `null` is a value, not deletion. Content-equal arrays do not cause repeated writes.
- `merge-models`: only for `agent/models.json`; providers merge by name and models by exact `id`, retaining unrelated providers, models and fields. Existing order is preserved and new ids append in preset order. Duplicate ids within one provider input, invalid collection shapes, and null provider/model collections fail preflight. Empty model arrays do not delete models.
- `copy`: whole-file snapshot for Markdown/YAML (or JSON); existing content is backed up, not merged. Conflicting modes or target casing aliases are rejected.
- `agent/...`: a configuration path under the resolved agent directory, with nested paths preserved. `web-search` is the dedicated extension-specific target described above.
- `settings.json` requires merge mode. Presets cannot write resource-registration arrays, trust defaults or selected runtime fields. Catalog compatibility requirements still apply; an explicit conflicting preference fails preflight.
- Built-in presets remain `base`, `ui`, `workflow`. A bundled CPA preset, credential import and Skills distribution are deferred pending catalog/distribution and routing decisions. `models.json` requires `merge-models`; ordinary merge/copy and noncanonical casing cannot bypass this rule. Auth/trust files, state, caches, installation directories, logs/backups and executable extension files remain forbidden targets.

### Custom model presets

An external preset can list `{ "from": "models.json", "to": "agent/models.json", "mode": "merge-models" }`. For example, this fragment changes one model without replacing the provider's other models or credentials:

```json
{
  "providers": {
    "your-provider": {
      "models": [
        { "id": "your-model", "contextWindow": 128000 }
      ]
    }
  }
}
```

For this mode only, both fragments and existing files accept Pi's BOM, `//` comments and trailing commas; this is not full JSON5. Changed files are written as standard JSON, with original bytes retained in a private backup. Valid unchanged files keep their existing formatting. Nested model objects merge; ordinary nested arrays still replace. `thinkingLevelMap` null values are preserved.

Model plans identify fields by provider/model id and redact values. Rebase and status checks follow selected ids rather than array positions, allowing unrelated model changes without treating them as drift. Validation checks collection structure, ids and selected provider field types; it is not a full Pi schema or live provider compatibility check. LazyPi never contacts a provider, resolves an API-key command or substitutes an environment variable while previewing/applying. Existing credentials are preserved unless explicitly changed by the fragment. Use Pi references such as `"apiKey": "$CPA_API_KEY"` in portable files; do not place raw keys in this repository or published directories.

Validate everything before installing. With presets, catalog files and compatibility rules join the same configuration plan, and each target is written at most once. Existing files receive unique `.lazypi.<timestamp>.<id>.bak` backups; unchanged files are not rewritten. New files/backups use restrictive permissions; existing file modes are preserved. Writes use same-directory temporary files and individual atomic replacements, **not** a cross-file or package-manager transaction. On failure, inspect the reported completed paths and backups; already installed packages may remain.

Pi package installation can change `settings.json`: the preset writer rereads it and preserves new package entries and unrelated fields. Concurrent changes to managed fields stop application. Avoid applying while other processes edit configuration. Local-path registrations matching a missing npm requirement must be migrated explicitly before applying; LazyPi does not uninstall them automatically.

Restart Pi after applying; not all extension settings support hot reload. If `PI_FFF_MODE` is set, it takes precedence over `pi-fff.json`; unset it to use the preset. Removing `--preset` from a later command does not undo earlier writes. No background synchronization, ownership database or automatic preset removal is provided. Presets are trusted configuration, not a sandbox: never distribute credentials or unreviewed command-bearing settings.

## Build your own LazyPi

### 1. Fork and clone

Fork the repository on GitHub, then:

```bash
git clone git@github.com:<your-user>/LazyPi.git
cd LazyPi
npm ci
```

### 2. Rename the npm package

The CLI reads its package name from `package.json`, so help and error messages pick it up with no second edit. Keep the name in `package-lock.json` in sync too:

```bash
npm pkg set name=@<your-npm-user>/lazypi
npm install --package-lock-only
```

### 3. Replace the catalog

`PACKAGES` in `bin/lazypi.mjs` is the source of truth. Each extension entry looks like this:

```js
{
  id: "interactive-shell",
  category: "tools",
  source: "npm:@moguw/pi-interactive-shell",
  description: "Interactive terminal workflows",
  hint: "Run observable interactive CLI sessions inside Pi.",
}
```

| Field | Meaning |
| --- | --- |
| `id` | Selector used by `--only`, `--except`, and `remove` |
| `category` | Any category you like; the CLI derives the category list automatically, nothing to register elsewhere |
| `source` | A Pi install source — `npm:<package>` or `git:...` |
| `description` | Short text shown during package selection |
| `hint` | Post-install guidance shown by `status` and the install cheatsheet |

Categories are derived automatically from the `category` values, so adding a new one never requires a separate list edit. Keep entries grouped by category and ordered like the existing ones.

#### Advanced fields

- `dependencies: ["other-id"]` — package ids automatically selected whenever this package is selected.
- `setupCommands: ["export ..."]` — recommended commands printed after install for the selected packages.
- `loadBefore: ["other-id"]` — packages this one must load before; `install` repairs the package order in existing settings to match.
- `conflicts: ["npm:old-package"]` — known incompatible sources rejected before installing their selected replacement; pinned versions/refs are recognized. Old registrations are never removed implicitly.
- `postInstall: [{ requiresSelected: ["other-id"], jsonMerge: { path: "extensions/.../config.json", value: { ... } } }]` — a JSON merge applied after install, but only when every id in `requiresSelected` is selected in the same invocation. Unrelated configuration is preserved.
- File-based entries replace `source` with `themeFiles` and/or `agentFiles`:
  - `themes` category — `themeFiles: ["themes/your-theme.json"]` copies the file into Pi's agent themes directory.
  - `config` category — `agentFiles: ["agent/AGENTS.md"]` copies the file to the agent root (for example `~/.pi/agent/AGENTS.md`).

### 4. Test before publishing

```bash
npm test
node scripts/packed-cli-smoke.mjs
npm pack --dry-run
```

For a real install check in an isolated, throwaway agent directory, use a temporary `PI_CODING_AGENT_DIR`:

```bash
test_dir="$(mktemp -d)"
PI_CODING_AGENT_DIR="$test_dir" node bin/lazypi.mjs --yes
PI_CODING_AGENT_DIR="$test_dir" node bin/lazypi.mjs status
rm -rf "$test_dir"
```

Do not rely on `--local` for full isolation: theme and agent-file entries are always installed agent-globally, so `--local` only redirects the settings write.

### 5. Publish

The first release is a manual npm publish. Scoped packages default to private, so publish with public access unless your npm account supports private packages:

```bash
npm publish --access public
```

After that, the repository's Release Please workflow ([`.github/workflows/release-please.yml`](.github/workflows/release-please.yml)) takes over: conventional commits on your default branch open release PRs, and npm trusted publishing handles authentication with `--provenance`.

**Fork owners:** check the branch filters in `.github/workflows/test.yml` and `.github/workflows/release-please.yml`. This repository's default branch is `main`, but those workflows currently trigger on `master` — update them to your own default branch, or CI will never run.

## Maintain the catalog

A normal maintenance pass looks like this:

1. Run `pi list` and compare the installed sources against `PACKAGES`.
2. Add entries only for extensions you actually use; remove entries you no longer want installed.
3. For a new file-based entry, drop the file under `themes/` or `agent/` and reference it from the entry.
4. Run `npm test` and `node scripts/packed-cli-smoke.mjs`, then `node bin/lazypi.mjs status` to eyeball the catalog.
5. Commit with Conventional Commits, for example `feat: add extension to catalog` or `fix: preserve custom Pi settings`.

Two different update paths, and they do not overlap:

- `lazypi update` (via `pi update`) refreshes the extensions already installed on this machine.
- Editing `PACKAGES` changes what LazyPi will install in the future — then run `lazypi install` on each machine you manage.

Existing files are never silently destroyed. Before a settings file or an installed theme/agent file is rewritten, LazyPi copies it to a timestamped `.lazypi.<timestamp>.bak`; identical files are skipped. Unrelated packages and settings fields in your `settings.json` are preserved.

## Repository layout

```
bin/lazypi.mjs          CLI and the PACKAGES catalog (the source of truth)
lib/presets.mjs         preset validation, merging, planning and safe writes
presets/               opt-in base, ui and workflow manifests and configuration files
themes/                 theme JSON files referenced by themes entries
agent/                  agent config files referenced by config entries (e.g. AGENTS.md)
test/                   node:test suite (catalog, load order, post-install, themes, CLI)
scripts/                packed-cli-smoke and installed-package assertion helpers
.github/workflows/      CI: test, windows-smoke, release-please
```

## Safety and behavior

- Global settings are read from `~/.pi/agent/settings.json`, or from `PI_CODING_AGENT_DIR` when set; `--local` uses `.pi/settings.json` in the current project.
- LazyPi never replaces your settings file wholesale. It preserves unrelated package entries and settings fields, and backs up the file before rewriting it.
- When catalog metadata declares `loadBefore`, install repairs existing settings order (timestamped backup included) so load-order-dependent extensions keep working after catalog changes.
- `postInstall` JSON merges run only when all `requiresSelected` ids are selected in the same install invocation, preserve unrelated configuration, and back up before changing an existing file.
- File-based installs (themes, agent config) copy into Pi's agent directory with a timestamped backup on overwrite and never touch settings such as `settings.theme` — activate a theme by setting it yourself.

## Development

The LazyPi CLI requires Node.js 20.12 or newer. The full extension set includes packages requiring Node.js 22.19 or newer; CI uses Node.js 24. npm and Pi are needed for real install-flow checks.

```bash
npm ci
npm test
node scripts/packed-cli-smoke.mjs
```

The packed smoke test inspects the published file list, invokes the npm artifact's binary, and applies a built-in plus external preset twice in an isolated HOME/agent directory, checking preservation, backups, idempotence and status. The CI workflows install Pi, run the full suite, run the packed smoke test, and assert that a full `lazypi --yes` install matches the catalog.
