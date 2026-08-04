---
name: Radix programmatic focus chaining
description: How to programmatically open Radix Select/Popover triggers and chain focus between them (keyboard-first line entry grids) without the components fighting back.
---

# Programmatically driving Radix triggers & chaining focus

Built for the Purchase Bill keyboard workflow (Add Line → category Select auto-opens → close advances into the item-picker Popover). Three traps, each found the hard way:

1. **Different triggers open on different gestures.** A Radix `Select` trigger opens on `pointerdown`; a `Popover` trigger (e.g. the SearchableItemSelect combobox) opens on `click`. Dispatch exactly the one gesture the target listens for — sending both toggles twice. For robustness across Radix versions, try `pointerdown` → `keydown ArrowDown` → `click()`, checking `aria-expanded` between attempts (discrete events flush synchronously in React 18, so the check is reliable).

2. **Chaining "when X closes, open Y" must go through `onCloseAutoFocus`.** Doing it from `onOpenChange(false)` + `setTimeout` loses a focus war: Radix restores focus to its own trigger *after* your timer, and the popover you just opened dismisses itself on focus-outside. Instead, on the content: `onCloseAutoFocus={e => { e.preventDefault(); /* advance */ }}`. Also: do NOT hang the advance on `onValueChange` — re-picking the already-selected value fires no value change.

3. **Escape-close needs a one-tick defer anyway.** Opening the next popover synchronously inside `onCloseAutoFocus` lets the same Escape keystroke reach the new popover's dismiss layer (document-level listener registered mid-dispatch still receives the bubbling event) and shut it. `e.preventDefault()` synchronously, then `setTimeout(0)` the open.

**Flag hygiene:** an "auto-advance on next close" flag must be row/target-scoped (store the trigger's testid, compare in the handler), set only after a *verified* open (`aria-expanded` check), and cleared when the dialog closes — a bare boolean leaks and hijacks a later manual interaction.

**Targeting appended rows:** never capture `fields.length` for a deferred lookup; resolve after the DOM update by taking the LAST `[data-testid^="prefix-"]` match.

**How to apply:** any grid/dialog wanting Tally-style keyboard entry (Enter-as-Tab, auto-open next control). Also pair with: `preventDefault` plain Enter on line inputs so implicit form submission can't save a half-typed document.
