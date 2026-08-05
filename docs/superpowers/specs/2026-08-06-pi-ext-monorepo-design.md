# pi-ext npm Workspace Design

## Context

`pi-ext/` is currently empty. The existing `pi-session/` directory is a standalone npm package that implements automatic and manual Pi session naming. The package will become one independently publishable extension inside `pi-ext`, following the production-extension organization used by `narumiruna/pi-extensions`.

## Goals

- Make `pi-ext/` a private npm workspace repository.
- Move the session-renaming extension to `extensions/pi-session-rename/`.
- Publish the extension as `@moguw/pi-session-rename`.
- Support both root Git installation and independent npm installation.
- Use the canonical Pi package entrypoint shape: a thin `src/index.ts` and `pi.extensions` pointing to it.
- Keep the extension's behavior and `/rename` command intact apart from the explicitly approved runtime identifier changes.
- Use one root `package-lock.json` and one root dependency installation.

## Non-Goals

- No Git repository initialization, commit, branch, or push.
- No feature redesign or unrelated refactoring.
- No compatibility read or migration for `~/.pi/agent/pi-session.json`.
- No migration of generated dependencies, package tarballs, or debug logs.
- No experimental or shared-library workspace categories until a real package requires them.

## Target Layout

```text
pi-ext/
|-- .gitignore
|-- package.json
|-- package-lock.json
|-- README.md
|-- tsconfig.json
|-- docs/
|   `-- superpowers/specs/2026-08-06-pi-ext-monorepo-design.md
`-- extensions/
    `-- pi-session-rename/
        |-- LICENSE
        |-- README.md
        |-- package.json
        |-- tsconfig.json
        |-- src/
        |   |-- index.ts
        |   |-- rename.ts
        |   |-- config.ts
        |   |-- settings.ts
        |   `-- debug.ts
        `-- test/
            `-- rename.test.ts
```

## Root Workspace

The root `package.json` will be private, use ESM, and declare only the active extension workspace category:

```json
{
  "name": "pi-ext",
  "private": true,
  "type": "module",
  "workspaces": ["extensions/*"]
}
```

Root scripts will fan out typechecking and tests through npm workspaces. The root will not declare a `pi` manifest; Pi's conventional top-level `extensions/` discovery will make a Git installation load production extension entrypoints. The root README will document aggregate Git installation, individual npm installation, local development, and the repository layout.

The root `tsconfig.json` will own shared strict TypeScript options. The extension-level config will extend it and include package source and tests. The root `.gitignore` will exclude `node_modules/`, `*.tgz`, and `debug.log` throughout the repository.

## Extension Package

`extensions/pi-session-rename/package.json` will:

- use the npm name `@moguw/pi-session-rename`;
- retain version `0.1.0` and MIT licensing;
- remain independently publishable;
- publish only `src`, `README.md`, and `LICENSE`;
- declare `"pi": { "extensions": ["./src/index.ts"] }`;
- retain Pi runtime imports as `"*"` peer dependencies;
- retain development-only Pi, TypeScript, Node type, and Vitest dependencies;
- expose workspace-compatible `typecheck` and `test` scripts.

`src/index.ts` will only forward the default export from `src/rename.ts`. Existing implementation modules move from `extensions/*.ts` to descriptive files under `src/`. Tests move unchanged in behavior and update imports from `../extensions/*.js` to `../src/*.js`.

A package-local standard MIT `LICENSE` will credit `moguw`, matching the existing `license: MIT` package metadata.

## Approved Runtime Identifier Changes

- The slash command remains `/rename`.
- The config path changes directly to `~/.pi/agent/rename.json`.
- The old `~/.pi/agent/pi-session.json` is not read, copied, or migrated.
- The debug environment variable changes from `PI_SESSION_DEBUG` to `PI_SESSION_RENAME_DEBUG`.
- User-facing package and settings labels change from `pi-session` to `pi-session-rename` where they identify the package.
- The stable UI status key remains `rename`.

## Migration Procedure

1. Create root workspace metadata, shared configuration, README, and ignore rules.
2. Create `extensions/pi-session-rename/` and move only maintained source, tests, and package documentation into it.
3. Introduce the thin `src/index.ts` entrypoint and update module/test imports.
4. Update package metadata, installation instructions, local paths, config filename, debug variable, and package labels.
5. Do not move the old `node_modules/`, `debug.log`, child `package-lock.json`, or generated tarballs.
6. Install dependencies from `pi-ext/` to generate the root workspace lockfile.
7. Run all verification gates.
8. Remove the old `pi-session/` directory only after the migrated workspace passes verification.

## Verification

Run from `pi-ext/`:

```bash
npm install
npm run typecheck
npm test
npm pack --workspace @moguw/pi-session-rename --dry-run --json
```

The pack result must contain `src/index.ts`, all implementation modules, `README.md`, `LICENSE`, and `package.json`, while excluding tests, logs, dependencies, and repository-only files.

Perform a Pi loader smoke that loads `extensions/pi-session-rename/src/index.ts` without invoking an external model. Confirm that the declared entrypoint resolves and registers cleanly.

Finally, search the maintained repository for stale package paths, npm names, config filenames, and debug environment variables. The only allowed legacy identifier is an intentional historical note in this design document.

## Risks and Mitigations

- Existing local extension paths break after the move. The root and package READMEs will provide the new paths.
- Existing `pi-session.json` settings stop applying. This is an approved hard switch and will be stated in the package README.
- Workspace dependency resolution could conceal missing runtime dependencies. Peer dependencies remain explicit, and npm pack output plus the Pi loader smoke validate the published shape.
- Removing the old directory too early could lose the only maintained copy. Removal occurs only after the target passes typecheck, tests, packaging inspection, and entrypoint loading.
