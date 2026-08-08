---
name: Party GST persistence & validation
description: Customer/vendor GST number chain — the list-casing wipe bug, blank = NULL rule, and grandfathered GSTIN validation on writes.
---

# Party GST persistence

**The wipe bug (fixed Aug 2026):** the customers LIST endpoint returned raw
`c.*` rows (snake_case `gst_number`) while every consumer — Customers page,
CSV, profile sheet, and the shared CustomerFormDialog — read `gstNumber`.
The edit dialog therefore loaded blank and saved the blank back, wiping the
stored GST on ANY customer edit. Vendors were never affected because their
list always mapped `gstNumber` explicitly.

**Why:** this is the "list vs detail casing" trap (see list-detail-casing.md)
biting a WRITE path: an edit form initialised from a list row turns a casing
mismatch into silent data loss, not just a blank display.

**How to apply:**
- Any edit form initialised from a LIST row must either get a camelCase-mapped
  list response or read `camel ?? snake ?? ''` on load. Both party forms now
  carry the fallback.
- Blank GST is stored as **NULL, never ''** — write paths normalise (trim,
  uppercase, '' → null) via `normalizeGstField` in routes/customers.ts, and an
  idempotent boot sweep in index.ts nulls any '' rows every boot.
- GSTIN validation (15-char regex) is **grandfathered on PATCH**: a stored
  legacy typo resubmitted verbatim passes (the form resends stored values, so
  strict rejection would block every unrelated edit of those rows); any NEW
  invalid value is a 400. Live data has several legacy typos — never "clean"
  them automatically.
- Validation is route-level ONLY, deliberately not in lib/partyCreate.ts — the
  data-import commit path reuses partyCreate and must accept legacy values.
- Regression suite: tests/party-gst.test.mjs (temp cloned admin; note its
  cleanup() deletes the temp user — never call it mid-run after login).
