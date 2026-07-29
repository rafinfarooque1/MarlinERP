---
name: Chart of accounts presentation & protection
description: Why a balance's sign does not tell you Dr/Cr, why a parent account need not equal its children, and why a ledger's code must never be client-writable.
---

## The statements payload is signed to each section's natural side

`/accounts/financial-statements` returns every figure so that a *healthy* balance is
POSITIVE: a liability standing at 384.62 Cr arrives as `+384.62`, and an input-tax
credit sitting inside a liability group arrives NEGATIVE.

**Why:** the statement builder normalises each section so totals can be summed and
compared without per-node sign juggling.

**How to apply:** never derive the Dr/Cr suffix from `balance > 0`. Derive it from the
account's `type` — asset/expense are debit-natural, liability/equity/income are
credit-natural — and then flip on a negative balance. Getting this wrong labels every
liability, capital and income row "Dr", which is exactly backwards. The per-ledger
statement endpoint is different: it returns raw debit-minus-credit, so there a positive
balance really is Dr.

## A parent account is NOT always the sum of its children

Some accounts are postable *and* have accounts filed under them — "Cash" and "Bank" are
the live examples. They carry entries made directly to them (from before per-location
cash ledgers existed) *plus* their children's balances. Listing only the children leaves
an unexplained gap that reads as a broken total.

**Why:** the chart grew: sub-ledgers were introduced under accounts that had already
been posted to for months, and nothing migrated those historical postings down.

**How to apply:** any tree/statement that shows children under a parent must emit the
residue (`parent − Σ rendered children`) as its own explicit line, computed from the
children *actually rendered* so filters and hidden inactive rows can't break the
arithmetic. Suppress it while a search filter is active — there the tree is
deliberately partial, so a residue would be an artefact of the filter, not a fact about
the books. Use the usual 0.005 epsilon; a small residue is real (rounding lands there
too) and worth showing.

## `code` is the system-owned marker — never let a client write it

A non-null `code` on an account ledger is what makes it system-owned: it drives the
rename block, the delete block, and every provisioning lookup that finds an existing
ledger instead of creating a duplicate.

**Why:** an edit-rights holder who can set `code` can strip it from a system ledger and
then delete the very account the statements are built from — the protection is only as
strong as the immutability of the field it keys on.

**How to apply:** codes are assigned by provisioning helpers and boot migrations only.
Keep them out of every request body (a raw `UPDATE ... SET code = $1` fed from
`req.body` defeats the zod schema that deliberately omits the field). When you strip a
field from an update path, check whether the remaining update can now be empty —
drizzle throws "No values to set" on an empty SET, which surfaces as a 500.
