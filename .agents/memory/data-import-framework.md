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
