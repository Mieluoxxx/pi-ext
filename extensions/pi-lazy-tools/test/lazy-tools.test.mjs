import assert from "node:assert/strict";
import test from "node:test";
import extension, { GROUPS } from "../index.ts";

function harness({ branch = [], allow = () => true, missing = [], rejectPersistence = false, searchTools = [] } = {}) {
  const definitions = new Map(["read", "bash", "apply_patch", "goal_complete", "history", ...searchTools, ...Object.values(GROUPS).flat()]
    .filter((name) => !missing.includes(name)).map((name) => [name, { name, parameters: {}, description: name, sourceInfo: { path: `/test/${name}` } }]));
  let active = [...definitions.keys()].filter(allow);
  const handlers = new Map();
  const commands = new Map();
  const entries = [...branch];
  const ctx = { sessionManager: { getBranch: () => entries }, ui: { notify() {} } };
  extension({
    registerTool(tool) { definitions.set(tool.name, tool); if (allow(tool.name)) active.push(tool.name); },
    registerCommand(name, command) { commands.set(name, command); },
    on(name, handler) { handlers.set(name, handler); },
    getAllTools: () => [...definitions.values()],
    getActiveTools: () => active,
    setActiveTools(names) { active = names.filter((name) => definitions.has(name) && allow(name)); },
    appendEntry(customType, data) { if (rejectPersistence) throw new Error("disk unavailable"); entries.push({ type: "custom", customType, data }); },
  });
  handlers.get("session_start")({}, ctx);
  return { definitions, handlers, commands, entries, ctx, active: () => active,
    load: (name) => definitions.get("load_capability").execute("test", { name }),
    removeActive(name) { active = active.filter((tool) => tool !== name); },
    addActive(...names) { active = [...new Set([...active, ...names])]; },
    newSession() { entries.length = 0; active = [...definitions.keys()].filter(allow); handlers.get("session_start")({}, ctx); },
  };
}

test("cold start hides only managed groups, not Goal or Remote lifecycle tools", () => {
  const h = harness();
  assert.deepEqual(h.active(), ["read", "bash", "apply_patch", "goal_complete", "history", "load_capability"]);
});

test("active FFF tools replace duplicate search tools on startup and subsequent requests", async () => {
  const h = harness({ searchTools: ["grep", "find", "ffgrep", "fffind"] });
  const check = () => {
    assert.ok(h.active().includes("ffgrep") && h.active().includes("fffind"));
    assert.ok(!h.active().includes("grep") && !h.active().includes("find"));
  };
  check();
  await h.load("docs");
  h.addActive("grep", "find");
  h.handlers.get("before_agent_start")();
  check();
  h.newSession();
  check();
});

test("each existing search fallback remains when its FFF counterpart is absent", () => {
  for (const fff of [[], ["ffgrep"], ["fffind"]]) {
    const h = harness({ searchTools: ["grep", "find", ...fff] });
    assert.equal(h.active().includes("grep"), !fff.includes("ffgrep"));
    assert.equal(h.active().includes("find"), !fff.includes("fffind"));
  }
});

test("registered but disallowed FFF tools do not suppress permitted fallbacks", () => {
  const h = harness({ searchTools: ["grep", "find", "ffgrep", "fffind"], allow: (name) => !name.startsWith("ff") });
  assert.ok(h.definitions.has("ffgrep") && h.definitions.has("fffind"));
  assert.ok(h.active().includes("grep") && h.active().includes("find"));
});

test("activation is additive, idempotent and survives the next request", async () => {
  const h = harness();
  await h.load("web");
  await h.load("docs");
  await h.load("web");
  h.handlers.get("before_agent_start")();
  for (const name of [...GROUPS.web, ...GROUPS.docs]) assert.ok(h.active().includes(name));
  assert.ok(!h.active().includes("act_ui"));
  assert.equal(h.entries.length, 2);
});

test("restore uses current branch records, new sessions reset to the baseline", async () => {
  const h = harness();
  await h.load("ui");
  const restored = harness({ branch: h.entries });
  assert.ok(restored.active().includes("act_ui"));
  restored.newSession();
  assert.ok(!restored.active().includes("act_ui"));
});

test("later provider restrictions are not undone by reconciliation", async () => {
  const h = harness();
  await h.load("web");
  h.removeActive("web_search");
  h.handlers.get("before_agent_start")();
  assert.ok(!h.active().includes("web_search"));
});

test("unknown and prototype names are rejected without mutations", async () => {
  const h = harness();
  const before = [...h.active()];
  for (const name of ["advisor", "__proto__", "constructor", undefined]) await assert.rejects(h.load(name), /Unknown capability/);
  assert.deepEqual(h.active(), before);
});

test("host rejection and persistence failures roll back activation", async () => {
  for (const options of [{ allow: (name) => name !== "query-docs" }, { rejectPersistence: true }]) {
    const h = harness(options);
    const before = [...h.active()];
    await assert.rejects(h.load("docs"));
    assert.deepEqual(h.active(), before);
    assert.equal(h.entries.length, 0);
  }
});

test("missing registrations are reported and never invented", async () => {
  const h = harness({ missing: ["source_check"] });
  assert.deepEqual((await h.load("web")).details.unavailable, ["source_check"]);
  await assert.rejects(harness({ missing: GROUPS.docs }).load("docs"), /No registered tools/);
});

test("a disallowed loader leaves the host-selected tools alone", () => {
  const h = harness({ allow: (name) => name !== "load_capability" });
  assert.ok(h.active().includes("web_search"));
});

test("invalid saved records cannot activate unknown groups", () => {
  const h = harness({ branch: [{ type: "custom", customType: "pi-lazy-tools.activation.v1", data: { version: 2, group: "web" } }] });
  assert.ok(!h.active().includes("web_search"));
});

test("status stores metadata, not prompt bodies or parameter schemas", async () => {
  const h = harness();
  await h.commands.get("tools-status").handler("", h.ctx);
  const snapshot = h.entries.at(-1).data;
  assert.equal(snapshot.registered, h.definitions.size);
  assert.ok(snapshot.tools.every((row) => !Object.hasOwn(row, "parameters") && !Object.hasOwn(row, "promptGuidelines")));
});
