---
name: Payroll paying-account selection & JV location stamps
description: Salary/advance payments take an optional paying cash/bank ledger; journal_vouchers now has raw location_type/location_id columns read by buildDerivedPostings.
---

# Payroll paying-account selection & JV location stamps

- Salary payments (`POST /hr/payroll/:id/pay`) and advances (`POST /hr/advances`) accept optional `payLedgerId`, validated by `resolvePayLedger()` in hr.ts: must be an active STD-CASH/STD-BANK descendant; non-HO callers restricted to `scopeCashLedgerIds(ownLocationScope())`.
- **Branch default must never be HO money:** when a branch caller omits the account, resolve to their OWN till (error if zero or several) — the old silent STD-CASH fallback was a scope bypass (architect review caught it).
- **Recorded payment mode is derived from the resolved ledger's tree** (bank tree → bank/upi, cash tree → cash), never trusted from the body; UPI defaults to STD-BANK, not cash.
- `journal_vouchers.location_type/location_id` exist as RAW boot-migration columns (invisible to drizzle — raw SQL only). NULL = company-level (the long-standing JV default). `buildDerivedPostings` section 3 reads them via COALESCE after the return-voucher joins. Stamp system vouchers whose money leg is a branch till; HO-paid payroll JVs stay unstamped on purpose.
- **Why:** located reports partition postings exactly; an unstamped till movement lands in the company bucket and vanishes from that location's slice.

## Related traps fixed at the same time
- Payment.tsx "Paid To" / Receipt.tsx "Received From" pickers leaked SAL-PAY-*/ADV-EMP-*/GST-* ledgers (they only filtered isSystemGroup/isGroup). Shared `isSystemLedger()` now lives in `marlin-erp/src/lib/systemLedgers.ts` — use it in ANY new ledger picker; posting to payroll ledgers manually double-pays dues.
- `/accounts/cash-bank-ledgers` requireModuleView list must include EVERY page that uses the picker (page:/hr/payroll, page:/hr/advances were added). A picker endpoint 403s silently for users who only hold the consuming page's right.

## How to apply
Any new "pay from" feature: reuse `resolvePayLedger` (or its rules), derive the mode from the ledger, stamp the voucher's location from the till, and extend the picker-endpoint permission list.
