---
name: Voucher print verification
description: Durable checks for physical voucher PDF placement and one-page output
---

Voucher print tests should verify all three layers: `pdfinfo` for exact page size and page count, `pdftotext -bbox` for the maximum text x-coordinate staying left of the center cut, and a rasterized page for visual clipping or accidental right-half duplication.

**Why:** A PDF can report the correct paper size while still placing a duplicated or overflowing voucher on the spare half; text bounds and a rendered image catch different classes of layout regressions.

**How to apply:** Use these checks whenever a server-rendered voucher or other half-sheet business document changes physical placement.