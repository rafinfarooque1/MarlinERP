---
name: Returns edit semantics
description: How editing a sales/purchase return works — delta-based stock, FY-pinned numbers, note JV rewritten in place.
---

# Returns edit (PATCH /sales-returns/:id, /purchase-returns/:id)

**Rules:**
- Body is FULL state (returnDate, reason?, lines with lineIndex+quantity), not a diff. Caps are recomputed against priors that EXCLUDE the edited return itself — both server-side and in the edit dialog UI.
- Stock moves only by per-lineIndex quantity DELTA. Date/reason-only edits therefore never fail on availability, even when the previously restored/returned stock has since been consumed. Lot layer is diffed per batchNumber against the stored batchRestore, applied even when the qty delta is zero.
- Return number and credit/debit-note (or refund-payment) numbers are NEVER reissued. The note JV is rewritten in place (update header, delete+reinsert lines). Consequently the new date must stay inside the FY embedded in the number (`PREFIX/FY/NNNN`), else 400.
- Money side effects that must track the delta: customers.total_purchases (credit-note mode), sales.payment_status recompute, payments row amount/date (cash refund mode), stock_ledger txn_date UPDATE on date change plus delta rows noted "adjusted by edit".

**Why:** preserving numbers keeps GST filings and printed documents stable; delta-based stock is the lesson from the purchase date-fix (full reverse+reapply 409s on consumed stock for edits that don't touch quantities).

**How to apply:** any future return-adjacent write path (delete/cancel a return, imports) must follow the same delta/number rules; delete/cancel is intentionally NOT implemented yet.

**UI:** the create dialogs in pages/returns/Returns.tsx double as edit dialogs via an optional `editing` prop; edit instances are keyed per return id so state initializes from props; the bill picker is replaced by a disabled input in edit mode.

# Return pricing display (Aug 2026 complaint: "shows MRP, not the sold rate")

- The backend was ALWAYS invoice-anchored: create/edit prorate the ORIGINAL document line's stored money (sales: `taxableAmount ?? lineSubtotal` + cgst/sgst/igst legs; purchases: `taxableValue` + legs), never the item master. Any "wrong rate" complaint here is a DISPLAY bug.
- Sale line `unitPrice` is the GROSS pre-discount rate (looks like MRP to users); the credited value is the discounted taxable+tax. Return UIs must show the effective "Net Rate" = (taxable+tax)/qty and estimate refunds with the SAME per-component r2 rounding chain as the server (round each prorated component to paise, then sum) or partial/fractional quantities drift from the note total.
- Post-tax bill coupons (`discountTotal`) are NOT prorated into returns by design — the CN reverses pre-coupon line values. Label discounts "Line Disc." and disclose the coupon exclusion, or users can't reconcile against the invoice total.

**How to apply:** any new surface previewing a return value (PDF, mobile, reports) must reuse this proration + rounding, and must never show gross unitPrice as if it were the refund rate.
