import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("packed sources load through Pi 0.85.1 without upstream directories, settings, credentials or network", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-openai-tools-pack-"));
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  try {
    const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--workspaces=false", "--pack-destination", root], {
      cwd: packageRoot, encoding: "utf8",
    }));
    // npm returns an array; pnpm's npm-compatible wrapper keys by package name.
    const info = Array.isArray(packed) ? packed[0] : packed["@moguw/pi-openai-tools"];
    const contents = info.files.map((file: { path: string }) => file.path);
    expect(contents).toHaveLength(49);
    expect(contents.some((path: string) => /node_modules|\.git\/|\.test\.|bun\.lock|pnpm-lock|package-lock|auto-mode|web-search/.test(path))).toBe(false);
    expect(info.bundled).toEqual([]);
    const extracted = join(root, "node_modules", "@moguw", "pi-openai-tools");
    // Install the sole production dependency from the local store. Pi's real
    // loader supplies host peer imports; no original extension is installed.
    writeFileSync(join(root, "package.json"), JSON.stringify({
      private: true,
      dependencies: { "@moguw/pi-openai-tools": `file:./${info.filename}` },
    }));
    writeFileSync(join(root, "pnpm-workspace.yaml"), "autoInstallPeers: false\n");
    execFileSync("pnpm", ["install", "--offline", "--ignore-scripts"], {
      cwd: root, encoding: "utf8", stdio: "pipe",
    });
    for (const path of contents.filter((path: string) => path.endsWith(".ts"))) {
      expect(readFileSync(join(extracted, path), "utf8")).not.toMatch(/\/Users\/moguw|bun:test/);
    }
    const piMain = import.meta.resolve("@earendil-works/pi-coding-agent");
    const loader = new URL("./core/extensions/loader.js", piMain).href;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      import { join } from 'node:path';
      let requests = 0;
      globalThis.fetch = async () => { requests++; throw new Error('Network forbidden'); };
      const { loadExtensions } = await import(process.argv[1]);
      const root = process.argv[2];
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      const loaded = await loadExtensions(manifest.pi.extensions.map(p => join(root, p)), root);
      assert.deepEqual(loaded.errors, []);
      assert.equal(loaded.extensions.length, 4);
      const names = loaded.extensions.flatMap(e => [...e.tools.keys()]);
      assert.deepEqual(names, ['new_context', 'get_context_remaining', 'history', 'notes', 'openai_generate_image', 'apply_patch']);
      assert(loaded.extensions.every(e => e.commands.size === 0 && !e.handlers.has('tool_call')));
      assert.equal(requests, 0);
      console.log(JSON.stringify({ entries: loaded.extensions.length, tools: names, networkRequests: requests }));
    `, loader, extracted], {
      cwd: extracted, encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: join(root, "home"), USERPROFILE: join(root, "home"),
        PI_CODING_AGENT_DIR: join(root, "agent"),
        XDG_CONFIG_HOME: join(root, "config"),
      },
    });
    expect(JSON.parse(output)).toMatchObject({ entries: 4, networkRequests: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
