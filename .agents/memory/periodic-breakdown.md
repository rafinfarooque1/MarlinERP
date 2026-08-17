---
name: Periodic (Month/Day Wise) statements
description: Chart of Accounts Month/Day Wise = full statements per bucket via the existing engine; bucket enumerator contract; pager/JSX traps
---

# Periodic Month/Day Wise statements

The first build (a Tally-style KPI table: Sales|Purchase|Expense|GP|NP columns, shared with Reports → Financial) was **rejected by the user**. The shipped design (Aug 2026):

- Chart of Accounts keeps its Summary view; Month Wise / Day Wise render collapsible per-period sections, each containing the **COMPLETE existing statements** (full BS + P&L hierarchy) for that bucket. No separate report page; the Reports → Financial "Month / Day Wise" entry and `components/app/period-breakdown.tsx` were removed.
- Server: `/accounts/periodic-summary` is now a slim **bucket enumerator** (`buildPeriodicBuckets` in api-server `lib/periodicSummary.ts`) — keys + date ranges only, **no money computed**. Open-ended "All" derives its start from the first in-scope posting (orphans excluded). Page window is generated **arithmetically** (never materialise the whole range and slice — a decades-long day range must stay O(page)).
- Client: each expanded bucket fetches the EXISTING `/accounts/financial-statements` for its exact sub-range, with a query key **identical in shape** to the Summary query so cache is shared; chart edits invalidate the whole `['fin-stmt']` prefix. Only expanded buckets fetch (lazy); default open = first bucket (all when ≤3).
- Reconciliation holds **by construction** (same engine, telescoping stock boundaries): BS as-of bucket end, P&L activity within bucket; Σ monthly GP/NP == whole-range GP/NP to the paisa.
- Ledger click inside a bucket opens the existing LedgerStatementSheet with THAT bucket's from/to (selectedLedger carries the range, not just the node).

## Location scoping trap (found in review)
The CoA page's legacy outlet dropdown sent `outletId` — a param the statements route **never read**, so it silently did nothing. Scope must flow through the canonical `locationType`/`locationId` params (query beats the global-context headers server-side), and the SAME effective scope must feed Summary, bucket enumeration, every bucket's statements AND the ledger sheet, or figures on one screen disagree.

## Traps (still current)
- Explicit JSX generics (`<RTable<Row> …>`) crash the vite parser.
- Pager reset on filter change must be SYNCHRONOUS (key page/open state by the input tuple); a useEffect reset lets one query fire for the new range at the old page.
