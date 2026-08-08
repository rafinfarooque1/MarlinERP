---
name: B2C→B2B invoice reclassification
description: Customer gains GSTIN → open-month B2C invoices convert to the B2B series; compaction floor, unconditional location guards on trail renames, GST save inside the conversion txn.
---

# B2C→B2B invoice reclassification

`lib/invoiceReclass.ts::convertCustomerB2CToB2B` — runs from the customers
PATCH when GST goes blank→valid. One transaction converts eligible SB2C
invoices to the SB2B series, compacts the vacated B2C serials, renames the
paper trail, writes audit rows. Locked months are skipped and reported;
legacy NULL-series rows are counted but untouched.

**GST save is INSIDE the conversion transaction** (`applyGstin: true`): the
route strips `gstNumber` from its own update and lets the conversion write it,
so a failure leaves neither a GSTIN on file nor a renumbered invoice. Never
reintroduce a separate save-then-convert with a compensating revert.

**Compaction floor principle:** only close gaps the conversion itself opened —
floor = max(pinned serials, minConvertedSerial − 1). Pins = locked-month,
cancelled, serial-less rows. Pre-existing historical gaps are NEVER renumbered
(those are real, issued documents). The per-scope counter is walked BACK to
max-in-use under the counter row lock.

**Trail renames need UNCONDITIONAL location predicates.** Invoice-number
strings repeat across location scopes by design, and receipts exist that no
live sale accounts for (orphans of deleted sales, legacy imports) — so a
"number currently unique among sales" probe proves nothing about receipts.
Receipts rename on `voucher_number + location_type + location_id`; quotations
rename on `converted_sale_id`, never a bare number match. The same rule binds
TEST CLEANUPS: a bare `DELETE FROM receipts WHERE voucher_number = $1` deleted
two real receipts in dev (restored by hand from sale_payments + the sibling
receipt's shape). Location-guard every trail delete, always.

**GSTR-1 freezes on the stamped `invoice_series`** (SB2B→B2B, SB2C→B2C);
only legacy NULL-series rows fall back to the GSTIN heuristic. A locked-month
B2C invoice stays B2C in returns even after the customer holds a GSTIN.

**Test isolation:** the regression suite (`tests/b2c-b2b-conversion.test.mjs`)
builds a THROWAWAY warehouse so resequencing can't touch real scopes, purges
strays by NAME at start (crash recovery), and the permanent warehouse delete
needs `confirmation: "DELETE <name>"`. GSTINs are generated with the real
check-digit algorithm in-test since the API validates checksums.
