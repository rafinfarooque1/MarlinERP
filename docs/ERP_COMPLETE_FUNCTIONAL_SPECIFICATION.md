# Marlin Frozen Fruits ERP — Complete Functional & Technical Specification

> **Provenance.** Produced August 10, 2026 by read-only inspection of the live codebase and development database (real business data; production checked read-only where noted). Nothing was modified during this discovery. Where a fact could not be established from code or schema it is marked **NOT FOUND / NOT IMPLEMENTED / PARTIALLY IMPLEMENTED / UNCLEAR / NOT VERIFIED** rather than guessed. Companion document: `docs/ERP_SYSTEM_AUDIT.md` (audit history, scores, health-check addenda). Where that audit and current code disagree, this document follows the code.

## 1. Executive Summary

**What it is.** A full multi-location ERP for Marlin Frozen Fruits — an Indian frozen-fruit/food business selling through a head office, warehouses and retail outlets. It runs the entire operation: point-of-sale and invoicing, quotations, purchases, batch/expiry-tracked inventory, production (raw materials → finished goods), inter-branch stock transfers, GST compliance (B2B/B2C series, GSTR-style returns), complete double-entry books (trial balance, P&L, balance sheet, day/cash/bank books, party ledgers, receivables/payables), payroll and HR (multi-punch attendance, leave, advances, statutory PF/ESI), expenses with daily rent/salary accrual, cash & bank management with electronic-collection reconciliation, month locking, a data-import/migration wizard for legacy software, PDF/share invoice delivery, and a mobile employee app.

**Who uses it.** A small hierarchy of staff: a level-1 Administrator (full access), view-only Management, and location-bound branch/outlet users whose every read and write is scoped to their own location (LBAC) on top of page/action permissions (RBAC, default-deny).

**Shape of the system.** A pnpm monorepo with three runtime pieces and shared libraries:
- `artifacts/api-server` — Express 5 + raw PostgreSQL (partial Drizzle typing), one API for all clients.
- `artifacts/marlin-erp` — React 18 + Vite web app (the main UI, path-routed).
- `artifacts/employee-app` — Expo/React Native self-service app (attendance, payslips).
- `lib/*` — generated OpenAPI clients/hooks and shared packages.

**The two architectural signatures** a newcomer must internalize before touching anything:
1. **The books are derived, not stored.** With the narrow exception of the manual journal-voucher family, no document writes double-entry rows. Every statement (TB, P&L, BS, ledgers, books, GST, dashboard) is computed on read by one posting builder that walks the documents (sales, purchases, receipts, payments, payroll, accruals, transfers, notes…). Statements therefore cannot disagree with each other — and "fixing the books" always means fixing the *document* or the *derivation*, never inserting a balancing entry.
2. **Inventory is a three-layer truth.** `stock_entries` holds authoritative quantities; an additive batch/lot layer provides FEFO consumption with expiry; an append-only `stock_ledger` provides the audit trail with business-dated backdating. The quantity column on the item master is stale by design and must never be read.

**Operational conventions that keep it safe:** every schema change ships as an idempotent boot migration (one-shot `migration_log` guards; `drizzle-kit push` is forbidden — the Drizzle schema is a partial view); money paths serialize on advisory/row locks; document numbering uses atomic FY-scoped allocators (never `COUNT(*)`); location-scoped reads answer 404 (not 403) for foreign records; destructive paths are guarded and month-locked (HTTP 423).

**Current state.** Live and in daily production use. Books reconcile to the paisa on real data (TB ₹2,442,715.33 = both sides; BS balanced; GSTR-1 ties to the invoice register exactly, Aug 10, 2026). Overall health 90/100 per the most recent audit; the open-item list is short and tracked (see §34).

**How to read this document.** Sections 2–6 give architecture, modules, roles, locations and master data. Sections 7–16 walk every transactional module. Sections 17–19 explain the accounting engine — read §17 before anything else if you plan to modify money behaviour. Sections 20–27 cover inventory, production, payroll, GST, imports and reports. Sections 28–33 map permissions, database, APIs, jobs, business rules and flows. Sections 34–38 close with bugs, limitations, production behaviour and a worked end-to-end example.

## Table of Contents

1. Executive Summary — 2. Architecture — 3. Module List — 4. User Roles — 5. Location Architecture — 6. Master Data — 7. Sales — 8. POS — 9. Quotations — 10. Purchases — 11. Returns — 12. Receipts — 13. Payments — 14. Journals — 15. Expenses — 16. Cash & Bank — 17. Accounting — 18. Chart of Accounts — 19. Ledgers — 20. Inventory — 21. Production — 22. Payroll — 23. GST — 24. B2B/B2C — 25. Month Locking — 26. Import/Migration — 27. Reports — 28. Permissions — 29. Database — 30. APIs — 31. Background Jobs — 32. Business Rules — 33. Transaction Flow Maps — 34. Known Bugs — 35. Current Limitations — 36. Production Behaviour — 37. Complete End-to-End Example — 38. Final System Summary

---

## 2. Architecture

This section describes the full technical stack of the Marlin Frozen Fruits ERP, how the tiers communicate, and the cross-cutting subsystems (authentication, authorization, accounting, inventory, multi-location, reporting, import/export, boot jobs, and audit). Every non-obvious claim cites a workspace-relative path.

### 2.1 Repository layout & artifacts

Four artifacts live under `artifacts/`:

| Artifact | Path | Kind | Preview path |
|---|---|---|---|
| API Server | `artifacts/api-server` | Express 5 + TypeScript API (esbuild bundle, raw `pg` + partial Drizzle) | `/api` |
| Marlin Frozen Fruits ERP | `artifacts/marlin-erp` | React 18 + Vite web SPA | `/` |
| Marlin Employee App | `artifacts/employee-app` | Expo (React Native) mobile app | `/employee-app/` |
| Canvas / mockup-sandbox | `artifacts/mockup-sandbox` | design sandbox (not part of the running ERP) | `/__mockup` |

Shared packages live under `lib/`:
- `lib/db` — Drizzle schema + pooled `pg` connection (`@workspace/db`). **The Drizzle schema is a PARTIAL view of the database** — many columns/tables ship only via boot migrations and are invisible to `db.select()` (must be read/written with raw SQL). Verified: `receipts.source`, `sale_payments.source`/`clearing_receipt_id`, `sales.other_charges`/`purchases.other_charges` (raw JSONB), `employees.must_change_password`, `employees.ui_location_pref`, `warehouses.disabled_at` all exist in the live DB but are accessed via `pool.query` in code.
- `lib/api-spec` — OpenAPI spec (source of truth for request/response shapes).
- `lib/api-client-react` — generated fetch hooks (Orval-style) + custom fetch wrapper (`src/custom-fetch.ts`), consumed by both web and mobile.
- `lib/api-zod` — Zod validators (e.g. `LoginBody` used in `routes/auth.ts:18`).
- `lib/pdf-kit`, `lib/purchase-pricing` — helper packages.

### 2.2 Frontend tech (marlin-erp)

- React 18 + Vite SPA. Router is **wouter** (`artifacts/marlin-erp/src/App.tsx:4` imports `Route, Switch, Router as WouterRouter, useLocation, Redirect, Link`). Path-based routing (no hash router) — routes such as `/dashboard`, `/sales/pos`, `/accounts/vouchers` are declared as `<Route path=…>` inside a `<Switch>` (App.tsx `Router()` from line 184).
- Data layer: TanStack Query via the generated hooks in `lib/api-client-react`.
- UI: Tailwind + Radix primitives (`src/components/ui/*`), Recharts for dashboard charts.
- Route guarding: `AuthGuard` + `RoutePermissionGuard` (`src/components/RoutePermissionGuard.tsx`) wrap protected routes; a convenience wrapper combines them (App.tsx ~line 159-183). `usePermission` mirrors the server permission rules client-side (server remains authoritative).
- Retired/redirected routes exist: e.g. `/production/stock-transfer`, `/headoffice/transfers` both `<Redirect to="/transfers" />` (App.tsx:223-224).

### 2.3 Mobile tech (employee-app)

Expo (React Native) using expo-router file-based routing. Screens (verified `artifacts/employee-app/app/`):
- `app/login.tsx` — login
- `app/(tabs)/index.tsx`, `attendance.tsx`, `leaves.tsx`, `payslips.tsx` — the four employee tabs
- `contexts/AuthContext.tsx`, `components/ChangePasswordModal.tsx` — forced password-change flow.
The app calls the same API server through `lib/api-client-react`, configuring a remote base URL and bearer-token getter (`setBaseUrl` / `setAuthTokenGetter` in `lib/api-client-react/src/custom-fetch.ts`).

### 2.4 Backend tech (api-server)

- Express 5 + TypeScript, bundled to CJS with esbuild. Most database access is **raw `pg`** via a pooled `pool` (`@workspace/db`); Drizzle `db` is used for a subset.
- App assembly: `src/app.ts` builds the Express app; `src/index.ts` runs boot migrations and opens the port. `src/routes/index.ts` mounts all routers under `/api`.
- Middleware chain (order, `src/app.ts`):
  1. `pino-http` request logging (`src/app.ts:10-28`, logger from `src/lib/logger.ts`).
  2. CORS (`src/app.ts:39-55`). `ALLOWED_ORIGINS` (comma-separated) gates origins in production; unset → allow all (dev). `x-refreshed-token` is exposed so clients can upgrade tokens.
  3. Body parsing: `POST /api/imports/parse` gets `express.raw({ limit: "10mb" })` **before** JSON so the workbook upload arrives as a Buffer (`src/app.ts:62`); everything else `express.json({ limit: "1mb" })` + `urlencoded` (1 MB cap) (`src/app.ts:64-65`).
  4. Global `requireAuth` gate on `/api` (`src/app.ts:71-91`) with an explicit allow-list (see §2.5).
  5. `app.use("/api", router)` (`src/app.ts:93`).
  6. Global JSON error handler (`src/app.ts:99-124`): CORS → 403; `entity.too.large` → 413; `entity.parse.failed` → 400; messages containing `"stock write refused"` → 409; else 500 `{error:"An unexpected server error occurred"}`.
- Routers mounted (`src/routes/index.ts`): health, auth, dashboard, assets (mounted **before** inventory to avoid `/assets/:id` swallowing `/assets/categories` etc. — index.ts:44-46), inventory, branches, purchases, production, stock, inventory-batches, sales, payments, reconciliation, cash-in-outlet, hr, customers, accounts, journal, periods, gst, company, audit, publicInvoices, invoiceShareLinks, quotations, publicQuotations, quotationShareLinks, pdfGen, returns, bom, reports, financialReports, search, storage, rent, backup, imports. (38 router modules under `src/routes/`.)
- PDF generation is server-side only (`src/services/*`: `invoicePdf.ts`, `challanPdf.ts`, `payslipPdf.ts`, `moneyVoucherPdf.ts`, `expenseVoucherPdf.ts`, `reportPdf.ts`, `reportXlsx.ts`).
- File storage: GCS via `src/lib/objectStorage.ts` + `objectAcl.ts` (asset bills/attachments, presigned uploads, DB backups).

### 2.5 How the tiers communicate

- **Path-based routing / PORT binding:** the server reads `process.env.PORT` (required — throws if missing, `src/index.ts:2753-2756`) and calls `app.listen(port, …)` (`src/index.ts:2759`). **The port is opened FIRST, then migrations run in the background** so autoscale deployments do not kill the process on a startup timeout; `/healthz` returns 503 until `app.locals.migrationsReady` flips true (`src/index.ts:2747-2759`, ~4105). All API paths are prefixed `/api`; the Replit proxy maps `/api` to this server and `/` to the web SPA.
- **Generated API client hooks:** the web app and mobile app both consume `lib/api-client-react` (TanStack-Query hooks generated from `lib/api-spec`). The spec **gates writes** — fields absent from the spec are stripped before sending (per audit; the codegen contract). `src/index.ts` files under `lib/api-client-react/src` (e.g. `vouchers.ts`, `journal.ts`, `dashboard-bi.ts`, `imports.ts`) provide hand-written hook layers over the generated `generated/` output.
- **Auth token wiring (web):** `artifacts/marlin-erp/src/main.tsx:9-11` registers `setAuthTokenGetter(() => localStorage.getItem('marlin_auth_token'))` and a matching setter, plus `setUnauthorizedHandler` and `setLocationContextGetter`. The custom fetch attaches `Authorization: Bearer <token>` on every call and honours `x-refreshed-token` rotation (`lib/api-client-react/src/custom-fetch.ts`). Downloads that bypass hooks read the same key (`src/lib/download.ts`).
- **Location context header:** a `LocationContextGetter` lets the client attach the current UI location selection to requests; the server treats it as a *request*, not authority (see §2.9 LBAC).

### 2.6 Authentication

Implemented in `routes/auth.ts`, `middleware/auth.ts`, `lib/token.ts`, `lib/password.ts`, `lib/passwordPolicy.ts`.

- **Login:** `POST /auth/login` (`routes/auth.ts:103`). Body validated by `LoginBody` (Zod). Username is trimmed; lookup normalizes both sides with `LOWER(TRIM(username))` (matches the unique index and lockout key), so "Admin" / "admin " reach the same account (`routes/auth.ts:146-153`).
- **Password hashing:** bcryptjs via `PasswordService.verify` / `.hash` (`lib/password.ts`, called at `routes/auth.ts:157,246`). `password_hash` is NEVER returned in any response (`buildEmployeeResponse`, `routes/auth.ts:50-100`). Failures return a generic `Invalid username or password` (no user enumeration; `routes/auth.ts:169`).
- **Bearer tokens — HMAC v2:** `lib/token.ts`. Format `v2.<base64url(id:username:issuedAtMs)>.<base64url(HMAC-SHA256)>`, signed with `SESSION_SECRET` (server refuses to boot if unset — `lib/token.ts:17-24`). `signToken(id, username)` stamps `Date.now()` (`token.ts:47-50`). `verifyToken` uses `timingSafeEqual` on the signature; rejects wrong format, missing `issuedAt`, and expired tokens (`token.ts:59-94`). **Legacy unsigned tokens are rejected** (must be `v2.`).
- **8-hour expiry:** `TOKEN_MAX_AGE_MS = TOKEN_MAX_AGE_HOURS (default 8) × 3600 × 1000` (`token.ts:26-28`); `verifyToken` rejects tokens older than that (`token.ts:91`).
- **requireAuth:** `middleware/auth.ts:146-195` — validates the Bearer token, re-loads the employee row (`is_active` re-checked), and attaches `req.employee = {id, username, hierarchyId, branchType, branchId, isActive}`. Any failure → 401. Applied globally except the allow-list in `app.ts:71-91`: `GET /health`, `GET /healthz`, `GET /healthz/schema`, `POST /auth/login`, and `GET` on `/public/invoices/*`, `/public/quotations/*`, `/share/invoice/*`, `/share/quotation/*` (HMAC-tokenized public links).
- **mustChangePassword:** returned at login and `/auth/me` (`COALESCE(must_change_password,false)`, `routes/auth.ts:149,272`). `POST /auth/change-password` (`routes/auth.ts:206`) verifies the current password (a wrong current field returns **400, not 401**, so the client does not eject the session — `routes/auth.ts:238-244`), enforces `validatePassword` policy, then sets `must_change_password = false` (`routes/auth.ts:246-250`).
- **Login lockout table + rate limiting:** durable per-username limiter backed by `login_lockouts` (`middleware/auth.ts:41-127`). 5 failures within a 15-minute window → 15-minute lock (`MAX_FAILURES=5`, `LOCKOUT_MINUTES=15`, `WINDOW_MINUTES=15`). Implemented as one atomic upsert (`ON CONFLICT … DO UPDATE`) so concurrent failures serialize on the row (`recordLoginFailure`, `auth.ts:86-122`). `checkLoginLock` runs before any credential work; a genuine lock returns **429** with `Retry-After` and `lockedUntil` (`routes/auth.ts:122-138`). A successful login `clearLoginFailures` (deletes the row, `auth.ts:125-127`). `getActiveLockouts` feeds the Login History page.
- **Login audit:** `login_attempts` rows are inserted fire-and-forget on every attempt (success or failure) with username, employee_id, success, ip (`::ffff:` stripped), user_agent (300-char cap), reason (`routes/auth.ts:27-38,130,165-168,187`). Every auth event also writes an `activity_log` row via `logActivity` (LOGIN_SUCCESS / LOGIN_FAILED / LOGOUT / PASSWORD_CHANGED).
- **Other auth endpoints:** `POST /auth/logout` (logs only), `GET /auth/me`, `PUT /auth/location-pref` (persists a *display* preference `ui_location_pref` — never authority), `PATCH /auth/profile` (self-service profile edit).

**Business rules (implemented):**
- Server refuses to start without `SESSION_SECRET` (`token.ts:17-24`) or `PORT` (`index.ts:2753-2756`).
- Tokens expire after 8 hours (env-overridable); legacy/unsigned tokens are rejected.
- Usernames are matched case-insensitively and trimmed on both sides.
- 5 failed logins per 15-minute window locks the account for 15 minutes, durably (survives restart), returning 429.
- Deactivated accounts (`is_active=false`) are blocked at login (403) and at `requireAuth` (401).
- `password_hash` never leaves the server; login failures are indistinguishable between "no such user" and "wrong password".

### 2.7 Authorization model overview

Implemented in `middleware/permissions.ts` (server) + `marlin-erp/src/lib/moduleRegistry.ts` / `usePermission` (client mirror).

- **Page-permission rows keyed `page:<href>`:** one `permissions` row per hierarchy × sidebar link. The key is `page:` + the link's `href` (`moduleRegistry.ts:138-142` `pagePermKey`, prefix `page:/…`). Example keys: `page:/accounts/vouchers`, `page:/accounts/day-book`, `page:/headoffice/inventory-reports`. The registry (`MODULE_REGISTRY`) is the single source of truth for the sidebar, the Permissions page, and the permission keys (64 `href:` entries in the registry). A key that is not a registered page can never be granted/revoked; a build-time check (`scripts/src/check-permissions.ts`) fails on unregistered keys.
- **Five-action model:** `view` (`requireModuleView`) plus `add`/`edit`/`delete`/`download` (`requireModuleAction`, `ModuleAction` type, `permissions.ts:94-108`). Columns `can_view/can_add/can_edit/can_delete/can_download`. Legacy `can_print`/`can_approve`/`can_share` still exist but are **write-mirrors** of `can_download`/`can_edit` and must never be read (`permissions.ts:80-92`).
- **Default-deny:** a missing permissions row = denied; access requires an explicit `can_*=true` row (`permissions.ts:56-58,147-148`). `requireModuleView`/`requireModuleAction` accept an any-of list (an endpoint feeding several pages is allowed if the caller holds any one).
- **Level-1 bypass:** hierarchy `level === 1` = full access, always (`permissions.ts:51-54,142-145`). Guards exist on level-1 create/delete of hierarchies too, not just edit.
- **Hierarchy tree with derived levels:** single-root `hierarchies` table. `level` is **DERIVED from the reporting chain** — root = 1, child = parent.level + 1 (`routes/hr.ts:931-986`). A reparent re-derives the level of the role AND everything below it in one transaction under an advisory lock, so the chain and levels can never disagree (`routes/hr.ts:1030-1066`). The top-level role cannot report to another role (`hr.ts:1008-1009`); a role cannot be deleted while employees hold it or others report to it.
- **Enforcement order:** `requireAuth` → RBAC page right (**403**) → LBAC location scope (**404**) → business logic. Frontend mirrors via `usePermission`/`RoutePermissionGuard` but the server is authoritative. Denials are written to `activity_log` as `PERMISSION_DENIED` (`permissions.ts:64-70,154-160`).
- **`hasModuleAction` / `canViewStockValuation`:** for permission checks that shape a response instead of rejecting (e.g. hiding stock cost). The inventory-valuation right reuses the `page:/headoffice/inventory-reports` key (`permissions.ts:216-233`): commercially sensitive value columns are **omitted** from payloads for roles without it, never merely hidden in the UI.
- **`requireHeadOffice`:** an orthogonal location guard for company-wide master data (item masters etc.). It asks "may this LOCATION write?" — non-headoffice branch types get 403 `HEAD_OFFICE_ONLY` (`permissions.ts:248-271`). Both the RBAC right and this location guard must pass.
- **LBAC (location-based access control):** `lib/dataScope.ts` + `lib/moneyScope.ts`. `getUserDataScope(employee)` derives scope purely from `branch_type`/`branch_id` (never from client params): headoffice → all; warehouse → itself + its outlets (`warehouse_id = branchId`); outlet → itself only (`dataScope.ts:66-94`). SQL helpers append parameterized WHERE fragments per table shape: `scopeSalesWhere` (COALESCE over `location_type/location_id`, falling back to legacy `outlet_id`), `scopeBranchWhere` (`branch_type/branch_id`), `scopeLocationTypeWhere`, `scopeTransferWhere` (either endpoint). Money vouchers use narrower own-location scope (`lib/moneyScope.ts`: `callerLocation`, `ownLocationScope`, `foreignPartyLedgerIds`, `locationOwnedLedgerMap`). Foreign ids return **404**, never 403.

**Business rules (implemented):**
- Access is default-deny; only an explicit `can_*=true` row grants it, except level-1 which bypasses all checks.
- Hierarchy level is computed from the reporting chain, never stored independently; reparenting re-derives the whole subtree under an advisory lock.
- Sensitive money/valuation fields are omitted from the payload for unauthorized roles, not just visually hidden.
- Head-Office-only writes on shared masters are enforced by branch type independently of RBAC.

### 2.8 Accounting architecture — DERIVED books (KEY)

**The books are derived, not stored.** For most flows there are **no stored double-entry journal lines**. Instead, `buildDerivedPostings()` (`routes/journal.ts:919-1541`) derives the entire double-entry posting stream from the source documents on demand, and `buildBooks()` (`lib/books.ts:570`) turns that stream into every statement.

The only source that stores real ledger lines is the **journal-voucher family** (journal, contra, credit_note, debit_note) in `journal_vouchers` + `journal_voucher_lines`. Everything else (sales, purchases, receipts, payments, expenses, rent, salary, transfers) is derived at query time.

`buildDerivedPostings({toDate?, q?})` returns `Posting[]` (`routes/journal.ts:882-903`): each posting has `date` (normalized YYYY-MM-DD), `entryId` (stable source-document identity, e.g. `sale:123`, `purchase:45`, `jv:9`, `payment:3`, `receipt:8`, `rent:…`, `salary:…`), `ledgerId`, `debit`, `credit`, `source`, `voucherNumber`, `description`, and `locationType`/`locationId` (both legs of one entry carry the SAME location stamp, so any location slice stays balanced). A `push` helper drops zero legs and normalizes dates (`journal.ts:932-945`). Ledger resolution is by `code` (`STD-CASH`, `STD-BANK`, `STD-SALES`, `STD-DTX`, `STD-PUR`, `STD-ELEC-CLR`, `SYS-DEBTORS`, `SYS-CREDITORS`, `STD-BRANCH-TRF/-DEBTOR/-CREDITOR`, `STD-OUT-CGST/-SGST/-IGST`, `STD-INP-CGST/-SGST/-IGST`, `journal.ts:962-971,1144-1145`). Per-location cash/sales/purchase ledgers come from `warehouses`/`outlets` (`journal.ts:978-983`).

Derivation sections (all in `buildDerivedPostings`):
1. **Payments** (`journal.ts:985-1020`): Dr `paid_to` / Cr `paid_from`. A vendor-advance slice debits the vendor-advance asset ledger (`advance_ledger_id`) instead of the payable.
2. **Receipts** (`journal.ts:1022-1049`): Dr `received_in` / Cr `received_from`. **Sale-linked receipts are EXCLUDED** — those whose id is a `sale_payments.clearing_receipt_id` OR whose `voucher_number` is a sale `invoice_number` — because the sales section already carries the settlement (double-count trap, `journal.ts:1022-1036`).
2b. **Allocation-receipt advance slice** (`journal.ts:1051-1076`): the excess of a bill-wise settlement receipt (Dr received_in / Cr the customer's own ledger — the customer advance is simply that ledger's credit balance).
3. **Journal voucher lines** as stored (`journal.ts:1078-1110`): journal/contra/credit_note/debit_note. Most are company-level (no location). Two exceptions inherit a location: return vouchers inherit their source sales_return/purchase_return location; system vouchers with a branch-till money leg carry their own stamp (`COALESCE(sr…, pu…, v.location_type)`).
4. **Direct expenses** (`journal.ts:1112-1139`): Dr expense ledger / Cr the paying account's `CBA-{id}` ledger (falling back to `STD-BANK`/`STD-CASH`).
5. **Sales** (`journal.ts:1141-1370`): Cr location Sales ledger for `net = total − tax − otherCharges`; Cr Output CGST/SGST/IGST split via `lineTaxHeads()` with a paise-remainder to `STD-DTX` (falls back to a single Duty & Tax lump when the split is inconsistent); Cr each Other-Charge expense ledger (expense recovery). **Gross debtor model**: when the sale names a customer with a provisioned `CUST-n` ledger, Dr `CUST-n` for the full total at sale_date + a Cr `CUST-n` leg per `sale_payments` collection at its payment_date (advance-method rows form a visible Dr/Cr wash). Walk-in / missing-ledger sales keep the old net shape (Dr settled legs + Dr remainder on `SYS-DEBTORS`, `journal.ts:1275-1281,1349-1369`). Cancelled sales post nothing, except cancelled **branch-transfer** invoices which stay in (their credit note reverses them, `journal.ts:1148-1160`). Branch-transfer invoices credit `STD-BRANCH-TRF` and debit `STD-BRANCH-DEBTOR` instead of Sales/cash (`journal.ts:1218-1265`).
6. **Purchases** (`journal.ts:1372-1439`): Dr Purchases (taxable, net of input GST) + Dr Input CGST/SGST/IGST (only when the head split is internally consistent, else a lump) + Dr each Other-Charge expense ledger / Cr `VEND-n` = goods + charges. Branch-transfer inward legs use `STD-BRANCH-CREDITOR`/`STD-BRANCH-TRF`.
6b. **Vendor advances consumed by bills** (`journal.ts:1441-1464`): Dr `VEND-n` / Cr `VADV-n`, dated with the bill.
7. **Warehouse rent** (`journal.ts:1466-1502`): daily derived Dr `expense_ledger_id` / Cr `payable_ledger_id` from `rent_accruals` — ungated by approval (approval only locks the month; payments are real vouchers via section 3).
8. **Salary** (`journal.ts:1504-1538`): daily derived Dr `SAL-EMP-n` / Cr `SAL-PAY-n` from `salary_accruals`, stamped with the employee's branch. Payroll approval writes a real true-up voucher for the delta; payments are vouchers.

`buildBooks()` (`lib/books.ts:570`) consumes the posting stream and folds in **opening balances** (which live OUTSIDE the stream, in `opening_balances`, `books.ts:662-676`) to produce Trial Balance, Ledger Statement, Day Book, Cash/Bank books, P&L (with opening/closing stock, `closingStockAt`/`stockAsOf`, `books.ts:199-252`), Balance Sheet, and GST figures. Opening-balance balance is asserted (`books.ts:802-804`). Report routes re-export the posting-location filters (`journal.ts:905-917`).

Consequence for a rebuilder: to correct the books you edit the **source document** (or a JV), never a stored posting. Editing a JV replaces its lines in place under the same id + number (`journal.ts:759-778`); every statement re-derives at query time (`journal.ts:610-621`).

**Business rules (implemented):**
- Only journal/contra/credit-note/debit-note vouchers persist ledger lines; all other financial events are derived from documents on demand.
- Both legs of a derived entry carry one identical location stamp; slices always balance.
- Sale-linked receipts are excluded from the receipt derivation to avoid double counting.
- Opening balances are folded in by `buildBooks`, not stored as postings.
- Cancelled sales post nothing (except branch-transfer invoices, which are reversed by a credit note).

### 2.9 Inventory architecture

Three-layer model (verified §5 of the audit + `lib/stockLedger.ts`, `lib/valuation.ts`, `lib/materialStock.ts`, `lib/batches.ts`):
- **`stock_entries` = quantity truth** — authoritative on-hand per location, polymorphic by `material_type` ∈ {item, material, raw_material} with overlapping ids (every query must scope `material_type`). Non-negative stock enforced by DB CHECK (`quantity >= -0.001`).
- **`stock_batches` = additive lot layer** — mfg/expiry/unit_cost per lot; any shortfall vs `stock_entries` is treated as "Untracked". Purchase lots are numbered `PUR-YYYYMMDD-NNNNN` from the `purchase_batch_seq` sequence. FEFO consumption via `planFEFO` (expiry ASC NULLS LAST).
- **`stock_ledger` = append-only audit** (`lib/stockLedger.ts`). One row per movement with `txn_type` (sale, sale_reversal, sale_cancellation, purchase, purchase_reversal, production_consumption, production_output, transfer_out, transfer_in, sales_return, purchase_return), signed `qty_change`, `unit_cost`, `doc_type`/`doc_id`, and a **business `txn_date`** (the document's own date, not insert time; `created_at` is the immutable insert stamp). The ONE narrow exception to append-only: `txn_date` is restated when a document's date is corrected without touching its lines (`stockLedger.ts:1-10,44-59`). Closing(D) = Opening(D+1).
- **`stock_reservations`** — `hold` (reduces available) and `in_transit` (already deducted from sender; sender-owned for valuation).

All movements write `stock_entries` + `stock_batches` + `stock_ledger` inside one transaction (lock order: labour day+location → item → rows). Valuation is a single at-cost engine (`stockValuationRows`) feeding the Stock report, Dashboard tile and P&L closing stock identically (weighted-average cost). See §5 (Inventory) for per-flow detail.

**Business rules (implemented):**
- On-hand quantity lives in `stock_entries`; batches are an additive layer; the ledger is append-only audit keyed on business `txn_date`.
- Every stock query must scope `material_type` (ids overlap across the three kinds).
- Negative stock is blocked by a DB CHECK constraint.
- Stock value derives from one shared valuation engine so report/dashboard/P&L agree by construction.

### 2.10 Multi-location architecture (summary)

- Locations are `headoffice`, `warehouse`, `outlet`. Head Office is a full selling location (id 1 for sales/stock; JV stamp `headoffice`/0 — HO must be matched on TYPE alone, not id, in the posting stream).
- Documents and masters are stamped `location_type` + `location_id`. The client's location context is a *request*, never authority — LBAC recomputes the effective state server-side (`lib/dataScope.ts`, `lib/moneyScope.ts`, `lib/requestLocation.ts`, `lib/postingLocation.ts`).
- Warehouse sees itself + its outlets; outlet sees itself; HO sees all.
- Mirror locations (same place existing as both a warehouse and an outlet) share one cash ledger — reads dedupe, writes resolve across both identities.
- Invoice seller identity = the location (bank/UPI may fall back to company; identity may not).
- Warehouse lifecycle: warehouses can be **disabled** (`disabled_at`/`disabled_by`, reversible; outlets inherit) — every transaction producer checks `disabledWarehouseError()` on the effective location and returns 409 `WAREHOUSE_DISABLED` (`lib/warehouseLifecycle.ts`, e.g. `journal.ts:714-715`). Permanent delete is Super-Admin/level-1 only with a typed-phrase confirmation and an in-transaction integrity re-check.
- `location_migration_map` supports location restamping/merges.

### 2.11 Reporting architecture

Reports derive from the **same posting builder** as the books (`buildDerivedPostings` → `buildBooks`), so a report can never disagree with the statements:
- Financial reports (`routes/financialReports.ts`, `routes/reports.ts`): trial-balance, ledgers, ledger-statement, cash, bank, day-book, gst, salary, expenses. Global filters (from/to + location) narrow LBAC only; HO placeholder matches on type alone.
- GST reports (`routes/gst.ts`): summary, GSTR-1, GSTR-3B, HSN, ledger-vs-register reconciliation, CSV exports; `lib/gst.ts` `lineTaxHeads()` is the single tax-math authority (shared with the sale/purchase derivations).
- Inventory / production / sales / HR reports read the valuation engine and posting stream respectively.
- Reports Center: `marlin-erp/src/pages/reports/ReportsCenter.tsx` + `sections/*`; server-side PDF/CSV/XLSX via `services/reportPdf.ts` / `reportXlsx.ts`.
- Dashboard KPIs (`routes/dashboard.ts`, `lib/dashboardFinancials.ts`): expense/GP/NP/receivables/payables/cash/bank tiles are read from the SAME `buildBooks` output (`companyFinancials`), never re-summed — so tiles agree with statements by construction. Accounting tiles are company-level (postings have no location) and are **null for branch logins** (UI shows —).

**Business rules (implemented):**
- Every financial statement, GST report and dashboard money tile derives from one posting stream + one tax authority; no report re-implements postings or tax math.
- Location filters narrow LBAC only; company-level accounting figures are null for branch users, never zeroed.

### 2.12 Import/Export architecture (summary)

- **Master imports & transaction imports:** `routes/imports.ts` (very large — templates, parse, batch preview, mappings, demo, approve, commit, discard, rollback). `POST /imports/parse` receives the raw workbook Buffer (raw body parser registered ahead of JSON, `app.ts:62`). State lives in `import_batches` / `import_rows` (per-row raw + normalized payloads + created-record links for rollback) and `import_mappings` (permanent name mappings). Transaction commits route through logic identical to `POST /sales` & `/purchases` via `lib/importTransactions.ts` (FEFO consumption, business-dated stock ledger, weighted-avg cost, GST via `lineTaxHeads`). Voucher imports go through `lib/importVouchers.ts` (one row = one voucher; FIFO or explicit allocation; `source='allocation'`).
- **Migration Wizard:** one linear multi-file migration in `import_migrations` (`/imports/migrations/*` endpoints: create, files, mappings, demo, approve, discard, rollback). Uploads sales/purchases/receipts/payments/daybook (+ optional opening stock) together, runs a never-committed demo transaction producing a comparison report pack, then approves at a chosen location in one all-or-nothing transaction (run order opening_stock→purchases→sales→receipts→payments→daybook). Rollback is whole-migration only (level ≤2). All import endpoints are gated by one `PERM` page key with the five-action model (`requireModuleAction(PERM, "add"/"delete"/"download")`).
- **Exports:** covered by the single `download` action right; CSV/PDF/XLSX generated server-side (`services/reportPdf.ts`, `reportXlsx.ts`, `pdfGen.ts`).

### 2.13 Background / boot jobs

- **Startup migrations (the ONLY DDL channel):** `runMigrations()` in `src/index.ts:42` plus `src/migrations/*` modules. All DDL and one-time data backfills ship here — **never run `drizzle-kit push`**. Each one-time step is guarded by a row in `migration_log` (e.g. `std_ledgers_cleanup_v1`, `customer_advances_fold_v1`, `money_voucher_source_backfill_v1`, `username_normalization_v1`, `stock_batches_natural_key_v1`, `sales_payment_backfill_v1`, …). Some steps are **type-driven, not log-gated**, so they self-heal (e.g. `convertTextDateColumns()` inspects the live column type every boot and converts leftover text→date; it runs as its own top-level step, NOT inside `runMigrations`, so an unrelated earlier failure cannot skip it — `index.ts:2627-2745`).
- **Backfills / healing sweeps:** party ledger backfills (`cust_vend_ledger_backfill_v1`), sale-payment leg backfills (`salePaymentLegsBackfill.ts` / `V2`), party-location backfill, warehouse/outlet ledger linking, avg-cost seeds, chart-structure regrouping (`ensureChartStructure`, runs last so per-entity ledgers are regrouped in the same boot — `index.ts:2574-2581`). Cash/bank opening-balance counterweight (`STD-OB-ADJ`) is recomputed under an advisory lock at boot and after every module write.
- **`boot_status`:** every boot records a row (`recordBootStatus`, `index.ts:2591-2625`) with `node_env`, `migrations_ok`, `migrations_error`, `date_columns`, `notes`; written to stderr AND the table because production discards stdout emitted before the port opens. Only the last 50 boots are kept.
- **Port-first boot:** the port opens before migrations complete; `/healthz` returns 503 until `app.locals.migrationsReady` is set (`index.ts:2747-2759`).

**Business rules (implemented):**
- All schema changes and one-time data fixes are applied at boot, guarded by `migration_log` or by live-type inspection; `drizzle-kit` is never used.
- The date-column conversion runs as an independent top-level step so it cannot be skipped by an earlier failure, and refuses the dev hold flag in production.
- Every boot's migration outcome is persisted to `boot_status` for post-deploy inspection.

### 2.14 Audit logging (and what is NOT audited)

- **`activity_log`** via `logActivity` (`lib/audit.ts`): fire-and-forget insert after successful mutations, with `action` (CREATE/UPDATE/DELETE/PERMISSION_DENIED), `module`, `entityType`, `entityId`, `description`, `user`, and structured `metadata` (`before`/`after` for edits/deletes — e.g. JV edit at `journal.ts:782-800`). Logging errors are swallowed so they never break the request. Permission denials are also written here (`middleware/permissions.ts:64-70,154-160`).
- **`created_by` stamping:** documents carry `created_by`/`updated_by`/`updated_at` (e.g. `journal_vouchers.created_by`, `updated_by`; serialized as a `rev` concurrency token, `journal.ts:149,161-164`).
- **`stock_ledger`** is the append-only inventory audit trail (§2.9), separate from `activity_log`.
- **`login_attempts`** records every login attempt (success + failure) with ip/user_agent/reason (`routes/auth.ts:27-38`); `login_lockouts` holds the durable rate-limit state.
- **`boot_status`** audits each boot's migration outcome (a diagnostic tail, not a permanent audit — trimmed to 50 rows).
- **What is NOT audited / NOT VERIFIED as audited:**
  - `logActivity` is best-effort and non-transactional: a mutation that commits but whose audit insert fails leaves no `activity_log` row (by design, `audit.ts:41-44`).
  - Pure **reads** are not audited (only PERMISSION_DENIED denials are).
  - `login_attempts.ip` records the request IP as seen by the server (`req.ip` with `::ffff:` stripped); behind a proxy this may be the proxy address unless trust-proxy is configured — **NOT VERIFIED** that a real client IP is captured in all deployments.
  - There is no dedicated field-level change history table beyond the `metadata.before/after` blobs on specific edit routes; coverage of before/after is per-route, not universal — **PARTIALLY IMPLEMENTED**.

**Business rules (implemented):**
- Mutations write a best-effort `activity_log` row; the log never blocks or fails the request.
- Login attempts and lockout state are persisted independently of the activity log.
- The stock ledger and boot_status provide domain-specific append-only trails; reads are not logged.

---

## 3. Module List

Every module below is enumerated by walking `marlin-erp/src/pages/` and `api-server/src/routes/` exhaustively. Modules map to sidebar links (permission key `page:<href>`) unless noted as retired/hidden. Sidebar section order (`moduleRegistry.ts` NAV_GROUP_ORDER): Operations, Stock, Production, Inventory, Assets, Sales, HR, Accounts, Company, plus standalone Dashboard and My Profile. One unified sidebar for all users; links are permission-filtered.

### 3.1 Standalone

**Dashboard** (`/`, `pages/dashboard/Dashboard.tsx`, `routes/dashboard.ts`, `lib/dashboardFinancials.ts`). KPI/BI landing page: Sales, Purchases, Expenses (with Salary/Rent/Other breakdown), Inventory value, Cash, Bank, Receivables, Payables, Money In/Out Today, GP/NP tiles, sales trend, payment mix, top items/customers, production trend. Money tiles read `companyFinancials`→`buildBooks` (never re-summed); accounting tiles are company-level and null for branch logins.

**My Profile** (`/profile/me`, `pages/profile/ProfileMe.tsx`, App.tsx:411-413; edited via `PATCH /auth/profile`). Self-service employee profile (name, phone, email, photo, education, work experience, emergency contact, DOB, bio). Has NO permission row — unrestricted for any logged-in user (wrapped in `AuthGuard` only).

### 3.2 Operations

**Point of Sale** (`/sales/pos`, `pages/sales/SalesPOS.tsx`, `routes/sales.ts`). Selling surface; requires a location context (`pages/sales/LocationPicker.tsx`) — fresh sessions render blank at `/sales/*` until a location is picked. HO is a full selling location. Supports FEFO/manual-batch consumption, cash/UPI/bank/card + credit settlement, coupons, other-charges rows, MRP floor, searchable state picker. Related sales pages: SalesDashboard, SalesStock, SalesExpenses, SalesCashBalance.

**Quotations** (`/sales/quotations`, `pages/headoffice/Quotations.tsx`, `routes/quotations.ts` + `publicQuotations.ts` + `quotationShareLinks.ts`; tables `quotations`, `quotation_share_links`). Quote customers without touching stock or books. **Now implemented** (audit's "in development / task #202" is stale — table exists, routes mounted, sidebar key `Quotations` present at `moduleRegistry.ts:271-273`). Public share links behind HMAC tokens.

**Location Stock** (`/sales/stock`, key `Location Stock`, `moduleRegistry.ts:277`). Branch stock view.

**Stock Transfer / HO Transfers** (`/transfers`, `pages/Transfers.tsx`, `routes/branches.ts`/`inventory` + `lib/api-client-react/transfers.ts`; table `stock_transfers`). Two-step transfer (dispatch → receive) with in-transit reservations; cross-GSTIN transfers write real sale/purchase rows. Old routes `/production/stock-transfer`, `/headoffice/transfers` redirect here (retired paths).

**Location Expenses** (`/sales/expenses`, key `Location Expenses`, `pages/sales/SalesExpenses.tsx`, `routes/inventory.ts`/expenses; table `expenses`). Location-stamped expense capture; delete supported.

**Cash Balance** (`/accounts/cash-in-outlet`, key `Cash Balance`, `pages/finance/CashInOutlet.tsx`, `routes/cash-in-outlet.ts`; table `cash_deposits`). Branch till cash view + deposits.

**Receipt Voucher** (`/operations/receipt-voucher`, `pages/operations/ReceiptVoucher.tsx` + `MoneyVoucherPage.tsx`, `routes/payments.ts`; table `receipts`) and **Payment Voucher** (`/operations/payment-voucher`, `pages/operations/PaymentVoucher.tsx`; table `payments`). Full-page surfaces over the SAME receipts/payments engine as Accounts › Payments — same REC-/PAT- numbering, postings and provenance locks; kind-bound PDF via `POST /pdf/money-voucher`. Payment-mode & attachment fields were REMOVED (columns kept for legacy, writes ignored). Bill-wise settlement / advances (`source='allocation'`, edit-locked).

### 3.3 Stock / Inventory

**Stock (HO)** (`/headoffice/stock`, key `Stock`, `pages/headoffice/Stock.tsx`, `routes/stock.ts`; tables `stock_entries`, `stock_batches`). On-hand + batch layer per location. Value columns omitted without the inventory-valuation right.

**Stock Ledger** (`/headoffice/stock-ledger`, `pages/headoffice/StockLedger.tsx`, `routes/stock.ts` + `lib/api-client-react/stock-ledger.ts`; table `stock_ledger`). Append-only movement audit with window-function running balance.

**Inventory Reports** (`/headoffice/inventory-reports`, `pages/headoffice/InventoryReports.tsx`). Valuation, ageing, movement — this key doubles as the stock-valuation permission (`INVENTORY_VALUATION_PAGE`, `permissions.ts:216`).

**Stock Verification** (`/headoffice/stock-verification`, `pages/headoffice/StockVerification.tsx`; table `stock_verifications`). Physical count vs system with corrective entries.

**Production batches** (`/production/production`, `pages/production/Production.tsx`, `routes/production.ts`; table `productions`, `bom_templates`). BOM-guided FEFO consumption, output at absorption cost (materials + overhead %), delete reverses stock + avg cost. Reports at `/production/reports` (`ProductionReports.tsx`).

### 3.4 Production (masters)

**Purchases** (`/production/purchase`, `pages/production/Purchases.tsx`, `routes/purchases.ts`; table `purchases`, `purchase_returns`). Vendor bills, batch creation (`PUR-…`), weighted-avg cost, Input GST, Other Purchase Charges (raw JSONB, `lib/otherCharges.ts`), advance settlement.

**Vendors** (`/vendors`, `pages/customers/Vendors.tsx`, `routes/customers.ts`; table `vendors`). Auto-provisions `VEND-n` ledger under Sundry Creditors + `VADV-n` advance ledger.

**Item Master** (`/production/item-master`, key `Items`, `pages/production/ItemMaster.tsx` + `Items.tsx`, `routes/inventory.ts`, `lib/itemCreate.ts`; tables `items`, `materials`, `raw_materials`). Items/materials/raw-materials with code sequences (`item_code_seq_*`) and EAN-13 barcodes. Creation is HO-only.

**Units** (`/production/units`, key `Units`, `pages/production/Units.tsx`). Unit-of-measure master.

**BOM templates** — surfaced within Production (`routes/bom.ts`; table `bom_templates`). No standalone sidebar key; managed under Production.

### 3.5 Inventory (HO masters)

**Warehouses** (`/headoffice/warehouses`, `pages/headoffice/Warehouses.tsx`, `routes/branches.ts` + `lib/api-client-react/warehouse-lifecycle.ts`; table `warehouses`, `warehouse_rent_agreements`). Location master with disable/permanent-delete lifecycle, GSTIN, cash/sales/purchase ledgers, rent agreements.

**Outlets** (`/headoffice/outlets`, `pages/headoffice/Outlets.tsx`; table `outlets`). Outlets belong to a warehouse; gated by an "outlets enabled" feature route (`OutletsEnabledRoute`). Mirror locations share a cash ledger.

**Item Prices** (`/headoffice/item-price`, key `Item Prices`, `pages/headoffice/ItemPrices.tsx`; table `item_prices`). Per-item selling prices (inclusive/exclusive modes).

### 3.6 Assets

**Asset Purchases** (`/assets/purchases`, `pages/assets/AssetPurchases.tsx`, `routes/assets.ts`; table `asset_purchases`). Capitalised including GST (no ITC); the purchase row is the register entry; no depreciation postings.

**Asset Register** (`/assets/register`, `AssetRegister.tsx`; table `assets`). **Asset Categories** (`/assets/categories`, `AssetCategories.tsx`; table `asset_categories`). **Asset Transfers** (`/assets/transfers`, `AssetTransfers.tsx`; table `asset_transfers`). **Asset Disposal** — surfaced via `AssetDisposal.tsx` (table `asset_disposals`). **Asset Reports** (`/assets/reports`, `AssetReports.tsx`).

### 3.7 Sales

**Sales** key (`/returns`, `/outstanding`; `moduleRegistry.ts:430-434`): **Returns** (`/returns`, `pages/returns/Returns.tsx`, `routes/returns.ts`; tables `sales_returns`, `purchase_returns`) — restore batches, never refund other-charges; and **Outstanding** (`/outstanding`, `pages/outstanding/Outstanding.tsx`) — dues = total − paid (owning-module calc).

**Customers** (`/customers`, `pages/customers/Customers.tsx` + `CollectPaymentDialog.tsx`, `routes/customers.ts`; table `customers`). Auto-provisions single `CUST-n` Sundry Debtor ledger (advance = credit balance on that ledger, single-ledger model).

**Coupons** (`/coupons`, `pages/customers/Coupons.tsx`; table `coupons`). Discount coupons for POS.

### 3.8 HR

**Employees** (`/hr/employees`, `pages/hr/Employees.tsx`, `routes/hr.ts`; table `employees`). Also the auth identity source; auto `SAL-EMP-n`/`SAL-PAY-n`/`ADV-EMP-n` ledgers.

**Attendance** (`/hr/attendance`, `pages/hr/Attendance.tsx`; tables `attendance`, `attendance_punches`). Multi-punch, drives daily salary accrual. **Leave** (`/hr/leave`, `pages/hr/Leave.tsx`; table `leaves`, `company_holidays`). **Payroll** (`/hr/payroll`, `pages/hr/Payroll.tsx`; tables `payroll`, `salary_accruals`, `salary_accrual_config`, `pay_components`) + **Advances** (`/hr/advances`, `pages/hr/Advances.tsx`; table `employee_advances`) — same permission key `Payroll`. **Rent Management** (`/hr/rent`, `pages/hr/RentManagement.tsx`, `routes/rent.ts`; tables `warehouse_rent_agreements`, `rent_accruals`, `rent_periods`, `rent_payments`). **Hierarchy** (`/hr/hierarchy`, `pages/hr/Hierarchy.tsx`; table `hierarchies`) — role tree with derived levels.

### 3.9 Accounts

**Chart of Accounts** (`/accounts/chart`, `pages/accounts/ChartOfAccounts.tsx` + `ChartHierarchy.tsx` + `chartCommon.tsx`, `routes/accounts.ts`, `lib/chartGroups.ts`; table `account_ledgers`). SYS-* roots → STD-* containers → auto party/branch/rent/salary/CBA ledgers; `code` never client-writable; P&L tab renders a two-sided Trading Account + P&L (GP/NP from `profitAndLoss.summary`).

**Ledger Statement** (`/accounts/ledger`, `pages/accounts/Ledger.tsx`). Running-balance statement per ledger.

**Payments** (key `Payments`; `pages/accounts/Payment.tsx` + `Receipt.tsx`, `routes/payments.ts`; tables `receipts`, `payments`, `payment_bill_allocations`, `purchase_advance_applications`, `advance_consumptions`). Receipt/payment vouchers with bill-wise settlement + advances (same engine as Operations vouchers).

**Cash & Bank** (`/accounts/cash-bank`, `pages/accounts/CashBank.tsx`, `lib/cashBankLedgers.ts`; table `cash_bank_accounts`). Each account backed by a `CBA-{id}` ledger under STD-CASH/STD-BANK; balances fully derived; opening balances counterweighted by `STD-OB-ADJ`. Module-managed heads (chart refuses child edits).

**Vouchers** (`/accounts/vouchers` + `/accounts/contra` + `/accounts/notes`; key `Vouchers`, `pages/accounts/Vouchers.tsx` + `Contra.tsx` + `Notes.tsx` + `Journal.tsx`, `routes/journal.ts`, `lib/journalCreate.ts`; tables `journal_vouchers`, `journal_voucher_lines`, `voucher_sequences`). Manual journal/contra/credit-note/debit-note — the only stored double-entry lines. Location-aware, provenance-locked (system vouchers uneditable/undeletable).

**Books** (key `Books`): **Day Book** (`/accounts/day-book`), **Cash Book** (`/accounts/cash-book`), **Bank Book** (`/accounts/bank-book`), **Trial Balance** (`/accounts/trial-balance`) — `pages/accounts/DayBook.tsx`, `CashBankBook.tsx`, `TrialBalance.tsx`; all from the derived posting stream (`routes/journal.ts` `computeCashBankBook`, `computeTrialBalance`).

**Expenses (Accounts)** (`/accounts/expenses`, `pages/accounts/Expenses.tsx`). Company-wide expense view.

**GST Summary** (`/accounts/gst`, `pages/accounts/GstSummary.tsx`, `routes/gst.ts`) and **GST Returns** (`/accounts/gst-returns`, `pages/accounts/GstReturns.tsx`) — GSTR-1 (B2B/B2C), GSTR-3B (ITC set-off), HSN summary, ledger-vs-register reconciliation, CSV.

**Reconciliation** (`/accounts/reconciliation`, `pages/finance/Reconciliation.tsx`, `routes/reconciliation.ts` + `lib/api-client-react/payments-reconciliation.ts`; tables `reconciliation_batches`, `reconciliation_batch_items`). Bank/UPI reconciliation.

**Month Locking / Accounting Periods** (`/accounts/periods`, key `Accounting Periods`, `pages/accounts/AccountingPeriods.tsx`, `routes/periods.ts`, `lib/periodLock.ts`; tables `accounting_period_locks`, `period_lock_events`). Locks a month against edits (edits/deletes in a locked month → 423).

**Accounts Cash Balance** (key `Accounts Cash Balance`, `moduleRegistry.ts:555`) — a separate permission key mapping to the cash-balance surface for accounts users.

**Reports (Accounts)** (key `Reports`, `/reports/sales` with matchPrefix `/reports`, `pages/reports/ReportsCenter.tsx`). The Reports Center covering financial, GST, inventory, production, sales, HR, parties, profitability, purchases, transfers, quotation report sections.

### 3.10 Company

**Settings** (key `Settings`): **Settings** (`/company/settings`, `pages/company/Settings.tsx`; table `company_settings`), **Company Profile** (`/company/profile`, `pages/company/Profile.tsx`), **Audit Log** (`/company/audit`, `pages/company/AuditLog.tsx`, `routes/audit.ts`; table `activity_log`).

**Permissions** (`/company/permissions`, `pages/company/Permissions.tsx`, `routes/company.ts`; table `permissions`). Per-page five-action rights per hierarchy; RBAC audit endpoint.

**Login History** (`/company/login-history`, `pages/company/LoginHistory.tsx`, `lib/api-client-react/login-history.ts`; tables `login_attempts`, `login_lockouts`). Attempt history + active lockouts.

**Backup & Restore** (`/company/backup`, `pages/company/BackupRestore.tsx`, `routes/backup.ts`, `lib/backup/`). pg_dump-based GCS backups; restore requires HO + approve right + password re-verification. (Company Reset also lives in this area — table truncation with chart re-seed, `routes/company.ts` ~654-713.)

**Import Data** (`/company/import`, `pages/company/ImportData.tsx` + `import/{MigrationWizard,MappingStep,ManageMappings,DemoReportView,shared}.tsx`, `routes/imports.ts`, `lib/importTransactions.ts` + `importVouchers.ts` + `openingStockImport.ts` + `legacyReports.ts`; tables `import_batches`, `import_rows`, `import_mappings`, `import_migrations`, `location_migration_map`). Two tabs: Migration (default wizard — whole-history multi-file migration) and Masters (standalone customer/vendor/item/ledger + opening-stock/opening-balance imports), plus History. Legacy report import via `lib/legacyReports.ts`. **Opening Balances** are set through this module (`lib/openingBalances.ts`; table `opening_balances`) — no separate sidebar link.

### 3.11 Employee mobile app

**Marlin Employee App** (`artifacts/employee-app`). Expo app with four tabs: index (home/punch), attendance, leaves, payslips (`app/(tabs)/*`), plus login and forced change-password. Consumes the same API via `lib/api-client-react` with a remote base URL + bearer getter. Employee-facing subset of HR (attendance punch, leave requests, payslip view).

### 3.12 Sidebar-present vs retired/hidden notes

- **Retired paths (redirects, still routed):** `/production/stock-transfer` and `/headoffice/transfers` → `/transfers` (App.tsx:223-224).
- **Retired branch type:** `production` as a branch type is retired and normalized to `headoffice` at auth (`routes/auth.ts:52-56`).
- **Folded-away permission actions:** `print`/`approve`/`share` rights folded into `download`/`edit` (columns kept but never read — `permissions.ts:80-92`).
- **Folded-away ledgers:** customer-advance (`CADV`) ledgers and the Customer Advances group were folded into the single `CUST-n` ledger (`customer_advances_fold_v1`, `index.ts:695-772`).
- **Removed money-voucher fields:** payment-mode & attachment removed from money vouchers (columns kept for legacy rows; writes ignored; no read surface).
- **Feature-gated:** Outlets sidebar/route gated by `OutletsEnabledRoute` (hidden when outlets are disabled).
- **BOM templates / Opening balances / Legacy report import / Bank-UPI reconciliation / Invoice sharing** exist as functionality but are surfaced within a parent module (Production, Import Data, Reconciliation, sales invoice pages) rather than as their own top-level sidebar keys.
- **Mockup-sandbox (`/__mockup`)** is a design artifact, not part of the ERP.

**Business rules (implemented):**
- The sidebar is a single unified nav derived from `MODULE_REGISTRY` (64 registered nav entries); no per-role nav forks — links are permission-filtered.
- Renaming a registry `key`/`href` invalidates existing permission rows for that page (keys are `page:<href>`).
- Every mounted API router has at least one corresponding UI surface or is a public/health/PDF/share endpoint.

---

## 4. User Roles

### 4.1 Purpose

Roles in Marlin ERP are **hierarchies** — a single rooted reporting tree that
serves two jobs at once:

1. It is the org chart / reporting chain (each role names the role it reports
   to; used by HR › Hierarchy).
2. It is the **RBAC principal**: every permission row (§28) is keyed on a
   `hierarchy_id`, and every employee (user) is assigned exactly one
   `hierarchy_id`. There is no separate "role" table — the org node *is* the
   role.

Table: `hierarchies` (`artifacts/api-server` — see `\d hierarchies`):
`id, name, level, description, created_at, reports_to_id`.
FKs into it: `employees.hierarchy_id`, `permissions.hierarchy_id`.

### 4.2 The hierarchy tree — single root, derived levels

- Exactly **one root** exists: the role whose `reports_to_id IS NULL`. Live data
  (verified via psql) confirms it: `id=1 Administrator, level=1, reports_to=NULL`.
- Every other role names a parent in `reports_to_id`. `level` is **derived, never
  client-writable**: root = 1, child = `parent.level + 1`
  (`routes/hr.ts` POST `/hr/hierarchies`, ~line 982:
  `level: parent.level + 1`).
- The `level` column persists in the row **because the permission middleware
  treats `level === 1` as a hardcoded full-access bypass** (§28). That is why
  the create/patch guards protect the root so carefully — reparenting into/out
  of the root would mint or revoke a super-admin role.

Live tree at time of writing (verified):

```
Administrator (id 1, level 1, root)          ← full-access bypass
└─ Management (id 4, level 2, reports_to 1)   ← "management view-only" tier
   ├─ MANAGER (id 2, level 3, reports_to 4)
   │  └─ SALES OFFICER (id 3, level 4, reports_to 2)
   └─ Owner (id 5, level 3, reports_to 4)
```

`level 2` (Management) has **no special code powers** — it is only "view-only"
by convention: its permission rows are typically granted `can_view=true` with
the write flags false. Nothing in code grants level-2 any bypass; only
`level === 1` is special. (The one place level ≤ 2 matters outside the RBAC
bypass is Migration Wizard rollback per the audit; NOT VERIFIED in this section
— see §6 spec part for imports.)

### 4.3 Employees are the users

There is no distinct `users` table. **`employees` are the login accounts.**
Table `employees` (verified `\d employees`) carries auth + HR + org fields:
`id, name, username, password_hash (default 'default123'), email, phone,
hierarchy_id (FK), branch_type, branch_id, salary, join_date, photo_url,
is_active (default true), created_at, updated_at,
must_change_password (default false), education/emergency_contact/
personal_address/date_of_birth/bio/work_experience (profile JSON/text),
is_production_staff (default false), salary_accrual_resume_from,
ui_location_pref (text), employment_status (default 'active'),
last_working_date`.

Auth truth (`routes/auth.ts`, `lib/token.ts`):
- Login is `POST /auth/login`; username lookup is **case-insensitive**
  (`LOWER(TRIM(username))`, matching unique index
  `employees_username_norm_unique` on `lower(trim(username))`).
- Password verified with bcrypt (`PasswordService.verify`); identical error for
  unknown-user and wrong-password (no enumeration). Rate limiting: 5 failures →
  15-min lock via `login_lockouts`/`checkLoginLock` (durable, survives restart).
- Success issues an HMAC-SHA256 signed **v2 token**
  `v2.<base64url(id:username:issuedAtMs)>.<sig>`, signed with `SESSION_SECRET`
  (server refuses to boot without it, `lib/token.ts` line 18). Max-age 8h
  (`TOKEN_MAX_AGE_HOURS`, default 8). Legacy unsigned tokens are rejected → 401.
- Deactivated account (`is_active=false`) → login `403`
  ("Your account has been deactivated…"); `/auth/me` also 403s if not active.
- `GET /auth/me` re-reads the row every request (permission/branch changes take
  effect on next page load). `branchType === 'production'` is a retired legacy
  value → normalized to `headoffice`/branchId 1 in `buildEmployeeResponse`.

### 4.4 How roles map to permissions

The `hierarchy_id` on the employee is the **only** thing that maps a user to
permissions. Resolution (both client and server compute identically):

1. Look up the employee's `hierarchy_id` → its `level`.
2. If `level === 1` → **full access, always** (bypass; no rows needed).
3. Otherwise read `permissions` rows for that `hierarchy_id` and the relevant
   page key(s); **default-deny** — a missing row = no access. (Full detail §28.)

Permissions are **per-role, not per-user**: two employees on the same hierarchy
have identical rights. There is no per-user override.

### 4.5 User lifecycle

**Create** — `POST /hr/employees` (`requireModuleAction("page:/hr/employees","add")`,
`routes/hr.ts` ~1322):
- Username trimmed, case-insensitive duplicate check → clean 400 if taken.
- Password set to `DEFAULT_INITIAL_PASSWORD` = `'marlin1458'`
  (`lib/passwordPolicy.ts` line 40), hashed with bcrypt, and
  **`mustChangePassword: true`** so the new user is forced through the
  change-password flow on first login.
- A `pay_components` row is seeded (`onConflictDoNothing`) so payroll has a
  structure.
- Posting to an outlet is refused while outlets are disabled
  (`OUTLETS_DISABLED_CODE`, 409). New rows default `employmentStatus:'active'`,
  `lastWorkingDate:null`.

**must_change_password flow** — returned in login and `/auth/me`; the frontend
redirects to a forced change. `POST /auth/change-password` verifies the current
password (wrong current → **400**, deliberately not 401 so a typo doesn't log
the user out), validates the new one against the company password policy
(`company_settings.password_*`), then sets `password_hash` and
`must_change_password = false`.

**Edit** — `PATCH /hr/employees/:id` (`…,"edit"`). Can change org fields, role
(`hierarchy_id`), branch assignment, salary, profile, and **employment status**.

**Deactivation / employment status** (`routes/hr.ts` ~1259):
- `employment_status ∈ {active, resigned, terminated, inactive}` — a
  raw-migration column read/written via explicit SQL (invisible to Drizzle).
- **Any status other than `active` implies `is_active = FALSE`.** `inactive` is
  the legacy plain deactivation; `resigned`/`terminated` additionally record
  *why*. `last_working_date` (LWD) stamps when they left.
- Legacy `isActive` toggle still works: reactivation restores `'active'`;
  deactivation records `'inactive'`.
- Changing to a non-active status triggers accrual cleanup; salary accrual /
  payroll cap future pay at the LWD (`employedDaysCap`), but pay already earned
  is preserved. Reactivation does **not** backfill months spent deactivated
  (`salary_accrual_resume_from`).

**Delete** — `DELETE /hr/employees/:id` (`…,"delete"`). (Blocking rules for
dependent HR/accounting history are enforced in HR module — see HR spec part;
NOT VERIFIED in full here.)

**Business rules (implemented):**
- Exactly one root role (`reports_to_id IS NULL`); every new role must name an
  existing parent, so a second super-admin root cannot be created via the API
  (`routes/hr.ts` POST, line 976-977).
- `hierarchies.level` is derived (root=1, child=parent+1), never client-writable;
  editing a role recomputes the whole subtree's levels under an advisory lock
  (`pg_advisory_xact_lock(hashtext('hierarchies_structure'))`, ~line 1048/1129).
- Only `level === 1` gets the RBAC bypass; "Management"/level-2 is view-only by
  granted rows, not by code.
- A role cannot be deleted while employees are assigned to it or another role
  reports to it (409); deleting a role also deletes its permission rows
  (`routes/hr.ts` DELETE ~1145-1165).
- Employees are the login accounts; new employees get password `marlin1458` +
  `must_change_password=true`.
- Any employment status ≠ `active` forces `is_active=false`; login of an
  inactive account is refused (403).

---

## 5. Location Architecture

### 5.1 Location kinds

Three physical location kinds plus the singular Head Office:

- **Head Office (HO)** — the company itself; a *singular*, id-less location. It
  is now also a full selling location (POS card, sales stamped `headoffice`).
- **Warehouses** (`warehouses`) — stock-holding, can purchase/produce/sell, own
  legal (GSTIN) identity used as invoice seller. Own three ledgers (cash, sales,
  purchase). Verified columns include `gst_number, state, state_code,
  billing_name, bank_*, upi_id, invoice_footer, authorized_signatory,
  cash_ledger_id, sales_ledger_id, purchase_ledger_id, disabled_at,
  disabled_by`.
- **Outlets** (`outlets`) — child of a warehouse (`warehouse_id` FK), sells
  only. Own two ledgers (cash, sales). GSTIN inherited context. Outlets are
  largely retired (see mirror-location note); their screens live behind a
  feature toggle (`outletWritesBlocked`).

Users are assigned to a location by `employees.branch_type ∈
{headoffice, warehouse, outlet}` + `employees.branch_id`. This assignment,
resolved server-side from the session, is the **sole** source of a user's data
scope — never a request parameter.

### 5.2 The HO placeholder-id convention (differs per table — match on TYPE)

HO has no natural id, so different subsystems use different placeholder ids and
callers must **match Head Office on `location_type` alone, never on the id**:

- **Money vouchers** (payments/receipts, journal vouchers): HO stamp =
  `location_type='headoffice'`, `location_id = 0`
  (`lib/moneyScope.ts` `callerLocation()` returns `{headoffice, 0}`;
  `resolveMoneyVoucherLocation` stores 0).
- **Sales / stock**: HO uses `location_id = 1` (per audit §2/§6 — "HO sales/stock
  use id 1"; also `PUT /auth/location-pref` stores `headoffice` with a display
  `locationId:1`). The mismatch (voucher 0 vs sales/stock 1) is intentional.
- Because of this, every LBAC/report filter treats `headoffice` by type only.
  `locationFilterParams` (marlin-erp `locationContext.tsx`) deliberately sends
  `locationType:'headoffice'` **without** a `locationId`.

### 5.3 Mirror locations (one place, two identities, one cash ledger)

The historic `outlet_to_warehouse_v1` migration
(`migrations/outletToWarehouse.ts`) converted every outlet into a warehouse but
**did not delete the outlet rows**, and the converted warehouse **reuses the
outlet's existing cash and sales ledgers** (only the purchase ledger is new).
Result: a single physical place can exist as **both** a warehouse and an outlet
that **share one cash ledger** — a "mirror location". Consequences enforced in
code:
- Read-side dedupe prefers the warehouse identity
  (`resolveMoneyVoucherLocation` picks `owners.find(o=>o.locationType==='warehouse')`,
  `lib/moneyScope.ts` line 433).
- A ledger can have **multiple owners**; `locationOwnedLedgerMap` returns an
  array of owners per ledger and a voucher stamped to *any* one owner is valid.
- `foreignLocationLedgerIds` computes the foreign set as a **difference on
  ledger ids** (not rows) precisely so a shared ledger is never wrongly called
  foreign (`lib/moneyScope.ts` line 133-138).

### 5.4 Acting-location vs global location context (READS only, never authority)

Two distinct notions:

- **Acting/effective location on a WRITE** — always derived server-side from the
  session (`callerLocation`) or a *validated* body request that HO may make for
  another location; branch users are forced to their own. Write paths must never
  read the display context.
- **Global location context (the sidebar selector)** — a *display* preference.
  The web client persists it (localStorage key `marlin_sales_location` + server
  `employees.ui_location_pref`) and attaches it to **every** API request as
  headers `x-location-type` (`warehouse|outlet|headoffice|all`) and
  `x-location-id` (`lib/requestLocation.ts`). Rules:
  - Read routes merge it via `getLocationFilter` / `getPostingLocationFilter`;
    explicit `?locationType=` query params win over the header (presence of the
    query *key* selects the query source).
  - `'all'`, absent, or malformed → "no narrowing".
  - It is layered **on top of LBAC and can only narrow what the caller may
    already see** — routes keep applying their scope conditions unconditionally.
  - **WRITE PATHS MUST NEVER READ THIS** (explicit banner in
    `requestLocation.ts` lines 23-25).
  - `PUT /auth/location-pref` persists it (display only; LBAC stays
    unconditional). "All" is distinguishable from "never set" (stored as JSON).

### 5.5 LBAC scope model

`lib/dataScope.ts` `getUserDataScope(employee)` derives scope purely from
`branch_type`/`branch_id`:
- **Head Office** → `{ isHeadOffice: true }` = sees everything.
- **Warehouse** → own warehouse id **plus every outlet whose
  `warehouse_id = branchId`**.
- **Outlet** → its own outlet only.

SQL WHERE builders (all return `'TRUE'` for HO, `'FALSE'` for empty scope):
`scopeSalesWhere` (sales; COALESCEs legacy `outlet_id`), `scopeBranchWhere`
(stock_entries/batches/employees via `branch_type`+`branch_id`),
`scopeLocationTypeWhere` (customers/vendors/returns via `location_type`+
`location_id`, optional `includeHeadoffice` for shared masters),
`scopeTransferWhere` (transfer visible if either endpoint is in scope).

**Money scope is deliberately narrower** (`lib/moneyScope.ts`
`ownLocationScope`): a warehouse gets **only its own till**, NOT its outlets —
"supplying an outlet is a stock relationship, not a shared wallet". A voucher
belongs to a location if it is stamped to it **or** one of its two ledger legs
is a ledger that location owns (rule 2 self-heals legacy `headoffice/0` rows).

### 5.6 LBAC enforcement order (page right 403 BEFORE location scope 404)

Middleware order (audit §9, confirmed by route wiring):
`requireAuth` → **RBAC page right (403)** → **LBAC location scope (404)** →
business logic. The distinction is deliberate:
- No page right at all → **403** (`requireModuleView`/`requireModuleAction`).
- Right present but the specific record is outside your locations → **404**
  ("Not found") — e.g. `partyScopeCheck` in customers, foreign voucher ids 404.
Hidden money figures are **omitted** from payloads, never zeroed (§28, §8).

### 5.7 Location-selector lockdown for branch users

`GlobalLocationSelector.tsx`: warehouse/outlet logins (`isLocked`) see a **fixed
label**, not a dropdown ("Your location is set by your login and cannot be
changed"). A `useEffect` force-syncs the persisted context to the user's own
branch even if a previous user's selection was left in localStorage on a shared
browser (otherwise every filtered page would ping a foreign location and get
zero rows). HO users get the full selector: All Locations / Head Office /
Warehouses group / Outlets group (outlets only when `outletsEnabled`).

### 5.8 Warehouse lifecycle (disable / permanent delete)

All three lifecycle ops are **level-1 only** (`requireLevelOne` in
`routes/branches.ts` ~338, on top of the ordinary `page:/headoffice/warehouses`
edit/delete right):

- **Disable / enable** — `POST /warehouses/:id/disable` / `/enable`. Sets raw
  `disabled_at`/`disabled_by` (reversible). Outlets inherit the parent state.
  Every transaction producer (sales, purchases, quotations, production,
  transfers, money vouchers, JVs, returns, verification, rent pay, imports,
  payroll pay/advances, asset purchases, deposits) checks
  `disabledWarehouseError()` on the *effective* resolved location → **409
  `WAREHOUSE_DISABLED`**. Receiving in-transit transfers and edits stay allowed
  (wind-down).
- **Ordinary delete** — `DELETE /warehouses/:id`. Blocked (400) if any linked
  cash/sales/purchase/rent ledger has accounting entries, if rent has ever been
  accrued/paid, or if any sale (own or child-outlet) was invoiced from it
  (seller identity is read live at reprint time). On success it drops the
  auto-provisioned rent ledgers and the row.
- **Permanent delete** — `DELETE /warehouses/:id/permanent` (Super-Admin /
  level-1). Two-stage UI: choice dialog (recommends Disable, shows a pre-delete
  count summary via `GET /warehouses/:id/delete-summary`) → typed
  `DELETE <name>` phrase (`deleteConfirmationPhrase`). Server re-checks the
  phrase + blockers inside one advisory-locked transaction, cascades
  children-first across every warehouse-stamped table, then validates in-txn
  (zero remaining rows, ledgers gone, TB balanced, no orphaned JV lines) — any
  failure rolls everything back with `failures[]`. Cross-location entanglements
  (outlets, transfers, employees, assets, deposits, import batches, shared
  mirror ledgers) are hard blockers, never cascaded
  (`lib/warehouseLifecycle.ts`).

### 5.9 What "All Locations" / HO / branch filters do in reports

- **All Locations** — no narrowing header; the caller sees everything their LBAC
  allows (HO = whole company; branch = own scope).
- **Head Office** — narrows to `location_type='headoffice'` matched by TYPE
  (id ignored); document-scoped reports show HO-stamped rows.
- **Warehouse/Outlet** — narrows to that concrete location (and, on
  warehouse selection, whatever the report's own scope helper includes).
- Financial reports (`/reports/fin/*`) apply the location filter as an **LBAC
  narrowing only**; accounting **control totals** (receivables/payables,
  cash/bank) are company-level by construction (postings carry no location) and
  are **null for branch logins** (dashboard shows "—"; §8).

**Business rules (implemented):**
- A user's data scope comes only from `branch_type`/`branch_id`; request/header
  location can only narrow, never widen (`dataScope.ts`, `requestLocation.ts`).
- HO matched on type alone; placeholder id differs by table (vouchers 0,
  sales/stock 1).
- Money scope excludes a warehouse's outlets (own till only); voucher ownership
  also derived from ledger legs to self-heal legacy rows (`moneyScope.ts`).
- Mirror locations share one cash ledger; reads dedupe to the warehouse
  identity, foreign-ledger set is computed by id difference.
- Branch users cannot change the location selector; it is forced to their own
  branch.
- Warehouse disable/enable/permanent-delete are level-1 only; disabled
  warehouses 409 (`WAREHOUSE_DISABLED`) on new transactions but still receive
  transfers and allow edits.
- Enforcement order is page-right 403 before location-scope 404; hidden money is
  omitted, not zeroed.

---

## 6. Master Data

### 6.1 Company profile / general settings

Table `company_settings` (single row, 47+ cols, verified `\d`): company_name
(default 'Marlin Frozen Fruits'), address/city/state/pincode, phone/email/website,
gst_number, pan_number, logo_url, currency (INR), financial_year (default
'2025-26' — a display default, see below), fy_start_month (default 4 = April),
invoice_prefix (default 'INV') + invoice_sequence, branch_transfer_prefix (BTR) +
sequence, quotation_sequence, voucher_prefixes (jsonb), payment_terms,
invoice_footer, production_overhead_percent, password policy
(password_min_length default 8, require_uppercase/number/special),
general_settings (jsonb), gst_transfer_invoicing (bool, default true), PF fields
(pf_enabled, pf_employee/employer_percent default 12), ESI fields (esi_enabled,
0.75 / 3.25), UPI fields (upi_enabled, upi_id, upi_payee_name,
show_upi_qr_on_invoice, show_bank_details_on_invoice), bank_* (name, account,
ifsc_code, branch, account_type, account_holder).

Surfaces: Company › Settings (`page:/company/settings`), Company Profile
(`page:/company/profile`). `fy_start_month` is the trusted source for the
current FY; the stored `financial_year` TEXT is **not trusted** for opening
balances because nobody rolls it forward (`lib/openingBalances.ts`
`currentFinancialYear()` derives the label from `fy_start_month`).

### 6.2 Locations (masters)

See §5 for lifecycle/architecture. Creation is HO-only in practice via the
warehouses/outlets pages. On **create** each warehouse auto-provisions three
ledgers (`provisionWarehouseLedgers`, `routes/branches.ts` ~23):
- `WH-CASH-<id>` "<name> Cash" (asset, under `STD-CASH`),
- `WH-SAL-<id>`  "<name> Sales" (income, under `STD-GRP-LOC-SAL`),
- `WH-PUR-<id>`  "<name> Purchase" (expense, under `STD-GRP-LOC-PUR`);
plus a zero/inactive rent agreement (`warehouse_rent_agreements`) and rent
ledgers. Outlets provision two (`OUTLET-CASH-<id>`, `OUTLET-SAL-<id>`).
GSTIN validated (`validateGstin`); `state_code` is **derived from the GSTIN's
first two digits** (`stateCodeFromGstin`), a submitted state_code is ignored to
avoid contradicting the registration. **Renames** sync all linked ledger names
by ledger id (not by code, because ex-outlet warehouses keep `OUTLET-*` codes).

### 6.3 Customers (incl. shared CustomerFormDialog, walk-in)

Table `customers` (verified): `name, phone, email, address, gst_number, state,
total_purchases, location_type, location_id, credit_limit, credit_days, pan,
notes, import_batch_id`. (`pan`, `notes` are raw-migration columns written via
raw SQL; credit fields likewise via `applyCreditFields`.)

- Access: `GET /customers` (`page:/sales/pos` OR `page:/accounts/vouchers` OR
  `page:/customers`). Write guards on `page:/customers`.
- **Shared `CustomerFormDialog`** (`components/customers/CustomerFormDialog.tsx`)
  is the one create/edit form reused across POS, Customers, Vouchers.
- **Walk-in**: a sale may have no `customer_id` (walk-in / counter sale);
  invoices/books/GST use "Walk-in" as the customer name
  (`routes/sales.ts` ~678, 1023, 1195) and fall to the B2C series and net-shape
  postings (see §6.9 party ledgers).
- **Create** — `POST /customers`: name required; GST normalized/validated;
  credit fields validated. **Location stamp comes from the session**
  (`branch_type`/`branch_id`); HO may pass an explicit location via the same
  validated `resolveRelocation` resolver (target must exist; non-HO callers
  refused). Insert + stamp + `CUST-<id>` debtor ledger provisioning happen via
  the one shared path `createCustomerWithLedger` (`lib/partyCreate.ts`).
- **Edit** — `PATCH /customers/:id`: `partyScopeCheck` (404 if out of scope);
  GST rules (below); renames sync the `CUST-<id>` ledger name; a blank→valid
  GST transition triggers automatic B2C→B2B invoice reclassification in one
  transaction (`convertCustomerB2CToB2B`) — GST save and reclass commit or fail
  together.
- **Delete** — `DELETE /customers/:id`: refused (400) if any sale exists, or if
  the `CUST-<id>` ledger has payment/receipt entries; otherwise the orphaned
  system ledger is dropped and the customer deleted.

### 6.4 Vendors

Table `vendors` (verified): same core as customers plus `bank_name,
account_number`; `location_type` defaults `'headoffice'`, `location_id` defaults
`0`. Access: `GET /vendors` shared across Purchases/Vouchers/Vendors/Reports/
Assets pages; writes on `page:/vendors`. Create/edit/delete mirror customers via
`createVendorWithLedger` → `VEND-<id>` creditor ledger under `SYS-CREDITORS`.

### 6.5 Party location stamping

Both parties are stamped `location_type`/`location_id` in the **same
transaction** as the insert (`partyCreate.ts` — "a row that survives without its
stamp is one whose access scoping silently falls back to something nobody
approved"). The party's ledger inherits the party's stamp **only when the
ledger's stamp is NULL** (`stampLedgerLocation` — display/ownership only; report
scoping stays document-based). HO-stamped or unstamped parties are company-wide
and visible everywhere; branch-stamped parties are foreign to other branches
(`foreignPartyLedgerIds`, `moneyScope.ts`).

### 6.6 Party GST persistence rules

- Normalisation: trim + uppercase, `''` → NULL (`normalizeGstField`).
- Validation (`gstWriteError`): GST stays **optional** (null always passes); a
  non-null value must match `GSTIN_RE` (15-char) — **except** when it equals the
  value already stored (grandfathering: live data holds a few legacy typos, and
  rejecting them would block every unrelated edit that resubmits the stored GST
  verbatim).
- Blank→valid GST on a customer auto-converts eligible (open-month,
  non-cancelled) B2C invoices to the B2B series atomically (§6.3).

### 6.7 Items / Item master

Table `items` (verified): `name, hsn_code (NOT NULL, default ''), tax_rate
numeric(5,2), unit, description, production_stock, mrp, cost, reorder_level
(default 10), avg_cost, item_code, barcode, status (default 'active'),
import_batch_id`. (`item_code`, `barcode`, `status` are raw-migration columns —
read/write via explicit SQL.)

- Access: creation/edit/delete is **HO-only** (`requireHeadOffice` — item
  masters are shared by every location; a warehouse renaming an item or flipping
  a GST rate would silently change what everyone sells/invoices). Reads are
  unguarded by location so warehouses keep full visibility.
- **Code prefixes follow the DISPLAY label, not the table name**
  (`lib/productIdentity.ts` `CODE_PREFIX`): `items`→**FG**, `materials`→**RM**
  (Raw Material), `raw_materials`→**PM** (Packing Material). Format
  `FG-0007` / `RM-0001` / `PM-0001` (`buildItemCode`).
- **EAN-13 barcode** (`buildBarcode`): leading digit **2** (worldwide
  restricted/in-store range, cannot collide with a manufacturer GTIN), then a
  kind digit (item=1, material=2, raw_material=3), then a 10-digit zero-padded
  sequence, then a mod-10 check digit (`ean13CheckDigit`).
- One sequence **per kind** (`item_code_seq_item`, `item_code_seq_material`,
  `item_code_seq_raw_material`) reserved via `nextval` (transaction-safe, never
  reused). MRP `0` reads as "not priced yet" → returned null.
- **GST rate slabs**: `tax_rate` must be one of `{0,5,12,18,28}`
  (`lib/gst.ts` `GST_SLABS`, enforced by `itemCreateError`). HSN stored as text.
- `status='inactive'` blocks use on **new** documents only
  (`blockedByInactiveProducts`); historical documents stay editable/reachable.

Categories & Units: Units at `page:/production/units`; item categories NOT
FOUND as a first-class table in the tables I inspected (items carry HSN + tax
slab rather than a category FK) — **NOT VERIFIED** whether a category master
exists beyond the label used in reports.

### 6.8 Raw materials vs finished products (polymorphic identity)

Three separate master tables — `items` (finished SKUs), `materials` (raw
materials), `raw_materials` (packing materials) — with **overlapping id spaces
from 1**. Every stock store (`stock_entries`, `stock_batches`, `stock_ledger`)
and every identity helper carries a **`material_type` discriminator**
(`item | material | raw_material`), CHECK-constrained; **every query must scope
`material_type`** or it silently mixes three products with the same id. The
label↔table mapping is intentionally crossed: table `materials` holds
Raw Materials (RM), table `raw_materials` holds Packing Materials (PM)
(`PRODUCT_LABEL`/`CODE_PREFIX`).

### 6.9 Chart auto-provisioned party ledgers (CUST- / VEND-)

- Customer → `CUST-<id>` (asset, under `SYS-DEBTORS` "Sundry Debtors").
- Vendor → `VEND-<id>` (liability, under `SYS-CREDITORS`).
- Non-fatal if the parent head is missing (returns null; ledger can be created
  later). Renames sync the ledger name; app-level party delete removes the
  orphaned ledger; a boot sweep heals hand-deleted masters
  (`orphanPartyLedgers`). Ledger `code` is never client-writable.
- Employees auto-provision `SAL-EMP-<id>`, `SAL-PAY-<id>`, `ADV-EMP-<id>`;
  bank/cash accounts back onto `CBA-<id>` under `STD-CASH`/`STD-BANK`.

### 6.10 Item prices (valid_from / valid_to raw columns)

Table `item_prices` (verified): `item_id (FK), outlet_id, price numeric(10,2),
updated_at, valid_from (text), valid_to (text), location_type (NOT NULL default
'outlet')`. `valid_from`/`valid_to` are text (raw-migration) date windows.
Surface: Inventory › Item Prices (`page:/headoffice/item-price`, HO-only).
The column is named `outlet_id` but `location_type` allows warehouse/outlet
pricing rows. MRP floor in POS is enforced against `items.mrp`.

### 6.11 Opening balances (intentionally zero + opening_balances + STD-OB-ADJ counterweight)

- Store: `opening_balances (ledger_id, balance, balance_type, as_of_date,
  financial_year, notes, created_by, updated_at)`; upsert key
  `(ledger_id, financial_year)` (`lib/openingBalances.ts` — the ONE write path,
  shared by `POST /accounts/opening-balances` and the Data Import commit).
- Opening balances live **outside** the derived posting stream and are folded in
  by `buildBooks`/`ledgerBalances`. `openingBalancePostings` shapes them as
  company-level (locationType null), dated at `as_of_date`.
- "Intentionally zero": the manual opening-balance screen expects the accountant
  to enter every side so the set self-balances. But the **Cash & Bank module**
  writes only the *asset* side (each account's opening money on its `CBA-<id>`
  ledger), which would unbalance the TB/BS. So a single auto-maintained
  counterweight credit row is kept on **`STD-OB-ADJ`** ("Opening Balance
  Adjustment", equity, under `SYS-CAP`) —
  `rebalanceCashBankOpeningEquity` (`lib/cashBankLedgers.ts` ~135) recomputes it
  **from scratch** (idempotent, never increment) as the signed sum of all
  openings on `CBA-%` ledgers, under an advisory lock
  (`cash_bank_opening_equity`), at boot and after every Cash & Bank
  create/edit/delete. When the total is zero the ledger and its row are removed.
  Manual opening-balance routes **refuse** `CBA-*` and `STD-OB-ADJ` ledgers
  (`routes/accounts.ts` ~3659, ~3826).

**Business rules (implemented):**
- Item/party masters live in dedicated tables; party creation always provisions
  a `CUST-`/`VEND-` ledger in the same path (`partyCreate.ts`).
- Item creation is HO-only; codes follow the display label (FG/RM/PM), barcodes
  are real EAN-13 in the `2` in-store range with a per-kind digit; tax rate must
  be a valid GST slab (0/5/12/18/28).
- Three product tables have overlapping ids; every stock query scopes
  `material_type`.
- Party location is stamped in the insert transaction; the party ledger inherits
  the stamp only when NULL.
- GST is optional; a non-null value must be a valid 15-char GSTIN unless it
  equals the stored (grandfathered) value; a customer gaining a GSTIN triggers
  atomic B2C→B2B invoice reclassification.
- `state_code` on warehouses is always derived from the GSTIN, never from the
  submitted state_code.
- Cash & Bank opening balances are counterweighted by one auto-maintained
  `STD-OB-ADJ` equity credit, recomputed idempotently under an advisory lock.

---


---

>
> Cross-cutting note on the data layer: the `sales`, `sale_payments`,
> `quotations` and `sales_returns` tables carry many raw-migration-only columns
> that `@workspace/db` (drizzle) cannot see (`location_type`, `location_id`,
> `party_gstin`, `party_state`, `number_scope`, `invoice_series`, `invoice_fy`,
> `invoice_serial`, `other_charges`, `bill_discount`, `sale_payments.source`,
> `sale_payments.clearing_receipt_id`, `legacy_invoice_number`). Confirmed live
> via `\d sales`, `\d sale_payments`, `\d sales_returns`. Every read/write of
> those columns is raw SQL.


## 7. Sales (Invoicing)

**Purpose.** Record customer sales invoices at any selling location (outlet,
warehouse or Head Office), deduct stock (batch/FEFO aware), settle or credit the
money, allocate a per-location GST-compliant invoice number (B2B vs B2C series),
and feed the derived-ledger accounting engine. The Head-Office "Sales" page and
the outlet "POS" page are the **same React component** driving the **same
`/sales` API** (see §8).

**Access / permissions.**
- Route guards use `page:/sales/pos` and, for the HO list, the caller passes a
  `permissionModule` prop (`page:/sales/pos`) — `marlin-erp/src/pages/headoffice/Sales.tsx:190`.
- All list/read/write endpoints are LBAC-scoped by the caller's data scope
  (`getUserDataScope`) — `api-server/src/routes/sales.ts` (scope helpers used
  throughout; e.g. GET `/sales` scoping ~`sales.ts:900`+).
- Credit-control override requires `edit` on `page:/outstanding` **or**
  `page:/returns` (`sales.ts` credit-control block, POST/PUT).
- Money collection on an existing invoice is location-pinned: only the sale's
  own location may collect; Head Office is unrestricted — `api-server/src/routes/payments.ts`.

**Screens / fields.** One dialog form (`headoffice/Sales.tsx`), Tally-style
keyboard entry (§8). Header: location (forced in POS mode), customer (or
walk-in / `party_name`), sale date, payment mode (only **cash** or **credit** at
creation). Lines: item (searchable), quantity, unit price, unit discount
(₹/unit) or legacy line-total discount, tax type. Footer: bill discount
(pre-tax), other charges (packing/freight/hamali — no GST), post-tax coupon
discount. Columns persisted on each line include `taxableAmount`, `cgst`,
`sgst`, `igst`, `taxAmount`, `taxType`, `batchBreakdown` (consumed batches with
`unitCost`), `discount` (= item discount + allocated bill-discount share).

**Tax & discount arithmetic (shared engine — `api-server/src/routes/sales.ts`).**
- `computeLineTax` — inclusive prices are **extracted** (tax carved out of the
  price); exclusive prices are **added on**. Intra-state → CGST + SGST where
  `CGST = round(half)` and `SGST = exact remainder`; inter-state → IGST.
- `allocateBillDiscount` — bill discount split across lines by **largest-
  remainder, paise-exact** allocation (no rounding drift).
- `buildSaleLines` (exported; **shared with Quotations**) — applies item
  discount first (`unitDiscount` ₹/unit or legacy line-total `discount`), then
  pre-tax bill-discount allocation, then tax. Stored line `discount` =
  itemDiscount + billDiscountShare.
- `checkMrpFloor` — line price must be ≥ `min(master MRP, saved floor)` (saved
  floor only relevant on edit); **strict compare, no epsilon**; exempts
  cross-GSTIN branch-transfer sales.
- `discount_total` on the header stores **only the post-tax coupon**; the pre-
  tax bill discount lives in `bill_discount`. Other charges are folded into
  `total_amount` with **no GST**.

**Create — `POST /sales` (`api-server/src/routes/sales.ts`).** In order:
1. Month-lock pre-check on `sale_date` (`respondIfMonthLocked`).
2. Inactive-item block (`blockedByInactiveProducts`).
3. Location resolve (outlet / warehouse / headoffice; **HO id fixed = 1** in the
   sales domain); LBAC scope enforced; disabled-warehouse / retired-outlet gate.
4. Place-of-supply = seller location state vs customer state → intra/inter-state.
5. MRP-floor check.
6. Quotation conversion path (locks quote row `FOR UPDATE`, refuses a second
   conversion, stamps both documents — see §9).
7. Advance adjustment (advisory lock; `sale_payments.method='advance'`).
8. **Credit control** — ledger-balance based via `currentPartyStatement`, guarded
   by advisory xact lock `hashtext('customer-credit')`; override requires the
   edit right named above.
9. Stock deduct — per-line lock in **ascending itemId** order, FEFO
   `consumeBatches`.
10. Invoice-number allocation — **SB2B if the customer has a GSTIN, else SB2C**
    (`allocateSalesInvoiceNumber`; §24).
11. Counter-settlement leg — for money settled at the moment of sale, one
    `sale_payments` row with `source='counter'`, `clearing_receipt_id = NULL`; a
    legacy `receipts` trail row `source='sale'` is also written. Only
    `CREATE_SALE_PAYMENT_MODES` (cash / credit) are allowed at creation
    (`isAllowedNewSaleMode`); settled modes are marked paid immediately.

**Edit — `PUT /sales/:id`.**
- Blocks branch-transfer invoices.
- **Both** the stored `sale_date` and the incoming date must be in open months.
- `resolveEditedSaleMode` — an edit cannot turn a sale into a bank/UPI mode.
- Recomputes location (absent fields preserve prior values); credit-controlled
  with the advisory lock.
- Drops the old counter leg under a row `FOR UPDATE`, re-derives `amount_paid`
  from `sale_payments`, then restates exactly one counter leg (invariant: one
  counter leg is maintained across create/edit/cancel).
- **Delta-based stock**: reverse old lines/batches, re-apply new lines; union
  lock order by `item|loc`.
- Restates the `receipts` trail (delete by voucher_number + location predicate)
  and recomputes `number_scope` on a location move.

**Cancel — `POST /sales/:id/cancel`.** Terminal state (`cancelled_at`).
- Blocked if real payments exist (`PAYMENTS_RECORDED`) — but exempts the
  counter leg (`source='counter'` + null `clearing_receipt_id`) and
  `method='advance'`.
- Blocked if any sales return exists against the invoice.
- Advance-only settlements are unwound and the advance restored; counter legs
  deleted; stock + batches restored; customer `total_purchases` reversed;
  `receipts` trail deleted. `buildDerivedPostings` then skips a cancelled sale.

**DB tables.** `sales` (verified `\d sales`): raw-migration columns include
`location_type/location_id`, `party_name/party_gstin/party_state`,
`bill_discount`, `other_charges jsonb`, `coupon_code`, `discount_total`,
`amount_paid`, `payment_status`, `number_scope`, `invoice_series`, `invoice_fy`,
`invoice_serial`, `quotation_id/quotation_number`, `legacy_invoice_number`,
`branch_transfer_id`, `cancelled_at`. Key unique indexes:
`uq_sales_scope_invoice_number (number_scope, invoice_number)`,
`uq_sales_scope_series_fy_serial (number_scope, invoice_series, invoice_fy,
invoice_serial)`, `sales_quotation_uq (quotation_id) WHERE NOT NULL`,
`idx_sales_branch_transfer_invoice_uq` (unique invoice per transfer twin).
`sale_payments` (verified `\d sale_payments`): `method`, `amount`,
`reconciliation_status`, `clearing_receipt_id`, `source`, `matched_*`,
`reference_number`.

**APIs.** `GET /sales` (paginated or legacy-array; excludes branch-transfer;
LBAC + warehouseScope filter), `GET /sales/summary`, `GET /sales/:id`,
`POST /sales`, `PUT /sales/:id`, `POST /sales/:id/cancel`,
`GET/POST /item-prices` (serves the Item Prices page **and** POS),
`POST /sales/:id/share-token` (30-min TTL, download-right, LBAC),
`GET /sales/:id/invoice.pdf` (inline, download-right),
`GET/POST /sales/:id/payments` (`payments.ts`). Share-link management +
public link paths below.

**Backend services / libs.** `lib/salePaymentPosition.ts` (authoritative
position = total − received − creditAdjustments; only `credit_note` returns
count as credit adjustments), `lib/paymentModes.ts`, `lib/voucherNumber.ts`
(sales-series + scoped serial allocation), `lib/invoiceReclass.ts` (B2C→B2B).

**Accounting legs (derived; `api-server/src/routes/journal.ts`
`buildDerivedPostings` §5 = Sales, ~lines 1141–1400).** Two models:
- **Gross-debtor model** (customer has a `CUST-n` ledger): at `sale_date`
  `Dr CUST-n` for the **full total** (narration "Invoice <no>"); `Cr` the sales
  ledger (net = total − tax − otherCharges); `Cr` Output GST heads via
  `lineTaxHeads` — `STD-OUT-CGST` / `STD-OUT-SGST` / `STD-OUT-IGST`, residual to
  `STD-DTX`; `Cr` each other-charge expense ledger. Then **per `sale_payments`
  row**: `Dr` cash / clearing / direct-account / advance and `Cr CUST-n` dated
  the payment date (advance is a Dr/Cr wash). Counter "extra" (amount_paid − Σ
  sale_payments) is dated at the sale.
- **Net model** (walk-in / missing customer ledger): `Dr` the settled legs +
  `Dr` the remainder on `SYS-DEBTORS` (narration "Outstanding"); an overpayment
  is credited to `CUST-n`.
- Sale-linked `receipts` rows are **excluded** from the receipt stream (they'd
  double-count against the derived legs).
- Branch-transfer invoices credit `STD-BRANCH-TRF` and debit the branch debtor
  (excluded from revenue reporting).

**Ledger codes referenced:** `STD-SALES`, `STD-CASH`, `STD-ELEC-CLR`,
`STD-OUT-CGST/SGST/IGST`, `STD-DTX`, `SYS-DEBTORS`, `CUST-n`,
`STD-BRANCH-TRF` / branch debtor, `WH-CASH-<id>`, `OUTLET-CASH-<id>`.

**Inventory impact.** Deduct on create (per-line lock ascending itemId, FEFO
`consumeBatches`); delta reverse/re-apply on edit; full restore on cancel; batch
layer (`stock_batches`) and stock ledger kept in step.

**Party / cash / bank impact.** `CUST-n` movements as above; customer
`total_purchases` incremented on create, restated on edit, reversed on cancel
and on credit-note return. Cash settled-at-sale → location till ledger; bank/UPI
only via later collection (`payments.ts`): direct-to-account when the account is
assigned and reconciliation is off, else `STD-ELEC-CLR` pending clearing.

**Location.** Every sale is stamped `location_type`/`location_id`; HO uses id 1
in the sales domain (note the HO-id inconsistency: vouchers use 0, sales use 1,
keyed by domain). Invoice numbering is per-location scope, with mirror
outlet→warehouse twins folded into one scope (`salesCounterScope`).

**Reports / dashboard.** Feeds `companyFinancials` / `companyBalances`
(dashboard, month-close summary), GSTR-1 (§24), Sales Dashboard
(`marlin-erp/src/pages/sales/SalesDashboard.tsx`). Month-close summary counts
real sales only (excludes branch-transfer) — `periods.ts:106`.

**Audit log.** Create / edit / cancel and payment actions call `logActivity`
(module `sales`). Reclassification and period lock events audited after commit.

**Invoice PDF & public links.** One renderer, two public link paths — confirmed:
`assembleInvoiceData(saleId)` → `renderInvoicePdf(data)` is used by BOTH
`GET /api/public/invoices/:token[.pdf]` (ephemeral in-session HMAC token, ~30
min; `api-server/src/routes/publicInvoices.ts:17,31,38`) and
`GET /api/share/invoice/:publicId/pdf?token=…` (revocable share link;
`api-server/src/routes/invoiceShareLinks.ts:11,25`). The share-link pair is the
only unauthenticated way in and reaches exactly one invoice.

**Validations.** Month-lock (both dates on edit), inactive item, MRP floor
(strict), LBAC scope, disabled-warehouse / retired-outlet gate, credit limit
(ledger-balance based) with explicit override right, allowed payment modes at
create (cash/credit only), cancel blocked by real payments or existing returns.

**Limitations / notes.**
- Other charges never carry GST and are never returned (see §11.1).
- Advance model is single-ledger on `CUST-n` (no separate `CADV` customer-
  advance ledger).
- HO-id is 1 in sales but 0 in vouchers (intentional, keyed by domain).

**Business rules (implemented):**
- HO "Sales" and outlet "POS" are one component + one `/sales` API.
- Only cash or credit at creation; bank/UPI only via later collection and never
  by turning an existing sale into a bank mode on edit.
- Exactly one counter-settlement leg is maintained across create/edit/cancel.
- Invoice series is SB2B iff the customer has a GSTIN, else SB2C, per-location
  scope with mirror twins folded.
- MRP floor is a strict (no-epsilon) minimum, exempting cross-GSTIN transfers.
- Credit control is ledger-balance based (not document arithmetic), overridable
  only with edit on `page:/outstanding` or `page:/returns`.
- Cancel is terminal and blocked by real payments (counter/advance exempt) or
  any existing return.

---

## 8. Point of Sale (POS)

**Purpose.** Fast, mouse-free selling at an outlet or warehouse. POS is **not a
separate engine** — it is the Sales form (§7) rendered under `page:/sales/pos`.

**Access / permissions.** `page:/sales/pos` (view/add/edit). Route
`SalesPOS` (`marlin-erp/src/pages/sales/SalesPOS.tsx`) reads the global location
context and renders `headoffice/Sales` with `permissionModule="page:/sales/pos"`
and forced location props.

**Screens / fields.** Same dialog and fields as §7. `SalesPOS.tsx`:
- "All Locations" → full sales list, no location filter (`SalesPOS.tsx:27`).
- Warehouse → warehouse sales + child-outlet sales (child ids computed from
  `useAllOutlets`, `SalesPOS.tsx:16–19`).
- Specific outlet/warehouse → that location only (forced props,
  `SalesPOS.tsx:33–41`).

**Blank-until-location gate.** A direct link or restored tab can arrive before an
HO user has picked a selling location. POS never renders blank: if
`locationType` is unset it `Redirect`s to `/sales`, which shows the existing
picker that applies the server-authorized scope — `SalesPOS.tsx:21–24`.

**Keyboard-entry conventions (shared machinery — `marlin-erp/src/lib/keyboard-entry.tsx`).**
The file contains **NO business logic** — it only moves focus and routes keys,
and is shared by many entry forms (Journal, Contra, Notes, Transfers, Expenses,
Money Voucher, etc.). Wiring (per file header, verified):
- `onOpenAutoFocus={autoFocusFirst}` lands the cursor on the first field.
- `data-kbd-scope` + `onKeyDown={entryScopeKeyDown({...})}` provides:
  Enter → next field (text/number/date only); Enter on `[data-last-field="1"]`
  → `onAddLine` (Tally-style new line); Ctrl/Cmd+S → `onSave`; Ctrl/Cmd+P →
  `onSaveAndPrint` (when print is supported); Ctrl/Cmd+Enter → `onComplete`
  (falls back to `onSave`); F4 → `onAddLine`; Delete → `onDeleteLine(rowIndex)`
  when focus is in a `[data-kbd-row]` and not in a text field.
- `advanceOnSelect` on `AccountCombobox` / `SearchableItemSelect` moves focus on
  pick. Conventions: mouse-only controls get `tabIndex={-1}`; `[data-kbd-ignore]`
  subtrees skipped; `[data-kbd-first]` marks the intended first field;
  `[data-field="name"]` lets validation put the cursor on the offending field.
- The Sales form wires these at `headoffice/Sales.tsx:3` (import) and
  `:1456` (`entryScopeKeyDown({ onSave, onComplete, onAddLine, onDeleteLine })`).

**Shared vs duplicated logic.** All sale money math (tax/discount/MRP) lives
server-side in `buildSaleLines`/`computeLineTax` and is shared with Quotations;
the POS form re-uses the HO Sales component; the keyboard layer is shared
library machinery. No POS-specific sale endpoint exists — POS posts to `/sales`.

**Everything else** (create/edit/cancel, accounting, inventory, invoice PDF,
returns entry point) is identical to §7. Note the sales-return `add` right is
also granted from POS: `requireModuleAction(["page:/returns", "page:/sales/pos"], "add")`
(`returns.ts:181`).

**Business rules (implemented):**
- POS is the Sales form under `page:/sales/pos`; no separate POS sale engine.
- POS never renders blank without a location — it redirects to the `/sales`
  picker which enforces server-authorized scope.
- Keyboard-entry is shared, logic-free focus/key machinery; the Sales form opts
  in via the documented data-attributes and `entryScopeKeyDown` handlers.

---

## 9. Quotations

**Purpose.** Customer offers that touch nothing else in the books. A quotation
mirrors the Sales Entry experience (same customer/location/discount/tax
arithmetic — literally `buildSaleLines`) but records only an offer. Nothing here
writes stock, reservations, receipts, ledger postings, GST or dashboard figures.
The ONLY bridge to the real world is **conversion**, which lives inside
`POST /sales`. Source: `api-server/src/routes/quotations.ts` and boot migration
`api-server/src/migrations/quotations.ts`.

**Access / permissions.** One key for the whole module,
`page:/sales/quotations`, behaving exactly like Sales (view/add/edit)
(`quotations.ts:42`). LBAC scope identical to sales but on NOT-NULL
`location_type/location_id` (no legacy outlet fallback) (`quotations.ts:66–95`).

**Numbering.** `QTN/<FY>/NNNN` from `company_settings.quotation_sequence` — its
own counter, bumped atomically inside the create transaction, completely
separate from invoice numbering (`quotations.ts:44`; migration `:76–81`).

**Screens / fields.** Header: customer, location, quote date, valid-till,
payment terms, place of supply, salesperson, notes, terms & conditions. Lines +
discounts/tax computed by the shared `buildSaleLines` with `checkMrpFloor` and
`resolveLocationGst`/`isInterStateSupply`.

**Create / edit / delete / status.**
- Statuses a user may set by hand: `draft`, `sent`, `accepted`, `rejected`,
  `expired`. `converted` is reserved for `POST /sales` (`quotations.ts:57–58`).
- **Expiry sweep**: reading the module auto-expires open offers (`draft`/`sent`)
  past `valid_till`; accepted/rejected/converted rows are never touched
  (`quotations.ts:105–112`).
- Edit refused once converted (`quotations.ts:566`); UPDATE guarded by
  `WHERE id = $ AND converted_sale_id IS NULL` (`:626`).
- Status change refused if converted (`:674`), guarded `WHERE converted_sale_id
  IS NULL` (`:684`).
- Delete refused if converted (`:701`), guarded delete `WHERE converted_sale_id
  IS NULL` (`:717`).

**One-sale-per-quotation (dual DB guarantee).** Conversion happens in the
sale-creation transaction (`POST /sales`): it locks the quotation row
`FOR UPDATE`, refuses a second conversion, and stamps `converted_sale_id` /
`converted_invoice_number` on the quote and `quotation_id` / `quotation_number`
on the sale. Two partial unique indexes make this hold even if a race slips past
the row lock (`api-server/src/migrations/quotations.ts`):
- `quotations_one_sale_uq ON quotations (converted_sale_id) WHERE converted_sale_id IS NOT NULL` (`:62–65`).
- `sales_quotation_uq ON sales (quotation_id) WHERE quotation_id IS NOT NULL` (`:88–91`, also seen in `\d sales`).

**Duplicate / re-quote.** NOT FOUND — no `/duplicate`, re-quote or clone route
exists in `quotations.ts` (searched). Re-quoting = creating a new quotation.

**Share links.** Separate `quotation_share_links` table (same shape/rules as
`invoice_share_links`; migration `:97+`) with an in-session token TTL of ~30 min
(`quotations.ts:47`); `createQuotationShareToken` (`quotations.ts:34`).

**DB table.** `quotations` (boot migration): `quotation_number` (unique),
`customer_id`, `location_type/location_id`, `quote_date`, `valid_till`, `status`,
`line_items`, money totals, `payment_terms`, `place_of_supply`, `salesperson`,
`notes`, `terms_conditions`, `converted_sale_id`, `converted_invoice_number`,
`created_by`, timestamps. Indexes on number(uq), customer, date, status, and the
partial one-sale uq.

**Accounting / inventory / party / cash impact.** NONE by design until
conversion; conversion's effects are entirely the `POST /sales` effects (§7).

**Reports / dashboard / audit.** Zero books impact; `logActivity` on
create/edit/status/delete. Not in financial reports.

**Business rules (implemented):**
- A quotation writes nothing to stock, receipts, ledgers, GST or the dashboard.
- Money math is the exact same shared helper as Sales (`buildSaleLines`).
- Its own `QTN/<FY>/NNNN` counter, separate from invoice numbering.
- Reading the list auto-expires stale open offers; outcomes are never re-touched.
- Convert / edit / delete / status changes are all gated on
  `converted_sale_id IS NULL`, and "exactly one sale per quotation" is enforced
  by two partial unique indexes plus a `FOR UPDATE` lock in `POST /sales`.

---


---

>
> Table-name nuance that recurs everywhere (from `src/lib/valuation.ts`
> `PRODUCT_KIND_LABELS`): `item` = **Finished Good**, `material` = **Raw
> Material**, `raw_material` = **Packing Material**. The DB table names read
> opposite to the business terms; the discriminator string is authoritative.


## 10. Purchases

**Route file:** `src/routes/purchases.ts` (~1913 lines).
**Table:** `purchases` (schema confirmed via `\d purchases`).

### 10.1 Create — POST `/purchases`

- Handler at `src/routes/purchases.ts:554`. Permission `page:/production/purchase`
  action `add`.
- **Validation (create):** ISO purchase date (real calendar date); month-lock
  guard (`respondIfMonthLocked`); non-empty line items; inactive-product block
  (create only); product existence check (create only); per-line identity —
  mfg/expiry required and calendar-checked, HSN 4–8 digits, qty > 0, discount
  0–100%; batch number must NOT collide with the reserved format
  `PUR-YYYYMMDD-NNNNN`.
- **Location resolution:** `resolveActingLocation` — Head Office may buy for any
  location; a warehouse may only buy for itself. Stored on
  `purchases.location_type` / `location_id` (schema default `headoffice`/`1`).
- **Ledger branch id (`ledgerBranchId`):** at Head Office, items ledger at
  branch_id `1`, materials/raw_materials at `0`; other locations use their own
  id.
- **Batch allocation:** one batch number per line from sequence
  `PURCHASE_BATCH_SEQUENCE`, format `PUR-YYYYMMDD-NNNNN`.
- **Stock cost basis:** each line is valued at its **taxable cost net of GST and
  discount** (`li.costPerUnit`), never MRP. Weighted-average cost is rolled on
  the materials / raw_materials master and, for items, via
  `updateAvgCostOnInbound`.
- **Atomicity:** the whole operation runs in one transaction — `creditBatch`,
  `creditMaterialAt`, `writeStockLedger` all execute on the same client.
- **Duplicate guard:** a repeated (vendor, invoice_number) → HTTP 409
  `DUPLICATE_PURCHASE_INVOICE`. Backed by DB partial unique index
  `uniq_purchases_vendor_invoice` on `(vendor_id, btrim(invoice_number))` where
  invoice is non-blank AND `branch_transfer_id IS NULL` (so inter-branch
  transfer mirror rows are exempt).

### 10.2 Pricing

- `priceBill` → `calcPurchaseBill` from the shared `@workspace/purchase-pricing`
  package (same engine the web client uses, so quotes and posts agree).
- `resolveSupplyTaxType` derives intra/inter-state from GSTIN state codes (which
  win) or from state names; Head Office falls back to `company_settings`. A
  `null` result leaves the caller's tax type standing.
- `taxTypeOverride` is honoured but recorded as an explicit override.
- `price_mode` is `exclusive` | `inclusive` (DB CHECK `chk_purchases_price_mode`),
  default `exclusive`.

### 10.3 Other charges (freight / hamali)

- Library `src/lib/otherCharges.ts`. Stored as `{ledgerId, amount}[]` in raw
  JSONB column `purchases.other_charges` (default `'[]'`) — written with raw SQL
  because the column is invisible to the Drizzle model.
- **Validation:** each ledger must be an active, postable **expense** ledger; NOT
  under the `SYS-PUR` subtree; NOT carrying a system-code prefix
  (`SYS-`, `SAL-EMP-`, `SAL-PAY-`, `ADV-EMP-`, `GST-`, `STD-BRANCH-`); amount
  > 0, ≤ 2 dp; at most 50 rows.
- Other charges are **never** folded into stock cost, average cost or GST. They
  only increase the amount owed to the vendor: **vendor owed = goods total +
  charges**. (Contrast §10.9.)

### 10.4 Vendor advance application (`useAdvance`)

- Raw-body boolean flag (zod strips it). When set, applies a vendor advance via
  `purchase_advance_applications` + `attributeAdvanceConsumption`, capped at
  `min(available, grandPayable, advanceAmount)`. Requires the `VADV-<id>` ledger
  to already exist.

### 10.5 Edit — PATCH `/purchases/:id`

- Handler at `src/routes/purchases.ts:920`. Line-diff edit.
- **Guards:**
  - Cannot re-point a bill to a different vendor if payments/advances exist →
    `BILL_HAS_SETTLEMENTS`.
  - New total may not shrink below the already-settled floor →
    `BILL_BELOW_SETTLED_AMOUNT`; the floor is re-checked **under a row lock**
    (`FOR UPDATE`).
  - Location is immutable unless an explicit move is requested (a move requires
    line items).
- **Line pairing** by composite key `kind:id:batch`. Untouched lines are left
  alone. Cost change → full reverse + reapply; qty-only change → delta;
  mfg/expiry-only change → in-place date fix with **no stock movement**;
  `isMove` or a duplicate key → treated as ambiguous → full reverse + reapply.
- **Goods-moved refusal:** `stockShortfall` (`purchases.ts:87`) aggregates the
  lot+location quantities the reversal needs, locks those rows, and refuses the
  edit if the goods have already moved on → HTTP 409 `PURCHASE_STOCK_CONSUMED`.
- Average cost is unwound with quantity on reversal
  (`updateAvgCostOnReversal`). Emptied lots are deleted. Stock-ledger reversal
  rows are dated to the bill's **OLD** date.
- Two lighter paths exist: a **metadata-only** edit (`purchases.ts:1666`) and a
  **charges-only** PATCH, both under a row lock that re-checks the settled floor.

### 10.6 Delete — DELETE `/purchases/:id`

- Handler at `src/routes/purchases.ts:1758`. Takes `FOR UPDATE`, checks
  month-lock, and **refuses** if any `payment_bill_allocations` exist →
  `BILL_HAS_ALLOCATIONS`.
- Deletes advance applications and releases their consumption.
- Reverses stock **floored at zero** and dated to the bill's own date. LBAC per
  location.
- **Asymmetry (documented):** delete does NOT run the goods-moved refusal that
  edit runs — it just floors the reversal at zero. Edit is strict, delete is
  lenient.

### 10.7 Accounting derivation

- Purchases are not posted as stored journals; the books are **derived** in
  `src/routes/journal.ts` (`buildDerivedPostings`, purchases branch ~line 1372).
- **Posting:** Dr Purchases (taxable + round-off) + Dr Input CGST/SGST/IGST (via
  `lineTaxHeads`, only when the head split is consistent across lines, else the
  tax is lumped) + Dr each other-charge expense ledger / Cr `VEND-n` for
  (goods + charges).
- Warehouse bills debit **that warehouse's own** purchase ledger; outlets and HO
  use `STD-PUR`.
- Inter-branch transfer purchases post to the clearing ledger
  `STD-BRANCH-TRF` / `branchCreditor` (see §20.x).
- Vendor-advance consumption (`journal.ts:1441`): Dr VEND / Cr VADV, keyed
  `purchadv:<id>`.

### 10.8 Per-bill FIFO settlement

- Library `src/lib/vendorBillSettlement.ts` (`purchaseSettlementIndex`).
- **Vendor owed per bill = `total_amount` + JSONB other_charges sum.**
- Explicit allocations (`payment_bill_allocations` + `purchase_advance_applications`)
  are pinned first and carved out of the pool. The remainder
  (`billed − ledger balance`) is distributed **FIFO oldest-first**.
- Settlement modes: payments (by stored mode, else cash/bank family), debit
  notes, and a synthetic **"Journal"** remainder.
- Asset purchases join the FIFO walk but are not emitted as settlements.

### 10.9 `total_amount` semantics (surprise / asymmetry)

- On **purchases**, `total_amount` is **goods-only**; the vendor-owed figure adds
  the JSONB other-charges on top.
- On **sales**, by contrast, `total_amount` already includes charges. The two
  documents deliberately differ. Anyone summing `purchases.total_amount` for a
  payables figure will understate the liability by the other-charges total.

### 10.10 Asset purchases

- Asset purchases are **not** handled here; `purchases.ts:1910` confirms they
  were moved to `src/routes/assets.ts`. See §21.x.

**Business rules (implemented):**
- A purchase is one atomic transaction across stock, batches, average cost, the
  ledger and (derived) books.
- Stock is valued at taxable cost net of GST and discount, never MRP.
- Other charges bill the vendor and expense to their own ledgers but never touch
  stock cost, average cost or GST.
- (vendor, invoice) is unique per real (non-transfer) bill.
- Edit refuses once goods have moved (`PURCHASE_STOCK_CONSUMED`); delete floors
  reversals at zero and refuses only if payment allocations exist.
- A bill's total can never fall below what has already been settled.
- Vendor payable is settled per-bill, FIFO oldest-first, with explicit
  allocations pinned first.

---


---

## 11. Returns

Returns are memo documents anchored to their original invoice/bill. Sales returns (§11.1) credit the customer; purchase returns (§11.2) debit the vendor.

### 11.1 Sales Returns

**Purpose.** Return goods against an existing (non-cancelled) sale invoice,
restore stock at the sale's location, and refund the money — a **credit note**
for registered customers or a **cash refund** for walk-ins. Sales returns are
**invoice-anchored memo documents**; they never mutate the original sale row.
Source: `api-server/src/routes/returns.ts` (sales section, ~lines 180–1065).

**Access / permissions.** Create:
`requireModuleAction(["page:/returns", "page:/sales/pos"], "add")` (`returns.ts:181`).
List: `requireModuleView("page:/returns")` (`:563`). Edit:
`requireModuleAction("page:/returns", "edit")` (`:628`). Additionally, only
users of the sale's location (or Head Office acting for it) may take the return —
holding the Returns right is not authority over another location's stock/books;
foreign ids get 404 (`returns.ts:240–248`).

**Anchoring & returnable quantity.** The sale is locked `FOR UPDATE`
(`returns.ts:213`). Blocked if the sale is cancelled (`SALE_CANCELLED`, 409;
`:218`) — cancelling already restored stock. Return date cannot precede the sale
date (`:223`). Per line: `returnable = soldQty − Σ(already returned across all
returns for this sale)`; over-return rejected with a `+0.001` tolerance
(`:289–304`); duplicate `lineIndex` in one request rejected (`:197–203`).

**Money — gross vs net.** Money is **prorated from the stored sale line by
quantity** (`frac = rq / soldQty`), keeping the credit note consistent with the
original invoice's inclusive-GST math including line discounts (`returns.ts:306–314`).
Persisted return line keeps `unitPrice` (gross printed unit price;
`:347`) alongside `taxableAmount` (the net/taxable, Net Rate basis; `:349`),
`cgst/sgst/igst`, `taxAmount`, `grossAmount`. Post-tax coupons and Other Charges
are **excluded** from returns by design (`returns.ts:400–408`): the charge was
incurred delivering the goods and does not come back; refunding a charge is an
explicit act (edit the sale, or raise a manual voucher).

**Batch restore (LIFO undo).** The consumed `batchBreakdown` is walked in
**reverse** (LIFO), capped per batch by what earlier returns already restored,
and applied via `restoreBatches` (`returns.ts:316–337, 489–493`). Any residual
beyond the tracked breakdown (legacy lines) still returns the full qty to
`stock_entries` (`:338–398`).

**Refund routing.**
- Registered customer (`sale.customer_id`): raise a **credit note** journal
  voucher (`nextVoucherNumber("credit_note")`) at the sale's location; decrement
  customer `total_purchases`; `refund_mode='credit_note'` (`returns.ts:424–457`).
  Requires `CUST-<id>` ledger to exist (else 400 asking to save the customer once).
- Walk-in (no customer): **cash refund** — a `payments` row with
  `source='refund'` from the location cash ledger to the sales ledger
  (`returns.ts:458–477`); `refund_mode='cash'`.

**Accounting legs (credit note; `returns.ts:431–451`).** For total taxable
`subtotal`, GST `totCgst/totSgst/totIgst`, gross `totalAmount`:
- `Dr STD-SALES` (location sales ledger, or `STD-SALES` fallback) for
  `subtotal + unresolved` (residual GST that had no head).
- `Dr` each resolved Output-GST head returned by `resolveGstHeads("output", …)`
  (`STD-OUT-CGST` / `STD-OUT-SGST` / `STD-OUT-IGST`).
- `Cr CUST-<id>` for the full `totalAmount`.
Voucher type `credit_note`, `partyLedgerId = CUST-<id>`, located at the sale's
location. (Cash-refund path posts via the `payments` voucher: cash ledger →
sales ledger; `returns.ts:467–474`.)

**Payment-status restatement.** After a credit note, the sale's stored
`payment_status` is recomputed from `computePaymentPosition` using
`creditAdjustmentsExpr` so a fully-credited invoice drops off collection lists
(`returns.ts:498–514`).

**Edit — `PATCH /sales-returns/:id` (`returns.ts:628+`).** Locks the return
`FOR UPDATE` (`:659`); recomputes returnable excluding *this* return (`:718`);
**delta stock**: raise/lower `stock_entries` and batch layers by `newQ − oldQ`
per line (`:835–911`); rewrites the linked credit-note voucher
(`rewriteVoucher`, `:944`) or restates the refund payment (`:963–974`);
corrects the stock-ledger business date and writes delta movement rows
(`:1004–1027`). Month-locked both-dates guarded.

**DB table.** `sales_returns` (verified `\d sales_returns`): `return_number`,
`sale_id` (FK), `customer_id`, `location_type/location_id`, `return_date`,
`line_items jsonb`, `subtotal`, `tax_total`, `total_amount`, `refund_mode`,
`credit_note_id`, `refund_payment_id`, `reason`, `created_by`. Indexes on
sale_id and customer_id.

**Inventory / party / cash / location.** Stock restored at the **sale's**
location (HO round-trips as headoffice/1, never coerced to outlet;
`returns.ts:230–238`); stock ledger written **inside** the transaction so the
trail commits/rolls back atomically (`returns.ts:516–527`). Retired-outlet /
disabled-warehouse gate on the return location (`:250–265`).

**Reports / dashboard.** Credit notes reduce revenue in derived postings and are
the only return type counted as a credit adjustment in the payment position
(`salePaymentPosition.ts`). Cash refunds appear in the payments stream.

**Audit.** `logActivity` on create (`returns.ts:531`) and edit (`:1029`),
module `sales`, entityType `sales_return`.

**Validations.** saleId/returnDate/lines shape; qty > 0; no duplicate lineIndex;
month-lock (create + both dates on edit); sale not cancelled; return date ≥ sale
date; per-line returnable cap; total > 0; required ledgers (`STD-SALES`,
`CUST-n`) / cash ledger present.

**Business rules (implemented):**
- Returns are anchored to a non-cancelled sale; cancelled invoices cannot be
  returned against (stock already restored).
- Returnable qty per line = sold − already-returned across all returns (with a
  small tolerance); duplicate line indexes are rejected.
- Money is prorated from the stored line (gross `unitPrice` + net taxable),
  keeping inclusive-GST math; coupons and Other Charges are never returned.
- Batches are restored LIFO, capped by prior returns; residual legacy qty still
  returns to `stock_entries`.
- Registered customer → credit note (`Dr Sales + Dr Output-GST heads / Cr
  CUST-n`) and `total_purchases` decremented; walk-in → cash refund payment.
- Edit applies delta stock and rewrites the same credit-note/refund voucher;
  stored `payment_status` is restated after a credit note.

---


### 11.2 Purchase Returns

**Route file:** `src/routes/returns.ts` (POST at line 1068).
**Table:** `purchase_returns` (FK → `purchases`).

- **Permission:** `page:/returns` OR `page:/production/purchase`, action `add`.
- Locks the parent purchase `FOR UPDATE`. Accounting location = the purchase's
  location (legacy rows treated as HO); LBAC scoped.
- **Date rule:** return date must be ≥ purchase date.
- **Returnable quantity:** `bought − already returned`, tracked per `lineIndex`.
- **Stock:** deducts at the purchase's location — FEFO `consumeBatches` for
  materials, `debitBatchByNumber` for items — availability-checked.
- **Money:** prorated by the returned-quantity fraction against the stored line
  values.
- **Document:** raises a **debit note** (`nextVoucherNumber("debit_note")`):
  Dr VEND / Cr STD-PUR + Cr the Input GST heads (`resolveGstHeads`).
- Writes the `purchase_returns` row and the stock_ledger rows inside the
  transaction.
- **Other charges are NOT touched on return (kept BY DESIGN):** freight/hamali
  already incurred are not reversed proportionally.
- **Edit:** PATCH exists (`returns.ts:1443`), rewriting the debit-note voucher.

**Business rules (implemented):**
- You cannot return more than was bought (net of prior returns), per line.
- A return removes stock at the original purchase location, FEFO/by-batch.
- Money returned is a straight pro-rata of the bought line values.
- A debit note reduces the vendor payable and reverses input GST.
- Freight/hamali (other charges) stay with the vendor — deliberately not
  reversed.

---


---

## 12. Receipts

Receipt vouchers record money **coming in** (a debit to a cash/bank/clearing ledger, a credit to the payer's ledger). Backend routes live in `artifacts/api-server/src/routes/accounts.ts` (~1308–1971). Rows are stored in the `receipts` table. Frontend page: `artifacts/marlin-erp/src/pages/operations/receipt-voucher.tsx` (route `/operations/receipt-voucher`).

### Endpoints
- `GET /accounts/receipts` — list, location-scoped (`accounts.ts` ~1308).
- `POST /accounts/receipts` — create (manual, allocation, or advance).
- `PATCH /accounts/receipts/:id` — edit (manual only).
- `DELETE /accounts/receipts/:id` — delete (manual/allocation; unwinds settlement).
- `GET /accounts/receipts/:id/delete-impact` — admin-only preview of a system-delete (`computeSaleReceiptImpact`).
- `POST /accounts/receipts/:id/system-delete` — admin-only forced delete of a sale-linked receipt.

### Voucher numbering
Numbers are allocated by `nextVoucherNumber(q, 'receipt', date)` (`lib/voucherNumber.ts`), format `REC/<FY-LABEL>/NNNN` (e.g. `REC/2026-27/0001`), FY-scoped via an atomic upsert on `voucher_sequences` (safe against concurrency and deletions). Default prefix `REC` (`DEFAULT_VOUCHER_PREFIXES.receipt`).

### Origin / system-vs-manual classification
A receipt is treated as **system** (locked for edit) when any of: `is_clearing` is set, OR `is_sale_receipt` (its `voucher_number` matches a `sales.invoice_number`), OR `source != 'manual'`. `source` values seen: `manual`, `allocation`, `sale`, `counter`, `settlement`, `deposit` (reconcile). Sale-linked receipts are **excluded** from `buildDerivedPostings` when they are clearing/invoice-matched, preventing a double count against the sale's own posting.

### Bill-wise settlement (allocation) path
When the body carries `allocations` (`[{ saleId, amount }]`) and/or `advanceAmount`, the receipt is stored with `source='allocation'` and writes `sale_payments` rows tied back by `clearing_receipt_id`. Per-invoice excess is capped at each invoice's outstanding. Any excess beyond invoices becomes **customer advance** — booked as a credit (negative) balance on the customer's own `CUST-<id>` ledger; there is **no separate customer advance ledger** (`advance_ledger_id` stays NULL). A duplicate-submit guard rejects an identical receipt within ~10 seconds. Allocation receipts are edit-locked; delete unwinds the `sale_payments` legs.

### Manual edit / delete
`loadManualReceipt` only loads rows with `source='manual'`; a NULL `source` fails closed (not editable). Editing is subject to a **month-lock** check (HTTP 423) against both the stored date and any new date. Deletes of allocation receipts reverse the settlement.

### Admin system-delete of sale receipts
`POST /accounts/receipts/:id/system-delete` is level-1 admin only and requires a `reason` of ≥5 characters. `computeSaleReceiptImpact` classifies the row as: **collection** (has `sale_payments` legs), **invoice-trail** (voucher_number equals an invoice number; reversal = `amount_paid − Σ legs`), or **orphan**. It **blocks (409)** when the underlying sale is cancelled or when the invoice number is ambiguously shared across multiple sales.

**Business rules (implemented):**
- A receipt is system/locked if `is_clearing` OR sale-invoice-matched OR `source != 'manual'`; only `source='manual'` rows are editable.
- Numbers are `REC/<FY>/NNNN`, FY-scoped and concurrency-safe via `voucher_sequences`.
- Customer advances are credit balances on `CUST-<id>` — no dedicated advance ledger.
- Allocation receipts write `sale_payments` (linked by `clearing_receipt_id`), cap excess at per-invoice outstanding, and are edit-locked; delete unwinds them.
- A ~10s duplicate-submit guard blocks accidental double posting.
- Month-lock returns 423 on both stored and new dates.
- Sale-linked receipts are excluded from derived postings to avoid double counting.
- Admin system-delete: level-1 only, reason ≥5 chars; blocks on cancelled sale or ambiguous shared invoice number (409).

---

## 13. Payments

Payment vouchers record money **going out** (a debit to the payee/expense ledger, a credit to a cash/bank ledger). Backend: `accounts.ts` (~573–1304). Rows stored in the `payments` table. Frontend page: `artifacts/marlin-erp/src/pages/operations/payment-voucher.tsx` (route `/operations/payment-voucher`).

### Endpoints
- `GET /accounts/payments` — list, location-scoped.
- `POST /accounts/payments` — create.
- `PATCH /accounts/payments/:id` — edit (editable sources only).
- `DELETE /accounts/payments/:id` — delete (guarded when advance consumed).

### Voucher numbering
`nextVoucherNumber(q, 'payment', date)` → `PAY/<FY-LABEL>/NNNN`, FY-scoped via `voucher_sequences`.

### Editability / system locks
`PAYMENT_EDITABLE_SOURCES = { manual, vendor }`. All other `source` values are system-owned and locked, with a per-source message from `SYSTEM_SOURCE_LOCK_MESSAGES` (system sources observed: `settlement`, `deposit`, `expense`, `refund`, plus accrual-driven payouts). Rows flagged `is_location_expense` or `is_refund` are also locked for edit/delete.

### Vendor bill settlement path
Vendor payments allocate to bills through `payment_bill_allocations` and apply vendor advances through `purchase_advance_applications`. Excess money parks in a **vendor advance ledger** (code `VADV-<vendorId>`) created on demand by `ensureAdvanceLedger` (`lib/advanceLedgers.ts`). Delete is refused when the voucher's advance has since been consumed — checked precisely per-voucher (`voucherAdvanceConsumed`) with a vendor-level aggregate (`advanceAvailable`) backstop.

### Manual money vouchers
Manual money vouchers no longer read or write `payment_mode` or attachment fields (those columns are retained for legacy rows only). Money-voucher location and leg legality are enforced by `lib/moneyScope.ts` (see §16).

**Business rules (implemented):**
- Editable sources are exactly `{ manual, vendor }`; every other source is locked with a source-specific message.
- `is_location_expense` and `is_refund` vouchers are locked for edit/delete.
- Numbers are `PAY/<FY>/NNNN`, FY-scoped, concurrency-safe.
- Vendor excess parks in `VADV-<vendorId>` (created by `ensureAdvanceLedger`); a vendor payment cannot be deleted once its advance is consumed.
- Bill settlement uses `payment_bill_allocations` + `purchase_advance_applications`.
- Manual vouchers ignore legacy `payment_mode`/attachment columns.

---

## 14. Journals

Manual journal (JV) vouchers are free-form double entries. Backend: `artifacts/api-server/src/routes/journal.ts`. Rows stored in `journal_vouchers` (header) with lines. Frontend page: `artifacts/marlin-erp/src/pages/accounts/journal.tsx` (route `/accounts/journal`); listed alongside other vouchers at `/accounts/vouchers`.

### Endpoints
- `POST /accounts/journal-vouchers` — create.
- `PATCH /accounts/journal-vouchers/:id` — edit.
- `DELETE /accounts/journal-vouchers/:id` — delete.
- `GET /accounts/voucher-locations` — location options for the lines.

### Voucher numbering
`nextVoucherNumber(q, 'journal', date)` → `JV/<FY-LABEL>/NNNN`. Other voucher types share the same allocator with prefixes `CTR` (contra), `CN`, `DN`, `SR`, `PR`, `EXP` (`DEFAULT_VOUCHER_PREFIXES`).

### Editability rules
`isEditableVoucher` = `origin === 'manual'` **and** the voucher type is in the JV family (`JV_TYPES`, `journal.ts` ~87-88) — non-JV types surface a `lockedReason` instead. An unknown/NULL origin is **locked for edit but still deletable**; `origin === 'system'` is **blocked for delete**. Changing the voucher **type** is forbidden. Changing the date across the FY boundary is forbidden when the voucher number is preserved (the number encodes its FY). Concurrent edits are protected by optimistic concurrency (`expectedRev`). Line locations are validated by `checkLinesLocation` (~361).

### Posting
JV lines participate in `buildDerivedPostings` (`journal.ts` section 3, ~1078), so journals flow into the Trial Balance, P&L, Balance Sheet and ledger statements through the same single stream as every other source. A line's location is `COALESCE(<return-doc location>, <voucher stamp>)`.

**Business rules (implemented):**
- Only `origin === 'manual'` vouchers are editable; NULL origin is edit-locked but deletable; `origin === 'system'` cannot be deleted.
- Voucher type is immutable; a preserved number forbids a date change that crosses the FY.
- Optimistic concurrency via `expectedRev`.
- JV lines post through the shared derived-postings stream (reach P&L / TB).
- Numbers are `JV/<FY>/NNNN`, FY-scoped, concurrency-safe.

---

## 15. Expenses

Two entry points exist and both ultimately live in the `payments` table, discriminated by the `is_location_expense` flag (NOT by the funding ledger). Backend: `accounts.ts` (~3168–3348 for `/accounts/location-expenses`; a separate `POST /expenses` at ~2699). Frontend pages: `/sales/expenses` and `/accounts/expenses`.

### Location expenses
`POST /accounts/location-expenses` stores a `payments` row with `is_location_expense = true`, `source = 'expense'`, a `payment_mode` of `cash`/`bank`/`credit`, plus free-text `notes`. Funding routing by mode:
- **cash** — checks the location's till balance; credits the location cash ledger.
- **bank** — Head-Office only; credits the `STD-BANK` (standard bank) ledger.
- **credit** — books to `STD-EXP-PAY` (expenses payable).

Delete (audit task #40) is guarded by both the `is_location_expense` flag and membership in the expense ledger subtree. In `buildDerivedPostings`, expenses debit the expense ledger and credit the CBA/location cash-bank ledger (falling back to `STD-CASH`/`STD-BANK` where no specific account applies).

### Accrual-driven expenses (rent, salary)
Rent and salary are recognised **daily as incurred**, independent of approval or payment, via timer-driven catch-up sweeps:

- **Rent** (`lib/rentAccrual.ts`): each active `warehouse_rent_agreements` row accrues `monthly_rent / days_in_month` per day into `rent_accruals`, idempotent via the unique index `(warehouse_id, accrual_date)`. The last covered day of a month absorbs the rounding remainder so a full month totals exactly. Runs hourly as a catch-up (`startRentAccrualScheduler`), serialised per warehouse by advisory lock `pg_advisory_xact_lock(8202, warehouse_id)`. Approved/paid `rent_periods` months and `accounting_period_locks` months are frozen (never accrued or rebuilt). A mid-month rent revision **deletes and rebuilds every unapproved month in full at the new rate** (`recalcUnapprovedRentAccruals`). Rent has **no true-up voucher**, so approval is gated on `rentMonthCoverage` (every day reached the books) and `isPeriodAccrualComplete` (the month has ended). Postings (`journal.ts` ~1484): Dr `expense_ledger_id` / Cr `payable_ledger_id` per accrual row, located to the warehouse, source `rent`, **ungated** (running month shows in P&L). Rent *payments* are real vouchers debiting the same payable — no double count.
- **Salary** (`lib/salaryAccrual.ts`): same shape — Dr `SAL-EMP-<employeeId>` / Cr `SAL-PAY-<employeeId>` per accrued day (`journal.ts` ~1519), located to the employee's branch, source `salary`, ungated. Unlike rent, approval writes a real **true-up voucher** debiting only the difference between payroll's computed figure and what already accrued. Months approved before daily accrual existed carry their original full-value voucher and are untouched.

**Business rules (implemented):**
- The expense discriminator is `is_location_expense = true` with `source = 'expense'`, not the funding ledger.
- Cash-mode expenses check till balance; bank-mode is HO-only via `STD-BANK`; credit-mode books to `STD-EXP-PAY`.
- Expense delete requires the flag AND expense-subtree membership.
- Rent/salary are recognised daily (ungated by approval): rent per `monthly_rent/days_in_month` with last-day remainder absorption; both idempotent and catch-up.
- Rent approval freezes the month and needs full coverage (no true-up); salary approval posts a difference-only true-up voucher.
- Rent revision rebuilds all unapproved months in full at the new rate; approved/period-locked months are never touched.
- Rent/salary payments are separate vouchers crediting cash and debiting the payable — no double recognition.

---

## 16. Cash & Bank

Backend: `accounts.ts` (~2094–2496), `lib/cashBankLedgers.ts`, `lib/openingBalances.ts`, `lib/moneyScope.ts`. Frontend page: `/accounts/cash-bank`; books at `/accounts/cash-book`, `/accounts/bank-book`; cash-in-outlet at `/accounts/cash-in-outlet`; reconciliation at `/accounts/reconciliation`.

### Cash & Bank accounts and CBA ledgers
Each cash/bank account is backed by a ledger `CBA-<id>` filed under the system group `STD-CASH` or `STD-BANK`. Balances are **fully derived** from the posting stream (`currentBalanceIndex` / `idx.net`); the stored `balance` column is dead. Branch tills are read-only from HO and deduped by ledger (warehouse identity wins over child-outlet mirror). `requires_reconciliation` is bank-only and defaults ON. Account `type` is immutable; writes are Head-Office only; delete is blocked by existing transactions, references, or children.

### System-ledger protection (chart of accounts)
`STD-CASH` and `STD-BANK` cannot be deactivated ("system accounts"). `CBA-*` ledgers cannot be edited from the chart ("manage from Accounts → Cash & Bank"). `is_system_group` ledgers cannot be deactivated. Any ledger with a `code` (system-owned) cannot be renamed and `code` is never writable.

### Opening balances
All openings go through one path, `upsertOpeningBalance` (`lib/openingBalances.ts`), counterweighted by a single equity ledger `STD-OB-ADJ` (under `SYS-CAP`), kept in balance by `rebalanceCashBankOpeningEquity` (recompute-from-scratch under an advisory lock). Openings fold into reports as company-level postings dated at their as-of date (`openingBalancePostings`), so the Trial Balance, Balance Sheet, Cash/Bank Books and the Cash & Bank screen all agree (audit finding M-1 fixed — verified: `computeCashBankBook` and `computeTrialBalance` both concat `openingBalancePostings`).

### Payment modes
`lib/paymentModes.ts` defines `Cash`, `Bank`, `UPI`, `Credit`. Legacy `card` / `bank_transfer` are **read** as Bank but never rewritten. New sales accept only `cash` or `credit`; `clearsThroughBank` modes (UPI/card, settled but awaiting bank) route through the Electronic Payment Clearing ledger.

### Money-voucher scope (LBAC)
`lib/moneyScope.ts`: `checkVoucherLegs` allows a branch to touch only its **own till**, blocking foreign/HO cash-bank ledgers (`headOfficeCashBankLedgerIds`) and foreign party ledgers (`foreignPartyLedgerIds`). `resolveMoneyVoucherLocation` decides a voucher's location: an explicit body location is a request not authority; the till owner's location wins; a mirror picks the warehouse; otherwise it falls back to the current stamp / caller. The cash-bank book/trial-balance full ledger lists are Head-Office only (`journal.ts` ~1646, ~1729).

### Electronic collections & reconciliation
UPI/card sale collections post to `STD-ELEC-CLR` (Electronic Payment Clearing) as `sale_payments` with `reconciliation_status = 'pending'` (`sales.ts` ~838, ~1073, ~1161). `POST /reconciliation/batches` (`reconciliation.ts` ~345) locks the selected pending payments, refuses any non-pending, generates a batch reference `RECON-<year>-NNNN` (advisory-locked, MAX-suffix+1), marks them `reconciled`, and posts: Dr bank / Cr `STD-ELEC-CLR` for the net (a `settlement`-source receipt) plus, if charges apply, a `settlement`-source payment Dr `STD-PROC-CHG` / Cr `STD-ELEC-CLR`. Batch vouchers are stamped to the destination bank's location via `resolveMoneyVoucherLocation`. `GET /reconciliation/pending`, `/reconciliation/reconciled`, `/reconciliation/batches[/:id]` support the flow.

### Cash-in-outlet (deposits / cash-in-transit)
`POST /cash-in-outlet/deposits` (`cash-in-outlet.ts` ~222) posts a `deposit`-source payment Dr `STD-CIT` (Cash in Transit) / Cr the location cash ledger and inserts a `cash_deposits` row (`status='pending_reconciliation'`), location-scoped and month-locked. `POST /cash-in-outlet/deposits/:id/reconcile` (~367) posts a `deposit`-source receipt (`cash-in-outlet.ts` ~463; the charges payment likewise carries source `deposit`) Dr destination bank / Cr `STD-CIT` for the net (charges deducted), sets the deposit `status='reconciled'` with `bank_receipt_id`. (Only the reconciliation-*batch* path in `reconciliation.ts` uses source `settlement`.) Deposits are LBAC-scoped (a location can only deposit its own cash).

**Business rules (implemented):**
- Every cash/bank account is a `CBA-<id>` ledger under `STD-CASH`/`STD-BANK`; balances are derived, the stored `balance` is dead.
- Branch tills are read-only from HO, deduped by ledger (warehouse wins); `requires_reconciliation` is bank-only, default ON.
- Account type immutable; writes HO-only; delete blocked by transactions/references/children.
- `STD-CASH`/`STD-BANK`/system groups cannot be deactivated; `CBA-*` and any coded ledger cannot be renamed/edited from the chart.
- Openings go through `upsertOpeningBalance`, counterweighted by `STD-OB-ADJ` (under `SYS-CAP`) and rebalanced from scratch under a lock; they fold into all reports as as-of-dated company postings (M-1 fixed).
- Payment modes are Cash/Bank/UPI/Credit; legacy card/bank_transfer read as Bank; new sales are cash/credit only; bank-clearing modes route via `STD-ELEC-CLR`.
- A branch money voucher may touch only its own till; foreign/HO cash-bank and foreign party ledgers are blocked; voucher location resolves by till ownership over the requested body location.
- Electronic collections sit pending in `STD-ELEC-CLR`; reconciliation batches (`RECON-<year>-NNNN`) move net to bank and charges to `STD-PROC-CHG`, marking payments reconciled.
- Cash deposits move cash → `STD-CIT` (pending) then `STD-CIT` → bank on reconcile; both are location-scoped and month-locked.

---

<!--
  Marlin Frozen Fruits ERP — Functional + Technical Specification
  Part: Accounting, Chart of Accounts, Ledgers, GST, Transaction-flow maps, End-to-end example
  Source of truth: code + live dev DB (read-only). schema.ts is partial and NOT trusted here.
  Primary files:
    artifacts/api-server/src/routes/journal.ts   (buildDerivedPostings, day book, cash/bank book, trial balance)
    artifacts/api-server/src/lib/books.ts         (buildBooks — TB / P&L / BS)
    artifacts/api-server/src/lib/ledgerBalances.ts(ledger statement, currentPartyStatement)
    artifacts/api-server/src/lib/gst.ts           (lineTaxHeads, slabs, GST ledger codes)
    artifacts/api-server/src/lib/gstTransfer.ts   (isInterStateSupply, transfer classification & JVs)
    artifacts/api-server/src/lib/gstinScope.ts    (filing-scope resolver)
    artifacts/api-server/src/routes/gst.ts        (GSTR-1 / 3B / HSN / reconciliation)
    artifacts/api-server/src/lib/voucherNumber.ts (allocators)
    artifacts/api-server/src/lib/periodLock.ts    (month lock)
-->

## 17. Accounting

### 17.1 Purpose and the central architectural decision

Marlin's accounting layer is **derivation-first**. There is **no stored, persisted
double-entry line table for business documents**. Sales, purchases, receipts,
payments, expenses, rent, salary, and the transfer/production/note journal
vouchers are stored in their own operational tables; the balanced double-entry
posting stream is **recomputed on every read** by a single function,
`buildDerivedPostings()` (`artifacts/api-server/src/routes/journal.ts:919`).

`buildDerivedPostings()` returns an array of `Posting` objects
(`journal.ts:882-903`):

```
Posting = { date, entryId, ledgerId, debit, credit,
            source, voucherNumber, description,
            locationType, locationId }
```

Consumers on top of that stream:

- `buildBooks()` (`lib/books.ts:570`) — the ONLY producer of Trial Balance,
  P&L and Balance Sheet.
- `buildLedgerStatement()` / `currentPartyStatement()` (`lib/ledgerBalances.ts:333,420`)
  — ledger + party statements (running balance).
- `computeTrialBalance()`, `computeCashBankBook()`, the Day Book route — all in
  `journal.ts` (1749, 1668, 1550).

**Why this matters for a rebuild:** you cannot "insert a journal entry" for a
sale and expect it to appear. To change how a sale posts, you change the
derivation rule. Statements can therefore *never disagree with each other*
because they all fold the same one stream. The tradeoff is that every statement
read recomputes the full stream (see §Known limitations).

Two invariants make the statements balance by construction (`books.ts:11-26`):

1. Every derived entry is internally balanced (Σdebit = Σcredit per `entryId`),
   so summing across all ledgers is exactly zero → Assets = Liabilities + Profit
   with no plug line. Any residual is a **real defect** (posting to a deleted
   ledger, ledger under no root, or an unbalanced opening balance set) and is
   surfaced as an error, never absorbed.
2. Inventory is **periodic** (purchases expensed; stock brought in via
   opening/closing valuation), except the production **capitalisation overlay**
   (`STD-FG-INV` / `STD-PROD-ABS`) which is a matched Dr/Cr pair *excluded* from
   the statements so stock is never double-counted.

### 17.2 Who can access / permissions

All accounting *views* are RBAC-gated per page key (default-deny). Representative
guards seen in code:

- Day Book: `requireModuleView("page:/accounts/day-book")` **and** the day book
  is Head-Office-only — a non-`headoffice` caller gets an empty payload
  (`journal.ts:1550-1555`).
- Trial Balance / Cash Book / Bank Book / financial reports: `page:/accounts/*`
  view rights, LBAC location filter narrows only.
- GST returns: `requireModuleView("page:/accounts/gst-returns")`
  (`routes/gst.ts:218,322`).
- Company-level accounting tiles are **omitted (never zeroed)** for branch
  logins because postings carry no location for company-level figures.

Writes that *feed* the stream are gated on their own module (sales `page:/sales/pos`,
expenses `page:/operations/expenses`, vouchers `page:/accounts/vouchers`, etc.)
with `requireModuleAction`.

### 17.3 The derivation, source by source (exact Dr/Cr legs)

`buildDerivedPostings()` first loads `account_ledgers` into a code→row map
(`journal.ts:959-961`) and resolves the standard head ids (`stdCash`, `stdBank`,
`stdSales`, `stdDtx`, `stdPur`, `elecClr`=`STD-ELEC-CLR`, `debtors`=`SYS-DEBTORS`,
`creditors`=`SYS-CREDITORS`, `branchTrf/branchDebtor/branchCreditor`). It builds a
per-location map of cash/sales/purchase ledgers from `warehouses` and `outlets`
(`journal.ts:978-983`). It then walks each source. `push()` drops any leg with
both sides ≤ 0.004 and normalises the date to `YYYY-MM-DD` (`journal.ts:932-945`).

Legs below use ledger **codes**; the live chart (verified) is in §18.

#### Source 1 — Payments (`payments`) — `journal.ts:985-1020`
Cr `paid_from_ledger_id`, Dr `paid_to_ledger_id`, dated `payment_date`.
If the row carries a vendor **advance** slice (`advance_amount` + `advance_ledger_id`):
Dr `paid_to` for `amount − advance`, **Dr the vendor-advance ledger (`VADV-n`)** for the
advance, Cr `paid_from` for the full amount. Location defaults to `headoffice`/0 for
legacy rows; sales-return cash refunds backfill location from the linked
`sales_returns` row.

#### Source 2 — Receipts (`receipts`) — `journal.ts:1022-1049`
Dr `received_in_ledger_id`, Cr `received_from_ledger_id`, dated `receipt_date`.
**Excluded** from this leg: any receipt whose id is referenced by
`sale_payments.clearing_receipt_id`, and any receipt whose `voucher_number`
equals a `sales.invoice_number` (sale-linked receipts) — those settlements are
derived from Source 5 instead, to avoid double-count.

#### Source 2b — Advance slice of allocation receipts — `journal.ts:1051-1076`
For a receipt that both settles bills (`clearing_receipt_id` present, excluded
above) AND has `advance_amount > 0`: Dr `received_in`, Cr the **customer's own
`CUST-n` ledger** (single-ledger advance model — the advance IS a credit balance
on the customer ledger; there is no separate customer-advance ledger since
`customer_advances_fold_v1`).

#### Source 3 — Journal voucher lines (`journal_voucher_lines`) — `journal.ts:1078-1110`
Posted **as stored** (Dr/Cr verbatim). Covers `voucher_type` in
`journal`, `contra`, `credit_note`, `debit_note`, `branch_transfer_sale`,
`branch_transfer_purchase`, and the system JVs (payroll true-up, production
overlay). Location = COALESCE(source sales-return location, source
purchase-return-via-purchase location, voucher's own `location_type/id`).

#### Source 4 — Expenses (`expenses`) — `journal.ts:1112-1139`
Dr `ledger_account_id` (the expense head), Cr the paying account's `CBA-{id}`
ledger (joined via `cash_bank_accounts`). Fallback when the account predates the
Cash&Bank↔chart link or was hand-deleted: Cr `STD-BANK` if the account type
contains "bank", else `STD-CASH`. Location defaults to `headoffice`/0.

#### Source 5 — Sales (`sales`) — `journal.ts:1141-1370` — the **gross debtor model**
Selects non-cancelled sales (`cancelled_at IS NULL OR branch_transfer_id IS NOT NULL`
— cancelled branch-transfer invoices stay in on purpose because their rejection
credit note reverses them). Per sale, with `total = total_amount`, `tax = tax_total`,
`ocTotal = Σ other_charges` (raw JSONB), `net = total − tax − ocTotal`:

1. **Revenue** — Cr location `sales_ledger_id` (else `STD-SALES`) for `net`,
   dated `sale_date`. Branch transfer → Cr `STD-BRANCH-TRF` instead.
2. **Output GST** — when `tax > 0`, sum per-line `lineTaxHeads()` into cg/sg/ig.
   If `STD-OUT-CGST/SGST/IGST` exist and the head split is within 0.05 of `tax`:
   Cr `STD-OUT-CGST` (cg), Cr `STD-OUT-SGST` (sg), Cr `STD-OUT-IGST` (ig); any
   ≤0.05 residual posts to `STD-DTX` (Cr if positive, Dr if negative) — the exact
   paise-remainder handling. Otherwise a single Cr lump to `STD-DTX`.
3. **Other charges** — one Cr per charge row to its own expense ledger
   (`other_charges[].ledgerId`) = an *expense recovery*, dated `sale_date`.
4. **Branch transfer**: Dr `STD-BRANCH-DEBTOR` (else `SYS-DEBTORS`) for the full
   `total`, then `continue` (no customer/cash legs).
5. **Gross debtor legs** (when `sales.customer_id` resolves to a `CUST-n` ledger):
   - Dr `CUST-n` for the full `total` at `sale_date` (description `Invoice <no>`).
   - For each `sale_payments` row: Dr the money ledger at `payment_date`
     (advance → Dr `CUST-n`; allocation-receipt → Dr `received_in`; sale-receipt
     landed directly in a bank/UPI account with reconciliation off → Dr that
     account; else cash → Dr location cash, non-cash → Dr `STD-ELEC-CLR`) **and**
     Cr `CUST-n` for the same amount (the "receipt" line of the statement;
     advance rows are a deliberate Dr/Cr wash on `CUST-n`).
   - Counter money with no `sale_payments` row of its own (`amount_paid − Σ all
     sale_payments`) is dated at the sale: Dr `STD-ELEC-CLR` (if payment mode
     clears through bank) or location cash, Cr `CUST-n`.
   - No remainder leg needed — the customer's *net* on `CUST-n` is `total − paid`.
6. **Net model** (walk-in / no customer / hand-deleted ledger): no `CUST-n` debit;
   settled legs debit cash/clearing; the remainder `due = total − amount_paid`
   posts Dr `SYS-DEBTORS` (or `CUST-n` if it exists), or a negative `due` posts a
   Cr "Overpayment held" leg on the customer/`SYS-DEBTORS` ledger.

**Net effect on the customer ledger is identical in both models** (`total − paid`);
gross model just makes the statement read like a book of account.

#### Source 6 — Purchases (`purchases`) — `journal.ts:1372-1439`
Per bill, `amt = total_amount`, per-line `lineTaxHeads()` → cg/sg/ig,
`inputTax = cg+sg+ig`. Split posts **only if internally consistent** (line head
sum agrees with line `taxAmount` sum within 0.05 and with stored `tax_total` when
non-zero, and `0 < inputTax < amt`):
- Dr purchase ledger (`amt − inputTax`) — location `purchase_ledger_id` for
  warehouses, else `STD-PUR`; branch transfer → `STD-BRANCH-TRF`.
- Dr `STD-INP-CGST`/`STD-INP-SGST`/`STD-INP-IGST` for cg/sg/ig.
Otherwise a single Dr lump = `amt` to the purchase ledger (legacy behaviour).
- **Other purchase charges** — Dr each `other_charges[].ledgerId` for its amount.
- Cr vendor `VEND-n` (else `SYS-CREDITORS`, or `STD-BRANCH-CREDITOR` for transfers)
  for `amt + Σ charges`. (Note the **asymmetry**: purchase `total_amount` is
  goods-only so charges are *added*; sale `total_amount` already *includes*
  charges. Verified `journal.ts:1438` vs `1215`.)

#### Source 6b — Vendor-advance applications (`purchase_advance_applications`) — `journal.ts:1441-1464`
Dr `VEND-n` / Cr `VADV-n` for the applied amount, dated with the bill. Settles the
advance-covered slice of a payable the purchase above credited in full.

#### Source 7 — Rent accrual (`rent_accruals` + `warehouse_rent_agreements`) — `journal.ts:1466-1502`
Per accrued day: Dr `agreement.expense_ledger_id` (`RENT-EXP-<wh>`), Cr
`agreement.payable_ledger_id` (`RENT-PAY-<wh>`). **Ungated** — recognised on the
day incurred; approval only locks the month, it does not change the books. Rent
*payments* are real vouchers (Source 3), so the payable is debited there.

#### Source 8 — Salary accrual (`salary_accruals`) — `journal.ts:1504-1538`
Per accrued day: Dr `SAL-EMP-<id>` (Salary Expense), Cr `SAL-PAY-<id>` (Salary
Payable), located to the employee's branch. **Ungated** for the same reason as
rent. This is only the *base* daily accrual.

#### Salary approval true-up + employer PF/ESI (system JV) — `routes/hr.ts:646-901`
`postSalaryApproval()` writes a **real** `journal` voucher (`origin='system'`,
`source_module='payroll'`) reaching the stream via Source 3. Its legs
(`hr.ts:688-829`):
- Fixed debits: Dr `STD-PF-EMPR` (employer PF), Dr `STD-ESI-EMPR` (employer ESI).
- Fixed credits: Cr `STD-PF-PAY` (`pfEmployee+pfEmployer`), Cr `STD-ESI-PAY`
  (`esiEmployee+esiEmployer`), Cr `STD-EMP-DED` (other withholdings), Cr
  `ADV-EMP-<id>` (advance recovered).
- True-up legs (delta above what daily accrual already booked):
  Dr `SAL-EMP-<id>` for `salaryCost − accrued`, Cr `SAL-PAY-<id>` for
  `netPay − accrued` — each placed on its natural or opposite side so the voucher
  balances even when a leg goes negative. A month accrued to exactly the payroll
  figure with no statutory legs writes **no** voucher (approval still locks the month).

#### Production costing overlay (system JV) — `lib/productionCosting.ts:308-337`
`postProductionCostJv()` writes a `journal` voucher (`source_module='production'`):
capitalise → Dr `STD-FG-INV` / Cr `STD-PROD-ABS`; relieve (delete / cost drop) →
the mirror. Both legs are in the stream (Source 3) but **excluded from the
statements** by `buildBooks` (`books.ts:74,593-597,633-638`) — the overlay nets to
zero and closing stock already carries manufactured value.

#### Branch transfers (cross-GSTIN) — `lib/gstTransfer.ts`
Two paths:
- **Invoice mode** (default, `gst_transfer_invoicing`): real `sales` +
  `purchases` rows with `branch_transfer_id` set (`createTransferSaleInvoice`
  607, `createTransferPurchaseInvoice` 659). These reach the stream through
  Sources 5 & 6 and post to `STD-BRANCH-TRF`/`STD-BRANCH-DEBTOR`/`STD-BRANCH-CREDITOR`
  (never Sales/Purchases) — keeping transfers out of turnover and P&L.
- **Voucher mode** (flag off): dispatch JV `createDispatchVoucher` (396) —
  Dr `STD-BRANCH-DEBTOR` / Cr location Sales (taxable) / Cr `STD-OUT-*`; receive
  JV `createReceiveVoucher` (472) — Dr location Purchases (taxable) / Dr
  `STD-INP-*` / Cr `STD-BRANCH-CREDITOR`. Same-GSTIN internal transfers post no
  GST (delivery challan only).

### 17.4 Transaction → accounting map

| Transaction | Dr | Cr | Statement(s) |
|---|---|---|---|
| Credit sale (provisioned customer) | `CUST-n` (total) | location Sales (net), `STD-OUT-CGST/SGST/IGST` or `STD-DTX`, each other-charge expense ledger | P&L (revenue, charge recovery), BS (debtor, output GST) |
| Cash/counter sale | location Cash or `STD-ELEC-CLR` (paid), `CUST-n`/`SYS-DEBTORS` (remainder) | location Sales, output GST | P&L, BS (cash/clearing) |
| Sale collection (`sale_payments`) | cash/`STD-ELEC-CLR`/`received_in` | `CUST-n` | BS |
| Purchase | purchase ledger/`STD-PUR` (taxable), `STD-INP-CGST/SGST/IGST`, charge expense ledgers | `VEND-n`/`SYS-CREDITORS` (goods+charges) | P&L (purchases, charges), BS (input GST, creditor) |
| Payment (to vendor) | `paid_to` (`VEND-n`), `VADV-n` for advance slice | `paid_from` (cash/bank `CBA-`) | BS |
| Receipt (from customer) | `received_in` (cash/bank) | `received_from` (`CUST-n`) | BS |
| Expense | expense head | paying `CBA-` (else `STD-CASH`/`STD-BANK`) | P&L, BS |
| Contra | as entered (cash↔bank) | as entered | BS |
| Journal voucher | as entered | as entered | per ledgers |
| Sales return (credit note) | `STD-SALES` (subtotal), `STD-OUT-*` | `CUST-n` | P&L (Less: sales returns), BS |
| Purchase return (debit note) | `VEND-n` | `STD-PUR`, `STD-INP-*` | P&L (Less: purchase returns), BS |
| Rent accrual (daily) | `RENT-EXP-<wh>` | `RENT-PAY-<wh>` | P&L, BS |
| Salary accrual (daily) | `SAL-EMP-<id>` | `SAL-PAY-<id>` | P&L, BS |
| Salary approval true-up | `SAL-EMP-<id>` Δ, `STD-PF-EMPR`, `STD-ESI-EMPR` | `SAL-PAY-<id>` Δ, `STD-PF-PAY`, `STD-ESI-PAY`, `STD-EMP-DED`, `ADV-EMP-<id>` | P&L, BS |
| Production capitalise | `STD-FG-INV` | `STD-PROD-ABS` | **Excluded** (overlay) |
| Asset purchase | (register row; GST capitalised into cost) | vendor / paying ledger | BS (asset), no depreciation postings (by design) |
| Branch transfer dispatch (cross-GSTIN, invoice) | `STD-BRANCH-DEBTOR` | `STD-BRANCH-TRF`, `STD-OUT-*` | BS only (kept out of P&L) |
| Branch transfer receive | `STD-BRANCH-TRF`, `STD-INP-*` | `STD-BRANCH-CREDITOR` | BS only |

### 17.5 What bypasses the ledger

Precisely (verified against code):

- **Quotations** — by construction. They are their own tables
  (`quotations`, `quotation_share_links`); `buildDerivedPostings()` never reads
  them, they touch neither stock nor books.
- **Sale-linked receipts** — the `receipts` rows that (a) are referenced by
  `sale_payments.clearing_receipt_id`, or (b) whose `voucher_number` equals a
  `sales.invoice_number`. Excluded from Source 2 to avoid double-count; their
  effect enters through Source 5 (`journal.ts:1034-1035`).
- **Production capitalisation legs** (`STD-FG-INV`/`STD-PROD-ABS`) — in the stream
  but excluded from the statements.
- **Stock ledger / batches** — inventory audit, not financial postings; they feed
  valuation (§19 cross-ref), not `buildDerivedPostings`.
- **Cash & Bank stored `balance` column** — dead; balances are fully derived.

### 17.6 Month-lock interaction

`lib/periodLock.ts`: `accounting_period_locks` holds only locked months (absence
= open). `isMonthLocked(q, year, month)` (`periodLock.ts:103`) is the shared guard;
any *write* with a business date in a locked month is refused with **HTTP 423
`MONTH_LOCKED`**. Salary approval re-checks it *inside* the transaction before
writing the true-up voucher (`hr.ts:717-722`). Deliberately still open in a locked
month: new open-month payments against locked-month credit sales, quotations, and
master edits. Locking does not alter derivation — it only stops new documents in
the period.

### 17.7 Orphaned-postings trap (deleted ledgers)

Because postings are derived by ledger **code/id lookup at read time**, a posting
whose ledger was hand-deleted becomes an orphan. `buildBooks` collects
`missingLedgerIds` and, if non-empty, throws an explicit error listing the ids
("Restore the ledger or reverse the entries") rather than silently absorbing the
imbalance (`books.ts:604,632,673,792-794`). Several derivation branches also
degrade safely: e.g. Source 6b skips a vendor-advance application whose `VADV-n`
was deleted (`journal.ts:1458`). This is why deleting parties/ledgers by hand in
the DB (bypassing the app's guarded deletes + healing sweeps) is the single
highest operational risk.

### 17.8 Voucher numbering (allocators, never COUNT(\*))

`nextVoucherNumber(q, type, date)` (`lib/voucherNumber.ts:56-94`) allocates from
`voucher_sequences` (PK `voucher_type, fy_label`) via an atomic upsert
(`INSERT … ON CONFLICT DO UPDATE SET last_number = last_number + 1 RETURNING`).
Format `PREFIX/FY/NNNN` (4-pad). FY label from `financialYearLabel` using
`fy_start_month`. **Never COUNT(\*)** — a deleted document must not let a number
repeat. Sales bills run two independent FY-scoped series `SB2B` / `SB2C`
(`voucherNumber.ts:96-115`), 6-pad, scoped by location via `salesCounterScope` /
`nextScopedSerial`. Branch-transfer invoices use their own global sequence
`BTR/FY/0001` from `company_settings.branch_transfer_sequence`
(`gstTransfer.ts:562-586`).

**Business rules (implemented):**
- The entire double-entry stream is derived on demand from source documents by
  `buildDerivedPostings()`; there is no stored posting-line table for documents.
- Every derived entry is internally balanced; statements balance by construction,
  residuals are reported as defects.
- Sales use the gross debtor model when a `CUST-n` ledger exists (full invoice Dr,
  per-collection Cr, advance Dr/Cr wash); walk-ins/orphans use the net model.
- Cancelled sales post nothing, except cancelled branch-transfer invoices which
  stay in (reversed by their credit note).
- Sale-linked receipts and quotations never post; production overlay legs post but
  are excluded from statements.
- Purchase vendor credit = goods + other charges; sale customer debit = total
  (charges already included). Charges carry no GST.
- Rent and salary are recognised daily and are ungated by approval; approval only
  locks the month (and, for salary, posts a true-up + statutory JV).
- GST paise split = half + exact remainder; residual to `STD-DTX`.
- Writes into a locked month are refused with 423; derivation is unchanged.
- All voucher/invoice numbers come from atomic sequence allocators, never COUNT(\*).

---

## 18. Chart of Accounts

### 18.1 Purpose and structure

`account_ledgers` is one self-referencing table (parent_id) carrying both **groups**
(`is_group`/`is_system_group = true`, non-postable) and **postable ledgers**. Each
row has `code`, `name`, `type` (`asset|liability|equity|income|expense`),
`section` (`balance_sheet|profit_loss`), `parent_id`, `is_group`,
`is_system_group`, `is_active`, `description`. Seeded at boot in
`src/index.ts` (idempotent `WHERE NOT EXISTS`).

### 18.2 Full hierarchy (verified against live dev DB)

**System roots** (`SYS-*`, `is_system_group=true`, seeded `index.ts:237-249`):

| Code | Name | type | section | Statement |
|---|---|---|---|---|
| SYS-CAP | Capital Accounts | equity | balance_sheet | BS Liabilities |
| SYS-LOAN | Loans (Liability) | liability | balance_sheet | BS Liabilities |
| SYS-CURL | Current Liabilities | liability | balance_sheet | BS Liabilities |
| SYS-FIXD | Fixed Asset | asset | balance_sheet | BS Assets |
| SYS-CURA | Current Asset | asset | balance_sheet | BS Assets |
| SYS-OPSTOCK | Opening Stock | asset | balance_sheet | BS Assets |
| SYS-CLSTOCK | Closing Stock | asset | balance_sheet | BS Assets |
| SYS-PUR | Purchase | expense | profit_loss | P&L Expense |
| SYS-DIREXP | Direct Expense | expense | profit_loss | P&L Expense |
| SYS-INDEXP | Indirect Expense | expense | profit_loss | P&L Expense |
| SYS-SAL | Sales | income | profit_loss | P&L Income |
| SYS-DIRINC | Direct Income | income | profit_loss | P&L Income |
| SYS-INDINC | Indirect Income | income | profit_loss | P&L Income |
| SYS-DEBTORS | Sundry Debtors (under SYS-CURA) | asset | balance_sheet | BS Assets |
| SYS-CREDITORS | Sundry Creditors (under SYS-CURL) | liability | balance_sheet | BS Liabilities |

`books.ts` groups them: P&L income roots = `SYS-SAL, SYS-DIRINC, SYS-INDINC`;
P&L expense roots = `SYS-PUR, SYS-DIREXP, SYS-INDEXP`; BS liability roots =
`SYS-CAP, SYS-LOAN, SYS-CURL`; BS asset roots =
`SYS-FIXD, SYS-CURA, SYS-OPSTOCK, SYS-CLSTOCK` (`books.ts:63-67`).

**Standard postable/container `STD-*` ledgers** (verified live, seeded across
`index.ts:282-288, 859-998` and libs):

| Code | Name | type | Parent |
|---|---|---|---|
| STD-SALES | Sales | income | SYS-SAL |
| STD-PUR | Purchases | expense | SYS-PUR |
| STD-BANK | Bank Accounts | asset | SYS-CURA (postable parent, module-managed) |
| STD-CASH | Cash | asset | SYS-CURA (postable parent, module-managed) |
| STD-DTX | Duty & Tax | liability | SYS-CURL (parent of GST heads) |
| STD-OUT-CGST/SGST/IGST | Output GST | liability | STD-DTX |
| STD-INP-CGST/SGST/IGST | Input GST | asset | STD-DTX |
| STD-ELEC-CLR | Electronic Payment Clearing | asset | (clearing) |
| STD-CIT | Cash in Transit | asset | — |
| STD-FG-INV | Finished Goods Inventory | asset | (overlay) |
| STD-PROD-ABS | Production Cost Absorbed | expense | (overlay) |
| STD-FIXED-ASSET | Fixed Assets | asset | SYS-FIXD |
| STD-BRANCH-TRF | Inter-Branch Transfer | liability | — |
| STD-BRANCH-DEBTOR | Inter-Branch Receivable | asset | SYS-CURA |
| STD-BRANCH-CREDITOR | Inter-Branch Payable | liability | SYS-CURL |
| STD-SALARY-EXP | Salary Expense | expense | (container) |
| STD-GRP-SAL-PAY | Salary Payable | liability | SYS-CURL |
| STD-PF-EMPR / STD-ESI-EMPR | Employer PF / ESI | expense | P&L |
| STD-PF-PAY / STD-ESI-PAY | PF / ESI Payable | liability | SYS-CURL |
| STD-EMP-DED | Employee Deductions Payable | liability | SYS-CURL |
| STD-GRP-RENT-EXP / STD-GRP-RENT-PAY | Rent Expense / Payable | expense / liability | — |
| STD-GRP-EMP-ADV | Employee Advances | asset | (parent of ADV-EMP-n) |
| STD-GRP-VEND-ADV | Vendor Advances | asset | (parent of VADV-n) |
| STD-GRP-LOC-SAL / STD-GRP-LOC-PUR | Location Sales / Purchases | income / expense | (parents of per-location ledgers) |
| STD-PROC-CHG | Bank & Processor Charges | expense | P&L |
| STD-EXP-PAY | Expense Payable | liability | SYS-CURL |

> NOTE — the audit mentions `STD-OB-ADJ` (Opening Balance Adjustment) under
> SYS-CAP. It was **NOT FOUND** in the current dev chart query. Opening-balance
> counterweighting logic exists (`lib/cashBankLedgers.ts`, `lib/openingBalances.ts`)
> but the specific ledger row is not present in this DB — treat its presence as
> environment-dependent / **NOT VERIFIED** here.

### 18.3 Auto-provisioned ledgers

Created by application logic, never hand-seeded:

- `CUST-<id>` (asset) under `SYS-DEBTORS` — `lib/partyCreate.ts:66-75`.
- `VEND-<id>` (liability) under `SYS-CREDITORS` — `partyCreate.ts:89-98`.
- `VADV-<id>` (asset) under `STD-GRP-VEND-ADV` — vendor advances (`lib/advanceLedgers.ts`).
- `SAL-EMP-<id>` / `SAL-PAY-<id>` / `ADV-EMP-<id>` — employee salary/payable/advance
  (`lib/payrollLedgers.ts:24-25`, `hr.ts:674-682`).
- `RENT-EXP-<wh>` / `RENT-PAY-<wh>` — per warehouse (`lib/rentLedgers.ts`).
- `CBA-<id>` — one per cash/bank account under `STD-CASH`/`STD-BANK`
  (`lib/cashBankLedgers.ts`).
- Per-location sales/purchase ledgers under `STD-GRP-LOC-SAL`/`STD-GRP-LOC-PUR`.
- `STD-BRANCH-DEBTOR/CREDITOR/TRF` provisioned on first transfer / first invoice
  (`gstTransfer.ts:353-375,617,666`).
- Customer advances have **no** dedicated ledger — the advance is the credit
  (negative) balance on the customer's single `CUST-n` ledger.

### 18.4 Code-guarded heads, postable parents, delete/move guards

- **`code` is never client-writable** — create/update routes in `routes/accounts.ts`
  set `code` server-side only; the create path derives `type/section/parent` from
  the parent (`accounts.ts:355-392`).
- **`STD-CASH` / `STD-BANK` are postable PARENTS**, not pure groups: their own
  balance ≠ the sum of children (branch tills, `CBA-` accounts sit under them).
  They are **module-managed** — the chart refuses to create/move/rename/deactivate
  children under them and the UI shows a "Cash & Bank" badge
  (`accounts.ts:191-199, 414-420, 495`).
- **System groups (`is_system_group`) cannot be moved** (`accounts.ts:495`) and are
  never postable (their statement total is their children's).
- **Delete guard**: `loadLedgerUsage` / `deleteBlockReason` (`lib/chartGroups.ts`,
  imported at `accounts.ts:30`) refuse deletion of any ledger referenced by a
  document — including a ledger referenced only by a sale/purchase's
  `other_charges` JSONB. A group with children cannot be deleted.

### 18.5 Statement sign conventions

`buildBooks.buildGroup(code, agg, sign)` signs each section to its **natural side**
so a healthy account reads positive (`books.ts:706-734`): income groups built with
`sign = -1` (credit-natural), expenses `sign = +1`, BS assets `+1`, BS liabilities
`-1`. **The presented sign is NOT a Dr/Cr flag** — it is "positive = the section's
expected side". A system group's own balance is forced to 0 (holds no postings),
overlay ledgers to 0.

**Business rules (implemented):**
- Chart is a single self-referencing table; groups vs postable ledgers via
  `is_group`/`is_system_group`.
- `code` is server-owned and never writable by the client.
- `STD-CASH`/`STD-BANK` are postable, module-managed parents; children cannot be
  created/moved/renamed/deactivated through the chart.
- System groups cannot be moved and never carry own postings.
- Party/branch/rent/salary/advance/CBA ledgers are auto-provisioned by code, not
  seeded.
- Ledger deletion is blocked while any document (including `other_charges`)
  references it, or while it has children.
- Statement figures are signed to each section's natural side; sign ≠ Dr/Cr.

---

## 19. Ledgers

### 19.1 How a ledger statement is produced

`buildLedgerStatement(postingsFn, ledgerId, opts)` (`lib/ledgerBalances.ts:333-402`):

1. Derive the full posting stream to `toDate` (or reuse a passed array), and read
   `opening_balances` for the ledger (`as_of_date <= toDate`).
2. `natural` = +1 for debit-natural accounts (customer, cash, bank), −1 for
   credit-natural (vendor).
3. **Opening** seeds the running total (not a dated line):
   `opening = Σ (isDebit? +amt : −amt) × natural`.
4. Filter postings to this ledger, sort by `(date, entryId)`, run a **running
   balance** `running += (debit − credit) × natural`, accumulate `totalDebit`,
   `totalCredit`. `fromDate` clips which lines are *shown* but the running balance
   already carries prior movement (so opening-of-window is correct).
5. Returns `{ opening, closing, totalDebit, totalCredit, entries[] }` where each
   entry has `balance` = running.

**Located statements flip basis**: when a location/posting filter is applied, the
statement's `opening`/`closing` are the *located view's* figures, not the party's
company-wide balance (`ledgerBalances.ts:425-432`).

### 19.2 Customer ledger

`currentPartyStatement('customer', id)` (`ledgerBalances.ts:420-459`): derives the
stream once, resolves the `CUST-n` ledger via the balance index, and runs the
statement with `natural = +1`. Because of the gross debtor model, the statement
reads as a true account: `Invoice <no>` debits, `Payment received` / `Advance
adjusted` credits, closing = net receivable (negative closing = customer holds an
advance).

### 19.3 Vendor ledger — `currentPartyStatement` is THE outstanding figure

Vendor statement runs with `natural = −1`. The **outstanding payable** for a
vendor is the closing of this one exported calculation — `currentPartyStatement`
plus its SQL builders (`buildLedgerBalanceIndex`, `getVendorBalance`
`ledgerBalances.ts:477`). There is exactly ONE such calc; every payable reader
routes through it (and the payables reader also adds the `other_charges` JSONB sum,
since purchase `total_amount` is goods-only). Vendor advances park on `VADV-n`
(asset), separate from `VEND-n`.

### 19.4 General ledger / trial balance

`computeTrialBalance()` (`journal.ts:1749`) folds the whole stream plus opening
balances into per-ledger net Dr/Cr; `buildLedgerBalanceIndex`
(`ledgerBalances.ts:130`) gives per-ledger balances including openings and control
totals. **Openings are folded in** (they live outside the stream and are added to
the cumulative aggregation, `books.ts:651-676`, `ledgerBalances.ts:157`).

### 19.5 Item ledger (stock ledger) cross-reference

The **financial** ledgers above are distinct from the **stock ledger** (see the
Inventory spec): `stock_ledger` is an append-only, business-dated, per-location,
per-material-type audit of quantity movement with a window-function running
balance (`Closing(D)=Opening(D+1)`). It feeds valuation, which feeds closing/opening
stock in `buildBooks`. The two never share rows; the only link is that valuation's
at-cost figure enters the financial statements as opening/closing stock.

### 19.6 Trial balance construction

`buildBooks`/`computeTrialBalance` build two aggregations from the stream: a
**period** aggregation (drives P&L) and an **everything-to-date cumulative**
aggregation (drives the balance sheet), with opening balances folded into the
cumulative only (`books.ts:599-676`). Overlay ledgers are stripped. Missing-ledger
ids abort with an error. TB Dr must equal Cr to the paisa (verified in the audit
addenda).

**Business rules (implemented):**
- Ledger + party statements derive from the same posting stream and always tie to
  the balance shown.
- Opening balances seed the running total; they are folded into cumulative
  balances, never shown as dated lines.
- Natural sign: +1 debtor/cash/bank, −1 vendor; located statements report the
  located slice's opening/closing.
- Vendor outstanding = the single `currentPartyStatement` closing (+ purchase
  other-charges); one exported calc used everywhere.
- Financial ledgers and the stock ledger are separate stores; only the valuation
  figure crosses over as opening/closing stock.
- Trial balance = period + cumulative aggregations with openings folded; overlay
  excluded; orphan-ledger residuals reported, not absorbed.

---


---

## 20. Inventory

### 20.1 Quantity truth — `stock_entries`

- `stock_entries` is the **single quantity truth** for every kind, discriminated
  by `material_type` (`item` | `material` | `raw_material`). Confirmed in
  `src/lib/materialStock.ts` header and `src/lib/valuation.ts`.
- Master counters (`items.production_stock`, `materials.current_stock`,
  `raw_materials.current_stock`) are **mirrors of the company-wide total only** —
  they cannot express a location and must never be read to answer "how much is at
  this location".
- **Schema (`\d stock_entries`):** unique
  `(item_id, material_type, branch_type, branch_id)`; CHECK
  `quantity >= -0.001` (the **negative-stock block** — a tiny epsilon absorbs
  float dust, effectively "no negative stock"); CHECK material_type ∈
  (item/material/raw_material); trigger `assert_stock_master_exists`.
  - **Audit divergence:** the audit's claim of "no triggers" is **stale** — the
    master-guard trigger is present on both `stock_entries` and `stock_batches`.

### 20.2 Batch layer — `stock_batches`

- Library `src/lib/batches.ts`. Additive lot layer keyed by natural key
  `stock_batches_natural_key_v2` = `(item_id, material_type, branch_type,
  branch_id, batch_number)`. Carries `barcode`, `mrp`, `source`, `source_id`.
- `creditBatch` — upsert on the natural key; `COALESCE` preserves existing
  mfg/expiry dates; MRP is latest-wins.
- `planFEFO` — order by expiry ASC NULLS LAST, then id (First-Expiry-First-Out).
- `consumeBatches` — honours a manual override first, then FEFO; **may
  under-total**, leaving an "Untracked"/untracked residual when the located
  quantity exceeds what the batch layer can account for.
- `debitBatchByNumber` — floors at 0. `restoreBatches` — re-credits exact lots on
  reversal.
- Average cost: `updateAvgCostOnInbound` / `updateAvgCostOnReversal`;
  `inboundCostForItem` / `inboundCostForMaterial` supply fallback costs.

### 20.3 Stock ledger — `stock_ledger`

- Library `src/lib/stockLedger.ts`. Append-only movement history.
- `txn_date` (a real DATE column) = the **business date** and is the ONE
  deliberate mutable exception — it follows a document's re-dating. `created_at`
  is immutable.
- **Running balance** (`src/routes/stock.ts:302`): a window function
  `SUM(qty_change) OVER (PARTITION BY material_type, ref_id, branch_type,
  branch_id ORDER BY created_at, id ...)`.
  - **Nuance:** the running balance is ordered by `created_at, id`, **not** by
    `txn_date`. A backdated entry therefore sorts by when it was recorded, not by
    its business date, so the per-row running balance can differ from a
    date-sorted reconstruction. **NOT VERIFIED** whether any report re-orders by
    `txn_date`.
- Valuation right: a role without valuation permission keeps every quantity and
  running balance but loses the unit cost/rate
  (`canViewStockValuation`).

### 20.4 Reservations — `stock_reservations`

- Library `src/lib/reservations.ts`. Schema CHECKs: `kind ∈ (hold, in_transit)`,
  `status ∈ (active, released)`, `qty > 0`; indexed by active / batch / doc.
- **`hold`** reduces *available* (on-hand − held).
- **`in_transit`** does **NOT** reduce available: the quantity has already been
  deducted from the sender's `stock_entries` and remains sender-owned for
  valuation until receipt.
- Helpers: `reservedSql` / `batchReservedSql`, `availabilityAt` (optional row
  lock), `reserveStock`, `releaseReservations`, `activeInTransit`.

### 20.5 Adjustments / physical verification

- Handler: `src/routes/inventory-batches.ts:507`, POST `/stock/verifications`,
  permission `page:/headoffice/stock-verification` action `add`. Table
  `stock_verifications`.
- **Items only** — the counted lines carry `itemId`/`countedQty`; there is no
  material / raw_material adjustment path in this handler.
- Reason must be one of `VERIFY_REASONS` = `damage`, `wastage`,
  `count_correction`, `expired` (default `count_correction`).
- Variance = counted − system. For each non-zero variance:
  `stock_entries.quantity` is **set** to the counted figure (row-locked); the HO
  `items.production_stock` mirror is nudged by the variance; **shrinkage**
  consumes FEFO (oldest spoils first); **surplus** lands in an explicit,
  auditable `ADJ-<verif.id>` batch at `inboundCostForItem` cost; a
  `txn_type='adjustment'` stock_ledger row is written dated to `verify_date`.
- Month-lock guarded; retired-outlet / disabled-warehouse writes blocked.
- **No accounting journal is posted for an adjustment.** `buildDerivedPostings`
  in `journal.ts` has no `stock_verification` branch. **Finding /
  surprise:** inventory damage/shrinkage moves quantity, batches and the stock
  ledger but is **NOT expensed to the books** — at-cost valuation and the GL can
  drift apart on write-offs. (**PARTIALLY IMPLEMENTED** as an accounting
  control.)

### 20.6 Valuation

- Library `src/lib/valuation.ts` — ONE at-cost engine
  (`stockValuationRows` / `stockValuation` / `closingStockValuation`).
- Quantity comes from `stock_entries` **only**. Cost = `avg_cost`, falling back to
  a manual cost; **never MRP**.
- Covers the three material kinds plus sender-owned `in_transit` stock.
- `PRODUCT_KIND_LABELS`: item → Finished Good, material → Raw Material,
  raw_material → Packing Material.

### 20.7 Ageing & expiry

- Library `src/lib/inventoryAging.ts`.
- **Expiry tiers** (`EXPIRY_TIER_DAYS = [7,15,30,60,90]`), buckets narrowest-first
  so each lot is counted once: `expired`, `d7`, `d15`, `d30`, `d60`, `d90`, `ok`,
  `no_expiry`. An undated lot is its **own** bucket (a data gap, never treated as
  safe). Per-bucket tone hints keep every surface colouring identically.
- **Movement classes** (`MOVEMENT_CLASS_DAYS = {fast:30, slow:90, dormant:180}`):
  `fast`, `slow`, `dormant`, `dead`; measured from the last ledger movement of
  that product at that location. Stock that has **never** moved is `dead`.

**Business rules (implemented):**
- `stock_entries` is the only per-location quantity truth; master counters are
  company-wide mirrors.
- No location may go negative (DB CHECK `quantity >= -0.001`).
- Lots are consumed First-Expiry-First-Out; consumption may leave an untracked
  residual rather than fabricate stock.
- The stock ledger is append-only; only `txn_date` follows document re-dating.
- `hold` reduces availability; `in_transit` does not (still sender-owned).
- Physical counts adjust quantity, batches and the ledger but post no journal.
- Valuation is always at cost (avg → manual), never MRP.

### 20.x Stock Transfers

**Route file:** `src/routes/stock.ts`. **Table:** `stock_transfers`
(`\d stock_transfers`). Helper library `src/lib/gstTransfer.ts`.

- **Two-step lifecycle:** dispatch (POST `/stock/transfers`,
  status `in_transit`) → approve (PATCH `/stock/transfers/:id/approve`,
  status `completed`) or reject (PATCH `/stock/transfers/:id/reject`,
  status `rejected`). Challan number `CHN-<epoch ms>`.
  - **Dispatch** row-locks and deducts the source's `stock_entries`
    immediately (goods have left), records an `in_transit` reservation
    (`reserveStock`, kind `in_transit`), stores the consumed batch breakdown per
    line, and writes `transfer_out` ledger rows. **Destination stock is NOT
    credited on dispatch** — only on approval.
  - **Approve** atomically claims the row
    (`UPDATE ... WHERE id = ? AND status = 'in_transit'` returning zero rows if
    already actioned — prevents double-apply), releases the `in_transit`
    reservation, and credits the destination. Received lines may only **confirm
    or short-receive** dispatched lines — never add items, never exceed dispatched
    qty; cost always comes from the dispatched line, not the payload. A short
    receipt leaves the shortfall recorded against the sender as unreconciled
    in-transit stock.
  - **Reject** reverses the source deduction (`transfer_in` ledger rows back to
    source) and, for an invoiced cross-GSTIN transfer, raises a credit note.
- **Authorization:** dispatch is authorised by the **source** location scope
  (`isLocationInScope` on `fromType/fromId`) — a warehouse can send to another
  warehouse without owning the destination; approve/reject are gated on the
  **destination** / source respectively.
- **GST classification** (`classifyTransfer`, `gstTransfer.ts:152`):
  - either side missing a GSTIN, or **same GSTIN** → `internal`, `taxType='none'`
    — a delivery challan only, no supply, no tax, no financial document.
  - different GSTIN, **same state code** → `intrastate`, `cgst_sgst`.
  - different GSTIN, **different state** → `interstate`, `igst`.
  - Transfer lines are priced **GST-exclusive at cost** (`buildTransferInvoiceLines`)
    — a transfer is billed at cost, so there is no margin to extract tax from.
- **Cross-GSTIN real sale/purchase rows:** a taxable (`≠ internal`) transfer with
  a positive taxable value raises, at dispatch, a **real sale invoice**
  (`createTransferSaleInvoice`, `sale_id` stamped on the transfer) **when transfer
  invoicing is enabled**, else a **journal dispatch voucher**
  (`createDispatchVoucher`, `dispatch_voucher_id`). Invoice OR voucher, **never
  both** (they carry the same postings — raising both would double revenue, tax
  and the inter-branch balance). On approve, the receiving side gets a **real
  purchase invoice** (`createTransferPurchaseInvoice`, `purchase_id` stamped) or a
  receive voucher. `document_mode` is stamped (`invoice`/`voucher`) at dispatch
  and the receive/reject legs read the stamp, so flipping the invoicing switch
  mid-flight cannot change how an in-flight transfer is received.
  - These synthetic sale/purchase rows carry `branch_transfer_id`, no customer/
    vendor, and the counterparty branch's details. They post to the inter-branch
    clearing ledgers `STD-BRANCH-DEBTOR` / `STD-BRANCH-CREDITOR` /
    `STD-BRANCH-TRF`.
  - **branch_transfer_id exclusion:** every revenue/expense query in
    `src/routes/dashboard.ts` and `src/routes/reports.ts` filters
    `branch_transfer_id IS NULL` (and `cancelled_at IS NULL`), so these mirror
    invoices do not inflate real sales/purchase figures.
- **Ghost transfer issue (confirmed, per audit §15):** because the cross-GSTIN
  sale/purchase mirror rows are real `sales`/`purchases` rows, deleting or
  mishandling a transfer can leave orphaned "ghost" branch-transfer invoices;
  the reject path guards this with `sale_id` + `document_mode` checks, but the
  risk is inherent to modelling the mirror as real documents. **NOT VERIFIED**
  end-to-end at the delete level.
- **Dispatched-by audit — NOT IMPLEMENTED.** There is **no `dispatched_by`
  column** on `stock_transfers` (confirmed via `information_schema`: only
  `dispatch_voucher_id`, `approved_by`, `approved_at` exist). The receiver is
  recorded (`approved_by`) but the dispatcher is not. This matches audit item
  #114; the task's mention of a "dispatched-by audit" is **aspirational, not
  present**.

**Business rules (implemented):**
- A transfer is a two-step dispatch→approve/reject flow; source stock leaves on
  dispatch, destination stock arrives only on approval.
- Approve/reject is a single-winner atomic status claim — a transfer can never be
  actioned twice.
- Receipt may only confirm or short-receive dispatched lines; costs come from the
  dispatch, not the payload; shortfalls stay as unreconciled sender stock.
- Same-GSTIN (or missing-GSTIN) moves are internal challans with no GST/document;
  different-GSTIN moves raise real GST sale + purchase invoices (or vouchers) at
  cost, on the inter-branch clearing ledgers.
- Branch-transfer mirror invoices are excluded from every real sales/purchase
  report via `branch_transfer_id IS NULL`.
- The dispatching user is not recorded (no `dispatched_by`).

---

## 21. Production

**Route file:** `src/routes/production.ts` (~1124 lines).
**Costing library:** `src/lib/productionCosting.ts` (~410 lines).
**Tables:** `productions`, `bom_templates` (`\d bom_templates`).

- **Create — POST `/productions`** (`production.ts:372`), permission
  `page:/production/production` action `add`.
  - Validates producedQuantity > 0, item existence, optional manual labour ≥ 0,
    overhead % 0–100, wastage lines (each qty > 0 with a reason), and each
    material line (`materialType` ∈ {material, raw_material}, valid id, qty > 0,
    exists). Inactive products (item or any consumed material) block a new batch.
  - **Location:** `resolveActingLocation` — HO may record for any location, a
    warehouse only for itself. Stored on `productions.location_type/location_id`.
- **BOM / materials consumption:**
  - `bom_templates` (one row per item, `lines` JSONB) is a **reference /
    reporting template only**. It is used in `/productions/reports` to compute
    expected-vs-actual consumption (`hasBom`, `expectedQty`). It is **not**
    enforced at create time — the actual consumed `materialUsed` comes from the
    request body, and BOM lines carry only `{materialType, materialId,
    quantity}` — i.e. **BOM lines have no location** (a template is
    location-agnostic; the batch supplies the location at run time). This is what
    "materials have no location" refers to: the *template*, not the movement.
  - At run time each consumed material IS located: the master mirror
    (`materials`/`raw_materials.current_stock`) is decremented, then
    `availabilityAt` (locked) is checked against **available** (on-hand − held),
    `deductMaterialAt` deducts at the manufacturing location **without clamping**
    (a shortfall is a hard `INSUFFICIENT_STOCK` 400 — the system will not
    manufacture stock from nothing), and `consumeBatches` draws the exact FEFO
    lots, whose breakdown is stored on the line for exact reversal.
- **Output:** good units only enter stock (`items.production_stock` +
  `stock_entries` upsert at the location); a produced `stock_batches` lot is
  credited (inheriting the SKU barcode + MRP), and the item average cost is
  rolled (`updateAvgCostOnInbound`). `transaction`-scoped; a per-item advisory
  lock removes the first-production stock-entry race.
- **Batch numbers:** stored `batch_number`; `defaultBatchNumber(id)` is the
  fallback label for legacy rows.
- **Wastage:** wastage lines (`{quantity, reason}`) are stored with a derived
  `wastage_value = wastageQty × totalCost / (producedQty + wastageQty)`.
  **Wastage never enters stock** — only the good `producedQuantity` does.
- **Output costing** (`productionCosting.ts`):
  `total_cost = rm_cost + pm_cost + labour_cost + overhead`, where
  `overhead = (rm+pm) × overhead_percent`; `cost_per_unit = total_cost / good
  units`. `cost_per_unit` is the **one** valuation cost carried into
  `stock_batches`.
  - **Labour is a daily pool, not per-batch:** the day's production payroll at a
    location (derived from attendance × `is_production_staff`, salary ÷ working
    days × worked fraction) is spread across every batch that location made that
    day, weighted by quantity. Every create/edit/delete goes through
    `reallocateDayLabour`, so recording or deleting a batch re-spreads labour over
    its siblings and the allocation always sums exactly to the day's pool. A
    manual labour figure (`labourCost`) opts a batch out of the payroll spread
    and stamps `labour_method`.
- **Books (capitalisation):** each batch posts, in the same transaction,
  **Dr Finished Goods Inventory / Cr Production Cost Absorbed**
  (`postProductionCostJv`, direction `capitalise`), relieving the
  already-expensed purchases and wages so manufacturing moves no profit — only
  selling does. Sibling re-spreads post the difference
  (`postReallocationAdjustment`).
- **Edit — PATCH `/productions/:id`** (`production.ts:796`): **metadata only**
  (production date and notes). Moving a batch to another date re-spreads labour
  across BOTH affected days under ordered day-locks (deadlock-safe) and posts the
  value differences. Line items / quantities are **not** editable in place.
- **Delete — DELETE `/productions/:id`** (`production.ts:~910`): day-lock +
  per-item advisory lock + `FOR UPDATE` (blocks a stale double-reverse → 404),
  month-lock and LBAC guarded. Reverses material consumption
  (`creditMaterialAt` + `restoreBatches` of the exact lots, with a
  `REV-PROD-<id>` residual lot if the stored breakdown under-totals), reverses
  the produced stock/batch (floored, may be partly consumed), writes reversing
  ledger rows, and posts the mirror capitalisation JV.

**Business rules (implemented):**
- A batch consumes real located material FEFO and refuses to over-consume
  (`INSUFFICIENT_STOCK`); only good output enters stock, wastage never does.
- BOM templates are location-agnostic references used for expected-vs-actual
  reporting, not enforced at run time.
- A batch costs rm + pm + labour + overhead; labour is a daily payroll pool
  re-spread across the day's siblings on every write.
- `cost_per_unit` is the single valuation cost carried into the produced lot and
  the average cost.
- Manufacturing capitalises cost into inventory (Dr FG / Cr Cost Absorbed) and
  moves no profit.
- Production edit is metadata-only; quantities/lines change only via delete +
  re-create.

### 21.x Assets

**Route file:** `src/routes/assets.ts` (~1108 lines).
**Tables (via `\dt` + `\d`):** `assets` (master), `asset_categories`,
`asset_purchases`, `asset_transfers`, `asset_disposals`.
**Divergence:** there is **no `fixed_assets` table** — the audit/task name is
stale; the register is `assets` + `asset_purchases`.

- **Asset register:** `assets` master (name, item_code, unit, status
  `active|inactive`) + `asset_purchases` rows carrying **location and status on
  the purchase row**:
  - `location_type/location_id` (acquisition) and
    `current_location_type/current_location_id` (present location, moved by
    `asset_transfers`);
  - `status` CHECK ∈ `active | sold | scrapped | written_off |
    transferred_outside`;
  - plus `acquisition_cost`, `gst_rate`, `gst_amount`, `total_cost`,
    `payment_mode` (CHECK `cash|bank|upi|credit`),
    `payment_status` (`paid|unpaid|partial`), `serial_number`, `asset_tag`,
    `warranty_start`, `warranty_end`, `useful_life_months`, `attachment_path`,
    `journal_voucher_id`.
- **Purchase — POST `/assets/purchases`** (`assets.ts:298`):
  - **Accounting:** **Dr STD-FIXED-ASSET / Cr Cash, Bank/UPI or the vendor's
    `VEND-<id>` payable** per `payment_mode` (a credit purchase requires the
    vendor ledger to exist, else a clear error — never falls through to Cash).
  - **GST is capitalised into the total — NO input-tax-credit posting**
    (explicitly out of scope per the file header, `assets.ts:7-11`). The
    vendor's rounded GST is tolerated within a paisa.
  - Posts a real `journal_vouchers` + `journal_voucher_lines` pair, id stamped on
    the purchase row.
- **Edit / Delete:** PATCH (`assets.ts:575`) and DELETE (`assets.ts:683`) exist;
  delete removes the linked JV lines + voucher (guarded by `ON DELETE RESTRICT`
  FKs from disposals/transfers).
- **Transfers** (`asset_transfers`) and **disposals** (`asset_disposals`, POST
  `assets.ts:955`) are implemented as first-class flows.
- **Depreciation — NOT IMPLEMENTED.** `useful_life_months` is stored but there
  is **no depreciation schedule table and no depreciation posting** anywhere in
  `assets.ts` (the file header confirms depreciation is out of scope).
- **Maintenance / AMC — NOT IMPLEMENTED.** There is **no maintenance or AMC
  table** (`\dt` shows only `assets`, `asset_categories`, `asset_purchases`,
  `asset_transfers`, `asset_disposals`). Warranty *dates* (`warranty_start`,
  `warranty_end`) are recorded on the purchase row, but there is **no
  maintenance/AMC log, schedule or reminder** feature.

**Business rules (implemented):**
- Assets live in a two-level register: an `assets` master and dated
  `asset_purchases` rows that each carry acquisition + current location, status
  and cost.
- An asset purchase books Dr Fixed Assets / Cr Cash/Bank/UPI/Vendor by payment
  mode; a credit buy needs the vendor payable ledger.
- GST on an asset is capitalised into cost with no ITC claimed (by design).
- Asset transfers and disposals are supported; disposals/transfers pin the
  purchase row via RESTRICT/CASCADE FKs.
- No depreciation and no maintenance/AMC tracking exist (only warranty dates and
  useful-life months are stored).

---

### 21.9 Coverage & confidence notes (Purchases/Inventory/Production)

- **Verified against code + live schema:** purchase create/edit/delete, pricing,
  other charges, advances, FIFO settlement, derived accounting; purchase returns;
  `stock_entries`/`stock_batches`/`stock_ledger`/`stock_reservations` schema and
  libraries; valuation; ageing; stock verification/adjustment; stock-transfer
  two-step flow, GST classification, cross-GSTIN sale/purchase mirrors and their
  report exclusion; production create/edit/delete, labour pool, capitalisation;
  asset register + purchase accounting.
- **NOT IMPLEMENTED (confirmed):** `dispatched_by` on transfers; asset
  depreciation; asset maintenance/AMC.
- **PARTIALLY IMPLEMENTED:** stock adjustments post no accounting JV (books can
  drift from at-cost valuation on write-offs).
- **NOT VERIFIED / UNCLEAR:** whether any report re-orders the stock ledger by
  `txn_date` rather than `created_at` for backdated rows; the full transfer-delete
  path's exposure to "ghost" branch-transfer invoices (the reject path is guarded,
  delete was not traced end-to-end).

---

## 22. Payroll

> Scope: the HR/Payroll module — Employees, Attendance (multi-punch), Leave, Holidays & weekly offs, Salary calculation, Payroll runs, Statutory (PF/ESI), Advances, Salary payments, Daily salary accrual, and the employee mobile-app touchpoints. Backend lives in `artifacts/api-server/src/routes/hr.ts` (~3,700 lines) plus `src/lib/attendanceFactor.ts`, `src/lib/salaryAccrual.ts`, `src/lib/payrollLedgers.ts`, `src/lib/advanceLedgers.ts`; salary payslip PDF in `src/routes/pdfGen.ts` + `src/services/payslipPdf.ts`. Web screens: `artifacts/marlin-erp/src/pages/hr/*`. Mobile screens: `artifacts/employee-app/app/(tabs)/*`.

### 22.0 Purpose & structure

Payroll turns recorded attendance into salary cost and take-home pay. The defining architectural choice is that **attendance is the source of truth for what a day of salary is worth**, and there is exactly ONE rule that prices a day — `dayContribution` / `monthLeaveSummary` in `lib/attendanceFactor.ts` — used identically by three consumers: the daily accrual sweep, payroll generation, and payroll approval's re-check. This is deliberate: daily accrual books salary day-by-day into the P&L, and approval only posts the *delta* ("true-up") between what payroll finally computed and what already accrued. If the three used different formulas the true-up would become a real, unexplainable correction instead of a rounding difference (`lib/attendanceFactor.ts:6-27`).

Menu group **HR** (`marlin-erp/src/lib/moduleRegistry.ts:453-482`): Employees, Attendance, Leave (accessed from the Attendance page, no own nav entry), Payroll + Advances (share the Payroll module key), Rent Management (documented elsewhere), Hierarchy.

### 22.1 Access control & permissions

Enforcement order for every endpoint: `requireAuth` (global) → RBAC page right (403) → LBAC location scope (404 / self-scope) → business logic (§9 of the audit).

Page rights (`page:<href>`), five actions view/add/edit/delete/download:

| Screen | Page key | Notable action mapping |
|---|---|---|
| Employees | `page:/hr/employees` | view/add/edit/delete; `reset-password` needs edit |
| Attendance | `page:/hr/attendance` | view; check-in/out & apply-leave need **add**; correction, leave approve/reject, holiday create/delete need **edit** |
| Leave | satellite → resolves to `page:/hr/attendance` (`RoutePermissionGuard`) | — |
| Payroll | `page:/hr/payroll` | generate needs add; edit/approve/pay need edit; payslip PDF needs **download** |
| Advances | `page:/hr/advances` | list is UNGUARDED at route level (self-scope fallback); add needs add; recover needs edit |

**Self-scope / LBAC specifics (all verified in `hr.ts`):**
- Non-headoffice (branch) employees are forced to self-scope on: `GET /hr/payroll` (own employee row only, `hr.ts:1674-1680`), `GET /hr/attendance` (own row only, `2576`), `GET /hr/pay-components/:id` (403 unless own, `1607-1611`), `GET /hr/leave-balance` (own id whatever they ask, `2855-2857`), payslip PDF (403 unless own, `pdfGen.ts:437`).
- `GET /hr/advances` is intentionally **not** route-guarded so the employee-app can always read the caller's own advances; it grants the wider "all employees" view only if the caller holds `page:/hr/advances` view AND is head office, else it self-scopes (`hr.ts:2353-2366`).
- Head-Office-ONLY actions even for a branch manager holding the edit right (money-moving): **attendance correction** (`PUT /hr/attendance`, 403 for non-HO, `3483`), **holiday create/delete** (403 for non-HO, `2791/2826`).
- Check-in/out: an employee may only punch for themselves (`403 "You can only check in for yourself."`, `2904/2999`).
- Leave approval: location scope first (out-of-scope = 404), and **nobody approves their own request** — HO and level-1 included (`403`, `hr.ts:3289-3292`); leave cancel is requester-only (`3434`).
- `GET /hr/hierarchies` is deliberately UNGUARDED (login-time permission resolution needs it; `hr.ts:903-909`).

### 22.2 Employees

**Screen:** `marlin-erp/src/pages/hr/Employees.tsx` (961 lines) — employee list + create/edit dialog, pay-structure editor, reset-password, mark resigned/terminated/inactive.

**Table `employees`** (verified live, `psql \d employees`): `id, name, username (unique + unique lower(trim(username))), password_hash (default 'default123'), email, phone, hierarchy_id (FK hierarchies), branch_type, branch_id, salary numeric(10,2), join_date date NOT NULL, photo_url, is_active bool default true, must_change_password bool, education/emergency_contact/work_experience jsonb, is_production_staff bool, salary_accrual_resume_from date, ui_location_pref, employment_status text NOT NULL default 'active', last_working_date date`.

**Raw-migration columns invisible to drizzle** (read/written via raw SQL): `is_production_staff`, `employment_status`, `last_working_date`, `salary_accrual_resume_from` (`hr.ts:1245-1274`).

**Employment status is truth; `is_active` is derived** (`hr.ts:1259-1263`, 1418-1450):
- `EMPLOYMENT_STATUSES = ["active","resigned","terminated","inactive"]`. Any status ≠ active implies `is_active=false`. `inactive` = legacy plain deactivation; `resigned`/`terminated` record *why*.
- A legacy `isActive`-only toggle is mapped back onto a status: reactivate → `active`; deactivate → keep an existing richer status, else `inactive`.
- `last_working_date` (LWD): `null` when active; otherwise the effective LWD, defaulting to **today** if a non-active status carries no explicit LWD (`hr.ts:1446-1449`).

**Create** (`POST /hr/employees`, `hr.ts:1322`): zod `CreateEmployeeBody`; blocks a move to outlet when outlets disabled (409 `OUTLETS_DISABLED`); case-insensitive username duplicate check (400); inserts with `passwordHash = hash(DEFAULT_INITIAL_PASSWORD)`, `mustChangePassword=true`; seeds a `pay_components` row `{allowances:[], deductions:[]}`; auto-provisions salary ledgers happen lazily at first accrual/approval (§22.11). Returns `employmentStatus:"active", lastWorkingDate:null`.

**Edit** (`PATCH /hr/employees/:id`, `hr.ts:1397`): `UpdateEmployeeBody`; outlet-move guard on the EFFECTIVE destination; employment status/LWD validated & written via raw SQL; on employment change to non-active → `recalcUnapprovedSalaryAccruals` (open days after LWD torn down, rest re-priced); on **reactivation** → stamps `salary_accrual_resume_from = CURRENT_DATE` so deactivated months are NOT backfilled; on **salary change** → `recalcUnapprovedSalaryAccruals` rewrites every unapproved month in full at the new salary (approved/paid months untouched) and writes a detailed `salary_accrual` audit log entry.

**Delete** (`DELETE /hr/employees/:id`, `hr.ts:1590`): hard `db.delete` of the row; logs before-snapshot; returns 204. No cascade healing in this route (audit note: orphan salary ledgers are healed by boot sweeps elsewhere). NOT VERIFIED: whether a delete is blocked when payroll/accrual history exists — this route does not block it.

**Reset password** (`POST /hr/employees/:id/reset-password`, `hr.ts:3635`): scoped like the list (out-of-scope = 404, can't probe ids); sets `password_hash = hash(ADMIN_RESET_PASSWORD)`, clears `must_change_password`, clears any brute-force lockout (`clearLoginFailures`); returns the constant password in the response so the screen shows exactly what the server set.

**Pay components** (`GET/PUT /hr/pay-components/:employeeId`, `hr.ts:1604/1634`): per-employee `allowances`/`deductions` arrays + legacy `workingDaysPerMonth` (1-31). Types: allowance = `fixed | percent_of_basic`; deduction = `fixed | percent_of_basic | percent_of_gross`. **`working_days_per_month` is NO LONGER READ by pricing** — the working-days basis is company-wide policy since Aug 2026 (`hr.ts:1818-1822`). PUT allowed with either `page:/hr/employees` OR `page:/hr/payroll` edit.

**Business rules (implemented):**
- Username is unique case-insensitively (DB unique index on `lower(trim(username))`); duplicates rejected 400.
- New employees start with the default password and `must_change_password=true`.
- `employment_status` is authoritative; `is_active` is always derived from it; the two can never disagree.
- Non-active status forces a last-working-date (defaults to today); active clears it.
- Reactivation resumes accrual from today (no backfill of deactivated months).
- Salary revision recalculates all unapproved months in full at the new rate; approved/paid months are frozen.
- Moving an employee to an outlet is blocked while outlets are disabled; already-stationed staff can still be edited.

### 22.3 Attendance (multi-punch, hours-based)

**Screens:** web `pages/hr/Attendance.tsx` (1,304 lines) — day/month register, correction dialog, holidays, leave sub-panel; mobile `employee-app/app/(tabs)/attendance.tsx` (671 lines) — punch in/out + month view.

**Tables:** `attendance` (one row per employee×date, unique `idx_attendance_emp_date`; columns `check_in/check_out` timestamptz, `check_in_lat/lng`, `check_out_lat/lng`, `status`, `leave_type` [raw column]) and `attendance_punches` (multi-session: `punch_in`, `punch_out` nullable, `in_lat/lng`, `out_lat/lng`; index `idx_att_punches_emp_date`). `leave_type` on `attendance` is a raw-migration column read separately (`hr.ts:2585-2594`).

**Day boundary = company timezone.** "Today" comes from `businessTodayStr()` (server), and `GET /hr/attendance/config` returns `today = new Date().toLocaleDateString("en-CA", { timeZone: ws.timeZone })` plus the thresholds and weekly-off rules (`hr.ts:2747-2763`). The mobile app keys its "today" on this so a device in another timezone still asks the server for the correct register day (`attendance.tsx:150`).

**Multi-punch model (paid on TOTAL closed-session hours, never the span):**
- Check-in (`POST /hr/attendance/check-in`, `hr.ts:2899`): refuses a second open session ("Already checked in — check out before checking in again.", conflict 409). If a legacy day recorded hours only on the `attendance` row (no punch rows), that closed session is first migrated into `attendance_punches` so re-checking-in doesn't lose it. Inserts a new open punch (`punch_out` NULL). The `attendance` row keeps first-in as `check_in`; re-opening clears `check_out`. Status set 'present' (leave preserved).
- Check-out (`POST /hr/attendance/check-out`, `hr.ts:2994`): closes the latest open punch; if all sessions already closed → 409 conflict; legacy day with no punches simply updates the row's `check_out`. 404 if no check-in exists.
- **Hours the day is paid on:** `PUNCHED_HOURS_JOIN` sums `EXTRACT(EPOCH FROM (punch_out - punch_in))/3600` over CLOSED punches per (employee,date) (`attendanceFactor.ts:130-137`). `dayContribution` uses `punchedHours` when present (breaks between sessions excluded), else falls back to the first-in→last-out span for pre-punch legacy rows (`attendanceFactor.ts:313-318`).
- Every attendance write is serialized per-employee via `withAttendanceWrite` → `withEmployeeAccrualLock` (advisory xact lock class 8201, `salaryAccrual.ts:136-141`), and re-checks that no touched month is signed off before writing (`hr.ts:177-200`). After the write, `reaccrue()` re-prices the employee's open accruals (best-effort; hourly sweep is the safety net, `hr.ts:149-155`).

**Attendance correction** (`PUT /hr/attendance`, `hr.ts:3479`): HO-only. Upserts on (employee,date) — because "absent→present" often has no stored row. Valid statuses: `present, half_day, absent, leave, company_holiday, weekly_off`. Leave carries `leaveType` (sick|casual, default casual). Explicit `checkIn`/`checkOut` (or clearing them to null) win over the status label and rewrite the day's punches to one session (or none). Weekly-off-with-casual-deduction gate when the month's casual allowance is exhausted: `weeklyOffExhaustedAction='ask'` → 409 `CASUAL_LEAVE_EXHAUSTED` unless `force:true` (day then priced LOP); `='absent'` → silently converts to 'absent' (force does NOT bypass). Signed-off-month check sits INSIDE the write lock (`3570-3608`). Month lock (423) checked before.

**GET `/hr/attendance`** (`hr.ts:2546`): range mode (`?year&month` or `?from&to`) returns all rows in period; single-date mode synthesises a row for every active employee — a rowless day displays as `company_holiday`/`weekly_off` per the calendar, else `absent` (a stored row outvotes the calendar). `derivePunchFields` computes `workingHours`, `lateMinutes`, `overtimeHours`, `openPunchIn`, and `hoursWorked` = the multi-punch-aware working hours.

**Business rules (implemented):**
- One open session at a time; overlapping/duplicate punches refused.
- A day is paid on the SUM of closed-punch hours (breaks excluded), never the first-in→last-out span; pre-punch rows fall back to the span so history is unchanged.
- The company timezone defines the day boundary; clients must use `config.today`.
- Full day ≥ `fullDayHours` (default 9); half ≥ `halfDayHours` (default 4.5); below half = LOP (`attendanceFactor.ts:319-321`).
- Open (checked-in, not out) day is provisionally a whole day until check-out re-prices it (`attendanceFactor.ts:323-325`).
- Attendance correction is Head-Office only; check-in/out are self-only for branch staff.
- Every attendance write is refused if its month is signed off (approved/paid payroll) or the accounting period is locked (423).

### 22.4 Leave

**Screen:** web `pages/hr/Leave.tsx` (561 lines); mobile `employee-app/app/(tabs)/leaves.tsx` (553 lines).

**Table `leaves`:** `id, employee_id, from_date, to_date, leave_type, reason, status ('pending'), approved_by, approval_note, approved_at, cancelled_at`. `approved_at`/`cancelled_at` are raw-migration columns (all reads/writes raw SQL, `hr.ts:3082-3083`).

**Lifecycle:** `pending → approved | rejected | cancelled`.
- **Apply** (`POST /hr/leaves`, `hr.ts:3211`): self-only for branch staff; validates YYYY-MM-DD, `toDate ≥ fromDate`. A pending request touches NOTHING but the `leaves` table — **no attendance stamp, no accrual lock, no salary effect** (`hr.ts:3236-3238`). This is the "pending leave = zero pay" rule: unapproved leave can never earn salary.
- **Approve** (`POST /hr/leaves/:id/approve` with `status:"approved"`, `hr.ts:3254`): location scope first (404), can't decide own request (403), must be pending (409). Month lock 423 if any day of the span is in a locked period. Runs under `withAttendanceWrite` (accrual lock + signed-off re-check): re-reads status under the lock, stamps each date into `attendance` as `status='leave', leave_type=<sick|casual>` **only where `check_in IS NULL`** (a day the employee actually worked keeps its worked record). Then `reaccrue`.
- **Reject** (`status:"rejected"`, requires a note): pure status flip; deliberately NOT under `withAttendanceWrite` so a request touching a signed-off month can still be rejected (never stranded). A DELETE safety-net removes only legacy apply-time stamps — `status='leave'` days with no check-in, no punches, not covered by another approved leave, not in an approved/paid payroll month, not in a locked accounting period (`hr.ts:3375-3394`). **Rejection never writes 'absent'** — it removes the stamp; absence is the default of no row.
- **Cancel** (`POST /hr/leaves/:id/cancel`, `hr.ts:3418`): requester-only (approvers withdraw by rejecting with a reason); pending-only (409); month-lock guarded; pure status flip to 'cancelled'. **Revert of a stamp = DELETE**, never a status stamp (see reject net).

Leave TYPE at approval: `sick` consumes the sick allowance, everything else (casual/annual/other) consumes casual — the pre-split behaviour (`hr.ts:3335`).

**Leave balance** (`GET /hr/leave-balance`, `hr.ts:2850`): branch callers self-scoped. Computed by the SAME `monthLeaveSummary` the pay formula uses (never a hand count). Synthesised rowless days (weekly offs/holidays) are bounded to `until = businessTodayStr()` so a Sunday three weeks out is not "leave already taken"; stored rows (leave approved in advance) count regardless. Returns `{casual:{allowed,taken,remaining}, sick:{allowed,taken,remaining}, tracked}`.

**Business rules (implemented):**
- A pending leave request has zero effect on attendance or pay; only approval stamps attendance (which both accrual and payroll read).
- Approval never overwrites a day the employee actually worked (skips where `check_in IS NULL`).
- Rejection/cancellation of a properly-gated request has nothing to undo; the reject-net DELETE only removes legacy apply-time stamps; it never marks 'absent'.
- Nobody approves/rejects their own leave; approvers can only decide their own location's requests (404 otherwise); rejection requires a reason.
- Reverting leave = deleting the attendance stamp, never writing a new status.

### 22.5 Holidays & weekly offs

**Holidays** (`company_holidays`: `id, holiday_date UNIQUE, name`). Admin-defined PAID days. Every employee's tracked month pays them without an attendance row; a stored row for the date outvotes the calendar per employee (that is the override mechanism — no per-employee holiday table).
- `GET /hr/holidays` (view-guarded, not HO-only, because every calendar shades them; `hr.ts:2774`).
- `POST /hr/holidays` / `DELETE /hr/holidays/:id` — **HO-only** (403 otherwise), unique on date (409 on conflict), and each re-runs `runSalaryAccrual(pool)` which re-prices only UNAPPROVED months (signed-off months skipped by the sweep, `hr.ts:2811-2814/2836`).

**Weekly offs** — company-wide policy in `company_settings.general_settings.weeklyOffs` (JSONB), NOT stored rows. Each rule: `{ day: 0-6, weeks: "all" | number[1-5], policy: "paid" | "casual_leave" }` (`attendanceFactor.ts:51-55`). "Second Saturday" = `{day:6, weeks:[2]}`. `paid` = full paid day consuming nothing; `casual_leave` = deducts one casual leave (beyond the allowance → LOP).

**Stored rows outvote the calendar; untracked months never synthesise.** `dayContribution`/`monthLeaveSummary` synthesise rowless holiday/weekly-off contributions ONLY inside a TRACKED month (one that has ≥1 attendance row). A month with no rows at all is NOT given synthetic calendar days — synthesising one would flip an untracked month to tracked and unpay every other day (`attendanceFactor.ts:340-344, 455-467`). Explicit stamped statuses (`company_holiday`, `weekly_off`) on the `attendance` row always win for their date.

**Business rules (implemented):**
- Company holidays are paid days that consume no leave; a stored attendance row overrides them per-employee.
- Weekly offs are configured in general_settings (not rows); `paid` costs nothing, `casual_leave` deducts a casual leave (then LOP).
- The first matching weekly-off rule for a date wins (`weeklyOffRuleFor`, `attendanceFactor.ts:207-219`).
- Holiday create/delete re-prices unapproved accruals only; signed-off months untouched.
- Rowless calendar days are synthesised only in tracked months; never in an untracked month.

### 22.6 The one pricing formula (dayContribution / monthLeaveSummary)

`lib/attendanceFactor.ts` is the single authority. **Leave policy** loaded once by `loadPayrollSettings` from `company_settings.general_settings` (`attendanceFactor.ts:167-203`), sanitised & clamped:
- `payrollWorkingDays` → `workingDays` (default 30, clamped 1-31 integer).
- `paidCasualLeavesPerMonth` (default 4), `paidSickLeavesPerMonth` (default 0) — each clamped 0..workingDays.
- `lopEnabled` (default true), `weeklyOffs`, `weeklyOffExhaustedAction` ('ask'|'absent').
- Thresholds: `fullDayHours` (9), `halfDayHours` (4.5).

**`dayContribution(a, thresholds, cal)`** returns `{work, casualLeave, sickLeave, paidOff}` (each 0/0.5/1) (`attendanceFactor.ts:283-329`):
- No row + holiday → `paidOff:1`; + weekly off → `casualLeave:1` (casual_leave rule) or `paidOff:1` (paid rule); else all-zero (LOP in a tracked month).
- Stored `company_holiday` → paidOff; `weekly_off` → per rule; `leave` → sick or casual full day.
- Punched: hours ≥ full → `work:1`; ≥ half → `work:0.5 + casualLeave:0.5` (owner's rule); below half → all-zero (LOP).
- Checked-in-not-out → provisionally `work:1`. `present` → work 1; `half_day` → 0.5/0.5; else absent (all-zero).

**`monthLeaveSummary(rows, policy, thresholds, calendar?)`** (`attendanceFactor.ts:423-478`):
```
payableDays = min(workingDays, worked + paidOff
                  + min(casualTaken, casualAllowance)
                  + min(sickTaken,  sickAllowance))
lopDays     = max(0, workingDays − payableDays)   // 0 when lopEnabled=false
```
- Untracked month (no rows): if `untrackedIsAbsent && lopEnabled` → pays ZERO (attendance-era); otherwise full attendance (pre-cutover / LOP-off, `attendanceFactor.ts:430-442`).
- LOP disabled → month always payable in full (figures still reported honestly).
- Half day = 0.5 worked + 0.5 casual leave; leave beyond allowance = LOP.

### 22.7 Salary calculation (dayFactor, LOP) — computePayroll

`computePayroll` (`hr.ts:477-550`) turns `{baseSalary, workingDays, presentDays (=payableDays), allowances, deductions, rates}` into the run:
- `lopDays = max(0, workingDays − presentDays)`; `perDayRate = baseSalary / workingDays`; `lopDeduction = round2(lopDays × perDayRate)`; `effectiveBasic = round2(baseSalary − lopDeduction)`.
- Allowances: `fixed` = value, `percent_of_basic` = effectiveBasic×%. `grossPay = effectiveBasic + allowancesTotal`.
- Statutory: PF on `effectiveBasic`, ESI on `grossPay`, both on post-LOP figures (a day not worked is not wages). Employee shares reduce take-home; employer shares are a separate cost.
- Other deductions: fixed / percent_of_basic / percent_of_gross. `deductionsBreakdown` includes the statutory employee lines for audit.
- `netPay = grossPay − (otherDeductions + pfEmployee + esiEmployee)`.
- `employerCost = grossPay + pfEmployer + esiEmployer` — the full cost that must hit the P&L.

### 22.8 Payroll runs (draft → approved → paid)

**Screen:** web `pages/hr/Payroll.tsx` (881 lines) — generate for a month, per-employee draft cards, extra amount/note, approve, pay (mode + till), payslip PDF, salary-accrual register view.

**Table `payroll`** (verified live): `id, employee_id, month, year, base_salary, deductions, bonus, total_amount, is_paid, paid_date, working_days int (26), present_days numeric(6,2), lop_days, lop_deduction, gross_pay, allowances_total, allowances_breakdown jsonb, deductions_breakdown jsonb, net_pay, status text ('draft'), approved_at, extra_amount, extra_note, paid_amount, payment_mode, advance_deduction, pf_employee, pf_employer, esi_employee, esi_employer, statutory_snapshot jsonb, advance_ids jsonb, pay_period_label, paid_leave_used/allowed, sick_leave_used/allowed`. Unique-ish index `idx_payroll_emp_month (employee_id, year, month)`.

**Generate** (`POST /hr/payroll/generate` {month, year, employeeId?, forceRegenerate?}, `hr.ts:1721`):
1. Month lock (423). Loads `loadPayrollSettings` (thresholds+policy) and `loadStatutoryRates` (snapshot).
2. Selects employees: active, PLUS ex-employees whose LWD ≥ month start (paid for served days). Legacy deactivations without an LWD stay excluded (`hr.ts:1760-1766`).
3. `untrackedIsAbsent = startDate >= attendanceFrom` (`loadAccrualCutover`) — attendance-era months pay nothing for a zero-attendance month; pre-cutover keeps legacy full pay.
4. Loads month attendance with `PUNCHED_HOURS_JOIN`; loads holidays.
5. Per employee: **skips runs already approved/paid even with forceRegenerate** (posted documents, `hr.ts:1809`). Working days = company policy (NOT pay_components). Filters attendance to `≤ LWD`. `leaveSummary = monthLeaveSummary(...)`; `effectivePresentDays = leaveSummary.payableDays`, then capped by `employedDaysCap(lwd, first, last)` (partial month for a leaver).
6. **Zero-payable teardown:** if `effectivePresentDays ≤ 0.004` → tear down any existing draft (`teardownDraftPayroll` releases advance claims) and write NO row (`hr.ts:1849-1852`).
7. `computePayroll`; advances auto-deducted (§22.10); writes/updates the draft row + `statutory_snapshot` + `advance_ids` (claimed) + leave snapshot, all in ONE transaction with the advance rows locked `FOR UPDATE`.
8. After the loop (full run): stale drafts for people who left before the month began are torn down (`hr.ts:1999-2012`).

**Edit** (`PATCH /hr/payroll/:id` {extraAmount, extraNote}, `hr.ts:2018`): DRAFT ONLY (month-lock 423; 409 if approved/paid — "amounts are locked… reverse the approval"). Only `extra_amount`/`extra_note` are editable.

**Approve** (`POST /hr/payroll/:id/approve`, `hr.ts:2164` → `postSalaryApproval` `hr.ts:646`): 400 if already approved/paid.
- Runs in ONE transaction: row lock `FOR UPDATE`, month-lock re-check (423), `lockSalaryAccrual`.
- **Re-checks attendance & policy inside the lock** using the live policy — recomputes payable days with the SAME clamp/cap/untracked rule as generation, AND checks every policy-bearing stored figure (`working_days, lop_days, paid_leave_used/allowed, sick_leave_used/allowed`). Any drift → 409 "Regenerate the payroll… then approve" (`hr.ts:742-802`).
- Posts the **true-up** voucher (see §22.9) = payroll figure minus what already accrued; if nothing to post (accrued exactly = computed and no statutory legs) it writes NO voucher but still locks the month.
- Closes claimed advances (`is_deducted=TRUE`), refusing if a claim changed since the draft (regenerate).
- Sets `status='approved', approved_at=NOW()`. Approval failures leave the row UNCHANGED (409 for actionable conflict, 500 for genuine posting failure, 423 for month lock, `hr.ts:2198-2211`).

**Pay** (`POST /hr/payroll/:id/pay` {amount?, paymentMode, payLedgerId?}, `hr.ts:2215`): requires status `approved` (400 otherwise — paying can no longer implicitly approve). Supports partial payments. Month-lock on BOTH the payroll month first and `today` (423). See §22.9 for postings and till/mode rules. Row re-read `FOR UPDATE` inside the txn so concurrent payments can't double-settle. When fully paid → `status='paid', is_paid=true, paid_date=today`.

**Approved is locked; corrections are reversals.** There is no un-approve endpoint: once approved the row's amounts are frozen (edit refused), the month is locked for accrual, and the documented remedy is a reversing journal (`hr.ts:2029-2032`, 2041; audit §12).

**Business rules (implemented):**
- draft→approved→paid one-way; approved/paid runs are never regenerated (skipped even with forceRegenerate).
- Generation and approval share the exact same clamp/cap/untracked-flag so approval of a leaver's month never 409s against generation's own draft.
- Zero-payable / stale drafts are torn down under the payroll row lock, releasing advance claims.
- Approval re-checks live attendance AND policy inside the accrual lock; any drift forces a regenerate (409).
- Approval only posts the delta over daily accrual, and only moves status if the voucher committed.
- Only draft rows accept extra amount/note; approved amounts are locked (corrections = reversals).
- Payment requires prior approval; supports partial; fully-paid flips to 'paid'.

### 22.9 Accounting impact (exact ledger legs)

Salary is recognised in TWO layers: daily accrual (the bulk) and approval true-up (the remainder + statutory).

**Daily salary accrual (P&L daily)** — derived posting from `salary_accruals`, per row where `amount > 0.004` (`journal.ts:1518-1538`):
```
Dr  SAL-EMP-<id>  (Salary - <emp>, Indirect Expense)   amount
  Cr SAL-PAY-<id> (Salary Payable - <emp>, Curr. Liab.) amount
```
No voucher number; source `"salary"`; dated `accrual_date`; located at the employee's branch.

**Approval true-up** (`postSalaryApproval`, `hr.ts:808-867`) — a journal voucher (`origin='system', source_module='payroll'`), where `accrued = SUM(salary_accruals for month)`:
```
Dr  SAL-EMP-<id>          round2(salaryCost − accrued)   [salaryCost = gross + extra]
Cr  SAL-PAY-<id>          round2(netPay − accrued)       [netPay = net_pay + extra]
Dr  STD-PF-EMPR           pfEmployer      (if > 0)
Dr  STD-ESI-EMPR          esiEmployer     (if > 0)
  Cr STD-PF-PAY           pfEmployee + pfEmployer   (if > 0)
  Cr STD-ESI-PAY          esiEmployee + esiEmployer (if > 0)
  Cr STD-EMP-DED          otherDeductions (TDS/fines) (if > 0)
  Cr ADV-EMP-<id>         advanceRecovered           (if > 0)
```
Either of the two salary lines can FLIP side when the accrual overstated the month (heavy LOP, or accrued-in-full then approved for less) — `place()` moves a negative amount to the opposite side so the voucher still balances (`hr.ts:819-829`). Balance asserted to ≤ ₹0.02 (`hr.ts:833`). The salary JV therefore recognises the FULL employer cost (gross + employer PF/ESI) at snapshot rates. If accrued exactly equals computed and there are no statutory legs, no voucher is written (just the month lock).

**Salary payment** (`hr.ts:2296-2313`) — a journal voucher (`origin='system', source_module='payroll'`), stamped with the paying till's location (null for HO):
```
Dr  SAL-PAY-<id>          payNow
  Cr <resolved cash/bank ledger>  payNow
```

**Employee advance grant** (`hr.ts:2434-2445`):
```
Dr  ADV-EMP-<id>          amount
  Cr <resolved cash/bank ledger>  amount
```

**Advance cash recovery** (`hr.ts:2507-2519`):
```
Dr  <resolved cash/bank ledger>  amount
  Cr ADV-EMP-<id>          amount
```

**Payment mode & till resolution (`resolvePayLedger`, `hr.ts:69-134`):**
- Only the MONEY side is selectable; `SAL-PAY-*` and `ADV-EMP-*` are payroll-owned and never appear in a picker.
- Must be an active ledger inside the `STD-CASH`/`STD-BANK` subtree. HO may use any till/bank; a branch caller only their OWN till.
- With no `payLedgerId`: HO → standard `STD-CASH`/`STD-BANK` by mode; **a branch caller falls back to their own till, NEVER silently to HO cash**, and must pick explicitly if their scope has more than one till ("Pick which cash account this is paid from.").
- Recorded mode is DERIVED from the account's tree: `tree==='bank'` → 'upi' (if requested) else 'bank'; else 'cash' (`hr.ts:2279-2281`). The row can never claim "cash" for money that left a bank account.
- Mirror locations (same place as warehouse+outlet, one shared till) resolve to ONE identity (warehouse first) for the voucher stamp.
- All money-moving payroll endpoints (pay, advance, recover) also check `disabledWarehouseError` on the resolved till (409 `WAREHOUSE_DISABLED`).

**Standard ledger codes used:** `STD-PF-EMPR`, `STD-ESI-EMPR`, `STD-PF-PAY`, `STD-ESI-PAY`, `STD-EMP-DED`, `STD-CASH`, `STD-BANK`. Per-employee: `SAL-EMP-<id>` (Indirect Expense, parent `STD-SALARY-EXP`), `SAL-PAY-<id>` (Curr. Liab., parent `STD-GRP-SAL-PAY`), `ADV-EMP-<id>` (asset, parent `SYS-CURA`). Salary ledgers provisioned idempotently by `provisionSalaryLedgers` (`payrollLedgers.ts:69-88`); expense ledgers get section `profit_loss` so they reach the P&L.

### 22.10 Advances

**Screen:** web `pages/hr/Advances.tsx` (450 lines).

**Table `employee_advances`:** `id, employee_id, amount, date (CURRENT_DATE), note, is_deducted bool, deducted_payroll_id int, created_at`.

- **Create** (`POST /hr/advances`, `hr.ts:2394`): month-lock 423; resolves the paying till BEFORE inserting; inserts `is_deducted=false`; posts the grant JV (§22.9).
- **Auto-deduct at generate** (`hr.ts:1854-1903`): a draft run *claims* unsettled advances (`deducted_payroll_id = run id`, still `is_deducted=false`) in date order (`date ASC, id ASC`) while each fits WHOLE inside net pay (recovery can never push take-home below zero; advances are recovered whole only — a part-recovered advance would desync the ledger). Approval flips them to `is_deducted=true` and posts `Cr ADV-EMP-<id>`.
- **Advance row lock / one settlement path per advance:** generate locks the advance rows `FOR UPDATE` and re-asserts the claim count (`hr.ts:1966-1976`); cash recovery locks the SAME row `FOR UPDATE` (`hr.ts:2480`). So an advance is either payroll-deducted OR cash-recovered, never both — whichever transaction commits first, the other sees it.
- **Cash recovery** (`POST /hr/advances/:id/recover`, `hr.ts:2466`): whole-advance only (partial would leave a remainder no flow sees). Refuses if `is_deducted` (400) or if `deducted_payroll_id` is set (400 "reserved by a payroll run — remove it from that run first"). Posts the recovery JV; sets `is_deducted=TRUE`, leaves `deducted_payroll_id` NULL (settled-with-no-payroll = cash recovery).
- **Teardown release:** tearing down a draft (`teardownDraftPayroll`, `hr.ts:1295-1320`) sets `deducted_payroll_id=NULL` on its unsettled claims so a later month can recover them; done under the payroll row lock re-checking draft status.

**Business rules (implemented):**
- Advances are auto-deducted at generation, in date order, whole, only while they fit in net pay.
- Exactly one settlement path per advance (payroll deduction or cash recovery), guarded by row locks.
- Cash recovery is whole-advance only, refused when reserved by a run or already settled.
- Draft teardown releases advance claims for reuse.

### 22.11 Daily salary accrual engine (P&L daily; approval = delta true-up)

`lib/salaryAccrual.ts` — `runSalaryAccrual` runs on a timer and on demand (holiday writes, reactivation, revision). Key properties (`salaryAccrual.ts:16-64`):
- **Catch-up, not a tick:** evaluates every open day from the employee's effective start to `asOf`; idempotent (unique `(employee_id, accrual_date)`); recomputes-in-place (so a corrected day is updated, never duplicated).
- **Per-day rate** = `monthly_salary / workingDays` (company policy basis), UNROUNDED, and the earned total is computed as `effectiveBasic = monthly − round2(lopDays × rate)` verbatim from payroll's expression — computing it as `paidDays × rate` would drift a paisa or two and make approval true up an unexplainable difference (`salaryAccrual.ts:438-547`). Each day is charged the *increase* in the month's cumulative earned total (cumulative-difference pricing, no per-day rounding accumulation). Rounding remainder lands on the last covered calendar day so a fully-covered month totals the monthly salary to the paisa.
- **Attendance-driven splits:** same `dayContribution` and cumulative `payableDays = worked + paidOff + min(casual,alw) + min(sick,alw)` capped at workingDays.
- **Untracked month = zero pay post-cutover:** days on/after `attendanceFrom` (`salary_accrual_config.attendance_from`) in a month with no rows earn nothing (writes zero-value audit rows); pre-cutover days are left exactly as the old flat-calendar engine wrote them (`salaryAccrual.ts:484-515`). LOP-off → every day full paid.
- **Zero-value rows are still written** as the audit that a day was evaluated; the derived-posting stream skips `amount ≤ 0` so they reach the books as no entry (`salaryAccrual.ts:566-583`, `journal.ts:1531`).
- **Locked months:** `lockedMonths` unions the employee's approved/paid payroll months AND accounting-period locks; the sweep never accrues, re-prices, or deletes a day inside them (`salaryAccrual.ts:214-226, 476`).
- **Employment bounds:** the walk never prices past `last_working_date`; rows already written beyond it are DELETEd (except in approved/paid or period-locked months) inside the accrual lock (`salaryAccrual.ts:360-381`).
- **Start date** = `max(join_date|created_at, salary_accrual_resume_from)` so reactivation resumes from today, not from a backfill (`salaryAccrual.ts:277-287`).
- **Concurrency:** advisory xact lock class 8201 per employee (`lockSalaryAccrual`); the sweep, salary revision, attendance writes, and approval true-up all queue on it.
- **Approval = delta true-up:** approval reads `accruedForMonth` inside the same lock+txn and posts only `computed − accrued` (§22.9). A fully-attended month accrues to exactly `effectiveBasic`, leaving only allowances + employer statutory to true up.
- **Salary revision** (`recalcUnapprovedSalaryAccruals`, `salaryAccrual.ts:639`): deletes and regenerates every unapproved month in full at the new salary inside one locked txn; approved/period-locked months excluded; salary 0 clears the open days.

**Register view** `GET /hr/salary-accruals` (`hr.ts:2054`): grouped by employee×month — days, accrued Σ, monthly_salary, paidDays (Σ attendance_factor), earningDays, workingDays, dailyAccrual rate, first/last day, `payrollStatus`, `locked` (approved|paid). LBAC-scoped to visible employees + global location filter.

**Table `salary_accruals`** (verified live): `id, employee_id, accrual_date, year, month, amount numeric(15,2), monthly_salary, days_in_month, attendance_factor numeric(4,2), working_days, attendance_basis text` (unique `idx_salary_accrual_emp_date`). `attendance_basis` values: `full_day, half_day, leave, sick_leave, absent, lop, holiday, weekly_off, untracked, no_lop`. **Table `salary_accrual_config`:** `id, attendance_from date` (the cutover).

**Business rules (implemented):**
- Salary is recognised daily as earned, at the same unrounded rate/expression payroll uses, so approval only true-ups the delta.
- The sweep is idempotent, recompute-in-place, and catch-up safe.
- Approved/paid months and accounting-period-locked months are financially final — never re-priced, extended, or deleted by automation.
- Post-cutover untracked months earn zero; pre-cutover months keep legacy full pay.
- Accrual is bounded by the last-working-date; rows past it are torn down (outside locked months).

### 22.12 Statutory (PF/ESI)

`loadStatutoryRates` (`hr.ts:435-455`) reads from `company_settings`: `pf_enabled, pf_employee_percent (12), pf_employer_percent (12), esi_enabled, esi_employee_percent (0.75), esi_employer_percent (3.25)`. Defaults `STATUTORY_DEFAULTS`. **Rates are snapshotted per run** into `payroll.statutory_snapshot` at generate time, so a later rate change never alters an approved/paid period (`hr.ts:417-420, 1905-1915`). `stripStatutoryDuplicates` drops legacy pay-component lines named PF/EPF/provident or ESI/ESIC when the corresponding scheme is enabled, so the contribution isn't deducted twice (`hr.ts:465-474`). PF on effective basic, ESI on gross (post-LOP). The salary JV recognises the full employer cost.

**Business rules (implemented):**
- PF/ESI rates are company-wide settings, snapshotted onto every run so approved periods are immune to later changes.
- Duplicate manually-configured PF/ESI deduction lines are stripped when the scheme is enabled.
- Employer PF/ESI is a business cost posted in the salary JV; only employee shares reduce take-home.

### 22.13 Per-employee ledgers

- `SAL-EMP-<id>` — "Salary - <emp>", type expense, section profit_loss, parent `STD-SALARY-EXP` (`payrollLedgers.ts:79-82`).
- `SAL-PAY-<id>` — "Salary Payable - <emp>", type liability, parent `STD-GRP-SAL-PAY` (`payrollLedgers.ts:83-86`); note the pay endpoint's `findOrProvisionLedger` fallback files it under `SYS-CURL` if absent (`hr.ts:2259-2264`).
- `ADV-EMP-<id>` — "Advance - <emp>", type asset, parent `SYS-CURA` (`hr.ts:2423-2428`).

All provisioned idempotently (INSERT ON CONFLICT DO NOTHING then re-read). Section follows the type so a salary expense never gets stamped balance_sheet and drop out of the P&L.

### 22.14 Salary payslip PDF

`POST /pdf/payslip` {payrollId} (`pdfGen.ts:419`), needs `page:/hr/payroll` **download**; a non-HO user may only download their own (403). Everything printed is read back from the STORED payroll row + `company_settings` header, so the slip can never disagree with approved figures. Server-side jsPDF via `services/payslipPdf.ts`; company logo inlined only if it's a `data:image/` URL.

### 22.15 Employee mobile app touchpoints

`artifacts/employee-app` (Expo). Tabs: Home (`index.tsx`), Attendance, Leaves, Payslips; plus `login.tsx` and `ChangePasswordModal`.

- **Auth / 401 contract** (`contexts/AuthContext.tsx:53-66`): a global unauthorized handler clears the persisted token+employee and routes to `/login` on any confirmed 401 (token is 8-hour server-expiry). Login via `POST /api/auth/login`; token wired into `customFetch` as bearer; `mustChangePassword` forces the change-password modal.
- **Self-scope GETs** (server forces self-scope for branch users, so the app just calls the shared endpoints):
  - Attendance config: `GET /api/hr/attendance/config` (timezone/thresholds; `attendance.tsx:150`).
  - Today's / month's attendance: `GET /api/hr/attendance?date=...` and `?year&month` (`attendance.tsx:193, 404`).
  - Punch: `POST /api/hr/attendance/check-in|check-out` with `{employeeId, lat, lng}` (`attendance.tsx:236`).
  - Payroll: `useListEnrichedPayroll` (generated hook over `GET /hr/payroll`, self-scoped) drives Home + Payslips; payslip PDF via `POST /pdf/payslip` (own only).
  - Leave balance: `GET /api/hr/leave-balance?year&month` (`index.tsx:75`).
  - Advances: `useListAdvances` / `GET /hr/advances` (self-scope fallback, `index.tsx:19`).
  - Leaves list/apply/cancel over `/hr/leaves` (`leaves.tsx`).

**Business rules (implemented):**
- The app relies on the server's self-scoping — it doesn't send scope, and branch users only ever get their own data.
- A 401 clears the session and forces re-login; there's no client-side session refresh.
- The app keys "today" on `attendance/config.today` (company timezone), not the device clock.

### 22.16 Inventory / customer-vendor / dashboard / reports / audit impact

- **Inventory impact:** none directly; but `is_production_staff` marks whose daily salary is spread across a day's production batches as labour cost (production costing; `hr.ts:1242-1244`).
- **Customer/vendor impact:** none.
- **Cash/bank & location impact:** salary payments, advances, and cash recoveries move the resolved till/bank ledger and stamp the voucher with that till's location (HO = null/company-level); branch tills never fall back to HO cash (§22.9).
- **Reports affected:** HR reports (payroll register, salary report, attendance reports — audit §7); the salary-accrual register (`GET /hr/salary-accruals`); Financial reports read salary via `buildBooks` (`STD-SALARY-EXP` subtree feeds the Dashboard expense breakdown and P&L Indirect Expenses).
- **Dashboard impact:** salary rolls into the Expenses tile (Salary breakdown from the `STD-SALARY-EXP` subtree) and into GP/NP via the same `buildBooks` P&L; never re-summed (audit §8).
- **Audit-log impact:** `logActivity` on employee create/update/delete, employment-status change, salary revision, holiday add/remove, leave apply/approve/reject/cancel, attendance correction, payroll approve/pay, advance recover, password reset — module tags `hr`/`payroll`.

### 22.17 Important validations & known limitations

**Validations:** month-lock (423 `MONTH_LOCKED`) on every dated write (generate, patch, pay, advance, recover, check-in/out, leave approve/cancel, correction, holiday writes via accrual sweep); disabled-warehouse 409 on money-moving endpoints; username uniqueness; leave date ordering; payment mode ∈ {cash,bank,upi}; approve/pay status gates; advance whole-and-fits rule; balance assertion on the salary JV (≤ ₹0.02).

**Known limitations / notes:**
- No un-approve endpoint — approved payroll corrections are manual reversing journals (by design).
- `DELETE /hr/employees/:id` hard-deletes the row without blocking on payroll/accrual history — **NOT VERIFIED** whether downstream FK/history is cleaned (audit mentions boot sweeps heal orphan ledgers, but that is out of this route). Flagged as a potential data-integrity gap.
- `pay_components.working_days_per_month` still stored/editable but NOT used by pricing (dead for calculation; legacy display only).
- Accrual rows written before the `working_days`/`attendance_basis` columns existed display a legacy basis (`DEFAULT_WORKING_DAYS = 26`) — display-only.
- `reaccrue` after attendance writes is best-effort (errors swallowed); correctness is guaranteed by the hourly sweep, not the inline call.

---

## 23. GST

### 23.1 Slab validation

`lib/gst.ts`: valid slabs `[0, 5, 12, 18, 28]`; `isValidGstSlab` +
`gstSlabErrorMessage`. (Entry-time slab locking on item masters is task #14, still
open — the constants exist and are used for validation helpers, but the audit notes
enforcement at entry is not complete: **PARTIALLY IMPLEMENTED**.)

### 23.2 Line tax heads — the single tax-math authority

`lineTaxHeads(li)` (`gst.ts:21-34`) returns `{cgst, sgst, igst}` for one line. It
uses explicit per-head fields when present; otherwise, from `taxAmount` + `taxType`:
`igst`/`inter` → all on IGST; anything else → **CGST = round(taxAmount/2)**, **SGST
= round(taxAmount − CGST)** (half + exact remainder, one rounding, never two
independent halves). **Both** the ledger derivation (`journal.ts`) and every GST
report (`routes/gst.ts`) call this exact function, so classification can never
diverge.

### 23.3 Place of supply — `isInterStateSupply` (code-first, alias-folding)

`lib/gstTransfer.ts:59-71`: compares the **selling location's** state to the
customer's state (place of supply). Resolution order: official 2-digit state
**codes** first (folding aliases — Orissa/Odisha, Uttaranchal/Uttarakhand, etc.,
via `STATE_CODES` map `gstTransfer.ts:19-34`), else normalised names. A missing
customer state (walk-in) or missing seller state ⇒ **intrastate** (CGST/SGST at the
counter's own state). Every sales producer (POS, sales entry, quotations) routes
through this one function (`sales.ts:689,1370`, `quotations.ts:236`). The client
mirrors the same state list in `indianStates.ts` (web).

### 23.4 CGST/SGST paise split

Split is always **half + exact remainder** so the two halves re-sum to `taxAmount`
exactly — in `lineTaxHeads` (23.2), in transfer pricing
(`buildTransferInvoiceLines` `gstTransfer.ts:285-286`: `cgst=r2(taxAmount/2)`,
`sgst=r2(taxAmount−cgst)`), and in the sale posting residual-to-`STD-DTX`
(§17.3 Source 5).

### 23.5 Purchases — ITC treatment

Purchase input GST posts to `STD-INP-CGST/SGST/IGST` as **debit assets** (input tax
credit) only when the head split is internally consistent (§17.3 Source 6);
otherwise the whole bill is a lump purchase debit (no ITC split). **Asset
purchases capitalise GST into cost (no ITC)** — the purchase row is the register
entry; there are no depreciation postings (by design, backlog).

### 23.6 GST reports (`routes/gst.ts`)

- **GSTR-1** (`/gst/gstr1`, `gst.ts:218`): reads `sales WHERE cancelled_at IS NULL`.
  Splits **B2B** (invoice-wise) vs **B2C** (rate-wise by place of supply). B2B/B2C
  is decided by the **stamped `invoice_series`** (`SB2B`→B2B, `SB2C`→B2C); only
  legacy rows with no series stamp fall back to the GSTIN heuristic
  (`gst.ts:263-274`) — this prevents a customer registering later from flipping a
  locked month's history.
- **GSTR-3B** (`/gst/gstr3b`, `gst.ts:322`): outward tax from sales, ITC from
  purchases (via `lineTaxHeads`), then standard **ITC set-off order**: IGST credit →
  IGST, CGST, SGST; CGST credit → CGST, IGST; SGST credit → SGST, IGST
  (`gst.ts:378-390`). Returns net payable + ITC carried forward.
- **HSN summary** (`/gst/hsn-summary`, `gst.ts:144`): per-HSN taxable + tax from
  sales/purchases line items.
- **Reconciliation** (`/gst/reconciliation`, `gst.ts:398`): GST ledger balances vs
  the sales/purchase registers.
- CSV/portal exports available (portal-ready JSON is task #53).

### 23.7 Filing scope — two resolvers, deliberately

- **Filing GSTIN scope**: `lib/gstinScope.ts` (`resolveGstScope`) — a location's
  effective GSTIN **falls back**: warehouse → own `gst_number` else company GSTIN;
  outlet → own `gstin` else parent warehouse's effective GSTIN else company GSTIN;
  headoffice → company `gst_number`. This answers "under which registration is this
  document *reported*".
- **Transfer classification GSTIN**: `resolveLocationGst` (`gstTransfer.ts:86-139`)
  reads **only the location's own** GSTIN with **NO fallback**. This answers "can a
  tax invoice be raised for this transfer" — a blank GSTIN must mean
  unregistered→internal (no invoice).

These two are intentionally different and the code comments forbid unifying them
(`gstinScope.ts:12-19`).

### 23.8 Credit/debit notes effect on returns — ACTUAL behaviour

**Verified honest state:** a sales return raises a `credit_note` JV that reverses
the invoice in the **books** (Dr `STD-SALES` subtotal + Dr `STD-OUT-*` / Cr
`CUST-n`, `returns.ts:432-451`) but does **NOT** set `cancelled_at` on the original
sale for a partial return. Because **GSTR-1 / GSTR-3B / HSN all read `sales`/`purchases`
`WHERE cancelled_at IS NULL` and never read credit/debit-note journal vouchers**
(`gst.ts:151,175,229,336,357,408,420`), a credit note does **not** reduce the GST
returns — the tax stays over-reported. This is the known open gap **task #54**;
`gstTransfer.ts:703-717` documents it explicitly and, for transfer rejections,
compensates by *also* stamping `cancelled_at` (the only path that removes a supply
from the returns). So:
- **Full cancel / cancelled_at set** → removed from returns. ✅
- **Partial return credit note (no cancel)** → books reversed, returns **NOT
  reduced**. ⚠️ (task #54, over-reporting / conservative direction).

### 23.9 Transfer GST

Cross-GSTIN transfers are taxable supplies. In invoice mode they write real
`sales`/`purchases` rows so GSTR-1/3B/HSN can see them (JVs are invisible to the
returns). Tax is **exclusive** (taxable = qty × cost, tax on top) — a transfer is
billed at cost, no margin to extract tax from (`gstTransfer.ts:236-243`). Materials
and packing materials are taxed at their own rate. Same-GSTIN → internal, no GST.

**Business rules (implemented):**
- `lineTaxHeads()` is the single tax-math authority shared by derivation and every
  GST report.
- Slabs are `{0,5,12,18,28}`; entry-time locking is task #14 (partial).
- Inter-state test compares seller vs place-of-supply state, code-first with alias
  folding; missing state ⇒ intrastate. One function for all producers.
- CGST/SGST split is half + exact remainder everywhere.
- Purchase ITC posts to input-GST assets only when the head split is consistent;
  asset GST is capitalised (no ITC).
- GSTR-1 B2B/B2C by stamped `invoice_series`; GSTR-3B ITC set-off IGST→CGST→SGST.
- Filing scope uses company/parent GSTIN fallback; transfer classification uses the
  location's own GSTIN with no fallback — two resolvers on purpose.
- Credit/debit notes do NOT reduce GST returns unless the source document is
  cancelled (`cancelled_at`); partial-return credit notes leave GST over-reported
  (task #54).
- Cross-GSTIN transfers raise real invoices with exclusive tax; same-GSTIN
  transfers post no GST.

---


---

## 24. B2B / B2C Classification

**Purpose.** Decide whether a sale is a registered B2B supply (invoice series
`SB2B`) or an unregistered B2C supply (`SB2C`), drive GSTR-1 grouping, and handle
the customer-registration transition safely across locked months.

**Series is decided at invoice-number allocation (`api-server/src/routes/sales.ts`,
`allocateSalesInvoiceNumber` / `SALES_SERIES` in `lib/voucherNumber.ts`).** On
`POST /sales`: **SB2B if the customer has a GSTIN, else SB2C** (6-digit serial
per per-location scope, per FY). The stamped `invoice_series` / `invoice_fy` /
`invoice_serial` are permanent identity on the row (`\d sales` unique indexes
`uq_sales_scope_series_fy_serial`).

**GSTR-1 classification follows the STAMPED series, not the current GSTIN
(`api-server/src/routes/gst.ts:268–274`).** `isB2B = series === "SB2B" ? true :
series === "SB2C" ? false : Boolean(gstin)`. The GSTIN heuristic is used ONLY as
a fallback for legacy rows with no series stamp (and transfer twins). This
prevents a customer registering later from silently flipping a locked month's
B2C invoices to B2B. GSTIN/state/party-name resolve from the sale's stamped
`party_gstin`/`party_state`/`party_name`, falling back to the customer record —
important for branch-transfer invoices that have no customer row
(`gst.ts:259–266`). Cancelled sales excluded (`gst.ts:229`).

**Customer B2C → B2B reclassification (`api-server/src/lib/invoiceReclass.ts`,
`convertCustomerB2CToB2B`).** Triggered when a customer's GST is edited in
`api-server/src/routes/customers.ts` (~lines 318–385). In one transaction:
- Lock the B2C counter, select all that customer's `SB2C` rows `FOR UPDATE`,
  draw fresh B2B serials, stamp `party_gstin`.
- Compact the vacated B2C serials (floor = `minConverted − 1`; pins =
  locked-month / cancelled / null-serial rows), and walk the B2C counter back.
- Rename the trail across `receipts`, `quotations`, `sale_payments`.
- **Skips locked months and legacy rows**; audited after commit.

**Month-close counts.** The month-close summary counts `SB2B` vs `SB2C` (and
"other") invoices for the admin review (`periods.ts:109–112, 167–171`).

**DB fields.** `sales.invoice_series` (`SB2B`/`SB2C`), `invoice_fy`,
`invoice_serial`, `number_scope`, `party_gstin`, `party_state` (all raw-migration,
verified `\d sales`).

**Business rules (implemented):**
- New sale: series is SB2B iff the customer has a GSTIN at sale time, else SB2C.
- GSTR-1 B2B/B2C is decided by the invoice's stamped series forever; the
  customer's current GSTIN is only a fallback for legacy series-less rows.
- Editing a customer's GST reclassifies their open (unlocked, non-legacy) B2C
  invoices to B2B in one transaction, compacting the freed B2C serials and
  renaming the whole trail; locked months are left untouched.

---

## 25. Month Locking (Accounting-Period Locks)

**Purpose.** Freeze an accounting month so no dated financial record can be
created, edited, deleted or moved into/out of it — for users AND automation.
Source: `api-server/src/lib/periodLock.ts` (232 lines) and
`api-server/src/routes/periods.ts` (296 lines).

**Model — absence of row = OPEN.** A month is open unless a row exists in
`accounting_period_locks`; locking is the exception, so no backfill is ever
needed (`periodLock.ts:1–19, 103–109`). `isMonthLocked` = `SELECT 1 … WHERE year
AND month`.

**Guard helpers (all write paths call one with the record's BUSINESS date).**
- `ymOfDate` accepts both `YYYY-MM-DD…` strings and the JS `Date` objects pg
  returns (`periodLock.ts:92–101`).
- `assertDateOpen` / `assertDatesOpen` (edits pass BOTH old + new dates, deduped
  by month in one query so a record can neither change inside a locked month nor
  move across the boundary; `:128–164`).
- `PeriodLockedError` → HTTP **423**, code `MONTH_LOCKED`, standard body
  `{ error, code, month, monthLabel }` (`:36–64`). `MONTH_LOCKED_MESSAGE` is the
  single user-facing string (`:24`).
- `respondIfMonthLocked` — the route-level pre-check used BEFORE opening a
  transaction (sends 423, returns true) (`:177–190`). `handlePeriodLocked` is the
  catch-branch helper for in-transaction throws (`:74–83`).
- Batch/automation: `lockedMonthsAmong` (`:196–217`) and `listLockedMonths`
  (`:220–231`). Background jobs (accrual sweeps, B2C→B2B reclass, resequencing)
  must consult these before touching rows — a locked month is frozen for
  automation too.

**Who can lock/unlock — ADMIN ONLY (hierarchy level 1 exactly).**
`periods.ts:26–34` (`isAdmin`, fails closed on missing/unknown role).
Management (level 2) can VIEW the page but never change lock state
(`periods.ts:6–8`).

**Endpoints (backend, `api-server/src/routes/periods.ts`).**
- `GET /accounting-periods/locks` — auth-only (no module gate); read by every
  signed-in client for the friendly pre-check message; leaks only which months
  are frozen (`:44–56`).
- `GET /accounting-periods/events` — lock/unlock history, gated
  `page:/accounts/periods` (`:59–85`).
- `GET /accounting-periods/:year/:month/summary` — pre-lock verification summary
  (sales/purchases/receipts/payments totals, expenses, GST on sales,
  receivables/payables/cash/bank as of month end, current inventory value, B2B/
  B2C/other invoice counts); gated `page:/accounts/periods` (`:90–178`). Real
  customer sales only — branch transfers excluded (`:105–116`).
- `POST /accounting-periods/:year/:month/lock` — admin-only; requires
  `confirm === true`; **a future month cannot be locked** (`:196–202`).
- `POST /accounting-periods/:year/:month/unlock` — admin-only; requires a
  non-empty `reason` and `confirm === true` (`:250–258`).

**Check-then-lock race.** Handled at the DB, not by a pre-check:
`INSERT … ON CONFLICT (year, month) DO NOTHING RETURNING` — if nothing is
inserted the month was already locked and a 400 is returned (`periods.ts:207–216`);
unlock uses `DELETE … RETURNING` and 400s if nothing was removed
(`:264–272`). Both wrapped in a transaction with a `period_lock_events` audit
row (lock: `:217–221`; unlock with reason: `:273–278`), plus a post-commit
`logActivity` (`:230–234, 287–291`).

**Backend vs frontend.** Enforcement is server-side (guard helpers on every
dated write, 423 responses). The frontend uses `GET …/locks` only for a friendly
pre-save message — it is advisory UX, never the enforcement boundary.

**DB tables.** `accounting_period_locks (year, month, locked_by, locked_at)` with
unique `(year, month)`; `period_lock_events (id, year, month, action, username,
reason, created_at)`.

**Audit.** Every lock and unlock writes a `period_lock_events` row and an
activity-log entry (module `accounts`, entityType `accounting_period`).

**Business rules (implemented):**
- A month with no lock row is open; locking is the explicit exception.
- Only a hierarchy-level-1 Administrator can lock/unlock (fails closed);
  Management may only view.
- Every dated financial write asserts the business date's month is open; edits
  assert BOTH the old and new dates so records cannot move across the boundary.
- Locked-month violations return HTTP 423 `MONTH_LOCKED` with a single standard
  message; automation must also skip locked months.
- Locking requires explicit confirmation and forbids future months; unlocking
  requires a reason + confirmation; the lock/unlock race is resolved atomically
  by `ON CONFLICT DO NOTHING` / `DELETE … RETURNING`.
```

---

## 26. Import/Migration

**Purpose.** A staged, all-or-nothing framework for replacing an old ERP's books with the ERP's own records — master data (customers/vendors/ledgers/items), transaction documents (sales/purchases invoices), settlement vouchers (receipts/payments), general vouchers (journal/contra from the old day book) and opening stock — plus a "Migration Wizard" that wraps all transaction modules into one linear multi-file migration. Every imported record commits through the **same primitives as manual creation** (FEFO lot consumption, weighted-average cost, business-dated `stock_ledger`, `lineTaxHeads`/`buildSaleLines`/`priceBill` GST math, `createJournalVoucherCore`, the settlement model) so imported documents land in books, inventory, GST reports and dashboards identically to hand-keyed ones.

Primary code: `artifacts/api-server/src/routes/imports.ts` (~6390 lines, PERM `page:/company/import`), with the heavy lifting in `lib/importTransactions.ts` (sales/purchases), `lib/importVouchers.ts` (receipts/payments), `lib/openingStockImport.ts` (opening stock), `lib/legacyReports.ts` (old-software Excel report auto-conversion), and `lib/openingBalances.ts` (ledger opening balances for the masters path). Frontend: `marlin-erp/src/pages/company/import/`.

### 26.1 Access / permissions

All import endpoints are gated by `page:/company/import` with the five-action model: `download` (templates + error file), `view` (batch/migration/mapping reads), `add` (parse, mappings apply, demo, approve, commit, discard, migration create), `delete` (rollback). Migration **rollback** additionally requires role level ≤ 2 (`imports.ts` rollback handler; also stated in the audit — verified `requireModuleAction(PERM, "delete")` plus level check). Approve/commit resolve the acting location through `resolveActingLocation` (LBAC) and refuse outlet writes when outlets are disabled (`outletWritesBlocked`) and disabled warehouses (`disabledWarehouseError`, 409 `WAREHOUSE_DISABLED`).

### 26.2 Module taxonomy (`imports.ts` lines 81–110)

- `ImportModule` = `customers | vendors | ledgers | items | sales | purchases | receipts | payments | daybook | opening_stock`.
- **Master modules** (`customers/vendors/ledgers/items`): commit records **directly** (no mapping/demo stage) — they CREATE the masters the transaction modules map onto. Reuse the manual-creation libs: `createCustomerWithLedger`/`createVendorWithLedger` (`partyCreate`), `insertChartAccount` (`chartGroups`), `createItemCore` (`itemCreate`), `upsertOpeningBalance` (`openingBalances`).
- **Txn modules** (`sales/purchases`): whole documents with stock + book effects.
- **Voucher modules** (`receipts/payments`): one row = one voucher, allocated against outstanding, excess → advance.
- **Demo modules** (everything except masters): run **Analyse → Mapping → Demo/Trial → Approve/Discard**.

### 26.3 The pipeline (file upload → validation → preview/trial)

1. **Templates** — `GET /imports/templates/:module` (download right) returns a pre-filled sample `.xlsx` (`ExcelJS`, `wb.xlsx.writeBuffer()`; `imports.ts` ~2531/2625). The sample templates are *deliberately shaped* so they never match the legacy-report signatures (§26.7).
2. **Parse** — `POST /imports/parse` uploads the raw `.xlsx` body (`wb.xlsx.load`; a non-workbook returns a plain error). For demo modules, before the normal sample-template parser runs, `convertLegacyReport(module, ws)` (§26.7) is tried; if it detects an old-software layout it converts the sheet to `{rowNumber, values}` records the normal validators consume, else returns null and the sample parser runs.
3. **Validation** — per-module validators (`validateRow` for masters; `validateTransactionRows`, `validateVoucherRows`, `validateDaybookRows`, `validateOpeningStockRows` for demo modules) run on the shared pool by default, or on a caller-held transaction client (`WizQ` seam) so approve-time revalidation sees the same transactional view as the writes it gates. Rows get a status: `ok | error | needs_mapping | needs_party`.
4. **Mapping-first name resolution** (§26.4).
5. **Demo/Trial** — `POST /imports/batches/:id/demo` for standalone batches; the whole batch runs through the SAME commit code path inside ONE **never-committed** transaction, and the comparison pack is computed on that client BEFORE `ROLLBACK`.
6. **Approve** (`.../approve`) = same routine + `COMMIT`, all-or-nothing; or **Discard** (`.../discard`) = nothing was ever written.

### 26.4 Mapping-first name resolution (auto-create retired)

`import_mappings` is the ONLY way a transaction-module file name resolves to a master (`imports.ts` 117–159). `kind ∈ customer|vendor|ledger|product`; product rows carry `target_kind` (`item|material|raw_material`) because those id spaces overlap. Match key `normName` = lower/trim/whitespace-squeeze. **No silent auto-matching** — any unmapped name holds the batch at `needs_mapping`; `addMissingMapping` aggregates distinct unmapped names into the mapping step the user works through (`GET/POST /imports/batches/:id/mappings`, `applyMappingEntries`, `upsertMapping`). The memory is **permanent**: once "M/S Fresh Mart & Co" is mapped, every future file resolves it silently (`GET/PUT/DELETE /imports/mappings`, `revalidateInFlightBatches`). Auto-create was retired — a name must be mapped to an existing master **or** created through the standard party/ledger/item path in the mapping step, never invented by the importer.

### 26.5 What each import type WRITES (verified against code)

All txn/voucher/opening writers accept an `ext?: PoolClient`; with `ext` supplied they write through that client inside a `SAVEPOINT import_doc` (caller owns BEGIN/COMMIT — this is how demo runs one never-committed txn and how the production commit gets all-or-nothing).

**Sales** (`importSaleDoc`, `importTransactions.ts` 126–409) — IMPLEMENTED:
- Reuses `buildSaleLines` + `checkMrpFloor`. Each line declares its price semantics: new-convention lines (`unitDiscount` present) use inclusive price + per-unit discount (MRP floor enforced); legacy batches use exclusive price + line-total discount (grandfathered, no MRP floor).
- Stock: ascending item id, `availabilityAt(lock)`, `stock_entries` deduction, `consumeBatches` (FEFO), business-dated `writeStockLedger`.
- **Invoice numbering:** always draws a fresh `SB2B/SB2C` from `allocateSalesInvoiceNumber` (series from customer GSTIN presence); the old number is stored in `sales.legacy_invoice_number` (searchable). Importing the source number verbatim is refused by design (allocator collision risk).
- Books shape identical to POST /sales (gross on provisioned customers). **Counter legs:** for settled modes (cash/bank/upi), writes a `sale_payments` row with `source='counter'` (so imported bills show Payment History like POS bills; `reconciliation_status='pending'` when the mode clears through bank). Branch (non-HO) settled sales also write a **legacy cash-book receipt** row (`receipts` with `source='sale'`) Dr cash/Elec-Clearing/customer / crediting the location sales ledger — HO writes NO receipt (derived postings fall back to STD-CASH/STD-SALES). Credit-sale collections (`paidAmount>0`) write a real clearing `receipts` voucher (`nextVoucherNumber('receipt')`, `source='sale'`) at branches + a `sale_payments` row, and recompute `amount_paid`/`payment_status` via `computePaymentPosition`. `customers.total_purchases` bumped.
- Provenance stamps: `sales.import_batch_id`, matching receipts' `import_batch_id`.

**Purchases** (`importPurchaseDoc`, 448–650) — IMPLEMENTED:
- Reuses `priceBill` (`price_mode='exclusive'`), GST slab validated per line (`isValidGstSlab`). `other_charges` re-validated at commit via `validateOtherCharges` (freight/hamali → expense ledger, added to vendor dues, never to stock cost/GST).
- **Invoice number kept verbatim** (that IS the legacy number; `purchases_vendor_invoice` enforces per-vendor uniqueness).
- Per-line stock: materials/raw_materials update `avg_cost`+`current_stock` and `creditMaterialAt`+`creditBatch`; items update `production_stock`, upsert `stock_entries`, `updateAvgCostOnInbound`, `creditBatch`. Lot numbers server-issued via `allocateBatchNumbers` (`PUR-YYYYMMDD-NNNNN`). Business-dated `writeStockLedger`.
- **Settlement:** `paidAmount>0` provisions the vendor ledger (`ensureVendorLedger`, threaded through `q`), resolves the paid-from ledger against `importAccountOptions` (cash till default, or the validated bank leaf — re-resolved at commit; a ledger moved out of the cash/bank tree since validation fails here), writes a `payments` voucher `source='allocation'` + a `payment_bill_allocations` row. Cap = goods total + other-charge total.

**Receipts** (`importReceiptVoucher`, `importVouchers.ts` 298–443) — IMPLEMENTED:
- One row = one voucher. ERP **allocates its own** `receipt` number; file number → `receipts.legacy_voucher_number`. `assertVoucherNumberFree` refuses `SB2B/SB2C`-shaped numbers.
- Received-in ledger resolution (`resolveAccountValue`): blank/"cash" → location cash till (mirror-aware `locationCashLedgerId`); "bank" → the location's unique STD-BANK leaf; "upi" → the single UPI-named bank leaf; else exact ledger-name match. Foreign banks (owned by another location) never resolve but produce an actionable error (`assertAccountMatchesLocation` guards commit).
- Allocation: explicit `explicitSaleId` settles ONLY that invoice (locked, per-invoice caps, cancelled/branch-transfer/other-customer/other-location refused); blank ref → **FIFO oldest-first** across the party's open invoices at the target location (HO target = unrestricted), snapshot then lock ascending-id, clamp to live outstanding. Writes `sale_payments` rows linked by `clearing_receipt_id` and updates each sale's `amount_paid`/`payment_status`.
- **Excess = customer credit on the customer's own `CUST-n` ledger** (single-ledger model; `advance_ledger_id` NULL, `advance_amount` records the slice for FIFO attribution + delete guard). `method` = cash/bank per `isCashFamilyLedger`.

**Payments** (`importPaymentVoucher`, 466–~600) — IMPLEMENTED: mirror of receipts against purchases, using `purchaseSettlementIndex` for dues, per-bill headroom cap (`payment_bill_allocations` + `purchase_advance_applications`), `payments` voucher `source='allocation'`, and excess parked in the vendor's `VADV-n` advance ledger (`ensureAdvanceLedger`).

**Journal/Contra** (from day book, or receipt/payment rows routed to a ledger) — IMPLEMENTED via `createJournalVoucherCore` (`runBatchImport`, `imports.ts` 3690–3846). Day book imports only Journal + Contra (§26.7). Receipt/payment rows whose party is NOT a customer/vendor (capital accounts, expense heads) can be routed in mapping to `skip` (surfaced in skip report) or `journal` (Dr money account / Cr routed ledger for receipts; reversed for payments). Legacy number → `journal_vouchers.legacy_voucher_number`.

**Opening stock** (`importOpeningStockDoc`, `openingStockImport.ts`) — IMPLEMENTED: modeled on the stock-verification path — one `stock_verifications` row (anchor for rollback), `stock_entries` credited (ADDITIVE, never absolute set), `items.production_stock` synced at HO, an `OPN-<verifId>` lot per line (`creditBatch` source `adjustment`), `updateAvgCostOnInbound` when a rate is present, business-dated `stock_ledger`. Whole file = one statement.

**Opening balances (ledgers)** — IMPLEMENTED but only in the **masters** `ledgers` import path (`upsertOpeningBalance` via `openingBalances.ts`), NOT as a wizard transaction module. The migration wizard's `opening_stock` covers inventory openings; ledger opening balances come from the `ledgers` master import (Debit/Credit column). There is **no separate "opening_balances" wizard module** — NOT IMPLEMENTED as a distinct migration file type.

### 26.6 File-order commits, one-transaction rollback, wizard location LAST

- **File-order (avg cost):** sales/purchases documents are grouped by `norm.doc` and imported in ascending doc index — "Whole DOCUMENTS in file order (avg cost depends on it — never re-sort)" (`runBatchImport` 3567). Weighted-average cost is order-dependent, so re-sorting would change valuation.
- **One-transaction, all-or-nothing:** standalone commit (`.../commit`) and migration approve run every document on one client in one txn; any failure `ROLLBACK`s everything (`ImportAbort` in approve mode aborts the whole run — "Nothing was imported from ANY file"). Demo mode collects per-document failures instead of aborting.
- **Run order** (`WIZARD_RUN_ORDER`, line 5328): `opening_stock → purchases → sales → receipts → payments → daybook`. Rollback runs the **reverse** order.
- **Wizard location picked at TRIAL/approve time (LAST):** files carry NO location; mapping/demo use a provisional HO stamp. `POST /imports/migrations/:id/approve` **requires** `locationType` in the body ("Pick the location first"). It re-stamps every batch (`UPDATE import_batches SET location_type/id`), **re-validates** at the chosen location (`revalidateDemoBatch`) — duplicates, stock scope and ledger ownership are all per-location — and **refuses** (409) if any file's stamp already differs from the requested location ("The trial ran at X, but this approval asks for Y … re-run the trial at the right location"). So approval imports exactly what the trial showed, including WHERE. An accounting-period lock check on every row's `dateIso` runs before any write (423 if any date lands in a locked month). Dev fault-injection env vars (`IMPORT_FAULT_INJECT`) prove atomicity of the restamp/revalidation and bookkeeping phases.

### 26.7 Legacy old-software Excel report auto-conversion (`lib/legacyReports.ts`)

`convertLegacyReport(module, ws)` detects five report families the owner's previous software exports, whose layout the normal parser can't read (banner rows above the header, header typically on row 6, `DD-MM-YY` two-digit-year dates, unit-group separator rows, Tally-style day book). `findHeaderRow` scans the first 15 rows for ALL required normalised header tokens (sample templates never match). Returns converted `{rowNumber, values}` rows + a `LegacyConversionMeta` (report label, headerRow, kept/dropped counts, plain-language notes), or an error, or null (not legacy → normal parser).

- **Item-wise Sales** (`convertSales`): columns `SlNo|Date|Invoice No|Party|Item|Qty|Rate|Amount|CGST%|CGST|SGST%|SGST|IGST%|IGST|UNIT`. **Amount is the GST-INCLUSIVE line total**; the ERP price = Amount ÷ Qty (inclusive), NOT the pre-tax Rate column. `gstRate` = sum of the % columns. Old software restarts invoice numbering, so the same number names several bills → disambiguated by `(number, date, customer)`: first bill keeps the number, later distinct bills get `/2`, `/3` … suffixes (`invoiceAliases` lookup, not a consecutive run). Walk-ins ("Walking Customer") → walk-in cash sales (no party); all other sales imported as **Credit** so the Receipt report can settle them.
- **Item-wise Purchase** (`convertPurchases`): `Rate` is GST-EXCLUSIVE → maps straight to the ERP Rate; inclusive Amount is deliberately NOT emitted (GST recomputed and cross-checked). Charge-type lines can be flagged as bill charges in mapping.
- **Receipt / Payment** (`convertVouchers`): `SlNo|Voucher No|Date|Account Name|Address1|Amount|Discount[|Payment Type]`. Repeated voucher numbers → `/2` suffix (each row is its own voucher). Payment-type mapped to money account: generic spellings (NEFT/RTGS/IMPS/plain HDFC/TPT/cheque…) → "Bank", UPI apps → "UPI", blank/"cash" → cash till; a **specific** name with digits/extra words (e.g. `hdfc-4737`) passes through verbatim for exact ledger match. Discount amounts noted in narration, **not posted**.
- **Day Book** (`convertDaybook`): `Description|Narration|Vch Name|Vch No.|Debit|Credit`; date lives on `Date : DD-MM-YY` section rows; one voucher's legs span multiple rows (folded back together). **Only Journal and Contra vouchers are kept** — every other family (Receipt/Payment/Sales/Purchase) is EXCLUDED because its own report file covers it (importing here would double-enter). If no journal/contra rows exist, returns an explanatory error listing what's covered/uncovered. Repeated numbers `/2`-suffixed.

### 26.8 Comparison / demo report pack

Built ON the never-committed demo client (`buildDemoReportPack`, 3946) so it sees uncommitted documents, using the SAME owning modules as live screens (`computeTrialBalance`, `buildBooks`, `computeCashBankBook`, `purchaseSettlementIndex`, `stockValuation`) narrowed to the import's location via `demoPackLocation` (HO matches on type alone; mirror places match any identity sharing the cash ledger). Tabs: **Overview/KPIs, Trial Balance, P&L, Balance Sheet, Cash Book, Bank Book, Receivables, Payables (vendor dues via settlement walk), Stock valuation.** `GET .../demo-report` (view right) returns the stored pack for side-by-side comparison with the old ERP.

### 26.9 Rollback (reversal-equivalent)

- Standalone/migration rollback (`.../rollback`, delete right; migrations level ≤ 2) reverse in one transaction (reverse run order via `reverseWizardBatch`). Each per-document reverser returns a human blocking reason or null.
- `rollbackImportedSale`: refuses if cancelled/branch-transfer/has-returns/foreign payments; restores stock+lots (`restoreBatches`), reverses `sale_payments`/clearing receipts it owns, decrements `total_purchases`, deletes sale-source receipts (location-scoped to survive shared numbers), writes `sale_cancellation` ledger dated on the sale's date.
- `rollbackImportedPurchase`: deletes own allocation voucher first; refuses if later allocations/advances reference the bill or lots were consumed; **unwinds avg cost WITH quantity** (`updateAvgCostOnReversal`/mirrored guarded SQL — beyond what manual DELETE /purchases does).
- `rollbackImportedOpeningStock`: refuses if OPN lots consumed; unwinds avg cost + stock + verification.
- Voucher rollback unwinds allocations/advances; refuses (409, per-voucher reasons) when an advance was already consumed downstream. Per-batch endpoints refuse migration-owned batches (409); post-delete books verification runs.
- Rollback eligibility is decided from **actual current state**, never a history flag. `verifyAfterRollback` confirms invoice numbers gone.

### 26.10 Exports (import module) — honest inventory

- **Sample template `.xlsx`** — `GET /imports/templates/:module` (download).
- **Error file `.xlsx`** — `GET /imports/batches/:id/error-file` (download) — the batch's rows with error/mapping verdicts.
- **No PDF, no CSV export** for the import module itself. The demo comparison pack is returned as JSON to the UI (no server-side PDF/CSV of the pack). — PDF/CSV of imports: **NOT FOUND.**

**Business rules (implemented):**
- Master imports create records directly through the manual-creation libs; no demo stage.
- Transaction/voucher/day-book/opening-stock imports must pass Analyse → Mapping → Demo/Trial → Approve.
- Every file name resolves ONLY through permanent `import_mappings`; no silent auto-matching, no auto-create.
- Sales get a fresh SB2B/SB2C number; old number → `legacy_invoice_number`. Purchases keep the vendor bill number verbatim (per-vendor unique). Receipt/payment/journal vouchers draw their own number; old number → `legacy_voucher_number`.
- Settled-mode sales write a `source='counter'` sale_payment; branch settled sales also write a `source='sale'` receipt; HO writes none (derived).
- Sales/purchases commit in file order (weighted-avg cost is order-dependent).
- Voucher excess → customer credit on `CUST-n` (customers) / `VADV-n` advance ledger (vendors); consumable like manual advances.
- Migration location is chosen LAST (at approve); files re-stamped + re-validated there; approval refuses a location different from the trial's.
- Wizard run order opening_stock→purchases→sales→receipts→payments→daybook; rollback reverses it; both are one all-or-nothing transaction.
- Old-software reports auto-detected: Sales uses GST-inclusive Amount; reused numbers get `/2` suffixes; day book imports Journal/Contra only.
- Only `.xlsx` template + `.xlsx` error file are exportable; no PDF/CSV of import data or the demo pack.

---

## 27. Reports

Every report is derived from the same double-entry stream (`buildDerivedPostings` → `buildBooks`, `lib/books.ts`) or from scoped SQL over the source tables. This section walks each report page in `marlin-erp/src/pages/` (reports + accounts).

### 27.0 Cross-cutting conventions

- **Reports Center** (`pages/reports/ReportsCenter.tsx` → `sections/*`) uses `shared.tsx`: `useDateRange` (presets today/yesterday/week/month/quarter/fy/all/custom; FY presets follow `companySettings.fyStartMonth`, default 4; dates computed in **local** calendar, never `toISOString`), `useLocationFilter` (compound key `${type}:${id}`, `''` = all), `ReportPicker`, `SummaryCards`, `RTable`, `ExportButtons`.
- **Table sorting/footers** (`lib/tableSort.tsx`, `RTable` in `shared.tsx`): tri-state click sort (asc → desc → default ERP order), type-aware (`Intl.Collator numeric` natural order `INV0009 < INV0010`, Indian-grouped numbers parsed as numbers, blanks always last in both directions), decorate-sort-undecorate, stable. `RTable` renders a `<SortableHead>` per sortable column, an optional bold `footer` totals row (one cell per column), and a "N records" line. Accessors must return RAW values (never `₹`-formatted strings).
- **Exports** (`shared.tsx` 425–528): **PDF** POSTs preformatted sections to `/api/pdf/report` (server-side jsPDF; PDFs use "Rs." — no ₹ glyph in the base font); **Excel** to `/api/xlsx/report` (numbers stay numeric); **CSV** built client-side (`downloadCSV`); **Print** = same PDF payload with `intent:'print'`. ALL four channels gated by ONE `Download` right (`canDownload`).
- **Global filters plumbing:** financial reports take `from/to` + a location; the location narrows LBAC only. `getPostingLocationFilter(req)` yields the posting-location filter; branch users are forced to their own location (server authoritative). **HO placeholder matches on TYPE alone** (its id differs per table — 0 for vouchers, 1 for sales/stock). Located financial reports echo a `companyLevel` remainder (journal-family/legacy-unstamped postings that carry no location) so a per-location slice doesn't look like it sums short (`companyLevelSummary`, `locationEcho`). Trial Balance and Balance Sheet are company-wide by construction — the location filter control is rendered **disabled** with an explanation (`LocationFilter disabledReason`).

### 27.1 Dashboard (`pages/dashboard/Dashboard.tsx`)

- **Data source:** `useGetDashboardBi(filters)` → `GET /dashboard/bi` (NOT `/dashboard/summary`; the legacy `/dashboard/summary` endpoint still exists but the Dashboard reads `/bi`).
- KPI tile sources (verified `routes/dashboard.ts` `/bi`):
  - **Sales / Purchases / trend / payment mix / by-location / top items/customers:** scoped SQL over `sales`/`purchases` (excludes `branch_transfer_id` + cancelled; LBAC-filtered; sale location via `location_type`+`location_id`). **`/dashboard/bi` sales INCLUDE warehouse (and HO) sales** — `salesConds()` filters only by the requested/effective location (`COALESCE(s.location_type,'outlet')`), with no HO/warehouse exclusion; when no location is selected it sums ALL locations. The legacy `/dashboard/summary` endpoint likewise applies only a `pushLocationFilter` (no explicit warehouse exclusion in its `salesConds`) — so the source of open task #37 ("summary misses warehouse sales") could NOT be reproduced as a hard exclusion in current code. Documented actual behaviour: **the live Dashboard reads `/bi` and its sales totals include warehouse sales; task #37 is UNCLEAR / possibly already addressed against current code.**
  - **Expenses (+ Salary·Rent·Other):** `companyFinancials` → `buildBooks` P&L (direct+indirect; breakdown from STD-SALARY-EXP / STD-GRP-RENT-EXP subtrees; Other = exact remainder). **Never re-sum expense subtrees** for a tile (production capitalisation overlay would double count).
  - **GP / NP:** read straight off the SAME `buildBooks` P&L summary (`companyFinancials().profit`) — click-through to `/reports/financial#pl-gross-profit` / `#pl-net-profit`.
  - **Receivables / Payables:** ledger-balance index control totals (postings have no location → company-level; **null for branch logins**, UI shows —).
  - **Cash / Bank:** same ledger index (STD-CASH/STD-BANK walks incl. opening balances).
  - **Inventory value:** shared `stockValuation`; hidden entirely (server omits the key) without the valuation right.
  - **Money In / Out Today (`moneyFlows`):** from `bi.moneyFlows`.
- Tiles must agree with the statements by construction; hidden money figures are omitted (—), never zeroed.

### 27.2 Trial Balance (`pages/accounts/TrialBalance.tsx` + `sections/FinancialReports.tsx`)

- Accounts page → `GET /accounts/trial-balance` (`journal.ts` 1820): **HO-only** (branch users get `[]`); `computeTrialBalance({fromDate,toDate,locFilter})` over the posting stream, net per ledger (Dr if positive else Cr), grouped, with `balanced` flag.
- Reports Center → `GET /reports/fin/trial-balance` (`financialReports.ts` 202): also HO-only; `splitPostings(from,to,loc)` → aggregates `inRange` by ledger, drops |net|<0.005, joins the chart for names/groups, returns `totalDebit/totalCredit/difference/balanced` + `companyLevel` echo when a location filter is applied.
- **Opening/closing:** none per se — the TB nets postings in the range; `splitPostings` separates `before` from `inRange`.

### 27.3 Balance Sheet & P&L (`sections/FinancialReports.tsx`)

- Both read `GET /accounts/financial-statements` (`accounts.ts` 3355) → `buildBooks(buildDerivedPostings, {fromDate,toDate,location})`. Branch users forced to their own location; `locationScoped`+`companyLevel` echoed for HO location slices. Returns `{profitAndLoss, balanceSheet, trialBalance, ...}`.
- **P&L calculation basis:** derived postings via `buildBooks`. Returns are split remainder-based — `grossSales/salesReturns/purchaseReturns` come from summing credit_note/debit_note-sourced postings on SYS-SAL/SYS-PUR subtrees (group totals stay net). Vertical statement: Sales → Less Returns → Net Sales → Opening Stock → Purchases → Direct Exp → Goods Available → Less Closing Stock → COGS → GP → Other Income → Indirect/Financial Charges/Depreciation → NP. Financial Charges/Depreciation name-matched; Indirect remainder by subtraction so it always ties to NP. **GP/NP tiles read P&L's OWN `profitAndLoss.summary`, never recomputed.** Closing stock via the shared `stockValuation` engine (same figure as Stock report + Dashboard tile). Production `STD-FG-INV`/`STD-PROD-ABS` legs excluded from P&L (closing stock already carries the value).
- **Balance Sheet:** cumulative (no `fromDate` effect on cumulative side); signed to each section's natural side (sign ≠ Dr/Cr). Opening balances folded in by `buildBooks`/`ledgerBalances`.

### 27.4 Cash Book / Bank Book (`pages/accounts/CashBankBook.tsx`, `sections/FinancialReports.tsx`)

- Accounts page → `/accounts/cash-book` + `/accounts/bank-book` (`computeCashBankBook`, `journal.ts` 1729); ledger picker via `/accounts/cash-bank-book/ledgers`.
- Reports Center → `GET /reports/fin/cash` + `/reports/fin/bank` (`financialReports.ts` `bookReport`, 313). Basis: posting stream under STD-CASH / STD-BANK root (or a chosen leaf via `?ledgerId`). **Opening balance** = sum of `before`-range postings on scoped ledgers; running `balance` across `inRange` entries (Receipt = debit, Payment = credit); `closingBalance` = final running balance. Also returns a per-account position table (opening/inflow/outflow/closing across the whole root) so "where is the money" is answerable. `companyLevel` echoed under a location filter.

### 27.5 Day Book (`pages/accounts/DayBook.tsx`, `sections/FinancialReports.tsx`)

- `GET /accounts/day-book` (`journal.ts` 1550) and `GET /reports/fin/day-book` (`financialReports.ts` 659). Basis: the derived posting stream for the date range, listed chronologically by voucher with Dr/Cr legs (includes JV lines with effective location = COALESCE(return doc, voucher stamp)).

### 27.6 Customer / Vendor Ledger & Ledger Statement (`pages/accounts/Ledger.tsx`)

- `useGetLedgerStatement` → `GET /accounts/ledger/:id/statement` (`accounts.ts` 3399) and `/accounts/ledger-statement` (2043); options via `/reports/fin/ledger-options` / `/reports/fin/ledgers`. Basis: posting stream for the ledger with a **running balance**; opening = pre-range postings + ledger opening balance; branch users get their own movements (expenses table + journal-family stay HO/no-location).

### 27.7 Receivables / Payables (Parties reports, `sections/PartiesReports.tsx`)

- Read `/reports/sales`-family endpoints (owning-module calc). Receivables per customer = Σ `outstandingExpr(s)` (`total − paid − credit adjustments`) over non-transfer sales; Payables per vendor via `purchaseSettlementIndex` (advances + other charges + FIFO order). Presented as a **single outstanding figure** per party (dues = total − paid, derivation-consistent with invoice/QR/register). Ageing views show per-party `advance` and seed advance-only parties (company-wide; null for branch logins).

### 27.8 Sales reports (`sections/SalesReports.tsx`)

- Hooks (orval): `useSalesRegister` (`/reports/sales-register`), `useSalesByItem` (`/reports/sales-by-item`), `useSalesByLocation` (`/reports/sales-by-location`), `useDiscountReport` (`/reports/discounts`), `useSalesStockCombined` (`/reports/sales-stock-combined`).
- Basis: scoped SQL over `sales` (excludes `branch_transfer_id` + cancelled; LBAC scope for non-HO via `scopeSalesWhere`); balance/status via shared `computePaymentPosition` so the register agrees with invoice/receivables. `sales-by-location` groups into a warehouse→outlet tree (`HierarchicalLocationTable`). **Warehouse sales inclusion caveat:** these report endpoints DO include warehouse (and HO) sales — the location filter is `($3='' OR type=$3)`, no HO/warehouse exclusion (`reports.ts` 108–112). The open task about "summary misses warehouse sales" is scoped to `/dashboard/summary`, not these reports — documented actual behaviour: **warehouse sales are included** in the Reports-Center sales reports.

### 27.9 Purchase reports (`sections/PurchasesReports.tsx`)

- `/reports/purchase-register`, `/reports/purchases-by-vendor`, `/reports/purchases-by-material` (`reports.ts` 386/482/526). Basis: scoped SQL over `purchases` (excludes branch transfers; vendor dues use the settlement index; `total_amount` is goods-only but payable readers add the `other_charges` JSONB sum). Permission key reuses `page:/reports/sales`.

### 27.10 Stock reports (`sections/InventoryReports.tsx`)

- Hooks: `useGetStockValuation`, `useGetExpiryReport`, `useGetMovementAnalysis`, `useGetReorderReport`; also `/stock/transfers` and `/reports/sales-stock-combined`.
- **Valuation:** the single at-cost engine `stockValuationRows` (on-hand across item/material/raw_material + sender-owned in-transit) — same figure as Dashboard tile and P&L closing stock. **Ageing / movement class** = last OUTBOUND date. **Expiry:** read per batch (`stock_batches` mfg/expiry). **Stock ledger:** window-function running balance (append-only `stock_ledger`, business date, Closing(D)=Opening(D+1)). Reorder = below-threshold report. Negative stock blocked by DB CHECK.

### 27.11 GST reports (`pages/accounts/GstSummary.tsx`, `GstReturns.tsx`)

- Summary: `useGetGstSummaryScoped` + `useGetGstDocuments` + `useGetGstFilters` (`/gst/*`, `page:/accounts/gst`). Returns: `useGetHsnSummary` (`/gst/hsn-summary`), `useGetGstr` (GSTR-1 `/gst/gstr1`, GSTR-3B `/gst/gstr3b`), `useGetGstReconciliation` (`/gst/reconciliation`) — `page:/accounts/gst-returns`. Also `/reports/fin/gst` for the Reports-Center financial GST view.
- Basis: `lineTaxHeads` tax math over sales/purchases; GSTR-1 = B2B invoice-wise / B2C rate-wise by place of supply; GSTR-3B = ITC set-off IGST→CGST→SGST; reconciliation = ledger-vs-register. Filing scope falls back to company GSTIN. The `/gst/*` endpoints return JSON API responses consumed by the UI; CSV exports are noted in the audit. **Portal-ready GSTR-1/3B JSON *file* export (task #53): NOT FOUND** — the gst routes only emit `res.json` API payloads, not a downloadable government-portal JSON file.

### 27.12 Payroll / Salary reports

- `GET /reports/fin/salary` (`financialReports.ts` 542) — salary register/report from the posting stream (SAL-EMP-n / SAL-PAY-n accruals). HR payroll register/attendance reports live under the HR module pages. Basis: derived postings + `payroll`/`salary_accruals` data. Detailed HR report walkthrough is covered in the HR spec section (out of scope here).

### 27.13 Expenses report

- `GET /reports/fin/expenses` (`financialReports.ts` 398): expense ledgers from the posting stream, **plus derived read-only rows (negative synthetic ids)** for purchase/sale `other_charges` freight/hamali postings so P&L/TB/Day Book and this report tie out.

**Business rules (implemented):**
- Dashboard reads `/dashboard/bi` (not `/summary`); tiles come from `buildBooks`/ledger index/valuation engine, never re-summed subtrees; GP/NP/expenses share one P&L build; receivables/payables/cash/bank null for branch logins.
- Trial Balance and Balance Sheet are company-wide (location filter disabled with an explanation); TB is HO-only (branch → empty).
- Financial reports use `from/to`+location narrowing LBAC only; HO matches on type alone; located slices echo a `companyLevel` remainder.
- Cash/Bank books compute opening from pre-range postings and a running balance; a per-account position table accompanies each.
- P&L returns are remainder/subtraction-based and always tie to NP; GP/NP read the P&L's own summary; closing stock uses the shared valuation engine.
- Receivables/Payables present a single outstanding figure per party (dues = total − paid via `computePaymentPosition` / `purchaseSettlementIndex`).
- Sales & purchase Reports-Center reports include warehouse (and HO) sales; only `/dashboard/summary` (legacy, unused by the live Dashboard) understates them.
- Stock valuation/ageing/expiry/movement read the single valuation engine + `stock_batches`/`stock_ledger`; ageing class = last outbound.
- Every report table sorts tri-state with natural numeric order and blanks-last; RTable renders an optional bold totals footer; all export channels (PDF/Excel/CSV/Print) are gated by one Download right.
- PDFs render money as "Rs." (no ₹ glyph); CSV/UI keep ₹.

**NOT VERIFIED / UNCLEAR:**
- GST portal-ready JSON export (task #53): NOT VERIFIED (CSV exports confirmed; JSON not confirmed).
- HR payroll-register report internals: out of this section's scope (covered elsewhere) — NOT documented in depth here.

---

## 28. Permissions

### 28.1 Model — one row per role × page

Table `permissions` (verified `\d permissions`):
`id, hierarchy_id (FK, NOT NULL), module (text, NOT NULL), can_view, can_add,
can_edit, can_delete, can_download, updated_at, can_print, can_approve,
can_share`. Unique constraint `permissions_hierarchy_module_uq (hierarchy_id,
module)`; index `idx_permissions_hier (hierarchy_id)`.

- **`module` is a page key**: `page:` + a sidebar link's href
  (`lib/pagePermissions.ts` `PAGE_PERM_KEYS` — ~59 keys, e.g. `page:/`,
  `page:/sales/pos`, `page:/customers`, `page:/accounts/chart`,
  `page:/company/permissions`). The href is the identifier because link *names*
  collide across sections ("Reports" appears 3×). A name not in `PAGE_PERM_KEYS`
  can never be granted/revoked — a build-time check
  (`scripts/src/check-permissions.ts`) fails on one.
- `pagePermissions.ts` is generated from marlin-erp's `moduleRegistry.ts`
  (regenerate: `pnpm --filter @workspace/scripts run permissions:write`).
- `LEGACY_MODULE_TO_PAGES` maps old grouped module names → the per-link keys and
  was used once by the `per_link_permissions_v1` migration to expand legacy
  rows.

### 28.2 The five actions (and the legacy print/approve/share columns)

The real model is **five actions**: `view` + `add | edit | delete | download`
(`middleware/permissions.ts` `ModuleAction`, `ACTION_COLUMN`).

- `download` **covers every output channel** — CSV/Excel export, PDF save,
  printing, and WhatsApp/email share. One right answers "may this role take a
  document out of the system?".
- `edit` **absorbed approve** — sign-off is write authority over the record.
- The legacy `can_print`, `can_approve`, `can_share` columns still exist but are
  **write-mirrors, never read**: on every `POST /company/permissions` they are
  set from `canDownload`/`canDownload`/`canEdit` respectively
  (`routes/company.ts` ~514-519), and the
  `permission_five_action_fold_v1` migration folded historical values. New code
  must never read them (banner in `middleware/permissions.ts` ~80-92).

### 28.3 Default-deny with seeding migration

- **Default-deny**: a missing `permissions` row = no access, everywhere
  (`requireModuleView` / `requireModuleAction`: "Access is granted only when an
  explicit `can_view=true` row exists").
- The one-time migrations `permission_seed_existing_v1` and
  `per_link_permissions_v1` inserted **all-true** rows for every hierarchy that
  existed when default-deny was introduced, so nobody was locked out on
  cutover. Guarded by `migration_log` — cannot re-run. **Hierarchies created
  afterwards start with NO rows → denied everywhere** until an admin grants
  access on the Permissions page.
- `GET /company/permissions/rbac-audit` (read-only, admin) surfaces rows still
  holding the seeded all-true baseline (all five flags true) plus a summary and
  the seed-migration log — an observability tool that never mutates.

### 28.4 Write guards (requireModuleAction) & which GETs stay unguarded

- Write endpoints are wrapped with `requireModuleAction(pageKey(s), action)`.
  Denials **403** with a human message and are audited
  (`PERMISSION_DENIED` in `activity_log`). An **any-of list** is the norm: one
  endpoint often feeds several pages (e.g. `/items` fills dropdowns on nine
  pages) — access is granted if ANY listed page grants the action.
- `hasModuleAction(hierarchyId, modules, action|'view')` is the shared decision
  for checks that can't be middleware (mid-request credit overrides, or
  response-shaping like hiding search groups) — route code must call this, never
  query `permissions` directly.
- **Deliberately unguarded GETs** (documented in code):
  - `GET /hr/hierarchies` and `GET /company/permissions` — the app shell /
    `usePermission()` read these on **every** page to resolve what the signed-in
    user may see. Guarding them would make permission resolution itself require
    a permission and 403 everyone below top level (`routes/hr.ts` ~904-908;
    `routes/company.ts` ~487). To avoid a disclosure, `GET /company/permissions`
    returns the **full cross-role matrix only to level 1**; everyone else gets
    only their own hierarchy's rows. Likewise `GET /hr/hierarchies` only adds
    per-role headcount for callers who may delete roles (key omitted, not
    zeroed, otherwise).

### 28.5 Inventory-valuation special key & omit-not-zero

- Whether a role may see stock **value** (avg-cost × qty) reuses the Inventory
  Reports page key `page:/headoffice/inventory-reports`
  (`canViewStockValuation`/`INVENTORY_VALUATION_PAGE`). If denied, the server
  **omits** the money fields from the stock payload entirely (a hidden column is
  still readable in devtools) — the same omit-not-zero rule dashboards use for
  receivables/payables/cash/bank on branch logins.

### 28.6 requireHeadOffice — the orthogonal location guard

`requireHeadOffice(what)` (`middleware/permissions.ts` ~248) is **orthogonal to
RBAC**: RBAC asks "may this ROLE write here?", this asks "may this LOCATION write
here?" — both must pass. Non-`headoffice` `branch_type` → **403** with code
`HEAD_OFFICE_ONLY`. Guards company-wide master data (item masters, etc.). Reads
are untouched so branches keep visibility.

### 28.7 Frontend hides links vs backend enforces

- The web `usePermission` / `resolvePermissions` (`lib/usePermission.ts`) mirror
  the server rules exactly (level-1 → FULL_ACCESS; no row → DEFAULT_DENY; else
  the row). The AppLayout sidebar hides links the user can't view, and
  `RoutePermissionGuard` blocks direct navigation.
- The frontend is **purely cosmetic**: the server remains authoritative on every
  request (403/404). Hidden links/columns are a UX nicety, never a security
  boundary.

### 28.8 Admin / level-1 special powers

- `level === 1` (Administrator) is a hardcoded **full-access bypass** in every
  guard (`requireModuleView`, `requireModuleAction`, `hasModuleAction`,
  `canViewStockValuation`, client `resolvePermissions`). Bypass guards exist
  even on level-1 create/delete of roles (you cannot reparent the root or mint a
  second root).
- Extra level-1-only powers (verified): warehouse disable/enable/permanent
  delete (`requireLevelOne`); admin system-delete of `source='sale'` receipts
  (audit §6); full permissions matrix visibility; backup/restore requires HO +
  approve right + password re-verification (audit §1).

### 28.9 What each typical role can actually do

Grounded in code + the live tree; exact grants for levels ≥3 depend on the
`permissions` rows an admin sets (default-deny), so these are the *shapes*:

- **Administrator (level 1, root)** — everything, via the bypass. No permission
  rows required. Only role that can manage the role tree's root, disable/delete
  warehouses, and see the full cross-role permission matrix.
- **Management (level 2)** — no code bypass; in practice granted `can_view` broadly
  with write flags off = **company-wide view-only** (org convention, not code).
- **Head Office user (branch_type='headoffice', level ≥2)** — LBAC sees **all**
  locations; passes `requireHeadOffice` (can create/edit item masters, locations,
  ledgers, opening balances); can act on behalf of any location for money
  vouchers/JVs. Actual page rights still gated by their `permissions` rows.
- **Warehouse user (branch_type='warehouse')** — LBAC sees own warehouse **+ its
  outlets** for stock/sales, but **money scope = own till only**. Fails
  `requireHeadOffice` (403 `HEAD_OFFICE_ONLY`) on master-data writes; can
  read masters. Location selector is locked to their branch. Foreign-location
  records return 404. Manual JVs/vouchers are forced to own location; foreign
  party/HO cash-bank ledgers are refused (`checkVoucherLegs`). Dashboard
  receivables/payables/cash/bank are null (omitted).
- **Outlet / branch user (branch_type='outlet')** — narrowest: sees only its own
  outlet; otherwise like a warehouse user but without child locations.

**Business rules (implemented):**
- One `permissions` row per `(hierarchy_id, module)` where module is a
  `page:<href>` key; five real actions (view/add/edit/delete/download);
  print/approve/share are write-mirrors of download/download/edit, never read.
- Default-deny: missing row = denied; level-1 always allowed; seeding migrations
  granted all-true to pre-existing roles once (guarded by `migration_log`).
- Guards run RBAC (403) before LBAC (404); denials are audited
  (`PERMISSION_DENIED`); hidden money/valuation fields are omitted, not zeroed.
- `GET /hr/hierarchies` and `GET /company/permissions` are unguarded by design
  (login-time resolution); the permission matrix is full only for level 1.
- `requireHeadOffice` is a separate location gate for shared master data
  (code `HEAD_OFFICE_ONLY`), orthogonal to role permissions.
- Frontend hides links/columns via `usePermission`; the backend is always
  authoritative.

---

## 29. Database — relationship map

### 29.1 Overview & conventions

The live dev database was enumerated read-only (`psql \dt`) as ground truth. It contains **74 tables in the `public` schema** (`ERP_SYSTEM_AUDIT.md` §3's "69"/"62 tables" figures are STALE — code wins), plus a separate **`backup_meta`** schema holding `backups`, `backup_settings`, `restore_events` (excluded from every `pg_dump` and from `\dt public`), and a `_system` schema. There are **76 sequences**.

Critical modelling facts a rebuilder must internalise:

- **Drizzle `schema.ts` is a PARTIAL view.** Many columns exist ONLY via raw boot migrations (`src/index.ts` + `src/migrations/`) and are invisible to Drizzle — a `db.select()` silently drops them. These must be read/written by raw `pg` SQL. Flagged below as **[raw]**. Examples confirmed in the live DB: `sale_payments.source`, `sales.other_charges`/`invoice_series`/`invoice_fy`/`invoice_serial`/`number_scope`/`legacy_invoice_number`/`import_batch_id`, `purchases.other_charges`/`price_mode`/`import_batch_id`, `receipts.source`/`advance_amount`/`advance_ledger_id`/`legacy_voucher_number`/`import_batch_id`, `payments.*` (same), `journal_vouchers.location_type`/`location_id`/`origin`/`source_module`/`legacy_voucher_number`, `employees.employment_status`/`last_working_date`/`salary_accrual_resume_from`, `warehouses.disabled_at`/`disabled_by`.
- **Declared FK constraints are sparse.** Most document→master links are **conventional (soft)**: enforced by application logic and boot-time healing sweeps, not the DB. E.g. `sale_payments` has NO FK to `sales` or to `receipts`. `receipts`/`payments` have NO FK to `account_ledgers` despite `*_ledger_id` columns. `journal_voucher_lines.ledger_id` has NO FK. Ledger identity is also carried as CODE STRINGS (`CUST-<id>`, `VEND-<id>`, `SAL-EMP-<id>`, `CBA-<id>`, `RENT-EXP-<wh>`, `VADV-<id>`, `STD-*`, `SYS-*`) rather than pure integer FKs.
- **`stock_entries` / `stock_batches` / `stock_ledger` / `stock_reservations` are polymorphic** by `material_type ∈ {item, material, raw_material}` (CHECK-constrained) with **overlapping `item_id` values across the three masters**. EVERY query MUST scope `material_type`. There is no FK — instead a **DB trigger `assert_stock_master_exists()`** fires `BEFORE INSERT OR UPDATE OF item_id, material_type, quantity` on both `stock_entries` and `stock_batches`. It does `PERFORM 1 FROM items/materials/raw_materials WHERE id = NEW.item_id FOR KEY SHARE` and raises `foreign_key_violation` ("stock write refused: … no longer exists") if the master is gone. The global error handler (`app.ts:118`) maps that message to **HTTP 409**. NOTE: this contradicts the audit's "no triggers" claim — there ARE 4 trigger rows (two tables × the guard). `stock_ledger` and `stock_reservations` have no such trigger.
- **Numbering is never `COUNT(*)`.** `voucher_sequences` (PK `voucher_type, fy_label`, col `last_number`) is the atomic allocator for every document series. Business SEQUENCES: `purchase_batch_seq`, `item_code_seq_item`, `item_code_seq_material`, `item_code_seq_raw_material`.
- **CHECK constraints** observed: `stock_entries.chk_stock_non_negative (quantity >= -0.001)`, material-type checks, `stock_reservations` kind/status/qty, `asset_purchases` payment_mode/status/status/qty, `asset_disposals.disposal_type`, `purchases.price_mode`, `opening_balances.balance_type`, `accounting_period_locks.month`.

### 29.2 ER overview grouped by domain

```
SALES DOMAIN
  customers ──(soft: customer_id)── sales ──1:N── sale_payments
     │                                │            (clearing_receipt_id → receipts, soft)
     │                                ├──1:N── sales_returns (FK sale_id) ── credit_note_id → journal_vouchers
     │                                ├──1:1── invoice_share_links (FK sale_id)
     │                                └──0:1── quotations (converted_sale_id, soft; quotation_id on sales unique)
  customers → ledger CUST-<id> (code string, no FK) under SYS-DEBTORS

PURCHASE DOMAIN
  vendors ──(FK vendor_id)── purchases ──1:N── purchase_returns (FK purchase_id) ── debit_note_id → JV
     │                          └──1:N── payment_bill_allocations (soft → payments)
     │                          └──1:N── purchase_advance_applications
  vendors → ledger VEND-<id> / advance VADV-<id> (code strings, no FK)

MONEY / ACCOUNTING DOMAIN
  account_ledgers (self-parent parent_id) ← receipts/payments/JV lines/opening_balances (ALL soft, no FK)
  journal_vouchers ──1:N (FK, ON DELETE CASCADE)── journal_voucher_lines
  receipts / payments  (source-provenance; advance_ledger_id, allocations)
  advance_consumptions  → pins consumed advance slices to receipt/payment & sale/purchase
  cash_bank_accounts (ledger_id → CBA-<id>) ; opening_balances ; accounting_period_locks + period_lock_events
  expenses (FK ledger_account_id → account_ledgers, FK payment_account_id → cash_bank_accounts)
  reconciliation_batches ──1:N── reconciliation_batch_items (→ sale_payments, unique)
  cash_deposits (till → bank, transit_payment_id / bank_receipt_id soft)

INVENTORY DOMAIN (all polymorphic by material_type)
  items / materials / raw_materials  ← [trigger guard] stock_entries, stock_batches
  stock_ledger (append-only)  ;  stock_reservations (hold / in_transit)
  stock_transfers (from/to type+id; sale_id/purchase_id for cross-GSTIN; dispatch/receive/credit_note voucher ids)
  stock_verifications ; item_prices (FK item_id) ; bom_templates (FK item_id, unique) ; productions (FK item_id)

LOCATION DOMAIN
  warehouses ──1:N (FK)── outlets ;  warehouse_rent_agreements/rent_accruals/rent_periods/rent_payments (warehouse_id)
  location_migration_map (old outlet → new warehouse)

HR DOMAIN
  hierarchies (self reports_to_id) ← employees (FK hierarchy_id) ← permissions (FK hierarchy_id, unique per module)
  employees ← attendance(FK)/attendance_punches(FK)/leaves(FK)/payroll(FK)/employee_advances(FK)/pay_components(FK 1:1)
  salary_accruals ; salary_accrual_config ; company_holidays

ASSETS DOMAIN
  assets (FK) ← asset_purchases (FK category_id → asset_categories) ← asset_transfers / asset_disposals (FK, CASCADE)

IMPORT / MIGRATION DOMAIN
  import_migrations ──1:N── import_batches ──1:N── import_rows ; import_mappings (name→master)

CONFIG / AUDIT / INFRA
  company_settings ; voucher_sequences ; coupons ; salary_accrual_config
  activity_log ; login_attempts ; login_lockouts ; migration_log ; boot_status
  invoice_share_links ; quotation_share_links
```

### 29.3 Table catalogue (important tables)

Legend: **PK** primary key · **FK** declared foreign key · **soft** conventional link (no DB constraint) · **[raw]** column ships via boot migration, invisible to Drizzle.

#### Sales

**`sales`** — POS/credit invoices. PK `id`. Soft links: `customer_id`, `outlet_id`, `location_id`, `branch_transfer_id`, `quotation_id`, `import_batch_id`. Referenced by `invoice_share_links` (FK) and `sales_returns` (FK).
Key cols: `invoice_number` (unique via partial indexes), `line_items` jsonb (GIN indexed), `subtotal`, `tax_total`, `discount_total`, `bill_discount`, `total_amount` (INCLUDES other_charges — see §7), `payment_mode`, `payment_status`, `amount_paid`, `location_type`/`location_id` (stamp), `party_name`/`party_gstin`/`party_state`, `cancelled_at`. **[raw]** `quotation_number`, `legacy_invoice_number`, `import_batch_id`, `number_scope`, `invoice_series` (SB2B/SB2C), `invoice_fy`, `invoice_serial`, `other_charges` jsonb `[{ledgerId, amount}]`.
Notable indexes: `uq_sales_scope_invoice_number(number_scope, invoice_number)`, `uq_sales_scope_series_fy_serial(number_scope, invoice_series, invoice_fy, invoice_serial)`, `sales_quotation_uq`, `idx_sales_branch_transfer_invoice_uq`, GIN on `line_items` — 18 indexes total.

**`sale_payments`** — collection/settlement history per sale. PK `id`. **NO FK at all** (soft `sale_id`, soft `clearing_receipt_id → receipts`, soft `outlet_id`). Cols: `payment_date`, `method`, `amount`, `reference_number`, `reconciliation_status`, `matched_reference`/`matched_by`/`matched_at`. **[raw]** `source` (e.g. `counter`, allocation legs; shipped by `sale_payment_legs_backfill_v2`), `created_by`. Related: `reconciliation_batch_items` (unique per `sale_payment_id`).

**`sales_returns`** — FK `sale_id → sales`. Cols: `return_number`, `line_items`, `subtotal`/`tax_total`/`total_amount`, `refund_mode` (default `credit_note`), soft `credit_note_id → journal_vouchers`, soft `refund_payment_id`, `location_type`/`location_id`.

#### Money vouchers

**`receipts`** — receipt vouchers (money IN). PK `id`. **NO FK** — `received_from_ledger_id`/`received_in_ledger_id` are soft → `account_ledgers`. Cols: `voucher_number`, `receipt_date`, `amount`, `narration`, `location_type`/`location_id` (default headoffice/0), `payment_mode` **[legacy, write-ignored Aug 2026]**, `reference_number`, `attachment_url` **[legacy]**, `created_by`. **[raw]** `source` (`sale`, `allocation`, manual…), `advance_amount`, `advance_ledger_id`, `import_batch_id`, `legacy_voucher_number`.

**`payments`** — payment vouchers (money OUT). PK `id`. **NO FK** — `paid_from_ledger_id`/`paid_to_ledger_id` soft. Cols mirror receipts plus `expense_category`, `is_location_expense` bool, `notes`. **[raw]** `source`, `advance_amount`, `advance_ledger_id`, `import_batch_id`, `legacy_voucher_number`.

**`advance_consumptions`** — pins every consumed advance slice. PK `id`. Cols: `party_kind`, `party_id`, `source_receipt_id`/`source_payment_id`, `consumer_sale_id`/`consumer_purchase_id`, `amount`. All soft links.

**`payment_bill_allocations`** — vendor bill-wise settlement. PK `id`. `payment_id`, `purchase_id`, `amount` (soft links).
**`purchase_advance_applications`** — `purchase_id`, `vendor_id`, `amount` (soft).

#### Purchases

**`purchases`** — PK `id`. **FK `vendor_id → vendors`** (the one real party FK). Cols: `invoice_number`, `line_items` jsonb, `total_amount` (GOODS ONLY — vendor owed = goods + other_charges), `tax_total`, `discount_total`, `round_off`, `location_type`/`location_id` (default headoffice/1), `branch_type`/`branch_id` (legacy dupes), `party_*`, `cancelled_at`. **[raw]** `price_mode` (`exclusive`/`inclusive`, CHECK), `import_batch_id`, `other_charges` jsonb. Unique `uniq_purchases_vendor_invoice (vendor_id, btrim(invoice_number))` partial (per-vendor invoice uniqueness). Referenced by `purchase_returns` (FK).

**`purchase_returns`** — FK `purchase_id → purchases`. Cols like sales_returns; soft `debit_note_id → journal_vouchers`.

#### Customers / Vendors

**`customers`** — PK `id`. Cols: `name`, `phone`, `email`, `address`, `gst_number`, `state`, `pan`, `credit_limit`, `credit_days`, `total_purchases` (denorm), `location_type`/`location_id`, `notes`, **[raw]** `import_batch_id`. Ledger `CUST-<id>` provisioned in chart (code string). No FK inbound except soft.

**`vendors`** — PK `id`. Similar plus `bank_name`/`account_number`. Ledger `VEND-<id>` + advance `VADV-<id>`. Referenced by `purchases` FK.

#### Chart of accounts / ledgers

**`account_ledgers`** — PK `id`. Self-referential `parent_id` (no FK declared). Cols: `name`, `type` (asset/liability/income/expense/equity), `code` (`SYS-*` roots, `STD-*` containers, `CUST-`/`VEND-`/`VADV-`/`CBA-`/`SAL-EMP-`/`SAL-PAY-`/`ADV-EMP-`/`RENT-EXP-`/`RENT-PAY-`/`STD-BRANCH-*` etc.), `section` (balance_sheet/profit_and_loss), `is_system_group`, `is_group`, `is_active`, `bank_details` jsonb, `location_type`/`location_id`, **[raw]** `import_batch_id`. Referenced by `expenses` FK (only). All voucher/JV ledger links are soft (by id or code).

**`journal_vouchers`** — PK `id`. Cols: `voucher_type` (`journal`/`contra`/`credit_note`/`debit_note`/…), `voucher_number`, `voucher_date`, `narration`, `party_ledger_id` (soft), `reason`, `total_amount`, `created_by`, `origin`, `source_module` (provenance for edit-locking). **[raw]** `location_type`/`location_id` (location-aware JVs — Aug 2026), `legacy_voucher_number`, `import_batch_id`. Referenced by `journal_voucher_lines` (FK **ON DELETE CASCADE**).
**`journal_voucher_lines`** — FK `voucher_id → journal_vouchers` CASCADE. Cols `ledger_id` (soft, no FK — flagged in audit as an FK candidate), `debit`, `credit`.

**`opening_balances`** — PK `id`. `ledger_id` (soft), `balance`, `balance_type` (CHECK debit/credit), `as_of_date`, `financial_year`, unique `(ledger_id, financial_year)`. **[raw]** `import_batch_id`. Folded into books outside the posting stream.

**`cash_bank_accounts`** — PK `id`. Each backed by ledger `CBA-<id>` (soft `ledger_id`). `account_type` (cash/bank), `bank_name`, `account_number`, `ifsc_code`, `balance` (DEAD column — balances derived from postings), `location_type`/`location_id`, `requires_reconciliation`. Referenced by `expenses` FK.

**`accounting_period_locks`** — PK `(year, month)`; only locked months present. **`period_lock_events`** — lock/unlock audit (action, username, reason).

#### Inventory

**`stock_entries`** — authoritative on-hand. PK `id`. Unique `(item_id, material_type, branch_type, branch_id)`. Cols `quantity`, `cost_price`, `material_type`. CHECK non-negative + material-type. **Trigger** `assert_stock_master_exists`.

**`stock_batches`** — additive lot layer. PK `id`. Natural key v2 `(item_id, material_type, branch_type, branch_id, batch_number)`. Cols `batch_number` (`PUR-YYYYMMDD-NNNNN` / `PRD/…`), `mfg_date`, `expiry_date`, `quantity`, `unit_cost`, `mrp`, `barcode`, `source`/`source_id`, `material_type`. Trigger guard as above.

**`stock_ledger`** — append-only audit. PK `id` (bigint). Cols `txn_type`, `material_type`, `ref_id`, `item_name`, `unit`, `branch_type`/`branch_id`/`branch_name` (denormalised), `qty_change`, `unit_cost`, `doc_type`, `doc_id`, `txn_date` (business date; Closing(D)=Opening(D+1)). No trigger.

**`stock_reservations`** — PK `id`. `kind ∈ {hold, in_transit}` (CHECK), `status ∈ {active, released}`, `material_type`, `ref_id`, `batch_id`/`batch_number`, `quantity` (>0 CHECK), `doc_type`/`doc_id`.

**`stock_transfers`** — PK `id`. `from_type/from_id`, `to_type/to_id`, `challan_number`, `line_items`, `received_line_items`, `status` (`in_transit`/…), `is_interstate`, `transfer_type`, `from_gstin`/`to_gstin`, `tax_type`, `transfer_value`/`gst_amount`, `dispatch_voucher_id`/`receive_voucher_id`/`credit_note_voucher_id` (soft → JV), `sale_id`/`purchase_id` (soft, for cross-GSTIN twins), `document_mode`, `transfer_invoice_number`.

**`stock_verifications`** — PK `id`. `branch_type`/`branch_id`, `verify_date`, `lines` jsonb, **[raw]** `import_batch_id`.

**`item_prices`** — FK `item_id → items`. `outlet_id`, `location_type`, `price`, `valid_from`/`valid_to`.
**`bom_templates`** — FK `item_id → items`, unique per item. `lines` jsonb.
**`productions`** — FK `item_id → items`. `produced_quantity`, `material_used` jsonb, `batch_number`, `mfg_date`/`expiry_date`, cost split (`material_cost`/`overhead_*`/`rm_cost`/`pm_cost`/`labour_cost`/`labour_method`/`total_cost`/`cost_per_unit`), `wastage`/`wastage_qty`/`wastage_value`, `location_type`/`location_id`.

#### Masters — products

**`items`** (finished goods), **`materials`** (packing), **`raw_materials`**. Each PK `id`; unique `name`, partial-unique `item_code` and `barcode`. Cols: `hsn_code`, `tax_rate`, `unit`, `mrp`, `cost`, `avg_cost` (weighted), `status` (active/inactive). `items` additionally `production_stock`, `reorder_level`, **[raw]** `import_batch_id`. Referenced by `stock_*` (via trigger, no FK), `bom_templates`/`item_prices`/`productions` (FK on `items` only).

#### Locations

**`warehouses`** — PK `id`. `state`, `gst_number`, `state_code`, address/bank/UPI/FSSAI fields, `cash_ledger_id`/`sales_ledger_id`/`purchase_ledger_id` (soft), `invoice_footer`, `authorized_signatory`, **[raw]** `disabled_at`/`disabled_by`. Referenced by `outlets` FK.
**`outlets`** — FK `warehouse_id → warehouses`. `cash_ledger_id`/`sales_ledger_id`, `gstin`, `state`/`state_code`, `upi_id`. (Mirror locations: an outlet + warehouse at the same place share one cash ledger.)
**`location_migration_map`** — old outlet→new warehouse mapping, unique `(old_type, old_id)`.

#### Rent

**`warehouse_rent_agreements`** — unique `warehouse_id`. `monthly_rent`, `security_deposit`, landlord fields, `due_day`, `status`, `expense_ledger_id`/`payable_ledger_id` (soft, `RENT-EXP-<wh>`/`RENT-PAY-<wh>`).
**`rent_accruals`** — unique `(warehouse_id, accrual_date)`, `amount`, `monthly_rent`, `days_in_month`.
**`rent_periods`** — unique `(warehouse_id, year, month)`, `status` (pending/approved).
**`rent_payments`** — `payment_mode`, `voucher_id` (soft → JV).

#### Payroll / HR

**`employees`** — PK `id`. `username` (norm-unique), `password_hash`, `hierarchy_id` FK, `branch_type`/`branch_id`, `salary`, `join_date`, `is_active`, `must_change_password`, jsonb `education`/`work_experience`/`emergency_contact`, `is_production_staff`, `ui_location_pref`. **[raw]** `salary_accrual_resume_from`, `employment_status` (active/resigned/terminated/inactive — truth; `is_active` derived), `last_working_date`.
**`attendance`** — FK `employee_id`; unique `(employee_id, date)`; `check_in`/`check_out` + geo; `status`; `leave_type`.
**`attendance_punches`** — FK `employee_id`; multi-punch `punch_in`/`punch_out` + geo (paid on total closed-session hours).
**`leaves`** — FK `employee_id`; `from_date`/`to_date`, `leave_type`, `status`, `approved_by`/`approved_at`/`cancelled_at`.
**`payroll`** — FK `employee_id`; index `(employee_id, year, month)`. Extensive cols incl. `status` (draft/approved/paid), `working_days`, `present_days`, `lop_days`/`lop_deduction`, `gross_pay`/`net_pay`, `allowances_breakdown`/`deductions_breakdown` jsonb, statutory `pf_*`/`esi_*` + `statutory_snapshot` jsonb, `advance_ids` jsonb, `advance_deduction`, `paid_leave_used`/`allowed`, `sick_leave_used`/`allowed`, `pay_period_label`.
**`employee_advances`** — FK `employee_id`; `amount`, `date`, `is_deducted`, `deducted_payroll_id` (soft).
**`pay_components`** — FK `employee_id` unique 1:1; `working_days_per_month`, `allowances`/`deductions` jsonb.
**`salary_accruals`** — unique `(employee_id, accrual_date)`; `amount`, `monthly_salary`, `days_in_month`, `attendance_factor`, `working_days`, `attendance_basis`.
**`salary_accrual_config`** — single row, `attendance_from` (cutover date).
**`company_holidays`** — unique `holiday_date`.

#### Permissions / hierarchy

**`hierarchies`** — PK `id`; self `reports_to_id` (soft), `level` (derived). **`permissions`** — FK `hierarchy_id`; unique `(hierarchy_id, module)`; five real actions `can_view/add/edit/delete/download` + legacy mirrors `can_print/approve/share`; `module` = `page:<href>`. Default-deny (missing row = no access). Level-1 = full-access bypass.

#### Assets

**`assets`** (master) — FK inbound from `asset_purchases`. **`asset_categories`** — unique lower(name); FK inbound. **`asset_purchases`** — FK `asset_id` (RESTRICT) + FK `category_id` (RESTRICT); the register entry itself; `acquisition_cost`/`gst_*`/`total_cost` (capitalised incl. GST), `location_type`/`location_id`, `current_location_*`, `status`, warranty/serial/tag, `journal_voucher_id` (soft), partial-unique `asset_code`. **`asset_transfers`** / **`asset_disposals`** — FK `asset_purchase_id → asset_purchases` **ON DELETE CASCADE**; disposal type CHECK.

#### Reconciliation / deposits

**`reconciliation_batches`** — `batch_reference`, `settlement_date`, `gross_amount`/`charges`/`net_amount`, `destination_bank_ledger_id` (soft), `status`. **`reconciliation_batch_items`** — `batch_id`, `sale_payment_id` (unique — one payment per batch), `amount`.
**`cash_deposits`** — till→bank movements; `source_cash_ledger_id`, `destination_bank_ledger_id`, `status` (`pending_reconciliation`…), `transit_payment_id`/`bank_receipt_id` (soft), `warehouse_id`/`outlet_id`.

#### Quotations

**`quotations`** — PK `id`; unique `quotation_number`; partial-unique `converted_sale_id`; `status` (draft/…), `line_items`, totals, `valid_till`, `place_of_supply`, `converted_sale_id`/`converted_invoice_number`. **`quotation_share_links`** — HMAC public link, one active per quotation. **`invoice_share_links`** — FK `sale_id`/`created_by`/`revoked_by`; `public_id`+`token`, one active per sale.

#### Config / audit / infra

**`company_settings`** — single row, ~50 cols incl. `invoice_prefix`/`invoice_sequence`, `fy_start_month`, `voucher_prefixes` jsonb, `production_overhead_percent`, password policy, `general_settings` jsonb (payroll working-days/leave policy, feature flags), GST/UPI/bank display flags, `gst_transfer_invoicing`, `branch_transfer_prefix`/`sequence`, PF/ESI defaults, `quotation_sequence`. **`coupons`** — unique `code`, `discount_type`/`value`, `usage_count`. **`voucher_sequences`** — the allocator (see §29.1). **`activity_log`** — `type`/`description`/`user`/`action`/`module`/`entity_type`/`entity_id`/`metadata` jsonb, index on `created_at DESC`. **`login_attempts`** / **`login_lockouts`** (PK `username`, `failure_count`, `locked_until`). **`migration_log`** (PK `name`, `applied_at`) — one-shot guard registry (58 rows live). **`boot_status`** — per-boot outcome (see §31). **`import_migrations`** → **`import_batches`** → **`import_rows`** (batch/row state, raw+normalized payloads, created-record links for rollback); **`import_mappings`** (name→master, unique `(kind, source_norm)`).

**Business rules (implemented):**
- The live schema (74 public tables + `backup_meta`) is authoritative; `schema.ts` and the audit's table counts are partial/stale (`psql \dt`).
- Polymorphic stock tables MUST be scoped by `material_type`; master existence is enforced by the `assert_stock_master_exists` trigger (FOR KEY SHARE), surfaced as HTTP 409 (`app.ts:118`).
- `sale_payments`, `receipts`, `payments`, `journal_voucher_lines` ledger links carry NO FK — integrity is application-level + boot healing sweeps + code-string ledger identity.
- Document numbering is allocated atomically from `voucher_sequences` (upsert `last_number+1`) and product codes from dedicated sequences — never `COUNT(*)`.
- Non-negative stock enforced by DB CHECK (`>= -0.001`); balance stored on `cash_bank_accounts`/`sales.total_purchases` are denormalised/dead — figures derive from the posting stream.

---

## 30. APIs — router-by-router endpoint map

All endpoints are mounted under `/api` by `src/routes/index.ts` (37 route files). Global middleware chain (`src/app.ts`): pino-http → CORS → raw body for `/api/imports/parse` (10 MB) → JSON/urlencoded body (1 MB) → **global `requireAuth`** (HMAC v2 bearer) → per-route RBAC (`requireModuleView`/`requireModuleAction`) + LBAC → route → global JSON error handler.

**Auth exceptions (bypass `requireAuth`, `app.ts:71-91`):** exact `/health`, `/healthz`, `GET /healthz/schema`, `POST /auth/login`, and GET-only prefixes `/public/invoices/`, `/public/quotations/`, `/share/invoice/`, `/share/quotation/` (each secured by its own HMAC token / share-link row).

**Permission guard key** = `page:<sidebar-href>` string passed to `requireModuleView(keys)` (reads, → 403) or `requireModuleAction(key, action)` (writes, action ∈ view/add/edit/delete/download). Order: requireAuth → RBAC (403) → LBAC (404) → business logic. A read guard may accept an ARRAY of page keys (any-of).

**OpenAPI / write-gating note:** there is NO runtime OpenAPI validator in the server; bodies are Zod-parsed and Zod **strips unknown keys** (no `.passthrough()`/`.strict()` found). The write-gating is at the CLIENT layer: `lib/api-spec/openapi.yaml` → Orval → `lib/api-client-react` hooks only ever SEND fields declared in the spec. So **a field absent from the spec is silently dropped before it reaches the server** — keep spec + codegen in lockstep or writes vanish without error.

**List-vs-detail casing inconsistency (confirmed):** list endpoints return raw DB rows in **snake_case** (`GET /sales` does `SELECT s.*` → rows carry `invoice_number`, `location_type`, …, `sales.ts:~470`), while the detail endpoint maps to **camelCase** (`GET /sales/:id` returns `{ invoiceNumber, … }`, `sales.ts:~2340`). Consumers must handle both shapes.

Below, "Acct?" = does the endpoint write postings/derive accounting effect (Y) or not (N). "Writes" lists primary tables mutated.

### 30.1 auth.ts
| Method | Path | Purpose | Auth | Guard | Writes | Acct? |
|---|---|---|---|---|---|---|
| POST | /auth/login | Issue v2 bearer (8 h), rate-limited | public | — | login_attempts, login_lockouts | N |
| POST | /auth/logout | Client-side token drop | bearer | — | — | N |
| POST | /auth/change-password | Forced/self password change | bearer | — | employees | N |
| GET | /auth/me | Current identity + perms | bearer | — | — | N |
| PUT | /auth/location-pref | Save UI location pref | bearer | — | employees | N |
| PATCH | /auth/profile | Self profile edit | bearer | — | employees | N |

### 30.2 health.ts
| GET | /healthz · /healthz/schema | Liveness / live column types | public | — | — | N |

### 30.3 dashboard.ts (all GET, guard `page:/`)
`/dashboard/summary`, `/stock-alerts`, `/recent-activity`, `/sales-trend`, `/top-items`, `/sales-by-location`, `/bi`, `/production-trend`. Read-only; figures derive from scoped SQL + `buildBooks`. Hidden money figures OMITTED (not zeroed) for branch logins. Acct? N (reads).

### 30.4 inventory.ts (masters; HO-only writes)
| Method | Path | Purpose | Guard (page:) | Writes | Acct? |
|---|---|---|---|---|---|
| GET/POST/GET/PATCH/DELETE | /materials[/:id] | Material master CRUD | /headoffice/materials | materials, stock_* | N |
| …same | /raw-materials[/:id] | Raw material CRUD | /headoffice/raw-materials | raw_materials | N |
| …same | /items[/:id] | Item CRUD (opening stock on create) | /headoffice/items | items, stock_entries/batches/ledger | N* |
| GET/POST/GET/PATCH/DELETE | /assets[/:id] | Asset MASTER CRUD | /assets/register | assets | N |
Note: item create seeds opening stock (batch + ledger). DELETE guarded (row locked FOR UPDATE, stock re-checked → 409). **Bug B1:** `GET /assets/:id` with non-numeric id → 500 NaN (inventory.ts:~428). `assetsRouter` is mounted BEFORE `inventoryRouter` so `/assets/categories|purchases|summary` resolve to assets.ts, not this `/assets/:id`.

### 30.5 assets.ts
| Method | Path | Purpose | Guard | Writes | Acct? |
|---|---|---|---|---|---|
| GET/POST/PATCH | /assets/categories[/:id] | Categories | /assets/categories | asset_categories | N |
| GET/POST/PATCH/DELETE | /assets/purchases[/:id] | Asset purchase (register + JV) | /assets/purchases | asset_purchases, journal_vouchers(+lines) | **Y** |
| GET/POST | /assets/transfers | Move between locations | /assets/transfers | asset_transfers, asset_purchases | N |
| GET/POST | /assets/disposals | Dispose/scrap/write-off | /assets/disposals | asset_disposals, asset_purchases | Y (on sale) |
| GET | /assets/summary | Register summary | /assets/register | — | N |
Asset purchase capitalised INCLUDING GST (no ITC); no depreciation postings.

### 30.6 branches.ts (warehouses/outlets; HO-only)
| Method | Path | Purpose | Guard | Writes | Acct? |
|---|---|---|---|---|---|
| GET/POST/GET/PATCH/DELETE | /warehouses[/:id] | Warehouse CRUD | /headoffice/warehouses | warehouses, account_ledgers | N |
| POST | /warehouses/:id/disable · /enable | Wind-down toggle | same | warehouses (disabled_at/by) | N |
| GET | /warehouses/:id/delete-summary | Pre-delete count | same | — | N |
| DELETE | /warehouses/:id/permanent | Super-admin cascade delete (advisory-locked, in-txn validation) | level-1 | cascades all warehouse-stamped tables | Y (unwinds) |
| GET/POST/GET/PATCH/DELETE | /outlets[/:id] | Outlet CRUD | /headoffice/outlets | outlets, account_ledgers | N |

### 30.7 purchases.ts
| Method | Path | Purpose | Guard | Writes | Acct? |
|---|---|---|---|---|---|
| GET | /purchases | List | /production/purchases | — | N |
| POST | /purchases | Create bill (stock in, FEFO cost, settlement, other_charges) | add | purchases, stock_*, sale/vendor ledgers via derivation, payments (settle), payment_bill_allocations, purchase_advance_applications, advance_consumptions | **Y** |
| GET | /purchases/:id | Detail | view | — | N |
| PATCH | /purchases/:id | Edit (refused once goods moved; charges-only PATCH allowed) | edit | purchases, stock_* | Y |
| DELETE | /purchases/:id | Delete (refused with allocations → BILL_HAS_ALLOCATIONS) | delete | purchases, stock_* | Y (reverse) |

### 30.8 production.ts
`GET/POST /productions`, `GET /productions/:id`, `DELETE /productions/:id` (guard `page:/production/batches`). POST consumes materials FEFO, credits output at absorption cost → `STD-FG-INV`/`STD-PROD-ABS` (excluded from P&L). DELETE reverses stock + avg cost. Acct? **Y** (capitalisation overlay).

### 30.9 stock.ts
| Method | Path | Purpose | Guard | Writes | Acct? |
|---|---|---|---|---|---|
| GET | /stock · /stock/ledger | On-hand / append-only ledger | /stock/branch, /stock/ledger | — | N |
| GET/POST | /stock/transfers | List / create two-step transfer (dispatch deducts + in_transit) | /stock/transfer | stock_transfers, stock_*, reservations, JV (or sale+purchase cross-GSTIN) | **Y** |
| PATCH | /stock/transfers/:id/approve · /reject | Receive/credit dest, or reject | approve/edit | stock_*, reservations, JV | Y |
| GET | /stock/transfers/:id | Detail | view | — | N |

### 30.10 inventory-batches.ts (guard `page:/stock/*`, reports)
`GET /stock/batches`, `/batches/suggest`, `/expiry-report`, `/valuation`, `/movement-analysis`, `/reorder-report`; `POST /stock/verifications` (writes stock_verifications + adjustment stock_ledger rows), `GET /stock/verifications[/:id]`. Verification Acct? N (physical adjustment, no postings — stock only).

### 30.11 sales.ts
| Method | Path | Purpose | Guard | Writes | Acct? |
|---|---|---|---|---|---|
| GET/POST | /item-prices | Outlet prices | /headoffice/item-price, /sales/pos | item_prices | N |
| GET | /sales | List (snake_case rows) | /sales/pos, /returns, / | — | N |
| POST | /sales | Create invoice (FEFO consume, settlement, other_charges, useAdvance, MRP floor) | add | sales, stock_*, sale_payments, advance_consumptions | **Y** |
| PUT | /sales/:id | Edit (preserves location; transfer invoices 409) | edit | sales, stock_* | Y |
| POST | /sales/:id/cancel | Terminal cancel (real payments block; advance-only unwound) | delete | sales(cancelled_at), stock_* restore | Y (reverse) |
| GET | /sales/summary | KPI summary | /sales/pos, / | — | N |
| POST | /sales/:id/share-token | Short-lived in-session token | share/edit | — | N |
| GET | /sales/:id/invoice.pdf | Server PDF | view | — | N |
| GET | /sales/:id | Detail (camelCase) | view | — | N |

### 30.12 payments.ts — sale collection payments
Router file `payments.ts` (NOT vendor payments). Two endpoints:
| Method | Path | Purpose | Guard (page:) | Writes | Acct? |
|---|---|---|---|---|---|
| GET | /sales/:id/payments | Collection history for a sale | /sales/pos | — | N |
| POST | /sales/:id/payments | Record a collection against a credit sale | /sales/pos, /outstanding, /customers (add) | sale_payments, receipts (clearing), sales.amount_paid/status | **Y** |
(The vendor quick-payment `POST /vendors/:id/payment` lives in customers.ts §30.15.)

### 30.13 accounts.ts (largest money router)
| Method | Path | Purpose | Guard | Writes | Acct? |
|---|---|---|---|---|---|
| GET | /accounts/chart[/flat] | Chart tree/flat | /accounts/chart | — | N |
| GET | /accounts/cash-bank-ledgers | Cash/bank leaves | /accounts/cash-bank | — | N |
| POST/PATCH/PATCH/DELETE | /accounts/chart[/:id][/move] | Ledger CRUD (code never client-writable; CBA/OB-ADJ refused) | add/edit/delete | account_ledgers | N |
| GET/POST/PATCH/DELETE | /accounts/payments[/:id] | Payment vouchers (allocations, advance, location-aware) | /operations/payment-voucher, /accounts/vouchers | payments, payment_bill_allocations, purchase_advance_applications, advance_consumptions | **Y** |
| GET/POST/PATCH/DELETE | /accounts/receipts[/:id] | Receipt vouchers | /operations/receipt-voucher, /accounts/vouchers | receipts, sale_payments, advance_consumptions | **Y** |
| GET | /accounts/receipts/:id/delete-impact | Warning dialog data | view | — | N |
| POST | /accounts/receipts/:id/system-delete | Level-1 delete of source='sale' receipt (reason, audited) | level-1 | receipts, sale_payments, sales | Y |
| GET | /accounts/ledger-statement · /ledger/:id/statement | Running balance | /accounts/ledger-statement | — | N |
| GET/POST/PATCH/DELETE | /accounts/cash-bank[/:id] | cash_bank_accounts CRUD (+CBA ledger) | /accounts/cash-bank | cash_bank_accounts, account_ledgers | N |
| GET/POST | /expenses | Expense CRUD | /operations/expenses | expenses, JV derivation | **Y** |
| GET | /expenses/categories · /accounts/expense-ledgers | Pickers | view | — | N |
| GET/POST/DELETE | /accounts/location-expenses[/:id] | Branch expense voucher path | /operations/expenses | payments (is_location_expense) | Y |
| GET | /accounts/location-expenses/summary · /all | Rollups | view | — | N |
| GET | /accounts/financial-statements | TB/P&L/BS bundle | /accounts/financial | — | N |
| GET | /gst/summary | GST summary (also in gst.ts) | /accounts/gst | — | N |
| GET/POST/DELETE | /accounts/opening-balances[/:id] | Openings (refuses CBA-/STD-OB-ADJ) | /accounts/opening-balances | opening_balances | N |
| GET | /accounts/settlement-context · /party-advance | Bill-wise settlement forms | view | — | N |

### 30.14 journal.ts
`GET/POST /accounts/vouchers` (journal/contra), `PATCH`/`DELETE`, plus `GET /accounts/voucher-locations`, credit/debit notes. Location-aware (mandatory HO/warehouse/outlet stamp; `checkLinesLocation`; branch users scoped, foreign ids 404). System vouchers edit-locked by provenance. Writes `journal_vouchers`+`journal_voucher_lines`. Acct? **Y**. (`buildDerivedPostings()` lives here — the single derivation authority.)

### 30.15 customers.ts
| Method | Path | Purpose | Guard | Writes | Acct? |
|---|---|---|---|---|---|
| GET/POST/GET/PATCH/DELETE | /customers[/:id] | Customer CRUD (auto CUST- ledger; delete removes ledger) | /operations/customers | customers, account_ledgers | N |
| GET/POST/GET/PATCH/DELETE | /vendors[/:id] | Vendor CRUD (auto VEND-/VADV-) | /production/vendors | vendors, account_ledgers | N |
| GET | /customers/:id/ledger · /vendors/:id/ledger | Party statement | view | — | N |
| POST | /vendors/:id/payment | Quick vendor payment | add | payments, allocations | **Y** |
| GET/POST/PATCH | /coupons[/:id] | Coupon CRUD | /sales/coupons | coupons | N |

### 30.16 returns.ts
| Method | Path | Purpose | Guard | Writes | Acct? |
|---|---|---|---|---|---|
| POST/GET/PATCH | /sales-returns[/:id] | Sales return (restore batches; credit note) | /returns | sales_returns, stock_*, JV (credit_note) | **Y** |
| POST/GET/PATCH | /purchase-returns[/:id] | Purchase return (debit note) | /returns | purchase_returns, stock_*, JV (debit_note) | Y |
| GET | /outstanding/receivables · /payables · /collections | Ageing (owning-module calc) | /sales/outstanding | — | N |
Returns NEVER refund other_charges (both sides).

### 30.17 gst.ts (all GET, guard `page:/accounts/gst`)
`/gst/hsn-summary`, `/gstr1`, `/gstr3b`, `/gst/reconciliation`, `/gst/filters`, `/gst/documents`. Read-only. Known gap #54: credit/debit notes not yet reducing returns.

### 30.18 reports.ts / financialReports.ts (all GET)
reports.ts: `/reports/sales-register`, `/sales-by-item`, `/sales-by-location`, `/discounts`, `/purchase-register`, `/purchases-by-vendor`, `/purchases-by-material`, `/profitability`, `/sales-stock-combined`, `/gst-transfers`, `/branch-transfers`.
financialReports.ts (`/reports/fin/*`): `ledgers`, `ledger-statement`, `ledger-options`, `trial-balance`, `cash`, `bank`, `gst`, `expenses`, `salary`, `day-book`. All read `buildBooks`/posting stream. Acct? N.

### 30.19 hr.ts (guard `page:/hr/*`)
Hierarchies CRUD; employees CRUD + reset-password; pay-components; payroll (`generate`/`:id`/`approve`/`pay` — postings **Y**: Dr SAL-EMP / Cr SAL-PAY, statutory true-up); salary-accruals (read); advances (`POST`, `:id/recover` — Y); attendance (`check-in`/`check-out`/`config`/PUT), holidays, leaves (`approve`/`cancel`), leave-balance. Payroll approve/pay = accounting; attendance/leave = stock-of-days only.

### 30.20 rent.ts
`GET/PATCH /rent/agreements[/:warehouseId]`, `GET /rent/accruals`, `POST /rent/accrue`, `GET /rent/periods`, `POST /rent/periods/:wh/:y/:m/approve`, `.../pay` (voucher → **Y**), `GET /rent/payments`, `/rent/dashboard`, `/rent/ledger-postings`. Daily accrual Dr RENT-EXP / Cr RENT-PAY.

### 30.21 reconciliation.ts
`GET /reconciliation/bank-ledgers`, `POST` (batch), `GET /pending`, `/batches[/:id]`, `POST /batches`, `GET /reconciled`, `POST /:id/match`, `/:id/unmatch`. Stamps `sale_payments.reconciliation_status`/`matched_*`; writes `reconciliation_batches`/`_items`. Acct? Y where a settlement voucher/bank leg is written.

### 30.22 cash-in-outlet.ts
`GET /cash-in-outlet`, `/deposits`, `POST /deposits`, `POST /deposits/:id/reconcile`. Till→bank transit (payment + bank receipt). Acct? **Y**.

### 30.23 quotations.ts / share links / public
quotations.ts: `GET/POST /quotations`, `GET/PUT /quotations/:id`, `POST /:id/status`, `DELETE /:id`, `GET /:id/stock-check`, `POST /:id/share-token`. Touches NO stock/books (Acct? N). `quotationShareLinks.ts`: create/revoke + public `GET /share/quotation/:publicId[/pdf]`. `publicQuotations.ts`: `GET /public/quotations/:token`. `invoiceShareLinks.ts` + `publicInvoices.ts`: same pattern for invoices (`/share/invoice/...`, `/public/invoices/:token`).

### 30.24 imports.ts (Import Data + Migration Wizard)
Batch path: `GET /imports/templates/:module`, `POST /imports/parse` (raw upload), `GET/POST /imports/batches/:id/mappings`, `GET /imports/mappings`, `/mapping-candidates`, `PUT/DELETE /imports/mappings/:id`, `GET /imports/batches[/:id][/error-file]`, `POST /imports/batches/:id/demo|approve|discard|commit|rollback`, `GET /imports/batches/:id/demo-report`. Migration path: `POST/GET /imports/migrations`, `GET /:id`, add-file (POST), `DELETE /:id/files/:module`, `GET/POST /:id/mappings`, `POST /:id/demo|approve|discard|rollback`, `GET /:id/demo-report`. Commit routes through `importTransactions.ts`/`importVouchers.ts` (identical logic to POST /sales & /purchases). Acct? **Y** on commit/rollback.

### 30.25 company.ts / audit.ts / periods.ts / backup.ts / storage.ts / bom.ts / search.ts
- company.ts: `GET/PATCH /company/settings`, `GET /company/login-history`, `GET/POST /company/permissions`, `GET /company/permissions/rbac-audit`, `POST /company/reset` (factory reset), `POST /company/clear-transactions`. Reset/clear = destructive (level-1). Acct? Y (wipes).
- audit.ts: `GET /audit/logs[/:id]` (activity_log). N.
- periods.ts: month lock/unlock (admin) → `accounting_period_locks`, `period_lock_events`; writes in a locked month refused HTTP **423 MONTH_LOCKED**.
- backup.ts: dashboard/list/history/create/download/delete/validate/verify/settings — pg_dump to GCS; restore needs HO + approve right + password re-verify.
- storage.ts: `POST /storage/uploads/request-url` (presigned PUT), `GET /storage/objects/*path` (ACL = uploader or record visibility, 404 not 403).
- bom.ts: `GET /bom-templates[/item/:itemId]`, `POST`, `PUT/:id`, `DELETE/:id`.
- search.ts: `GET /search` global.

**Business rules (implemented):**
- Global bearer auth on every `/api` route except the exact/prefix exceptions in `app.ts`; each route additionally gated by `page:<href>` RBAC (403) then LBAC (404).
- Server strips unknown body keys (Zod default); the generated client only sends spec-declared fields — the effective write contract is the OpenAPI spec, enforced client-side.
- List endpoints return raw snake_case rows; detail endpoints return camelCase — a real, code-confirmed inconsistency (e.g. `GET /sales` vs `GET /sales/:id`).
- Writes into a locked accounting month are refused with 423; hidden money figures are omitted (not zeroed) for branch logins.
- Creates return 201; wholesale lists are intentionally un-paginated (opt-in paging on some).

---

## 31. Background Jobs

### 31.1 Is there a cron scheduler? — PARTIALLY. No OS cron / node-cron / queue; three in-process `setInterval` timers exist.
A search for `node-cron`, `bull`/`bullmq`, `agenda`, `worker_threads`, `new Worker`, external `schedule(` returned **NOT FOUND**. The audit's flat "no cron scheduler" is imprecise: there are **three in-process interval timers**, all `unref()`'d so they never hold the process open, all started at the very end of boot in `src/index.ts`:

1. **Salary accrual** — `startSalaryAccrualScheduler(pool)` (index.ts:3972; `lib/salaryAccrual.ts:798`). Runs `runSalaryAccrual` immediately, then every **1 hour** (`setInterval(tick, 60*60*1000)`). Idempotent catch-up: a restart/clock-change/downtime self-heals on the next pass. Posts Dr `SAL-EMP-n` / Cr `SAL-PAY-n` from attendance.
2. **Rent accrual** — `startRentAccrualScheduler(pool)` (index.ts:3967; `lib/rentAccrual.ts:488`). Same hourly idempotent pattern; posts Dr `RENT-EXP-wh` / Cr `RENT-PAY-wh`.
3. **Backup sweep** — `startBackupScheduler()` (index.ts:4102; `lib/backup/scheduler.ts:167`). First sweep delayed **60 s** (so boot migrations finish first), then on `SWEEP_INTERVAL_MS`. Each sweep runs `runScheduledBackupSweep` (frequency/retention from `backup_meta.backup_settings`) + `dropStaleScratchDbs` (prunes stranded verification DBs).

These are the ONLY recurring timers. Everything else described below is **boot-time**, not scheduled.

### 31.2 Boot-time migrations & backfills — the ONLY DDL channel
`drizzle-kit push` is never run. All DDL + data migrations execute at process start in `src/index.ts` and `src/migrations/*.ts`.

**Run order & structure:**
- `app.listen()` opens the port first (index.ts:2759) with `app.locals.migrationsReady = false`; `/healthz` stays not-ready until the very last line sets it `true` (index.ts:4106).
- `runMigrations()` (index.ts:42) runs first: a large batch of idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS` plus seed inserts and one-shot data migrations. Wrapped in try/catch → **non-fatal**: on failure it records `migrationsError`, writes to **stderr** (stdout is discarded pre-port in prod) and a `boot_status` row, and continues. (index.ts:2765-2777).
- `convertTextDateColumns()` runs as its OWN top-level step (index.ts:2782) — deliberately outside `runMigrations()` so a swallowed throw there can't skip it. text→date column conversions; noted as never auto-applying across a publish diff.
- `revertPendingLeaveStamps()` (index.ts:2812) — own step, migration_log-guarded.
- Then a long sequence of `await`ed migration modules from `src/migrations/` (index.ts:3947-4098), each with a documented dependency order and MANY individually wrapped in try/catch with a "(non-fatal, retries next boot)" stderr log so one failure never takes down boot: `migrateOutletsToWarehouses` → `repairOpeningBatches` → `addMaterialLocations` → `addMaterialBatches` → `addWarehouseRent` → (start rent scheduler) → `addSalaryAccrual` → (start salary scheduler) → `addInvoiceShareLinks` → `addBackupRestore` → `addExpensePaymentModes` → `addFixedAssets` → `addAssetModule` → `addPurchaseBillFields` → `addSaleOtherCharges` → `addQuotations` → `addDataImport` → `addWarehouseLifecycle` → `runOrgHierarchyRestructure` → `addVoucherProvenance` → `backfillPartyLocations` → `restampMoneyVoucherLocations` → `backfillSalePaymentLegs` → `backfillSalePaymentLegsV2` → `cleanupOrphanStockRows` → `ensureStockMasterGuardTrigger` → `startBackupScheduler()` → `migrationsReady = true`.

**One-shot guard mechanism — `migration_log`:** PK `name`, one row per applied one-time migration. The pattern (e.g. index.ts:205, 474, 623, 703) is: `SELECT 1 FROM migration_log WHERE name = '<key>'`; if present, skip; else do the work in a transaction and `INSERT INTO migration_log (name) VALUES ('<key>') ON CONFLICT DO NOTHING`. Guards are keyed on the marker name, **never on data shape** (a re-added empty column or NULL value must not re-trigger). Live DB currently holds **58 markers** (e.g. `std_ledgers_cleanup_v1`, `customer_advances_fold_v1`, `sale_payment_legs_backfill_v2`, `org_hierarchy_restructure_v1`, `orphan_stock_cleanup_v1`, `username_normalization_v1`, `sales_b2b_b2c_series_v1`, `cash_bank_ledger_link_v1`, …).

**Boot observability — `boot_status`:** `recordBootStatus()` (index.ts:2591) writes one row per boot: `node_env`, `migrations_ok` (bool = migrationsError===null), `migrations_error` text, `date_columns` outcome, `notes`. It creates the table if absent and keeps only the last 50 boots (`DELETE … id <= max(id)-50`). This exists because pino writes to stdout which prod discards until the port opens — `boot_status` is the durable, SQL-readable boot record. `GET /healthz/schema` (unauthenticated GET) lets a publish be verified from outside without reading logs.

**Self-healing sweeps (run every boot, idempotent):** e.g. `sweepOrphanPartyLedgers` (orphan CUST-/VEND- ledgers from hand-deleted masters), `rebalanceCashBankOpeningEquity(pool)` (index.ts:3942 — recomputes the STD-OB-ADJ equity counterweight to whatever CBA openings exist right now; every boot AND after every module write, under an advisory lock). `ensureStockMasterGuardTrigger` re-asserts the `assert_stock_master_exists` trigger (idempotent DDL).

**Cosmetic known issue:** `stock_batches_opening_v1` logs "DEFERRED" every boot (audit §15 Low).

### 31.3 Automatic numbering allocators (invoked on write, not scheduled)
- **`voucher_sequences`** (PK `voucher_type, fy_label`) via `nextVoucherNumber`/`nextScopedSerial`/`allocateSalesInvoiceNumber` (`lib/voucherNumber.ts`): atomic `INSERT … ON CONFLICT … DO UPDATE SET last_number = last_number + 1 RETURNING`. Formats: JV/receipt/payment `PREFIX/FY/0000`; sales `series+fy+serial` under per-location scope rows (live examples: `sales_invoice_counter_b2c@warehouse:1`, `…_b2b@warehouse:2`). Never `COUNT(*)`.
- **DB sequences:** `purchase_batch_seq` (batch numbers `PUR-YYYYMMDD-NNNNN`), `item_code_seq_item`/`_material`/`_raw_material` (product codes).

### 31.4 Automatic reconciliation status stamping
Not a background job — reconciliation status is stamped synchronously by the reconciliation endpoints (`reconciliation.ts` match/unmatch and batch creation) onto `sale_payments.reconciliation_status`/`matched_reference`/`matched_by`/`matched_at`. No timer scans for matches. NOT FOUND: any periodic auto-matcher.

### 31.5 What runs on publish (production boot)
Production boot runs the **exact same `runMigrations()` + migration-module sequence + schedulers**. A publish therefore replays every idempotent `IF NOT EXISTS`/`migration_log`-guarded step against the prod DB. text→date conversions can never auto-apply across a diff (audit risk #2) — the migration playbook must be followed. The three interval schedulers start on prod boot identically.

**Business rules (implemented):**
- No OS cron / node-cron / queue / worker (NOT FOUND); the only recurring work is three `unref()`'d in-process `setInterval` timers (salary hourly, rent hourly, backup sweep) started at end of boot.
- All DDL and data migrations run at boot, non-fatally wrapped (failures log to stderr + a `boot_status` row and retry next boot), never via `drizzle-kit`.
- One-time migrations are guarded by a `migration_log` marker keyed on name, never on data shape; the marker is written in the same transaction as the work.
- Every boot writes one `boot_status` row (migrations_ok / error / date-columns / notes), keeping the last 50; `GET /healthz/schema` exposes live column types unauthenticated for post-publish verification.
- Idempotent self-healing sweeps run every boot (orphan party-ledger sweep, cash/bank opening-equity rebalance under advisory lock, stock master-guard trigger re-assert).
- Document/product numbering is allocated on write via atomic `voucher_sequences` upserts and dedicated DB sequences — no scheduled numbering job.
- Reconciliation status is stamped synchronously by reconciliation endpoints; there is no auto-matching background job.
- Production publish replays the same boot sequence against the prod DB.

---

## 32. Business Rules (consolidated)

Every module section above closes with a "**Business rules (implemented)**" list traced to code — those lists are the authoritative, exhaustive inventory. This section consolidates the rules a developer is most likely to violate accidentally, grouped by theme. Nothing here is aspirational; each rule is implemented and enforced today.

### 32.1 Settlement & payment rules
- Payment modes are **Cash / Bank / UPI / Credit**. Legacy `card`/`bank_transfer` values are *read* as Bank but never rewritten. New sales accept only `cash` or `credit` at entry (UPI/card arrive via collection routing).
- Cash/UPI/bank sales are **settled the moment they exist** (`amount_paid = total`); only `credit` sales carry a balance, require a registered customer, and pass the credit-limit guard.
- Dues everywhere = `total − paid`. No report or guard may infer dues from mode or status labels.
- Every settled sale carries **exactly one** `sale_payments` leg with `source='counter'` and `clearing_receipt_id IS NULL`, dated the sale date. Producers: POS create, sale edit, importer. Cancel exempts/deletes counter legs only in that exact shape; unknown provenance fails closed.
- Electronic (UPI/card) collections post to the Electronic Clearing ledger with `reconciliation_status='pending'`; reconciliation batches move net to bank and charges to processing-charges, marking legs `reconciled`. Cash needs no reconciliation.
- Credit collections are received **into a ledger** (`receivedInLedgerId`); the server derives cash/bank/upi from the account and validates it against the *sale location's* ledger set.
- Receipt allocation: per-invoice cap at outstanding; excess becomes customer advance as a **credit balance on `CUST-<id>`** (no separate customer-advance ledger). Vendors are asymmetric: excess parks on `VADV-<vendorId>`.
- A sale-linked (trail) receipt is display-only; derivation excludes it by invoice-number match or leg linkage. Books derive collections from `sales` + `sale_payments`, with the `amount_paid − Σ legs` remainder posted as counter money dated the sale.

### 32.2 Credit rules
- Credit limit is checked against the customer's **ledger balance** (`currentPartyStatement` — openings, JVs, notes, unallocated receipts all count), inside the write transaction, under the customer advisory lock.
- The sale-edit guard projects the **post-edit** paid figure using the save path's own semantics (Σ `sale_payments`), never the stored `amount_paid`.
- Cancelled is a terminal state: every write path (payments, returns) re-checks it after taking the sale row lock.

### 32.3 GST rules
- **All** GST derives from per-line stored net figures via one helper (`lineTaxHeads`) — never recomputed ad hoc.
- Place of supply = **selling location's state** vs customer state, via one resolver (`isInterStateSupply`, code-first with alias folding); same state → CGST+SGST, different → IGST.
- CGST/SGST paise split = half + **exact remainder** (never two independent roundings); client and server math match.
- Per-line discounts are **pre-tax** (reduce taxable value); the bill-level coupon is **post-tax** and lives only in `discount_total`. Never sum line discounts into `discount_total`.
- Sale other charges carry **no GST** and are expense recoveries, not revenue; purchase other charges are vendor-owed but excluded from stock cost.
- Invoice series: B2B (customer has GSTIN) vs B2C stamped at creation (`SB2B`/`SB2C`, per-location, FY-pinned, allocator-issued). B2C→B2B reclassification converts open-month invoices atomically, compacting only conversion-opened gaps.
- Two GSTIN resolvers exist **on purpose**: filing scope falls back to the company GSTIN; transfer classification must not.
- Cross-GSTIN branch transfers write **real** sale/purchase documents (replacing dispatch/receive JVs); every revenue/spend query excludes `branch_transfer_id` rows.
- Known gap (#54): credit/debit notes do not yet reduce GSTR outputs (over-reporting direction).

### 32.4 Stock rules
- Quantity truth = `stock_entries`; the item-master qty column is stale by design. Consumption is FEFO over the batch layer, clamped, shortfall labelled "Untracked".
- Every stock write appends a business-dated `stock_ledger` row **inside the same transaction**; Closing(D) = Opening(D+1) under backdating.
- Negative stock is blocked by a DB constraint. Masters with live stock or reservations cannot be deleted (row locked, re-checked under lock, 409).
- Reservations: `hold` reduces availability; `in_transit` does not (already deducted at dispatch).
- Transfers are always two-step (dispatch → approve); dispatched stock is sender-owned in valuation while in transit.
- Valuation is **one** at-cost computation feeding report, dashboard and P&L alike; stock adjustments post **no** accounting entry (PARTIALLY IMPLEMENTED — books can drift from valuation on write-offs).
- Product identity is polymorphic (`item`/`material`/`raw_material` with overlapping ids): every read/write must scope by kind; code prefixes follow the display label; barcodes use the EAN-13 in-store `2` range; inactive blocks CREATE only.

### 32.5 Return rules
- Sales returns are **invoice-anchored**: pricing comes from the original invoice lines (gross unit price; net rate displayed), never the item master. Returnable qty = sold − already returned, capped per line. Bill coupons and other charges are excluded from refunds.
- Purchase returns keep bill-borne other charges **by design**.
- Return edits restate stock by **delta**, keep FY-pinned numbers, and rewrite the note JV in place.

### 32.6 Discount & pricing rules
- Line price ≥ item-master MRP floor (create + edit; stored lines grandfathered; quotations exempt).
- Bill-level pre-tax discounts are allocated **paise-exact** into lines; stored line discount = item discount + allocated share; legacy lines keep line-total semantics forever.
- Money inputs are validated as decimal **strings** (reject >2dp); NUMERIC does the arithmetic.

### 32.7 Location rules
- Two gates in fixed order: page permission (403) **before** location scope (404). Body-supplied location is a request, never authority — the effective value is computed, then guarded.
- HO's placeholder id differs per table (vouchers 0; sales/stock 1): HO is matched on **type alone**.
- A money voucher may touch only the caller's own till; voucher location resolves from till ownership; mirror locations (same place as outlet + warehouse sharing a cash ledger) dedupe sums and resolve writes like reads.
- The sidebar location selector affects **reads only**; branch users get read-only location labels, never dropdowns.
- Every new transaction producer must check the warehouse-disabled guard on the *effective* location, inside the transaction.

### 32.8 Month-lock rules
- Absence of a lock row = open. One shared helper refuses any write whose **business date** falls in a locked month with HTTP 423 — across sales, purchases, returns, production, transfers, vouchers, expenses, payroll, attendance, leave, rent, assets and imports.
- Deliberately open: new open-month payments against locked-month credit sales; quotations; master data.
- Lock is admin-only with a pre-lock verification summary; unlock requires a reason; both are event-logged.

### 32.9 Payroll rules
- Employment status is truth; `is_active` is derived; the last working date bounds accrual and payroll; a fully untracked month post-cutover pays **zero**.
- Days with punch rows are paid on **total closed-session hours** (never first-to-last span); the day boundary is the company timezone.
- One formula (`dayContribution`/`monthLeaveSummary`) feeds attendance, accrual and payroll alike. Pending leave = zero pay; approval stamps under the attendance lock; rejection must not take it; revert = DELETE.
- Stored holiday/weekly-off rows outvote the calendar; untracked months never synthesise attendance.
- Salary accrues to the P&L **daily**; payroll approval is a delta true-up (can flip sides) that locks the month and re-checks attendance **inside the lock**. Statutory rates are snapshotted per run; approved payroll is immutable — corrections are reversals. The salary JV recognises full employer cost (incl. employer PF/ESI).
- One settlement path per advance (row-lock serialized); `is_deducted` TRUE with NULL payroll id = cash recovery. Branch salary payments never fall back to HO cash.

### 32.10 Import rules
- Commits **reuse the manual-creation libraries** — an import must be indistinguishable from hand entry (incl. counter legs, numbering, avg-cost order).
- Name resolution is mapping-first via permanent `import_mappings`; silent auto-create is retired.
- Files commit in order (average cost is order-dependent); a batch is one transaction; rollback runs in reverse order with reversal-equivalent cost unwind and refuses when downstream activity exists.
- The wizard's location is fixed at trial time; approval refuses any other location. Legacy Excel amounts are GST-inclusive; reused document numbers get `/2` suffixes.

### 32.11 Voucher & numbering rules
- All document numbers come from atomic FY-scoped allocators (`voucher_sequences`, per-location invoice columns) — **never** `COUNT(*)`, never renumbering (it strands allocators; renames pair-rename receipts).
- Voucher provenance (`source`/`origin`) is stored, never inferred. Editability derives from it; NULL fails closed for edit; unknown origin stays deletable; `system` blocks delete. Type changes are forbidden; date changes may not cross the FY the preserved number encodes.
- Ledger `code` is never client-writable; coded ledgers (`STD-*`, `CBA-*`, `CUST-*`, `VEND-*`…) cannot be renamed from the chart; system heads are guarded by code, not flags.
- Every derivation-visible ledger must exist — the posting builder throws on missing ledger ids (orphan postings are a data bug, not a display option).

### 32.12 Security & session rules
- Passwords: bcryptjs; tokens: HMAC-v2 bearer, 8-hour expiry; legacy tokens rejected. New users must change the seeded password on first login. Login lockout: 5 failures / 15 min → 15-minute lock, keyed on normalized username.
- Any 401 = dead session (clients log out); wrong typed credentials are 400. Self-service GETs self-scope instead of 403.
- Default-deny permissions: a page without a granted row is invisible *and* its writes are refused server-side; level 1 alone bypasses. Hidden money figures are **omitted**, never zeroed.

---

## 33. Transaction Flow Maps

Legend: USER → FRONTEND → API → SERVICE/LOGIC → DB → DERIVATION → REPORTS/DASHBOARD.

### 33.1 Cash (POS) sale
```
Cashier picks location → POS cart (marlin-erp headoffice/Sales.tsx)
  → POST /api/sales (mode=cash/upi/bank)
  → sales.ts: buildSaleLines + lineTaxHeads, isInterStateSupply, checkMrpFloor,
    disabledWarehouseError, isMonthLocked(423), allocateSalesInvoiceNumber (SB2B/SB2C)
  → DB: INSERT sales (amount_paid=total, line_items JSONB, other_charges),
    FEFO consume stock_batches, append stock_ledger, (advance-only rows write sale_payments)
  → DERIVATION (buildDerivedPostings §17.3 Source 5): Cr location Sales(net),
    Cr STD-OUT-*, Dr location Cash / STD-ELEC-CLR (counter money), [Dr CUST-n if provisioned]
  → REPORTS: TB, P&L (revenue+GST), Day Book; DASHBOARD: Sales tile, payment mix, cash tile
```

### 33.2 Credit sale
```
Same as 33.1 but mode=credit, amount_paid=0
  → DERIVATION: Dr CUST-n (full total), Cr Sales(net), Cr Output GST
  → REPORTS: Outstanding/Receivables (customer ledger closing), P&L, TB
  → collection later via 33.3 receipt/allocation → Cr CUST-n, Dr cash/bank
```

### 33.3 Receipt (customer collection)
```
User → Receipt Voucher page / Vouchers → POST /api/accounts/receipts
  → accounts.ts: nextVoucherNumber('receipt'), optional allocations[]/advanceAmount,
    isMonthLocked(423), branch LBAC on ledgers
  → DB: INSERT receipts (source), sale_payments rows via clearing_receipt_id when settling bills
  → DERIVATION: sale-linked/allocation receipts EXCLUDED from Source 2 (posted via Source 5);
    pure receipt → Dr received_in / Cr received_from (CUST-n); advance excess → Source 2b
  → REPORTS: ledger statement, cash/bank book; DASHBOARD: cash/bank, receivables
```

### 33.4 Payment (vendor)
```
User → Payment Voucher → POST /api/accounts/payments
  → nextVoucherNumber('payment'), allocations[]/advanceAmount, month-lock, LBAC
  → DB: INSERT payments (+ payment_bill_allocations / purchase_advance_applications)
  → DERIVATION Source 1: Dr paid_to (VEND-n) [+ Dr VADV-n advance] / Cr paid_from (CBA-)
  → REPORTS: vendor ledger, payables; DASHBOARD: cash/bank, payables
```

### 33.5 Expense
```
User → Expenses page → POST /api/... expenses (location-stamped, kind stored)
  → month-lock, disabledWarehouse, expense ledger must be postable Indirect/Direct
  → DB: INSERT expenses (payment_account_id → CBA)
  → DERIVATION Source 4: Dr expense head / Cr CBA (else STD-CASH/STD-BANK)
  → REPORTS: P&L (indirect/direct), Day Book; DASHBOARD: Expenses tile (+Salary/Rent/Other)
```

### 33.6 Journal voucher / contra
```
User → Journal/Contra dialog (mandatory location, ledger legs) → POST /api/accounts/vouchers
  → checkLinesLocation (legs must belong to stamp), provenance, month-lock, nextVoucherNumber
  → DB: INSERT journal_vouchers + journal_voucher_lines (Dr/Cr as entered)
  → DERIVATION Source 3: posted verbatim
  → REPORTS: per-ledger statements, TB, Day Book
```

### 33.7 Stock transfer (cross-GSTIN)
```
User → Stock Transfer → POST dispatch → deduct source stock, create in_transit reservation,
    classifyTransfer(from,to); invoice mode → createTransferSaleInvoice (sales row, branch_transfer_id)
  → receive/approve → release reservation, credit dest stock, createTransferPurchaseInvoice
  → DERIVATION: sale/purchase rows → STD-BRANCH-TRF / STD-BRANCH-DEBTOR / -CREDITOR + GST heads
  → REPORTS: GSTR-1/3B (real invoices), BS branch clearing; P&L untouched (kept out of turnover)
```

### 33.8 Payroll run
```
HR → generate draft (freezes gross/net from attendance) → approve
  → hr.ts postSalaryApproval: row lock, month-lock(423), lockSalaryAccrual,
    re-check attendance/policy drift, accruedForMonth
  → DB: INSERT journal_voucher (system/payroll) true-up + employer PF/ESI; close advances
  → DERIVATION: daily Source 8 (Dr SAL-EMP / Cr SAL-PAY) + approval JV (Source 3):
    Dr SAL-EMP Δ, Dr STD-PF-EMPR, Dr STD-ESI-EMPR / Cr SAL-PAY Δ, STD-PF-PAY, STD-ESI-PAY, STD-EMP-DED, ADV-EMP
  → REPORTS: P&L salary, payroll register; DASHBOARD: Expenses(Salary)
```

### 33.9 Import (transactions / vouchers / migration)
```
User → Company → Import Data → upload Excel → analyse → map names → (demo run in never-committed txn)
  → approve picks target location LAST, re-stamp + re-validate
  → lib/importTransactions.ts / importVouchers.ts: same logic as POST /sales,/purchases,/receipts,/payments
    (FEFO, weighted-avg cost, settlement model, lineTaxHeads, invoice numbers kept verbatim)
  → DB: real sales/purchases/receipts/payments/JV rows, import_batches/import_rows for rollback
  → DERIVATION: identical to native documents; ROLLBACK = all-or-nothing reversal
  → REPORTS/DASHBOARD: identical to native
```

---


---

## 34. Known Bugs

Every item below is an *observed, tracked* finding — none are speculative. Source: the in-repo system audit (`docs/ERP_SYSTEM_AUDIT.md`), the Aug 5 and Aug 10, 2026 health-check re-runs, and the curated project task backlog (60+ vetted items). Severity reflects business impact today.

### 34.1 Open — High

| ID | Module | Description | Expected | Actual | Root cause | Affected data / reports | Recommended fix |
|---|---|---|---|---|---|---|---|
| #54 | GST | Credit/debit notes do not reduce GST returns | GSTR outputs net of notes | Returns/notes excluded from GSTR figures → tax **over-reported** (conservative direction, but wrong) | GSTR builders read invoice register only, not note-sourced postings | GSTR-1/period GST reports; any filing built on them | Fold note tax heads into the GSTR aggregation before the next filing period |
| #188 | Customers | Deleting a customer can leave invisible balances | Delete blocked or balance surfaced | Postings to the deleted party's ledger classify into neither statement; TB stays balanced while BS gap equals their net | Delete guard checks documents, not ledger residue | Balance Sheet, receivables | Guard on ledger balance too; healing sweep for existing orphans |
| #14 | Items | GST rate free-entry | Rates restricted to valid slabs (0/5/12/18/28%) | Any numeric rate accepted at item entry | No slab validation on item master write | Every downstream GST computation for mispriced items | Validate against the slab list on create/edit |

### 34.2 Open — Medium

| ID | Module | Description | Notes |
|---|---|---|---|
| B1 | API | Non-numeric `:id` on `GET /api/assets/:id` (and possibly sibling routes) → unhandled DB error, HTTP 500 `NaN` | Should 400/404; central `:id` validation recommended |
| #134 | All editors | Concurrent edits silently overwrite (no stale-write detection) | Last write wins; no version/updated-at check |
| #131 | Products | Finished product vs raw material share overlapping numeric ids (polymorphic tables) | Currently safe only by `material_type` scoping discipline; no DB-level enforcement |
| #189 | Reports | GST and expense reports lack the location filter other financial reports have | Filter plumbing exists; these two report families never adopted it |
| #40 | Expenses | Location expenses recorded in error cannot be deleted | No delete path for managers |
| #205 | Quotations | Two users can convert one quotation into two invoices at the same moment — *partially mitigated*: one-sale-per-quote is enforced by two partial unique indexes + `FOR UPDATE`; task remains open pending re-verification | Verify then close |

### 34.3 Open — Low

- #57 — hidden TypeScript errors (esbuild runs despite them; no CI type gate).
- #114 — transfer dispatch does not record *who* dispatched (audit-trail gap).
- #191 — older credit-sale settlements display a generic "Paid" instead of the settling method.
- #190 — 7 stale regression suites (pre-auth-era harnesses, fixture-month clock rollover) fail for test-debt reasons, not app bugs; they mask nothing today but erode signal.
- `stock_batches_opening_v1` boot migration logs `DEFERRED` on every boot (cosmetic, known).

### 34.4 Recently fixed (for historical context — verified closed)

- **F-1 counter-payment history gap (fixed Aug 10, 2026):** counter-settled sales (cash/UPI/bank) wrote no `sale_payments` row — history tabs blank, reconciliation blind; books were never wrong (derivation posted the remainder). Now every settled-sale producer writes exactly one `source='counter'` leg; a one-shot boot backfill healed history (dev: 53 legs ₹53,967.54; prod: 45 bills ₹51,300.04 heal on next publish). Trial balance verified identical to the paisa before/after.
- **M-1 (Aug 5 → fixed):** Cash Book/Bank Book omitted opening balances.
- **M-2 (Aug 5 → fixed):** first production cash sales lacked settlement legs (superseded by F-1's v2 backfill).
- **M-3 (Aug 5 → fixed):** deleted products left nameless stock rows in valuation.
- **#37 (retest & close):** sales summary "misses warehouse sales" no longer reproduces — dashboard = register = SQL exactly (Aug 10 audit).
- Aug 1, 2026 health-check batch: sale-edit location corruption (the historical books-drift root cause), fire-and-forget return stock-ledger writes, unlogged stock verification, unguarded product deletes with live stock, permission-seeder mirror drift — all fixed with data heals applied.

The full curated backlog (65 tasks at the time of writing) lives in the project task list; each entry is a vetted finding from prior audit/QA sessions.

## 35. Current Limitations

Deliberate scope boundaries and accepted debts — not bugs:

- **Derived accounting recomputes per request.** `buildDerivedPostings` walks the full document stream on every statement read. Sub-100 ms at current volume; linear growth. A cached/materialized stream is the planned mitigation at ~10× volume.
- **No depreciation postings** for assets (by design — GST is capitalised into asset cost, no ITC claimed, no depreciation schedule).
- **No stored double-entry journal for documents.** Only manual JVs persist legs; everything else derives. This makes statements internally consistent by construction but means "the ledger table" does not exist to query directly.
- **Sparse DB-level FK enforcement.** Many relations are conventional (code-managed); healing sweeps at boot compensate (orphan party ledgers, ghost transfer twins). Manual DB edits bypass every safeguard — twice observed in production; the app's own delete/reset paths must be used.
- **Type-safety debt:** ~70 `as any` in the largest sales page, extensive `req.employee` casting; esbuild does not fail on type errors (#57).
- **God files:** `hr.ts` (~2.7k lines), `accounts.ts` (~2.1k), `sales.ts` (~1.9k) — services not yet extracted.
- **Concurrency model:** advisory locks + row locks guard money paths (credit limit, advances, attendance/payroll, numbering); generic record edits have no optimistic-lock/versioning (#134).
- **Accepted races:** month-lock check-then-lock has a narrow documented race (a write racing the lock action itself).
- **Un-paginated list endpoints** by policy (UIs read lists wholesale); fine at current volume.
- **WhatsApp invoice delivery** is share-link based; direct attachment sending is a tracked future task (#137).
- **Quotation lifecycle** is intentionally minimal: parallel document store with zero books impact; no sales-order stage exists between quotation and invoice (NOT IMPLEMENTED — invoicing is direct).

## 36. Production Behaviour

Production runs the same codebase, published to a separate environment with its own PostgreSQL database. Differences that matter:

- **Schema convergence happens only via boot migrations.** Every DDL ships as an idempotent startup migration (one-shot guards in `migration_log`; status in `boot_status`). Publish additionally diffs the two live databases — expression indexes and text→date type changes cannot auto-apply, so column types are kept converged deliberately. `drizzle-kit push` is **never** run (schema.ts is a partial view; a push would drop raw-migration tables).
- **Boot output is discarded until the port opens** in production — mid-migration failures are observable only via `boot_status` rows, which is why each one-time conversion is a separate top-level step.
- **Pending on next publish:** the counter-payment backfill (45 bills, ₹51,300.04, all cash — no reconciliation-queue noise will result).
- **Data divergence, not schema divergence:** dev and prod imported the same legacy documents *separately* — internal ids and generated batch numbers differ between environments. Cross-environment record matching must use invoice/voucher numbers, never ids. Prod data corrections go through the app, not SQL.
- **Runtime differences:** the deployed runtime lacks dev-workspace CLI binaries (`zip`/`unzip` → ENOENT only in prod; `pg_dump` **is** present). All archive handling uses in-process libraries.
- **Proxy effects:** every client IP reaches the app as `127.0.0.1` in production — the login-audit IP column is therefore uninformative there.
- **Prod health (Aug 10, 2026 audit):** structurally clean — zero duplicates, unbalanced vouchers, orphan legs/ledgers, ghost documents, negative stock. Verified read-only via the production database connection; production is never written outside the app and its boot migrations.
- **Test-only issues:** the 7 failing regression suites (#190) are fixture/harness debt (pre-auth-era assumptions, fixture-month clock rollover) — they do not represent production defects. Dev additionally carries clearly-labelled leftover test fixtures (e.g. "ZZ Counter Test…" customer with two cancelled bills) that have zero books impact.

---

## 37. Complete End-to-End Example

Illustrative worked example with realistic figures. GST 18% intrastate
(CGST 9% + SGST 9%). Ledger codes are the live ones from §18.

### Step 1 — Purchase (Head Office) of raw fruit
Bill PUR/2026-27/0001, vendor **V (`VEND-7`)**, taxable ₹10,000 + CGST 900 + SGST
900 = **₹11,800**, plus freight ₹500 (other charge → `STD-FREIGHT` expense ledger,
say id posts as a Direct Expense). Credit terms.

Derived postings (Source 6):
```
Dr STD-PUR              10,000.00
Dr STD-INP-CGST            900.00
Dr STD-INP-SGST            900.00
Dr <freight expense>       500.00
   Cr VEND-7                        12,300.00   (goods 11,800 + charge 500)
```
Movements: TB balanced; P&L purchases +10,000 & direct expense +500; BS input GST
asset +1,800, creditor +12,300. Stock in at taxable value 10,000 (freight NOT in
stock cost), weighted-avg cost updated.

### Step 2 — Production (BOM consumes raw fruit → finished pulp)
Absorption cost of output = ₹7,000 (materials at cost + overhead %).

Overlay JV (production, excluded from statements):
```
Dr STD-FG-INV           7,000.00
   Cr STD-PROD-ABS               7,000.00
```
Movements: TB still balances; **P&L and BS unchanged** by construction (overlay
stripped). Finished-goods on-hand rises in valuation; raw stock falls (FEFO).

### Step 3 — Stock transfer HO → Outlet, same GSTIN
Internal transfer (same registration): delivery challan only, **no GST, no financial
posting**. Stock moves via `in_transit` reservation then credited at destination.
Movements: none in TB/P&L/BS; stock location shifts.

### Step 4 — POS cash sale at the outlet, with discount + GST
Invoice SB2C/2026-27/000001. Line MRP-inclusive ₹5,900 (taxable 5,000 + GST 900),
line discount nets taxable to **4,720** taxable → CGST 424.80 + SGST 424.80, total
**₹5,569.60**, paid cash. Walk-in (no `CUST-n`).

Derived postings (Source 5, net model):
```
Dr <outlet Cash / STD-ELEC-CLR>   5,569.60
   Cr <outlet Sales ledger>               4,720.00
   Cr STD-OUT-CGST                           424.80
   Cr STD-OUT-SGST                           424.80
```
Movements: P&L revenue +4,720; BS output GST +849.60, cash +5,569.60; FEFO stock
out. GSTR-1 B2C rate-wise picks this up (`cancelled_at IS NULL`).

### Step 5 — Credit sale to customer C (`CUST-3`)
Invoice SB2B/2026-27/000001, taxable ₹20,000 + CGST 1,800 + SGST 1,800 = **₹23,600**,
credit (amount_paid 0). Gross debtor model:
```
Dr CUST-3              23,600.00   (Invoice SB2B/…/000001)
   Cr <location Sales>          20,000.00
   Cr STD-OUT-CGST               1,800.00
   Cr STD-OUT-SGST               1,800.00
```
Movements: P&L revenue +20,000; BS debtor +23,600, output GST +3,600. Receivables /
Outstanding report shows C owes 23,600.

### Step 6 — Collection from C: ₹23,600 by bank
Receipt REC/2026-27/0001, `received_in` = bank `CBA-5`, against invoice
(sale_payments row via `clearing_receipt_id`). Receipt excluded from Source 2;
posted via Source 5:
```
Dr CBA-5              23,600.00   (dated receipt date)
   Cr CUST-3                   23,600.00   (Payment received — SB2B/…/000001)
```
Movements: BS debtor −23,600 (net CUST-3 now 0), bank +23,600. Customer statement
shows Invoice (Dr) then Payment received (Cr), closing 0.

### Step 7 — Sales return from C: 1 unit, taxable ₹4,000 + GST 720 = ₹4,720
Return SR/…, credit note CN/2026-27/0001 (Source 3):
```
Dr STD-SALES           4,000.00
Dr STD-OUT-CGST          360.00
Dr STD-OUT-SGST          360.00
   Cr CUST-3                    4,720.00
```
Movements: P&L **Less: Sales Returns 4,000** (net sales fall); BS output GST −720,
CUST-3 now a **credit (advance) balance of 4,720** (a refundable credit). Stock
restored to batches. **GST returns caveat:** the original sale still shows in
GSTR-1/3B in full (partial return, `cancelled_at` not set) — task #54; the tax stays
over-reported until that fix lands.

### Step 8 — Month-end statements (movement summary)
Trial Balance (balanced, illustrative deltas for the period):
```
Dr side:  STD-PUR 10,000 · direct exp (freight) 500 · STD-INP-CGST 900 · STD-INP-SGST 900
          · CBA-5 23,600 · outlet Cash 5,569.60 · STD-SALES(returns) 4,000 · STD-OUT-* returns 720 ...
Cr side:  location Sales 24,720 (=4,720 POS +20,000 credit) · STD-OUT-CGST/SGST (net of returns)
          · VEND-7 12,300 · CUST-3 4,720(cr) ...
(FG-INV/PROD-ABS overlay excluded; TB Dr = Cr to the paisa)
```
P&L (period):
```
Sales (gross)              24,720.00
Less: Sales Returns         4,000.00
Net Sales                  20,720.00
Opening Stock                    ...
Add: Purchases             10,000.00
Add: Direct Expenses (freight) 500.00
Less: Closing Stock  (valuation incl. FG 7,000 & remaining raw)
= COGS → Gross Profit
Less: Indirect Expenses (salary/rent accruals if any)
= Net Profit
```
Balance Sheet (cumulative, as at month-end):
```
Assets:      Cash + Bank (CBA-5) + STD-INP-CGST/SGST + Closing Stock + Fixed Assets + net Debtors
Liabilities: VEND-7 (12,300) + STD-OUT-CGST/SGST (net) + Capital + Profit for the period
CUST-3 sits as a credit (advance) 4,720 → nets against Sundry Debtors
Assets = Liabilities + Equity, no plug (overlay stripped, openings folded)
```

**Business rules (implemented):**
- Every step's books are the *derived* consequence of its documents; no manual
  posting is entered for sales/purchases/receipts/payments/rent/salary.
- Internal (same-GSTIN) transfers move stock only, never the books.
- Production overlay keeps P&L/BS unchanged while carrying manufactured value into
  stock valuation.
- A partial sales return reverses revenue + output GST in the books and turns the
  customer into a credit balance, but does not reduce the GST returns (task #54).
- Month-end TB/P&L/BS all fold the same posting stream + openings and balance by
  construction.

---

## 38. Final System Summary

Marlin Frozen Fruits ERP is a production-grade, multi-location business system whose defining property is **a single source of truth per domain**:

- **Money:** documents (sales, purchases, receipts, payments, vouchers, payroll, accruals) are the only stored facts; one derivation (`buildDerivedPostings` → `buildBooks`) turns them into every statement on read. The manual JV family is the sole stored double-entry. Consequence: statements can never disagree with each other, and every money bug is either a document bug or a derivation bug.
- **Quantity:** `stock_entries` (with the batch layer and the append-only `stock_ledger` audit trail). Everything else — item-master qty, dashboards, valuation — is derived or dead.
- **Outstanding balances:** `currentPartyStatement` and its SQL builders, exported from the owning module. Any hand-rolled `total − paid` is a defect.
- **Identity:** documents own their numbers via FY-scoped allocators and stamped series columns; locations own their money via till-anchored resolvers; parties own their ledgers via auto-provisioned coded accounts.

**How everything connects, in one paragraph.** A user (RBAC page rights, LBAC location scope) enters a document through the React web app or Expo employee app; the generated API client calls the Express server; the route validates (zod + raw-body reads for raw-migration columns), takes its advisory/row locks, writes the document plus its side rows (stock entries + batches + ledger rows, settlement legs, JV twins for transfers) in one transaction, month-lock checked on the business date. Nothing else happens at write time. Every read — ledger, trial balance, P&L, balance sheet, GST return, dashboard tile — replays the document stream through the one posting builder, folds openings, applies location/date filters, and renders. Imports enter through the same creation libraries; boot migrations evolve schema and heal data one-shot on both dev and prod.

**To rebuild or modify this ERP correctly:** read §17 (accounting derivation) and §20 (inventory layers) first — they explain why writes look "incomplete" (no journal rows) and why reads look "expensive" (full derivation). Respect the consolidated rules in §32; nearly every historical defect in this system came from violating one of them (hand-computed dues, inferred provenance, COUNT(*) numbering, body-trusted locations, schema.ts trusted over the live DB). The open work is enumerated honestly in §34; the deliberate boundaries in §35. Everything else is working, reconciled to the paisa, and in daily use.
