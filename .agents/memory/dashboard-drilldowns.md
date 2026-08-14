---
name: Dashboard drill-downs & tile-report parity
description: KPI tile → filtered report navigation convention, and the parity contract proven by tests
---

Every dashboard KPI tile navigates to its source report with the SAME filters,
and the tile's figure must equal that report's total.

**Drill URL convention** (`reports/shared.tsx`):
- `/reports/<cat>?view=<subreport>&range=<preset>[&from=&to=][#anchor]`.
- Section roots read `?view=` in their `useState` initializer via
  `reportViewFromUrl(valid)`; `useDateRange` reads `?range/from/to` the same
  way. A mount effect then strips the params with `history.replaceState`
  (keeping the hash) so refresh/back don't resurrect them.
- **Location is never in the URL** — the global `x-location-*` headers already
  follow the user into every report, so the slice carries over automatically.
- P&L rows have stable ids (`pl-cogs`, `pl-gross-profit`, `pl-net-profit`) that
  the hash effect scrolls to and highlights.

**Parity contract** (proven in `tests/dashboard-parity.test.mjs`, read-only
probe-user suite): EVERY clickable tile equals a control its drill target
displays. The non-obvious mappings, forced by a completion review:
- Payments/Receipts (cash+bank flows) → a COMBINED Cash & Bank book view (the
  cash book alone excludes bank movements and can never reconcile).
- Payables (creditors + accrued salary + accrued rent) → the Balance Sheet
  liabilities table, whose three lines the tile sums — NOT vendor-only ageing.
- Expenses (P&L direct+indirect) → the P&L itself via a memo statement row,
  NOT the operational expense report (a different measure).
The rule: if no existing report displays the tile's exact figure, add a thin
view/memo row that does — never leave a tile pointing at a near-miss report.
When adding a tile, extend that suite — the tile must read the SAME slice as
the report it opens, never a re-sum.
