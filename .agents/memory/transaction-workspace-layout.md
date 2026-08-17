---
name: Transaction window layout (Purchase-master)
description: The shared stacked layout for all transaction entry surfaces (Purchase page, POS Record Sale, New Quotation); supersedes the two-column workspace convention.
---

# Transaction window layout — Purchase page is the MASTER design

Settled Aug 2026 (user correction spec, replacing the earlier two-column "workspace" convention): the Purchase → New Purchase Bill page defines the ONE transaction-entry design. POS "Record Sale" and "New Quotation" dialogs reuse it exactly; Purchase's appearance must never drift.

- Shared primitives live in `components/app/transaction-window.tsx`: TXN_CARD, TXN_HEADER_GRID, TXN_LINES_BOX, `txnLinesHead(gridLg)` / `txnLineRow(gridLg)` builders, TXN_SUBROW (per-row breakdown strip), TxnCellLabel, TXN_BOTTOM_GRID + TXN_SUMMARY_CARD, and action-bar variants (page vs dialog — the dialog one is sticky with negative margins matching dialog padding). Restyle in ONE place; never fork these strings back into pages.
- Structure per surface (stacked, single column — no side summary): header card → lines card (column header strip + grid rows + per-row TXN_SUBROW) → Other Charges card → TXN_BOTTOM_GRID with summary card right-aligned → sticky action bar (total left, Cancel + submit right).
- Each surface passes its own `lg:grid-cols-[...]` column template to the builders (sale has an MRP column; quotation shows MRP only as a hint under Rate).
- No horizontal scrolling at any width; names wrap; below `lg` rows stack into labeled cells with a delete button beside the item picker (`lg:hidden`) and the trailing delete `hidden lg:inline-flex`.
- Kept from the retired workspace layout: barcode search in the item picker, MRP floor snap-back, wrapping picker trigger.
- **Outside-click NEVER closes a TransactionDialog** (dirty or clean) — `transaction-dialog.tsx` preventDefaults onInteractOutside unconditionally; Escape/✕/Cancel still route through the dirty-discard confirm. This is global to every TransactionDialog.

**Why:** the user rejected the two-column workspace and mandated the Purchase page as the single visual system for all three surfaces, with zero business-logic changes (RHF wiring, testids, keyboard-entry attrs untouched).

**How to apply:** any new transaction entry surface must consume `transaction-window.tsx` primitives with its own column template — never invent a new layout and never restyle Purchase independently. Verify e2e at 1440/768/390.
