---
name: Per-location invoice numbering
description: Sales SB2B/SB2C serials run per location; stamped identity columns, counter scoping, publish-safe index rules, receipt-delete guard, reserved-series invariant.
---

# Per-location sales invoice numbering

Every location (HO, each warehouse, each outlet) runs its own SB2B/SB2C serial.
Printed format unchanged — internal identity is (location, number).

## Identity is STAMPED COLUMNS, not an index expression
`sales` carries 4 nullable raw-migration columns stamped at creation:
`number_scope` (folded scope text), `invoice_series`, `invoice_fy`,
`invoice_serial`. Two PLAIN unique indexes enforce identity:
`uq_sales_scope_invoice_number (number_scope, invoice_number)` and
`uq_sales_scope_series_fy_serial (scope, series, fy, serial)`.
**Why:** the earlier CASE-expression unique index could not be reproduced by
the publish-time schema differ (it generated invalid SQL — "unterminated
quoted string" — and the deploy failed). NEVER put a CASE/expression in an
index here; plain columns only. Stamping also CLOSES the old mirror-fold gap:
the index now keys the folded scope, so even direct SQL can't print twins at
one physical place.
- Every producer must stamp all 4 columns: POS create, importer, BTR transfer
  invoices (parse via `parseDocNumberIdentity`, NULL identity for non-3-part
  numbers is fine). Sale EDIT recomputes `number_scope` (edits can move the
  sale; the index then arbitrates the kept number at the new location).
- Legacy odd-shaped numbers keep NULL series/fy/serial forever — never
  renumbered; NULLs never collide in a unique btree, so no partial predicate.
- Boot backfill is shape-driven (`WHERE number_scope IS NULL`), re-runs every
  boot, reuses the same mirror-fold LATERAL SQL as the counter reconcile, and
  on 23505 logs the duplicate (scope, number) groups before rethrowing.
- `allocateSalesInvoiceNumber()` returns the full identity; generic per-scope
  primitive `nextScopedSerial()` is the seam for future doc types.

## Counter scoping (voucherNumber.ts `salesCounterScope`)
- Counter rows live in `voucher_sequences` with the location encoded in the
  TEXT key: `sales_invoice_counter_b2c@warehouse:2`. **Why:** widening the
  natural PK strands every older ON CONFLICT target (see migration-ddl-drift).
- Scope: `headoffice` by TYPE alone (HO placeholder id differs per table),
  else `type:id` — but an outlet sharing `cash_ledger_id` with a warehouse
  (mirror pair) FOLDS onto `warehouse:<twinId>` so one physical place never
  prints duplicates under its two identities.
- Boot reconcile groups per (scope, fy) with SQL mirroring the TS resolver
  (LATERAL twin lookup), forward-only. Old global counter rows left in place.

## Ordering rule for the index swap
Create the replacement unique index FIRST, then drop the old one. Note the
publish diff applies columns+indexes BEFORE the new build boots: prod rows sit
NULL-scoped (unguarded by the new indexes) until boot backfills — safe only
because the still-running old build allocates from one global counter.

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
