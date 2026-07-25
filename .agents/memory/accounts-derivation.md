---
name: Accounts books derivation & voucher numbering
description: How trial balance / day book / cash-bank book derive postings, the sale-receipt double-count trap, and the FY voucher numbering rule
---

## Derived postings model (Phase 1 Accounts)

Trial balance, cash/bank book (and their opening/running balances) all flow through ONE function: `buildDerivedPostings()` in `artifacts/api-server/src/routes/journal.ts`. It derives double-entry postings from transaction tables (payments, receipts, journal_voucher_lines, expenses, sales + sale_payments, purchases) instead of a posted-ledger table.

**The sale-receipt double-count trap:** the sales flow ALSO persists rows into `receipts` (at sale creation with `voucher_number = invoice_number`, and at payment collection linked via `sale_payments.clearing_receipt_id`). Those persisted rows are accounting-WRONG on their own (no GST split; collections credit Sales instead of the customer), so the derivation treats sales/sale_payments as the source of truth and EXCLUDES sale-linked receipts by those two markers. Day book applies the same exclusion.

**Why:** including both sources double-counts cash and sales while keeping Dr=Cr — the trial balance `balanced` flag can NOT catch double counting; both sides inflate equally.

**How to apply:** any new feature that persists money-movement rows for sales/purchases must either be excluded in `buildDerivedPostings` + day book, or become the single source of truth there. When verifying books, always compare a component (e.g. sales-family credit) against an independent SQL sum — never trust `balanced` alone.

**As-of-date caveat (accepted for Phase 1):** customer outstanding uses the CURRENT `sales.amount_paid`, so a historical `toDate` reflects later collections too.

## GST head split (Phase 2)

Sales/purchase tax splits to Output/Input CGST-SGST-IGST ledgers inside `buildDerivedPostings`. ONE per-line classifier — `lineTaxHeads()` in `api-server/src/lib/gst.ts` (falls back from `taxAmount`+`taxType` when head fields are absent) — is shared by the derivation, all `/gst/*` report endpoints, AND `/gst/summary`. Route any new GST aggregation through it.

**Why:** independent aggregations diverge immediately: reports counted heads the ledger refused to split. Also, purchases' stored `tax_total` is 0 on legacy rows (the column started being populated later) — a split gate requiring it zeroed ALL real input-tax ledgers in one shot.

**How to apply:** split gates = head sum consistent with per-line `taxAmount` sum, and with stored `tax_total` only when > 0. Inconsistent docs keep the legacy lump ON PURPOSE and reconciliation flags them (`matched:false` there is a feature — it surfaces bills whose ITC isn't in books). To test legacy/corrupt shapes, insert simulation rows via psql (the API validates them away), verify TB balance + recon, then delete.

## FY voucher numbering

`nextVoucherNumber(queryableOrNull, type, date?)` in `artifacts/api-server/src/lib/voucherNumber.ts` — atomic upsert on `voucher_sequences` (PK type + fy_label), format `JV/2026-27/0001`. Prefixes/FY start month configurable via company_settings (`voucher_prefixes` jsonb, `fy_start_month`).

**Why:** COUNT(*)-based numbering duplicates under concurrency and reuses numbers after deletes. All COUNT-based spots were replaced (accounts, customers, reconciliation, cash-in-outlet, payments routes).

**How to apply:** never number a voucher with COUNT(*). Pass the transaction client so the sequence update joins the tx. Grep for `COUNT(*)` near INSERTs when touching money routes — one hid in the sale-payment collection path long after the first sweep.
