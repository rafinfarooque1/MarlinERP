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

## Transaction imports (sales & purchase invoices)

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
