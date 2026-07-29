# Dynamic UPI QR on Sales Invoices — Validation Report

Scope: the brief "Implement dynamic UPI QR payment on POS / sales invoices".
This report answers the brief's closing requirement: confirm that one
authoritative outstanding figure drives every surface, and that no duplicate
payment or accounting logic was introduced.

## 1. One definition of what a customer owes

There is exactly one definition, and it lives in one module —
`artifacts/api-server/src/lib/salePaymentPosition.ts`:

```
Outstanding = Invoice Total − Amount Received − Credit Adjustments   (clamped at 0)
```

* Clamped at zero: an over-collection never produces a negative request. The
  excess is reported separately as `overpaid` so it stays visible instead of
  being silently absorbed.
* A **cancelled** invoice owes nothing: status `cancelled`, outstanding `0`, no
  QR, no bank details.
* Status is **derived** from the money, never read from the stored payment mode.
  `credit` is a payment *arrangement*, not a payment *state* — a credit invoice
  that has been paid reads PAID, and a cash invoice with nothing received reads
  UNPAID.
* Status thresholds compare against the invoice total, so an invoice reduced
  only by a credit note correctly reads PARTIALLY PAID.

The module exports both the in-process calculation (`computePaymentPosition`)
and the SQL fragments (`creditAdjustmentsExpr`, `amountDueExpr`,
`outstandingExpr`) so list endpoints compute the *same* figure in the database
without a second implementation of the rule.

## 2. Every surface reads that one figure

| Surface | Reads from |
| --- | --- |
| Invoice list | `outstandingExpr` in SQL |
| Invoice detail, create, edit | `loadPaymentPosition` |
| Collect Payment cap | `loadPaymentPosition` on the **row locked inside the transaction** |
| Invoice PDF (authenticated + public + share link) | `loadPaymentPosition` |
| WhatsApp / share message | position fields returned by the API |
| Customer outstanding, receivables, collections | `outstandingExpr` |
| Dashboard receivables | `outstandingExpr` |

Verified live: dashboard, receivables and the invoice list all reported the same
₹9,911.00, and the sales register agreed invoice by invoice.

## 3. No duplicated payment or accounting logic

* **No new accounting code.** `journal.ts` was not touched by this work. The books still
  derive from documents; credit notes already post their own voucher.
* **The old local status helper in `routes/payments.ts` was deleted**, not left
  alongside the new one — the payment route now derives status from the shared
  module. This removed a second, divergent rule rather than adding one.
* **Generating or rendering a QR writes nothing.** A QR is a rendering of an
  existing balance. Verified: repeated invoice views and PDF renders left the
  trial balance byte-identical.
* **Only credit notes reduce what is owed.** A walk-in cash refund lowers the
  receipt and the receivable together and nets to zero, so it must not be
  subtracted again — doing so would forgive money twice.

Two credit-note allocation levels exist deliberately:

* *Per invoice* nets only credit notes raised by a sales return **against that
  invoice**.
* *Per customer* additionally nets **unallocated** credit notes (no owning
  return).

This was confirmed live: customer 3's outstanding is ₹200 below the sum of their
invoices because `CN/2026-27/0001` is a manual ₹200 credit note with no owning
return.

The customer ledger statement's `balance_due` stays **gross** on purpose (a
comment in the code pins this): a statement shows the invoice as raised and the
credit note as its own line, so netting it there would double-count the credit.

## 4. The brief's regression tests

| # | Test | Result |
| --- | --- | --- |
| 1 | Unpaid invoice → QR asks the full total | PASS |
| 2 | Part payment → QR asks only the remainder | PASS |
| 3 | QR never requests more than outstanding (cap) | PASS — over-cap payment refused, nothing written |
| 4 | Credit-note return reduces the amount due and the QR | PASS — invoice total untouched |
| 5 | Full settlement → PAID, QR replaced by a receipt block | PASS |
| 6 | A settled invoice accepts no further payment | PASS |
| 7 | Cancelled invoice → no QR, no bank details, owes nothing | PASS |
| 8 | UPI unconfigured → bank details only, no broken QR | PASS |
| 9 | Viewing/printing/sharing creates no accounting entry | PASS — trial balance unchanged |
| 10 | One figure across invoice, PDF, WhatsApp, share link, customer outstanding | PASS |

