---
name: Location data wipe pattern
description: How to safely wipe one location's transactional data in production (Calicut wipe, Aug 2026)
---

# Wiping one location's transactional data

The Calicut wipe (migration guard `calicut_txn_wipe_2026_08_v1`) is the reference
implementation. Durable rules it encoded:

**Rule: FK maps are insufficient here — sweep soft-link tables by column-name scan.**
**Why:** this DB mostly avoids FK constraints. Scanning `information_schema.columns`
for `%_sale_id|purchase_id|receipt_id|payment_id|voucher_id%` found linking tables the
FK catalog missed: `cash_deposits` (transit_payment_id + bank_receipt_id),
`rent_payments.voucher_id`, `stock_transfers.(sale|purchase|dispatch_voucher|receive_voucher)_id`,
`reconciliation_batch_items.sale_payment_id`. Every doc-deleting change must re-run that scan.

**Rule: refuse on mixed cross-location rows, never delete through them.**
**Why:** `payment_bill_allocations` / `advance_consumptions` can link a wiped doc to a
surviving location's doc; deleting the shared row silently alters the OTHER location's
settlement state. Gate = XOR membership check → throw (rollback), no marker.

**Rule: pin scope with anchors + type gates, not just counts.**
Identity anchors (specific ids + numbers + amounts, verified ABSENT from dev), volume caps,
and a stock_ledger `txn_type NOT IN (scoped set)` gate so post-scoping drift of a NEW kind
(transfer/adjustment/production) refuses instead of being deleted.

**Rule: rehearse on a scratch DB loaded with REAL prod data before publish.**
Export via replica `json_agg` → base64 (`replace(encode(convert_to(...),'base64'),chr(10),'')`,
chunked by id; CSV-safe), load with `jsonb_populate_recordset(NULL::tbl, $1::jsonb)`
(needs sequences untouched — explicit-id inserts leave stale sequences, advance them or use
explicit ids for test rows). Test all paths: dev skip, broken anchor refusal, entanglement
refusal, apply, idempotent rerun, non-target rows byte-identical.

**Rule: backups of prod rows go to the workspace, NOT a prod backup schema** (publish
schema-differ chokes on unknown schemas/tables). NEVER include tables that aren't being
deleted — an employees export leaked bcrypt hashes into the repo and had to be removed.

Stored aggregates that must be unwound alongside doc deletes (books are derived, these are
not): `customers.total_purchases`, `items.production_stock` (both GREATEST(0,...), mirroring
app delete paths), quotation `converted_sale_id`/status.
