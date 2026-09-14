---
name: Asset module design
description: Fixed-asset module — register model, route-order trap, and journal-backed lifecycle accounting
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

**Accounting:** GST on an asset purchase is capitalised into the Dr STD-FIXED-ASSET
total; the acquisition voucher is Dr fixed-asset / Cr STD-CASH | STD-BANK |
VEND-&lt;id&gt; by payment mode, `source_module='fixed_asset'`, with zero stock movement.
Monthly straight-line depreciation posts Dr STD-DEPR-EXP / Cr STD-ACCUM-DEPR, keyed
idempotently by asset and accounting month. Disposal posts Dr accumulated depreciation
and any remaining book value to STD-ASSET-DISP-LOSS, Cr STD-FIXED-ASSET, and stores the
voucher link on the disposal row. Transfers remain non-posting. Deleting a purchase
deletes its voucher; disposed assets refuse deletion (they are history).
**Why:** depreciation and disposal must flow through the same journal stream as the
rest of the ERP so P&L and Balance Sheet agree with the asset register.
**How to apply:** keep depreciation/disposal journals location-stamped to the asset's
current location and guard both routes with month lock and LBAC checks.

**LBAC:** asset rows are scoped on `COALESCE(current_location, purchase location)` — a
transfer changes who can see the asset. Reports offer `locationBasis=purchase|current`.

**Voucher location:** every non-zero asset purchase voucher must carry the same resolved
location as its purchase row; the voucher location is required for located statements and
must be stamped during the purchase transaction, not inferred later.
**Why:** asset purchases are accounting transactions, so an unstamped journal voucher
disappears from location-filtered books even when the register row is correctly located.
**How to apply:** stamp `location_type/location_id` from the resolved purchase location on
every future fixed-asset journal voucher; do not rewrite historical production vouchers
without an explicit data-repair decision.
