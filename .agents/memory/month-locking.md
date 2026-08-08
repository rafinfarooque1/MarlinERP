---
name: Accounting month locking
description: Period lock design — absence-of-row = open, one 423 helper guards business dates, which paths are deliberately open, and the accepted race.
---

# Accounting month locking

Tables `accounting_period_locks` (only LOCKED months have rows; absence = open)
and `period_lock_events` (full lock/unlock history with actor + unlock reason).
Admin (hierarchy level 1) only; lock needs `confirm:true`, unlock needs a
reason; future months can never be locked. Page key `page:/accounts/periods`.

**One helper, one message.** Every write family calls
`respondIfMonthLocked(res, pool, [businessDates], label)` from
`lib/periodLock.ts` before its transaction → HTTP **423**, code `MONTH_LOCKED`,
the fixed user message in `MONTH_LOCKED_MESSAGE`. Never hand-roll the check or
the message. `ymOfDate` accepts strings AND JS Date (pg date columns return
Date objects — guards on stored rows depend on this).

**What the guard applies to:** the document's BUSINESS date(s), never
`created_at`. Edits/deletes guard the STORED date and the incoming one.
Accrual sweeps (salary, rent) must skip locked months in generation AND in
their teardown deletes (`NOT EXISTS` against the locks table).

**Deliberately open paths:**
- A NEW payment dated in an OPEN month against a locked-month credit sale is
  allowed — only the payment's own date is guarded. Settling old dues is the
  point of credit control.
- Quotations, holidays, masters, reconciliation match/unmatch (status flips,
  no business date), the master-only import commit path.
- Leave REJECTION isn't blocked (would strand requests) but its safety-net
  DELETE excludes locked months.

**Accepted race:** guards check on the pool before the write's transaction, so
a lock committing in that millisecond window can miss one concurrent document.
Settled as acceptable (single admin locks at month-end; the pre-lock summary
would expose a straggler). Closing it would need shared advisory locks in
every writer — don't attempt casually.

**Guard-coverage sweep:** to audit coverage, list route files with
POST/PATCH/PUT/DELETE that never import `periodLock` and check each for
business-date writes. Asset transfers were the gap found this way (asset
purchases/disposals were guarded, transfers forgotten).

Regression suite: `tests/period-lock.test.mjs` (~14 write families, the
allowed-payment principle, unlock→correct→relock, events).
