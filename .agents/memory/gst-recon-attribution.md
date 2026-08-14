---
name: GST reconciliation attribution
description: How the recon drill-down decomposes head differences into documents + JV entries, and the GSTR-1/3B invariants the suites pin
---

# GST reconciliation drill-down & GSTR-1 detail (Aug 2026)

## Attribution decomposition (the design contract)
- For every tax head, `rows[].difference` (ledger − register) decomposes EXACTLY into
  Σ per-document differences (`mismatchDocs.outward/.inward`) + Σ non-document
  postings on that head (`otherEntries`, JVs etc.). The test suite pins this identity.
- **Why:** without exact decomposition the drill-down can "explain" a mismatch while
  hiding another; matched-with-offsetting-detail is a real state (cancelled BTR
  invoices +tax offset by their credit-note JVs −tax, net 0).
- **How to apply:** any new producer that posts to the six STD-OUT-*/STD-INP-* heads
  or STD-DTX must either carry a `sale:`/`purchase:` entryId (attributed to the doc)
  or surface in `otherEntries` — never silently shift the ledger side.

## Register-vs-fetch asymmetry (regression trap)
- The recon fetch includes cancelled + branch-transfer docs (they still post until
  reversed), but the legacy aggregate fields (`rows`, `salesTaxTotal`…) are computed
  ONLY over non-cancelled rows so the pre-existing response stays byte-identical.
  Filter at aggregation time, not fetch time.

## GSTR-1 invoice-wise B2C
- `b2c[]` rows (one per sale × rate group) must aggregate exactly into the `b2cs`
  portal rows per (placeOfSupply, rate); totals are computed from b2b+b2cs and are
  untouched by the detail. Payment status/mode come from the existing
  salePaymentSummaries helper (branch transfers = "na").
- Credit/debit notes are NOT netted into GSTR-1 figures (display carries a caption;
  math change is a separate queued task).

## GSTR-3B testable invariant
- Set-off follows the statutory order (IGST credit first), so netPayable per head is
  NOT max(0, out−itc). The invariant to assert is conservation:
  `(itc.totalItc − itcCarriedForward.total) + netPayable.total == outwardSupplies.totalTax`.
- `/gst/gstr3b` takes `?month=YYYY-MM`, not fromDate/toDate.

## Page conventions
- GstReturns tabs deep-link via `?tab=hsn|gstr1|gstr3b|recon` (screenshots/tests).
- All /gst/* endpoints honor the global x-location-* headers with query-param
  parity and HO-header == company-wide (verified by gst-recon-b2c.test.mjs).
