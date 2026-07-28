---
name: Codegen staleness trap (api-zod / api-client-react)
description: Regenerating clients from openapi.yaml can flip validators stricter than what UI forms actually send
---

# Codegen staleness trap

The committed generated code (`lib/api-zod`, `lib/api-client-react`) can be **stale relative to `lib/api-spec/openapi.yaml`**. Running codegen for an unrelated spec change regenerates EVERYTHING, silently picking up old spec requirements the previous generated code never enforced.

**Why:** The spec always declared `paymentMode` required on SaleInput, but the committed zod had it `.optional()`. A codegen run for new credit fields flipped it to required — and the Sales form never sent `paymentMode`, so every UI sale creation started failing with a 400 zod error. The API tests passed (they sent the field); only browser E2E caught it.

**How to apply:** After any codegen run, `git diff` the generated packages for fields that changed from `.optional()` to required (or newly-added required fields), then verify the UI forms/payloads that hit those endpoints actually send them. Browser-level E2E after codegen is the reliable net — request-level tests mask client payload gaps.

## The generated TYPES are not a valid oracle for what routes return

Staleness cuts the other way too, and it makes "audit the UI against the API types" a trap. Many routes deliberately return **more fields than the generated interfaces declare**, because columns added by raw startup migrations are invisible to drizzle and get read back via raw SQL (see `raw-migration-columns.md`) — e.g. an `EXTRA_COLS` select merged into the response.

**Why:** An audit comparing UI field reads against `lib/api-zod/src/generated/types/*.ts` reported ~15 "missing field" bugs across production, purchases, sales, outlets, item master and payroll — claiming visible `NaN` / `undefined` / `Invalid Date`. Nearly every one was a **false positive**: the routes really do return `paymentStatus`/`amountPaid`/`balanceDue`, `batchNumber`/`totalCost`/`costPerUnit`, `taxTotal`/`discountTotal`, `mrp`/`hsnCode`/`taxRate`, `gstin`/`state`/`stateCode`, and `branchType`. Only the generated types were behind. "Fixing" them would have broken working features.

**How to apply:** Fields reached through an `as any` cast are a signal the value comes from the raw-SQL layer, **not** evidence of a bug. Before changing any UI field read, confirm against the route's actual `SELECT` / response object (grep the field name in `artifacts/api-server/src/routes/`) and against the drizzle schema — and prefer a passing browser E2E over a type-level audit. Runtime behaviour is the oracle; the generated types are not.
