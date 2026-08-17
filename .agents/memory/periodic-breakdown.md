---
name: Month Wise statement columns
description: Chart of Accounts Month Wise = month columns folded INTO the statements via one aggregated endpoint; series-key contract; superseded designs; traps
---

# Month Wise statement columns (Chart of Accounts)

Two earlier designs were **rejected by the user** — do not resurrect either:
1. A Tally-style KPI table (Sales|Purchase|Expense|GP|NP columns).
2. Collapsible per-period sections each repeating the full statements, with a Summary/Month Wise/Day Wise switcher. **Day Wise was removed entirely** per an explicit correction spec.

Shipped design (Aug 2026):
- ONE toggle button on the page (`coa-month-wise-toggle`). ON folds month columns (Account | Apr | … | Total) INTO the existing BS + P&L hierarchy — expand/collapse preserved, chart editing disabled while ON; OFF is byte-identical to the normal page. Months come from the existing period filter; the engine clamps the last month at today.
- Server: `GET /accounts/financial-statements/monthly` — enumerates months via `buildPeriodicBuckets` (cap 62 → 400), runs `buildBooks` **sequentially** per month, flattens to `series: Record<string, number[]>` keyed `n:<nodeId>`, `grp:capital|loans|curliab|fixed|curassets|direxp|indexp|dirinc|indinc`, plus scalars (`sales, salesReturns, purchases, purchaseReturns, openingStock, closingStock, bsClosingStock, pandl, liabTotal, assetsTotal, gp, np`). Same guard + branch-user LBAC as `/accounts/financial-statements`. Never a call per month/account from the client.
- Cell semantics: **P&L cells = month activity (Σ months == Total); BS cells = position as at month end (last month == Total — never sum a balance)**. Opening/closing stock per month are the engine's own telescoping boundaries; GP c/d rows split per month via max(±gp,0).
- Client: `StatementsView` takes an optional `monthly` prop; parallel read-only `Mw*` components render cells; monthly query key starts `['fin-stmt','monthly',…]` so the family prefix-invalidation covers it. Month cell → ledger sheet scoped to that month; Total/name → whole period. Sticky name column + ONE horizontal scroll region per panel (panels stack single-column in monthly mode). Banners get per-month chips (aligned columns impossible outside the scroll region).
- `buildPeriodicBuckets` still supports 'day' internally — dead but harmless; no route exposes it.

## Location scoping trap (found in review)
The CoA page's legacy outlet dropdown sent `outletId` — a param the statements route **never read**, so it silently did nothing. Scope must flow through the canonical `locationType`/`locationId` params (query beats the global-context headers server-side), and the SAME effective scope must feed the statements, the monthly columns AND the ledger sheet, or figures on one screen disagree.

## Traps (still current)
- Explicit JSX generics (`<RTable<Row> …>`) crash the vite parser.
- Whole-range parity is the regression contract: Σ month P&L == whole-range figures, BS last month == whole-range, OFF totals == ON Total column (verified to the paisa on live data).
