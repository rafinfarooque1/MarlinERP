---
name: Books drill-down & export surface
description: How ledger-statement/day-book rows map to source documents, the ?view= query-param pattern target pages watch, and the shared export guard.
---

# Books drill-down & export surface

The ledger statement and day book expose each posting's provenance key from
`buildDerivedPostings()` (`sale:12`, `purchase:5`, `payment:9`, `receipt:3`,
`receiptadv:3`, `jv:7`, `expense:8`, `purchadv:44`, `rent:<id>`, `salary:<key>`,
`opening-balance-N`). The client maps them in ONE place —
`marlin-erp/src/lib/drilldown.ts` — to either a link or a human explanation.

**Rules that must hold:**
- For `jv:*` keys the posting `source` carries the voucher type
  (journal/contra/credit_note/debit_note); the statement's `entryType` IS that
  source string — pass it through, never re-derive from the description.
- Derived-only families (`rent`, `salary`, `purchadv`, retired `expense`,
  opening balances) must explain instead of dead-clicking (sonner toast). A
  numeric-looking id does not imply a navigable document — `purchadv`'s id is
  the advance-application row, not the purchase.
- Any NEW posting producer must emit an entry key and get a case in
  drilldown.ts, or its rows silently become dead clicks.

**Target-page contract:** documents open via query params the pages watch on
mount, then strip with `history.replaceState`:
`/headoffice/sales?view=<id>`, `/production/purchase?view=<id>` (fetch by id —
the row may be outside the loaded list pages, so use the GET-by-id hook, never
scan the list), `/accounts/vouchers?kind=<type>&view=<id>` (sets type filter +
search to the voucher number; JVs expand). Target pages keep their own
permission gates — books access does not grant sales access.

**Exports:** all books pages (Ledger, Day Book, Cash/Bank Book, Trial Balance)
export through the shared `/pdf/report` + `/xlsx/report` endpoints guarded by
an any-of `requireModuleAction([...pages], 'download')` list
(`REPORT_EXPORT_PAGES` in pdfGen.ts) — a new exporting page must be added to
that list or its users get 403 despite seeing the buttons. The xlsx coercer
strips "Rs. …" strings back to numbers, so pages send `pdfMoney()` output.

Regression suite: `api-server/tests/books-drilldown-export.test.mjs`
(read-only, self-provisions a level-1 probe user).
