---
name: Fixture-month tests vs clock rollover
description: Why a hardcoded-month test suite starts failing the month after it was written, and the two corrections that fix it.
---

# Fixture-month tests vs the real clock

Suites that pin a fixture month (e.g. July 2026) but exercise flows that stamp documents with the RUN day break as soon as the real calendar rolls past the fixture month. Two distinct mechanisms, both hit on 1 Aug:

1. **Ledger read windows:** approval/payment vouchers are dated "today", so any trial-balance/P&L read capped at the fixture month's last day silently excludes them. Fix: read to `max(fixtureMonthEnd, today)`.
2. **Fixture bleed into the current month:** the daily salary accrual treats an attendance-untracked month as full attendance, so a fixture employee that lives past its month accrues for TODAY too. Payable assertions must net out `salary_accruals` rows outside the fixture month (expense/P&L comparisons must stay raw — both sides see the bleed equally).

**How to apply:** when a previously-green money suite fails with every figure off by the same clean amount (e.g. exactly one day's pay), check the calendar before suspecting the code. And when writing new suites, never cap ledger reads at the fixture month.

Also: browser `getCurrentPosition`'s `timeout` option only starts counting AFTER permission is granted — an unanswered permission prompt calls neither callback. Any UI awaiting it needs its own hard deadline (`Promise.race`/setTimeout) or the button spins forever, which in headless test browsers looks exactly like a disabled button.
