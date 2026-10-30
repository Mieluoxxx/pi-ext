---
name: maintain-pi-interactive-shell
description: "Maintain extensions/pi-interactive-shell: sync upstream nicobailon/pi-interactive-shell commits, rewrite the ones touching the tool contract for the action-based API, verify, and publish. Use for upstream syncs, releases, and regressions in this extension."
---

# Maintain pi-interactive-shell

This package forks [nicobailon/pi-interactive-shell](https://github.com/nicobailon/pi-interactive-shell) and replaces the flat tool parameters with an action-based contract. Upstream runtime fixes merge close to as written. Changes to the tool fields, description, or schema get rewritten by hand.

Read the facts from their source. Do not restate them here. Paths below are relative to the repository root.

| Question | Source |
| --- | --- |
| Sync waterline, ported items, never-ported items | `extensions/pi-interactive-shell/README.md`, Upstream sync |
| Shipped behavior per version | `extensions/pi-interactive-shell/CHANGELOG.md` |
| Files that reach the npm tarball | `extensions/pi-interactive-shell/package.json`, `files` |

## Sync upstream

1. Take the waterline SHA from the README's Upstream sync section.
2. Clone upstream outside the workspace and list what landed after that commit.

   ```bash
   git clone -q https://github.com/nicobailon/pi-interactive-shell /tmp/pis-upstream
   git -C /tmp/pis-upstream log --format='%h %ad %s' --date=short <waterline>..HEAD
   ```

3. Classify each commit from `git -C /tmp/pis-upstream show --stat <sha>`.
   - Port as written when the commit leaves `tool-schema.ts` and `tool-contract.ts` alone.
   - Rewrite when it changes tool fields, the tool description, or the schema. Those two files are fork-local, so the local shape wins.
   - Skip when the README already lists that area as not ported. Name the reason instead of porting a fragment.
4. Apply the patch with `git -C /tmp/pis-upstream show <sha> -- <path>` and adapt it. Keep the upstream SHA in the changelog entry and the README bullet.
5. Update the four surfaces a sync touches. The package version, both READMEs, and the changelog.

## Traps

The extension binds `ExtensionAPI` at `session_start`, not in the factory. A test harness that calls `extension(pi)` and never dispatches `session_start` keeps the stale callback path that Pi takes during `/reload`. Its assertions pass while the reload path stays broken. Dispatch the event from the harness.

## Verify

```bash
pnpm --filter @moguw/pi-interactive-shell check
```

There is no CI, so this is the only gate. It does not cover packaging, because `files` in `package.json` is an allowlist and version 0.16.0 shipped without `launch-policy.ts` while every test passed; 0.16.1 only re-added the file. Run this from `extensions/pi-interactive-shell` and require `clean`.

```bash
node -e '
const fs = require("node:fs");
const listed = new Set(JSON.parse(fs.readFileSync("package.json", "utf8")).files);
const shipped = fs.readdirSync(".").filter((f) => f.endsWith(".ts") && listed.has(f));
const missing = new Set();
for (const file of shipped) {
  for (const [, dep] of fs.readFileSync(file, "utf8").matchAll(/from "\.\/([a-z0-9-]+)\.ts"/g)) {
    if (!listed.has(dep + ".ts")) missing.add(dep + ".ts");
  }
}
console.log(missing.size ? [...missing].join("\n") : "clean");
'
```

Add `pnpm --filter @moguw/pi-interactive-shell pack --dry-run` when you want the full tarball listing.

## Publish

Bump `version`, write the changelog entry with its upstream SHAs, and move the waterline in both READMEs. Turn an `Unreleased` heading into the release heading dated today before you publish. Run `pnpm --filter @moguw/pi-interactive-shell publish` from the repository root.
