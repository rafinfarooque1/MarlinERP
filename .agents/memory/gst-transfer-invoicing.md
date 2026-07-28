---
name: GST transfer invoicing
description: Cross-GSTIN stock transfers raise real sales/purchase invoice rows; the consequences that ripple through every revenue and spend report.
---

# Cross-GSTIN transfers are taxable supplies with real invoice rows

A transfer between two different GSTINs raises a **real row in `sales` (sender) and
`purchases` (receiver)**, not just a journal voucher.

**Why:** GSTR-1, GSTR-3B, the HSN summary and reconciliation all read those two
tables and need line-level HSN detail. A journal voucher cannot carry it, so
teaching the returns to read vouchers was rejected.

**How to apply:** every query that sums, counts or averages `sales` or
`purchases` for **revenue, spend, COGS, turnover, profit, item average cost or
party balances** must add `branch_transfer_id IS NULL`. Forgetting it silently
inflates turnover by the transfer value. GST reports are the deliberate
exception — they must see these rows. Queries that INNER JOIN `customers` or
`vendors`, or filter on `customer_id`/`vendor_id`, are already safe: transfer
invoices have neither, they carry `party_name`/`party_gstin`/`party_state`
instead (auto-creating branch customers would pollute masters and credit
control).

## Invoices REPLACE the dispatch/receive vouchers

`buildDerivedPostings` derives the postings from the invoice rows, so the old
dispatch/receive JVs are **not** created for an invoiced transfer. Creating both
would double the revenue, the tax and the inter-branch balance.

**Trap:** `buildDerivedPostings` must keep posting **cancelled** transfer sales.
Rejection raises a credit note that already reverses them; skipping cancelled
rows as well would subtract the same amount twice.

## Turnover treatment is "separate", by explicit user decision

Transfer invoices are statutory tax documents only. They appear in GST returns
and create both invoice legs, but must never increase sales revenue, gross
sales, profit or dashboard sales. One clearing ledger `STD-BRANCH-TRF`
(liability, under `SYS-CURL`) is credited on dispatch and debited on receive, so
it nets to zero and drops out of the trial balance entirely. Balance-sheet
placement is what keeps the P&L untouched — the P&L reads `total_amount` off the
tables directly, so the exclusion there is what actually delivers it.

## Taxability is automatic, never a user choice

Same GSTIN → stock movement only. Different GSTIN same state → CGST+SGST.
Different GSTIN different state → IGST. Company Settings only enables or
disables the whole module; there is no per-transfer taxability switch, because
that would be a switch for whether to follow tax law.

## Forward-only gating via a stamp, not a setting

`stock_transfers.document_mode` ('invoice'/'voucher', NULL read as 'voucher') is
stamped at dispatch. The **stamp** decides the receive/reject leg, never the
current setting — otherwise flipping the kill-switch mid-flight would let a
transfer leave as one document type and land as another.

## Tax is EXCLUSIVE here

Taxable = qty x cost, tax on top — the opposite of customer sales, where MRP is
GST-inclusive. Safe because GST reports read `lineSubtotal`/`taxAmount` directly.
The receiver's purchase invoice reuses the **sender's invoice number** and the
**dispatched** quantities, so ITC matches the sender's output tax; short receipts
fall to the existing in-transit shortfall mechanism.

## Numbering depends on the settings row existing

The `BTR` series counter lives on the `company_settings` singleton (as the
customer `INV` series does), so a fresh database must seed that row before the
first dispatch or the sequence has nowhere to persist. Issuing a number must
**fail closed** if the UPDATE touches no row — emitting a default would hand the
same statutory number to every transfer. A global unique index on
`sales.invoice_number` is impossible (older test data already contains
duplicates); the guard is a partial unique index scoped to transfer rows.

## Side effects worth remembering

- Materials and packing materials are now taxed on cross-GSTIN transfers. Only
  finished goods were before, which understated the tax.
- `STD-BRANCH-DEBTOR`/`STD-BRANCH-CREDITOR` used to exist with `parent_id = NULL`,
  orphaned from the balance-sheet groups, so their balances fell into the
  statement's `difference` line. Never noticed because no transfer had ever been
  taxable. They belong under `SYS-CURA`/`SYS-CURL`.
- Delete guards that count `sales WHERE outlet_id = $1` miss transfer invoices:
  those stamp `location_type`/`location_id` and leave `outlet_id` null.
