---
name: Data import framework
description: Durable design constraints for the Import Data module; what any later import type (sales, receipts) must honour.
---

# Data import framework — design constraints

Rules that must hold for every import type, and why:

- **Commit through the manual-creation code path.** Extract a shared create
  function first if one doesn't exist; a duplicated create path silently
  diverges on ledger auto-provisioning, location stamping, and audit stamps.
- **Commit and rollback are mutually exclusive.** Commit creates records
  row-by-row (deliberately not one transaction — each row uses the manual
  path), so it holds the batch's advisory lock for the whole loop; rollback
  try-locks the same key and refuses while a commit runs. Rollback accepts only
  fully `committed` batches — a stuck `committing` batch (dead committer) needs
  eyes, not an automatic delete. Terminal status updates are conditional on the
  state the writer claimed. **Why:** a rollback interleaved with a live commit
  deletes early rows while later ones keep appearing — untracked records and a
  lying batch status.
- **Rollback eligibility from actual state, inside the deleting transaction,
  after deleting the batch's own opening balances** — otherwise the batch's own
  OBs count as "usage" and block every rollback. All-or-nothing with per-record
  reasons; only *created* records are reverted, never rows that updated
  pre-existing data.
- **Duplicates:** in-file duplicate = error; existing-record duplicate =
  warning with a skip-or-update decision that is re-checked at commit time, not
  trusted from validation. Names colliding with system accounts/groups are
  errors, never importable.
- **Client hooks are hand-written, not codegen** (the spec gates writes and
  strips fields); upload is a raw body to the parse endpoint.
- **Opening-balance FY** derives from the company's FY start month setting,
  never the stale financial-year text column.

## Location support & batch identity

- **Masters (customers/vendors/ledgers) REQUIRE a Location column** — blank is
  a row error, name resolved case-insensitively against warehouses/outlets/
  "Head Office" and scope-checked against the uploader. **Why:** an unstamped
  or wrongly-stamped master is invisible to every location view.
- **Txn/voucher files carry an OPTIONAL Location column that is a
  cross-check only** — it must match the batch's picked location by
  normalized NAME (mirror-safe) or the row errors; it never overrides the
  picked location.
- **Batch display id is DERIVED, never stored:** `IMP${id padded to 6}` via
  `batchDisplayId()`; UI keeps a client-side fallback format.
- **`import_batch_id` stamps go ONLY on records a batch CREATED** (8 tables);
  duplicate-update paths stay unstamped and are never rolled back. Rollback
  authority remains `import_rows`; stamps power counts + leftover checks.

## Rollback delete (counts, verification, role gate)

- **Role gate on rollback:** hierarchies.level ≤ 2 (Admin/Management) checked
  server-side ON TOP of the page delete right, fails closed on missing role.
- **Counts snapshot inside the txn BEFORE deletes** (one multi-subselect over
  the stamp columns) feeds the response, audit description AND
  `activity_log.metadata`.
- **Post-rollback verification runs AFTER COMMIT** (books derive via pool, an
  in-txn check can't see uncommitted deletes): leftover stamps = 0, TB
  balanced via `buildDerivedPostings({})`, and **batch-EXACT orphan check** —
  capture the batch's sale invoice numbers inside the txn, then assert no
  receipt with those voucher numbers survived. **Why:** a global orphan-count
  delta lets unrelated concurrent writes mask a real leftover (review
  finding); dev data already holds legacy orphans, so absolute counts fail.
- **Audit write is fire-and-forget** — tests must sleep briefly before
  querying `activity_log`.

## Transaction imports (sales & purchase invoices)

- **Imported SALES draw a fresh SB2B/SB2C number from the shared allocator**
  inside the import txn (series from the customer master's GST); the file's
  number is stored only in `sales.legacy_invoice_number` (searchable old
  reference). The sale receipt, stock-ledger notes and returned result all use
  the NEW number so the books-exclusion invariant and rollback's
  receipt-by-voucher delete stay consistent. Purchases still keep the supplied
  number (per-vendor uniqueness).

- **Commit via extracted doc functions** that replicate POST /sales and POST
  /purchases line-for-line (stock locks ascending, FEFO lots, business-dated
  stock_ledger, settlement, avg cost). **Why:** any shortcut diverges from the
  books; the routes are too entangled to call directly, so the shared pieces
  were exported and reassembled in one lib.
- **Process documents in FILE order, never re-sorted.** Weighted-average cost
  depends on entry order; the preview warns that backdated bills affect avg
  cost in the order they appear.
- **Grouping is consecutive-rows-only** (same invoice+date+party); the same
  key reappearing later in the file is an error, not a merge — silent merging
  would hide row-ordering mistakes in the source export.
- **`needs_party` is its own row status** (counted as error for commit
  gating); resolve-parties creates missing customers/vendors through the
  standard creation path (ledgers auto-provision) and then re-runs the whole
  validation over stored rows — no re-upload, and re-validation must rewrite
  batch counters too.
- **Target location is an explicit 400-guarded choice** — defaulting to the
  uploader's branch would stamp an entire migration onto the wrong location.
- **Rollback is all-or-nothing in ONE transaction** (unlike per-record masters
  rollback): settlement ids live on the head row's `raw.created`; purchase
  unwind runs `updateAvgCostOnReversal` BEFORE qty removal and blocks when the
  lot has been consumed; expect avg_cost to legitimately stay non-zero once
  remaining qty hits 0 (standard unwind semantics — inert, next inbound
  recomputes).
- **Settlement facts that trip test expectations:** purchases round-off to
  whole rupees (`round_off` col); sales status value is `partially_paid` (not
  "partial"); cash/UPI/bank sales settle at creation with NO sale_payments
  row — only credit collections write one; interstate detection reads
  `company_settings.state`, which can be blank (→ intrastate fallback).

## Voucher imports (receipts & payments)

- **The validation-time allocation plan is preview-only.** Commit RECOMPUTES
  allocation inside each voucher's transaction on row-locked documents.
  **Why:** dues can change between parse and commit; trusting the stored plan
  would over- or double-settle.
- **The preview plan runs over a RUNNING outstanding shared across the file**
  (earlier rows decrement what later rows see) so multi-row files preview the
  same way they commit. Explicit against-invoice refs settle ONLY that doc
  (detailed error classes: not found / cancelled / branch-transfer / other
  location / already settled); blank refs go FIFO oldest-first; excess parks
  in CADV/VADV via the standard advance path.
- **Provenance is `source='allocation'`** — edit-locked like allocation
  vouchers, books derive with zero journal changes, never NULL (NULL fails
  closed for edit rights).
- **Account cell mapping:** blank/"cash" → the location's cash till
  (mirror-aware); "bank" → the unique STD-BANK leaf; anything else = exact
  case-insensitive ledger-name match, error otherwise.
- **Rollback refusal reads `advance_consumptions`** (attribution to the
  parking voucher's id) — a consumed advance blocks the WHOLE batch with a
  per-voucher reason; freeing the consumption unblocks it.
- **Dues include GST:** sale outstanding is MRP-inclusive but purchase-bill
  dues = taxable + GST (unitCost is pre-tax) — FIFO expectations in tests must
  use bill TOTALS, not qty×unitCost.
