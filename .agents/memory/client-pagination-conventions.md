---
name: List pagination & entity picker conventions
description: How list pages paginate (TablePager/useClientPage) and how searchable entity pickers work (EntityCombobox) in the ERP web client.
---

**Rule:** every list page uses the shared `TablePager` + `useClientPage` (components/ui/table-pager.tsx) for client-paged full fetches, or passes a `pageSize` state into its server-paged hook. Plain `<Select>` pickers over entity lists (accounts, employees, materials, ledgers) are `EntityCombobox` (components/ui/entity-combobox.tsx — cmdk searchable, {id,label,sublabel}, clearable, 200-row cap).

**Why:** hand-rolled footers and unsearchable selects were swept once (Aug 2026); re-introducing bespoke ones re-fragments the UX the sweep unified.

**How to apply:**
- Paginate AFTER filter+sort: `useClientPage(sortedFilteredRows)`; the hook resets page on row-count change only (same-length filter changes keep the page — accepted).
- Totals, footers, and CSV exports must read the FULL filtered set, never the page slice. (The old Quotations page-scoped-CSV exception is GONE — Aug 2026.)
- SERVER-paginated/infinite pages must NOT export their loaded rows: exports one-shot the full filtered set via the fetchAll* helpers in lib/api-client-react, reusing the exact screen filters so file and screen can never disagree. (Those endpoints only return everything when page AND limit are both absent — limit:0 does not work there.)
- Pager auto-hides at ≤25 rows unless `alwaysShow`; sizes 25/50/100, default 50.
- Pages that need every row for totals/lot maps (e.g. Stock) keep `limit:0` full fetch and page only the rendering.
- POS customer picker and AccountCombobox were already searchable — leave them; EntityCombobox is for the generic cases.
