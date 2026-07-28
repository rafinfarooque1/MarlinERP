# Marlin ERP — Source of Truth Contract

This is the governing rule set for the enterprise restructure. Every task in the programme
must comply with it. Where existing code disagrees, the code changes — not the contract.

**Core rule:** for each concept below there is exactly **one** authoritative store and exactly
**one** function that derives figures from it. Anything else is a reader. No module may
maintain its own parallel copy, and no report may compute a figure a different way from
another report.

---

## 1. Inventory quantity

**Truth:** the per-location stock row, keyed by item type + item id + location.
**Lot detail:** the per-location batch rows, carrying batch number, manufacturing date,
expiry date and unit cost.

**Invariant that must always hold:**
> for every item type + item id + location, the stock row quantity equals the sum of its
> batch quantities.

Both are written inside the **same transaction**, always. The batch layer stops being a
partial overlay with an untracked remainder and becomes complete, because valuation and
expiry both depend on every unit belonging to a lot.

**Retired as sources — must not be read by anything:**
- the item-level production stock counter
- the global material stock number
- the global packing-material stock number

These exist today and disagree with reality. Reads are removed first, then writes; the
columns are left dormant and documented as dead rather than silently half-maintained.

**Transition order matters:** materials and packing materials have no location rows at all
today, so those rows are created and reconciled *before* their global columns are retired.

## 2. Stock movement audit trail

**Truth:** the append-only stock ledger.

**Rule:** *every* movement writes it — purchase, production consumption, production output,
sale, sales return, transfer dispatch, transfer receipt, transfer rejection, adjustment,
verification. In the same transaction as the movement, never fire-and-forget.

Currently the ledger holds 6 rows because sales, material purchases, production consumption
and stock verification all skip it. A ledger with holes is not an audit trail.

## 3. Costing

**Material unit cost — truth:** the material's weighted-average cost, rolled on every inbound
receipt.

> **This is the live defect.** Purchases write the weighted-average column. Production reads a
> *different*, never-written column, which sits at zero. Material cost, total cost and cost per
> unit therefore all compute to zero. One authoritative column, read by everyone.

**Produced batch cost — truth:** the batch's unit cost, set from the production run's computed
cost per unit.

**Batch cost formula:**
```
raw material + packing material + labour + overheads = total batch cost
total batch cost ÷ quantity produced = cost per unit
```

**Labour:** allocated from actual payroll. Daily employee cost derives from attendance, then
spreads across the batches that location completed that day, weighted by quantity produced or
production hours. Manual entry per batch is the fallback when no payroll exists. Allocated
amounts must sum **exactly** to the day's production payroll cost. Once statutory
contributions are enabled, allocate full employer cost, not gross salary.

**Never a cost:** MRP, selling price, or any price field. Cost and price are separate concepts
and must never substitute for one another.

## 4. Accounting

**Truth:** the chart of accounts, via the single shared derived-postings builder.

**Rule:** every financial figure — ledger balance, trial balance, profit & loss line, balance
sheet line, day book entry, GST return figure, receivable, payable, cash and bank balance —
comes from that builder. No endpoint queries source tables to produce a financial number.

**Currently violating and must be converted:** the profit & loss and balance sheet (which also
ignore journal vouchers entirely, so payroll never reaches them), the day book (which
re-implements the logic), the GST summary and returns, the dashboard totals, the profitability
report, and receivables aging (which computes from the sales table and so disagrees with the
customer ledger).

## 5. Profitability

**Truth:** derived from the accounting source and the valuation source, nothing else.

Gross profit, net profit, gross margin and net margin are computed once, in one place, and
read everywhere. No screen recomputes profit from raw sales and purchase rows.

## 6. Stock valuation

**Truth:** one shared valuation function — quantity from the stock layer, unit cost from the
batch layer, falling back to the item's weighted-average cost only where a lot genuinely has
no cost.

Covers **all three item types** across **all locations**, plus **in-transit stock**, which
today belongs to no location and is missing from every total.

Valued at **cost, never at MRP**. The profit & loss currently values closing stock at MRP and
reads it from a retired counter — both are corrected here.

The production report and the stock status report currently value the same item differently,
one from a batch-time snapshot and one from current average cost. After this, one function
serves both.

## 7. Dashboard and reports

**Truth:** dashboard widgets and all reports are **pure readers**. Each figure comes from the
accounting source, the valuation source, or the profitability source.

**Rule:** no widget and no report issues its own aggregate query against sales, purchases,
payments, receipts or stock tables. If two screens show the same concept, they call the same
function — so they cannot disagree.

Every report is location-filtered on the server, not in the browser.

---

## Automatic propagation

Every operational transaction — purchase, production, sale, return, transfer dispatch,
transfer receipt, rejection, expense, payroll — must, in **one transaction**, update:

1. inventory quantity and the batch layer
2. the stock ledger
3. the accounting source
4. and thereby valuation, profitability, dashboard and reports, because those are readers

No manual posting step. No scheduled reconciliation job. No screen that only refreshes on
demand.

## Duplicate posting — known traps

Each of these has already been verified as a live or imminent double-count. None may be
"solved" by adding a second store or a reconciling adjustment.

| Trap | Rule |
|---|---|
| Transfer journal vouchers **plus** new tax invoices | The invoice replaces the vouchers. Never both. |
| Expenses reachable via two tables | One route is authoritative; the other stops posting. |
| Sale-linked receipts | Deliberately excluded from one posting source. Do not "fix" this. |
| Payroll expensed **and** capitalised into inventory | Charge cost of production and credit the movement in stock, so a cost held in closing inventory is not also a period expense. Test: produce a batch, sell none, gross profit must not move. |
| Labour allocated across batches | Allocations must sum exactly to the day's payroll cost. |
| Same item counted in stock rows and batch rows | They are one quantity expressed two ways, reconciled by invariant — never added together. |

## Enforcement

The following must be checkable, not merely intended:

- Stock rows reconcile to batch rows for every item type, item and location.
- The trial balance balances, and the balance sheet balances **without** a plug figure.
- Trial balance, profit & loss and balance sheet agree with each other.
- Allocated labour equals the day's production payroll cost.
- Total valuation equals the sum of per-location valuations plus in-transit.
- No endpoint outside the shared builder produces a financial figure.
- The rendered sidebar is unchanged.
