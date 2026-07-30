---
name: Audit stamps and the "system" fallback
description: Why created_by/matched_by columns silently record "system", and how to spot it
---

An audit stamp read off the wrong request property, with a `?? "system"` fallback
behind it, fails silently forever. Every row looks legitimately system-generated,
nothing throws, no test fails, and the column is only wrong in a way a human
would have to already suspect to notice.

**The rule:** an audit stamp must read from the exact object the auth middleware
attaches, and the fallback must be a value that stands out as broken (or the code
should refuse to write). Grep the middleware for what it assigns before writing
any `created_by`.

**Why:** this codebase's auth middleware attaches the caller under one property
name, but roughly half the write paths read a *different, never-assigned* one.
Those routes had been stamping every voucher, receipt, reconciliation match and
cash movement as "system" since they were written. Because the fallback was a
plausible value, the books looked fine.

**How to apply:** when adding any write path that records who did it, copy the
property expression from a route you have *verified* against the middleware, not
from the nearest neighbouring route — the codebase can be split roughly evenly
between a correct and an incorrect spelling, so "consistent with the file next to
it" is not evidence. A one-line grep across all routes for the wrong spelling is
worth running whenever you touch audit columns.
