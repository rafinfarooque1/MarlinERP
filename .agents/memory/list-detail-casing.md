---
name: List vs detail response casing
description: List endpoints can return raw snake_case rows while detail endpoints map to camelCase
---
Some list endpoints return raw DB rows (snake_case, e.g. `gst_number`) while the single-record read on the same resource maps fields to camelCase (`gstNumber`). The generated client types claim camelCase for both, so a frontend check like `customer.gstNumber` silently reads `undefined` on list data — features that key off the field (e.g. GSTIN-driven defaults) just never fire, with no error anywhere.

**Why:** discovered when a GSTIN-driven default checkbox never auto-checked; `/customers` list returns `gst_number` but the code checked `gstNumber`.

**How to apply:** before keying UI behavior on a field from a LIST response, curl the endpoint and confirm the actual key casing; read both (`x.gstNumber ?? x.gst_number`) or fix the route mapping. Never trust the generated type as evidence of the list response shape.
