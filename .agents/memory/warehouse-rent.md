---
name: Warehouse rent accrual design
description: Why rent accruals are derived rather than posted, how the approval gate constrains due dates, and the traps in accruing a monthly amount daily.
---

# Warehouse rent

## Accruals are derived postings, not vouchers

Daily rent (`Dr Rent Expense / Cr Rent Payable`) is added as a section of the shared
derived-postings builder. Rent *payments* are real journal vouchers, and they arrive through
the builder's journal-voucher section.

**Why:** one voucher per warehouse per day would bury the voucher register — a handful of
warehouses generates thousands of vouchers a year that no human will ever read. Deriving the
accrual instead means rent reaches the trial balance, P&L, balance sheet and ledger statements
through the one stream every other source already uses, with no new reporting path.

**How to apply:** the payable is credited by the derived accrual and debited by the payment
voucher. Those are two different sections of the same builder — never add a second accrual
path, or the payable double-counts. Verify by checking the payable ledger nets to
accrued-minus-paid.

## Recognition is daily — approval only locks the month

**Superseded twice; read daily-expense-accrual.md for the current model.** Rent reaches the
P&L as each day accrues, and approval validates, locks and releases the payable rather than
posting anything. An earlier version gated recognition on approval because the brief said rent
should work "exactly like Payroll"; a later brief reversed that and pulled payroll along with it.

The lesson that survived both: when a brief says module X should work like module Y, go read
what Y actually does — the analogy is the requirement, not a loose comparison. And when the
owner reverses a rule, the old behaviour is still sitting in the git history looking correct,
so check which brief is current before "restoring" it.

## A workflow gate dictates where the payment deadline can fall

Approval is refused until a month has finished accruing (so an approved figure cannot change
afterwards). That single rule forces the payment deadline into the *following* month.

**Why:** dating the deadline inside the rent month made every month overdue while it was still
accruing — July rent read "overdue by 24 days" on 29 July even though nobody was yet permitted
to approve it, let alone pay. The reminder banner was nagging about something the system
itself forbade.

**How to apply:** whenever a workflow gate blocks an action until a period closes, any deadline
attached to that action must sit after the close, and the month-12 rollover must advance the
year. Clamp the day to the target month's length (a due day of 31 must survive February).

## Accruing a monthly amount daily

A monthly rent divided across calendar days does not sum back to the monthly figure. Absorb
the rounding remainder on the **last covered day of each month**, derived from the agreement
and the calendar — never from today, or the remainder lands on whichever day the job happens
to run and a fully-covered month never totals the agreed rent.

Idempotency comes from a unique index on (warehouse, accrual date), which lets the scheduler be
a plain hourly catch-up rather than a midnight tick: downtime, restarts and clock changes all
self-heal.

**Switched-off agreements must stay in the sweep.** Filtering the catch-up to active
agreements only looks obviously right and is a permanent expense leak: any day missed *before*
deactivation (downtime, a restart, or a switch-off that landed between hourly runs) becomes
unreachable forever, because nothing will ever look at that agreement again. Keep them in the
query and bound them by the stop date instead — the date bound is what prevents over-accrual,
not the status filter. Exclude only rows that never accrued at all (no stop date).

## The "switched off / never rented" shape is status-inactive with NO stop date

Because the catch-up sweep deliberately keeps deactivated agreements in the query and bounds
them by their stop date, the stop date — not the status — is what decides whether a row
accrues. So there are two different "off" states, and only one of them is inert:

- `status='inactive'` **with** `inactive_from` set = *was* rented, still accrues up to the day
  before that date.
- `status='inactive'` with `inactive_from` NULL and a zero amount = never rented, produces
  nothing. This is the shape auto-registered rows are born in.

**Why:** wiping rent data and then marking the agreement inactive *with* a switch-off date
re-creates every accrual up to that date on the next hourly sweep, silently putting the expense
back into the P&L after it was deliberately removed.

**How to apply:** to switch rent off and keep it off, reset the row to the auto-registered
shape — inactive, zero rent and deposit, null start/end/stop dates — so it matches every
warehouse that was never rented. Never reach for `inactive_from` as the way to say "off".

## Setting the rent amount is Head Office only, not merely location-scoped

Location scope is the wrong control for rent terms. Scoping alone lets a warehouse user edit
*their own* warehouse's agreement — i.e. choose the rent charged against them, which lands
directly in the P&L as expense they picked. Terms, approval and payment are all HO-only;
warehouse users keep full read access to their own warehouse.

**How to apply:** when a scoped write changes a financial figure rather than operational data,
scope is not authorisation. Ask who is entitled to *decide* the number, not who is allowed to
see the row. Gate the UI control on the same rule, or the button 403s in the user's face.

## Deactivating must stop accrual without erasing history

Warehouses have no `is_active` column — only hard delete — so "this warehouse is no longer
rented" lives on the rent record as a status plus a switch-off date. Accrual stops from that
date forward; every past accrual, approval and payment stays exactly where it was, and the
months remain visible in reports.

**Related:** a warehouse delete must refuse when rent history exists. Derived accruals are
invisible to a "does this ledger have entries?" check, so that guard has to query the rent
tables directly or the delete silently drops real expense out of the P&L.

**Auto-provisioned ledgers need a matching teardown.** Anything that creates ledgers per
warehouse on create must remove them on delete, or the Chart of Accounts slowly fills with
unreachable "<ledger> - <deleted warehouse>" rows. Dropping them is only safe because the
delete is already refused when anything has posted to them — that refusal is what makes the
cleanup safe, so the two must be kept together.
