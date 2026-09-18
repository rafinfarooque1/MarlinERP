---
name: Financial integrity diagnostics
description: Integrity checks must separate proven equality from unavailable evidence and remain read-only.
---

# Integrity diagnostics must fail closed on unknown evidence

**Rule:** A financial integrity check may return PASS only when both sides come from authoritative sources and the comparison was actually performed. Missing history, unavailable sub-ledgers, and untested atomicity are WARN (or FAIL when a contradiction is observed), never zero-valued PASS results.

**Why:** A balanced trial balance or a mathematically balanced statement can coexist with orphaned postings, fabricated historical stock, settlement duplication, or an audit write that was not atomic. Treating unavailable evidence as zero hides the exact failures the diagnostic is meant to find.

**How to apply:** Return source, date, location, actual, expected, difference where measurable, and an explanation for every check. Keep the diagnostic read-only; repair paths require separate reviewed migrations and isolated tests.