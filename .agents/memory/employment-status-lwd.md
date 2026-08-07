---
name: Employment status & last working date
description: How resignation/termination bounds payroll and accrual in the Marlin ERP, and the traps in the leaver write paths.
---

Employees have `employment_status` (active/resigned/terminated/inactive) and
`last_working_date` (LWD) — raw-migration columns on `employees`, invisible to
drizzle, read/written via raw SQL only. The PATCH route reads them from the RAW
body (zod strips unknown keys).

## The model

- Status is truth; `is_active` is derived (non-active ⇒ false). A legacy
  `isActive`-only body maps back onto a status (false keeps a richer stored
  status, else 'inactive').
- Non-active always has an LWD (defaults to today when omitted). Reactivation
  clears the LWD; resumption is the existing `salary_accrual_resume_from` stamp
  (never backfills the gap).
- Legacy deactivations WITHOUT an LWD keep old behavior: excluded from payroll,
  accrual stops, nothing deleted — there is no boundary to rebuild against.

## Why the LWD is load-bearing

Leaving stops FUTURE pay, not pay already earned. Generation includes
ex-employees whose LWD ≥ month start; attendance rows after the LWD are clamped
out; payable days are capped at the LWD's day-of-month (so a pre-cutover
full-pay month can't pay past the exit either).

**Generation and approval must be paisa-identical**: the same LWD clamp, the
same `employedDaysCap`, the same `untrackedIsAbsent` flag on both sides — any
divergence makes every approval of a leaver's month 409 forever against the
draft generation itself wrote.

## Draft teardown must take approval's row lock

Zero-payable employees generate no payroll row; their stale drafts (and drafts
of pre-month leavers, who are EXCLUDED from the generation loop and need their
own sweep) are torn down with advance claims released. The teardown must
`SELECT ... FOR UPDATE` the payroll row (the same lock approval takes) and
re-check `status='draft'` while holding it. Releasing advances first and then
discovering via a 0-row guarded DELETE that approval won would still COMMIT the
release and strand approval's advance deduction.

## Cleanup precedent (Aug 2026)

Test-fixture employees were retired via the status model (terminated, LWD
before the month) — never hard-deleted, which orphans accruals and ledgers.
Accrual rows stranded before a `salary_accrual_resume_from` stamp are never
re-walked; they were corrected in place with an `activity_log` entry as the
audit trail.
