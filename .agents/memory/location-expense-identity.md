---
name: Location expenses need an explicit discriminator
description: Why location expenses in Marlin ERP are identified by a stored flag and mode rather than inferred from which ledger funded them.
---

# Never infer a record's kind from the account that funded it

Location expenses are rows in the shared `payments` table. They were originally
*identified* by "the money came out of a location's cash ledger". That works only
while every expense is paid in cash.

The moment an expense can be paid from a bank account or left unpaid on credit, the
funding ledger stops identifying anything: a bank-funded expense looks like any other
bank payment, and the same query then hides it from the page that created it.

**The rule:** identity gets its own stored discriminator, and the payment method is
**stored as entered, never derived** from the ledgers on the row.

**Why:** derived identity is retroactively unstable. Re-point a location's cash ledger,
or add a payment method, and history silently reclassifies — rows leave or join the
page with no write having touched them. A stored flag cannot drift.

**How to apply:** when a shared table starts serving a second kind of record, add the
discriminator *before* adding the feature, and backfill under a migration guard so the
flag is set for rows created under the old rule. Then rekey **every** read — the old
inference is usually spread across a list query, a single-record fetch, a summary
aggregate and a delete guard, and missing one leaves a row that can be listed but not
deleted (or worse, deleted from the wrong page).

Related: a credit-mode expense needs a payable ledger to credit. Provision it as a
standard ledger at startup like the other `STD-*` accounts, rather than asking the user
to create one, or the first credit expense fails with a configuration error.
