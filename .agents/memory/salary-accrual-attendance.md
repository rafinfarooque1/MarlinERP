---
name: Attendance-driven salary accrual
description: Rules that keep the daily salary accrual and the month-end payroll figure from disagreeing in the Marlin ERP.
---

Salary accrues **per attended day**, at payroll's rate — not per calendar day.

## Reproduce payroll's arithmetic, don't re-derive it

The month's earned basic must be computed with payroll's own expression, using the
**unrounded** per-day rate:

    perDay   = monthlySalary / workingDays          // NOT rounded
    lopDays  = max(0, workingDays − paidDaysSoFar)
    earned   = round2(monthlySalary − round2(lopDays × perDay))

Charge each day the *increase* in `earned` so no per-day rounding accumulates.

**Why:** the algebraically "equivalent" `round2(paidDays × perDay)` is not equivalent
once rounding enters. At ₹20,000 over a 26-day basis with one day of loss of pay it
gives ₹19,230.75 where payroll gives ₹19,230.77. Rounding the per-day rate *before*
multiplying makes it worse. Approval then trues up a two-paise difference that nothing
in the books explains, on every employee, every month.

**How to apply:** any second place that prices a day of salary — accrual, projections,
reports — copies the formula above verbatim. If you catch yourself writing
`days × rate`, stop. The cap falls out of `max(0, …)` for free, so don't add a separate
`min(monthlySalary, …)`.

## Generation freezes; attendance keeps moving

Payroll generation snapshots gross/net onto the payroll row. A later attendance
correction re-prices the accrual immediately but leaves that row alone. Approval, which
posts the *difference* between the frozen figure and what accrued, then trues up to a
number the attendance no longer supports and books the gap as salary cost.

**Why:** two writers with different notions of "now", and only one of them is
re-triggered by a correction.

**How to apply:** at approval, recompute paid days from current attendance **inside the
same lock/transaction** that reads the accrued total, and refuse loudly if it disagrees
with the stored figure ("regenerate, then approve"). Checking outside the lock is
worthless — a sweep can land between the check and the voucher. This is a conflict the
approver can fix, so it is a 409, not a 500.

## Untracked months are full attendance

A month with no attendance rows at all earns a full salary, matching payroll. The
consequence is a cliff: once **one** row exists in a month, every dateless day in that
month counts as absent. Deliberate — mirrored from payroll rather than invented — but
it means partial attendance backfill silently cuts a month's salary.
