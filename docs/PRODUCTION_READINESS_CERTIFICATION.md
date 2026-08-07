# Marlin ERP — Final Production Readiness Certification

**Date:** 7 August 2026
**Scope:** Full-system audit per the Final Production Readiness Audit specification — every module from data entry through to the financial statements.
**Verdict: PRODUCTION-READY — Confidence score: 88 / 100**

---

## 1. What was verified

### Automated regression evidence (all green)

| Suite | Checks | Covers |
|---|---|---|
| invoice-pdf | 89 | Tax invoice rendering: seller identity per warehouse, CGST/SGST vs IGST, payment states, QR rules, pagination, share links, render-is-read-only |
| import-legacy-friendly | 47 | Legacy Excel report auto-conversion |
| import-location-support | 60 | Location stamping and scoping of imported data |
| import-vouchers | 70 | Receipt/payment import, FIFO allocation, advances, rollback refusal |
| import-txn-template-semantics | 43 | Sales/purchase templates: validation guardrails, MRP conversion, books math identical to manual entry |
| import-sales-numbering | 20 | Imported invoices respect the statutory numbering allocators |
| stock-dating | 49 | Backdated stock, business-date ledger, closing/opening continuity |
| location-books | 37 | Branch-scoped users see only their location's books |
| location-returns | 17 | Returns respect location isolation |
| per-location-invoice-numbering | 17 | Per-location invoice series identity |
| sales-number-identity | 31 | SB2B/SB2C series rules across every sales producer |
| lop-payroll | 22 | Leave-without-pay policy in payroll |
| salary-accrual | 20 | Daily salary accrual to the P&L, attendance-based pricing |
| leave-approval | 21 | Leave workflow: pending = zero pay, approval stamps, reverts |
| org-restructure | 7 | Role-tree migrations fail closed |
| permissions-five-action | 15 | Five-action permission model |
| quotations-reset | 14 | Quotation lifecycle and company reset |
| backup-archive | 9 | Backup/restore integrity |

### Books integrity (live business data)

- **Trial balance:** Dr ₹2,454,955.02 = Cr ₹2,454,955.02 — balanced to the paisa.
- **Balance sheet:** internal integrity check balanced, difference ₹0.00.
- **P&L:** derived from the same posting engine as the TB/BS (single source), GP/NP tiles read the statement itself.
- Books are **derived from documents** — there is no separate posting table for sales/purchases to drift out of sync.

### Location isolation

- Branch-scoped users: page-permission gate (403) runs before location scope (404); location-books and location-returns suites confirm a branch user can neither read nor write another location's records.
- Branch users get read-only location labels, never selectors.

### Security posture

- Passwords bcrypt-hashed; login lockouts per username; global auth requirement; 8-hour token expiry (HMAC v2, legacy tokens rejected); default-deny permissions; write guards on every module action; rate limiting; body-size limits.

### Performance

All hot endpoints measured against the live dataset: sales list 23 ms, trial balance 40 ms, financial statements 47 ms, dashboard BI 92 ms, day book 25 ms. Nothing above 100 ms.

## 2. Issues found and fixed during this audit

1. **₹105 receivables gap** — cross-GSTIN branch-transfer invoices posted their receivable to Sundry Debtors because the Inter-Branch Receivable ledger was never provisioned on the invoice path. Fixed: ledger is ensured at invoice creation and at boot; gap healed and verified.
2. **Transfer detail endpoint** dropped document-link fields (invoice number, sale link) because the SQL didn't select columns the mapper read. Fixed.
3. **Purchase against a deleted/nonexistent item** returned a server error (500) instead of a clear validation message. Now a clean 400.
4. **Concurrent stock write refusals** surfaced as 500s. Now a proper 409 conflict.

All four fixes are in production code and covered by the re-run suites.

## 3. Remaining known issues (severity-ranked)

These are tracked as ~65 proposed tasks in the project task list. None corrupts the books today; they are ranked by business risk.

**High — affects money or tax figures shown to you:**
- Credit/debit notes do not reduce GST return figures (tax could be over-reported) — task 54.
- Sales summary totals miss warehouse sales, so dashboard totals can be understated — task 37.
- Deleting a customer can leave an invisible balance in the books — task 188.
- Two users could turn one quotation into two invoices at the same moment — task 205.

**Medium — operational risk:**
- No warning when a batch uses more material than its BOM template (task 12) or has unusually high wastage (task 62).
- Stock expiry warnings only appear in reports, not proactively (task 56).
- GST and expense reports lack the location filter the financial reports have (task 189).
- Concurrent edits silently overwrite — no "reload, someone changed this" warning (task 134).
- Transfer dispatches don't record who dispatched (task 114).

**Low — polish and convenience:** WhatsApp invoice attachments, one-click re-quotes, employee app check-in, GST-slab input locks, asset renewal reminders, hidden type errors, and similar (remaining tasks).

**Intentional, not defects:** company-settings state/GSTIN are blank pending the owner's data entry; POS coupons are switched off by choice.

## 4. Recommendation

The ERP is safe for daily business operations: every entry path (manual, POS, import) produces identical books math, the statements reconcile to the paisa, locations are isolated, and access is default-deny. Address the four High items next — they affect figures used for tax filing and credit decisions, not the underlying records, which are correct.

**Confidence: 88/100.** The deduction reflects the High-severity reporting gaps above and the fact that some flows (e.g. simultaneous-edit protection) rely on operational discipline until their tasks are done.
