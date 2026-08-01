---
name: JV location stamping & statement visibility
description: manual journal-family vouchers are HO-stamped at creation; statements gate JV lines with LBAC scope + view filter on an EFFECTIVE location; journal routes HO-only on every verb
---

Rule: manual journal/contra/CN/DN vouchers are stamped `headoffice`/0 at creation (session-derived via callerLocation, never the body). Legacy NULL-stamp manual vouchers were backfilled once behind migration_log `manual_jv_location_backfill_v1`. System vouchers (origin='system': payroll, transfer clearing) stay company-level (NULL) ON PURPOSE.

**Why:** vouchers with NULL location vanished from every location-sliced view — even the sidebar's plain "Head Office" selection dropped all manual JVs from the Trial Balance, P&L, Balance Sheet and ledger statements, because location filters can only keep what they can attribute. The books looked complete unfiltered and silently incomplete the moment any location header arrived.

**How to apply:**
- Ledger-statement queries include JV lines through TWO layered conditions on the same joins (sales_returns sr on credit_note_id, purchase_returns pr on debit_note_id, purchases pu on pr.purchase_id): `jvScopeCond` (LBAC — who MAY see) then `jvLocationCond` (view filter from the x-location-type header). Effective location = `COALESCE(sr.location_*, pu.location_*, v.location_*)` — mirrors buildDerivedPostings(), so a return-linked note inherits its document's location.
- Branch callers must NOT be blanket-excluded from JV lines: their own sales-return CNs / purchase-return DNs are in their located books, so excluding all JVs makes their statement disagree with their own P&L. Scope to effective location instead.
- Journal-voucher ROUTES are HO-only on EVERY verb (list, get-by-id, POST, PATCH, DELETE) — gating only list+edit let a branch user with page rights create vouchers they couldn't read back, and delete manual JVs by id. Get-by-id returns 404 (not 403) to avoid leaking ids.
- Boot backfills must claim their migration_log marker and do the work in ONE transaction (INSERT marker … RETURNING as the claim, then UPDATE, then COMMIT): marker-after-work re-runs on crash and re-stamps rows someone reclassified in between.

Related: removing a stored field from a document surface (voucher payment mode/attachment, Aug 2026) = keep the columns for legacy rows, silently ignore the fields on write, and strip EVERY read surface — list JSON, PDF renderer AND its query, CSV export, delete-audit metadata, edit dialogs. Grep all of them; the PDF query selecting a dropped field keeps it alive invisibly.
