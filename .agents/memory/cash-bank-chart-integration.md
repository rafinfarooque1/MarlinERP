---
name: Cash & Bank ↔ Chart integration
description: CBA ledgers, derived balances, module-managed heads, opening-balance counterweight — design + the traps hit building it
---

# Design (settled Aug 2026)

- Every `cash_bank_accounts` row is backed by a ledger coded `CBA-{accountId}` — cash type under STD-CASH, everything else under STD-BANK (renamed "Bank Accounts"). `ledger_id`, `location_type`, `location_id` are raw boot-migration columns (drizzle-invisible — raw SQL only).
- Balances are FULLY derived (postings + openings). The stored `balance` column is dead: expense POST no longer touches it; it survives only as `storedBalance` in responses.
- The two heads are module-managed by **code guards, not `is_system_group`** — flipping that flag on a postable root makes books.ts zero its own direct posting history. UI badge = `moduleManaged` flag on chart GET nodes.
- GET /accounts/cash-bank returns the whole subtree: module rows (editable), branch tills (`source:'location'`, read-only, deduped by ledger id), roots (`source:'system'`), leftovers (`source:'ledger'`), synthetic ids = `-ledgerId`. So Σ rows = books' cash+bank position.
- Writes are HO-only (`employee.branchType`), on top of page-permission guards.
- Migration `cash_bank_ledger_link_v1`: renames Bank head, adopts code-less orphan children (gain CBA code + module row), links legacy accounts, seeds opening = stored balance + Σ expenses paid from the account (because derived postings repoint legacy expense credit legs to the account's own ledger).

# Opening-balance counterweight

**One-sided openings unbalance the TB and BS.** The opening_balances store expects the accountant to enter every side. Module-seeded asset openings need a counterweight: ONE credit row on "Opening Balance Adjustment" (`STD-OB-ADJ` under SYS-CAP), recomputed FROM SCRATCH (never incremented) as Σ of all openings on CBA- ledgers.

- `rebalanceCashBankOpeningEquity`: one transaction + `pg_advisory_xact_lock` (read-sum → rewrite must be atomic or the last concurrent writer persists a stale figure). Runs at every boot (self-healing), after every module opening write/delete, and after both company resets.
- When the sum is 0 it deletes the adjustment LEDGER too, not just its rows — STD- codes survive the full reset's ledger purge and would linger as an empty equity head.
- Manual opening-balance POST/DELETE must refuse `CBA-%` and `STD-OB-ADJ` ledgers, or a chart-permission user silently unbalances the books and breaks the module-sole-owner contract.

# Trial balance did not fold openings

Both TB routes (accounts + reports) aggregated only `buildDerivedPostings` — invisible while openings were intentionally zero. Fixed via `openingBalancePostings()` (lib/openingBalances.ts): openings shaped as company-level postings dated `as_of_date`, injected into the accounts TB and into `splitPostings` (ALL /reports/fin/* views). **books.ts keeps its own separate cumulative fold — a route must use one mechanism, never both, or openings double-count.**

# Traps hit

- `account_ledgers.code` has NO unique constraint on live DBs (CREATE TABLE IF NOT EXISTS drift) — `ON CONFLICT (code)` is a 42P10. Check-then-insert instead.
- Boot ordering: a migration that writes a table must run AFTER that table's DDL block in index.ts — `opening_balances` is created surprisingly late. On a fresh DB the earlier position crashes boot.
- Transaction reset preserves cash_bank_accounts AND their openings BY DESIGN (openings are account identity/masters); full reset truncates both. Both resets end with a rebalance sweep.
- Write-route responses must return the DERIVED balance (`currentBalanceIndex().net()`), not a hard-coded 0/null — a stale zero flashes onto the screen before the list refetch.
- Cash/Bank Book now folds `openingBalancePostings()` exactly like the TB (concat before subtree filter/sort). The durable rule stands: every ledger-anchored report must fold openings via ONE mechanism — a report that skips it understates by exactly the opening, and books.ts's own cumulative fold must never be combined with it.
