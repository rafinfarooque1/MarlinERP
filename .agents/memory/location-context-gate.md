---
name: Sales segment location gate
description: Why /sales/* pages render blank on deep links and how to navigate them in tests.
---

**Rule:** Every sales-segment page (POS, expenses, stock, dashboard) renders `null` until a location is chosen in the client-side location context. The context starts empty in a fresh browser session, so deep-linking straight to a segment page shows a blank dark page with no error — queries may still fire, nothing renders.

**Why:** The segment pages assume the `/sales` location picker ran first and set the context; there is no fallback UI. A blank page in a fresh session is expected behavior, not a crash — this burned a full e2e round misdiagnosed as a render regression.

**How to apply:**
- In UI tests (fresh browser contexts), always navigate `/sales` → click a location card → then the target segment page.
- When debugging a "blank page, no console errors, only the toaster in the a11y tree" report on these pages, check the location context before hunting for crashes.
- If asked to fix the blank state, all segment pages share the same gate — change them together, not one-off.
