---
name: Voucher admin-only delete & employee party legs
description: Level-1-only voucher deletion via the shared admin gate, and the salary-ledger-only rules for Employee party legs on manual receipts/payments.
---

# Voucher admin-only delete & employee party legs

## Admin-only voucher deletion
Deleting any voucher (payment, receipt, journal/contra/notes) is level-1
Administrator only — a shared `isLevelOneAdmin` gate in the api-server's
`lib/adminGate.ts`, applied ON TOP of the page delete right, before every
other check in the DELETE handlers.

**Why:** removing a voucher rewrites the books; the page permission matrix is
about pages, not about who may erase accounting history.

**How to apply:** every NEW voucher-producing module's DELETE route must import
the shared gate (never re-derive the level locally — accounts.ts had a private
copy that journal.ts couldn't reuse). Client side, hide delete buttons with the
`useIsAdmin` hook (marlin-erp `lib/useIsAdmin.ts`, fails closed while loading);
the server 403 is the real guard.

## Employee party legs on manual receipts/payments
- Only the employee's `SAL-PAY-<id>` / `SAL-EMP-<id>` ledgers are valid legs;
  `ADV-EMP-*` is refused outright (payroll-owned) — EXCEPT an unchanged legacy
  leg on PATCH, which stays editable (amount/date/narration).
- Employee must exist and be active (inactive blocks create/leg-change only).
- Branch-stamped employee ⇒ voucher must be stamped to that same branch; HO on
  either side means company-wide (same convention as `foreignPartyLedgerIds`).
- Enforced on EFFECTIVE values (body ?? stored row) in payments/receipts POST
  and PATCH — a partial PATCH cannot route around it.
- Pickers narrow via `GET /accounts/voucher-employees`: a minimal directory
  (id/name/branch/isActive, NO salary) gated on any voucher page's view right,
  because the HR employees list both leaks salary and needs an HR page right.

## Test-suite gotchas hit here
- `journal_lines` doesn't exist — the table is `journal_voucher_lines`.
- `employees.branch_id` is NOT NULL; head-office rows use placeholder 0 (some
  legacy rows use 1) — never insert NULL.
