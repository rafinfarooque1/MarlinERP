# Marlin Frozen Fruits ERP — Complete System Audit

**Date:** 1 August 2026 · **Type:** Read-only discovery & documentation (no code or data modified)
**Scope:** `artifacts/api-server` (Express 5 API), `artifacts/marlin-erp` (React web), `artifacts/employee-app` (Expo mobile), `lib/*` shared packages, development database.

---

## 1. ERP Architecture

```
┌────────────────────┐   ┌─────────────────────┐   ┌──────────────────────┐
│  marlin-erp (web)  │   │ employee-app (Expo) │   │  Public links (no    │
│  React + Vite      │   │ attendance/leaves/  │   │  login): invoice PDF │
│  wouter + react-   │   │ payslips            │   │  share links (HMAC)  │
│  query + Tailwind  │   └──────────┬──────────┘   └──────────┬───────────┘
└─────────┬──────────┘              │                         │
          │      lib/api-client-react (generated hooks + Zod) │
          ▼                         ▼                         ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                    api-server — Express 5 (esbuild bundle)               │
│  pino logging → CORS → body parse (1 MB) → requireAuth (global, HMAC v2  │
│  bearer tokens, 8 h) → per-route RBAC (requireModuleView/Action) → LBAC  │
│  (dataScope / moneyScope) → route logic → global JSON error handler      │
│                                                                          │
│  routes/ (33 routers, ~266 endpoints)   services/ (PDF: jsPDF w/ Unicode │
│  font)   lib/ (books, gst, batches, valuation, dataScope, audit, backup) │
│  migrations/ (boot-time DDL + data migrations — the ONLY DDL channel)    │
└──────────┬──────────────────────────────────────────┬────────────────────┘
           ▼                                          ▼
   PostgreSQL (63 tables)                    Google Cloud Storage
   Drizzle schema (partial) + raw            (asset bills/attachments,
   boot-migration columns                    presigned uploads, DB backups)
```

| Concern | Implementation |
|---|---|
| Frontend | React 18 + Vite, `wouter` router, TanStack Query, Tailwind + Radix, Recharts |
| Mobile | Expo (login, attendance punch, leaves, payslips) |
| Backend | Express 5 + TypeScript, esbuild CJS bundle, raw `pg` for most queries |
| Database | PostgreSQL; Drizzle ORM schema is a *partial* view — many columns/tables ship via boot migrations (never run `drizzle-kit push`) |
| Auth | `POST /auth/login` → HMAC-SHA256 signed `v2.<payload>.<sig>` bearer token (8 h expiry); global `requireAuth` except `/health`, `/auth/login`, `/public/*`; `mustChangePassword` forced flow; bcryptjs hashes; login rate limiting |
| API architecture | OpenAPI spec (`lib/api-spec`) → Orval codegen → `lib/api-client-react` hooks; the spec **gates writes** (fields absent from spec are stripped) |
| File storage | GCS via `lib/objectStorage.ts`; presigned PUT uploads; attachment ACL = uploader or record visibility, 404 (not 403) |
| PDF generation | Server-side only (`services/*Pdf.ts`, jsPDF + embedded TrueType for ₹); invoices, challans, payslips, reports |
| Notifications | WhatsApp share via `wa.me` composed-message links (channel seam in `invoiceShare.ts`) |
| Permissions | Per-page rows (`page:<href>`), five actions, default-deny, level-1 bypass (§9) |
| Audit logging | `activity_log` via `logActivity` after successful mutations; `login_attempts` for auth history; `boot_status` records every boot's migration outcomes |
| Backup/Restore | `routes/backup.ts`; pg_dump-based, GCS-stored; restore = HO + approve right + password re-verification; dumps exclude via `--exclude-schema` |

## 2. Module List (complete)

