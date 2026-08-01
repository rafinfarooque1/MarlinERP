---
name: Orphan party ledgers & dropdown sources
description: Why deleted vendors/customers keep appearing in voucher pickers, and how the boot sweep heals it
---

**Rule:** party pickers in voucher entry / receipts / payments are built from the CHART OF ACCOUNTS (`/api/accounts/chart/flat`, filtered on `COALESCE(is_active,true)`), not from the vendors/customers tables. Sales/purchase pickers and global search read the masters directly.

**Why:** every customer/vendor auto-provisions a ledger (`CUST-<id>` / `VEND-<id>` under SYS-DEBTORS/SYS-CREDITORS). The DELETE routes remove the ledger with the master, but a row hand-deleted in the database leaves its ledger behind — it vanishes from the Vendor module yet keeps appearing in every ledger dropdown. Happened in prod 2026-08-01: 11 parties entered as vendors, hand-deleted from `vendors`, re-entered as customers; their 11 VEND-* ledgers stayed in the pickers.

**How to apply:**
- A boot-time sweep (`orphanPartyLedgers.ts`, every boot, idempotent) deletes unreferenced orphan party ledgers and deactivates referenced ones (never delete a referenced ledger — postings lose their name). Its explicit 18-column reference list must be extended when a new `*_ledger_id` column appears.
- Creation order is master-first (own txn) then ledger — so the sweep can never race a half-created party; the reverse transient (master without ledger) is ignored.
- Investigative lesson: pin a reset/incident moment from rows the event itself reseeds (hierarchies, admin user, `min(activity_log)`), not from gaps in data — timestamp gaps misled the first ghost-cleanup cutoff by two hours.
