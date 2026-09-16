---
name: Release-gate browser verification
description: Use the workspace preview proxy for authenticated web checks and treat consumed drill-down query removal as expected.
---

Authenticated ERP browser checks must run through the workspace preview proxy at its registered preview root, not the frontend's direct Vite port; the direct port serves the SPA shell for `/api/*` instead of proxying API calls. Report pages intentionally consume and remove `view`, `range`, `from`, and `to` from the URL after seeding their in-page state, so verification must assert the rendered report, date inputs, and location context rather than the post-mount URL.

**Why:** Direct-port checks produced a blank authenticated shell and a misleading `hierarchies.find is not a function` error because API paths returned HTML; a valid proxy check then rendered all report destinations correctly. Treating stripped query parameters as failures also misclassified successful drill-downs.

**How to apply:** Use the registered preview root for UI automation, capture the link href before navigation, then verify destination content, selected date values, persisted location, and absence of authorization errors.