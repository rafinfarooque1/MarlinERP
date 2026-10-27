---
name: Locking Rate price floor
description: Sales price-floor semantics and the authorization/audit requirements for administrator overrides.
---

# Locking Rate price floor

A configured Locking Rate replaces the MRP floor for sales. Compare the effective per-unit rate after item discounts, allocated bill discounts, and any post-tax coupon share. For exclusive-tax pricing, convert a coupon's gross share back to the taxable-rate basis before comparing.

Items without a Locking Rate retain the existing MRP floor and saved-price grandfathering on edits. Only a server-verified level-one administrator may go below a configured Locking Rate, and only when the request explicitly asks for the override. The UI checkbox is not authorization. Record accepted overrides inside the sale transaction with the actor, invoice, location, item, original/effective prices, discount, and timestamp.

**Why:** A body flag or front-end role check is forgeable, while comparing only the entered rate misses discounts that lower the final selling price.

**How to apply:** Keep create and edit paths on the same server-side effective-price check; preserve MRP behavior for unconfigured items and audit every authorized exception.
