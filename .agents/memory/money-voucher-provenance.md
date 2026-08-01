---
name: Money voucher provenance
description: payments/receipts carry a stored `source` column; edit/delete rights derive from it, fail closed on NULL
---

Rule: a payments/receipts row's ownership is STORED in its `source` column ('manual', 'expense', 'refund', 'sale', 'deposit', 'settlement', 'vendor'), stamped by every producer at INSERT. Manual edit/delete (PATCH/DELETE /accounts/payments|receipts) is allowed only for source 'manual' (payments also 'vendor' — vendor payments own no other record; dues are ledger-derived). NULL source = locked.

**Why:** join/narration inference misses producers — a review found cash-in-outlet, reconciliation and vendor payment rows editable because only expense/refund/sale links were checked. Storing provenance is the only complete verdict; failing closed on NULL means a future producer that forgets to stamp yields locked rows (annoying, visible) instead of editable system vouchers (silent corruption).

**How to apply:** any NEW code that inserts into payments or receipts MUST stamp `source`. Legacy backfill ran once behind migration_log 'money_voucher_source_backfill_v1' (durable links first, then the two narration patterns, remainder 'manual') — never re-run a "source IS NULL → manual" sweep, it would unlock unstamped system rows. Lock messages and the editable-set live in routes/accounts.ts next to loadManualPayment/loadManualReceipt; the GET list `origin`/`editable` flags must always match those helpers' verdict. Mode/reference are metadata only — posting is driven by the ledgers.
