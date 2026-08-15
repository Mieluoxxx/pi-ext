# pi-interactive-shell Monorepo Integration Design

Date: 2026-08-15
Status: Approved

Amendment: The package README is usage-focused, ends with upstream acknowledgments,
and ships without the imported banner or demo video.

## Context

`pi-interactive-shell/` is currently a standalone nested Git repository beside the
monorepo's `extensions/` workspace. It contains the complete v0.15.0 extension,
including its runtime modules, tests, bundled skill, examples, and documentation.
The standalone baseline is the fork commit `4ec1bee`, based on upstream commit
`87938caaaffe9f9c53642741971596100c387e50`. Its working tree also contains one
README correction that changes the recorded upstream branch to `upstream/main`.

The package must become an independently publishable `@moguw` workspace while
preserving runtime behavior and verifiable source provenance.

## Goals

- Add `@moguw/pi-interactive-shell` under `extensions/pi-interactive-shell/`.
- Keep version `0.15.0` and preserve the existing extension behavior.
- Make `Mieluoxxx` the current package author, publisher, and maintainer.
- Preserve the original author and historical contributors only where required
  for license compliance, provenance, acknowledgments, and existing changelog
  history.
- Include the package in root workspace checks and direct Git-package loading.
- Preserve a reliable migration baseline and avoid copying nested repository or
  dependency state.

## Non-goals

- No refactor of the extension's runtime modules, tool schema, commands,
  shortcuts, overlays, or session behavior.
- No conversion from the upstream flat module layout to `src/`.
- No Git subtree, submodule, or retained nested `.git/` directory.
- No attempt to use `pi-upstream-sync` against this package directory. That tool
  compares repository-level histories, while this monorepo and the upstream
  standalone repository have unrelated trees.
- No publication or Git commit as part of the integration.

## Package Layout

The destination remains structurally close to upstream:

```text
extensions/pi-interactive-shell/
├── index.ts
├── *.ts
├── tests/
├── skills/pi-interactive-shell/SKILL.md
├── examples/
├── README.md
├── CHANGELOG.md
├── LICENSE
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

Only tracked project files and the approved README working-tree correction are
copied. `.git/`, `node_modules/`, generated archives, logs, and a package-local
lockfile are excluded. The root `package-lock.json` remains the workspace lock.

Keeping the flat layout minimizes source drift and makes future manual upstream
comparisons practical.

## Package Metadata

`package.json` will use the monorepo's independently published package contract:

- `name`: `@moguw/pi-interactive-shell`
- `version`: `0.15.0`
- `private`: `false`
- `author`: `Mieluoxxx`
- `repository`: `Mieluoxxx/pi-ext`, with directory
  `extensions/pi-interactive-shell`
- `homepage` and `bugs`: the `Mieluoxxx/pi-ext` package location and issue tracker
- `publishConfig.access`: `public`
- `pi.extensions`: `./index.ts`
- `pi.skills`: `./skills`

Runtime dependencies (`@xterm/addon-serialize`, `@xterm/headless`, and `zigpty`)
remain regular dependencies. Pi-owned runtime packages remain wildcard peer
dependencies and receive monorepo-aligned development versions for local type
checking and tests. The `files` allowlist includes runtime modules, the bundled
skill, examples, documentation, and license, while excluding tests and
development configuration from the published tarball.

## Attribution And Provenance

All current distribution-facing ownership is assigned to `Mieluoxxx`: npm
author, repository, homepage, issue tracker, README maintainer identity, and new
release notes.

The integration does not rewrite history. The original author, upstream project,
upstream baseline, and historical contributor credits remain in the
acknowledgments, license notice, existing changelog entries, and this design
record. The README ends with a concise acknowledgment of the original author and
project without exposing maintenance history or commit baselines as usage content.

## Migration Safety

The migration uses copy, verify, then delete:

1. Refuse to proceed if `extensions/pi-interactive-shell/` already exists.
2. Copy the allowed source tree to the destination without modifying the nested
   source repository.
3. Apply package, documentation, license, and workspace metadata changes only at
   the destination.
4. Compare unchanged runtime, test, skill, example, and asset files against the
   source tree.
5. Install workspace dependencies and run all verification commands.
6. Delete the original top-level `pi-interactive-shell/` only after verification
   passes and after receiving the required explicit dangerous-operation
   confirmation.

If copying, comparison, dependency installation, or verification fails, the
original nested repository remains untouched. The incomplete destination is
reported rather than silently treated as integrated.

## Documentation Changes

- Change the package README installation command to
  `pi install npm:@moguw/pi-interactive-shell`.
- Keep the README focused on installation, commands, tool calls, modes, shortcuts,
  configuration, limitations, and usage examples.
- Remove the imported banner and demo video from both the workspace and npm package.
- End the README with an acknowledgment thanking original author Nico Bailon and
  linking the upstream project.
- Add the package to the root README package table and local-development examples.
- Add an unreleased changelog entry for the scoped monorepo distribution without
  altering historical release attribution.

## Verification

The pre-migration baseline is:

- standalone package typecheck: passed
- standalone package tests: 19 files, 99 tests passed
- existing monorepo typecheck: passed
- existing monorepo tests: 10 files, 156 tests passed

After integration, verification must include:

1. `npm install` at the repository root, producing only the root lockfile update.
2. `npm run check` at the repository root, including the new workspace.
3. Direct typecheck and test execution for `@moguw/pi-interactive-shell`.
4. `npm pack --workspace @moguw/pi-interactive-shell --dry-run --json`.
5. Tarball inspection confirming the scoped name and required runtime/resources,
   with no `.git/`, `node_modules/`, tests, or development-only configuration.
6. A source comparison confirming that runtime behavior files differ only where
   package integration explicitly requires documentation or metadata changes.
7. `git diff --check` and a final worktree review that distinguishes pre-existing
   user changes from integration changes.

## Acceptance Criteria

- Pi can discover `./index.ts` and the bundled skill from the workspace package.
- The package is ready for independent public publication as
  `@moguw/pi-interactive-shell@0.15.0`.
- Current package ownership is consistently attributed to `Mieluoxxx`.
- Required upstream provenance and historical credits remain intact.
- All 99 extension tests and the complete monorepo check pass after relocation.
- Published contents contain no nested Git metadata or installed dependencies.
- The old top-level directory is removed only after explicit confirmation and
  successful verification.
