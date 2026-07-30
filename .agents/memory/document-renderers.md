---
name: Document renderers must not compute
description: Rules for printable documents (invoices, payslips) — never re-derive a stored figure, and always bound the layout.
---

# A renderer prints; it does not compute

A printable document is a claim about what was *posted*. The moment a renderer
falls back to arithmetic, it can print a number the record never agreed to.

The trap looks harmless: `line.subtotal ?? qty * rate`. For every record written
by the current code the fallback is dead, so it never shows up in testing. It
only fires on the pre-feature rows nobody has in a dev database — in production,
on the oldest and most disputed documents.

**Why:** the fallback re-derives *one* component while the neighbouring
components (tax, discount, line total) stay absent and print as `0.00`. The
result is a document whose breakdown contradicts its own grand total.

**How to apply:**
- Decide per-document whether the stored lines are complete (`every(l => …)`),
  and branch once on that, rather than defaulting each field independently.
- When they are not complete: print `-` for the derived breakdown and fall back
  to the **document-level aggregates** the record itself stores.
- Distinguish "zero" from "not recorded". `Number(x ?? 0)` collapses them;
  a money cell needs an explicit null check so absent prints as `-`.
- Beware the inverse of a conditional row: `if (cgst > 0) …` with no `else`
  silently drops the tax line entirely for a bill that stored a tax total but
  no head-wise split. Every conditional breakdown needs a fallback row.

# Single-page documents need an explicit fit strategy

A payslip (or any "one page by contract" document) is a fixed vertical stack,
but the number of rows in it is data. Two rules:

- Measure the **fixed tail** (totals, words, signatures, footer) first, subtract
  it, and fit the variable rows into what is left: tighten the row pitch, then —
  only if that is not enough — fold the surplus into one summarised row that
  still carries the summed amount, so the column totals stay honest.
- **Type must follow the pitch.** A baseline offset that was fine at the default
  spacing overshoots its own row once the pitch is tightened, and the last row
  prints on top of the totals band. Scale the baseline and the font size with
  the pitch, not just the row height.

Taking `wrap(label, w)[0]` to force a single line silently deletes the tail of a
long name. Shrink-then-ellipsize instead, so the cut is visible.
