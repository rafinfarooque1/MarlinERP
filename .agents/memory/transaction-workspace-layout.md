---
name: Transaction workspace dialog layout
description: The two-column wide-dialog convention for POS/Quotation entry forms; apply to future transaction dialogs.
---

# Transaction workspace dialog layout

The POS "Record Sale" and Quotation dialogs are wide two-column workspaces, settled Aug 2026:

- Dialog width `sm:max-w-6xl`; inside the `<form>`: `lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(21rem,24rem)]`.
- LEFT column = the entry flow in its ORIGINAL DOM order (header/receive/coupon/items/charges). Never reorder sections — tab order and keyboard-entry rows depend on it.
- RIGHT column = summary card + `DialogFooter` (still inside the form so submit works), `lg:sticky lg:top-0`; footer gets `lg:pt-0 lg:border-t-0`.
- Line-item rows: NO horizontal scroll wrappers. Rows are `grid grid-cols-2 sm:grid-cols-12` with per-cell `col-span-1 sm:col-span-N` (spans must total 12); trailing delete cell `hidden sm:flex`, plus a `sm:hidden` delete button beside the item picker for mobile.
- Editable price label is "Rate (₹)" with an "MRP min ₹X" hint; a per-line info line under the item picker shows SKU · MRP · per-unit · GST%.
- SearchableItemSelect trigger wraps long names globally (`h-auto min-h-8 whitespace-normal` appended AFTER caller className — twMerge lets the later class win) and its search filter matches `barcode` (scanner wedge = digits + Enter → first match).

**Why:** spec §74 mandated no sideways scrolling at any width and a visible running summary; two-column-without-moving-DOM was chosen to keep RHF registration, dirty guard, and keyboard-entry untouched.

**How to apply:** any new transaction entry dialog (or a rework of Purchase into a dialog) should reuse this exact pattern rather than inventing a new layout; verified by e2e at 1440x900 and 390x844.
