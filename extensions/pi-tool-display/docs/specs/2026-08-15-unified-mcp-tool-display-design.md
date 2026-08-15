# Unified MCP Tool Display

## Goal

Make MCP tools follow the same visual and behavioral conventions as the existing `pi-tool-display` renderers. The design applies to the `mcp` proxy, `mcpScript`, and direct MCP wrappers.

`pi-tool-display` owns presentation while it is enabled. `pi-mcp-adapter` continues to own discovery, registration data, execution, transport, authentication, and result production.

## Decisions

- Implement the integration entirely in this repository by decorating Pi's native tool rendering boundary.
- Reuse existing call-line theme tokens, preview rendering, output modes, expansion hints, truncation hints, and property restoration.
- Do not add an MCP-specific component hierarchy or hard-code colors, borders, spacing, or backgrounds.
- Do not add configuration. Existing `mcpOutputMode`, `previewLines`, `expandedPreviewMaxLines`, `showTruncationHints`, and `showRtkCompactionHints` remain authoritative.
- While `pi-tool-display` is active, adapter settings such as `toolResultRendering` and `collapsedResultLines` do not affect MCP presentation.

## Display Ownership And Lifecycle

For every detected MCP tool, `pi-tool-display` overrides the renderer resolution performed by Pi's native `ToolExecutionComponent`:

- `renderCall`
- `renderResult`
- `renderShell`, setting it to `"default"`

The default shell makes MCP calls use the same full-row background, spacing, wrapping, and expansion lifecycle as other decorated tools. The adapter's `"self"` shell and compact or boxed result components are not used while the override is active.

Decoration does not mutate the registered tool definition. The adapter's execution function, schema, prompt metadata, label, description, and renderer properties therefore remain intact. A versioned, owner-aware prototype patch restores Pi's original renderer-resolution methods during extension disposal or `/reload`.

Renderer classification is evaluated from each `ToolExecutionComponent` instance's current `toolName` and `toolDefinition`. A newly registered object with the same name as an earlier direct tool is therefore classified independently without a name- or object-identity cache. This applies both to automatic MCP detection and to tools routed through `customToolOverrides`.

This rendering-boundary design is required by Pi's extension isolation model: each extension receives its own `ExtensionAPI`, while `getAllTools()` returns fresh metadata-only `ToolInfo` copies without renderer or execution properties. Wrapping this extension's `registerTool` or mutating `getAllTools()` results cannot change tools owned by `pi-mcp-adapter`.

An explicit `customToolOverrides` entry retains its current precedence. MCP auto-decoration handles candidates without an enabled custom override.

## Call Rendering

### Shared Visual Structure

Collapsed MCP calls render as one line using the same theme semantics as existing tools:

- the literal `MCP` family title: `toolTitle` plus bold
- operation and target: `accent`
- argument count and qualifiers: `muted`

No raw JSON appears on a second line while collapsed.

Representative output:

```text
MCP call server:tool (3 args)
MCP search "query" @ server limit 20
MCP Script (2 args)
MCP direct_tool (1 arg)
```

The exact colors and wrapping come from the active Pi theme and shared renderer helpers.

### Proxy Operations

The proxy call formatter supports every current operation shape:

- `tool`: `call <server>:<tool>` when a server is present, otherwise `call <tool>`
- `connect`: `connect <server>`
- `describe`: `describe <tool>` with an optional server qualifier
- `instructions`: `instructions <server>`
- `search`: `search "<query>"` with optional server, regex, schema visibility, limit, and offset qualifiers
- `server`: `tools <server>`
- `action`: the action name
- no operation fields: `status`

For a proxy tool call, the displayed argument count is the number of keys in the nested MCP `args` object, not the number of fields in the proxy envelope. Object values and JSON-object strings are both supported. Missing or empty nested arguments display `(no args)`. An invalid JSON argument string displays a neutral `(args)` suffix and must never make rendering throw.

Direct-tool labels normalize both `MCP ` and `MCP:` prefixes before rendering, preventing duplicated MCP titles. `mcpScript` uses the same one-line title and muted argument-count convention.

### Expanded Arguments

When the tool display is expanded, the call header remains and the complete arguments appear below it as formatted structured text. A proxy `tool` operation shows its parsed nested `args` object, or the original string when parsing fails. Every other proxy operation shows the complete top-level proxy input after fields with `undefined` values are removed. Direct tools and `mcpScript` show their complete argument objects.

Argument formatting is failure-safe: circular or otherwise non-serializable values fall back to a readable string representation. Expanded arguments are not subject to the collapsed preview line budget.

## Result Rendering

