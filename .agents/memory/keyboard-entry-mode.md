---
name: Keyboard Entry Mode
description: Tally-style mouse-free entry conventions across all ERP entry forms — shared machinery, attributes, and the traps hit while building it.
---

# Keyboard Entry Mode (all entry forms)

All entry forms (Journal, Contra, Notes, Expenses, SalesExpenses, MoneyVoucherPage, Sales, Quotations, Transfers, Production, Purchases) share `src/lib/keyboard-entry.tsx`. Purchases keeps its earlier bespoke Enter-walk (sanctioned; do not restructure) and only consumes the shared shortcuts.

## Conventions (must be honored by any new entry form)
- `data-kbd-scope` on the form wrapper + `onKeyDown={entryScopeKeyDown({...})}`; `useEntryShortcuts(open, {...})` adds document-level Ctrl+S/Ctrl+P/Ctrl+Enter/F4 while the form is open (scope-only handlers miss the keys when focus wanders — Ctrl+S then triggers the browser save dialog).
- `data-kbd-row={i}` on line rows; `data-last-field="1"` on the LAST row's final editable input (Enter there = add line); row X buttons get `tabIndex={-1}`; `data-kbd-ignore` exempts embedded widgets (BatchPicker, inline cmdk customer search); `data-kbd-first` overrides the auto-focus target; `data-field` + `focusField()` for validation-error focus.
- Pickers: `advanceOnSelect` (opt-in prop on AccountCombobox/SearchableItemSelect) advances focus after a pick via `onCloseAutoFocus` preventDefault + `advanceFrom(trigger)`. Esc/outside-click still return focus to the trigger.
- Enter keeps native meaning in textareas, buttons, and cmdk popovers (handler skips `e.defaultPrevented` and non-plain-input targets).

## Traps learned
- **cmdk v1 needs `CommandList`**: CommandGroup without CommandList renders fine but arrow/Enter navigation is dead (nothing highlights, Enter no-ops). AccountCombobox had exactly this bug.
- **Double-submit race**: an `isPending` check is NOT enough — two rapid Ctrl+S events both pass before React Query publishes pending. Forms whose onSubmit lacks a second guard need a synchronous `submitLockRef` (set before mutate, released in `onSettled`). Place it AFTER validation early-returns so a failed validation never wedges the lock.
- **Esc layering is correct by design**: first Esc closes only the open popover/select (Radix dismisses topmost layer only); a second Esc closes the dialog (spec behavior). Testers reporting "Esc closed the whole dialog" usually pressed it when no popup was open.
- Native date inputs garble a typed "YYYY-MM-DD" string — automation must fill() them or type per displayed segment order.
- Radix Select opens on pointerdown, Popover on click (see radix-programmatic-focus.md) — `focusAndOpen` covers popovers; Selects need the Purchases pointerdown-dispatch helper.

**How to apply:** any new entry dialog/page must wire the same attributes + both handlers, opt its pickers into `advanceOnSelect`, and use the sync submit lock unless its onSubmit already re-guards.
