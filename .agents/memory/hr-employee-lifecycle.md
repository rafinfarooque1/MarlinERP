---
name: HR employee lifecycle
description: App-created employees, deletion semantics, leave cancel, and attendance permanence — what tests and admin flows must expect.
---

## Employee create/delete via app paths

- `POST /hr/employees` auto-seeds a `pay_components` row and sets the default
  initial password (`DEFAULT_INITIAL_PASSWORD` in lib/passwordPolicy.ts) with
  `mustChangePassword=true`. Login response shape is `{ token, employee }` —
  the flag rides on `employee.mustChangePassword`.
- `DELETE /hr/employees/:id` deletes the pay_components row WITH the employee
  in one txn (fixed Aug 2026 — it used to 500 for every app-created employee
  because none of the FKs on employees cascade). History tables (attendance,
  payroll, leaves, advances, invoice_share_links) block deletion ON PURPOSE →
  clean 400 "mark inactive instead". **Why:** deleting a person under
  signed-off pay records would orphan them; the pay row is config, not history.
- **How to apply:** test fixtures that check in / apply leave become
  undeletable via the app; suites must remove their OWN attendance/leave rows
  by SQL (documented) before the app delete — there is no app delete path for
  attendance or leaves, by design.

## Leave + attendance semantics tests must expect

- Leave **cancel is a status flip** to 'cancelled' (row stays for audit; only
  pending cancels; double-cancel = 409). It is NOT a delete — don't assert row
  removal.
- Check-in: one open session at a time (second check-in = 409 — doubles as the
  double-tap guard); non-HO users can only punch for themselves (403).

## Mobile POS settlement provenance

- A mobile/POS **cash sale's payment is receipt-backed** (`sale_payments` row
  with `clearing_receipt_id` → receipts row, source='sale'), so
  `POST /sales/:id/cancel` refuses with PAYMENTS_RECORDED. Cleanup path:
  `POST /accounts/receipts/:id/system-delete` first (removes the payment leg
  under the sale row lock), then cancel. Only `source='counter'` legs leave
  with the bill on cancel.
