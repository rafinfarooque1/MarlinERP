---
name: Company reset & ghost rows
description: Why full-reset truncate lists drift, how ghost rows re-attach after RESTART IDENTITY, and how the one-time prod cleanup is gated
---

**Rule:** every reset endpoint must derive its table list from the ONE maintained transactional list (`TXN_RESET_TABLES` in company.ts) plus explicit extras — never keep a second hand-copied list.

**Why:** the factory reset carried its own stale copy: it truncated documents+masters with RESTART IDENTITY but missed stock_batches, stock_ledger, journal vouchers, accruals, rent tables, cash_bank_accounts, voucher_sequences. New masters reused ids 1..N, so every surviving old row silently re-attached to the new company's records (77 kg ghost batch showing under a brand-new item with the same id). Nothing errors — the corruption is only visible as impossible stock figures.

**How to apply:**
- Adding a transactional table? Add it to `TXN_RESET_TABLES`; the factory reset inherits it automatically.
- Standalone sequences (purchase_batch_seq, item_code_seq_*) are NOT owned by truncated tables — RESTART IDENTITY never touches them; restart explicitly.
- Accrual sweeps (salary, rent) backfill from anchors/agreements: a reset must advance `salary_accrual_config.attendance_from` and wipe rent agreements, or the sweeps resurrect old-company money.
- The one-time prod cleanup (`prod_reset_ghost_cleanup_v1`, migrations/prodResetGhostCleanup.ts) deletes pre-cutoff rows only, gated by: marker in same txn, NODE_ENV=production, and a reset-signature fingerprint (zero pre-cutoff business documents) that makes it refuse loudly on any other database.
- Batch-layer invariant for verification: batch coverage may be SHORT of stock_entries (untracked stock is legitimate) but must never EXCEED it — over-coverage = ghost batches.
