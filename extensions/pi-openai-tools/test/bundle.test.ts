import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadToolkitConfig } from "../src/config";
import { DEFAULT_TOOLKIT_CONFIG, TOOLKIT_ID } from "../src/types";

vi.mock("../src/config", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/config")>(),
  loadToolkitConfig: vi.fn(),
}));

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const expectedTools = ["new_context", "get_context_remaining", "history", "notes", "openai_generate_image", "apply_patch"];
const webTools = ["web_search", "fetch_content"];
let config = structuredClone(DEFAULT_TOOLKIT_CONFIG);

beforeEach(() => {
  config = structuredClone(DEFAULT_TOOLKIT_CONFIG);
  vi.mocked(loadToolkitConfig).mockImplementation(() => ({ config, warnings: [] }));
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network forbidden in bundle tests"); }));
});
afterEach(() => vi.unstubAllGlobals());

async function loadBundle(includeRegisteredTools = true) {
  let loading = true;
  const tools = new Map<string, any>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const commands: string[] = [];
  const messages: unknown[] = [];
  let active = ["read", "bash", "edit", "write", ...webTools];
  const guard = () => {
    if (loading) throw new Error("Action method called during registration");
  };
  const pi = {
    registerTool(tool: any) {
      expect(tools.has(tool.name)).toBe(false);
      tools.set(tool.name, tool);
    },
    registerCommand(name: string) { commands.push(name); },
    on(name: string, handler: (event: any, ctx: any) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    getAllTools() { guard(); return [...tools.values()]; },
    getActiveTools() { guard(); return [...active]; },
    setActiveTools(names: string[]) { guard(); active = [...names]; },
    sendMessage(message: unknown) { messages.push(message); },
  };
  for (const entry of manifest.pi.extensions) {
    const module = await import(new URL(`../${entry}`, import.meta.url).href);
    module.default(pi as unknown as ExtensionAPI);
  }
  loading = false;
  // Pi normally activates all newly registered tools before session_start.
  if (includeRegisteredTools) active.push(...tools.keys());
  return {
    tools, handlers, commands, messages,
    active: () => active,
    async emit(name: string, event: any, ctx: any) {
      const results = [];
      for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
      return results;
    },
  };
}

function context(model = { provider: "cpa", api: "openai-responses", id: "gpt-6-astra" }) {
  return {
    model: { ...model, baseUrl: "https://gateway.invalid/v1", contextWindow: 100_000 },
    hasUI: false,
    ui: { notify: vi.fn() },
    sessionManager: { getSessionId: () => "bundle-test", getBranch: () => [] },
    modelRegistry: { getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "test-only" })) },
    getContextUsage: () => undefined,
    abort: vi.fn(),
  };
}

test("four declared entries register exactly six tools without registration-time actions or excluded hooks", async () => {
  expect(manifest.pi.extensions).toEqual([
    "./extensions/compaction.ts", "./extensions/image-generation.ts",
    "./extensions/codex-astra.ts", "./extensions/apply-patch.ts",
  ]);
  const bundle = await loadBundle();
  expect([...bundle.tools.keys()]).toEqual(expectedTools);
  expect(bundle.commands).toEqual([]);
  expect(bundle.handlers.has("tool_call")).toBe(false);
  expect(bundle.tools.get("apply_patch").freeform).toMatchObject({ type: "grammar", syntax: "lark" });
  expect(TOOLKIT_ID).toBe("pi-openai-toolkit");
});

test("defaults disable paid images and remote execution, preserve web tools and retain GPT patch switching", async () => {
  const bundle = await loadBundle();
  const ctx = context();
  await bundle.emit("session_start", {}, ctx);
  expect(bundle.active()).not.toContain("openai_generate_image");
  expect(bundle.active()).toContain("apply_patch");
  expect(bundle.active()).not.toContain("edit");
  expect(bundle.active()).not.toContain("write");
  expect(bundle.active()).toEqual(expect.arrayContaining(webTools));
  expect(bundle.messages).toEqual([]);
  expect(ctx.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();
  await expect(bundle.tools.get("new_context").execute("id", { force: true }, undefined, undefined, ctx))
    .rejects.toThrow("remote-context-inactive");
  await expect(bundle.tools.get("openai_generate_image").execute("id", { prompt: "a tree" }, undefined, undefined, ctx))
    .rejects.toThrow("not enabled");
  const nonGpt = context({ provider: "cpa", api: "openai-responses", id: "other-model" });
  await bundle.emit("model_select", { model: nonGpt.model }, nonGpt);
  expect(bundle.active()).not.toContain("apply_patch");
  expect(bundle.active()).toEqual(expect.arrayContaining(["edit", "write", ...webTools]));
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

test("CPA remote context is explicit opt-in, image eligibility is API-only, and model changes preserve web activity", async () => {
  config.compaction.contextManagement = "remote";
  config.imageGeneration.enabled = true;
  const bundle = await loadBundle(false);
  const ctx = context();
  await bundle.emit("session_start", {}, ctx);
  expect(bundle.messages).toEqual([]);
  expect(bundle.active()).not.toContain("new_context");
  config.compaction.gatewayContextModels = ["cpa/gpt-6-astra"];
  await bundle.emit("model_select", { model: ctx.model }, ctx);
  expect(bundle.messages).toHaveLength(1);
  expect(bundle.active()).toEqual(expect.arrayContaining(expectedTools));
  const nonGpt = context({ provider: "cpa", api: "openai-responses", id: "other-model" });
  await bundle.emit("model_select", { model: nonGpt.model }, nonGpt);
  expect(bundle.active()).toContain("openai_generate_image");
  expect(bundle.active()).not.toContain("apply_patch");
  expect(bundle.active()).not.toContain("new_context");
  expect(bundle.active()).toEqual(expect.arrayContaining(webTools));
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

test("request hook composition keeps unowned tools and does not inject hosted search", async () => {
  const bundle = await loadBundle();
  const ctx = context();
  await bundle.emit("session_start", {}, ctx);
  const input = [{ role: "user", content: "hello" }];
  const tools = [{ type: "function", name: "web_search", parameters: { type: "object" } }];
  let payload: any = { model: ctx.model.id, input, tools, reasoning: { effort: "low" } };
  for (const handler of bundle.handlers.get("before_provider_request") ?? []) {
    payload = (await handler({ payload }, ctx)) ?? payload;
  }
  expect(payload).toEqual({ model: ctx.model.id, input, tools, reasoning: { effort: "low" } });
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
