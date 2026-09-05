# Frozen Fruits ERP — Production Forensic Audit

**Audit date:** 2026-09-05  
**Timezone:** Asia/Calcutta  
**Mode:** Read-only  
**Production URL:** https://frozenfruits.store  
**Additional deployment URL:** https://marlin-erp.replit.app  
**Production deployment:** public autoscale, successful build  
**Production database:** `neondb`, PostgreSQL 16.15  
**Development database previously audited:** `heliumdb`, PostgreSQL 16.10

## Scope and restrictions

This audit was performed against the published production URL and the read-only production database replica. No credentials were requested or exposed. No production login was performed, no records were inserted/updated/deleted, no migrations were run, and production was not restarted.

Protected production UI flows were not exercised beyond the public login page because doing so would require production credentials or creating a production test user, both outside this read-only scope.

The current workspace commit at audit time contains only the attached audit instructions and a production screenshot; it does not contain application-code changes relative to the deployed application.

## Executive production result

**Overall production readiness: CONDITIONAL / AMBER.**

The production ERP is live and broadly coherent with development:

- Public root page returns `200`.
- `/api/healthz` returns `{"status":"ok"}` after startup.
- `/api/healthz/schema` reports all 16 date columns correct.
- Production and development contain the same 69 migration names.
- Production and development contain the same 81 public tables.
- Production and development contain the same 1,076 public columns and data types/nullability.
- Journal voucher debits and credits balance exactly.
- No orphan journal-voucher lines were found.
- No orphan stock-ledger references were found.
- No negative stock or negative batch quantities were found.
- Batch quantity exactly equals stock quantity for item stock.
- Current sales and purchases are location-stamped.
- All production transfers are completed; no transfer is currently in transit.
- Salary and rent accruals run through 2026-09-05.
- Backup scheduler metadata reports the latest run as `ok`.

The principal confirmed production issue is:

> **High — Reservation 18 remains active for 5 units of item 90 at warehouse 5 even though transfer 9 is `completed`.**

This can understate available stock at `CEEVEES IMPEX` by 5 units and proves that the transfer/reservation state invariant is violated in production.

Other production conditions requiring attention:

- Two system payroll-migration journal vouchers are unstamped by location, matching the development condition.
- Five purchases have blank vendor invoice numbers.
- Two purchase invoice values repeat, but the repeated values belong to different vendors; this is a data-quality candidate, not confirmed duplicate system numbering.
- One reconciliation batch is `active` with zero item rows.
- Deployment startup logs show transient `/api` health failures (`500`/`503`) before recovery to `200`.
- Production startup runs repair/migration logic on boot; no-op migrations still emit error-level log records.
- Production backup manifests observed in metadata have blank `git_commit` and `erp_version` `0.0.0`, weakening build-to-backup traceability.

## A. Production architecture

### Confirmed runtime identity

| Item | Production evidence | Status |
|---|---|---|
| Live URL | `https://frozenfruits.store` | Confirmed |
| Additional URL | `https://marlin-erp.replit.app` | Confirmed |
| Deployment type | Autoscale | Confirmed |
| Visibility | Public | Confirmed |
| Build status | Successful | Confirmed |
| Database | PostgreSQL 16.15, `neondb` | Confirmed |
| Public tables | 81 | Confirmed |
| Public columns | 1,076 | Confirmed |
| Migration names | 69 | Confirmed |
| API health | `200`, `{"status":"ok"}` | Confirmed |
| Schema health | 16/16 date columns correct | Confirmed |
| Public version endpoint | `/api/version` returns `401` without authentication | Confirmed |
| Public build/commit identifier | Not exposed | Not testable |

The public production page is the Frozen Fruits ERP login screen. It renders the “Frozen Fruits ERP” brand, operational-platform copy, username/password fields, and internal-personnel messaging. A screenshot was captured at:

```text
screenshots/production-home-2026-09-05.png
```

### Health behavior

Unauthenticated production probes:

| Path | Status | Result |
|---|---:|---|
| `/` | 200 | Login page |
| `/api/healthz` | 200 | Ready |
| `/api/healthz/schema` | 200 | Date schema healthy |
| `/api/version` | 401 | Authentication required |
| `/api/auth/me` | 401 | Authentication required |
| `/api/health` | 404 | Not a registered route |

## B. Production versus development comparison

### Schema and migration parity

| Comparison | Production | Development | Result |
|---|---:|---:|---|
| Migration names | 69 | 69 | Exact set match |
| Public tables | 81 | 81 | Exact set match |
| Public columns | 1,076 | 1,076 | Exact set match |
| Column data types/nullability | Same | Same | Exact set match |
| PostgreSQL patch version | 16.15 | 16.10 | Different patch version, not a schema mismatch |

