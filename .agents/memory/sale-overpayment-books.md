---
name: Sale overpayment & one-sided entries
description: How overpaid invoices (amount_paid > total) are posted, who produces them, and how the BS integrity check names one-sided entries.
---

## The failure this solves
A production balance sheet showed "Assets and liabilities differ … with no identifiable cause" while dev was clean. Cause: 11 invoices with `amount_paid > total_amount`. The derived sale entry clamped the negative "due" leg away (`if (due > 0.004)` only), so each such sale posted more debit than credit — the ONLY silent way to gap the BS (missing/unclassified ledgers, OB imbalance, overlay drift all have named issues).

**Why:** the posting builder's `push()` silently drops legs with ledgerId 0/NULL or amounts ≤ 0.004; a clamped-away leg looks identical. Integrity checks must enumerate the clamps, not just the refs.

## Rules
- Overpayment = customer advance = Cr `CUST-<id>` — single-ledger model since Aug 2026, no CADV anywhere. `advanceAvailable()` is ledger-based (max(0, −net CUST)), so the credit is automatically adjustable against future invoices. Under the gross debtor model (Aug 2026) a provisioned customer's overpayment emerges NATURALLY as the credit remainder of per-payment legs exceeding the invoice Dr — the explicit "Overpayment held" leg exists only on the walk-in/missing-ledger net fallback path (there it still lands on `SYS-DEBTORS`).
- The derivation is READ-ONLY: it never provisions ledgers. CUST- ledgers exist with the customer (create path + orphan sweep), so no overpayment sweep is needed anymore.
- **Producers of overpayment:** legacy imports, and the sale EDIT path — it re-derives `amount_paid` from `sale_payments` with no floor, so lowering a bill below what was collected overpays it. Collections/allocations are capped at outstanding and cannot.
- Cutoff safety: gross-path sales measure the "extra" counter-money slice against the ALL-TIME sale_payments sum, so entries balance at every cutoff without backdating later collections. The net fallback path still uses CURRENT `amount_paid` with the old as-of "extra" leg. Any new leg must preserve entry balance at every `toDate`.
- buildBooks now names internally-unbalanced entries (per-entryId net over the location-unfiltered stream) before the "no identifiable cause" fallback.
- The old "advance split across CUST and CADV" nuance dissolved with the fold: credit notes, overpayments and parked receipts all land on the same CUST ledger and are all consumable as advance — the owner's explicit intent.

## How to apply
When an integrity gap appears ONLY in production: dev-vs-prod divergence is DATA, not code. Query the prod replica read-only (`executeSql({ environment: "production" })`) for stored-figure contradictions per document type (paid > total, payments-sum ≠ amount_paid, NULL ledger refs, unbalanced JV line sums) — the gap usually equals the sum of one clamp class exactly.