Test evidence:

* **27 pure-logic checks** — status derivation, clamping, overpaid reporting,
  2-decimal rounding, sub-paisa settlement, and every QR gate branch.
* **40 API checks in one consolidated suite, all passing** — covering the
  read-only cases (cancelled, counter-settled, part-paid, settings on/off,
  cross-surface parity of invoices / receivables / dashboard / both sales
  reports) and a full end-to-end write run: a real invoice taken through unpaid
  → part payment in cash → credit-note return → full settlement, with the
  shared PDF re-rendered at each state and confirmed to drop the QR once
  settled, and both sales reports confirmed to fall by exactly the credit note.
* All test data was reversed afterwards; a full database fingerprint (row
  counts, sequence high-water marks, stock, costs, customer aggregates and
  per-ledger Dr/Cr sums) is **identical** to the pre-test capture.
* The two UI surfaces were verified in a browser: the invoice panel shows
  Invoice Total / Amount Received / Balance Due with the QR carrying the
  outstanding figure, and a settled invoice shows the receipt block with no QR.

## 5. Configuration, not hard-coding

QR content comes from company payment settings. Resolution order for the UPI ID
is **selling location first, then company** — identical at all three call sites.
The payee name is the company's configured payee name, falling back to the
location name.

Three switches govern the printed output (Accept UPI payments, Print the UPI QR
on invoices, Print bank details on invoices). All three **default to on**, so
existing invoices print exactly what they printed before this change.

The UPI ID is validated as a VPA on both sides — inline in the form on save, and
independently by the server with a 400.

## 6. Findings worth the owner's attention

**Fixed in passing** (each one made the "one figure" guarantee false):

0. Two sales reports (*Sales by Location* and the combined *Sales & Stock*
   report) computed outstanding as `total − paid` in SQL of their own, so a
   credit note never reduced the figure they showed. They now sum the shared
   per-invoice expression. Verified live: raising a credit note drops both
   reports by exactly the credit-note amount.
1. A second Collect Payment page (`pages/headoffice/Payments.tsx`) recomputed the
   balance in the browser as `total − paid` — a rule that disagreed with the
   invoice whenever a credit note existed — and offered a Collect button on
   cancelled invoices. **This page is not currently routed**, so no user could
   reach it; it was corrected rather than left as a trap for whoever wires it up.
   It now renders the server's figures, shows credit notes as their own line, and
   treats cancelled as terminal. The live collection flow is the POS page at
   `/sales/pos`, which was built against the shared figures from the start.
   The payment endpoint now also returns the position it just computed
   (`newBalanceDue`, `newCreditAdjustments`) so no caller has a reason to
   recompute a balance after collecting.

1. Several outstanding queries never excluded **cancelled** invoices — the
   customers list, receivables and collections all counted money that had been
   cancelled.
2. The dashboard filtered on the **stored** `payment_status` column rather than
   the derived position, so it disagreed with the invoice list.
3. Collecting **cash** at a warehouse that mirrors an outlet failed outright
   ("Cash ledger (WH-CASH-3) not found"). Mirror locations share one till, and
   its ledger code can only name one of the pair. The payment route now resolves
   the location's own `cash_ledger_id` first and falls back to the code — the
   same order the cash-balance read path already used. Without this, the QR
   feature's whole point (customer pays, you record it) was unavailable in cash
   at those locations.

**Data observation, not changed by this work:** invoice `TST/2025-26/0008`
(₹6,352.50) stores `payment_status = 'paid'` with `amount_paid = 0`, no payment
rows and no receipt in the books. The derived answer — UNPAID, ₹6,352.50 due, QR
shown — agrees with the ledger; the stored flag is the unsupported outlier.
Invoice `TST/2025-26/0001` similarly carries ₹1.00 paid with no receipt row.
Both look like seeded rows inserted without their money side. They are now
reported correctly, but if these are real sales the stored flags should be
corrected at source.

## 7. Interpretation to confirm

The brief's §9 refers to a "Default Bank Account". This was implemented as the
**existing single set of company bank-detail fields** (now extended with account
holder, branch and account type), not as a new foreign key to a chosen ledger in
the chart of accounts. If the intent was to nominate one of several bank ledgers
as the default for collections, that is a separate change.
