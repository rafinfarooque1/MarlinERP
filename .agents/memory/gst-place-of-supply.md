---
name: GST place of supply for sales
description: CGST/SGST vs IGST on sales/POS/quotations is decided by the SELLING LOCATION's state vs the customer, via ONE shared function with a client mirror that must stay in sync.
---

# GST place of supply (sales, POS, quotations)

**Rule:** Inter-state vs intra-state on a sale is the SELLING LOCATION's state
vs the customer's state — never the company/head-office state. Decided by
`isInterStateSupply(seller, customerState)` in `api-server/src/lib/gstTransfer.ts`;
seller state comes from `resolveLocationGst()` (company state only as fallback
when the location has no state, and for Head Office). Walk-in / customer
without a state = intrastate. Sale CREATE, sale EDIT (uses the NEW effective
location) and quotation create/update all route through it.

**Why:** A Karnataka warehouse selling to a Karnataka customer was charged
IGST because the old code compared the company state (Kerala) with the
customer. Quotations must use the same function or a quote and the invoice it
becomes disagree.

**How to apply:**
- Any NEW sales producer must call `isInterStateSupply` + `resolveLocationGst`;
  never compare company vs customer state for a sale.
- Comparison is state-CODE-first (folds aliases like Orissa/Odisha,
  Uttaranchal/Uttarakhand), name compare only as fallback.
- The ERP client has a MIRROR of the map + function in
  `marlin-erp/src/lib/indianStates.ts` used by the POS preview (Sales.tsx).
  If the server map/logic changes, change the client mirror in lockstep or the
  on-screen GST preview diverges from what saving stores.
- Historical sales are intentionally untouched (no migration); legacy import
  paths intentionally keep their own isInterState inputs.
- Sale API test cleanup pattern that leaves no trace (used by repo suites):
  cancel the sale, then SQL-delete receipts (by voucher number/narration),
  sale_payments, stock_ledger rows (doc_type='sale' AND doc_id), the sales row,
  and activity_log rows mentioning the invoice number. Quotations are safer
  still for classification checks — zero books impact, plain DELETE endpoint.
