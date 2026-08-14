---
name: Payroll workflow
description: Three-state payroll workflow (draft→approved→paid), accounting entries, advances, and hours-based attendance scoring.
---

## Workflow states
- `draft` — LIVE (Aug 2026): viewing a month refreshes its drafts from current attendance (locked/finalised months skipped). Generate/Regenerate buttons are gone; the old generate endpoint survives as a compat alias and must stay paisa-identical to the refresh.
- `approved` — accounting entry created (Dr Salary Exp / Cr Salary Payable)
- `paid` — fully paid (or `paid_amount >= net_pay`); partial payments stay `approved`

## Absence-classification gate at approval (Aug 2026)
Unclassified absent day = post-cutover tracked month (≥1 attendance row), day ≤ business today, within join→LWD, no attendance row, not a holiday/weekly-off-rule day. Approval (inside the accrual lock, after the drift check) 409s with `code: UNCLASSIFIED_ABSENCES` + dates unless body `{confirmLop:true}`. Managers classify via PUT /hr/attendance (CL→leave/casual, SL→leave/sick, Paid→weekly_off, LOP→absent); GET /hr/payroll/unclassified-absences lists them. Payroll test suites that approve fixture months with gap days must pass `confirmLop:true`.

**Refresh-on-read discipline:** the live refresh writes (drafts + advance claims), so it runs only for head-office callers with the payroll `add` right — everyone else reads stored rows. Same-month refreshes serialise on an advisory lock, with a DB unique index on employee+month as backstop. Both refresh AND approval must derive every figure from the payroll row re-read under its own row lock — nothing read before the lock may be trusted.
**Why:** a live view that writes turns every viewer into a writer; concurrent materialisation of an untracked month double-inserts; and either ordering of a refresh-vs-approval race corrupts the books when pre-lock figures are used — approval posts stale net pay and strands claimed advances, or refresh resets a posted document back to draft.

**Period-completeness gate (checked FIRST, before classification):** the same rowless-day scan runs to the period end (month end, or LWD for leavers). Any rowless day AFTER business today ⇒ 409 `code: MONTH_INCOMPLETE`, and `confirmLop` does NOT override — approving mid-month would freeze the projection of future days as LOP into the books permanently (approved months refuse corrections).
**Why:** confirmLop is a statement about days that occurred, never about days that might; without this gate a manager who classified all past days could still underpay the rest of the month.
**How to apply:** a period counts complete when it has ended OR every remaining day carries a stored attendance/holiday/weekly-off row (a roster entered ahead). Test suites that approve the CURRENT month must either resign the fixture employee with LWD ≤ today (figures untouched when attendance sits below the cap) or fill the remaining days with stored rows.

## DB columns (added via startup migration — raw SQL only, invisible to Drizzle)
`payroll`: status, approved_at, extra_amount, extra_note, paid_amount, payment_mode, advance_deduction  
`employee_advances`: id, employee_id, amount, date, note, is_deducted, deducted_payroll_id, created_at  
`company_settings`: general_settings JSONB (holds fullDayHours, halfDayHours, and Settings.tsx keys)

## Accounting entries
| Event | Debit | Credit |
|-------|-------|--------|
| Approve | `SAL-EMP-{id}` under SYS-INDEXP | `SAL-PAY-{id}` under SYS-CURL |
| Pay | `SAL-PAY-{id}` | STD-CASH or STD-BANK |
| Advance | `SAL-PAY-{id}` (payment voucher, source='employee_advance') | STD-CASH or chosen till |

(ADV-EMP-* Current-Asset ledgers retired Aug 2026 — balances migrated onto SAL-PAY, subtree deactivated; see advance-recovery.md.)

Ledgers are per-employee, auto-provisioned by `findOrProvisionLedger()` in hr.ts.

## Hours-based attendance scoring (payroll generate)
- `fullDayHours` / `halfDayHours` read from `company_settings.general_settings` (defaults: 9 / 4.5)
- Configurable via Settings page → Payroll section
- Since Aug 2026, `leave` days are paid only through the company paid-casual-leave allowance; half days consume 0.5 of it — see lop-leave-policy.md for the full rule (dayContribution / monthLeaveSummary are the only pricing path)
- Working-days basis = the payroll month's ACTUAL calendar days (`monthWorkingDays(year, month)` in attendanceFactor.ts). Both `payrollWorkingDays` (settings blob) and `pay_components.working_days_per_month` are retired from pricing; a stored `payrollWorkingDays` key is accepted and ignored. `salaryDay` retired too (was display-only).
- Only checkIn without checkOut → counted as full day
- No attendance records → assume full attendance (pre-cutover months only; post-cutover untracked month = ZERO pay and NO payroll row)
- `payroll.paid_leave_used`/`paid_leave_allowed` snapshot the policy per run; NULL = pre-policy row, UIs omit the leave line

## Advance deduction
- Pending advances fetched at generate time, summed → `advance_deduction` stored on payroll row
- `net_pay = max(0, computed_net - advance_deduction)`; advances NOT marked deducted at generate time
- Approval posts NO advance leg: SAL-PAY credit = `round2(netPay + advanceRec − accrued)` — the advance's own Dr on SAL-PAY offsets it to net pay owed
- Advances can only be added by headoffice users; non-HO employees see only their own

**Why:** Marking advances as deducted only at generate avoids issues if payroll is regenerated multiple times.
