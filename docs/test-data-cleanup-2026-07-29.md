# Test-data cleanup — 29 July 2026

Audit note for a one-off destructive operation. Recorded so the change is
reproducible and reviewable. The script itself was a scratch file and was
removed after it ran; everything needed to reconstruct it is below.

## Scope

Remove **only** auto-generated test records. Keep all genuine business data,
masters, chart of accounts, GST settings, employees, vendors, purchases,
productions, and transactions created during implementation and verification.

### Removed

| What | Detail |
|---|---|
| Customers | ids 5–19 — `ZZ CreditGuard Seq/Race Test`, `ZZ Settled Exposure Test`, `ZZ EditFlow Test`, `Credit Test <epoch>` |
| Ledgers | ids 94–108 (`CUST-5` … `CUST-19`) |
| Sales | 28 invoices belonging to those customers, ₹13,850 |
| Stock ledger | the 28 `doc_type='sale'` audit rows for those invoices |
| Receipts | 1 (`TST/2025-26/0040`, ₹100, posted into ledger 97) |
| Item | 12 `TST-P5 Pack 63178` plus its two zero-qty batches and one zero-qty stock row |

### Deliberately kept

- **14 walk-in / branch-transfer sales** (`customer_id IS NULL`) — genuine.
- **Productions `E2E-bhrw` and `E2E-PROD-rrEp`** — auto-generated batch numbers,
  but production records were explicitly in scope to keep, and deleting a
  production batch permanently distorts the item's moving-average cost.
- **Coupon `AUD1-VA`** (usage_count 0) — too ambiguous to delete unasked.

## Method

Single transaction, in this order:

1. Restore the stock the test sales had consumed, derived from each sale's
   `line_items` JSON rather than hardcoded:
   - `stock_entries`: item 1 @ warehouse 1 **+25**, item 2 @ warehouse 3 **+3**
   - `stock_batches`: replay each line's `batchBreakdown` —
     batch 3 +3, batch 24 +20, batch 25 +4, batch 30 +1
2. Delete the `stock_ledger` rows for those sales.
3. Delete receipts/payments touching the test ledgers.
4. Delete the sales, then the customers, then the ledgers.
5. Delete item 12 and its zero-qty scaffolding.
6. Recompute `customers.total_purchases` for surviving customers.
7. Assert `invoice_sequence` is still ahead of the highest issued number.

A dry-run pass (rollback at the end) was executed first and its output matched
the committed run exactly.

## Before / after

| Measure | Before | After |
|---|---|---|
| Sales | 53 | 25 |
| Customers | 19 | 4 |
| Ledgers | 84 | 69 |
| Items | 7 | 6 |
| Stock ledger rows | 163 | 135 |
| Revenue (non-transfer) | 66,678 | **52,828** |
| Invoices on dashboard | 50 | 22 |
| Trial Balance (Dr = Cr) | 271,857.90 | **257,907.65** |
| Balance Sheet (both sides) | 786,363.48 | **781,279.73** |
| Cash on hand | 30,109.90 | 19,059.90 |
| GST summary sales | 69,623 | 55,773 |
| Purchase register | 187,310 | 187,310 (unchanged) |

Trial-balance movement of 13,950.25 = 13,850 (sales) + 100 (receipt). Purchases
are untouched, as required.

## Verification performed afterwards

- Trial Balance, Balance Sheet, P&L, GST summary / GSTR-1, sales register,
  `/sales/summary` and the dashboard all reconcile — full acceptance audit green.
- Referential sweep clean: no orphaned `sale_payments`, `sales_returns`,
  `stock_ledger`, `stock_entries`, `stock_batches`, `journal_voucher_lines`,
  `receipts`, `payments`, `opening_balances`, `item_prices`, `bom_templates`,
  `productions`, `stock_reservations`, `reconciliation_batch_items` or
  `stock_transfers`; no duplicate ledger codes or invoice numbers; every
  surviving customer still has its `CUST-<id>` ledger.
- No negative stock or batch quantities.
- **Write-path probe** (a read-only audit cannot catch this): created a new
  sale — allocated `TST/2025-26/0057` with no unique-index collision — created a
  customer and confirmed its ledger was auto-provisioned, cancelled the sale and
  confirmed stock was restored, then purged the probe rows and confirmed state
  returned exactly to 25 sales / 4 customers / 69 ledgers / stock_ledger max id
  264 / revenue 52,828.

`invoice_sequence` now sits at 57 against a highest issued number of 53. The
allocator is forward-only, so the gap is harmless; what matters is that the
sequence is never *behind* the maximum.
