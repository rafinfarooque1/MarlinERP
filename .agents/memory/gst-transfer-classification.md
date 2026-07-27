---
name: GST-aware transfer classification
description: How the ERP auto-detects whether a stock transfer is internal or taxable, and what columns + accounting entries are produced.
---

## The rule
Every stock transfer is auto-classified by comparing source and destination GSTINs:
- Same GSTIN → `transfer_type = 'internal'`, `tax_type = 'none'` — delivery challan only, no GST
- Different GSTIN, same state → `transfer_type = 'intrastate'`, `tax_type = 'cgst_sgst'` — CGST + SGST
- Different GSTIN, different state → `transfer_type = 'interstate'`, `tax_type = 'igst'` — IGST only
- Either side missing GSTIN → `transfer_type = 'internal'` (safe fallback)

Users always initiate a "Stock Transfer" — the backend decides the type. Never user-controlled.

## New DB columns (added via startup ALTER TABLE IF NOT EXISTS)

**stock_transfers**: `transfer_type`, `from_gstin`, `to_gstin`, `tax_type`, `transfer_value`, `gst_amount`, `dispatch_voucher_id`, `receive_voucher_id`

**outlets**: `gstin`, `state`, `state_code` (outlets had no GST fields before)

**warehouses**: `state_code` (already had `gst_number` and `state`)

## New helper: `artifacts/api-server/src/lib/gstTransfer.ts`
- `resolveLocationGst(pool, locationType, locationId)` → LocationGst — reads GSTIN+state from company_settings / warehouses / outlets
- `classifyTransfer(from, to)` → { transferType, taxType, isInterstate }
- `computeTransferGst(pool, lines, taxType)` → GstTotals — looks up item GST rates, computes CGST/SGST or IGST
- `createDispatchVoucher({ client, challanNumber, transferDate, fromLocation, gst, taxType, ... })` → voucher ID
- `createReceiveVoucher({ client, challanNumber, transferDate, toLocation, gst, taxType, ... })` → voucher ID
- `ensureClearingLedger(db, code, name, type, section)` — find-or-create pattern (safe against concurrent creation race)

## Accounting entries

**Dispatch (source side, INSIDE transaction):**
- Dr STD-BRANCH-DEBTOR (Inter-Branch Receivable, auto-created if absent)
- Cr STD-SALES / WH-SAL-n / OUTLET-SAL-n (location-specific or standard fallback)
- Cr STD-OUT-IGST or STD-OUT-CGST + STD-OUT-SGST

**Approve (destination side, INSIDE transaction):**
- Dr STD-PUR / WH-PUR-n (location-specific or standard fallback)
- Dr STD-INP-IGST or STD-INP-CGST + STD-INP-SGST
- Cr STD-BRANCH-CREDITOR (Inter-Branch Payable, auto-created if absent)

Unresolved GST head (deleted standard ledger) folds into the Sales/Purchase line — books always balance.

## GST computation strategy
- Item GST rates queried from `items.gst_rate` in batch
- Materials/raw_materials default to 0% (no GST rate stored)
- For intrastate: cgst = sgst = rate/2; for interstate: igst = rate
- Stored as `transfer_value` (taxable) + `gst_amount` (total) — split reconstructed at approve time from `tax_type`

## Frontend
- Warehouses form: added `stateCode` field (2-digit numeric)
- Outlets form: added `gstin`, `state`, `stateCode` fields
- HoTransfers: replace static "Interstate Transfer" badge with dynamic type badge (Internal / Inter-Branch Sale / Interstate Tax Transfer)
- StockTransfers: replace "Interstate/Intra-state" text with full transfer type label

**Why inside transaction for both dispatch and approve:** The GST vouchers must be atomic with the stock deduction/credit. A crash between stock movement and JV would create unbalanced books. Fire-and-forget would be incorrect here.