The latest production migration is:

```text
stock_transfer_ledger_dates_v1
2026-08-29 11:41:38 UTC
```

The production `boot_status` records show successful production boots through 2026-09-04, including:

```text
all 16 date column(s) already correct
leave_revert: already applied
prod_reset_ghost_cleanup_v1: already applied
allocation_receipt_cleanup_2026_08_v1: already applied
calicut_txn_wipe_2026_08_v1: already applied
orphan_party_ledgers: none found
```

### Application/build parity

The production deployment log does not expose a commit hash. `/api/version` is protected and no production credentials were used. The public frontend exposes hashed assets:

```text
/assets/index-7Ot-DRJR.js
/assets/index-CXeJUTk6.css
```

The current workspace commit is `d425075`, whose changes are limited to the attached audit instructions and screenshot documentation. Therefore:

- No application-code difference is demonstrated between current workspace and the deployed build.
- Exact deployed commit identity remains unverified.
- Backup metadata observed in production has blank `git_commit` and `erp_version` `0.0.0`, so backups do not provide a reliable build fingerprint.

**Production status:** NOT TESTABLE for exact commit identity.  
**Development comparison:** Schema is identical; build identity is not directly comparable.

## C. Production database health

### Production data volume snapshot

| Domain | Rows |
|---|---:|
| Sales | 593 |
| Purchases | 61 |
| Customers | 162 |
| Vendors | 36 |
| Journal vouchers | 204 |
| Stock ledger rows | 2,381 |
| Activity-log rows | 5,772 |
| Stock entries | 144 |
| Stock batches | 199 |
| Stock reservations | 4 |
| Sales returns | 15 |
| Purchase returns | 1 |

### Integrity checks

| Check | Production result | Status |
|---|---:|---|
| Unbalanced journal vouchers | 0 | Not found |
| Orphan journal-voucher lines | 0 | Not found |
| Orphan stock-ledger references | 0 | Not found |
| Negative stock entries | 0 | Not found |
| Negative stock batches | 0 | Not found |
| Sales without location | 0 | Not found |
| Purchases without location | 0 | Not found |
| Duplicate sales identifiers | 0 groups | Not found |
| Active stale reservations | 1 | Confirmed |
| Active in-transit transfers | 0 | Not found |
| Batch/stock quantity mismatch | 0 | Not found |

### Confirmed stale reservation

```text
stock_reservations.id       = 18
doc_id                      = 9
doc_type                    = stock_transfer
material_type               = item
ref_id                      = 90
branch_type                 = warehouse
branch_id                   = 5
quantity                    = 5.000
status                      = active
transfer_status             = completed
```

The affected stock row currently contains:

```text
item 90 / warehouse 5
stock quantity = 3,900.000
batch quantity = 3,900.000
```

The reservation is therefore not a quantity/batch mismatch, but it is a state mismatch. If the normal availability calculation subtracts every active reservation, production availability is understated by 5 units.

**Production status:** CONFIRMED.  
**Severity:** HIGH.  
**Business impact:** Users may be blocked from selling or transferring stock that is physically available; inventory availability and transfer history disagree.  
**Development comparison:** Development had no stale active reservation in the earlier audit. Production is worse.

### Duplicate purchase values

Production has two repeated invoice-number groups:

```text
blank invoice number       5 rows, vendors 5, 19, 24, 26, 39
invoice number 2026/2027   2 rows, vendors 12 and 25
```

No non-blank invoice number repeats for the same vendor. The values are vendor invoice fields rather than the system’s generated purchase identity, so this is not confirmed duplicate transaction creation.

**Production status:** CONFIRMED data-quality condition; duplicate transaction not confirmed.  
**Severity:** MEDIUM.  
**Business impact:** Vendor invoice search, duplicate detection, import reconciliation, and audit review are weaker.

## D. Production accounting health

### Trial balance

```text
Total debits  = ₹4,340,224.05
Total credits = ₹4,340,224.05
Difference    = ₹0.00
```

**Production status:** NOT FOUND — no trial-balance imbalance.

### Party ledgers

All 162 customer masters have a matching `CUST-<id>` ledger. All 36 vendors have a matching `VEND-<id>` ledger. This corrected the initial exploratory join that used the wrong naming assumption.

Production customer and vendor ledger balances exist, including positive, zero, and credit balances. That is expected for the gross customer/vendor ledger model and does not by itself prove the ageing report is reconciled.

### Customer/vendor outstanding

