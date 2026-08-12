# Marlin ERP — Full Functional Audit, End-to-End Process Map & Accounting Integrity Review

**Date:** 10 August 2026 · **Type:** Read-only investigation (no code changed, no data changed — dev or production)
**Method:** live paisa-level reconciliation of the development books via the API (temporary audit login, since removed), read-only SQL integrity sweeps of BOTH databases (development + production replica), code-path tracing of every question in the audit brief, and cross-checks against the standing system audit.
**Companion document:** `docs/ERP_SYSTEM_AUDIT.md` (kept current through Aug 8, 2026) holds the full architecture, 62-table catalog, module inventory, posting map, permission/location/GST/HR flows, and scores. This report does not repeat it — it verifies it against today's live data and answers the audit brief point by point.

---

## 1. Verdict in one paragraph

The ERP already is the "one consistent accounting system" the brief demands. Every financial statement, report and dashboard money tile reads ONE derived posting stream (`buildDerivedPostings()` → `buildBooks()`); the ledger cannot disagree with the reports because the reports *are* the ledger. Today's live reconciliation proves it to the paisa on real data. One genuine functional gap was found (counter-settled sales write no payment-history rows — books unaffected), one known task was reproduced live in dev data (#188 deleted-customer residue, ₹3,000), production is structurally clean, and a handful of dev-only test residue items were catalogued. The full findings ledger is §5.

## 2. Reconciliation results (spec §31 — live run, Aug 10, 2026, dev API)

