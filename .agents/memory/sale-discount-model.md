---
name: Sale discount model
description: Three distinct sale discounts (per-unit item, pre-tax bill, post-tax coupon) and the derived stored-line `discount` that keeps every legacy consumer correct.
---

# Sale discount model

THREE independent discount concepts on a sale — never mix them:

1. **Item discount** — `unitDiscount`, ₹ off EVERY unit's MRP (0 ≤ ud ≤ unitPrice, server-enforced). Line amount = ud × qty.
2. **Bill discount** — `billDiscount` on the sale, ONE **pre-tax** amount allocated across lines proportional to each line's post-item-discount value, paise-exact by largest remainder (shares sum EXACTLY; no share exceeds its basis). Each line's taxable value and GST come from `round2(basis − share)`.
3. **Coupon** — `discountTotal`, **post-tax** flat deduction off the grand total. Untouched by the rework.

**The key trick:** every stored line keeps `discount = round2(itemDiscount + billDiscountShare)` — the TOTAL pre-tax ₹ off the line. All legacy consumers that recompute `gross = qty×unitPrice − discount` (PDF line loop, GST reports, accounting via stored cgst/sgst/igst heads) stay correct with zero changes. `unitDiscount`/`billDiscountShare` carry the decomposition for display and edit.

**Why:** rewriting every consumer of `li.discount` would be enormous and regression-prone; deriving the legacy field keeps the blast radius to the two write paths.

**How to apply:**
- The POS ₹/% toggle on the bill discount is CLIENT-ONLY entry sugar: a % converts to ₹ before compute and the payload overrides the raw form value, so the server contract stays ₹-only. Any new discount-entry UI must keep that boundary — never send a percentage.
- Any NEW reader that wants item-only discount must compute `discount − (billDiscountShare ?? 0)` (legacy lines have no share → no-op). Never label the combined `li.discount` as "item discount".
- Legacy lines (no `unitDiscount`) keep line-TOTAL `discount` semantics FOREVER — including through edits. The edit form derives `ud = (discount − share)/qty` at FULL float precision so an untouched save round-trips exactly.
- Client preview must mirror server rounding: round the adjusted amount to the paisa BEFORE the tax math (fractional kg quantities keep sub-paisa fractions otherwise) — call the tax fn with (1, adjustedAmount) rather than (qty, price, disc).
- Full-MRP "gross" figures add back item + pre-tax bill discounts only; subtotal+tax already stands before the post-tax coupon.
- Regression suite: artifacts/api-server/tests/sale-discounts.test.mjs (70 asserts incl. allocation exactness, legacy semantics, fractional qty).
