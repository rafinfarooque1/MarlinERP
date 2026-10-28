---
name: Sales report fixture drift
description: Regression checks tied to mutable development sales and payment records
---

Captured sales-report test IDs can keep their invoice totals while payment rows or outstanding balances change. A failing all-fields snapshot may therefore be unrelated to a report change.

**Why:** The sales report definition test's fixed payment totals no longer matched its development rows, while its invoice totals and the new quantity aggregation remained internally consistent.

**How to apply:** When this suite fails, compare the specific response field to its source rows and verify the changed report measure independently. Do not change business data or weaken unrelated assertions just to make a stale snapshot pass.
