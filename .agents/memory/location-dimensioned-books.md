---
name: Location-dimensioned books
description: How the posting stream carries a location dimension — stamping rules, filter semantics, the company bucket, return-voucher attribution, and as-of business dates.
---

# Location-dimensioned books

## Stamping
- Every derived posting carries `locationType`/`locationId`; BOTH legs of an entry share ONE stamp, so every location slice is internally balanced by construction. Never stamp legs independently.
- Filter params `?locationType=&locationId=`: `warehouse`/`outlet` match type+id, `headoffice` matches type alone (legacy id placeholders differ), `company` matches null-location postings.
- ZERO DRIFT contract: with no filter params the response must be byte-identical to pre-feature output — no `location`/`companyLevel` keys, no changed math. Filtered responses add `location` + `companyLevel {entries, debit, credit}` (the unattributable postings, echoed identically whichever slice asked).
- The filter is presentation narrowing, NOT authorization — LBAC runs first.
- Location-slice stock = branch-scoped valuation; the `company` slice's opening/closing stock is 0 (stock always belongs to a place).

## Journal vouchers — the return exception
- `journal_vouchers` has no location column, so JV lines default to company-level. That is the honest answer for manual journals, payroll allocations, and two-location transfer vouchers — but NOT for return notes.
- A sales-return credit note / purchase-return debit note is a system voucher raised from a location-bearing document. Resolve its location by joining `sales_returns.credit_note_id` / `purchase_returns.debit_note_id → purchases` (one-to-one, no fan-out). Without this, every return's reversal vanishes from the slice its sale/purchase posted into.
- **Why:** slices stayed balanced and reconciled to consolidated even with this bug — internal balance proves nothing about correct *attribution*. Only a fixture that posts a return and asserts which slice contains the voucher catches it.

## Refund payments
- Walk-in sales-return cash refunds are `payments` rows. Stamp them at insert AND backfill history in the derived stream via `LEFT JOIN sales_returns ON refund_payment_id` — otherwise the headoffice fallback misfiles every refund.

## As-of positions
- As-of receivables/payables (`?asOf=`) cap every movement at the date: sale_payments by payment_date, credit notes by **`return_date` (business date), never `created_at`** — a backdated return recorded later was still effective on its date. `asOf=today` must equal the undated path exactly; the undated SQL is untouched (zero drift).

## Frontend
- wouter runs with `base={import.meta.env.BASE_URL}`; a raw `<a href="/...">` escapes the base path AND bypasses the router — always use wouter `<Link>`. A dead in-app anchor renders the app's own 404 ("Location not found in database"), which looks like a backend error.
- Radix Select: `value={x ? String(x) : ''}` — `undefined` flips it uncontrolled→controlled.

## Tests
- `artifacts/api-server/tests/location-books.test.mjs` — read-only: zero drift, per-ledger slice-sum == consolidated, slice balance, day-book partition, as-of contracts.
- `artifacts/api-server/tests/location-returns.test.mjs` — creates ZZLOCRET sale+return fixtures (returns are not deletable by design; each pair nets ~zero) to pin return attribution and the return_date cutoff.