The direct production query confirmed party ledger existence and voucher balance, but a complete outstanding reconciliation requires the application’s derived-posting and return/advance logic. It was not reproduced through an authenticated production report call.

**Production status:** NOT TESTABLE as a complete document-to-ledger reconciliation without authenticated report execution.  
**Partial evidence:** party ledgers exist; trial balance balances.

### Cash and bank

Production has location-specific cash ledgers. Read-only posting balances include:

```text
WH-CASH-1  Frozen Hub - Ragiguda Cash  -₹51,000.00
WH-CASH-2  Frozen Hub - Calicut Cash    -₹77,061.00
WH-CASH-3  Tropicane - Kochi Cash       ₹0.00
WH-CASH-4  Tropicane - Ecity Cash       ₹0.00
WH-CASH-5  CEEVEES IMPEX Cash           ₹0.00
```

These are accounting balances, not an independent physical-till or bank-statement reconciliation. No external bank/till source was queried.

**Production status:** NOT TESTABLE as an external cash/bank reconciliation.  
**Partial evidence:** ledger posting totals exist and overall vouchers balance.

### P&L and Balance Sheet

The production database has balanced journal lines, but a full P&L/Balance Sheet parity check requires executing `buildDerivedPostings()` and `buildBooks()` for the production data or calling authenticated report endpoints. No production credentials were used.

**Production status:** NOT TESTABLE as full report parity.  
**Development comparison:** The previously audited source logic and known historical limitations still apply unless a separate production build fingerprint proves otherwise.

## E. Production inventory health

### Current quantity and lot reconciliation

```text
item stock rows      = 144
stock quantity       = 56,296.500
batch quantity       = 56,296.500
negative stock rows  = 0
negative batch rows  = 0
```

**Production status:** NOT FOUND for negative/mismatched quantity conditions.

### Transfers

Production currently reports:

```text
completed transfers = 11
in-transit transfers = 0
```

The stale reservation described in Section C is the exception: transfer state is completed while an active reservation remains.

### Historical stock

The source logic still reconstructs historical stock by rewinding current stock with dated ledger movements and applying current valuation limitations. Production contains stock movements from 2026-05-17 through 2026-09-05, but that data range does not prove historical cost reliability.

**Production status:** CONFIRMED source-level limitation; production impact not fully measurable from unauthenticated endpoints.  
**Severity:** HIGH for historical financial reporting.

### Historical in-transit stock

No transfer is currently in transit, so no live in-transit position can be tested. The source model does not retain complete historical transfer receipt state for arbitrary past as-of dates.

**Production status:** NOT TESTABLE with current live state; limitation exists in development source and therefore remains a production risk.

## F. Production GST health

Production contains the expected GST ledgers:

```text
STD-INP-CGST
STD-INP-SGST
STD-INP-IGST
STD-OUT-CGST
STD-OUT-SGST
STD-OUT-IGST
```

A full production GST reconciliation between document-level `/gst/summary` and posting-derived Reports Center GST was not executed because those endpoints require authentication and no production credentials were used.

The source still has two separate calculation streams:

- document/table-derived GST summary;
- posting-derived financial-report GST.

**Production status:** NOT TESTABLE for current numeric divergence.  
**Development comparison:** Previously identified divergence risk remains present in source.  
**Severity:** HIGH reconciliation risk until the two sources are proven equal on production data.

## G. Production location and security health

### Location stamps

- Sales without location: `0`.
- Purchases without location: `0`.
- Invalid warehouse/outlet references for party masters: `0`.
- Invalid account-ledger location references: `0`.
- Invalid journal-voucher location references: `0`.
- All 4 `headoffice` customer rows use the valid system discriminator `headoffice` with location ID `0`.

### Unstamped vouchers

Production has two unstamped journal vouchers:

```text
337  Employee advance balance moved to Salary Payable — faisal
338  Employee advance balance moved to Salary Payable — Ramis
```

Both are system payroll migration vouchers dated 2026-08-15. They match the known development legacy condition and are not current user-entered postings.

**Production status:** CONFIRMED legacy data condition.  
**Severity:** MEDIUM.  
**Business impact:** Location-specific accounting reports must explicitly handle these rows or they may disappear from scoped views.

### Previously identified security risks

The following were confirmed in the workspace source but could not be directly exercised in production without authenticated cross-location accounts:

| Risk | Production status | Development comparison |
|---|---|---|
| Customer/vendor detail GET missing party scope | NOT TESTABLE | Confirmed in source |
| Best-effort audit logging | NOT TESTABLE through failure injection | Confirmed in source |
| Physical transaction deletion | NOT TESTABLE without authenticated mutation | Confirmed in source |
| Shared bootstrap/reset password risk | NOT TESTABLE without secrets/auth | Confirmed source risk |
| Logout/token revocation behavior | NOT TESTABLE without a production session | Confirmed source behavior |

