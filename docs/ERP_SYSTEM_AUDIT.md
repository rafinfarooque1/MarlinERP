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
   PostgreSQL (62 tables)                    Google Cloud Storage
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
**Operations:** Point of Sale (`/sales/pos` — Head Office is a full selling location since Aug 2026: HO card in the location picker, sales stamped `headoffice`/1, books derive to STD-CASH/STD-SALES, invoice numbering unchanged) · Stock (branch) · Stock Transfer · Expenses · Cash Balance · Customers · Receipt Voucher (`/operations/receipt-voucher`) · Payment Voucher (`/operations/payment-voucher`) — full-page surfaces over the SAME receipts/payments engine as Accounts › Vouchers (same REC-/PAT- numbering, postings, provenance locks); own page keys; kind-bound PDF print via `POST /pdf/money-voucher`. Payment mode & attachment REMOVED from money vouchers (Aug 2026): columns kept for legacy rows, writes silently ignore the fields, no read surface (list/PDF/CSV/delete-audit) exposes them. Branch users: sole own-till cash account auto-selected.
**Stock:** Production batches · Stock (HO) · Stock Ledger · Inventory Reports · Stock Verification
**Production:** Purchases · Vendors · Item Master · Units · BOM templates · Production Reports
**Inventory (HO):** Warehouses · Outlets · Item Prices
**Assets:** Asset Purchases · Asset Register · Categories · Transfers · Disposal · Reports
**Sales:** Returns · Outstanding · Coupons · (Quotations — **in development**, task #202 in progress)
**HR:** Employees · Attendance (multi-punch) · Payroll · Advances · Leave · Rent Management · Hierarchy
**Accounts:** Chart of Accounts · Ledger Statement · Cash & Bank · Vouchers · Journal · Contra · Credit/Debit Notes · Day Book · Cash Book · Bank Book · Trial Balance · P&L · Balance Sheet · GST Summary · GST Returns (GSTR-1/3B/HSN) · Reconciliation · Financial Reports
**Company:** Settings · Company Profile · Permissions · Audit Log · Login History · Backup & Restore · Company Reset · Import Data (`/company/import`) — Excel imports for masters (customers, vendors, items with opening stock, ledgers with opening balances) **and, since Aug 2026, sales & purchase invoices** (task #225): required target-location picker (HO/warehouse/outlet), multi-row invoice grouping (consecutive rows, same invoice+date+party), missing-party resolution step (inline bulk create via the standard party paths → ledgers auto-provisioned, then in-place re-validation), invoice/bill numbers preserved as-supplied (never renumbered, allocator untouched; uniqueness validated in-file and against the DB — sales globally, purchases per-vendor). Commits route through logic identical to POST /sales & /purchases (`api-server/src/lib/importTransactions.ts`): FEFO lot consumption, business-dated stock_ledger, weighted-avg cost, settlement model (cash/UPI/bank settle at creation; credit carries dues, paid-amount becomes a sale_payments collection / payment allocation voucher), GST via `lineTaxHeads()`. Batch rollback is all-or-nothing in one transaction via reversal-equivalent logic (stock restored, avg cost unwound with qty, settlements deleted) and refuses per-document when downstream activity exists (payments, returns, consumed lots, transfer links). **Receipt & payment voucher imports** (task #226, `api-server/src/lib/importVouchers.ts`): one row = one voucher (voucher numbers kept verbatim, blank → sequence allocator), received-in/paid-from column maps to real cash/bank ledgers (blank/"cash" → location cash till, mirror-aware; "bank" → unique STD-BANK leaf; else exact ledger-name match), explicit against-invoice settles only that document while blank refs auto-allocate FIFO oldest-first with a running outstanding shared across the file, excess parks as CADV/VADV advances consumable like manual ones, provenance `source='allocation'` (edit-locked, books derive automatically). Preview shows the planned allocation per row; commit recomputes it on locked rows. Rollback unwinds allocations and advances in one transaction and refuses (409, per-voucher reasons) when an advance was already consumed downstream.

One unified sidebar for all users (no per-role nav forks); links are permission-filtered.

## 3. Database (69 tables, no triggers, 4 business sequences)

All DDL ships via boot migrations in `api-server/src/index.ts` + `src/migrations/` (logged in `migration_log`/`boot_status`). Business sequences: `purchase_batch_seq`, `item_code_seq_item`, `item_code_seq_material`, `item_code_seq_raw_material`. Voucher/invoice numbering uses `voucher_sequences` (PK `voucher_type, fy_label`) — never COUNT(*).

| Category | Tables |
|---|---|
| **Master** | items, materials, raw_materials, customers, vendors, employees, warehouses, outlets, account_ledgers, asset_categories, assets, hierarchies, cash_bank_accounts, bom_templates, item_prices, coupons, pay_components |
| **Transactional** | sales, sale_payments, sales_returns, purchases, purchase_returns, productions, stock_transfers, stock_entries, stock_batches, stock_reservations, journal_vouchers, journal_voucher_lines, receipts, payments, expenses, cash_deposits, reconciliation_batches(+items), asset_purchases, asset_transfers, asset_disposals, attendance, attendance_punches, leaves, payroll, employee_advances, salary_accruals, rent_accruals, rent_periods, rent_payments, opening_balances, invoice_share_links, quotations, quotation_share_links, stock_verifications |
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
| Employees | Auth (username), HR, attendance, payroll, salary accrual; auto `SAL-EMP-`/`SAL-PAY-`/`ADV-EMP-` ledgers |
| Chart of Accounts | Everything financial; `SYS-*` roots → `STD-*` containers → auto party/branch/rent/salary ledgers; `code` never client-writable |
| Warehouses / Outlets | LBAC scope, stock location, GSTIN for transfer classification, seller identity on invoices (seller = location, never company), rent agreements; a place can exist as BOTH warehouse and outlet sharing one cash ledger (mirror locations) |
| GST config | Slab rates on items; company + per-location GSTINs; `lineTaxHeads()` is the single tax-math authority |
| Bank accounts | cash_bank_accounts + STD-BANK ledger children; contra/deposits/reconciliation |
| Permissions/Hierarchy | Single-root role tree, per-page rights (§9) |

## 5. Inventory Flow

**Truth stores:** `stock_entries` = authoritative on-hand per location · `stock_batches` = additive lot layer (mfg/expiry/unit_cost; shortfall = "Untracked") · `stock_ledger` = append-only audit (business-date `txn_date`; Closing(D)=Opening(D+1)) · `stock_reservations` = `hold` (reduces available) and `in_transit` (already deducted from sender, sender-owned for valuation).

Movements (all write stock_entries + batches + stock_ledger inside one transaction, lock order: labour day+location → item → rows):
1. **Opening stock** at item creation → credit entry + batch.
2. **Purchase** → batches `PUR-YYYYMMDD-NNNNN` (allocator sequence), stock valued at **taxable value** (net of GST + discount), weighted-avg cost update; edits refused once goods moved (floor-at-zero reversals would invent stock).
3. **Production** → BOM-guided FEFO consumption (`planFEFO`: expiry ASC NULLS LAST) with clamped batch takes, output credited at absorption cost (materials at current cost + overhead %; wastage never enters stock); delete reverses stock AND avg cost (permanently within data limits).
4. **Two-step transfer** (always) → dispatch deducts source + creates `in_transit`; receive releases + credits destination. Cross-GSTIN transfers also write real sale/purchase rows (§6).
5. **Sale** → FEFO (or manual batch) consumption; **cancellation** is terminal — every write path (payments, returns) re-checks it after the row lock; returns restore batches.
6. **Verification/adjustment** → stock_verifications + corrective entries.
7. **Expiry** — tracked per batch; reports read expiry dates (proactive alerts = backlog task #56).

**Valuation:** ONE at-cost engine (`stockValuationRows`) = on-hand (3 material kinds) + sender-owned in-transit; feeds Stock report, Dashboard tile and P&L closing stock identically. Movement/ageing class = last OUTBOUND. Negative stock blocked by DB CHECK.

## 6. Accounting Flow (every posting)

Single source of truth: `buildDerivedPostings()` (routes/journal.ts) derives the entire double-entry stream from documents on demand; `buildBooks()` (lib/books.ts) turns it into every statement. Opening balances live outside the stream and are folded in by buildBooks/ledgerBalances.

| Event | Postings |
|---|---|
| Sale | Dr Cash/Elec-Clearing (settled legs) + Dr `CUST-n` (credit remainder) / Cr location Sales + Cr Output CGST+SGST or IGST (via `lineTaxHeads`, paise split = half + exact remainder) |
| Sale-linked receipt | **Excluded** from stream (sale already carries the settlement) — double-count trap |
| Purchase | Dr Purchases + Dr Input GST / Cr `VEND-n` (settlement per mode) |
| Receipt / Payment | Dr received_in / Cr received_from · Dr paid_to / Cr paid_from. Bill-wise settlement (Aug 2026): vouchers may carry `allocations` (`[{saleId\|purchaseId, amount}]`) + `advanceAmount` → `source='allocation'`, edit-locked, delete = full unwind (409 once the advance slice is consumed). Excess parks on `CADV-n` (liability) / `VADV-n` (asset) advance ledgers; the voucher leg splits the advance slice to the advance ledger. Allocation receipts write `sale_payments` rows via `clearing_receipt_id` (excluded from stream → pass `receiptadv` posts the advance slice); vendor side uses `payment_bill_allocations` + `purchase_advance_applications`. Sales/purchases accept `useAdvance:true` → auto-adjusts (method `advance` / pass `purchadv`), capped at min(available, total). Explicit-first rule: pinned money never enters the payables FIFO pool. `GET /accounts/settlement-context` + `/accounts/party-advance` feed the forms; ageing reports show per-party `advance` (ledger-anchored/company-wide views) and seed advance-only parties. Purchase guards: delete/vendor-edit refused with allocations (`BILL_HAS_ALLOCATIONS`), total below applied advance refused. Consumption attribution: `advance_consumptions` pins every consumed slice to its parking voucher (FIFO oldest-first, NULL source = JV-funded); voucher delete guard checks these references first (precise) then the aggregate balance (backstop). Sale cancel: real payments still block (PAYMENTS_RECORDED); advance-only payments are unwound instead — advance restored atomically in the cancel txn. |
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

## 11. GST Flow

- Slab-locked rates (0/5/12/18/28 — enforcement task #14 open), item-level HSN, price modes inclusive/exclusive.
- `lineTaxHeads()` is the ONLY tax-math path (server and client agree); CGST/SGST = half + exact paise remainder (never two independent rounds); IGST on inter-state by place of supply.
- Line discounts net into taxable value pre-tax; bill-level coupon is post-tax only (`discount_total`).
- **Sale MRP floor (Aug 2026):** line `unitPrice` ≥ item master MRP on create AND edit (server `checkMrpFloor` + POS field validation; 400 `MRP_BELOW_MASTER`); reductions only via discounts. Edits grandfathered: floor = min(master, lowest stored line price). Items with mrp 0 have no floor; quotations exempt (check sits outside `buildSaleLines`).
- Head-wise Output/Input CGST/SGST/IGST ledgers; GSTR-1 B2B/B2C split; GSTR-3B with ITC set-off; HSN summary; reconciliation report ledger-vs-register.
- **Known gap (task #54):** credit/debit notes do not yet reduce GST returns.

## 12. HR Flow

Attendance: multi-punch (`attendance_punches`), paid on TOTAL closed-session hours; day boundary = company timezone. Leave: pending = zero pay; approval stamps attendance under the lock; rejection never writes 'absent'; revert = DELETE. Payroll: draft→approved→paid; statutory PF/ESI at snapshotted rates; approved runs locked — corrections are reversals; advances auto-deducted at generation. Leave policy (Aug 2026): company-wide `payrollWorkingDays` (30) / `paidCasualLeavesPerMonth` (4) / `lopEnabled` in general_settings; half day = 0.5 leave; leave beyond the allowance deducts LOP at salary/workingDays; per-employee working-days retired; `payroll.paid_leave_used/allowed` snapshot per run (NULL = pre-policy). Salary accrual: daily P&L recognition from attendance (unrounded rate, copied verbatim from payroll's expression); approval re-checks attendance inside the lock. Rent: agreements per warehouse; daily accrual; partial payments; revision regenerates the unapproved month.

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
