---
name: Marlin ERP cross-module integration conflicts
description: Verified places where Marlin ERP modules disagree with each other — read before touching stock quantity, financial statements, or transfer accounting.
---

# Where the modules disagree

Established by a full end-to-end audit against live data. These are architectural
mismatches, not bugs in a single function, and each one has bitten or will bite any change
in its area.

## Stock has five quantity stores, not one

`items.production_stock`, `raw_materials.current_stock`, `materials.current_stock`,
`stock_entries`, `stock_batches`, plus `stock_ledger` as audit trail.

**The item-table stock column is stale and must not be trusted.** Purchases and production
maintain it; sales do not. It decays permanently.

**Why it matters:** the Profit & Loss closing stock reads that column, so it reports a small
fraction of real inventory — and values it at MRP rather than cost.

**How to apply:** treat the per-location layer as quantity truth. Before adding any stock
figure to a report, check which store it reads.

## Raw and packing materials have no location dimension

The per-location stock and batch layers hold finished-goods IDs only. Raw and packing stock
are single global numbers.

**Why it matters:** this makes production structurally Head-Office-only. "Consume materials
from this warehouse" is not expressible, and raw materials get no batch, mfg date or expiry
tracking — which matters most for perishables.

**How to apply:** any feature promising per-warehouse manufacturing or per-warehouse
inventory valuation must first make all item types location-aware.

## The batch layer tolerates deficits but not surpluses — and both exist

Design assumption: batch units ≤ stock units, with the shortfall absorbed as untracked
residual. Live data violates it in both directions.

**Why it matters:** availability arithmetic (quantity minus reserved) built on unreconciled
totals is wrong from the start.

**How to apply:** reconcile batch vs stock totals before enforcing anything based on
availability.

## Financial statements ignore journal vouchers

The Trial Balance derives from the shared postings builder. The P&L and Balance Sheet read
source tables directly and skip `journal_voucher_lines` entirely.

**Why it matters:** payroll posts as a voucher, so it appears in the Trial Balance and not in
the P&L. Any *new* posting added as a voucher is invisible to the P&L for the same reason.

**How to apply:** never assume a new voucher shows up in the P&L. Route financial figures
through the shared builder, and treat Day Book, GST returns and dashboard totals as separate
re-implementations that also need unifying.

## The Balance Sheet self-balances with a plug

It carries a difference line that absorbs imbalance, so real bookkeeping errors are hidden
rather than surfaced. Removing the plug is what makes the statement meaningful.

## Different-GSTIN transfers already post full tax entries

Dispatch and receive each create a journal voucher covering sales/purchases, GST and
inter-branch receivable/payable.

**Why it matters:** generating "real invoices" for these transfers *in addition* double-counts
revenue and tax. Invoices must take over the postings and the voucher path must be switched
off.

**Also:** rejection reverses stock only. Once an invoice exists, rejection needs a credit note.

## In-transit stock belongs to no location

Dispatch removes it from the source; the destination gets it only on approval. In between it
is absent from every location total, so group inventory value understates.

## Guard coverage is mostly writes

Roughly 60 endpoints are unguarded and nearly all are reads. A View permission therefore
hides a menu entry without preventing the fetch. Some guard names used in routes are absent
from the registry, making them permanently ungovernable.

**How to apply:** when scoping permission work, treat "hide the link" and "deny the data" as
two separate jobs.
