---
name: Codegen staleness trap (api-zod / api-client-react)
description: Regenerating clients from openapi.yaml can flip validators stricter than what UI forms actually send
---

# Codegen staleness trap

The committed generated code (`lib/api-zod`, `lib/api-client-react`) can be **stale relative to `lib/api-spec/openapi.yaml`**. Running codegen for an unrelated spec change regenerates EVERYTHING, silently picking up old spec requirements the previous generated code never enforced.

**Why:** The spec always declared `paymentMode` required on SaleInput, but the committed zod had it `.optional()`. A codegen run for new credit fields flipped it to required — and the Sales form never sent `paymentMode`, so every UI sale creation started failing with a 400 zod error. The API tests passed (they sent the field); only browser E2E caught it.

**How to apply:** After any codegen run, `git diff` the generated packages for fields that changed from `.optional()` to required (or newly-added required fields), then verify the UI forms/payloads that hit those endpoints actually send them. Browser-level E2E after codegen is the reliable net — request-level tests mask client payload gaps.

## openapi.yaml GATES the write path — a column + drizzle mapping is not enough

A field can exist end to end — real DB column, mapped in the drizzle table, read back
correctly by every GET — and still be **impossible to write**, because the generated
`Create*Body` / `Update*Body` zod schema does not declare it. Zod strips unknown keys, so
`safeParse(req.body).data` silently loses the field before it ever reaches
`db.insert(...).values(...)` / `db.update(...).set(...)`. No 400, no log line, no type error:
the write just returns 200 with the old value.

The symptom is always "I save it and it comes back blank", which sends you hunting through
the form binding, the request payload and the SQL — all of which are innocent. The GET side
is a red herring precisely because `db.select()` DOES return the column.

**Why:** the per-location UPI ID had `warehouses.upi_id` in the DB, `upiId` in the drizzle
schema, correct hydration in the React form, and the field in the outgoing request body —
but `WarehouseInput`/`WarehouseUpdate` in `openapi.yaml` never listed it, so both CREATE and
UPDATE dropped it. Fixing the route alone would have been undone by the next codegen run.

**How to apply:** for any "saved value reads back empty" report, diff the three layers in this
order — spec body schema, then generated zod, then the route — before touching the form. Fix
it in `lib/api-spec/openapi.yaml` and re-run codegen (`pnpm --filter @workspace/api-spec run
codegen`); never hand-edit the generated packages. Corollary: an `as any` on a *write* payload
(`data: data as any`) is the tell that the client type disagrees with what the form sends, and
it suppresses exactly the error that would have caught this.

## A partial PATCH whose only fields are raw columns produces an EMPTY drizzle SET

Routes that keep some columns outside the drizzle schema (raw startup-migration columns,
applied with a follow-up `pool.query`) can receive a body where every *validated* key is a raw
one. `parsed.data` is then `{}` and `db.update(...).set({})` throws, so the request 500s even
though the raw-column update would have been perfectly valid. Guard with an
`Object.keys(patch).length > 0` check and fall back to a plain select so the route still
answers 404 for a missing row.

## The generated TYPES are not a valid oracle for what routes return

Staleness cuts the other way too, and it makes "audit the UI against the API types" a trap. Many routes deliberately return **more fields than the generated interfaces declare**, because columns added by raw startup migrations are invisible to drizzle and get read back via raw SQL (see `raw-migration-columns.md`) — e.g. an `EXTRA_COLS` select merged into the response.

**Why:** An audit comparing UI field reads against `lib/api-zod/src/generated/types/*.ts` reported ~15 "missing field" bugs across production, purchases, sales, outlets, item master and payroll — claiming visible `NaN` / `undefined` / `Invalid Date`. Nearly every one was a **false positive**: the routes really do return `paymentStatus`/`amountPaid`/`balanceDue`, `batchNumber`/`totalCost`/`costPerUnit`, `taxTotal`/`discountTotal`, `mrp`/`hsnCode`/`taxRate`, `gstin`/`state`/`stateCode`, and `branchType`. Only the generated types were behind. "Fixing" them would have broken working features.

## A camelCase field the type declares but the route never emits fails SILENTLY

The mirror image is worse than a missing field: a route that returns only the raw
snake_case column while the generated interface declares the camelCase name gives a
`p.employeeId` of `undefined` at runtime with a perfectly clean typecheck. Nothing throws
— a `Map.get(undefined)` just misses, so the UI renders a dash or a zero, and any *filter*
keyed on that field quietly matches nothing (which looks like "no results", not a bug).

**Why:** the payroll list route hand-built its camelCase aliases and forgot `employeeId`. A
brand-new accrual column read blank and the pre-existing branch filter had been silently
dead for as long as it had existed.

**How to apply:** when a joined/aliased route response feeds a lookup by id, print one real
response body and check the key exists — do not trust the interface. Fix it at the route by
adding the alias next to the others (`employeeId: Number(r.employee_id)`), not with a
defensive `?? r.employee_id` at each call site: the route is where the other twenty aliases
already live, and one fix repairs every consumer.

**How to apply:** Fields reached through an `as any` cast are a signal the value comes from the raw-SQL layer, **not** evidence of a bug. Before changing any UI field read, confirm against the route's actual `SELECT` / response object (grep the field name in `artifacts/api-server/src/routes/`) and against the drizzle schema — and prefer a passing browser E2E over a type-level audit. Runtime behaviour is the oracle; the generated types are not.
