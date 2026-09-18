# ERP Production Hardening Report

**Review date:** 2026-09-18  
**Scope:** Master ERP production-hardening brief  
**Development data policy:** No production database was queried, migrated, repaired, deleted from, or published.

## Development status

**DEVELOPMENT STATUS: NOT READY**

The codebase has received substantial hardening work, but the brief requires a complete accounting, historical inventory, settlement, GST, payroll, asset, export, backup/restore, security, and test gate. Several of those gates are intentionally reported as `WARN` until their authoritative evidence and isolated integration tests exist. This report does not claim production readiness.

## Implemented in this pass

### Accounting and valuation

- P&L and Balance Sheet calculations use the shared derived-posting/book path.
- P&L return splits use note-sourced postings rather than reclassifying arbitrary ledger movements.
- Balance-sheet retained earnings are cumulative to the requested cutoff.
- Internal entry balance, missing-ledger, unclassified-ledger, opening-balance, capitalization-overlay, and statement-difference issues are surfaced in the books result.
- Stock quantity is sourced from `stock_entries`; MRP is not used as inventory value.
- Finished goods, raw materials, packing materials, and sender-owned in-transit stock use one valuation path.
- Historical valuation uses dated cost checkpoints and movement evidence. Missing or contradictory evidence is reported as incomplete; current mutable master cost is not substituted.
- Reservations reduce available stock and do not reduce on-hand valuation.
- Batch/ledger/stock writes were tightened around material type, location, and transaction consistency.

### Financial write safety and scope

- Several financial mutation paths now write audit records on the transaction client before commit, so an audit failure can roll back the business mutation.
- Party, money, Cash & Bank, material, and stock paths received stricter location and identifier validation.
- Cash & Bank boot logic no longer silently chooses one member from a legacy multi-location account. Ambiguous memberships are diagnosed and left unchanged for explicit review.
- Financial schedulers now start only after the complete startup schema/repair sequence succeeds.
- Startup now exposes a separate liveness endpoint and does not mark readiness when base migration or core migration fails.
- The development-only test-data cleanup is guarded by a migration-log marker rather than re-running destructive shape-based deletion on every boot. Production never runs that deletion block.

### Financial Integrity Center

- Added read-only `GET /api/accounts/integrity`, restricted to Head Office users with the Chart of Accounts page permission.
- Added the Financial Integrity Center panel to the Chart of Accounts page.
- The endpoint returns exactly `FI-01` through `FI-27`, each with `PASS`, `WARN`, or `FAIL`, source, date, location, difference where measurable, and explanation.
- Unknown evidence is explicitly `WARN`; it is not converted to zero or green status.
- The first seven checks are wired to canonical book/valuation values. Negative stock is directly checked from `stock_entries`. The remaining checks identify the missing authoritative evidence or isolated test required to prove them.

### Report exports

- Added a strict canonical report request contract that accepts only report identity, validated filters, and display intent.
- Added server-side canonical document and CSV adapter layers that do not accept client-prepared rows or client-authored totals.
- Historical valuation warnings and integrity warnings are carried into canonical report output.
- Existing official export endpoints have not yet all been migrated to these adapters; this is a release blocker.

## Verification completed

| Check | Result |
|---|---|
| `pnpm run typecheck` | PASS |
| Permission registry check | PASS — 59 sidebar pages |
| Route guard audit | PASS — 405 routes |
| ERP production web build with `PORT=21940 BASE_PATH=/` | PASS |
| Backup archive unit test | PASS — 9 passed, 0 failed |
| API `/api/healthz/live` | PASS — 200 |
| API `/api/healthz` after managed restart | PASS — 200 |
| Unauthenticated integrity request | PASS — rejected with 401 |
| Managed API/web workflows | PASS — rebuilt and restarted without startup build errors |
| Production database access or repair | NOT RUN by design |
| Production publish/deploy | NOT RUN by design |

The web build emitted existing source-map warnings for UI primitives and a chunk-size warning; the build completed successfully.

## Remaining release blockers

1. **Complete isolated database test matrix.** No full database/business-flow suite was run because the development database contains real business data. A separate scratch database with explicit identity verification is required.
2. **Financial Integrity Center checks FI-08 through FI-27.** They currently return honest `WARN` results where a dedicated source query or fault-injection test is still needed.
3. **Authoritative export wiring.** Canonical PDF/CSV/XLSX generation must be connected to every official report export route, then compared against rendered report screens and parsed file totals.
4. **GST reconciliation.** Register, tax-ledger, place-of-supply, transfer, and party-GST parity need isolated positive/negative tests.
5. **Payroll and assets.** Accrual, statutory calculations, depreciation, disposal, employee status/LWD, and location-stamp parity need end-to-end proof.
6. **Historical inventory continuity.** Daily opening/closing continuity and transfer-in-transit continuity require reliable dated evidence across a scratch ledger.
7. **Settlement controls.** Customer/vendor balances, advances, credit notes, allocation capacity, duplicate settlement, and overpayment cases need canonical reconciliation tests.
8. **Backup/restore rehearsal.** An isolated backup must be restored into a fresh database and verified with schema, row-count, checksum, and representative report comparisons.
9. **Audit durability fault injection.** Every critical financial mutation must prove that an audit insert failure rolls back the mutation.
10. **Live production readiness evidence.** Production remains untouched. Before any publish decision, the isolated gates above must pass and any existing ambiguous location ownership must be explicitly reviewed rather than auto-reassigned.

## Limitations and non-claims

- This report does not certify that existing development records are financially correct.
- A balanced trial balance or balanced Balance Sheet is not treated as proof that no orphaned postings, missing history, or classification errors exist.
- No old transaction was rewritten to make a report balance.
- No permission was broadened to hide a missing source.
- The new diagnostic endpoint is a read-only observability surface, not a repair endpoint.
- The current deployment log contains unrelated database-endpoint-disabled errors from a deployment environment; no attempt was made to enable that endpoint or access production data.