Unauthenticated production API behavior is correct for the tested protected endpoints: `/api/version` and `/api/auth/me` return `401`.

## H. Production report and PDF health

The live login page loads correctly, but protected report/PDF screens were not opened without credentials.

Source-level risks therefore remain unverified in production:

- generic report exports accept client-prepared report rows;
- Chart of Accounts PDF filtering is presentation-only;
- historical stock reliability must be propagated to report consumers;
- GST document/posting streams can diverge;
- invoice and document renderers rely on stored source rows and location letterhead.

**Production status:** NOT TESTABLE for authenticated UI/report parity.  
**Public surface status:** Login page loads; static root page is visually coherent.

## I. Production HR/payroll health

Production contains salary and rent accruals through the audit date:

```text
salary accruals: 210 rows, 2026-08-01 through 2026-09-05
rent accruals:    94 rows, 2026-08-01 through 2026-09-05
```

This is evidence that the accrual schedulers have been running through the current date.

Complete payroll accounting parity was not executed because it requires application-derived posting logic and authenticated HR/report access.

Known source risk remains:

- bulk attendance correction commits first and invokes re-accrual afterward;
- an asynchronous re-accrual failure can leave accruals stale until scheduler catch-up.

**Production status:** Partial health confirmed; full payroll accounting reconciliation not testable.

## J. Production backup and restore health

Production backup metadata shows:

```text
backup metadata rows: 18
backup settings rows: 1
last_run_status: ok
last_run_at: 2026-09-05 01:26:49 UTC
```

The backup metadata observed in the production snapshot also contained a verified archive with seven checks passed on 2026-08-27. However, the production backup manifest had:

```text
erpVersion = 0.0.0
gitCommit  = ""
```

**Finding — MEDIUM:** backups exist and the scheduler reports success, but build-to-backup identity is incomplete. A restore operator cannot reliably prove which application commit produced the backup.

A production restore was not attempted because restore would be a mutation/destructive operation and explicitly prohibited by the audit request.

**Production status:** Backup scheduling partially confirmed; restore correctness not testable.

## K. Production scheduler and background-job health

### Backup scheduler

`backup_settings.last_run_status = ok` and `last_run_at` is current as of the audit date.

**Status:** Confirmed healthy from metadata.

### Salary and rent schedulers

Salary and rent accrual rows extend through 2026-09-05, indicating catch-up/scheduler activity.

**Status:** Partially confirmed.

### Startup migrations and repairs

Production logs show startup executes migrations and repair checks. Relevant log evidence:

```text
test_data_cleanup: skipped (production never deletes rows)
text_date_columns_to_date_v2: all 16 date column(s) already correct
leave_revert: already applied
voucher_provenance_v1: newly classified 0 manual / 0 system
storage_locations_setup: storage tables/indexes ensured
```

The deployment log also shows transient health failures while the API was booting:

```text
healthcheck /api returned 500
healthcheck /api returned 503
then /api/healthz returned 200
```

These recovered before the deployment became healthy.

**Finding — MEDIUM operational risk:** startup performs migration/repair work before readiness, and no-op migration messages are logged at error level. A monitor that treats every error-level line as a failed deployment may generate false alerts; a real migration delay can also temporarily fail health checks.

### In-process scheduler limitation

The source runs salary, rent, and backup schedulers inside the API process. Production data shows successful recent output, but no distributed lock or overlap telemetry was verified.

**Status:** Scheduler output partially confirmed; multi-instance/overlap behavior not testable.

## L. Confirmed critical issues

### L1. Active reservation attached to completed transfer

- **Production status:** Confirmed.
- **Severity:** HIGH.
- **Exact records:** `stock_reservations.id=18`, `doc_id=9`, `quantity=5`, `status=active`; transfer 9 is `completed`.
- **Evidence:** Production read-only query.
- **Business impact:** Available stock can be understated by 5 units; transfer history and stock availability disagree.
- **Development comparison:** Not present in earlier development census.
- **Production relative to development:** Worse.

No Critical severity issue requiring immediate production shutdown was confirmed. The stale reservation is the highest current production data-integrity issue.

## M. Confirmed high issues

1. **Historical stock valuation limitation**
   - Confirmed source design; production impact not fully quantified.
   - Historical stock depends on current quantity plus ledger rewind/current weighted-average cost.

2. **Historical in-transit limitation**
   - Confirmed source design; no current active transfer exists to exercise it.
   - Past in-transit state cannot be fully reconstructed.

