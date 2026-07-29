---
name: Mirror warehouse/outlet rows share one till
description: Marlin ERP has warehouse rows that are duplicates of outlet rows, sharing a cash ledger with no discriminator column — read before writing any per-location money query.
---

# A location can exist twice, under two types

Some warehouse rows are duplicates of outlet rows: same name, and — critically — the
**same `cash_ledger_id`**. They are two identities for one physical place.

There is **no column that marks a row as a mirror.** The only signal is a shared cash
ledger. Do not expect a flag, a parent link, or a naming convention to tell you; a
warehouse legitimately named "… Outlet" is still a warehouse.

**Why it matters:** three separate defects came out of this pairing.

- **Double counting.** List both identities and one till's cash appears twice, so a
  "total cash" figure silently doubles. Dedupe by cash ledger, not by name or id.
- **Silent hiding.** Rows are stamped with whichever identity the user was in at the
  time. A query keyed on the stamp alone will not find a record entered under the
  twin, so a page shows nothing where the old ledger-keyed query showed a row.
  Resolve a location to *every* `(type, id)` pair sharing its cash ledger before
  filtering reads.
- **Read/write divergence.** Ledger-code conventions (`WH-CASH-<id>`,
  `OUTLET-CASH-<id>`) only ever got provisioned for one half of the pair. Resolving
  by code makes the twin look like it has no till: reads reported zero, and writes
  were rejected outright. Resolve from the stored `cash_ledger_id` column, with the
  code as fallback only.

**How to apply:** for any per-location money feature, ask three questions — is this
figure summed across identities (dedupe), is this a read that must find rows entered
under the twin (resolve identities), and does this write resolve the till the same way
the read did (a till you can see must be a till you can transact from). Any fix that
makes a previously-zero location show real money also makes its write paths reachable
for the first time; check them in the same change.

That audit has to be exhaustive: fixing the obvious cash route (the deposit page) left
*other* write paths still resolving by code, so collecting payment against an invoice
failed outright at a mirrored location long after the read paths were correct. Enumerate
every route that resolves a till, not just the one that surfaced the bug.
