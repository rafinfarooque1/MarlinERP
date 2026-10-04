---
name: Customer disable visibility
description: The visibility contract for disabled customers and their historical records.
---

Disabled customers stay visible in Customer management so staff can re-enable them, but must be excluded from all other customer lists and selection/search surfaces.

**Why:** the user requested that a disabled customer appear only in the Customers area, not in other lists.

**How to apply:** keep a page-authorized management list that includes disabled rows; make normal customer lists and picker/search queries active-only. Preserve historical transactions and ledger records.

The Disable/Enable customer control requires the Customers page's Delete permission, not Edit. A status-only API update must enforce Delete; other customer-field updates require Edit; mixed status-and-field updates require both.

**Why:** the user requested that customer status controls appear only when Delete permission is granted, even when Edit permission is enabled.

**How to apply:** keep UI visibility and the server's status-update authorization aligned; mixed status and customer-field updates require both Delete and Edit.