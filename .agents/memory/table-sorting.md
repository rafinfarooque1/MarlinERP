---
name: Table sorting infrastructure
description: Shared column-sort lib for all ERP tables — conventions every new/edited table must follow
---

# Table sorting (ERP-wide, Aug 2026)

All data tables in marlin-erp sort via `src/lib/tableSort.tsx`: `useTableSort(rows, accessors)` + `<SortableHead k=... sort=...>`. Tri-state: click asc → desc → back to the page's default order. Blanks always last; `Intl.Collator numeric` gives natural invoice ordering (INV0009 < INV0010); numeric strings incl. Indian grouping coerced; report tables use RTable in `reports/shared.tsx` which sorts internally (`Col.sortValue` override, `sortable:false` opt-out; default accessor is `row[key]`).

**Rules when adding/editing tables:**
- Sort the FILTERED render array; accessors return RAW values (never ₹-formatted strings or display dates); lookup-map values must be merged onto rows in the same memo, since accessors may only read the row.
- Footers/totals/opening-balance rows stay pinned outside the sorted array; mobile card lists read the same `sorted` array; action/expander columns = plain TableHead.
- Accessors are read via ref inside the hook — they are intentionally NOT memo deps.

**Why:** one shared comparator keeps Excel/Tally-grade semantics consistent; per-page hand-rolled sorts caused string-vs-number bugs.

**Intentionally not sortable:** HR Hierarchy (org tree), ChartOfAccounts (tree), Expenses ByLocationTab (two pinned sections), running-balance columns in Ledger statements (order-dependent), StockVerification new-count grid, dynamic-column RentManagement reports tab.

**Review false-positive trap:** a reviewer will claim `render: r => fmt(r.total)` columns sort the formatted string — they don't; RTable sorts `row[key]` (raw). Verify the row field type (API returns raw numbers / pg numeric strings) before "fixing".
