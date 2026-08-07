---
name: Cross-environment record identity
description: dev and prod hold separately-imported copies of the same business documents — ids and generated batch numbers differ; match by business number
---

Rule: the dev and production databases each ran their own data import, so the SAME real-world document exists in both with DIFFERENT surrogate identities. A purchase bill the owner calls "#0039" is the PROD purchase id; its dev twin has another id, and allocator-generated lot numbers (`PUR-YYYYMMDD-00NNN`) differ per environment too. Match records across environments by their business number (invoice_number, voucher_number), never by id or generated batch number.

**Why:** a metadata-fix request named prod batch numbers that simply don't exist in dev; the dev twin (same invoice_number) carried its own batch numbers. Applying a fix "by batch number" in the wrong environment silently no-ops.

**How to apply:** when the owner references a document, locate it in BOTH environments by business number before acting. Prod is read-only from the workspace — data corrections there must go through the app in production (publish first if the needed code path is newer than the last publish). Purchase date-only corrections (mfg/expiry) already bypass stock validation via the edit path's dateFixes branch — no separate utility needed; a 409 PURCHASE_STOCK_CONSUMED on a dates-only edit in prod means prod predates that branch.
