---
name: Orphan party ledgers & dropdown sources
description: Why deleted vendors/customers keep appearing in voucher pickers, and how the boot sweep heals it
---

**Rule:** party pickers in voucher entry / receipts / payments are built from the CHART OF ACCOUNTS (active ledgers), not from the vendors/customers tables. Sales/purchase pickers and global search read the masters directly.

**Why:** every customer/vendor auto-provisions a `CUST-<id>`/`VEND-<id>` ledger. The DELETE routes remove both, but a master row deleted by hand in the database leaves its ledger behind — invisible in the module, yet present in every ledger dropdown.

**How to apply:**
- A boot-time idempotent sweep deletes unreferenced orphan party ledgers and deactivates referenced ones (never delete a referenced ledger — its postings lose their name). Its explicit reference-column list must be extended whenever a new `*_ledger_id` column appears.
- Creation order is master-first, then ledger, so the sweep can never race a half-created party; the reverse transient (master without ledger) is ignored.
- Investigative lesson: pin an incident moment from rows the event itself reseeds (first admin login, `min(activity_log)`), not from gaps in data — gaps mislead.