MCP results reuse the existing result pipeline rather than the adapter's compact or boxed components.

### Content Normalization

- Text blocks retain their order and are joined consistently with existing output helpers.
- Non-text MCP content is preserved as a readable placeholder such as `[image: image/png]` instead of being silently discarded. This normalization is confined to the MCP result path and does not change generic tool output behavior.
- ANSI handling and line preparation continue to use the existing shared utilities.

### Successful Results

- `hidden`: final successful result output is empty.
- `summary`: show the returned line count and the existing `Ctrl+O to expand` hint.
- `preview`: show up to `previewLines` with the existing omission and expansion hint.
- expanded: show normalized output up to `expandedPreviewMaxLines`; `0` keeps the existing unlimited behavior.

Backend truncation, full-output paths, and RTK compaction metadata continue to use the existing hint format and visibility settings.

### Partial Results

Partial MCP results use the existing concise `running...` presentation. They do not use the adapter-specific `Running MCP tool...` text or compact result component.

### Errors

MCP failures remain visible even when `mcpOutputMode` is `hidden`. They render an explicit failure header followed by the available error output, using the shared error theme and preview or expanded line limits. A result is treated as failed when `result.isError === true`, the render context reports `isError === true`, or `Boolean(details.error)` is true. Detection does not modify the result object.

### Expansion

`Ctrl+O` controls both call arguments and result expansion through the standard Pi render context. Expansion bypasses adapter collapsed limits but continues to honor `expandedPreviewMaxLines` for result content. Existing display-cap and backend-truncation hints remain visible.

## Data Flow

1. Pi constructs a `ToolExecutionComponent` with the registered definition.
2. The versioned prototype patch classifies `mcp`, `mcpScript`, direct wrappers, and configured custom tools from that component instance.
3. Non-matching tools delegate to Pi's original shell and renderer resolvers unchanged.
4. Matching MCP tools resolve the default shell plus the shared MCP call and result renderers.
5. Runtime calls continue through the untouched adapter-owned `execute` function.
6. Pi invokes the unified display callbacks for collapsed, partial, error, and expanded states.
7. Disposal restores Pi's original renderer-resolution methods.

If decoration fails, the error is logged through the existing debug logger and the original adapter renderer remains usable. A display failure must not prevent MCP execution.

## Implementation Scope

Primary changes are expected in:

- `src/tool-overrides.ts`: shared call formatting, MCP content normalization, error handling, and native renderer selection.
- `src/mcp-tool-execution-patch.ts`: versioned, reload-safe wrapping of Pi's renderer-resolution methods.
- MCP-focused tests under `tests/`: renderer behavior and registration lifecycle coverage.

A small shared helper may be extracted only when it directly removes duplication with an existing ordinary-tool formatter. No adapter source changes, new settings, or unrelated renderer refactors are planned.

## Tests

Add focused regression coverage for:

1. One-line collapsed headers for `mcp`, `mcpScript`, and direct MCP wrappers.
2. Nested proxy argument counts for object and JSON-string inputs, including no-argument and invalid inputs.
3. Expanded structured arguments with no collapsed JSON line.
4. Proxy `tool`, `connect`, `describe`, `instructions`, `search`, `server`, `action`, and status titles.
5. Direct labels beginning with `MCP ` and `MCP:`.
6. `renderShell: "default"` overriding an adapter-owned `"self"` shell.
7. Rendering of same-name replacement definitions and tools registered before or after extension load.
8. `hidden`, `summary`, and `preview` result modes.
9. Partial, error, collapsed, and expanded result states.
10. Expanded result caps, backend truncation hints, full-output paths, and RTK hints.
11. Non-text content placeholders, including image MIME types.
12. Prototype restoration and preservation of execution, schemas, prompt metadata, and adapter-owned renderer properties.

Existing non-MCP renderer tests must remain unchanged and passing.

## Non-Goals

- Changing MCP discovery, transport, authentication, execution, schemas, or result payloads.
- Modifying or publishing `pi-mcp-adapter`.
- Reproducing adapter compact or boxed result layouts.
- Adding MCP-specific colors or a second display configuration surface.
- Changing UI when `pi-tool-display` is disabled.

## Acceptance Criteria

- MCP calls visually align with existing tools such as `ffgrep`: one semantic title line, shared theme tokens, default shell, and no collapsed raw JSON block.
- All MCP tool forms use the same result modes and state handling as the rest of `pi-tool-display`.
- Hot-registered same-name direct tools receive the unified renderer.
- Expanded calls expose complete arguments, and expanded results remain available within the configured expanded cap.
- MCP execution behavior and prompt metadata are unchanged.
