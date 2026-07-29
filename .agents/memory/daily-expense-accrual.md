---
name: Daily expense accrual (rent and salary)
description: Why rent and salary are recognised daily and what approval means once it is no longer the posting event — the true-up, the freeze, and the recalculation contract.
---

# Daily accrual, approval as a true-up

## Recognition is daily; approval no longer posts the expense

Rent and salary reach the P&L a day at a time (monthly amount ÷ days in that calendar
month), debiting the expense and crediting the payable as the day passes. Monthly approval
validates the figure, **locks** the month and releases the payable. Payment only clears the
payable.

**Why:** the owner's requirement changed direction mid-project. The first brief said rent
should work "exactly like Payroll", i.e. nothing in the books until approval; a later brief
replaced that with daily recognition and demoted approval to a validation-and-lock step.
Both models exist in the history, so a section of code that gates recognition on `approved`
is not necessarily correct-but-old — check which model the current brief describes before
"restoring" anything.

**How to apply:** there must be exactly one recognition path per expense. When approval
stops being the posting event, the approval voucher has to become a **delta**, and any
report that used to filter accruals to approved periods has to stop filtering.

## The approval voucher is a delta, and it can flip sides

Approval posts only `final figure − already accrued`. That difference is routinely
**negative** (a month accrued at a higher rate than the run finally computed, or a run of
zero), so each leg must be able to land on either side of the voucher independently — a
"place this amount on the natural side, or the opposite side if it went negative" helper,
not two hardcoded Dr/Cr lines.

If the delta nets to nothing, write **no voucher at all** but still lock the month. A
zero-line voucher is not balanced-and-harmless; it is a document asserting an event that
did not happen.

**How to apply:** verify by summing recognition for the month across *both* paths
(accruals + approval voucher) and comparing against the final figure. A balanced trial
balance proves nothing here — double counting balances perfectly.

## Approved and paid months are frozen — in every direction

A locked month must be excluded from the catch-up sweep **and** from recalculation. The
sweep is the obvious one; the recalculation path is the one that gets missed, because it is
triggered from an unrelated screen (editing an employee's salary, editing a rent agreement)
where the month is not on screen and its status is not in the caller's mind.

## Revision recalculates the whole unapproved month, not the remaining days

When the monthly amount changes, delete every unapproved accrual for the affected months
and regenerate them at the new rate.

**Why:** patching only the days after the change leaves one month carrying two different
daily rates, so a fully covered month never totals the agreed monthly figure and the
rounding remainder (absorbed on the last covered day) is computed against the wrong base.

**How to apply:** delete-then-regenerate inside one transaction under the same advisory
lock the sweep uses, or an hourly sweep can interleave and re-create rows at the old rate.
"Delete under the lock, regenerate afterwards" is not good enough: in the gap the month
reads as empty, and an approval landing there trues itself up against nothing, posts an
oversized voucher and locks the month — after which the deleted days can never come back,
because locked months are excluded from the sweep. Give the sweep a lock-held helper that
takes a `Querier`, so the rebuild can reuse it inside its own transaction instead of
re-entering the sweep on a second connection and deadlocking on the same advisory lock.

## A rebuild must start from the earliest day it deleted

These sweeps resume from `MAX(accrual_date) + 1` per entity. That cursor is a trap for any
delete-and-regenerate path: if a **locked month sits after** the month being rebuilt (August
approved, July still open), the newest surviving row is in August, so the cursor resumes in
September and the days just deleted are gone for good. Pass the earliest deleted date in
explicitly; existing rows are protected by the unique index, so starting earlier is free.

## Never delete what the rebuild cannot regenerate

Scope every delete to the exact span the regeneration will cover. Two live examples:

- An employee re-hired mid-month has a resume date, and the rebuild only accrues from it —
  so the delete must be scoped to `accrual_date >= resume date` or it destroys the earlier
  stint's genuinely accrued days. The month-end remainder's "already accrued" sum needs the
  same scope, otherwise earlier-stint days swallow the remainder.
- An entity that can no longer accrue at all (a deactivated employee: no "inactive from"
  day is recorded, so nothing bounds a rebuild) must return early **without deleting**.

**Why:** deleting is instant and silent; regenerating depends on dates, status and rate that
may no longer permit it. An amount of zero is the one case where delete-without-regenerate
is correct — an open month at a zero rate really is worth nothing.

## Rent approval is the point of no return, so it must verify coverage

Once locked months are excluded from the sweep, nothing tops a month up afterwards. Rent has
no true-up voucher (salary does), so its approval runs a **targeted catch-up for that entity
first**, then refuses if the month is still short. Compare **amounts**, not day counts —
day counts have a legitimate zero-amount edge case — and name both figures in the error, so
a day lost to downtime is recovered rather than quietly written off.

## The revision audit entry is the feature, not decoration

Every recalculation records ten fields: previous amount, new amount, previous daily
accrual, new daily accrual, who, date, time, reason, entries reversed, entries regenerated.
The reason is free text supplied by the user and is optional — the entry is still written
without it.

**Trap:** the reason arrives as an extra field on a validated body, and zod strips unknown
keys, so it must be read from the raw request body rather than the parse result.

## Per-entity ledgers must be filed into their container on creation

Auto-provisioning a per-employee expense/payable ledger with its *group head* as the parent
means the ledger sits loose until some later boot-time structure pass relocates it. Pass the
**container** the structure pass would have put it in, so the very first accrual lands in
the right place in the Chart of Accounts.

## Rejoining employees need an explicit resume date

An employee who leaves and rejoins must not accrue for the gap. That resume date is stored
as a raw-migration column, so it is invisible to the ORM — read and write it with raw SQL
(see raw-migration-columns.md).
