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

## 1a. Reserved quantity

**Truth:** the reservation ledger — one row per commitment against stock, never a counter on
the stock or batch row. Reserved quantity is always summed from active rows; a mirrored
column would be one more thing that can drift.

> **Rule:** on-hand quantity is not availability. Everything that consumes stock compares the
> request against **available = on hand − active holds**, and refuses in one shared wording
> that names both figures. A check that reads the raw quantity is a double-promise waiting to
> happen.

Two kinds, and the difference is load-bearing:

| Kind | Goods are… | Reduces available? | Valued as |
|---|---|---|---|
| `hold` | still on the shelf, committed to a document that has not shipped | **yes** | the holder's on-hand stock |
| `in_transit` | already deducted from the sender at dispatch | **no** — subtracting twice would double-count the dispatch | the **sender's** stock until received |

Reservation and the movement it accompanies share **one transaction**, and availability is
read with the stock row locked — otherwise two requests both pass the check before either
deducts. Release is by document and idempotent: receiving, fulfilling, cancelling or
rejecting releases the whole document's rows, so a retried callback cannot free stock twice.

**A commitment is released only when it is actually resolved.** Where a receipt comes up short
of what was dispatched, the difference stays an active in-transit commitment owned by the
sender — unreconciled and visible — because the sender's stock is already gone and releasing it
would erase those units from every location and every total at once. Whether that shortfall is
a loss, a theft or a late delivery is a business decision; the system refuses to guess.

**`hold` has no producer yet.** The system has no order concept — no sales order, quotation or
requisition — and sales deduct stock at the moment they are recorded, so nothing today can
promise stock it has not yet taken. The kind is implemented and enforced at every consumption
point so the day an order document exists it is honoured without revisiting those call sites.

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

> **Fixed.** Purchases roll the weighted-average column; production used to read a *different*,
> never-written column, so material cost, total cost and cost per unit all computed to zero.
> Every reader now resolves cost as weighted-average first, falling back to the legacy column
> only when the average is zero. Any new query that reads a material cost must do the same —
> and must actually **select** the weighted-average column, or it silently reports zero again.

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

## 4a. Money vouchers and location ownership

**Truth:** the payment and receipt vouchers themselves, and the location that owns them.

**Rule:** a voucher belongs to a location when it is stamped with that location **or** when one
of its two legs is a ledger that location owns. Ownership is decided in one place; no handler
writes its own location filter. A branch may only move money through its own cash ledger — never
another location's ledger, and never a Head Office cash or bank account.

**Rule:** money vouchers use an **own-location** scope, deliberately narrower than the scope used
for stock and sales. Supplying an outlet is a stock relationship, not a shared wallet. Sales and
purchases shown inside a ledger statement keep the wider scope.

**Payment modes have one canonical list:** Cash, Bank, UPI, Credit. Only Credit creates a
receivable; everything else is settled when the sale is recorded. Cash lands in the location's
own cash ledger, Bank and UPI in Electronic Payment Clearing until a bank settlement is matched.
Historical `card` and `bank_transfer` rows mean Bank; they are displayed as Bank and never
rewritten, and any filter offering Bank must match them too.

**Invoice delivery:** one PDF renderer, reached through a signed public link. Message text and
delivery channel live outside the renderer, so adding a channel that attaches the PDF never
touches the invoice itself.

## 5. Profitability

**Truth:** derived from the accounting source and the valuation source, nothing else.

Gross profit, net profit, gross margin and net margin are computed once, in one place, and
read everywhere. No screen recomputes profit from raw sales and purchase rows.

## 6. Stock valuation

**Truth:** one shared valuation function — quantity from the stock layer, unit cost from the
batch layer, falling back to the item's weighted-average cost only where a lot genuinely has
no cost.

> **Implemented.** One function now serves the stock valuation report, the dashboard stock
> tile and the profit & loss closing stock. It covers **all three product kinds** across
> **all locations**, and appends **in-transit** rows valued at the cost they were dispatched
> at, owned by the sender. Every roll-up (per location, per kind, per product) comes from the
> same row set, so a drill-down always sums to the headline. Any new stock figure calls this
> function — a fresh `SUM(quantity * cost)` is a defect, not an optimisation.

Valued at **cost, never at MRP**. The profit & loss used to value closing stock at MRP and read
it from a retired counter — both are corrected.

> **Closing stock moved, and so did reported profit.** It now includes raw and packing
> materials and in-transit goods, and is priced at cost. That is the correct figure, but it is
> not the figure last month's screen showed; the in-transit portion is reported separately so
> the change is auditable rather than mysterious.

## 6b. Inventory ageing

**Truth:** one ageing module. Expiry tiers (7 / 15 / 30 / 60 / 90 days, plus *expired* and
*no expiry date*) and movement classes (fast / slow / dormant / dead) are defined once as data,
never as literals scattered through SQL, so a report, a tile and a future alert cannot disagree
about what "near expiry" or "dead stock" means.

A lot falls in the **narrowest** tier it qualifies for, so it is counted exactly once. A lot
with no expiry date is its own bucket — a data gap, not a fresh lot.

Movement class is measured from the last **outbound** movement in the stock ledger: receiving
more of something that never leaves does not make it alive. Stock with no ledger history at all
is reported as such, alongside the date the ledger began, rather than presented as neglected.

## 6a. Product identity

**Truth:** the product master row — the item code, barcode and active/inactive status on the
finished-SKU, raw-material and packing-material tables. One code and one barcode per product,
issued from a per-type sequence so a number is never reused.

**Rule:** identity is issued in exactly one place. No module invents its own code format, and
nothing derives a code from a display name or a row count.

**Batch identity is a snapshot, not a second source.** A lot copies its parent's barcode and
the MRP that applied when the lot was created, so a historical lot keeps the price it was
made under. Reads may fall back to the parent's current MRP for display, but a lot's stored
MRP is never rewritten after the fact, and an unpriced lot reads as *no MRP* — never as zero.

**Status governs new activity only.** An inactive product is refused on new sales, purchases,
transfers and production runs. It stays fully readable, keeps its history, and open documents
that already reference it can still be edited, approved, dispatched, received, rejected and
paid to a terminal state.

**Item master writes are Head-Office-only**, enforced on the server. Reads stay open to every
location, so warehouses keep full visibility of what they hold.

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
| Production capitalisation voucher **plus** closing stock | Production now posts a real journal voucher (finished-goods inventory debited, production absorbed credited) inside the stock transaction. The profit & loss does not read journal vouchers yet, so it is invisible there today. The moment statements read vouchers, the absorbed credit **and** the closing-stock credit describe the same batch: take the batch through closing stock, not through both. |
| Closing stock values finished goods only | Raw and packing material stock is not valued, so consuming material reduces profit even though nothing was sold. Producing therefore moves profit on its own. Valuation must cover all three item types before profitability can be trusted. |
| Labour allocated across batches | Allocations must sum exactly to the day's payroll cost — including when two batches are recorded at the same moment. Locks are taken in one order everywhere: day+location labour lock (sorted by date), then the per-item lock, then row locks. Reversals read their lines from a row locked inside the transaction, never from a snapshot taken before it. |
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
