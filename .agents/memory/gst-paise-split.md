---
name: GST paise split
description: CGST/SGST halves must be half + exact remainder, never two independent rounds
---
Splitting intra-state GST as `cgst = round(tax/2); sgst = round(tax/2)` breaks on odd-paise tax (₹0.05 → 0.03 + 0.03 = 0.06 ≠ 0.05), making accounting heads and GST reports disagree with the stored line tax. Correct split: `half = round(tax/2); other = round(tax − half)` so the heads always sum exactly to taxAmount.

**How to apply:** any place that derives CGST/SGST from a total tax (server tax computation, client preview math, reports) must use the half+remainder pattern, and both server and client copies must match. Regression: assert `cgst + sgst === taxAmount` on an odd-paise case (e.g. base 100.50 @ 5%).
