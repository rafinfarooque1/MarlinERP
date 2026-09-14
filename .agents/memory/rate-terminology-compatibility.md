---
name: Rate terminology compatibility
description: The user-facing rename from MRP to Rate and the compatibility boundary that must remain stable
---

Use “Rate” in labels, messages, exports, import templates, PDFs, and other user-facing sales, stock, item, and quotation surfaces. Keep the underlying `mrp`, `masterMrp`, related function names, database columns, API fields, and import aliases unchanged unless a deliberate breaking contract migration is requested.

**Why:** Existing documents, clients, migrations, and imports depend on the current internal names; changing them would turn a terminology update into a compatibility-breaking schema/API migration.

**How to apply:** Update visible copy and generated document text only. Treat `mrp`-shaped identifiers and aliases as internal compatibility surfaces, and verify both web and employee-app text when adding a new price display.