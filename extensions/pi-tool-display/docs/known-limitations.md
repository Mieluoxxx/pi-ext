# Known Limitations

## Long logical lines can produce oversized previews

**Status:** Confirmed, deferred.

### Observed behavior

Some tools return JSONL, minified data, generated records, or other output where a single logical line is thousands of characters long. A collapsed renderer can limit the result to a small number of logical lines and still occupy most of the terminal after Pi's `Text` component wraps those lines to the available width.

The observed `ffgrep` case displayed up to 15 logical lines before wrapping. Because each matched session record was a long JSONL line, those 15 lines expanded into many terminal rows. The `limit 50` call argument controls the maximum number of search matches; it is not a display-height limit.

### Display ownership

`ffgrep` is registered by `@ff-labs/pi-fff` and keeps its native renderer unless it is explicitly listed in `customToolOverrides`. The observed output was therefore not rendered directly by `pi-tool-display`.

`pi-tool-display` nevertheless has the same latent limitation in its generic, MCP, and read preview paths: `previewLines` limits logical lines before the TUI performs width-dependent wrapping. Bash `opencode` output has an additional `bashCollapsedMaxChars` budget, but the shared preview paths do not currently have a rendered-row budget.

### Workarounds

An explicitly configured custom override can hide the result or reduce it to a summary:

```json
{
  "customToolOverrides": {
    "ffgrep": {
      "enabled": true,
      "kind": "generic",
      "outputMode": "summary"
    }
  }
}
```

Use `"hidden"` instead of `"summary"` when no inline result is needed. `"preview"` does not avoid the long-line problem because it still applies only a logical-line limit.

The current generic override also replaces the tool's native call renderer, so the richer `ffgrep /pattern/ in path limit N` title becomes a generic tool-and-argument-count title.

### Deferred direction

A general fix should introduce a width-aware bounded preview component for generic, MCP, and read results. It should:

- calculate output during `render(width)` rather than before the terminal width is known;
- wrap or truncate ANSI-styled text without splitting escape sequences, wide characters, or surrogate pairs;
- enforce both logical-line and rendered-row budgets, with an optional character budget as a secondary guard;
- reserve space for an omission and expansion hint;
- distinguish omitted logical lines from the unrendered remainder of a partially displayed long line;
- allow result-only custom overrides so a tool can retain its native `renderCall` presentation.

Regression coverage should include a single 10,000-character JSONL line at narrow and wide terminal widths, ANSI-styled and wide-character content, collapsed and expanded states, accurate omission hints, and preservation of the native call title.
