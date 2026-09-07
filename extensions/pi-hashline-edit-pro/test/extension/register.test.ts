import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import register from "../../index";
import { withTempDir } from "../support/fixtures";

describe("extension registration", () => {
  it("registers the read and replace tools", async () => {
    await withTempDir("register-", async () => {
      const toolNames: string[] = [];
      const eventNames: string[] = [];
      const commandNames: string[] = [];
      const pi = {
        registerTool(tool: { name: string }) {
          toolNames.push(tool.name);
        },
        registerCommand(name: string) {
          commandNames.push(name);
        },
        on(name: string) {
          eventNames.push(name);
        },
      } as any;

      register(pi);

      expect(toolNames.sort()).toEqual(["grep", "insert", "read", "replace", "undo_last_change"]);

      expect(eventNames).toEqual(["session_start", "tool_result"]);
    });
  });
  it("honors disabledTools by skipping the listed tool at registration", async () => {
    await withTempDir("register-disabled-", async (dir) => {
      const { mkdir, writeFile } = await import("fs/promises");
      const { join } = await import("path");
      const configDir = join(dir, ".config", "pi-hashline-edit-pro");
      await mkdir(configDir, { recursive: true });
      await writeFile(
        join(configDir, "config.json"),
        JSON.stringify({ autoRead: true, disabledTools: ["grep"] }),
        "utf-8",
      );
      const toolNames: string[] = [];
      const eventNames: string[] = [];
      const pi = {
        registerTool(tool: { name: string }) {
          toolNames.push(tool.name);
        },
        registerCommand() {},
        on(name: string) {
          eventNames.push(name);
        },
      } as any;
      register(pi);
      expect(toolNames.sort()).toEqual(["insert", "read", "replace", "undo_last_change"]);
      expect(eventNames).toEqual(["session_start", "tool_result"]);
    });
  });

});

describe("tool prompt file references", () => {
  it("replace.ts loads the consolidated replace.md prompt", () => {
    const source = readFileSync(
      new URL("../../src/replace.ts", import.meta.url),
      "utf-8",
    );
    expect(source).toContain("../prompts/replace.md");
    expect(source).toContain("../prompts/replace-snippet.md");
    expect(source).toContain("../prompts/replace-guidelines.md");
  });
});
