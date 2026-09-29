# Frozen Fruits ERP — Current Issues Register

**Audit status:** IN PROGRESS — Phase 1 only  
**Snapshot date:** 2026-09-29  
**Functional code changes:** none during this documentation audit  
**Production database:** NOT QUERIED

This register separates confirmed documentation defects from unverified historical code findings. “No confirmed code issue yet” means the code audit is incomplete; it does not mean the ERP has no code issues.

## Confirmed documentation findings

| ID | Area | Current finding | Expected condition | Evidence | Severity | Risk / user impact | Status |
|---|---|---|---|---|---|---|---|
| DOC-001 | Existing master documentation | `ERP_COMPLETE_DOCUMENTATION.md` contains eight byte-identical copies of the same 1,195-line document (9,560 lines total). | One maintained copy with a clear current snapshot and progress state. | Eight consecutive 1,195-line blocks have the same SHA-256 digest; verified 2026-09-29. | MEDIUM | Makes edits ambiguous, wastes review effort, and can hide stale information. Documentation issue only. | CONFIRMED |
| DOC-002 | Historical schema inventory | `docs/ERP_SYSTEM_AUDIT.md` states 69 tables and no triggers. The read-only development schema snapshot on 2026-09-29 found 93 public base tables and three trigger objects. | Schema counts and triggers should be dated and scoped to the environment they describe. | `docs/ERP_SYSTEM_AUDIT.md` §3; development `information_schema.tables` and `information_schema.triggers`. | MEDIUM | Readers may rely on an obsolete table/trigger inventory. Production schema was not queried. | CONFIRMED STALE |
| DOC-003 | Readiness / integrity status | `ERP_FINAL_HARDENING_REPORT.md` (2026-09-18) says FI-08–FI-27 remain WARN. Current source and development schema include a later FI-08 daily-close implementation and its tables. | Readiness reports should distinguish historical status from current code/evidence. | Report §“Remaining release blockers”; current `artifacts/api-server/src/routes/integrity.ts`, `src/lib/dailyStockClosures.ts`, and development schema metadata. | MEDIUM | Readers may mistake a pre-change report for the current FI-08 status. Runtime close coverage itself is not asserted by this documentation finding. | CONFIRMED STALE |

## Historical findings pending source verification

These are leads from earlier documentation, not current confirmed defects. They are excluded from the confirmed issue total until the relevant current route/service and tests are inspected.

| ID | Historical finding | Source of lead | Current status |
|---|---|---|---|
| HIST-001 | GST credit/debit-note treatment in returns was listed as an open accuracy issue. | `docs/ERP_SYSTEM_AUDIT.md` August addenda and `ERP_COMPLETE_DOCUMENTATION.md` known-issues section. | NOT VERIFIED against current GST return queries, tax helpers and tests. |
| HIST-002 | Sale cancellation was reported to lack a frontend surface despite an API endpoint. | `docs/ERP_COMPLETE_DOCUMENTATION.md` and August audit addendum. | NOT VERIFIED against the current route tree and sale UI callers. |

## Documentation conflicts to adjudicate in later phases

- `SOURCE_OF_TRUTH.md` contains stock-ledger and accounting statements that conflict with later repository documentation. Inspect the current writers, `buildDerivedPostings` consumers and report routes before calling any statement a product defect.
- `ERP_COMPLETE_DOCUMENTATION.md` and `ERP_FINAL_HARDENING_REPORT.md` predate some current code. No severity or release-readiness conclusion is carried forward without revalidation.

## Phase 1 totals

- Confirmed documentation issues: **3**
- Confirmed functional/code issues: **NOT ASSESSED**
- Historical issue candidates: **2**, not included in confirmed totals
- Critical/high functional issues: **NOT ASSESSED**

**DOCUMENTATION PROGRESS:** Phase 1 complete; module-by-module issue review remains.