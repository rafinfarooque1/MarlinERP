---
name: Company holidays & weekly offs
description: How holidays, weekly-off rules and the casual/sick leave split price attendance — calendar vs stored rows, the until bound, and the moved accrual cutover trap.
---

## Model
- `company_holidays` (date UNIQUE + name) is company-wide; weekly offs live in general_settings as rules `{day, weeks:'all'|[1..5], policy:'paid'|'casual_leave'}` (UTC weekday, nth-of-month = Math.floor((d−1)/7)+1).
- A **stored attendance row always outvotes the calendar** for its date — that IS the per-employee override mechanism; there is no per-employee holiday table.
- Rowless days in a TRACKED month are judged calendar-first: holiday/paid-off → paid (`basis 'holiday'/'weekly_off'`), casual_leave-policy weekly off → draws from the casual allowance, otherwise absent. **Untracked months never get calendar synthesis** — a holiday row must not flip an untracked month to tracked economics.
- Casual and sick allowances cap independently: payable = min(wd, work + paidOff + min(casual, allow) + min(sick, allow)). `attendance.leave_type` NULL (legacy) = casual. Payroll snapshots `sick_leave_used/allowed` (NULL = pre-policy, omit never zero).
- Holiday create/delete are HO-only and re-run the FULL accrual sweep (locked months skipped) — deleting a test holiday restores the books exactly, so create+delete of a far-past dummy holiday is a clean way to force a full re-price after restoring pinned settings.
- Weekly-off marking past an exhausted casual allowance: action='ask' → advisory 409 `{code:'CASUAL_LEAVE_EXHAUSTED'}`, resubmit `force:true` records it unpaid; action='absent' → the day is STORED as absent (force does not bypass — the setting is the answer). The gate judges the WHOLE month like the pay formula, so future scheduled Sundays count and it can warn even with allowance left today.
- Every attendance GET the correction UI reads from must surface `leaveType` (raw SQL — drizzle drops the column); otherwise reopening a sick row silently reclassifies it casual on save.
- Settings PATCH re-runs the full accrual sweep when a pay-policy key (workingDays, casual/sick allowance, lopEnabled, weeklyOffs, exhausted action) actually changed — so test recipes that pin policies now touch real open months; each restore-PATCH self-heals by sweeping under restored settings.

## The `until` bound (mid-month leave balance)
`MonthCalendarContext.until` clamps **synthesised** calendar days only; stored rows (leave approved in advance) always count. Only GET /hr/leave-balance sets it (= business today).
**Why:** without it the balance card counted every future Sunday of the month as casual leave already taken (day 6 showed 0 remaining). Payroll/accrual never set it — a generated month is judged whole by convention.
**How to apply:** any new "how much leave is left right now" surface must pass `until`; any month-end money math must NOT.

## Accrual cutover moves — fixture suites break silently
`salary_accrual_config.attendance_from` is MOVED FORWARD by company reset (and a retrack endpoint sets it to CURRENT_DATE). Days before it accrue NOTHING for new employees — no rows, no errors. The pinned July-2026 suites (salary-accrual, attendance-punches, leave-approval, lop-payroll) then fail with "accrued ₹0 over 0 earning days" while payroll figures stay correct — that signature means CUTOVER, not a pricing bug.
**How to run them anyway:** verify every real employee's fixture-month payroll is absent-or-draft impact-wise, snapshot real accrual rows, temporarily set attendance_from to the fixture month start, run, restore the cutover, delete any fixture-month rows for real employee ids, parity-check the snapshot. Full sweeps fire only from holiday create/delete + the hourly timer — settings PATCH does not sweep.
