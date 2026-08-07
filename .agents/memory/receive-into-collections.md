---
name: Receive Into collections
description: Customer collections pick a real Cash & Bank account instead of a cash/bank/upi method dropdown; server derives the method and validates location ownership.
---

# Receive Into collections (customer payment screens)

**The rule:** No collection screen offers a method dropdown. Every collect form posts
`receivedInLedgerId` (a real Cash & Bank ledger) and the SERVER derives the method:
CBA `account_type` cash→cash / upi→upi / else bank; a ledger with no CBA row is cash
iff it sits under the STD-CASH subtree. The legacy `{method}`-only body stays accepted
forever (importer, mobile app) and behaves exactly as before.

**Why:** the owner wants collections recorded against the actual account the money
landed in, per location, reconciling to the paisa — a method label can't say *which*
bank. Removing the dropdown removes the mismatch class entirely.

**How to apply:**
- ONE shared picker: `components/receive-into-select.tsx` — `useReceiveIntoOptions(locationType, locationId)`
  filters `useCashBankLedgersFlat()` by the matching `useVoucherLocations()` entry's
  `cashBankLedgerIds` (HO matched on TYPE alone — sales use placeholder id 1, vouchers 0).
  Options expose `accountType`; `isCashOption()` drives display-only hints (ref input,
  recon warning). The server re-derives — never trust the client's idea of cash.
- Server allowed set (inside the txn, after the caller-location gate): branch sales =
  `scopeCashLedgerIds` of the SALE's location; HO sales = `ledgerIdsUnderCodes(['STD-CASH','STD-BANK'])`
  minus `locationOwnedLedgerMap()` keys. Wrong location / inactive → 400.
- Electronic override reuses the assigned-account path by faking the `assigned` rows
  from the override, so recon-ON accounts still go clearing→pending and recon-OFF post
  direct — downstream unchanged.
- Derivation (journal.ts): `directIn` fires for ANY method when the receipt's
  `received_in` differs from BOTH the electronic clearing ledger AND the till —
  legacy postings stay bit-identical; explicit picks debit the receipt's own ledger.
- Any endpoint feeding a collect dialog (aging, collections list, sales list) MUST
  return `locationType`/`locationId` with `?? 'outlet'` / `?? outlet_id` fallbacks for
  legacy rows, or the picker has nothing to filter on.
- GET /sales/:id/payments returns `receivedInLedgerId/Name` (null on old rows — UIs
  fall back to `paymentModeLabel(method)`).
- The dup-guard keys on the DERIVED method, so it must run AFTER override resolution —
  and when a destination was picked, the destination is part of the duplicate identity
  (split collections legitimately post equal amounts to two accounts seconds apart;
  only a repeat into the SAME account is a double-submit). Legacy bodies keep the
  stricter method+amount identity.
- A UPI QR must only be generated when a UPI account is actually the picked
  destination — a cash/bank collection must never flash a scannable QR.
