---
name: LOP leave policy
description: Company-wide payroll leave policy (working days, paid casual leave, LOP) — one formula shared by accrual, payroll, approval; NULL snapshot semantics.
---

# Company-wide LOP leave policy (Aug 2026)

Policy lives in `company_settings.general_settings` JSONB: `payrollWorkingDays`
(default 30), `paidCasualLeavesPerMonth` (default 4), `lopEnabled` (default true).
Sanitized ONLY in `loadPayrollSettings()` (attendanceFactor.ts) — wd clamps 1–31
integer, allowance clamps 0..wd. PATCH /company/settings validates the incoming
blob (it replaces the stored one wholesale, so the incoming object IS the
effective value).

## The one formula
- `dayContribution(day) → {work, leave}`: leave={0,1}; hrs≥full={1,0};
  hrs≥half={0.5,0.5} (missing half CONSUMES allowance); <half or absent={0,0}
  (straight LOP, does NOT consume allowance); checkIn-only/present={1,0};
  half_day status={0.5,0.5}.
- `monthLeaveSummary()`: untracked month = full attendance; paidLeaveUsed =
  min(leaveTaken, allowance); payableDays = min(wd, worked+paidLeaveUsed);
  lopDays = wd − payableDays; lopEnabled=false ⇒ payableDays=wd (full pay,
  accrual basis `no_lop`).
- Consumers: payroll generate, approval re-check, daily accrual (cumulative
  cumWork/cumLeave deltas), all through these two helpers. **Why:** a second
  hand-rolled copy is exactly how the pre-policy accrual drifted paise from
  payroll. **How to apply:** never price a day outside dayContribution /
  monthLeaveSummary; keep the expected-expression
  `round2(salary − round2(lop × unroundedPerDay))` verbatim.

## Retired: per-employee working days
`pay_components.working_days_per_month` is NO LONGER READ for pricing (column
kept; UI passes the stored value through untouched). `DEFAULT_WORKING_DAYS=26`
survives only as a display fallback for pre-policy accrual rows. The employee
pay-structure editor shows a note pointing at Company → Settings → Payroll.

## NULL snapshot = policy didn't exist
`payroll.paid_leave_used` / `paid_leave_allowed` (raw boot-migration NUMERIC
columns) are NULL on rows generated before the change. Payroll UI, CSV and
payslip PDF switch their attendance layout on `paidLeaveAllowed != null`; they
must OMIT the leave line for NULL, never render 0 ("0/4 leave" claims leave was
tracked and unused). Stored present_days = days PAID (worked + paid leave), so
new layouts show worked = present − paidLeaveUsed.

## Policy edits and open months
Changing any policy key re-prices every UNAPPROVED month at the next accrual
sweep and makes existing drafts stale — approval re-checks live policy inside
the lock and refuses with "regenerate". Approved/paid months never move.

## Test suites pin the policy
salary-accrual / attendance-punches / leave-approval / lop-payroll suites
pin+restore `generalSettings` via PATCH. attendance-punches pins allowance=0 —
with any allowance, the policy tops half days up to full pay and hours-based
pricing assertions go invisible. Fixtures use salary 30000 (₹1,000/day at wd 30).
