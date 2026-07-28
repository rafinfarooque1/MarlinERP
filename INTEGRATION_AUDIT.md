# Marlin ERP — End-to-End Integration Audit

Audit date: 28 July 2026. Performed against the live database and codebase, before any
code was written. Every finding below is evidence-backed, not inferred.

**Verdict:** the module *boundaries* are sound — one chart of accounts, one batch layer, one
permission registry, one navigation registry. But the modules do **not** currently agree with
each other. There are two separate "single sources of truth" that have drifted, and the
financial statements read from stores no other module maintains.

Nine of these conflicts would have broken the approved plan if we had started coding. The
plan has been revised accordingly.

---

## A. Stock has no single source of truth

Stock quantity lives in **five** places: `items.production_stock`,
`raw_materials.current_stock`, `materials.current_stock`, `stock_entries`, `stock_batches`,
with `stock_ledger` as the intended audit trail.

### A1 — CRITICAL: `items.production_stock` has silently gone stale

Live comparison of the three finished-goods stores:

| Item | `items.production_stock` | `stock_entries` | `stock_batches` |
|---|---|---|---|
| Strawberry | **76** | 535 | 567 |
| Frozen Strawberries 500g | **0** | 571 | 567 |
| Frozen Mango Chunks 1kg | **0** | 625 | 625 |
| Frozen Mixed Berries 250g | **0** | 292 | 292 |
| Frozen Pineapple Slices 500g | **0** | 528 | 528 |
| Frozen Sweet Corn 500g | **0** | 838 | 838 |

Purchases and production update `items.production_stock`, but **sales never reduce it**. It
has decayed into a meaningless number.

### A2 — CRITICAL: the Profit & Loss reads that stale column

Closing stock in the P&L is built from `items WHERE production_stock > 0`. So closing stock
is computed from **76 units** when roughly **3,389 units** actually exist — and those 76 are
valued at **MRP (selling price)**, not cost. Both errors are in the same figure.

### A3 — CRITICAL: raw and packing materials have no location at all

`stock_entries` and `stock_batches` contain **only** finished-goods item IDs (23 of 23 and 33
of 33 rows resolve to `items`). Raw and packing materials exist as a single global number:
`raw_materials.current_stock = 9`, `materials.current_stock = 99`.

**This blocks warehouse production.** A warehouse cannot "consume raw materials from its own
stock" because there is no per-warehouse raw-material stock — there is one shared pool. It
also means raw materials get **no batch, no manufacturing date and no expiry tracking**,
which for frozen fruit is exactly where expiry matters most.

**Partially addressed.** Purchases and production runs now carry a location, materials land in
that location's stock and lot layer, and batch number, manufacturing date and expiry are
mandatory on every purchase line, whatever the line's kind. The **master-level** counters
(`raw_materials.current_stock`, `materials.current_stock`) are still a single global pool; per-
location material valuation belongs to the stock phase.

### A4 — Batch totals have already drifted, in both directions

Strawberry holds 567 units in batches against 535 in entries — a **surplus of 32** that the
design does not allow for. The batch layer tolerates *fewer* batch units than stock units
(the "untracked residual" fallback), but never more. Item 2 drifts the other way, by 4.
Reserved-stock enforcement computed on top of this would be wrong from day one.

### A5 — Sales never write the stock ledger

Sale creation and edits update `stock_entries` and `stock_batches` but write **no**
`stock_ledger` row. The whole ledger contains **6 rows** and not one sale. Any stock movement
report built on it would be materially incomplete.

### A6 — Sales returns do not restore batches

A return puts quantity back into `stock_entries` but not into `stock_batches`, so returned
stock silently becomes untracked residual and widens the A4 drift with every return.

---

## B. Accounting has multiple sources of truth

`buildDerivedPostings()` is the intended shared builder, and the Trial Balance uses it. Most
other financial outputs do not.

### B1 — CRITICAL: the P&L and Balance Sheet ignore every journal voucher

The financial-statements endpoint reads `expenses`, `payments` and `receipts` — but **not**
`journal_voucher_lines`. Payroll posts as a journal voucher. Therefore **payroll appears in
the Trial Balance but not in the Profit & Loss.** The two reports cannot agree today. Any new
posting we add as a voucher (production costing, transfer tax) would be invisible to the P&L
for the same reason.

### B2 — The Balance Sheet forces itself to balance

It carries a `difference` line that absorbs any imbalance, so a genuine bookkeeping error
would be hidden rather than reported.

### B3 — Opening balances are empty

`opening_balances` has **0 rows** and opening stock is hardcoded to zero, so a Balance Sheet
would reflect only movement recorded in this system — it cannot match your real accounts.

### B4 — Day Book, GST returns, dashboard and profitability each re-implement their own totals

Day Book re-derives postings independently of the shared builder. GSTR-1, GSTR-3B and the GST
summary sum `sales`/`purchases` directly. The dashboard sums `payments`/`receipts` in place.
Each is a separate opportunity to disagree with the books.

### B5 — Production posts nothing to the accounts — **FIXED**

Production moved stock and wrote the stock ledger but created **no** accounting entry, so the
value converted from raw material into finished goods never reached the ledgers.

