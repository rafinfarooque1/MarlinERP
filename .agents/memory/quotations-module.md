---
name: Quotations module
description: Why quotations never touch the books, how one-sale-per-quote is enforced, and settled behavior decisions.
---

# Quotations module

Quotations are a **parallel document store**: their zero impact on stock/books/GST is by construction (own table, own sequence), so isolation is verified by grepping the quotations router for foreign-table writes — not by reconciliation.

## One sale per quotation
Belt-and-braces on purpose: partial unique indexes on BOTH sides of the link, plus a `FOR UPDATE` lock on the quotation at the start of the sale-create transaction.
**Why:** the client-side prefill (sessionStorage + URL marker) is convenience only; two tabs can both reach the submit button, so the server must decide under the lock. Stamping both directions inside the sale txn keeps traceability atomic.
**How to apply:** any future "convert X into Y exactly once" flow needs all three layers, and the conversion must re-check the source row's LBAC scope *inside the transaction* — the sale's own location check does not cover the quotation's location, and skipping it lets a scoped user consume an out-of-scope quotation by guessing its id (completion review caught exactly this). Out-of-scope reads as not-found, never 403.

## Settled decisions
- Quote MRP is editable, but only UPWARD (owner spec Aug 2026): line price ≥ item master MRP, same shared floor rule as sales with grandfathering on edit; the raise lives on the quotation alone (each line stores the master MRP as of save time for audit; activity log records overrides). The Item Master is never written from quotations. Conversion carries the raised price into the sale via the normal prefill — no special-casing.
- The quotation line JSON is described by the shared sale-line schema in the OpenAPI spec — any new stored line field must be added there and regenerated, or generated clients silently strip it from responses.
- Quote-time stock is informational only; the Sales form's oversell clamp still applies at conversion — a "Qty (max 0)" block there means the location genuinely has no stock, not a bug. The pre-conversion warning warns, never blocks, and the prefilled form stays fully editable (including location).
- Auto-expiry sweeps only draft/sent past valid-till; accepted quotes never auto-expire. Bell feed = expired within the last 14 days.
- On convert, honour the quote's stored bill discount while the coupon code is unchanged, even if the coupon has since expired (same rule as sale edit).

## Traps
- Item "inactive" is `items.status` owned by `blockedByInactiveProducts()` — there is no `is_active` column; hand-rolled checks 500.
- Explicit JSX type arguments (`<Comp<T> …>`) pass tsc but break the Vite build — the cartographer babel plugin injects attributes between tag and generic. Rely on inference in JSX.
- Generated PDFs embed a subsetted font, so grepping raw PDF bytes for ASCII always fails — use `pdftotext` (in the runtime PATH) to verify PDF content.
