---
name: P&L returns split & GP/NP tiles
description: How sales/purchase returns are surfaced for the standard trading statement, and why the dashboard GP/NP tiles can never drift from the P&L.
---

## GP/NP dashboard tiles
The rule: any dashboard profit figure must be read off `buildBooks().profitAndLoss.summary` (via `companyFinancials().profit`), never recomputed from tiles or source tables.
**Why:** GP = revenue − COGS where revenue INCLUDES direct incomes and COGS nets opening/closing stock; any re-derivation (e.g. sales tile − purchases tile) disagrees with the P&L for every range with stock movement. Reading the P&L's own summary makes reconciliation a construction guarantee, not a test outcome.
**How to apply:** `/dashboard/bi` exposes `profit {gross, net, companyWide}`, null exactly when the other accounting figures are null (non-HO scope without a posting location). Same pattern as the Expenses tile.

Profit figures are only presentable when both period stock boundaries are evidenced. If opening or closing stock is unreliable, expose GP/NP/COGS as unavailable in dashboard and statement surfaces; do not present the partial arithmetic as profit or substitute a sales-based approximation.
**Why:** inventory is part of COGS, so a mathematically calculated profit using incomplete stock values can show large GP with zero sales. Existing integrity warnings do not make that number safe to present as a fact.
**How to apply:** gate profit presentation on opening-stock reliability and actual closing-evidence reliability (not the historical-view display flag, which is false for every rewind). Preserve the warning and require source-backed evidence to restore the figures.

Scope subtlety when verifying: the dashboard treats an `x-location-type: headoffice` header as company-wide (`postingLoc` null), while financial-statements treats the same header as the HO slice. Compare company-wide with NO header, or slices with warehouse/outlet headers — a "mismatch" under an HO header is a test artifact, not a bug.

## Returns split (Sales / Less: Returns / Net Sales)
Statement groups net returns into their totals — a credit note debits the sales subtree, a debit note credits purchases — so gross/returns cannot be read off group totals. buildBooks recovers the split by summing the period's postings with `source === 'credit_note'` on the SYS-SAL subtree (dr−cr) and `source === 'debit_note'` on SYS-PUR (cr−dr). Identified by posting source, never re-classified. Exposed as `incomes.grossSales/salesReturns`, `expenses.purchaseReturns`.
Caveat: a note whose counter ledger is OUTSIDE the sales/purchases subtree counts in neither figure — arithmetically consistent (it didn't move sales), but it means "Sales Returns" only covers notes actually posted against sales.

## Statement presentation must be remainder-based
When splitting a display line out of a group (e.g. Financial Charges / Depreciation out of Indirect Expenses by ledger-name match), always compute the residual line by subtraction from the group total. Then the statement ties to Net Profit regardless of how the split classifies. Never sum picked nodes into an independent total.

Drill-down: dashboard GP/NP tiles navigate to `/reports/financial#pl-gross-profit|#pl-net-profit`; the P&L scroll-highlights the row (ids on statement rows, effect keyed on load).

## Two-sided (T-form) presentation
When rendering Trading/P&L as balanced debit/credit panels (Chart of Accounts page), each account needs its balancing carry-down row on the lighter side (GP c/d on trading debit when profit, credit when loss; GP b/d mirrored in the P&L account) and the panel header totals must include it — otherwise the two sides visibly differ by exactly GP. Returns rows (gross / Less: returns / net) render only when returns ≠ 0; `sales`/`purchases` fields arrive NET, gross = net + returns.
