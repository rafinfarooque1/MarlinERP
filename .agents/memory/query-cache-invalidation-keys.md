---
name: React Query invalidation keys must come from the generated helpers
description: A hand-written invalidation key that matches no query fails silently and looks exactly like a backend bug.
---

Always invalidate with the **generated** query-key helper
(`getListVendorsQueryKey()` → `['/api/vendors']`), never a hand-written guess
like `['vendors']`.

**Why:** the two look equally plausible in review, but a key that matches no
query is a no-op. The mutation succeeds, the toast fires, the server is
correct — and the screen keeps serving the pre-mutation value from cache until
a full reload. The symptom presents as a *backend* bug ("the balance didn't
update"), so debugging starts in the wrong layer. Confirm where the truth is by
curling the endpoint before touching any server code.

**How to apply:** when a mutation changes a figure, invalidate every surface
that reports that figure, not just the one on screen — for a vendor payment
that is the vendor ledger, the vendor list, the payables ageing, the dashboard
tiles and the cash-in-outlet list. Custom hooks living outside the generated
client may import the generated key helpers; that is an established pattern in
this workspace and creates no cycle.
