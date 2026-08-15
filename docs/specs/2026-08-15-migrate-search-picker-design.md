# Migrate Search Picker Design

## Goal

Replace the `/migrate` scan-mode group picker with a TUI picker that supports
Neovim-style search activation: press `/` to open a query input and filter old
project paths while keeping the existing migration and confirmation flow.

## Scope

- Add `extensions/pi-session-migrate/src/picker.ts`.
- Use the picker only when scan mode finds multiple dangling-project groups.
- Keep explicit-path migration, claim annotations, confirmation, and copying
  behavior unchanged.
- Keep the existing `ctx.ui.select()` flow outside TUI mode.

## Component Design

`picker.ts` will expose:

- A pure `filterMigratePickerItems(groups, query)` helper for case-insensitive substring
  matching against each group's `oldCwd`.
- A pure selection-state helper that clamps the selected index after filtering
  or navigation.
- A `pickSearchableMigrateGroup(displays, ctx)` TUI adapter that returns the selected
  display or `undefined` when cancelled.

The TUI adapter will compose Pi TUI primitives instead of importing Pi's
private selectors. It will use `Input` for search text and propagate focus to
that input so terminal IME candidate placement remains correct. Rendered lines
will use width-safe truncation helpers.

The existing `GroupDisplay` representation remains the single source for the
old path, session count, and claim marker. Search does not affect ordering:
the scan's existing session-count order is preserved among matches.

## Interaction

Normal mode:

- Show the same project rows as the current picker.
- `/` enters search mode and reveals an input line prefixed with `/`.
- `Up` and `Down` move through visible rows.
- `Enter` selects the highlighted group.
- `Escape` cancels the picker.

Search mode:

- Printable input updates the query and list immediately.
- Filtering is case-insensitive substring matching over `oldCwd`; this also
  naturally matches a project basename contained in that path.
- `Up` and `Down` navigate only matching rows.
- `Enter` selects the highlighted match when one exists.
- The first `Escape` clears the query, exits search mode, and restores the full
  list. A second `Escape` cancels the picker.
- Empty matches display `No matching projects` and cannot be selected.

When there is exactly one scanned group, the current direct confirmation flow
is retained. The command does not open a picker merely to search one result.

## Error Handling And Compatibility

The search picker is TUI-only. In RPC, JSON, and print modes, multiple groups
continue through `ctx.ui.select()` so the extension does not depend on custom
terminal rendering. The picker does not mutate session storage, and selection
still proceeds to the existing confirmation dialog before migration.

## Tests

Add focused unit tests for pure helpers and state transitions:

- Empty query returns every group in original order.
- Queries match full paths and project-directory names without case sensitivity.
- No-match queries produce no selectable result.
- Filtering and navigation clamp selection safely.
- `/`, first `Escape`, second `Escape`, `Enter`, and arrow-key behavior are
  covered through a small picker state model without terminal integration.

Run the extension typecheck and Vitest suite after implementation.

## Design Review

The scope is limited to selecting a scanned project group. It introduces no
new persistence, third-party dependencies, migration rules, or search syntax;
the existing Pi TUI package is declared directly. The first
Escape behavior is explicit to distinguish clearing a search from cancelling
the entire migration action.
