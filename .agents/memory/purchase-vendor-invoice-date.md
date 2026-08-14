---
name: Purchase vendor invoice date
description: vendor_invoice_date semantics on purchase bills — required on create, keep/change/clear on edit, legacy NULL never backfilled
---

## The rule
- `purchases.vendor_invoice_date` (DATE, raw-migration column → raw SQL read/write only, invisible to drizzle) is REQUIRED + ISO-validated on POST /purchases, and required in the create schema of the API spec. PATCH: field omitted = keep, valid string = change, null/'' = clear. Client create-form requires it; edit form leaves it optional so legacy bills stay correctable without inventing a date.
- Legacy bills keep NULL forever — absent ≠ zero, no backfill; every surface (list, detail, CSV, PDF) renders a dash/hint for NULL.

**Why:** the vendor's own invoice date is a statutory/reconciliation fact; fabricating it on old bills would corrupt GST/audit trails.

## Blast radius of requiring a field on a busy producer
Requiring a new field on POST /purchases broke fixture payloads in ~20 test suites (grep missed half at first — POST call sites hide behind template literals and helper wrappers). Grep `tests/` for EVERY producer payload before requiring a field, patch them in the same change, and re-run suites whose semantics depend on validation order (e.g. a locked-month test must reach its 423, not die on the new 400). Raw-SQL producers (imports, transfer twins) bypass route validation and legitimately write NULL.

## Friendly message vs generated schema
Once the spec marks a field required, the generated zod parse rejects the body before any hand-written check — burying the plain-language error. If a route wants a friendly message for a missing field, validate it on the raw body BEFORE the schema parse.

## Temp-user trap
Suites' `cleanup()` deletes `employees WHERE username LIKE 'zztest%'`. A temp admin-clone runner named `zztest_*` gets deleted MID-RUN by the suite it's driving — every later request 401s and looks like an auth regression. Name the runner outside the fixture prefix and delete it + its login_attempts afterwards.
