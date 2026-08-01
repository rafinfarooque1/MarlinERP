---
name: Asset module design
description: Fixed-asset module — register model, route-order trap, and what is intentionally NOT posted
---

# Asset Management module

**Register model:** each `asset_purchases` row IS the register entry. It carries its own
`current_location_*` and `status` (active/sold/scrapped/written_off/transferred_outside);
transfers and disposals act on the purchase row and append to `asset_transfers` /
`asset_disposals` history tables. There is no separate register table — the `assets`
master only deduplicates names.
**Why:** purchases create register entries 1:1, and a separate table would need constant
sync. Quantity>1 purchases are one register row (not per-unit) — splitting them later
means changing this model.

**Route-order trap:** the assets router must be registered BEFORE the inventory router.
Inventory owns `GET /assets/:id` (legacy asset master detail), which otherwise swallows
`/assets/categories`, `/assets/summary`, etc. as `:id`.
**How to apply:** any new `/assets/<literal>` route stays safe only while that ordering
holds; check `routes/index.ts` order when adding routers with overlapping prefixes.

**Intentionally NOT posted (schema is future-ready only):** depreciation, disposal
accounting, and GST input-tax-credit. GST on an asset purchase is capitalised into the
Dr STD-FIXED-ASSET total; the only voucher is Dr fixed-asset / Cr STD-CASH | STD-BANK |
VEND-&lt;id&gt; by payment mode, `source_module='fixed_asset'`, zero stock movement. Transfers
and disposals post nothing. Deleting a purchase deletes its voucher; disposed assets
refuse deletion (they are history).

**LBAC:** asset rows are scoped on `COALESCE(current_location, purchase location)` — a
transfer changes who can see the asset. Reports offer `locationBasis=purchase|current`.
