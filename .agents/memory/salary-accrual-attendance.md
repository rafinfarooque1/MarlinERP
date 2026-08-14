---
name: Attendance-driven salary accrual
description: Rules that keep the daily salary accrual and the month-end payroll figure from disagreeing in the Marlin ERP.
---

Salary accrues **per attended day**, at payroll's rate — not per calendar day.

Since Aug 2026 the day's worth comes from the company leave policy
(`dayContribution` → {work, leave} and the paid-casual-leave allowance — see
lop-leave-policy.md); the accrual walks the month cumulatively (cumWork/cumLeave)
and charges each day the delta. The rounding rules below still hold verbatim.

## Reproduce payroll's arithmetic, don't re-derive it

The month's earned basic must be computed with payroll's own expression, using the
**unrounded** per-day rate:

    perDay   = monthlySalary / workingDays          // NOT rounded
    lopDays  = max(0, workingDays − paidDaysSoFar)
    earned   = round2(monthlySalary − round2(lopDays × perDay))

(Since Aug 2026, `workingDays` = the month's ACTUAL calendar days —
`monthWorkingDays(year, month)` — everywhere: accrual, generation, approval.
The `payrollWorkingDays` setting is retired/ignored.)

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

## Untracked months: zero in the attendance era, full before it

Since Aug 2026 the owner reversed the legacy convention: a month with no attendance
rows at all earns **nothing** — but only for months on/after the accrual cutover
(`salary_accrual_config.attendance_from`) AND while the leave policy has LOP enabled
(LOP off means pay isn't attendance-based, so full pay stands). Pre-cutover months
keep the legacy full-pay reading forever — approved history must never restate.

**How to apply:** in the accrual walk no cutover check is needed (pre-cutover days
exit earlier); in payroll/monthLeaveSummary it's the `untrackedIsAbsent` calendar
flag, which generation and approval must BOTH set from `monthFirst >= cutover` or
approvals 409 forever. Zero-value accrual rows are still written (audit trail);
derived postings skip ≤0. The one-row cliff remains: partial backfill silently
prices every dateless day as absent.

## Employment status bounds the walk

Employees carry `employment_status` + `last_working_date` (LWD) — raw-migration
columns, raw SQL only; status is truth and `is_active` is derived from it. The
accrual clamps each span to `min(asOf, LWD)` and deletes rows dated after the LWD
in non-approved months, inside the employee accrual lock; the sweep includes
non-active employees that HAVE an LWD (it bounds the rebuild). Rows before an
employee's `salary_accrual_resume_from` are never re-walked — stranded relics
there need one-time corrections. See employment-status-lwd.md.