Production now posts a journal voucher inside the same transaction as the stock move:
finished-goods inventory debited with the batch cost, production absorbed credited. Editing a
batch re-posts, deleting it posts a reversal, and re-spreading a day's labour across sibling
batches posts the adjustment. **Caveat carried forward:** the profit & loss and balance sheet
still ignore journal vouchers (B1), so this posting is invisible in the statements today. When
B1 is fixed, the absorbed credit and the closing-stock credit will describe the same batch —
see the duplicate-posting trap table in `SOURCE_OF_TRUTH.md`.

### B6 — The costing engine has never actually run — **FIXED**

Costing populated nothing because it read a material-cost column that purchases never wrote.
Every cost reader now resolves weighted-average cost first and falls back to the legacy column
only when the average is zero. Batches record raw material, packing material, labour and
overheads separately, plus total cost and cost per unit; cost per unit is stamped on the lot as
its valuation cost. Labour comes from that location's production payroll for the day, spread
across the day's batches weighted by quantity, with manual per-batch entry as the fallback and
the method recorded on the row. Pre-existing runs keep null costs and are never
retro-capitalised.

**Watch for:** a cost query that forgets to *select* the weighted-average column reports zero
silently — that is exactly how the packing-material estimate on the production form regressed
to ₹0.00 after the rest of the fix was in place.

### B7 — Expenses can be double-counted

Expenses reach the books by two independent paths — the legacy `expenses` table and
expense-ledger `payments`. The shared builder counts both, so the same expense entered on
both paths is counted twice.

---

## C. Stock transfers

### C1 — CRITICAL: adding transfer invoices as planned would double-count tax

Different-GSTIN transfers **already** post a dispatch voucher (Dr Inter-Branch Receivable,
Cr Sales, Cr Output GST) and a receive voucher (Dr Purchases, Dr Input GST, Cr Inter-Branch
Payable). Generating real sales and purchase invoices *in addition* would count revenue,
tax and receivables twice. The invoices must **replace** those vouchers, not accompany them.

### C2 — Rejection after invoicing would leave tax posted

Rejecting a transfer reverses stock only. Once a tax invoice exists, rejection must also
raise a credit note, or output GST stays on the books for goods that came back.

### C3 — In-transit stock is invisible

Dispatch removes stock from the source; the destination only receives it on approval. In
between, the quantity exists in **no** location total. Group inventory value understates by
the whole in-transit amount.

### C4 — Converting outlets will create new tax liability going forward

**0** transfers have ever been taxable, because outlets carry no GSTIN, so everything
classified as internal. Once converted warehouses inherit Karnataka and Tamil Nadu GSTINs,
transfers between those states become **taxable interstate supplies**. This is legally
correct, but it is new behaviour and new tax cost that starts the day conversion happens.

---

## D. Permissions and location access

### D1 — About 60 endpoints have no permission guard, nearly all reads

105 endpoints are guarded, roughly 60 are not, and the unguarded ones are overwhelmingly
GETs. Per-link View permissions will therefore hide menu items without actually preventing
the data being fetched.

### D2 — Three writes are completely unguarded

Attendance check-in, attendance check-out and leave creation accept writes with no
permission check.

### D3 — Some guard names are not in the registry

Guards such as "Raw Materials", "Materials", "Hierarchy" and "Login History" are used in
routes but are not registry entries, so they are silently ungovernable — the permissions page
can never grant or revoke them.

### D4 — Master data, audit logs, GST and reconciliation are unscoped by location

These return data across all locations regardless of the caller's warehouse.

### D5 — Money vouchers were Head-Office-only — **FIXED**

Payments, receipts, ledger statements and the cash/bank ledger picker returned nothing outside
Head Office, so a warehouse could take cash at the counter but never see or spend its own till.
They are now location-scoped: a voucher belongs to a location when it is stamped with it *or*
one of its two legs is a ledger that location owns.

Two traps this exposed, worth remembering before touching money scope again:

- **The general location scope is too wide for cash.** It grants a warehouse every outlet it
  supplies, which would let one location spend another's till; worse, retired outlet rows share
  cash and sales ledger ids with warehouse rows, so the same ledger would read as owned by two
  locations. Money paths use an own-location-only scope. Sales and purchases *inside* a ledger
  statement keep the wider scope, matching the Sales module.
- **New location columns default to Head Office**, which would have re-homed every historical
  voucher to HO. A one-time guarded backfill re-owned old rows from their ledger legs instead.

---

## How the plan changed

| Finding | Now covered by |
|---|---|
| A1–A6 stock truth, materials without location | Folded into the foundation task, which becomes location **and** stock model unification |
| B5, B6 production costing and postings | Costing reclassified from "extend" to "build"; labour added; postings added |
| C3 in-transit invisibility | Added to the reserved-stock task |
| C1, C2 transfer double-count and rejection | Transfer task now replaces vouchers and raises credit notes |
| C4 new tax liability | Flagged as a business consequence of conversion |
| D1–D3 unguarded and unregistered endpoints | Added to the permissions task |
| B1–B4 fragmented financial truth | Financial-statement rebuild now also unifies Day Book, GST and dashboard onto the shared builder |
| B3 opening balances | Raised as an open decision |

Two conflicts remain **open decisions** rather than plan items, because they change how the
business operates: whether raw-material stock should become per-warehouse (required for
warehouse production) and whether opening balances are captured now.
