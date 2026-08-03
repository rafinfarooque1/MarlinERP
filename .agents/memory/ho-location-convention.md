---
name: Head Office location convention
description: HO is a full location (selling included) but its placeholder id differs per table — match on TYPE alone; hand-rolled predicates (dashboard/bi) need explicit HO branches
---

Rule: Head Office is a first-class location everywhere (vouchers, sales/POS, dashboard, global selector), but its stored placeholder id is NOT uniform: journal/money vouchers store `location_id 0`, while sales/purchases/productions/stock store `1` (the item-stock convention). Every location predicate must therefore match HO on TYPE ALONE — an id equality silently drops valid HO rows from one table or the other.

**Why:** the review of the HO-selling change caught /dashboard/bi accepting `locationType=headoffice` but never applying it (and, had it applied ids, vouchers(0) and sales(1) would have excluded each other).

**How to apply:**
- Prefer the shared helpers: `pushLocationFilter` (SQL) and `PostingLocationFilter`/`postingMatchesLocation` (derived postings) already do type-only HO. `parsePostingLocationFilter` accepts `headoffice` with `id: null`.
- The BI dashboard (`/dashboard/bi`) hand-rolls its own predicates (salesConds/locConds/stock/receivables/stockValuation args) — any new locationType must be added to EACH of them explicitly; grep for `effLocType` there.
- HO sales: POST /sales with `locationType 'headoffice'` forces location_id 1, null cash/sales ledger ids (derivation falls back to STD-CASH/STD-SALES), seller name 'Head Office' (never resolved via the legacy outlet_id placeholder). Frontend state uses id 1 for HO; list filters send type-only (no locationId).
- Client lib serializers (paginated-lists) must emit `locationType=headoffice` WITHOUT a locationId or the `type && id` guard drops the filter silently.
