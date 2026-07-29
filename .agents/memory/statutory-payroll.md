---
name: Statutory payroll (PF/ESI) and payroll immutability
description: How PF/ESI rates are applied, why a per-run snapshot exists, and the rule that approved payroll is locked.
---

## Rates are snapshotted per run, never re-read

PF/ESI percentages live as columns on company settings, but a payroll row stores
its own copy of the rates it used at generate time.

**Why:** rates change by statute mid-year. If payroll read the live settings at
display or approval time, editing a rate would silently restate every past
payslip and put the slip out of step with the voucher already posted for it.

**How to apply:** anything that needs the rates for an existing run reads the
row's snapshot. Only generation reads the live settings. This is what makes
"changes apply to future runs only" true rather than merely a UI promise.

## Approved payroll is locked

Approval locks the run. After that, amounts must not change — no extra-amount
edits, no regeneration, and no recalculation of the month's daily accruals.
Corrections go through a reversal, not an amendment.

Approval is no longer the moment salary is recognised: it posts only the
difference between the final figure and what daily accrual already charged. See
daily-expense-accrual.md — the entry below is the shape of that *full* cost, and
approval now posts it net of the accrued portion.

**Why:** the voucher is already in the books for the old figure. Editing the row
leaves the payslip saying one thing and the ledger another, with no document
linking the two. Generation must therefore also skip non-draft rows even when
asked to force a regenerate.

**How to apply:** every payroll mutation route filters on `status = 'draft'` and
returns a 409 explaining that the period is posted. Test both directions — a
draft edit must still succeed.

## The salary entry recognises full cost, not net pay

    Dr  Salary - <employee>          gross + extra
    Dr  Employer PF Contribution     employer share
    Dr  Employer ESI Contribution    employer share
      Cr  PF Payable                 employee + employer
      Cr  ESI Payable                employee + employer
      Cr  Employee Deductions Payable
      Cr  Advance to <employee>      advance recovered
      Cr  Salary Payable             net take-home

**Why:** debiting only net pay understates the cost of employing someone by
everything withheld, and hides the PF/ESI liability entirely. Employer
contributions are a real cost that appears nowhere else.

**How to apply:** the employer ledgers sit under Indirect Expenses, so they
reach the P&L through the normal subtree walk — do not add them separately
anywhere, or they double-count. Payment is a separate voucher that discharges
Salary Payable against cash/bank.

## Money-moving routes must be one transaction

Salary approval and salary payment each write a voucher *and* change the payroll
row. Both must happen in a single transaction, with the row re-read `FOR UPDATE`
inside it.

**Why:** catching the voucher error and carrying on leaves a row marked paid
with the cash still sitting in the ledger — the two screens disagree and nothing
reconciles them. Re-reading under the lock is what stops two concurrent partial
payments from each settling the same outstanding balance.

## Attendance is fractional

Half days are a real feature (there is a half-day hours threshold in settings),
so present/LOP day counts are NUMERIC, not INTEGER. Rounding them is not an
option: it either pays for a day not worked or docks a day that was.
