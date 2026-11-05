---
name: Sale MRP floor
description: Sale-line price must be >= item master MRP; grandfathering on edit; deliberate exemptions; fixture-pricing rule for tests.
---

# Sale Item Master Rate floor

A POS sale line's entered Rate may equal or exceed the Item Master rate for
employees; only a level-1 Administrator may enter a lower rate. The server
enforces this on create and edit, and both web and employee-app forms mirror it.
Quotations and sales imports keep their separate existing floor behavior.

**Why:** the user requested a locked Item Master rate for employee billing, with
an Administrator override for pricing below it.

**How to apply:**
- Keep the admin exception server-authoritative (level-1 hierarchy); client
  validation is display behavior only. Items with mrp 0/unset have no floor.
- Grandfathering (edit only): floor = min(master MRP, lowest STORED line price
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
