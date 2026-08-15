# Bash Collapsed Character Limit

## Goal

Prevent one extremely long physical output line from expanding into a full terminal viewport while preserving the existing collapsed Bash output workflow.

## Configuration

Add `bashCollapsedMaxChars` to `ToolDisplayConfig`.

- Default: `2000`
- Accepted range: `0` through a bounded positive integer
- `0` disables the character limit.
- The value applies only to unexpanded successful Bash output and live partial Bash output.
- The limit does not apply to expanded output. In particular, OpenCode Bash output continues to show all lines when expanded; this change does not alter that behavior.

The setting is persisted through the existing config store and is surfaced in the settings inspector next to `bashCollapsedLines`. Preset equality and preset-derived config must include the new field.

## Rendering Behavior

Collapsed Bash output continues to observe `bashCollapsedLines`. It will also observe `bashCollapsedMaxChars`; rendering stops at whichever budget is exhausted first.

The character budget is calculated after ANSI sanitization and counts Unicode code points. It must not split ANSI escape sequences or UTF-16 surrogate pairs. Newline separators are not counted because the budget is applied to the rendered text content of each output line.

When the character budget is exhausted:

- Render only the character-budget prefix of the final visible line.
- Append an expandable omission hint that reports the number of hidden characters.
- Retain the existing remaining-line hint when the line budget also hides complete lines.
- Show both omission facts when both limits are exceeded.

The full raw output remains available to the model and to the expanded renderer.

## Implementation Scope

- `src/types.ts`: configuration field and default.
- `src/config-store.ts`: load, normalize, and clamp the persisted field.
- `src/config-modal.ts`: inspector control and persisted update path.
- `src/presets.ts`: preset values and equality detection.
- `src/tool-overrides.ts`: Bash-only collapsed preview truncation and combined omission hint.
- A small focused helper may be added where existing rendering helpers make its ownership clear.

No changes are planned for Zentui, MCP rendering, non-Bash tool renderers, raw tool execution, or expanded Bash output.

## Tests

Add regression coverage for:

1. A single physical line longer than 2000 visible characters collapses and offers expansion.
2. Multiple lines respect whichever of the line and character limits is reached first, including both limits being exceeded.
3. Live partial Bash output follows the same character budget.
4. ANSI-styled output and non-BMP Unicode are truncated without leaking control sequences or splitting surrogate pairs.
5. `bashCollapsedMaxChars: 0` leaves collapsed output character-unlimited.
6. Expanded Bash output bypasses the collapsed character cap.
