---
name: Ledger-authoritative current balances
description: Why "current balance" must come from the posting stream, never from document arithmetic, and the traps in proving it.
---

# One definition of "current balance"

For a **posted** transaction the ledger is authoritative. Business tables
(purchases, sales, payments) are source documents; they may show settlement
history, but they must never produce a competing "current balance".

**Why:** the ERP grew two parallel definitions. Ledger-derived surfaces (trial
balance, balance sheet, P&L, cash/bank book, ledger statements) saw journal
vouchers and contras. Document-arithmetic surfaces (party lists, ageing
reports, dashboard AP/AR, cash-in-outlet) did not. A payable cleared by a
journal therefore showed its full original value on the vendor list while the
vendor's own ledger page correctly showed zero — same party, same instant, two
numbers.

**How to apply:** any new screen showing a party/cash/bank balance reads the
centralized balance service. If you are about to write `SUM(documents) −
SUM(payments)`, you are re-creating the bug.

## Rules that fall out of it

- **Sign by account nature, and never clamp.** `GREATEST(0, …)` silently hides
  an overpaid vendor (a debit "advance") as ₹0.00 — money already paid out,
  invisible. Show the abnormal side and label it.
- **Absent ≠ zero.** A party with no ledger provisioned has *no* balance. Send
  `null` and render an em-dash. `₹0.00` reads as "settled in full", a different
  claim. Watch for `Number(null) === 0` in a response mapper undoing this.
- **Postings carry no location.** So a ledger-anchored figure is inherently
  company-wide. Either scope the *rows* and accept a company figure per row
  (what the party lists have always done), or refuse to anchor and say so via a
  `basis` field — do not invent a location split that the data cannot support.
- **Build the balance index once per request**, then read per ledger. Deriving
  the posting stream inside a loop, or once for the index and again for a
  statement, is the main performance trap.
- **Allocation vs. balance are different questions.** Where documents carry real
  per-invoice allocation (sales), keep it and anchor only the control total.
  Where they do not (purchases have no `amount_paid`), *derive* the credit pool
  as `billed − ledgerBalance`, which makes residual bill balances sum to the
  ledger balance by construction. The two ageing reports are legitimately
  asymmetric; say so, or someone will "fix" it.

## Verifying it

- **Re-read a ledger subtree; never snapshot it.** Creating a vendor or customer
  provisions a new party ledger under the control account. A subtree id list
  captured before the fixtures exist omits exactly the ledger under test, and
  every control-total assertion then passes against a stale set.
- Postings can only be made to **leaf** ledgers; a group is rejected.
- The strongest end-to-end gate is: move money one way, assert every surface
  that claims to know the resulting balance agrees, then delete the fixtures and
  assert the trial balance returns to its opening totals.

## Ledger statement endpoints (Aug 2026)
Both Accounts→Ledger statement routes (`/accounts/ledger-statement`, `/accounts/ledger/:id/statement`) were the LAST surfaces stitching entries from source documents; rewritten onto buildDerivedPostings + openingBalancePostings via one shared helper. Rule: any new balance/statement surface must read the posting stream — a 400-check cross-surface harness (temp user, paisa-exact, company + located pass) is the cheap way to prove it.

## Full integrity-audit recipe (Aug 2026 — came back clean)
Two temp scripts prove the whole system: (1) stream-level via esbuild-bundled import of buildDerivedPostings — per-entry Dr=Cr, orphan ledger refs, duplicate legs, per-doc coverage, doc-level GST vs invoice tax; (2) HTTP harness (temp user) — every surface vs TB to the paisa. Audit-check traps that are BY DESIGN, not bugs: sale-mirror receipts have no receipt postings (sale posts the money legs — coverage checks must mirror the exclusion filter in journal.ts); vendor ledger endpoints return natural-side (credit-positive) balances while entries are raw Dr/Cr; the Cash & Bank screen's head rows show the heads' OWN balance (0), not subtree sums. `tsx` is not installed — bundle temp TS scripts with esbuild like build.mjs does.
