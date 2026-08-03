---
name: Location-aware manual vouchers & statement visibility
description: manual journal-family vouchers carry a chosen, validated location; routes are location-scoped (no longer HO-only); statements gate JV lines on an EFFECTIVE location
---

Rule: manual journal/contra/CN/DN vouchers carry a mandatory location (headoffice/warehouse/outlet) chosen in the dialog. The body is a REQUEST, not authority: `resolveVoucherLocation` re-authorizes it (branch users forced to their own location → 403 on mismatch; omitted → caller's location on create, current stamp on edit). `checkLinesLocation` then validates the rebuilt effective lines against the stamp: a branch-owned till/sales ledger must belong to the stamp's owner; the STD-CASH/STD-BANK subtrees (HO's own money) are legal only on HO-stamped vouchers; branch creators are blocked from foreign party ledgers. HO voucher stamp = `headoffice`/0. System vouchers (origin='system') stay company-level (NULL) ON PURPOSE.

**Why:** vouchers with NULL location vanished from every location-sliced view, and the earlier HO-only route gate blocked branch bookkeeping entirely. Location-aware stamping + leg validation lets branches keep their own books without reaching into another location's money.

**How to apply:**
- Voucher routes are location-scoped on EVERY verb: list filters branch users to own location, get/PATCH/DELETE return 404 (not 403) for foreign ids, POST/PATCH re-authorize the body location and re-check lines. PATCH pre-read must include the location columns.
- `GET /accounts/voucher-locations` is the UI's source for the location list + owned-ledger map (mirror locations = multi-owner; outlets drop out when outlet writes are blocked; branch callers get only their own entry).
- Statements/ledger queries include JV lines via effective location = `COALESCE(sr.location_*, pu.location_*, v.location_*)` (return-linked notes inherit their document's location) — mirrors buildDerivedPostings(). Branch callers must not be blanket-excluded from JV lines.
- Boot backfills must claim their migration_log marker and do the work in ONE transaction (INSERT marker … RETURNING as the claim, then UPDATE, then COMMIT).

Related: removing a stored field from a document surface (voucher payment mode/attachment, Aug 2026) = keep the columns for legacy rows, silently ignore the fields on write, and strip EVERY read surface — list JSON, PDF renderer AND its query, CSV export, delete-audit metadata, edit dialogs. Grep all of them; the PDF query selecting a dropped field keeps it alive invisibly.
