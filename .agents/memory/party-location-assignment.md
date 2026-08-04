---
name: Party (customer/vendor) location assignment
description: How customers/vendors carry an assigned location — one validated resolver for create+edit, /:id scope gates, located ledger rules, import stamping, backfill guards.
---

# Party location assignment

Customers and vendors carry `location_type`/`location_id` (raw-migration columns → raw SQL read AND write; surface camelCase in list responses).

## Rules (settled)
- **One resolver for every explicit assignment.** `resolveRelocation()` in the customers router validates HO-only (403 for branch callers), target existence (400), outlet-writes-disabled (409), headoffice→id 0. POST create and PATCH edit both use it — a create path that trusts the body while the edit path validates is exactly the gap a review will find.
- **/:id routes need their own LBAC gate.** Lists scope by stamp, but PATCH/DELETE/ledger address rows directly — without `partyScopeCheck()` a branch user edits any party by id. Rule mirrors list visibility: customers must be in caller scope; vendors also pass when HO-stamped (shared masters). Out-of-scope = 404 (never confirm existence).
- **Detail GETs intentionally NOT gated** — old documents must keep rendering party names after a relocation (module-retirement lesson). Recorded as an open follow-up decision.
- **Located ledger view**: header/query filter is a view request. Non-HO callers may only request slices inside their scope (403 otherwise; HO/company slices are HO-only). When located, the source-document totals (`partyDocumentTotals`) must be filtered to the SAME slice as the statement — company-wide "billed" next to a located balance reads like a discrepancy. HO location match = type alone (ids vary per table).
- **Import stamping**: per-row Location column resolved at parse against the uploader's scope; blank rows fall back to the location persisted ON THE BATCH RECORD, never the committer's session — a different user pressing Commit must not re-home rows.
- **Backfill** (`partyLocationBackfill.ts`): derive a customer's location only from a SINGLE distinct sale location AND only when the branch id > 0 (legacy sales can resolve to warehouse/outlet id 0 — a stamp no filter ever matches); everything ambiguous → headoffice.
- **Party ledgers (CUST-/VEND-) inherit the party's location at creation** — `stampLedgerLocation()` in the shared party-create lib UPDATEs the ledger only when its `location_type IS NULL` (non-fatal on error), plus a one-time boot backfill for existing ledgers. `account_ledgers.location_type/location_id` are raw-migration columns (raw SQL only) and are DISPLAY-ONLY — chart of accounts shows a location badge; report scoping stays posting-based.

**Why:** the whole feature is a filter over the stamp — any path that writes an unvalidated or session-guessed stamp silently hides the record from every location view.

## Test fixture gotcha
`regr_whuser`'s password is NOT the default. For branch-user LBAC tests: create a temp employee via POST /hr/employees (gets DEFAULT_INITIAL_PASSWORD + mustChangePassword → change-password flow), probe scope with EMPTY-body PATCH (400 = gate passed, 404 = blocked — mutation-free), then clean up. NOTE: DELETE /hr/employees 500s on the seeded pay_components FK — remove that row first via SQL.
