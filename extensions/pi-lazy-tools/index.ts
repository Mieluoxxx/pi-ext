// Pi 0.86.0's Node loader can retain native .js ESM imports across /reload; use its TypeScript path.
export const GROUPS = Object.freeze({
  web: ["web_search", "source_check", "fetch_content", "get_search_content", "find_search_content"],
  docs: ["resolve-library-id", "query-docs"],
  ui: ["find_roots", "observe_ui", "search_ui", "expand_ui", "inspect_ui", "act_ui", "read_text", "wait_for", "launch_browser", "navigate_browser", "evaluate_browser"],
  delegation: ["subagent", "bg_wait", "subagent_supervisor"],
  hashline: ["replace", "insert", "undo_last_change"],
});
const ENTRY = "pi-lazy-tools.activation.v1";
const LOADER = "load_capability";
const managed = new Map(Object.entries(GROUPS).flatMap(([group, names]) => names.map((name) => [name, group])));

export default function lazyTools(pi) {
  let enabled = new Set();

  const reconcile = () => {
    const active = pi.getActiveTools();
    // If a host allowlist excludes the loader, leave its tool policy untouched.
    if (!active.includes(LOADER)) return;
    const next = active.filter((name) =>
      (!managed.has(name) || enabled.has(managed.get(name))) &&
      !(name === "grep" && active.includes("ffgrep")) &&
      !(name === "find" && active.includes("fffind"))
    );
    if (next.length !== active.length) pi.setActiveTools(next);
  };

  const activate = (name) => {
    if (typeof name !== "string" || !Object.hasOwn(GROUPS, name)) throw new Error("Unknown capability. Use web, docs, ui, delegation or hashline.");
    const registered = new Set(pi.getAllTools().map((tool) => tool.name));
    const names = GROUPS[name].filter((tool) => registered.has(tool));
    const unavailable = GROUPS[name].filter((tool) => !registered.has(tool));
    if (names.length === 0) throw new Error(`No registered tools for ${name}; enable its existing extension first.`);
    const previous = pi.getActiveTools();
    try {
      pi.setActiveTools([...new Set([...previous, ...names])]);
      const actual = new Set(pi.getActiveTools());
      if (names.some((tool) => !actual.has(tool))) throw new Error(`Host tool policy rejected ${name}; no capability was activated.`);
      if (!enabled.has(name)) pi.appendEntry(ENTRY, { version: 1, group: name });
      enabled.add(name);
    } catch (error) {
      pi.setActiveTools(previous);
      throw error;
    }
    return { group: name, tools: names, unavailable };
  };

  pi.registerTool({
    name: LOADER,
    label: "Load capability",
    description: "Enable an existing tool group after reading its Skill: web, docs, ui, delegation or hashline. Tools become available on the next model request. This does not execute the tools or grant permission to use them.",
    promptSnippet: "Enable additional tool groups after reading their matching Skills",
    promptGuidelines: ["When required tools are absent, read the matching Skill and use load_capability. Enable delegation only when the user has authorized delegation; loading tools never grants execution permission."],
    parameters: {
      type: "object",
      properties: { name: { type: "string", enum: Object.keys(GROUPS) } },
      required: ["name"],
      additionalProperties: false,
    },
    executionMode: "sequential",
    async execute(_id, params) {
      const result = activate(params?.name);
      return {
        content: [{ type: "text", text: `Available on the next request: ${result.tools.join(", ")}.${result.unavailable.length ? ` Not registered: ${result.unavailable.join(", ")}.` : ""}` }],
        details: result,
      };
    },
  });

  pi.on("session_start", (_event, ctx) => {
    enabled = new Set();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === ENTRY && entry.data?.version === 1 && Object.hasOwn(GROUPS, entry.data.group)) enabled.add(entry.data.group);
    }
    reconcile();
  });
  pi.on("before_agent_start", reconcile);

  pi.registerCommand("capability", {
    description: "Enable a tool group: /capability web|docs|ui|delegation|hashline",
    handler: async (args, ctx) => {
      const result = activate(args.trim());
      ctx.ui.notify(`Enabled: ${result.tools.join(", ")}${result.unavailable.length ? `; unavailable: ${result.unavailable.join(", ")}` : ""}`, "info");
    },
  });
  pi.registerCommand("tools-status", {
    description: "Inspect active tool names and save a metadata-only audit to session history",
    handler: async (_args, ctx) => {
      const active = new Set(pi.getActiveTools());
      const rows = pi.getAllTools().map((tool) => ({
        name: tool.name,
        active: active.has(tool.name),
        sourceInfo: tool.sourceInfo,
        schemaBytes: Buffer.byteLength(JSON.stringify(tool.parameters ?? {})),
        descriptionBytes: Buffer.byteLength(tool.description ?? ""),
        guidelineBytes: Buffer.byteLength(JSON.stringify(tool.promptGuidelines ?? [])),
      }));
      const snapshot = { version: 1, active: [...active], registered: rows.length, enabledGroups: [...enabled], tools: rows };
      // Metadata only: no prompts, conversation content, schemas or credentials.
      pi.appendEntry("pi-lazy-tools.audit.v1", snapshot);
      ctx.ui.notify(`Active ${active.size}/${rows.length}: ${[...active].join(", ")}\nEnabled groups: ${[...enabled].join(", ") || "none"}. Audit saved in session history; byte counts are not token counts.`, "info");
    },
  });
}
