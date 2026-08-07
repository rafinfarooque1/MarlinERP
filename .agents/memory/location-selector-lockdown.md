---
name: Location selector lockdown for branch users
description: Branch (warehouse/outlet) users must never be OFFERED or shown names of foreign locations in any picker; the pin pattern and the shared surfaces that enforce it.
---

Rule: a branch user's acting location is a fact of their login, never a choice. Every form that posts to a location renders a read-only label for them (never a dropdown), and every filter/picker lists only their own scope (own branch + child outlets). Merely defaulting the dropdown is not enough — the dropdown itself names other branches, which is the leak.

**Why:** owner requirement — warehouse staff "must not even know other warehouses exist"; the server already rejects foreign writes (403), so the remaining exposure is purely what pickers display.

**How to apply:** any NEW location picker/filter must go through one of the shared surfaces below, or copy the pin pattern (`isHOUser ? <Select> : fixed label`, defaults pinned to `me.branchType/branchId`, plus a cold-load guard effect because /api/me resolves async — pin only CREATE forms; edits/conversions keep the document's stored location, which may be a child outlet).

Shared surfaces that already enforce this (extend them, don't fork):
- `lib/useActingLocation.ts` — options + canChoose + labelFor (purchases, production, assets).
- `lib/voucherLocation.tsx` `LocationSelectField` — renders fixed label when server offers ≤1 location (all money/journal voucher forms).
- `components/ui/LocationFilter.tsx` — list-filter two-step; scoped to own branch for locked users (transfers, reports, stock, reconciliation).
- `pages/sales/LocationPicker.tsx` — auto-skips to POS when a warehouse user has exactly one visible location.
- Sales.tsx / Quotations.tsx carry their own hand-rolled selector with the pin pattern inline.
- HO-only creation UIs (cash-bank accounts, HO expenses) hide the Add button for branch users — the dialog's location list would otherwise name every branch.

GET /warehouses and /outlets stay UNSCOPED by design: transfer destinations and document display names legitimately need foreign names. The lockdown is per-surface, not on the master lists.

Testing trap: scope rejections sit BEHIND earlier validations — a foreign-location probe that fails zod (wrong field name, e.g. transfers use `lineItems` not `lines`) or referential checks (invalid expense ledger) proves nothing about scope. Make the rest of the body valid first.
