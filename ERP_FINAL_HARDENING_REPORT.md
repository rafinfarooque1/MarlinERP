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

### Inventory transfer and historical correction closure

- Transfer receipt events accept a validated business date and persist it separately from the HTTP approval timestamp.
- Historical in-transit valuation uses the persisted receipt date, so completed receipts do not remain in transit until the day they were approved.
- Transfer headers persist server-enriched costs and batch breakdowns; receive/reject paths no longer fall back to client-omitted zero costs.
- Legacy zero-cost transfer ledger rows use the latest dated checkpoint as evidence when available; missing evidence remains an explicit warning.
- Historical purchase deletion uses a current-date correction only when a newer checkpoint makes dated replay impossible, avoiding an unhandled 500 while preserving the backdate guard.

## Verification completed

| Check | Result |
|---|---|
| `pnpm run typecheck` | PASS |
| Permission registry check | PASS — 59 sidebar pages |
| Route guard audit | PASS — 405 routes |
| ERP production web build with `PORT=21940 BASE_PATH=/` | PASS |
| Backup archive unit test | PASS — 9 passed, 0 failed |
| Isolated accounting acceptance suite | PASS — 37 passed, 0 failed |
| Isolated GST suite | PASS — 12 passed, 0 failed |
| Isolated fixed-assets suite | PASS — 40 passed, 0 failed |
| Isolated transfer receiving/valuation suite | PASS — 43 passed, 0 failed |
| Isolated balance reconciliation suite | PASS — 73 passed, 0 failed |
| Isolated payroll LOP suite | PASS — 21 passed, 0 failed |
| Isolated salary accrual suite | PASS — 21 passed, 0 failed |
| Isolated payroll auto-calculation suite | PASS — 29 passed, 0 failed |
| Isolated attendance punches suite | PASS — 14 passed, 0 failed |
| Isolated bulk attendance suite | PASS — 9 passed, 0 failed |
| Isolated leave approval suite | PASS — 21 passed, 0 failed |
| Location-cost valuation suite | WARN — 35 passed, 4 failed only because company-wide opening evidence for the prior date is incomplete; fixture valuation, cleanup, deletion, transfer, and trial-balance checks passed |
| API `/api/healthz/live` | PASS — 200 |
| API `/api/healthz` after managed restart | PASS — 200 |
| Unauthenticated integrity request | PASS — rejected with 401 |
| Managed API/web workflows | PASS — rebuilt and restarted without startup build errors |
| Production database access or repair | NOT RUN by design |
| Production publish/deploy | NOT RUN by design |

The web build emitted existing source-map warnings for UI primitives and a chunk-size warning; the build completed successfully.

## Remaining release blockers

1. **Historical inventory evidence.** The location-cost suite still reports the company-wide opening position for the prior date as incomplete because existing stock lacks a dated checkpoint. This must be resolved with authoritative evidence or remain a documented release failure; current master cost must not be substituted.
2. **Financial Integrity Center checks FI-08 through FI-27.** They currently return honest `WARN` results where a dedicated source query or fault-injection test is still needed.
3. **Authoritative export wiring and parity.** Canonical PDF/CSV/XLSX generation is not yet connected to every official report export route and compared with rendered screens and parsed totals.
4. **Backup/restore rehearsal.** A scratch backup must be restored into a fresh database and verified with schema, row-count, checksum, and representative report comparisons.
5. **Audit durability fault injection.** Every critical financial mutation must prove that an audit insert failure rolls back the mutation.
6. **Remaining breadth gates.** RBAC/LBAC breadth, cache invalidation/304 behavior, dashboard/report parity, mobile distribution, and FI-08–FI-27 evidence still require their dedicated isolated checks.
7. **Live production readiness evidence.** Production remains untouched. Before any publish decision, every remaining isolated gate above must pass and any ambiguous location ownership must be explicitly reviewed rather than auto-reassigned.

## Limitations and non-claims

- This report does not certify that existing development records are financially correct.
- A balanced trial balance or balanced Balance Sheet is not treated as proof that no orphaned postings, missing history, or classification errors exist.
- No old transaction was rewritten to make a report balance.
- No permission was broadened to hide a missing source.
- The new diagnostic endpoint is a read-only observability surface, not a repair endpoint.
- The current deployment log contains unrelated database-endpoint-disabled errors from a deployment environment; no attempt was made to enable that endpoint or access production data.