3. **Audit logging can be lost**
   - Confirmed source behavior; production failure path not injected.
   - Audit insert failure is swallowed rather than durably retried or made transactional.

4. **GST document/posting source divergence**
   - Confirmed source architecture; production numeric divergence not tested without authenticated report access.

5. **Customer/vendor detail scope gap**
   - Confirmed development source; production endpoint behavior cannot be proven without an authenticated cross-location user.

## N. Medium issues

1. Production has two unstamped legacy payroll migration vouchers.
2. Five purchases have blank vendor invoice numbers.
3. Two repeated non-blank purchase invoice values exist across different vendors.
4. One reconciliation batch is `active` with zero item rows.
5. Backup metadata does not carry a reliable ERP version or git commit.
6. Startup emits transient health failures during migration readiness and logs no-op migrations as errors.
7. Generic report exports and return-void gaps remain source-level risks not exercised in production.
8. Cash/bank and party outstanding balances were not independently reconciled to external or application-report sources.

## O. Low issues

1. Public `/api/health` is 404 while the actual documented route is `/api/healthz`; this is not a functional defect but can confuse generic monitors.
2. `/api/version` is protected, so unauthenticated deployment fingerprinting is unavailable.
3. Public login copy advertises module/GST/live-report capabilities before authentication; this is informational disclosure of product scope, not a confirmed security exploit.

## P. Issues that cannot be verified

The following were intentionally not tested because they require credentials, mutation, or destructive operations:

- authenticated login → dashboard flow;
- Head Office, All Locations, and warehouse-specific UI behavior;
- Sales, Purchase, POS, Quotation, Other Charges, Stock Transfer screens;
- Cash, Bank, Payment, Receipt screens;
- Customer/Vendor Ledger screens;
- P&L, Balance Sheet, GST, Chart of Accounts, valued-only, and Month Wise screens;
- production PDF generation and generic exports;
- production return mutation/void behavior;
- production cross-location authorization attack;
- production logout/token revocation with a real session;
- restore from a production backup;
- production bank/till reconciliation against external statements;
- production payroll finalization/accounting reconciliation;
- production multi-instance scheduler overlap;
- exact deployed commit/build identity.

## Q. Top 10 fixes required

1. **Clear or compensate the stale reservation for completed transfer 9** through the approved application workflow, after confirming the physical quantity and audit trail.
2. Add a production invariant check: active reservations may only reference allowed transfer states.
3. Add the missing party-scope check to customer/vendor detail GET routes.
4. Add a first-class immutable void/reversal flow for sales and purchase returns.
5. Make audit delivery durable with an outbox/retry or fail the mutation when audit is mandatory.
6. Unify GST summary and posting-derived GST reporting, or expose an explicit source/reconciliation status.
7. Record deployment commit/version in the API and every backup manifest.
8. Reconcile and classify blank/repeated vendor invoice numbers; prevent ambiguous vendor invoice reuse where business policy requires uniqueness.
9. Make report exports server-recomputed or clearly label client-payload exports as snapshots.
10. Add a production reconciliation dashboard/check for transfer reservations, unstamped vouchers, backup freshness, and report-source parity.

## R. Overall production readiness rating

### Rating: CONDITIONAL / AMBER

The production ERP is operational and structurally aligned with development. Its database is internally balanced at the journal and stock/batch quantity levels, the public application is reachable, and schema/migration parity is strong.

It should not receive a “fully reconciled production” rating until:

- the completed-transfer reservation is resolved and the invariant is guarded;
- production P&L, Balance Sheet, GST, customer/vendor outstanding, and cash/bank reports are authenticated and independently reconciled;
- backup restore is rehearsed in a non-production environment;
- deployment commit/version identity is recorded;
- cross-location detail-read authorization is directly tested;
- audit-log completeness is proven under failure conditions.

## Production-versus-development conclusion

| Area | Production result | Relative result |
|---|---|---|
| Deployment availability | Public and healthy after startup | Operational |
| Schema | Exact table/column parity | Same |
| Journal balance | Balanced | Same/clean |
| Stock negatives | None | Clean |
| Batch/stock quantities | Exact match | Clean |
| Transfer state | One stale active reservation | Worse than development |
| Unstamped vouchers | 2 legacy payroll rows | Better than development’s 9, but same class |
| Customer/vendor ledgers | All present | Clean |
| Backup scheduler | Latest status `ok` | Partially healthy |
| Report/UI functional parity | Auth not available for audit | Not testable |
| Exact deployed commit | Not exposed | Not testable |

**Audit stopping point:** No changes were made. The production condition is documented above and should be reviewed before any remediation is approved.
