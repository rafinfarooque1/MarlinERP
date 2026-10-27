---
name: Stock movement test dates
description: Keep inventory integration fixtures compatible with the stock baseline, daily close, and report cutoff.
---

# Stock movement test dates

Stock writes are refused before the trusted baseline and on or before the latest daily close. Future-dated movements may be accepted as stock events but omitted from financial statements whose reporting cutoff is today.

**Why:** A historical fixture can become invalid as the baseline or close-through date advances, and shifting it into the future can make otherwise valid P&L assertions meaningless.

**How to apply:** Use a controlled test database/clock or split movement assertions from date-sensitive reports; do not blindly update old fixtures to future dates.
