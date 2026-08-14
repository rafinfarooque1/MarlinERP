---
name: Purchase other charges
description: Bill-borne expense charges (freight/hamali) on purchase bills — JSONB storage, goods-only invariants, payable-side readers, return policy
---

# Other Purchase Charges

Purchase bills carry optional `{ledgerId, amount}` rows in raw JSONB `purchases.other_charges`
(startup-migration column — drizzle-invisible, so EVERY read and write is raw SQL; a drizzle
`.select()` silently reads it as undefined and `.set()` cannot carry it).

## The two invariants
1. **Goods figures stay goods-only.** `total_amount`, stock valuation, avg cost, GST math,
   dashboard purchase KPIs, GST purchase registers and purchase-return caps never see charges.
2. **The vendor is owed goods + charges.** Every payable-side reader must add the JSONB charges
   sum: derived vendor credit in `buildDerivedPostings`, settlement context, vendor bill
   settlement FIFO, vendor billed totals (list AND detail), ledger delete/usage guards.
   Missing one reader makes "billed" disagree with the vendor's own ledger.

**Why:** charges are real P&L expenses funded by the vendor, not inventory cost — mixing them
into goods figures would inflate stock while the books carry them as expense, and the two would
never reconcile.

## Return policy (deliberate)
Goods returns do NOT reverse charges: freight on a returned shipment was still incurred, so
after a full goods return the vendor correctly stays owed exactly the charge amount. A reviewer
will flag this as a "gap" — it is the intended commercial behaviour, documented in the audit doc.

## Validation (guard the effective value)
`lib/otherCharges.ts` `validateOtherCharges` runs on create, full edit, charges-only PATCH and
import commit: ledger exists + active + postable + `type='expense'`, NOT under the SYS-PUR
subtree (recursive ancestry walk — the "Purchases" ledger itself is `STD-PUR`, a CHILD of
SYS-PUR, so a prefix test alone misses it), no internal code prefixes, amount >0 ≤2dp, ≤50 rows.
The frontend dropdown filter (parentId walk) is convenience, never the guard.

## How to apply
- New payable-side reader or vendor money report → add the JSONB sum
  (`jsonb_array_elements` + `(e->>'amount')::numeric` with the `~ '^[0-9.]+$'` guard).
- Expense registers that must tie to the P&L → include charges as DERIVED read-only rows with
  negative synthetic ids (`/reports/fin/expenses` pattern) so ids never collide with vouchers.
- Any PATCH path that returns the row must re-read `other_charges` via raw SQL before
  responding, or the response silently drops the charges it just stored.

## Direct-Expense-only new picks (Aug 2026)
- NEW charge picks (create, or genuinely new ledger on edit) must be postable expense ledgers strictly UNDER SYS-DIREXP (self excluded); stored legacy charges are grandfathered per-bill — the edit path passes the bill's stored charge ledger ids so they keep passing the OLD any-expense-outside-SYS-PUR rule verbatim. Mirrors sale charges (Direct-Income-only).
- validateOtherCharges takes `opts.grandfatheredLedgerIds`; import path enforces the new rule with no grandfather set.
- Test fixture trap: a "legacy" fixture ledger must sit outside BOTH SYS-DIREXP and SYS-PUR subtrees, or even the grandfather rule refuses it.
