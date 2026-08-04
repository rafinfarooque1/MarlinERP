---
name: Invoice numbering vs the sequence counter
description: Renumbering documents strands the allocator counter and can brick creation of new documents once a unique index exists.
---

# Renumbering documents strands the counter that issues them

Document numbers here come from a counter (`company_settings.invoice_sequence`
for sales), but uniqueness is enforced on the number stored on the row. Those
are two separate pieces of state, and only one of them is authoritative for
"what has been used".

**The rule:** any operation that rewrites document numbers must advance the
allocator to at least the highest number now in use, in the same change.

**Why:** a de-duplication pass that moves colliding invoices *onto* higher
numbers, then adds a unique index, leaves the counter pointing at numbers that
are now taken. Every subsequent create dies on the unique violation. The
failure is total (no new sales at all) but invisible to any read-only
verification — a balanced trial balance and a clean acceptance audit both pass
happily while the write path is completely broken.

**How to apply:**
- After any renumbering/backfill of a numbered document, reconcile the counter.
- Prefer a boot-time, idempotent, forward-only reconcile
  (`GREATEST(counter, max_suffix_in_use)`) over a one-shot migration: other
  code paths and manual data fixes can strand the counter the same way, so it
  should re-heal rather than be corrected once.
- Only ever move the counter *forward*. Moving it back re-issues numbers that
  already exist.
- Restrict the "max in use" scan to rows whose number actually matches the
  current prefix/period format, and require the suffix to be all digits —
  otherwise legacy or hand-entered formats poison the maximum.

**The general lesson:** a read-only audit cannot certify a system. It exercises
queries, not writes. Any migration that changes stored keys needs at least one
real create/update afterwards to prove the write path still works.

## B2B/B2C sales series (SB2B / SB2C)

Sales bills use TWO independent FY-scoped counters in `voucher_sequences`
(`sales_invoice_counter_b2b` / `_b2c`), format `SB2B/2026-27/000001`, series
chosen from the customer's `gst_number` (`NULLIF(TRIM(...),'')` — non-blank =
B2B; walk-in = B2C). `company_settings.invoice_sequence` no longer issues sale
numbers (it still exists for quotations' `computeInvoiceNumber`).

- **Every producer of sales rows must draw from this allocator** — POS create
  AND the transaction importer. The importer once wrote the file's source
  number into `invoice_number` verbatim; an imported SB2x-shaped number can
  collide with or outrun the counter and brick the next POS sale until a
  restart reconciles. Source numbers belong ONLY in `legacy_invoice_number`
  (raw-migration column — raw SQL only), which every search/dedupe predicate
  also matches.
- **Renumbering sales must pair-rename their receipts in the same txn.** Sale
  receipts carry `voucher_number = invoice_number`, and derived postings
  EXCLUDE receipts whose voucher matches a sale — rename one side only and
  revenue double-counts. Verify with the orphan-receipt count, not just a
  balanced TB.
- **Proving a rename books-neutral needs identical builds on both sides.** A
  TB hash change after restart can come from previously-edited-but-unbuilt
  code finally compiling in; also, statement JSON can differ by unstable
  sort-tie order of equal rows, not money. Diff values, not hashes, before
  concluding a regression.
- Regression suite: `tests/import-sales-numbering.test.mjs` (import → series,
  legacy search, POS continuation, rollback).