| Check | Result | Figures |
|---|---|---|
| Trial Balance Dr = Cr | ✅ exact | 2,442,715.33 = 2,442,715.33, difference 0 (both TB endpoints agree) |
| Balance Sheet: Assets = Liabilities + Equity | ✅ exact | 1,483,945.08 = 1,483,945.08 |
| Receivables ageing = per-customer sum | ✅ exact | 274,066.37 both |
| Receivables ageing vs dashboard tile | ⚠️ ₹3,000 apart — **explained exactly**: dashboard (ledger basis) includes ₹3,000 stranded on SYS-DEBTORS by two deleted customers (ids 158, 161; 4 unpaid invoices). This is the live instance of open task **#188**. Production has ZERO such rows. | 277,066.37 vs 274,066.37 |
| Payables report = dashboard tile | ✅ exact | 694,037 both |
| Cash & Bank screen = TB per ledger | ✅ | 0 mismatches |
| Cash book / bank book closing = TB per ledger (openings folded) | ✅ | prior bug M-1 confirmed FIXED in code and by live figures |
| Inventory valuation report = dashboard tile | ✅ exact | 617,540.30 both (incl. ₹105 legitimately in transit) |
| Day book Dr = Cr | ✅ | totals equal |
| GSTR-1 = raw invoice sums | ✅ exact | GSTR-1 433,377.41 = sales register 433,272.41 + the ₹105 cross-GSTIN branch-transfer invoice (100 taxable + 5 IGST) — correct: transfer invoices ARE supplies |
| Dashboard sales = sales register = raw SQL | ✅ exact | 433,272.41 / 301 invoices in all three (open task **#37** "summary misses warehouse sales" no longer reproduces — likely fixed en route; retest & close) |
| P&L identity | ✅ | GP/NP read from the same `buildBooks` summary; revenue 412,490.16, NP −300,027.72 ties to income − expenses |

## 3. Database integrity sweeps (spec §27 — both databases)

| Invariant | Production | Development |
|---|---|---|
| Unbalanced vouchers (Σdebit ≠ Σcredit) | **0** | **0** |
| Voucher lines pointing to deleted ledgers | **0** | **0** |
| Orphan / duplicate CUST- / VEND- party ledgers | **0** | **0** |
| Orphan sale-source (trail) receipts | **0** | 5 rows, ₹250 — test residue referencing FY 2023-24 fixture invoices (D-2 below) |
| Deleted customers with unpaid invoices | **0** | 4 invoices, ₹3,000 (task #188 live instance, D-1) |
| Cancelled sales still holding money | **0** | 35 rows, ₹6,682.53 — pre-guard-era + test fixtures (D-3) |
| Ghost BTR/ transfer invoices | **0** | **0** |
| Duplicate invoice numbers | **0** | 2 pairs — each pair = one real warehouse invoice + one CANCELLED head-office test fixture; per-location numbering makes this legal by design (same printed number may exist at two locations; unique per location) |
| Walk-in customer masters | **1** ("WALKING CUSTOMER") | **1** — no duplicates anywhere (spec §22 satisfied; the walk-in *receipt-voucher advances* issue is separate — see cancelled tasks note in §7) |
| Sales `amount_paid` ≠ Σ payment legs | **45 rows, ₹51,300.04** | 45 rows, ₹21,230.04 — **finding F-1 below** |

## 4. Audit-brief questions answered (spec §§8–24, code-verified with line evidence)

| Brief section | Verdict |
|---|---|
| §3/§4 One authoritative accounting flow; ledger = source of truth | ✅ by construction. All postings derive from documents through `buildDerivedPostings()` (routes/journal.ts); every statement through `buildBooks()`. A report cannot be right while the ledger is wrong — they are the same stream. Opening balances folded in by the same layer. |
| §5 CoA ↔ TB ↔ BS ↔ P&L ↔ balances consistency | ✅ verified live (§2). Statements signed to natural side; openings need the STD-OB-ADJ counterweight (documented). |
| §6/§7 Customer/vendor ledger completeness | ✅ sales, receipts, advances, returns, notes, JVs, openings all post to the party ledger (GROSS model on provisioned customers). Verified per-customer sum = ageing = ledger. |
| §8 Advance handling | ✅ matches the brief's requirement exactly: NO separate "Customer Advances" liability — a customer overpayment is simply a credit (negative) balance on their single Sundry Debtor ledger (the CADV classification was deliberately folded away Aug 2026). Vendor advances park on VADV- asset ledgers. Excess on an allocation receipt is parked and auto-applied to the next invoice; every consumption is pinned to its parking voucher. Aug 9 deep-dive verified paisa-exact behaviour on production data. |
| §9 Sales trace incl. payment modes | ✅ full trace in system audit §5–6. Credit sales never post as cash (only settled legs / counter money reach cash ledgers); cash/bank/UPI route to the location's assigned ledgers via one resolver. |
| §10 Purchase edit safety | ✅ edits pair lines by kind:id:batch and touch only changed stock; refused once goods consumed/moved (floor-at-zero would invent stock); settled floor re-checked under the row lock. MFG/expiry are optional at entry. |
| §11 Sales-return rate | ✅ **uses the original sale line**, never current MRP: refund = stored line taxable/discount/tax prorated by qty fraction (routes/returns.ts:306-314); caps at sold − previously returned; restores stock at original batch cost; posts at the sale's location. |
| §12 Purchase-return rate | ✅ same pattern — original purchase line `unitCost`/taxable/tax prorated (returns.ts:1242-1261); never the item master rate. |
| §13 GST logic same-state/inter-state | ✅ ONE path (`lineTaxHeads()` + `isInterStateSupply`, code-first with alias folding) shared by sales, POS, quotations, purchases, both returns, invoices, GST reports. CGST/SGST = half + exact paise remainder. POS *is* the sales engine (same route). |
| §14 GSTIN persistence | ✅ create/edit/reload/invoice/reports verified by `party-gst.test.mjs`; the historical list-casing wipe bug is fixed; blank = NULL; stored typos grandfathered. |
| §15 B2B/B2C serials | ✅ open-month conversion on GSTIN add, compacts ONLY conversion-opened gaps, pair-renames receipts/quotations, audits per invoice; locked months untouched (`b2c-b2b-conversion.test.mjs`, 24 checks). |
| §16 Month closing | ✅ admin-only lock/unlock with logged events + reason; ONE shared 423 guard covers every producer (sales→payroll→imports). Deliberately open: open-month payments against locked-month credit sales, quotations, masters. |
| §17 Multi-location accounting | ✅ every transaction location-stamped; HO is a normal location (placeholder id differs per table — matched on TYPE); branch users pinned (read-only labels, no dropdowns); body location is a request, never authority; consolidated = sum of locations by construction (one stream, location = an attribute). Covered by `location-books` suite. |
| §18 Warehouse delete/off | ✅ full lifecycle shipped Aug 2026: disable (reversible, all producers 409), permanent delete = typed-phrase + advisory-locked cascade with in-transaction validation (TB re-balanced or full rollback); cross-location entanglements are hard blockers. |
| §19 Voucher audit | ✅ verified into ledger/day book/cash-bank books/TB live (§2). |
| §20 Payroll | ✅ attendance-driven — no salary from mere existence: zero-attendance months in the attendance era pay ZERO; accrual/payroll clamp to last working date; pending leave = zero pay until approval. |
| §21 POS | ✅ same engine as sales (one route); Add-Charge shipped Aug 9 (charges post to their expense ledgers; no GST; returns never refund them — policy documented). |
| §22 Walk-in | ✅ single master both DBs. |
| §23/§24 Import/migration | ✅ mapping-first name resolution, existing-ledger reuse, validate→preview→map→errors→confirm→commit→one-txn rollback; commits reuse the manual-creation libs; legacy Excel auto-conversion; located compare pack for post-import reconciliation. |
| §26 Edit/delete/reverse | ✅ per-document rules in system audit §13; edits reverse-and-reapply inside one transaction; deletes sweep ledger effects; terminal states enforced after row locks. |
| §32 Reports read the ledger, not documents | ✅ for all accounting reports. Deliberate exception: dashboard *sales/purchases activity* KPIs are document sums (gross incl. GST) — activity metrics, not books figures; the money tiles (cash, bank, receivables, payables, expenses, GP/NP) read the ledger stream. See §6. |

## 5. Findings (spec §§P–X)

### F-1 · Counter-settled sales write no payment-history legs — the only new functional defect (Medium)
Cash/UPI/bank sales settled at the counter set `amount_paid = total` but insert NO `sale_payments` row (routes/sales.ts:1049-1083 — only applied advances get a leg). Verified live: 9/9 cash sales created in production Aug 6–10 (₹38,150) have zero legs, while credit-sale collections all have theirs. 36 imported cash sales (₹13,150.04) share the gap.
- **Books are NOT affected**: the posting derivation computes `amount_paid − Σ legs` and posts the missing counter-money slice anyway (journal.ts:1330-1345). TB/cash book/statements stay exact — confirmed by §2.
- **What breaks:** the sale's payment-history tab is blank; the reconciliation module (which matches `sale_payments` rows) cannot see counter-settled UPI/bank collections; method-level views lean on the sale's `payment_mode` column instead of real settlement rows. The one-shot Aug 5 backfill (`salePaymentLegsBackfill`) fixed exactly this for OLD rows — the producer gap re-opened it for every new counter sale, so history rows exist for pre-Aug-5 cash sales but not newer ones (inconsistent by date).
- **Fix plan:** write the settlement leg inside the sale-create transaction for settled modes (mirror of the backfill's row); make the import sale path do the same for paid amounts; re-run the backfill logic once for the rows created since (guard on a new marker); regression: extend `pos-other-charges`/`sales-pricing` suite with a "counter sale ⇒ exactly one settlement leg; Σ legs = amount_paid" assertion.

### D-1 · Dev data: task #188 live instance (dev-only; High-priority task already in backlog)
Customers 158 & 161 were deleted leaving 4 unpaid invoices (₹3,000) attributable to no one — the exact ₹3,000 by which the dev dashboard receivables tile exceeds the ageing report. Production: zero. Fix = task #188 (block deletion with open balance / reassign residue).

### D-2 / D-3 · Dev data: test residue (Low, dev-only)
5 orphan trail receipts (₹250, FY 2023-24 fixture invoices), 35 cancelled sales holding `amount_paid` (₹6,682.53, pre-guard era + fixtures), 2 duplicate invoice pairs (real vs cancelled HO fixture — legal under per-location numbering). None exist in production. Worth a one-time dev sweep only if the noise bothers reports.

### Stale task worth closing
**#37** (sales summary misses warehouse sales): dashboard = register = raw SQL exactly today (433,272.41 / 301). Retest and close.

## 6. Duplicate-calculation register (spec §28)
Places that compute money figures outside the authoritative stream, with risk assessment:

| Place | What it does | Risk |
|---|---|---|
| Dashboard sales/purchases/BI charts (dashboard.ts:164-180, 329-656) | Document sums (gross, incl. GST) | **Accepted design** — activity KPIs, not books figures; documented. Don't "fix" into the ledger or the tiles will stop matching invoices users count. |
| Client-side list footers (headoffice/Sales.tsx:1425, Payments.tsx:367, Stock.tsx:122, CashBank.tsx:154, SalesDashboard.tsx:232) | Sum the loaded rows | Display totals of the visible list — correct as list footers; they must never be presented as company totals. No change needed while lists stay un-paginated (opt-in paging discipline). |
| CSV/PDF export (lib/download.ts:235-237) | Re-sums line CGST/SGST/IGST | Matches stored lines today; keep in lockstep with `lineTaxHeads` (add a fixture assert if it drifts). |
| GST summary/returns screens (GstSummary.tsx, GstReturns.tsx) | Client-sums API rows | Rows come whole from the server; footer-only risk. |
| financialReports.ts:332-380 GST report | Ledger-based GST totals | Intentional — it IS the ledger-vs-register reconciliation view. |

Authoritative sources confirmed wired everywhere else: outstanding = `salePaymentPosition` builders; party balances = ledger index; valuation = `stockValuationRows`; GP/NP = `buildBooks` summary.

## 7. Regression test plan (spec §Z) & backlog map
- 40+ standing suites in `artifacts/api-server/tests/` already cover create/edit/delete/reverse per module (spec §29's matrix), location isolation (§30), period locks, B2B/B2C, advances, MRP floor, per-location numbering. Add: the F-1 settlement-leg assertion (above); a "deleted customer leaves no balance" test when #188 lands.
- The curated task backlog (65 open tasks) already tracks the known improvement areas the brief probes: #54 (notes must reduce GST returns — the one open ACCOUNTING-correctness gap, High), #188, #14 (GST slab lock), #134 (concurrent-edit reload), #190 (stale suites), etc. Three tasks from the Aug 9 receipt investigation (over-entry warning, system-row badge, Walking-Customer voucher review) were cancelled by the owner on Aug 10 — the underlying observations remain in `docs/` and memory should they be revived.
- Recommended order: **F-1 → #54 → #188 → #14**, then the Medium backlog.
