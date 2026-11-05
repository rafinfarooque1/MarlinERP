---
name: Sale MRP floor
description: Item Master Rate and optional Locking Rate are separate; preserve the raw-rate MRP floor and compare the locking floor after discounts.
---

# Sale Item Master Rate floor

A POS line's entered Rate must continue to meet the Item Master Rate (MRP)
floor. Separately, an optional Locking Rate is enforced against the final
per-unit consideration after item, bill, and coupon discounts. Only a confirmed
Level-1 Administrator may override the Locking Rate, and the sale audit records
the overridden items and effective rates.

**Why:** the user clarified that the original Locking Rate must be a separate,
optional field and must not replace or overwrite the normal Item Master Rate.

**How to apply:**
- Keep the normal MRP floor independent of Locking Rate. The Locking Rate is
  optional (NULL means no restriction) and is checked after all applicable
  discounts; server authorization is authoritative.
- MRP grandfathering (edit only): floor = min(master MRP, lowest STORED line price
  for that item) — invoices saved before a later MRP rise stay editable but
  can't be reduced further. Floors come from stored lines, never the request.
- The compare is STRICT with no epsilon: both sides parse decimal strings, so
  equal decimals are identical doubles; an epsilon re-opens a sub-paisa hole.
- Deliberate exemption: cross-GSTIN transfer invoices (system docs priced at
  cost). Quotations still enforce the floor for every user via the shared
  checkMrpFloor (quotation-specific message, code stays `MRP_BELOW_MASTER`).

**Test-fixture rule:** any suite selling below its fixture item's MRP now gets
400 — price fixture sales ≥ the fixture mrp, or pin the fixture mrp to the
lowest price the suite uses.

**Pre-existing suite failures (NOT this feature):** the GST compliance suite
sends unauthenticated requests (predates global auth) and fails wholesale; the
accounting suite fails on an unstocked first warehouse + a payroll JV/net-pay
mismatch — dev-data conditions.
