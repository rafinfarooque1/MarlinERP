---
name: Sale MRP floor
description: Sale-line price must be >= item master MRP; grandfathering on edit; deliberate exemptions; fixture-pricing rule for tests.
---

# Sale MRP floor

A POS sale line's price may equal or exceed the item's master MRP, never go
below — reductions go through the discount fields so MRP, selling price and
discount stay separate figures.

**Why:** owner spec (Aug 2026) — protects margin analysis and stops silent
under-pricing at the till.

**How to apply:**
- Enforced server-side on sale create AND edit (400 `MRP_BELOW_MASTER`) plus
  POS field validation. Items with mrp 0/unset have no floor.
- Grandfathering (edit only): floor = min(master MRP, lowest STORED line price
  for that item) — invoices saved before a later MRP rise stay editable but
  can't be reduced further. Floors come from stored lines, never the request.
- The compare is STRICT with no epsilon: both sides parse decimal strings, so
  equal decimals are identical doubles; an epsilon re-opens a sub-paisa hole.
- Deliberate exemption: cross-GSTIN transfer invoices (system docs priced at
  cost). Quotations are NO LONGER exempt (Aug 2026): they enforce the same
  floor via the shared checkMrpFloor (quotation-specific message, code stays
  MRP_BELOW_MASTER), because the quote MRP became editable UPWARD — see
  quotations-module.md.

**Test-fixture rule:** any suite selling below its fixture item's MRP now gets
400 — price fixture sales ≥ the fixture mrp, or pin the fixture mrp to the
lowest price the suite uses.

**Pre-existing suite failures (NOT this feature):** the GST compliance suite
sends unauthenticated requests (predates global auth) and fails wholesale; the
accounting suite fails on an unstocked first warehouse + a payroll JV/net-pay
mismatch — dev-data conditions.
