---
name: Money voucher ownership (location-scoped cash)
description: How payments/receipts/ledger statements decide which location owns a voucher, and why money uses a narrower scope than the rest of LBAC.
---

## Rule: a voucher belongs to a location if it is stamped with it OR one of its legs is a ledger that location owns

Payments and receipts carry `location_type`/`location_id`, but the stamp alone is not the test.
Ownership = stamped location OR either leg pointing at a ledger the location owns (its cash or
sales ledger).

**Why:** the stamp only exists on rows written after the columns were added, and any future insert
path that forgets to stamp would silently make a voucher invisible to the branch that created it.
The leg arm keeps history visible and self-heals such omissions.

**How to apply:** every money read/write filter must OR the two arms together, never rely on the
stamp alone. New insert paths should still stamp — the leg arm is a safety net, not a licence.

## Rule: money scope is own-location only, not the general LBAC scope

**Why:** `getUserDataScope` gives a warehouse user its own warehouse *plus every outlet it
supplies* — correct for stock (it ships there), wrong for cash (it must not spend the outlet's
till). It is worse than a policy question here: retired outlet rows share cash/sales ledger ids
with warehouse rows, so the wider scope makes one location's ledger appear to belong to two
locations at once.

**How to apply:** use the own-location scope helper for anything touching payments, receipts,
cash/bank ledger pickers and the money half of ledger statements. Sales and purchases *inside*
a ledger statement keep the normal wider scope, matching the Sales module's established rule.

## Rule: "foreign" ledgers are a set difference on ledger IDs, never a row filter

Computing another location's ledgers by filtering location rows returns ids that the caller also
owns (shared ids again), which 403s a user on their own ledger. Build all-location ledger ids,
subtract the caller's own ids.

## Branch write restrictions

- The caller's own leg (payments `paid_from`, receipts `received_in`) must be their own cash ledger.
- The other leg may be neither another location's ledger nor an HO cash/bank ledger.
- Requesting another location's ledger statement is a 403; a cross-location delete is a 404.
- The `expenses` table and journal-family vouchers have no location dimension → HO-only.

## Backfill, don't default

New location columns default to headoffice/0, which would have silently re-homed every historical
voucher to HO. A one-time `migration_log`-guarded backfill re-owned old rows from their ledger legs
(cash leg for both tables; for receipts also `received_from = <location sales ledger>`, which is how
counter UPI/bank sales are recognised).
