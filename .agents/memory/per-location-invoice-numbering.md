---
name: Per-location invoice numbering
description: Sales SB2B/SB2C serials run per location; counter scoping, index swap ordering, receipt-delete guard, and the reserved-series invariant.
---

# Per-location sales invoice numbering

Every location (HO, each warehouse, each outlet) runs its own SB2B/SB2C serial.
Printed format unchanged — internal identity is (location, number).

## Counter scoping (voucherNumber.ts `salesCounterScope`)
- Counter rows live in `voucher_sequences` with the location encoded in the
  TEXT key: `sales_invoice_counter_b2c@warehouse:2`. **Why:** widening the
  natural PK strands every older ON CONFLICT target (see migration-ddl-drift).
- Scope: `headoffice` by TYPE alone (HO placeholder id differs per table),
  else `type:id` — but an outlet sharing `cash_ledger_id` with a warehouse
  (mirror pair) FOLDS onto `warehouse:<twinId>` so one physical place never
  prints duplicates under its two identities.
- The unique index (`uq_sales_invoice_number_per_location`) keys the RAW
  identity — index expressions can't join, so mirror folding is enforced only
  by the shared counter, not by the DB. Direct SQL inserts bypass it.
- Boot reconcile groups per (scope, fy) with SQL mirroring the TS resolver
  (LATERAL twin lookup), forward-only. Old global counter rows left in place.

## Ordering rule for the index swap
Create the per-location unique index FIRST, then drop the global one — never
a window without duplicate protection.

## Consequences of shared numbers
- Existing locations continue past their own historical max (never reset to
  1 — a reset would collide with their own old bills). Only a location's
  FIRST use of a series starts at 000001; that is also how new locations
  auto-init (no counter row until first use).
- Any `DELETE FROM receipts WHERE voucher_number=$1` keyed on a sale's number
  must be guarded: plain match only when the number identifies exactly one
  sale, else additionally require the receipt's location = the sale's stored
  location. Legacy trail receipts were location-backfilled one-time (while
  numbers were still unique) so the guard always has a stamp to match.
- Global search appends the location name to sale subtitles — that's how twin
  numbers are told apart.

## Reserved-series invariant (books safety)
All books predicates (journal derivation exclusion, is_sale_receipt) match
sale-trail receipts BY NUMBER SHAPE alone. That is sound only because no
producer may create a non-sale receipt with an SB2x number — the voucher
importer now REJECTS verbatim `SB2B/`/`SB2C/` voucher numbers. Keep that
guard on any future producer that accepts caller-supplied voucher numbers.

## Out of scope (unchanged)
Quotation numbering (`computeInvoiceNumber`), sales returns/credit notes,
BTR partial unique index (statutory, stays global), purchase numbering.
