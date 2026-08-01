---
name: Sharing a builder between create and edit
description: Reusing the create path's body→rows builder for an edit silently applies create-time defaults to any field the edit omitted.
---

Sharing one validation/build function between POST and PATCH is right — a
document that could not have been created should not be reachable by editing
either. But the create path fills omitted optional fields with **module
defaults**, and an edit that omits the same field does not mean "reset me to the
default", it means "leave me alone".

Found live: editing a credit note's amount without re-sending
`counterLedgerId` moved its counter leg from Purchases to Sales, because the
create path defaults that field per voucher type. Nothing errored; the entry was
just reclassified into a different account.

**Why:** the builder cannot tell "field absent because the caller has no opinion"
from "field absent because there is nothing there yet". Only the caller knows,
and only the edit caller has a prior value to fall back on.

**How to apply:** give the shared builder an explicit `defaults` parameter.
Create passes nothing; edit passes the row's **current** values, read from the
stored record. Resolution order becomes body → existing value → module default.
Audit every optional field the create path back-fills, not just the one that
broke.

Reading the current value outside the transaction is fine when the write is
already protected by a revision check inside it — a concurrent change fails the
rev check and rolls the whole edit back.

Related: `effective-value-guards.md` (guard the resulting state, not the body)
and `document-renderers.md` (absent ≠ zero).

## Case: sale PUT location corruption (Aug 2026)
`PUT /sales/:id` defaulted omitted `locationType`/`locationId` to `'outlet'`/`undefined`, silently wiping the sale's location. 35 rows (₹19,288.53) corrupted this way were the entire receivables-vs-TB drift. Fix: omitted location fields preserve the row's current values; recovery came from activity_log CREATE metadata (`metadata->'after'`). Corollary: cash-mode sales with `amount_paid < total` are a corruption signal — cash settles in full at creation.
