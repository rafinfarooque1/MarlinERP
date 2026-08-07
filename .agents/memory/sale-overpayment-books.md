---
name: Sale overpayment & one-sided entries
description: How overpaid invoices (amount_paid > total) are posted, who produces them, and how the BS integrity check names one-sided entries.
---

## The failure this solves
A production balance sheet showed "Assets and liabilities differ … with no identifiable cause" while dev was clean. Cause: 11 invoices with `amount_paid > total_amount`. The derived sale entry clamped the negative "due" leg away (`if (due > 0.004)` only), so each such sale posted more debit than credit — the ONLY silent way to gap the BS (missing/unclassified ledgers, OB imbalance, overlay drift all have named issues).

**Why:** the posting builder's `push()` silently drops legs with ledgerId 0/NULL or amounts ≤ 0.004; a clamped-away leg looks identical. Integrity checks must enumerate the clamps, not just the refs.

## Rules
- Overpayment = customer advance. The sale entry posts the excess as Cr `CADV-<id>` → fallback Cr `CUST-<id>` → `SYS-DEBTORS` ("Overpayment held"). `advanceAvailable()` is ledger-based, so the credit is automatically adjustable against future invoices.
- The derivation is READ-ONLY: it can never provision CADV ledgers. Producers must: the sale-edit path provisions at write time; a boot sweep (idempotent, every boot, next to the CUST/VEND backfill in index.ts) heals imported/legacy rows.
- **Producers of overpayment:** legacy imports, and the sale EDIT path — it re-derives `amount_paid` from `sale_payments` with no floor, so lowering a bill below what was collected overpays it. Collections/allocations are capped at outstanding and cannot.
- Cutoff safety: sale entries use CURRENT `amount_paid`; the "extra" leg (amount_paid − as-of sale_payments, dated sale_date) absorbs collections a toDate excludes, so entries balance at every cutoff. Any new leg must preserve this: derive it from the same current-state figures.
- buildBooks now names internally-unbalanced entries (per-entryId net over the location-unfiltered stream) before the "no identifiable cause" fallback.
- Known, deliberate nuance: a credit note on a fully paid invoice credits CUST (via the note JV), not CADV — so an economic advance can sit split across CUST and CADV. Pre-existing returns design; books balance; do not "unify" casually.

## How to apply
When an integrity gap appears ONLY in production: dev-vs-prod divergence is DATA, not code. Query the prod replica read-only (`executeSql({ environment: "production" })`) for stored-figure contradictions per document type (paid > total, payments-sum ≠ amount_paid, NULL ledger refs, unbalanced JV line sums) — the gap usually equals the sum of one clamp class exactly.