**Standalone:** Dashboard · My Profile
**Operations:** Point of Sale (`/sales/pos` — Head Office is a full selling location since Aug 2026: HO card in the location picker, sales stamped `headoffice`/1, books derive to STD-CASH/STD-SALES, invoice numbering unchanged) · Stock (branch) · Stock Transfer · Cash Balance · Customers · Receipt Voucher (`/operations/receipt-voucher`) · Payment Voucher (`/operations/payment-voucher`) — full-page surfaces over the SAME receipts/payments engine as Accounts › Vouchers (same REC-/PAT- numbering, postings, provenance locks); own page keys; kind-bound PDF print via `POST /pdf/money-voucher`. Payment mode & attachment REMOVED from money vouchers (Aug 2026): columns kept for legacy rows, writes silently ignore the fields, no read surface (list/PDF/CSV/delete-audit) exposes them. Branch users: sole own-till cash account auto-selected. · **Dispatch board** (`/operations/dispatch`, `routes/dispatch.ts`, Aug 2026 task #295) — fulfillment status layer over sales: PENDING → READY → DISPATCHED forward-only with who/when stamps in the additive `sale_dispatch_status` table (absence of row = PENDING; FK ON DELETE CASCADE). Zero books/stock impact by construction. Queue = last 30 days (or explicit from/to), cancelled sales drop out automatically, branch-transfer invoices excluded, LBAC + location-selector narrowing like GET /sales; transitions take the sale row lock then the status row lock (double-click can't skip a step); foreign/BT sale = 404, cancelled = 409. Page key `page:/operations/dispatch` seeded to pre-existing roles (`dispatch_page_perms_v1`), new roles default-deny. Suite: `tests/dispatch-board.test.mjs` (30, incl. books-unchanged reconciliation). **Voucher polish (Aug 2026, task #291):** deleting ANY voucher (payments, receipts, journal family) is Administrator-only — level-1 gate in `lib/adminGate.ts` applied on top of the page delete right (403 otherwise; UI hides the button via `useIsAdmin`); Employee party legs on manual receipts/payments accept ONLY the employee's `SAL-PAY-`/`SAL-EMP-` ledgers (ADV-EMP refused — payroll-owned; unchanged legacy legs grandfathered on PATCH), employee must be active and belong to the voucher's location (HO on either side = company-wide), enforced server-side on EFFECTIVE values; pickers narrow via `GET /accounts/voucher-employees` (minimal directory, no salary, voucher-page view right); system-generated rows show an explicit "System generated" badge (not just a lock icon) across all voucher lists. Suite: `tests/voucher-polish.test.mjs` (33).
**Stock:** Production batches · Stock (HO) · Inventory Reports · Stock Verification

**Retired surfaces (Aug 2026, task #288 — total hide, `RETIRED_PAGE_HREFS` in `moduleRegistry.ts`):** the standalone Expense module (`/sales/expenses` + the earlier nav-retired `/accounts/expenses`; expenses run through Receipt/Payment vouchers now) · the Stock Ledger page (`/headoffice/stock-ledger`; Live Stock, Item Tracking & Storage Locations cover it) · Outstanding's Collect action + Collections tab (Receipt/Payment vouchers are the only payment flows). No routes remain (typed URLs → standard 404), Permissions matrix hides the dead rows, but the `page:` keys stay registered (backend read guards still name them) and every expense/stock-ledger read endpoint and historical record stays intact.
**Production:** Purchases · Vendors · Item Master · Units · BOM templates · Production Reports
**Inventory (HO):** Warehouses · Outlets · Item Prices
**Assets:** Asset Purchases · Asset Register · Categories · Transfers · Disposal · Reports
**Sales:** Returns · Outstanding (Receivables/Payables aging only — Collect/Collections retired, task #288) · Coupons · (Quotations — **in development**, task #202 in progress)
**HR:** Employees · Attendance (multi-punch) · Payroll · Advances · Leave · Rent Management · Hierarchy
**Accounts:** Chart of Accounts · Ledger Statement · Cash & Bank · Vouchers · Journal · Contra · Credit/Debit Notes · Day Book · Cash Book · Bank Book · Trial Balance · P&L · Balance Sheet · Month/Day Wise statements (full per-period BS+P&L inside Chart of Accounts; `/accounts/periodic-summary` enumerates buckets, each bucket renders via `/accounts/financial-statements`) · GST Summary · GST Returns (GSTR-1/3B/HSN) · Reconciliation · Financial Reports
**Company:** Settings · Company Profile · Permissions · Audit Log · Login History · Backup & Restore · Company Reset · Import Data (`/company/import`) — Excel imports for masters (customers, vendors, items with opening stock, ledgers with opening balances) **and, since Aug 2026, sales & purchase invoices** (task #225): required target-location picker (HO/warehouse/outlet), multi-row invoice grouping (consecutive rows, same invoice+date+party), missing-party resolution step (inline bulk create via the standard party paths → ledgers auto-provisioned, then in-place re-validation), invoice/bill numbers preserved as-supplied (never renumbered, allocator untouched; uniqueness validated in-file and against the DB — sales globally, purchases per-vendor). Commits route through logic identical to POST /sales & /purchases (`api-server/src/lib/importTransactions.ts`): FEFO lot consumption, business-dated stock_ledger, weighted-avg cost, settlement model (cash/UPI/bank settle at creation; credit carries dues, paid-amount becomes a sale_payments collection / payment allocation voucher), GST via `lineTaxHeads()`. Batch rollback is all-or-nothing in one transaction via reversal-equivalent logic (stock restored, avg cost unwound with qty, settlements deleted) and refuses per-document when downstream activity exists (payments, returns, consumed lots, transfer links). **Receipt & payment voucher imports** (task #226, `api-server/src/lib/importVouchers.ts`): one row = one voucher (voucher numbers kept verbatim, blank → sequence allocator), received-in/paid-from column maps to real cash/bank ledgers (blank/"cash" → location cash till, mirror-aware; "bank" → unique STD-BANK leaf; else exact ledger-name match), explicit against-invoice settles only that document while blank refs auto-allocate FIFO oldest-first with a running outstanding shared across the file, excess stays as a credit balance on the customer's own ledger (vendor side parks in VADV), consumable like manual advances, provenance `source='allocation'` (edit-locked, books derive automatically). Preview shows the planned allocation per row; commit recomputes it on locked rows. Rollback unwinds allocations and advances in one transaction and refuses (409, per-voucher reasons) when an advance was already consumed downstream. **Migration Wizard (Aug 2026):** ONE linear multi-file migration (`import_migrations`, display id MIGxxxx) wrapping all transaction modules — upload sales/purchases/receipts/payments/daybook (+ optional opening stock) files together, combined analysis + permanent name-mapping step, a demo run in one never-committed transaction that produces a comparison report pack (Overview/TB/P&L/BS/Cash & Bank/Dues/Stock), then approval that picks the target location LAST (files carry no location; mapping/demo use a provisional HO stamp, approve re-stamps + re-validates at the chosen location) and imports everything in one all-or-nothing transaction (run order opening_stock→purchases→sales→receipts→payments→daybook). Per-batch endpoints refuse migration-owned batches (409; standalone batch list filters them out); rollback is whole-migration only (role level ≤2, reverse run order, blocked → 409 with nothing deleted, post-delete books verification). UI: Company → Import Data "Migration" tab (default wizard), "Masters" tab keeps standalone master imports, History shows migrations with resume/remove.

One unified sidebar for all users (no per-role nav forks); links are permission-filtered.

## 3. Database (69 tables, no triggers, 4 business sequences)

All DDL ships via boot migrations in `api-server/src/index.ts` + `src/migrations/` (logged in `migration_log`/`boot_status`). Business sequences: `purchase_batch_seq`, `item_code_seq_item`, `item_code_seq_material`, `item_code_seq_raw_material`. Voucher/invoice numbering uses `voucher_sequences` (PK `voucher_type, fy_label`) — never COUNT(*).

| Category | Tables |
|---|---|
| **Master** | items, materials, raw_materials, customers, vendors, employees, warehouses, outlets, account_ledgers, asset_categories, assets, hierarchies, cash_bank_accounts, bom_templates, item_prices, coupons, pay_components |
| **Transactional** | sales, sale_payments, sales_returns, purchases, purchase_returns, productions, stock_transfers, stock_entries, stock_batches, stock_reservations, journal_vouchers, journal_voucher_lines, receipts, payments, expenses, cash_deposits, reconciliation_batches(+items), asset_purchases, asset_transfers, asset_disposals, attendance, attendance_punches, leaves, payroll, employee_advances, salary_accruals, rent_accruals, rent_periods, rent_payments, opening_balances, invoice_share_links, quotations, quotation_share_links, stock_verifications, sale_dispatch_status |
| **Configuration** | company_settings (47 cols), permissions, voucher_sequences, salary_accrual_config, warehouse_rent_agreements, location_migration_map |
| **Audit / infra** | activity_log, login_attempts, login_lockouts, stock_ledger (append-only), migration_log, boot_status, import_batches, import_rows (Import Data module: batch/row state, per-row raw+normalized payloads, created-record links for rollback) |

Key relationships & constraints:
- Declared FKs are sparse (25) and concentrated on document→master links (sales_returns→sales, purchases→vendors, permissions→hierarchies…). Many links are **conventional** (ledger codes `CUST-<id>`/`VEND-<id>`/`SAL-EMP-<id>`, `location_type`+`location_id` pairs) — enforced by application logic and boot-time healing sweeps, not the database.
- `stock_entries` / `stock_batches` / `stock_ledger` are polymorphic by `material_type` (item|material|raw_material) with **overlapping ids** — every query must scope `material_type` (CHECK-constrained).
- Notable CHECKs: non-negative stock (`quantity >= -0.001`), reservation kind/status, payment modes, price_mode, disposal types.
- Heavily indexed hot tables: sales (15 indexes incl. unique invoice number + GIN on line_items), stock_batches (8, natural key v2), stock_ledger (6), journal_vouchers (6).
- Raw-migration columns are invisible to Drizzle: they must be read/written via raw SQL (drizzle `db.select()` silently drops them).

## 4. Master Data Flow

| Master | Consumers |
|---|---|
| Items / Materials / Raw materials | Purchases, Production/BOM, Sales, Transfers, Stock, Valuation, GST (HSN/rate), Item Prices. Code prefixes follow display labels; EAN-13 barcodes in the `2` in-store range; inactive blocks CREATE only; creation is HO-only |
| Customers / Vendors | Sales/Receipts · Purchases/Payments; auto-provision `CUST-`/`VEND-` ledgers under Sundry Debtors/Creditors; app-level delete removes the ledger; a boot sweep heals hand-deleted masters (orphan ledgers) |
| Employees | Auth (username), HR, attendance, payroll, salary accrual; auto `SAL-EMP-`/`SAL-PAY-` ledgers (`ADV-EMP-` retired Aug 2026: advances now post Dr SAL-PAY via payment voucher, source='employee_advance'; old balances migrated by `employee_advances_to_salary_payable_v1`, subtree deactivated; cash-recovery endpoint removed) |
| Chart of Accounts | Everything financial; `SYS-*` roots → `STD-*` containers → auto party/branch/rent/salary ledgers; `code` never client-writable |
| Warehouses / Outlets | LBAC scope, stock location, GSTIN for transfer classification, seller identity on invoices (seller = location, never company), rent agreements; a place can exist as BOTH warehouse and outlet sharing one cash ledger (mirror locations) |
| GST config | Slab rates on items; company + per-location GSTINs; `lineTaxHeads()` is the single tax-math authority |
| Bank accounts | cash_bank_accounts each backed by a `CBA-{id}` ledger under STD-CASH / STD-BANK ("Bank Accounts"); balances fully DERIVED from postings + openings (stored balance column is dead); the two heads are module-managed (chart refuses child-create/move/rename/deactivate, UI shows a "Cash & Bank" badge); Cash & Bank screen shows the whole subtree incl. read-only branch tills so Σ rows = books' cash+bank position; opening balances seeded per account are counterweighted by ONE auto-maintained credit row on "Opening Balance Adjustment" (STD-OB-ADJ under SYS-CAP), recomputed under an advisory lock at boot and after every module write; manual opening-balance routes refuse CBA-/STD-OB-ADJ ledgers; HO-only writes |
| Permissions/Hierarchy | Single-root role tree, per-page rights (§9) |

## 5. Inventory Flow

**Truth stores:** `stock_entries` = authoritative on-hand per location · `stock_batches` = additive lot layer (mfg/expiry/unit_cost; shortfall = "Untracked") · `stock_ledger` = append-only audit (business-date `txn_date`; Closing(D)=Opening(D+1)) · `stock_reservations` = `hold` (reduces available) and `in_transit` (already deducted from sender, sender-owned for valuation).

Movements (all write stock_entries + batches + stock_ledger inside one transaction, lock order: labour day+location → item → rows):
1. **Opening stock** at item creation → credit entry + batch.
2. **Purchase** → batches `PUR-YYYYMMDD-NNNNN` (allocator sequence), stock valued at **taxable value** (net of GST + discount), weighted-avg cost update; edits refused once goods moved (floor-at-zero reversals would invent stock). **Other Purchase Charges** (Aug 2026): optional `{ledgerId, amount}` rows in raw JSONB `purchases.other_charges` (drizzle-invisible — raw SQL only) — freight/hamali booked Dr expense ledger / Cr vendor; NEVER in stock valuation, avg cost, GST math, dashboard purchase KPIs or return caps (`total_amount` stays goods-only; vendor owed = goods + charges, every payable reader adds the JSONB sum). Server validation (`lib/otherCharges.ts`, applied on create/full edit/charges-only PATCH/import commit): active postable expense ledger, not under SYS-PUR subtree, no internal code prefixes, >0 ≤2dp, max 50 rows. Importer has optional "Other Charge Ledger/Amount" columns (both-or-neither, unknown name = hard error, paid cap = grand total). Goods returns intentionally do NOT touch charges — freight on returned goods was still incurred, the vendor stays owed exactly the charge amount. Charges surface in P&L/TB/Day Book/ledger statements via derived postings and as derived read-only rows (negative synthetic ids) in `/reports/fin/expenses`.
3. **Production** → BOM-guided FEFO consumption (`planFEFO`: expiry ASC NULLS LAST) with clamped batch takes, output credited at absorption cost (materials at current cost + overhead %; wastage never enters stock); delete reverses stock AND avg cost (permanently within data limits).
4. **Two-step transfer** (always) → dispatch deducts source + creates `in_transit`; receive releases + credits destination. Cross-GSTIN transfers also write real sale/purchase rows (§6).
5. **Sale** → FEFO (or manual batch) consumption; **cancellation** is terminal — every write path (payments, returns) re-checks it after the row lock; returns restore batches. **Other Charges on sales** (Aug 2026): optional `{ledgerId, amount}` rows in raw JSONB `sales.other_charges` (drizzle-invisible — raw SQL only), validated in `lib/otherCharges.ts` (>0 ≤2dp, max 50; purchase charges: active postable expense ledger outside SYS-PUR; **sale charges since Aug 2026: active postable INCOME ledger strictly under Direct Income `SYS-DIRINC`** — e.g. the seeded "Packing & Delivery Recovery" — with stored legacy expense-ledger charges grandfathered per sale on EDIT via `validateSaleOtherCharges(q, raw, { grandfatheredLedgerIds })`). **Asymmetric totals vs purchases, by design:** sale `total_amount` INCLUDES charges (dues, receipts, credit checks, advance caps, customer Dr, PDF grand total all key off it) while `subtotal`/`tax_total` stay goods-only — charges carry NO GST, so taxable value and GST reports are untouched. Books: revenue Cr = `total − tax − charges`, one Cr per charge to its own ledger (Direct Income; legacy rows keep their expense ledger), Dr side carries the full total; `loadLedgerUsage` guards ledger deletes via a `sales.other_charges` branch. Edit: supplied list replaces, absent preserves, `[]` clears. Returns NEVER refund charges (mirrors purchase returns — the freight was incurred regardless); refunding one = edit the sale or a manual voucher. Quotations/branch-transfer invoices never carry charges. POS UI: charge rows (Direct Income ledger + amount) under the cart, summary "+ Other Charges" line, PDF row per charge named after the ledger. **Creation-time collection (Aug 2026):** New Sale's payment methods come from the selected location's Cash & Bank ledger assignments (same `resolveReceiveIntoAccount` the collect flow uses) — raw-body `receivedInLedgerId`/`amountReceived`/`allowOverpayment`/`referenceNumber` on `POST /sales`; money posts through the ONE receipt engine (`lib/saleCollection.ts` → receipt-backed `sale_payments` row, mode DERIVED from the account); partial requires a registered customer (else 400 `PARTIAL_REQUIRES_CUSTOMER`) and stores mode `credit`/`partially_paid`; overpay 400 `EXCEEDS_OUTSTANDING` unless customer + `allowOverpayment` (excess = netted customer advance, walk-ins always refused); `clientRequestId` create replay never doubles money. **Price history:** `GET /sales/price-history?customerId&itemId&limit≤10` (POS view right, LBAC-scoped, cancelled/branch-transfer excluded) feeds a read-only popover beside the POS item picker — informational only, never auto-applies. Suites: `tests/pos-other-charges.test.mjs` (64), `tests/pos-create-collection.test.mjs` (42), `tests/pos-partial-overpay-idempotency.test.mjs` (29).
6. **Verification/adjustment** → stock_verifications + corrective entries.
7. **Expiry** — tracked per batch; reports read expiry dates (proactive alerts = backlog task #56).

**Valuation:** ONE at-cost engine (`stockValuationRows`) = on-hand (3 material kinds) + sender-owned in-transit; feeds Stock report, Dashboard tile and P&L closing stock identically. Movement/ageing class = last OUTBOUND. Negative stock blocked by DB CHECK.

## 6. Accounting Flow (every posting)

Single source of truth: `buildDerivedPostings()` (routes/journal.ts) derives the entire double-entry stream from documents on demand; `buildBooks()` (lib/books.ts) turns it into every statement. Opening balances live outside the stream and are folded in by buildBooks/ledgerBalances.

| Event | Postings |
|---|---|
| Sale | GROSS on provisioned customers (Aug 2026): Dr `CUST-n` full total at sale_date ("Invoice <no>") + Cr `CUST-n` per sale_payment at payment_date (voucher = clearing receipt's; advance rows = visible Dr/Cr wash) + Dr Cash/Elec-Clearing counter-money / Cr location Sales + Cr Output CGST+SGST or IGST (via `lineTaxHeads`, paise split = half + exact remainder). Walk-ins/missing-ledger sales keep the old net shape (Dr settled legs + Dr remainder on `SYS-DEBTORS`). Net per ledger identical either way. |
| Sale-linked receipt | **Excluded** from stream (sale already carries the settlement) — double-count trap. Admin-only delete (Aug 2026): a level-1 Administrator may delete a `source='sale'` receipt via `POST /accounts/receipts/:id/system-delete` (reason required, audited with before/after metadata; `GET .../delete-impact` feeds the warning dialog). Collection receipts unwind their `sale_payments` legs + `amount_paid` + status; invoice-trail receipts reverse only the counter-money slice (`amount_paid − Σ sale_payments`); cancelled sales block (409); ambiguous shared invoice numbers block; other system sources still route to their owning module. Sale-edit now re-derives `amount_paid` under the sale row lock so concurrent unwinds can't be overwritten. |
| Purchase | Dr Purchases + Dr Input GST + Dr other-charge expense ledgers (one leg per charge row) / Cr `VEND-n` = goods + charges (settlement per mode) |
| Receipt / Payment | Dr received_in / Cr received_from · Dr paid_to / Cr paid_from. Bill-wise settlement (Aug 2026): vouchers may carry `allocations` (`[{saleId\|purchaseId, amount}]`) + `advanceAmount` → `source='allocation'`, edit-locked, delete = full unwind (409 once the advance slice is consumed). Customer excess stays as a CREDIT (negative) balance on the customer's single `CUST-n` Sundry Debtor ledger (single-ledger model, Aug 2026 — CADV ledgers and the Customer Advances group were folded away by `customer_advances_fold_v1`; customer advance = max(0, −net), netted against everything owed). Vendor excess still parks on the `VADV-n` (asset) advance ledger with a split voucher leg. Allocation receipts write `sale_payments` rows via `clearing_receipt_id` (excluded from stream → pass `receiptadv` posts the advance slice to the customer ledger); vendor side uses `payment_bill_allocations` + `purchase_advance_applications`. Sales/purchases accept `useAdvance:true` → auto-adjusts (method `advance` debits `CUST-n` / pass `purchadv`), capped at min(available, total). Explicit-first rule: pinned money never enters the payables FIFO pool. `GET /accounts/settlement-context` + `/accounts/party-advance` feed the forms; ageing reports show per-party `advance` (ledger-anchored/company-wide views) and seed advance-only parties. Purchase guards: delete/vendor-edit refused with allocations (`BILL_HAS_ALLOCATIONS`), total below applied advance refused. Consumption attribution: `advance_consumptions` pins every consumed slice to its parking voucher (FIFO oldest-first, NULL source = JV-funded); voucher delete guard checks these references (precise); the aggregate-balance backstop is vendor-only (a customer's netted figure says nothing about whether a specific voucher's money was used). Sale cancel: real payments still block (PAYMENTS_RECORDED); advance-only payments are unwound instead — advance restored atomically in the cancel txn. |
| Contra / Journal | As entered; voucher provenance stored (system vouchers locked for edit; unknown-origin locked but deletable; number preserved ⇒ type & FY frozen). Manual vouchers are LOCATION-AWARE (Aug 2026): mandatory location (HO/warehouse/outlet) picked in the dialog above Date; body is re-authorized against the caller (branch users forced to own location; omitted → caller's location on create / current stamp on edit); ledger legs validated against the stamp via `checkLinesLocation` (branch tills/sales ledgers must belong to the stamp owner; STD-CASH/STD-BANK subtrees allowed only on HO vouchers; branch creators blocked from foreign party ledgers); routes are location-scoped, not HO-only — branch users CRUD own-location vouchers, foreign ids 404. `GET /accounts/voucher-locations` feeds the dialog. HO voucher stamp = `headoffice`/0 while HO sales/stock use id 1 — HO must be matched on TYPE alone. Legacy NULL rows backfilled via boot migration; statements include JV lines with effective location = COALESCE(return doc, voucher stamp) |
| Credit note | Dr Sales / Cr Customer · Debit note: Dr Vendor / Cr Purchases (location inherited from source) |
| Salary accrual | Daily, attendance-driven: Dr `SAL-EMP-n` / Cr `SAL-PAY-n` (payroll approval = delta true-up under the attendance lock; month locks; full employer cost incl. PF/ESI at snapshot rates) |
| Rent accrual | Daily derived: Dr `RENT-EXP-wh` / Cr `RENT-PAY-wh`; payments are vouchers |
| Expense | Dr expense ledger / Cr paying ledger (kind discriminator stored, never inferred from funding ledger) |
| Asset purchase | Capitalised **including GST** (no ITC), purchase row IS the register entry; no depreciation postings (by design, backlog) |
| Branch transfer (same GSTIN) | Dispatch/receive JVs via `STD-BRANCH-TRF` + auto `STD-BRANCH-DEBTOR/CREDITOR` (tax posted at dispatch+approve) |
| Branch transfer (cross-GSTIN) | Real sale + purchase rows replace the JVs (`branch_transfer_id` set — every revenue/spend query must exclude it) |
| Production costing | Matched `STD-FG-INV`/`STD-PROD-ABS` legs — **excluded from P&L** (closing stock already carries the value): the capitalisation overlay |

Statements: Trial Balance, P&L (period aggregate + opening/closing stock), Balance Sheet (cumulative; statements signed to each section's natural side — sign ≠ Dr/Cr), Ledger Statement (running balance), Day Book, Cash/Bank books — all from the same stream. Voucher numbering per type + FY via `voucher_sequences`.

## 7. Reporting Flow

- **Financial** (`/reports/fin/*`): trial-balance, ledgers, ledger-statement, cash, bank, day-book, gst, salary, expenses — all read `buildBooks`/posting stream; global filters (from/to + location) narrow LBAC only; HO placeholder matches on type alone.
- **GST** (`/gst/*`): summary, GSTR-1 (B2B invoice-wise / B2C rate-wise by place of supply), GSTR-3B (ITC set-off IGST→CGST→SGST), HSN summary, ledger-vs-register reconciliation, CSV exports. Filing scope falls back to company GSTIN (transfer classification deliberately does not).
- **Inventory**: stock report, stock ledger (window-function running balance), valuation & ageing, movement reports, verification.
- **Production**: output, consumption vs BOM, wastage, batch costs.
- **Sales**: summary, by item/customer/payment mode, outstanding (owning-module calc — dues = total − paid), returns.
- **HR**: payroll register, salary report, attendance reports.
- Reports Center (`/reports/:cat`) + PDF/CSV export via server-side generators.

## 8. Dashboard Flow (KPI sources, verified)

| KPI | Source |
|---|---|
| Sales, Purchases, trend, payment mix, by-location, top items/customers | Scoped SQL over sales/purchases (LBAC-filtered; sale location via `location_type`+`location_id` — never join legacy `sale_payments.outlet_id`) |
| Expenses (+ Salary·Rent·Other breakdown) | `companyFinancials` → `buildBooks` P&L (direct+indirect; breakdown from STD-SALARY-EXP / STD-GRP-RENT-EXP subtrees of the same build; Other = exact remainder) |
| Receivables / Payables (+Suppliers·Salary·Rent hint) | Ledger balance index control totals (postings have no location → company-level; **null for branch logins**, UI shows —) |
| Cash / Bank balance | Same index (STD-CASH/STD-BANK walks incl. opening balances) |
| Inventory value | Shared valuation engine; hidden entirely without the valuation right (server omits the key) |
| Production trend | productions by day |
| GP / NP tiles | `companyFinancials().profit` — read straight off the SAME `buildBooks` P&L summary as Expenses (GP = net sales + direct income − COGS; NP adds other income, less indirect). Null exactly when the other accounting figures are null. Click-through to `/reports/financial#pl-gross-profit` / `#pl-net-profit`. |

Never re-sum expense subtrees for a tile (capitalisation overlay); tiles must agree with the statements by construction.

Card layout (Aug 2026): five fixed rows — Sales·Purchases·Expenses / Inventory·Cash·Bank / Receivables·Payables / Money In·Out Today / GP·NP — via a 6-col grid with col-spans; spec colors (sales green, expenses/payables/out red, inventory/receivables blue, balances & GP/NP signed).

The Chart of Accounts → Profit & Loss tab renders the same figures as a two-sided Trading Account (with GP c/d balancing both sides and conditional gross/Less-returns rows) → Gross Profit banner → P&L Account (GP b/d + Other Income vs Indirect Expenses) → Net Profit banner; GP/NP displayed from `profitAndLoss.summary`, never recomputed.

P&L report additionally renders a standard vertical Trading & P&L statement (Sales → Less: Sales Returns → Net Sales → Opening Stock → Purchases → Direct Expenses → Goods Available → Less: Closing Stock → COGS → GP → Other Income → Indirect/Financial Charges/Depreciation → NP). `buildBooks` surfaces `grossSales/salesReturns/purchaseReturns` by summing credit_note/debit_note-sourced postings on the SYS-SAL/SYS-PUR subtrees (group totals stay net). Financial Charges/Depreciation lines are name-matched with the Indirect remainder computed by subtraction, so the statement always ties to NP.

## 9. Permission Flow

- **Model:** one `permissions` row per hierarchy × sidebar link (`page:<href>`); five real actions (view/add/edit/delete/download; print/approve/share are legacy write-mirrors, never read). Default-deny: missing row = no access. Hierarchy level 1 = full-access bypass (guards exist on level-1 create/delete, not just edit).
- **Role tree:** single-root `hierarchies` with derived levels; structure edits serialize on one advisory lock; deletion blocked while employees hold the role or others report to it.
- **Enforcement order:** requireAuth → RBAC page right (**403**) → LBAC location scope (**404**) → business logic. Frontend mirrors via `usePermission`/`RoutePermissionGuard` (server remains authoritative).
- **LBAC:** HO sees all · warehouse sees itself + its outlets · outlet sees itself. Stamped `location_type`+`location_id` on documents and masters; request body location is a *request*, not authority — guards compute the **effective** resulting state. Money vouchers use narrower own-location scope. HO-only endpoints guard master data. Hidden money figures are **omitted**, never zeroed (clients echo GETs back on approve).
- Permission GETs (hierarchies/permissions) stay unguarded by design (login-time resolution needs them).

## 10. Location Flow

Sales POS requires a location context (fresh sessions render blank at `/sales/*` until picked — by design). GST classification (internal/intrastate/interstate) auto-detects from location GSTINs. Inventory, expenses, deposits, rent are location-stamped. Financial reports accept a location filter (LBAC-narrowing); accounting-tile figures are company-level by construction. Mirror locations (same place as warehouse + outlet) share one cash ledger — reads dedupe, writes resolve across both identities. Invoice seller identity = the location (bank/UPI may fall back to company; identity may not).

**Warehouse lifecycle (Aug 2026):** warehouses can be **disabled** (raw `disabled_at/disabled_by` columns; reversible; outlets inherit the state). Every transaction producer — sales, purchases, quotations, production, transfers, money vouchers, JVs, returns, stock verification, rent pay, imports, payroll pay/advances, asset purchases, deposits — checks `disabledWarehouseError()` on the *effective* resolved location and 409s with `WAREHOUSE_DISABLED`; receiving in-transit transfers and edits stay allowed (wind-down). **Permanent delete** (Super-Admin/level-1 only, `DELETE /warehouses/:id/permanent`): two-stage UI (choice dialog recommending Disable with a pre-delete count summary → typed `DELETE <name>` phrase), server re-checks phrase + blockers inside one advisory-locked transaction, cascades children-first across every warehouse-stamped table, then validates in-txn (zero remaining rows, ledgers gone, TB balanced, no orphaned JV lines) — any failure rolls everything back with `failures[]`. Cross-location entanglements (outlets, transfers, employees, assets, deposits, import batches, shared mirror ledgers) are hard blockers, never cascaded.

## 11. GST Flow

- Slab-locked rates (0/5/12/18/28 — enforcement task #14 open), item-level HSN, price modes inclusive/exclusive.
- `lineTaxHeads()` is the ONLY tax-math path (server and client agree); CGST/SGST = half + exact paise remainder (never two independent rounds); IGST on inter-state by place of supply.
- Line discounts net into taxable value pre-tax; bill-level coupon is post-tax only (`discount_total`).
- **Sale MRP floor (Aug 2026):** line `unitPrice` ≥ item master MRP on create AND edit (server `checkMrpFloor` + POS field validation; 400 `MRP_BELOW_MASTER`); reductions only via discounts. Edits grandfathered: floor = min(master, lowest stored line price). Items with mrp 0 have no floor; quotations exempt (check sits outside `buildSaleLines`).
- Head-wise Output/Input CGST/SGST/IGST ledgers; GSTR-1 B2B/B2C split; GSTR-3B with ITC set-off; HSN summary; reconciliation report ledger-vs-register.
- **Known gap (task #54):** credit/debit notes do not yet reduce GST returns.

## 12. HR Flow

Attendance: multi-punch (`attendance_punches`), paid on TOTAL closed-session hours; day boundary = company timezone. Leave: pending = zero pay; approval stamps attendance under the lock; rejection never writes 'absent'; revert = DELETE. Payroll: draft→approved→paid; drafts are LIVE (Aug 2026) — `GET /hr/payroll?year&month` idempotently refreshes every draft from current attendance before returning, but ONLY for head-office operators holding the payroll `add` right (the refresh writes: drafts + advance claims; view-only AND self-scoped branch readers — even with `add` — get stored rows). Generate/Regenerate buttons removed; `POST /hr/payroll/generate` kept as a paisa-identical compat alias; locked/approved months skipped; concurrent refreshes of one month serialise on an advisory lock, a unique index enforces one payroll row per employee-month, and both refresh and approval derive all figures from the payroll row re-read under its row lock (neither side can clobber the other's committed state); statutory PF/ESI at snapshotted rates; approved runs locked — corrections are reversals; advances auto-deducted at generation. Approval also refuses incomplete pay periods (409 `MONTH_INCOMPLETE`, no override): any rowless non-holiday/non-weekly-off day between tomorrow and the period end (month end, or LWD for leavers) blocks — mid-month approval would freeze future days as LOP; rostering the rest of the month with stored rows counts as complete. Absence classification (Aug 2026): approval 409s `UNCLASSIFIED_ABSENCES` (dates listed) for post-cutover tracked months with uncovered past days inside join→LWD unless `{confirmLop:true}`; managers classify via `PUT /hr/attendance` (CL/SL/Paid Off/LOP) from the payroll page's badge dialog; `GET /hr/payroll/unclassified-absences` surfaces them. `leaving_reason` raw column on employees (effective-value rule: active ⇒ NULL, blank ⇒ NULL trimmed). Employment status (Aug 2026): `employment_status` (active/resigned/terminated/inactive) + `last_working_date` raw columns on employees; status is truth, `is_active` derived; salary accrual and payroll clamp to the LWD (rows past it deleted in open months); ex-employees paid for served days when LWD ≥ month start; zero-attendance months in the attendance era (≥ `salary_accrual_config.attendance_from`, LOP on) pay ZERO (pre-cutover months keep legacy full pay); zero-payable/stale drafts torn down under the payroll row lock with advance claims released; generation and approval share the same clamp/cap/untracked flag. Leave policy (Aug 2026): company-wide `paidCasualLeavesPerMonth` (4) / sick allowance / `lopEnabled` in general_settings; working-days basis = the payroll month's ACTUAL calendar days (`monthWorkingDays`; the `payrollWorkingDays` and `salaryDay` settings are retired — stored keys accepted and ignored); half day = 0.5 leave; leave beyond the allowance deducts LOP at salary/calendar-days; per-employee working-days retired; `payroll.paid_leave_used/allowed` snapshot per run (NULL = pre-policy). Salary accrual: daily P&L recognition from attendance (unrounded rate, copied verbatim from payroll's expression); approval re-checks attendance inside the lock. Rent: agreements per warehouse; daily accrual; partial payments; revision regenerates the unapproved month.

## 13. Document Flow

| Document | Numbering | Mutation rules |
|---|---|---|
| Quotation | — | Module in development (task #202) with follow-ups #203–205 queued |
| Sales invoice | `prefix/FY/seq` unique, allocator-backed (never renumber) | Edit reverses/reapplies stock; cancel is terminal; PDF server-side; share via revocable HMAC links or short-lived in-session token |
| Receipt / Payment / JV / Contra / Notes | `REC/PAY/JV…/FY/seq` | Provenance-gated edits; system vouchers locked; deletes allowed with ledger sweep; JV-family routes location-scoped (branch users see/create/edit/delete only own-location vouchers, foreign = 404; line ledgers validated against the stamp); receipts/payments reject foreign-location and foreign-party ledger legs for branch callers |
| Purchase bill | vendor ref or `PUR/FY/seq` | Edit refused once goods consumed/moved |
| Expense | `EXP/FY/seq` | Location-stamped; delete pending task #40 |
| Asset purchase | user ref + code | Row IS the register entry; transfers/disposals tracked |
| Transfer | `TRF/FY/seq` | Two-step; approve/reject; no delete (audit preserved) |
| Production | `PRD/FY/seq` | No edit; delete reverses stock + cost |

## 14. API Analysis

33 route files, **266 unique endpoints** (grep-verified). All under `/api`, JSON envelopes, Zod-validated bodies (zod strips unknown keys), global bearer auth except `/health`, `/auth/login`, `/public/*` (tokenized invoice links). Guard pattern per route: `requireModuleView(page)` for reads, `requireModuleAction(page, action)` for writes, plus HO-only and location-scope checks. OpenAPI spec drives the generated client; **the spec gates writes** (fields not in the spec are silently stripped — keep codegen in lockstep). Creates return 201. List endpoints the UI reads wholesale are intentionally un-paginated (opt-in paging only).

**Read-only verification this audit (Phase 17, GETs only — writes not exercised per the no-modification directive; write-path behavior is covered by the regression suites in `artifacts/api-server/tests/`):** 60+ endpoints across every module returned 200 with correct shapes — masters, documents, stock, batches, ledger, all statements, GST returns, HR, rent, assets, dashboards, permissions, audit/login history, with date + location filter variants. Expenses KPI reconciliation re-verified across 9 filter combinations. **One defect found** (see §15 bug B1).

## 15. Known Bugs

### Fixed by the Aug 1, 2026 full health-check (code)
- **Sale-edit location corruption vector (Critical, root cause of the books drift):** `PUT /sales/:id` defaulted omitted location fields to `outlet`/`undefined`, silently stripping the sale's location. 35 historical rows (₹19,288.53) had been corrupted this way — the exact receivables-vs-TB and location-books drift. Edits now preserve the row's existing location; `POST /sales` rejects non-finite location ids.
- **Transfer-invoice edits locked:** editing a transfer-generated invoice through the sales editor is now a 409 (it must be managed via the transfer).
- **Sales-return & purchase-return stock-ledger writes were fire-and-forget** (pool write before COMMIT — a rollback kept phantom audit rows, a crash lost them). Both now write inside the transaction with the business return date.
- **Stock verification wrote no stock_ledger rows** — physical adjustments appeared as unexplained quantity jumps in the audit trail. Now writes `adjustment` rows per non-zero variance, in-transaction.
- **Product master deletes orphaned live stock:** items/materials/raw materials could be deleted with stock on hand or an active reservation, leaving invisible orphan quantities in valuation. Deletes are now guarded in a single transaction (master row locked FOR UPDATE, stock re-checked under the lock → 409).
- **Permission seeder mirror drift:** 5 seeding INSERTs omitted `can_approve`/`can_share`, breaking the five-action mirror invariant for new hierarchies (3 live rows had drifted). Seeders fixed; rows healed.

### Data heals applied (dev DB, Aug 1, 2026)
32 corrupted sales restored from their CREATE audit metadata (location + settled `amount_paid` on cash sales); 3 ghost `BTR/` invoices removed (their transfers and purchase twins had been deleted, FK nulled); 2 ghost in-transit reservations removed; missing `CUST-`/`VEND-` ledgers provisioned for parties that predate auto-provisioning (books re-attach their postings retroactively — this alone reconciled TB vs receivables/payables ageing). All 21 regression suites now pass except two stale pre-auth-era tests (task #190).

### Open (found; tracked, NOT fixed — per task backlog discipline)

**Critical** — none observed in dev. (Production has two fixes awaiting your publish: pre-reset ghost data cleanup and orphan vendor-ledger sweep — both already built and reviewed.)

**High** (all already tracked in your task backlog):
- #54 Credit/debit notes don't reduce GST returns (tax over-reported).
- #37 Sales summary misses warehouse sales (dashboard understates).
- #188 Deleted customers can leave invisible balances in the books.
- #14 GST rates not locked to valid slabs at entry.

**Medium:**
- **B1 (new, found by this audit):** `GET /api/assets/:id` with a non-numeric id (e.g. any unknown `/assets/...` path) throws an unhandled DB error → 500 `NaN` (inventory.ts:428). Should 400/404. Same pattern may exist on other `:id` routes.
- #134 Concurrent edits silently overwrite (no stale-write detection).
- #131 Finished product vs raw material with same id (polymorphic tables) — guarded by material_type discipline, enforcement task open.
- #189 GST/expense reports lack the location filter other reports have.
- #40 Location expenses recorded in error cannot be deleted.

**Low:** #57 hidden type errors (esbuild ignores them at runtime); #114 transfer dispatcher not recorded; #191 older credit-sale settlements show generic "Paid"; `stock_batches_opening_v1` boot migration logs DEFERRED every boot (cosmetic, known); pre-launch UX polish items in the backlog.

Full backlog: 60+ curated tasks in the project task list (each one a vetted finding from prior sessions).

## 16. Improvement Suggestions

| Area | Suggestion |
|---|---|
| Performance | `buildDerivedPostings` recomputes the full posting stream per request (dashboard, TB, ledger). Fine at current volume (~sub-100 ms) but linear growth — introduce a cached/materialized stream keyed by max document timestamp when volume grows. |
| Performance | N+1 lookups in transfer dispatch line loops (stock.ts:665,694) — batch with `IN` clauses. |
| Robustness | Validate `:id` params centrally (B1 class of 500s). |
| Type safety | ~70 `as any` in headoffice/Sales.tsx, 42 in accounts.ts; `req.employee` cast everywhere — introduce typed request context. (#57 covers build-time enforcement.) |
| Maintainability | God files: hr.ts (2,732 lines), accounts.ts (2,119), sales.ts (1,833) — extract services. Ledger-fallback and branch-transfer pivots in journal.ts are repeated inline — centralize. |
| Database | Conventional (code-string) relations depend on healing sweeps; consider FKs where safe (e.g. journal_voucher_lines.ledger_id). |
| Accounting | Depreciation postings for assets (currently none, by design); voucher-period locking UI. |
| Inventory | Proactive expiry alerts (#56), wastage anomaly flags (#62), BOM over-consumption warning (#12). |
| Workflow | Quotations module completion (#202–205); WhatsApp attachment sending (#137). |
| UI | Reload prompt on concurrent edit (#134); settlement method on old credit sales (#191). |

## 17. Scores & Risk Assessment

**Overall ERP Health: 86 / 100** (82 before the Aug 1, 2026 health-check fixes — the books-drift root cause, atomic stock-audit writes, guarded master deletes, and full reconciliation of TB vs ageing raised it). Exceptionally strong: single-source accounting derivation (statements cannot disagree), batch/FEFO inventory with append-only audit ledger, default-deny RBAC + LBAC, GST returns with reconciliation, daily accrual engine, boot-migration discipline with self-healing sweeps, extensive regression suites. Deductions: type-safety debt, god-file maintainability, derived-stream scaling ceiling, sparse DB-level FK enforcement, open GST-correctness gap (#54).

**Production Readiness: 85 / 100.** Already live and in daily use; hardened auth, backups + verified restore path, audit trails, boot observability. Held back by: the two fixes awaiting publish, #54 (tax filing accuracy), #37 (reporting accuracy), and no CI gate on type errors.

**Risks:**
1. **Manual DB edits in production** (twice this week: stale reset, hand-deleted vendors) — highest practical risk; mitigations now exist (reset fix, healing sweeps), but the pattern bypasses every safeguard. Use the app's delete/reset paths.
2. **Publish-time schema drift** — dev and prod schemas converge only via boot migrations; publish diffs the live DBs (text→date can never auto-apply). Keep to the established migration playbook.
3. **GST filing accuracy** until #54 lands (over-reporting, i.e. conservative direction — but fix before relying on returns).
4. **Scaling** — posting-stream recomputation and un-paginated lists are fine for current volume; revisit at ~10× document counts.
5. **Key-person dependency** — deep conventions (ledger codes, polymorphic scoping, overlay exclusions) are documented in code comments and this audit; keep this document current.

## 18. Recommended Next Steps

1. **Publish** — ships the two production fixes already built and reviewed (ghost cleanup + orphan ledger sweep).
2. Fix **#54** (GST returns vs credit/debit notes) before the next filing period.
3. Fix **#37** (sales summary warehouse gap) — dashboard trust.
4. Land **B1** (`:id` validation) — small, removes a 500 class.
5. Continue the Quotations module (#202, in progress) and its follow-ups.
6. Then work the High/Medium backlog in the order above; schedule #57 (type errors) as a hardening sprint with CI enforcement.

## 19. Addendum — Full Health-Check Re-Run (Aug 5, 2026)

Report-only audit (no fixes applied). Method: 33 regression suites re-run, production + dev database integrity sweeps (25 invariant checks each), API-level cross-report reconciliation (17 checks), GST return reconciliation against raw invoices.

**Production database: structurally clean.** Zero duplicates, zero unbalanced vouchers, zero orphan legs/ledgers/ghost documents, zero negative stock, zero cancelled sales holding money. The Aug 5 allocation-receipt cleanup verified applied (10 receipts removed, audit rows present, 13 sales reset).

**Reconciliation (dev, quiet DB): 15/17 passed.** TB Dr=Cr (both TB endpoints agree to the paisa), BS balanced, receivables/payables reports = dashboard = ledger decomposition, Cash & Bank screen = TB per ledger, inventory valuation = dashboard, GSTR-1 = invoice sums exactly, day book Dr=Cr.

**New findings (unfixed, reported only):**
- **M-1 Cash Book / Bank Book omit opening balances.** `journal.ts` cash-bank-book route builds from `buildDerivedPostings` but never folds in `openingBalancePostings`, though the TB code comment claims the books count them. Dev: Main Cash book shows −175.25 vs screen/TB 49,474.75 — difference exactly the 49,650 opening. Prod currently has zero opening-balance rows, so latent there — until openings are entered.
- **M-2 First 8 production cash sales (Aug 1–4) have `amount_paid` set but zero `sale_payments` legs** — created before the settlement-legs producer shipped. Their payment-history tabs are blank and reconciliation/method-level reports can't see them. One-time backfill would close it.
- **M-3 Deleting a product leaves nameless stock rows** in valuation/stock reports (9 blank-name rows in dev from test suites; prod clean today).
- **L-1** 9 FK columns lack indexes (trivial at current volume). **L-2** auth-lockout suite T13 flaky under residue (unique index verified present in DB; T15 recovery path passes).

**Test battery: 26/33 suites fully green (~1,100 assertions).** All 7 failing suites are stale-test/fixture issues, not app bugs — already covered by task #190: gst + org-restructure (pre-auth-era harness), accounting (pre-statutory-payroll JV assertions + depleted fixture stock), invoice-pdf (expects coupons enabled in settings), per-location-numbering (assumes fresh serials), import-txn-semantics + stock-dating (fixture-month clock rollover).

**Scores (Aug 5):** Accounting 92, Dashboard 95, Customer/Vendor 95, Sales 90, Purchases 95, Inventory 88, Imports 92, GST 85 (held by #54), Location 93, Payroll 92, Cash & Bank 80 (M-1), Reports 90, DB health 90, Performance 85, Security 92. **Overall: 90/100** (up from 86 — prod verified clean end-to-end; deductions: M-1/M-2/M-3, #54, stale test debt).

## 20. Addendum — Month Locking & B2B/B2C Invoice Series (Aug 8, 2026)

- **Accounting Periods module** (`/accounts/periods`, `routes/periods.ts`, `lib/periodLock.ts`): admin-only monthly locking. `accounting_period_locks` holds only locked months (absence = open); `period_lock_events` records every lock/unlock with actor and unlock reason. Lock requires confirmation and shows a pre-lock verification summary; unlock requires a reason. All writes with a business date in a locked month are refused with HTTP 423 `MONTH_LOCKED` via one shared helper — sales, purchases, returns, productions, transfers, vouchers, expenses, payroll, attendance, leaves, rent, assets (incl. asset transfers), imports, accrual sweeps. Deliberately open: new open-month payments against locked-month credit sales, quotations, masters.
- **B2C→B2B reclassification** (`lib/invoiceReclass.ts`): a customer gaining a GSTIN converts their open-month SB2C invoices to the SB2B series atomically (GST save inside the same transaction), compacts only the serial gaps the conversion opened (historical gaps preserved), pair-renames receipts/quotations with unconditional location guards, and writes an audit row per invoice. GSTR-1 classifies by the stamped `invoice_series`; locked months are never touched.
- Regression suites: `tests/period-lock.test.mjs` (38 checks), `tests/b2c-b2b-conversion.test.mjs` (24 checks) — both suites are self-cleaning and location-guarded against the live data.

## 21. Addendum — Post-Modernization Acceptance Gate (Aug 15, 2026, task #300)

Final regression, reconciliation and export/UI audit closing the modernization program. Unlike §19 (report-only), genuine breaks found here were **fixed**.

### Test battery: 55/55 suites green
Every backend suite passes (~2,900 assertions; `org-restructure-migration` runs via the workspace tsx harness). The §19 "stale suite" debt is fully paid — the 7 formerly-failing suites were rewritten/repaired in earlier tasks and now pass. Monorepo typecheck clean across api-server, marlin-erp, employee-app, mockup-sandbox and all `lib/*` packages.

Two suite-adjacent defects found and fixed on the way to green:
- **Ghost sale receipts (data + product fix).** `buildDerivedPostings` excludes sale-linked receipts only while the sale exists; deleting a sale turned its receipts into live one-sided postings. 10 ghost receipts in dev (leaked by test fixtures) were exactly the −₹3,000 BS gap. Receipts removed; `period-lock.test.mjs` cleanup now unwinds creation-time clearing receipts too, and re-running the suite verifiably leaks nothing.
- **Nameless reversal audit rows (product fix, root cause of §19 M-3).** Purchase delete/edit-reversal wrote `stock_ledger` rows with blank item names — the stored line JSON never carries name/unit (they resolve at read time), so the writers must resolve from the product masters, which they now do inside the transaction. 293 orphan rows healed (verified against masters/documents/batches first). Locked in by `tests/purchase-reversal-ledger-names.test.mjs` (15 checks: edit and delete reversals both stamp real name/unit, zero blank rows escape).

### Reconciliation battery: 17/17 pass (evidence recorded)
On live-shaped dev data: TB Dr = Cr = ₹2,511,294.30 on both TB endpoints; Balance Sheet balanced, zero difference, no integrity issues; every dashboard tile equals its report (receivables ₹273,686.37, payables ₹695,682, inventory ₹618,685.54, sales ₹431,632.41, purchases ₹936,135); payroll/Salary-Payable sub-ledgers consistent; orphan-posting and ghost-receipt scans clean; `stock_ledger` Σqty = `stock_entries` per item+location (0 mismatches); batches ≤ stock; placements ≤ site stock; no negative stock. GST fixture month (July 2026): Summary = GSTR-1 = GSTR-3B (taxable ₹103,881.02, output ₹5,194.19, ITC ₹3,661.71, net ₹1,532.48) and `/gst/reconciliation` fully attributes all 6 heads. §19's **M-1 is fixed** (cash/bank book folds opening balances — verified in code and by the recon pass).

### Export audit: every export reproduces its screen
All 87 CSV call sites audited against their page's pagination. Client-paged pages and full-fetch reports export the complete filtered dataset by construction; books/statement exports covered by the `books-drilldown-export` suite. **Four broken exports found and fixed** — Purchases, Sales, Quotations and the Quotation report exported only the loaded server page; they now one-shot fetch the full filtered dataset (new `fetchAllPurchases`/`fetchAllSales`/`fetchAllQuotations` client helpers using the unpaginated server path, same filters as the screen). Verified server-side (unpaginated = paginated totals: 433/26/13) and end-to-end in the browser (pager total 26 = CSV rows 26).

### UI regression: pass
Playwright sweep as a level-1 user: sale entry (keyboard-entry POS dialog) with dirty-guard verified (Escape on a dirty form prompts, never silently closes) and cash creation-time collection working; journal voucher create + admin delete with dirty-guard; purchases list sorting/pager/₹ formatting; payroll month live-draft render; dispatch board render; mobile (390×844) dashboard + purchases with no horizontal overflow, card lists, drawer nav. One design note (not a regression): sale cancellation has **no UI surface** — `POST /sales/:id/cancel` has never had a frontend caller; cancelling requires the API (and receipts must be unwound first). Tracked as a follow-up.

### Scores (Aug 15)
Accounting 95 (M-1 closed, ghost-receipt class closed) · Inventory 92 (M-3 closed, ledger reconciles exactly) · Reports/Exports 95 (export parity now enforced end-to-end) · Cash & Bank 92 (was 80) · GST 85 (still held by #54) · Tests/CI 95 (all suites green, zero stale debt) · everything else at §19 levels or better. **Overall: 93/100** (up from 90).

### Owner summary (plain language)
Your ERP passed its full end-of-program health check. The books balance to the paisa, every dashboard number matches the report behind it, stock counts agree across all three tracking layers, and the GST returns agree with the ledgers. Every "Export" button now downloads *everything* the screen is filtered to — four of them previously exported only the first page. All automated tests pass. The two things to keep on your radar: credit/debit notes still don't reduce GST returns (task #54 — fix before relying on filed returns), and cancelling a sale currently requires technical help since there's no button for it yet.

### Deferred / open items (intentional, with status)
- **Stock Transfer module spec** — deferred by design; existing two-step transfers remain the flow.
- **#54** GST credit/debit notes vs returns — open, highest-priority correctness item.
- **#53** portal JSON exports — deferred.
- **#37** sales summary warehouse gap, **#14** GST slab locking, **#188** deleted-customer balances (mitigated: orphan sales derive onto SYS-DEBTORS; scans clean), **#134** concurrent-edit reload prompt — open in backlog.
- **Sale cancel UI** — endpoint exists, no frontend surface (follow-up proposed).
- **§19 M-2** (8 early prod cash sales missing `sale_payments` legs) — production-side backfill still pending publish-time verification.
