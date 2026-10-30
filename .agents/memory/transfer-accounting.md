---
name: Transfer accounting
description: Accounting policy and migration boundary for taxable inter-warehouse transfers
---

Completed taxable transfers recognize stock value as `Transfer-Out` income at
dispatch and `Transfer-In` expense at receipt. Cross-GSTIN transfers also carry
the appropriate GST heads; same-GSTIN transfers use tax-free internal vouchers.
P&L recognition stays separate from the inter-branch payable.

For P&L reporting, the older location-specific treatment (Transfer-Out as
income and Transfer-In as purchase expense) is superseded. All stock-owning
scopes exclude transfer-ledger balances from operating totals and use the dated
stock-cost movement plus sender-owned transit boundary adjustment. Transfer
postings remain available as memo/audit data; voucher, payable, and GST postings
are unchanged. Closing valuation includes sender-owned in-transit stock exactly
once. Balance Sheet asset totals continue to exclude that calculated stock
value. Dispatch reduces sender on-hand; transit remains sender-owned until
receipt.

**Why:** the user explicitly chose to keep stock calculation in the P&L only
and confirmed excluding it from all Balance Sheet totals after being warned
that the statements may no longer balance.

**How to apply:** Keep stock in P&L and COGS; omit it from Balance Sheet asset
rows and totals, and do not add a compensating balance to hide the resulting
difference.

There is one payable ledger per undirected location pair. The balanced dispatch
and receipt legs split between that pair ledger and shared clearing so a
forward transfer increases the pair balance and a reverse transfer decreases
it; the shared clearing is a contra-account, not another branch payable.

**Why:** Posting both sides of a completed transfer to the pair ledger would
net the obligation to zero. Splitting the legs preserves each document's
balance while keeping the actual bilateral position visible; rewriting
historical journal lines would damage the audit trail.

**How to apply:** Invoice-mode postings use the derived invoice projection and
must not create duplicate JVs. Legacy voucher-mode history is repaired only
with additive, balanced adjustment vouchers; keep existing journal lines
immutable. Migrations are marker-guarded and atomic.

For reporting, keep the pair-payable postings unchanged. Transfer ledger
amounts are memo-only, and the dated opening adjustment carries inventory cost
movement into COGS once. Keep monthly statements, on-screen reports, PDFs, and
canonical exports aligned on the same transfer and transit boundaries.

**Why:** the corrected reporting requirement is that internal movements cannot
create artificial profit or loss when authoritative stock valuation already
reflects them. This supersedes the earlier location-only P&L presentation rule.

**How to apply:** keep raw transfer ledger amounts accessible for audit and
GST reconciliation, but do not include them in revenue, purchases, expenses,
COGS, or Gross Profit.

For voucher-mode short receipts, the destination Transfer-In voucher is based
on the quantity actually received; the shortfall remains sender-owned in
transit. Invoice-mode transfers remain priced from dispatched lines because
the outward tax invoice is still the full legal document.

**Why:** charging the destination for unreceived goods made its historical
Transfer-In expense exceed received stock, while the missing quantity was
still valued as sender-owned transit.

**How to apply:** build voucher-mode receipt totals from received lines; do not
shrink an already-issued invoice or change the dispatch-side Transfer-Out.