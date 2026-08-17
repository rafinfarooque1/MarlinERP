---
name: Periodic (Month/Day Wise) breakdown
description: How the Tally-style bucketed P&L reconciles with the statements; opening-stock contract; where the shared UI lives
---

# Periodic Month/Day Wise breakdown

`GET /accounts/periodic-summary` (api-server `lib/periodicSummary.ts`) returns per-month/per-day buckets of Sales | Purchase | Expense | Payment | Receipt | GP | NP plus whole-range totals. Frontend: shared `components/app/period-breakdown.tsx`, mounted in Chart of Accounts (Summary/Month/Day toggle) and Reports → Financial ("Month / Day Wise" sub-report; drill → 'pnl').

## Reconciliation pattern (reusable)
- ONE `buildDerivedPostings` pass, sliced by location, bucketed by `date.slice(0,7|10)` on the same `chart.idsUnder` subtrees buildBooks uses (skip orphan ids + CAPITALISATION_LEDGERS overlay ids).
- GP/NP per bucket = periodic-inventory formula off stock valuations at bucket BOUNDARIES. Boundaries telescope, so day-sums == month bucket == range totals **by construction** — never sum per-bucket recomputations.
- Valuations only for the requested page + range edges, deduped in a promise cache, concurrency-capped. `toDate` clamps at today (`closingStockAt` for today, `stockAsOf` for the past).

## Opening-stock contract (deliberate — do not "fix")
Inception opening keys off whether the REQUEST supplied fromDate, not the derived effFrom. This mirrors the undated financial-statements exactly, so the unbounded breakdown always ties to the "All" Summary beside it. Edge data with stock before the first posting makes a first-bucket drill diverge — an engine semantic that already exists between "All" and explicit-range statements. Comment in periodicSummary.ts explains; architect reviewed and accepted.

## Traps hit
- Explicit JSX generics (`<RTable<Row> …>`) crash the vite parser (see quotations-module) — struck again here in components/app.
- Pager reset on filter change must be SYNCHRONOUS (key page state by the input tuple, ignore stale in-render); a useEffect reset lets one query fire for the new range at the old page.
- The drill contract: bucket click passes its exact [from..to] to the HOST page, which re-uses the existing detailed report (custom period + view switch) — no duplicate report pages.
