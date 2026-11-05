---
name: Financial integrity diagnostics
description: Integrity checks must separate proven equality from unavailable evidence and remain read-only.
---

# Integrity diagnostics must fail closed on unknown evidence

**Rule:** A financial integrity check may return PASS only when both sides come from authoritative sources and the comparison was actually performed. Missing history, unavailable sub-ledgers, and untested atomicity are WARN (or FAIL when a contradiction is observed), never zero-valued PASS results.

**Why:** A balanced trial balance or a mathematically balanced statement can coexist with orphaned postings, fabricated historical stock, settlement duplication, or an audit write that was not atomic. Treating unavailable evidence as zero hides the exact failures the diagnostic is meant to find.

**How to apply:** Return source, date, location, actual, expected, difference where measurable, and an explanation for every check. Keep the diagnostic read-only; repair paths require separate reviewed migrations and isolated tests.

**Presentation rule:** Use `UNVERIFIED` for checks whose authoritative evidence/query is not materialized yet. Reserve `WARN` for a measured condition that deserves review, and `FAIL` for a proven contradiction.

**Why:** Treating every unavailable check as WARN makes a healthy 0-FAIL result look like a P&L defect and encourages unsafe “fixes” that only turn unknowns green.

**How to apply:** Keep the distinction in both the API summary and the integrity panel; a reliable inventory mismatch is FAIL, while an unreliable historical valuation is UNVERIFIED.

## FI-05 net-profit identity

**Rule:** Compare `grossProfit + otherIncome - operatingExpenses` with `netProfit`. The canonical `operatingExpenses` value is the complete indirect-expense total and already includes depreciation; do not subtract depreciation a second time. Keep depreciation-specific reconciliation under FI-16.

**Why:** The P&L summary proves the combined totals identity, while depreciation is nested inside the indirect-expense group. An extra subtraction would double-count it and manufacture a mismatch.

**How to apply:** Read all four values from `buildBooks.profitAndLoss.summary`, return measured actual/expected/difference evidence, and reserve depreciation idempotency and accumulated-balance checks for asset-specific evidence.

## Stock comparison must use the statement's ownership scope

**Rule:** Inventory integrity comparisons must use the same valuation options as the canonical statements, including sender-owned in-transit stock.

**Why:** Excluding a valid ownership component from the diagnostic creates a deterministic false mismatch even when the P&L and Balance Sheet agree.

**How to apply:** When changing stock valuation inclusion rules, update FI-06/FI-07 and the statement engine together; verify both on-hand and in-transit components.