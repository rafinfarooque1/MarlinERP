---
name: Orphaned ledger postings (deleted ledgers, surviving journal lines)
description: Why a balanced trial balance can sit next to an unbalanced balance sheet
---

Deleting a ledger without also removing or reversing the journal lines that
point at it leaves postings that belong to no account. The damage is quiet and
permanent:

- The **trial balance still balances** — it sums the raw lines, and the orphans
  are equal-and-opposite in aggregate across the whole table.
- The **balance sheet does not** — statement building classifies each posting by
  walking its ledger up to a reporting root, and a posting whose ledger is gone
  classifies as nothing, so it lands in neither Assets nor Liabilities. The
  difference equals the orphan set's net Dr−Cr exactly.

So "the trial balance balances" is not evidence the books are sound. When a
balance-sheet difference appears, the *first* check is a set difference of every
`%ledger_id%` column against `account_ledgers`; if the orphan net matches the
difference to the paisa, that is the whole story and nothing else is wrong.

**Why this happens here:** a bootstrap cleanup that wipes user-created ledgers
deleted the *expenses / payments / receipts* rows referencing them but not
`journal_voucher_lines` or `journal_vouchers.party_ledger_id`. Master tables that
merely *reference* a ledger (rent agreements and similar) are stranded the same
way, and those bite later, when something tries to post to the missing ledger.

**How to apply:**
- Never repair this by inserting a balancing entry. The correct repairs are
  restoring the deleted ledger or reversing the stranded postings — both are
  business decisions, so report and ask.
- Any new code path that deletes a ledger must consult the usage guard that
  enumerates every referencing table, and that guard must cover *reference*
  columns on master tables, not only transaction tables.
- A one-time boot cleanup guarded by "does ledger X exist yet" is inert forever
  after its first run — check the guard before blaming it for fresh damage.
