# Marlin Frozen Fruits — ERP System Guide

A complete map of the system: every section, what it does, what it writes, and how
the sections connect to each other.

---

## 1. What this system is

An integrated ERP for a frozen-fruits manufacturing and retail business in India.
It covers the full commercial cycle in one place:

```
buy raw fruit → produce finished goods → move stock to branches
→ sell to customers → collect money → account for it → file GST
```

The defining characteristic is that **operations and accounting are not two separate
systems**. You never post journal entries for a sale. You record the sale, and the
books follow automatically. Section 7 explains exactly how.

**Technology:** a React web application, an Express API server, and a PostgreSQL
database. There is also a separate Expo mobile app for employees.

---

## 2. The location hierarchy — the backbone

Almost every record in the system is stamped with *where* it happened. There are
exactly three kinds of location:

| Type | Meaning | Current count |
|------|---------|---------------|
| `headoffice` | The central office. Also where production happens. | 1 |
| `warehouse` | Regional bulk storage. | 2 |
| `outlet` | Retail shops that sell to the public. | 3 |

Every outlet belongs to a parent warehouse. Stock flows downward
(Head Office → Warehouse → Outlet), money and reporting flow upward.

This matters because it drives three separate things:

1. **Stock balances** are held *per location*, not globally. The same item has an
   independent quantity at each place.
2. **Cash balances** are per location — each warehouse and outlet has its own cash
   ledger, automatically created when the location is created.
3. **Who sees what** — a user attached to an outlet sees that outlet's data. Head
   Office sees everything. This is enforced on the server, not just hidden in the
   interface.

> Historical note: "production" used to be a fourth location type. It was retired —
> production is a Head Office department, not a separate branch — and old records
> were merged into Head Office by a one-time migration.

---

## 3. The sidebar — 45 links across 8 sections

The navigation is generated from a single file (`moduleRegistry.ts`), which is also
the source of truth for the permissions screen. One list, one permission system —
they can never drift apart.

### Dashboard (standalone, always first)
Live overview: today's sales, stock alerts, recent activity, and charts. Reads from
every other module; writes nothing.

### Operations — 6 links (the branch-facing section)
This is what a shop or warehouse employee uses daily.

| Link | Purpose |
|------|---------|
| **Point of Sale** | The billing counter. Ring up sales, take cash/UPI/card/credit. |
| **Stock Transfer** | Send stock to another location, and receive incoming stock. |
| **Expenses** | Record spending at this location (rent, charges, sundries). |
| **Cash Balance** | How much cash is physically in this location's drawer. |
| **Stock** | Current stock on hand at this location. |
| **Customers** | Customer records and their outstanding balances. |

### Production — 4 links
| Link | Purpose |
|------|---------|
| **Batches** | Record a production run: materials consumed → finished goods produced. |
| **Reports** | Production output, yield, wastage and cost analysis. |
| **Purchases** | Record purchase bills from vendors, with GST. |
| **Vendors** | Supplier records and payables. |

### Inventory — 8 links (Head Office control)
| Link | Purpose |
|------|---------|
| **Units** | Units of measure (kg, box, pouch…). |
| **Item Master** | All products: finished SKUs, raw materials, packing materials. Holds HSN code, GST rate and MRP. |
| **Stock Ledger** | Every stock movement ever, with a running balance. Audit trail. |
| **Reports** | Valuation, ageing, expiry and reorder reporting. |
| **Verification** | Physical stock counts vs system stock. |
| **Warehouses** | Warehouse master, incl. GSTIN and state. |
| **Outlets** | Outlet master, incl. GSTIN, state and UPI ID for invoice QR codes. |
| **Item Prices** | Selling price per item per location. |

### Sales — 3 links
| Link | Purpose |
|------|---------|
| **Returns** | Sales returns — refunds money and puts stock back. |
| **Outstanding** | Who owes you money, and how overdue it is. |
| **Coupons** | Discount codes (percentage or fixed, valid for N days). |

### HR — 5 links
| Link | Purpose |
|------|---------|
| **Employees** | Staff records, salary, location assignment, login credentials. |
| **Attendance** | Daily attendance and hours. Leave applications are approved here. |
| **Payroll** | Monthly payroll: draft → approved → paid. |
| **Advances** | Salary advances, auto-deducted from the next payroll. |
| **Hierarchy** | Designations and permission levels. |

### Accounts — 13 links (the financial core)
| Link | Purpose |
|------|---------|
| **Chart of Accounts** | The account tree — 71 ledgers currently. |
| **Ledger Statement** | Every transaction for one account, with running balance. |
| **Cash & Bank** | Cash and bank account balances. |
| **Vouchers** | Hub for manual entries: Journal, Contra, Credit Note, Debit Note. |
| **Day Book** | Everything that happened on a given day. |
| **Cash Book** | All cash movements. |
| **Bank Book** | All bank movements. |
| **Trial Balance** | The proof: total debits must equal total credits. |
| **Expenses** | Head-office expense entry. |
| **GST Summary** | Output GST vs input GST. |
| **GST Returns** | GSTR-1 and GSTR-3B preparation. |
| **Reconciliation** | Match deposits against system records. |
| **Reports** | Sales, purchase, profitability and stock reporting. |

### Company — 5 links
| Link | Purpose |
|------|---------|
| **Settings** | System configuration. |
| **Company Profile** | Legal name, GSTIN, address — appears on invoices. |
| **Audit Log** | Who changed what, when. |
| **Permissions** | Grant/revoke module access per role. |
| **Login History** | Login attempts, successful and failed. |

---

## 4. Master data — the four foundations

Everything else references these. Get them wrong and every downstream number is wrong.

1. **Items** (7 finished + 1 material + 1 raw material) — each carries a unit, HSN
   code, GST rate and MRP. HSN and GST rate flow onto every invoice and into GST returns.
2. **Locations** (1 head office + 2 warehouses + 3 outlets) — each with GSTIN and
   state, which is what makes GST classification possible.
3. **Parties** — 19 customers, 2 vendors. Each gets its own accounting ledger
   automatically, so balances are always traceable to a named party.
4. **Chart of Accounts** — 71 ledgers. Standard accounts are auto-provisioned
   (Sales, Purchases, Output/Input GST, Sundry Debtors/Creditors, cash per location).

---

## 5. How the operational flows actually work

This section is the "connections" part. Each flow touches several modules at once.

### 5.1 A sale at the counter (Point of Sale)

One action fans out into six effects:

```
POS sale recorded
├── invoice number issued        (per-year sequence, never a row count)
├── stock reduced                at that location
├── batches consumed             oldest-expiry-first (FEFO)
├── stock ledger entry           append-only audit line
├── accounting effect derived    Sales + Output GST + Cash/Debtor
└── customer dues updated        if sold on credit
```

Payment mode decides the money side:
- **Cash / UPI / Card** — settled immediately, cash ledger increases.
- **Credit** — nothing collected now. The customer's ledger is debited, the amount
  appears in **Outstanding**, and the customer's credit limit is checked *before*
  the sale is allowed.

Discounts have two distinct meanings, which is an important accounting detail:
- **Line discounts** reduce the taxable value, so GST is charged on the reduced amount.
- **Bill-level coupon discounts** apply after tax.

### 5.2 A purchase from a vendor

```
Purchase bill recorded
├── stock increased (raw material / packing material)
├── batches created with cost
├── stock ledger entry
├── Input GST recorded          → claimable as input tax credit
└── vendor payable increased    → Sundry Creditors
```

### 5.3 A production batch

This is the only flow that *destroys* stock to *create* stock:

```
Production batch
├── raw + packing materials consumed  (reduced from Head Office stock)
├── finished goods produced           (added, with a new batch number)
├── wastage recorded
└── cost rolled up:
      material cost  = Σ (quantity × material cost)
      overhead       = material cost × overhead %
      total cost     = material + overhead
      cost per unit  = total cost ÷ good units produced
```

That cost-per-unit becomes the valuation basis for the finished goods, which is what
makes later profitability reporting meaningful.

### 5.4 A stock transfer (two-step, deliberately)

A transfer is **not** a single instant movement. It requires confirmation at both ends:

```
Step 1 — DISPATCH (sending location)
    stock leaves sender · status → In Transit

Step 2 — RECEIVE/APPROVE (receiving location)
    stock arrives at receiver · status → Received
```

Nothing is silently in two places at once, and nobody can push stock onto another
location without that location accepting it.

Transfers are also **GST-classified automatically** by comparing the GSTIN of the two
locations:
- Same legal entity → *internal*, no tax.
- Different GSTIN, same state → *intrastate*, CGST + SGST.
- Different state → *interstate*, IGST.

Journal entries are created at both dispatch and receipt.

### 5.5 A sales return

```
Sales return
├── stock returned to location  (batches restored)
├── stock ledger entry
├── refund issued or credit note raised
└── original sale's GST reversed
```

---

## 6. Inventory is tracked in three layers

Understanding this explains a lot of the system's behaviour:

| Layer | Role |
|-------|------|
| **Stock entries** (23 rows) | The authoritative quantity per item per location. The single source of truth for "how much do we have". |
| **Stock batches** (33 rows) | A lot-level layer *on top*: batch number, manufacture date, expiry date, unit cost. Enables expiry tracking and accurate costing. Consumed oldest-expiry-first. |
| **Stock ledger** (6 rows) | Append-only history of every movement, with running balance computed at read time. Never edited — this is the audit trail. |

If batch detail is incomplete for some older stock, consumption falls back to an
"Untracked" bucket rather than blocking the transaction. Quantities always stay correct.

A database-level constraint prevents stock from ever going negative.

---

## 7. The accounting engine — the most important design decision

**Sales and purchases do not store journal entries.**

Instead, there is a single function that *derives* the double-entry postings from the
operational documents whenever the books are read. It unifies six sources:

| # | Source | Posting |
|---|--------|---------|
| 1 | Payments | Dr paid-to ledger / Cr paid-from ledger |
| 2 | Receipts | Dr received-into / Cr received-from |
| 3 | Journal voucher lines | As stored (journal, contra, credit note, debit note) |
| 4 | Direct expenses | Dr expense ledger / Cr cash or bank |
| 5 | **Sales** | Cr Sales (net) + Cr Output GST (CGST/SGST/IGST split) / Dr cash or customer |
| 6 | **Purchases** | Dr Purchases + Dr Input GST / Cr vendor |

### Why this matters

Because Day Book, Cash Book, Bank Book, Trial Balance, and the GST reports **all read
from that one builder**, they can never disagree with each other or with operations.
There is no "posting" step to forget, no sync job to fail, and no way for the books to
drift from the stock and sales records.

This is why the trial balance balances after *every* entry — it is arithmetically
guaranteed, not periodically repaired.

### One subtlety worth knowing

When a sale is made, a receipt row is also stored. Those sale-linked receipts are
**deliberately excluded** from source #2, because source #5 already derives the correct
postings from the sale itself. Including both would double-count the revenue.

### Voucher numbering

Every voucher type has its own financial-year sequence (`JV/2026-27/0001`,
`CTR/2026-27/0001`, `PAT/2026-27/0003`, `SR/2026-27/0001`…). Numbers come from a
dedicated sequence table — never from counting existing rows, which would reuse numbers
after a deletion.

### Manual entries

Four voucher types are entered by hand at **Accounts → Vouchers**:
- **Journal** — any adjustment. Rejected unless debits equal credits.
- **Contra** — moving money between cash and bank.
- **Credit Note** — reduce what a customer owes.
- **Debit Note** — reduce what you owe a vendor.

---

## 8. GST handling

Built for Indian compliance throughout, not bolted on:

- Every item carries an HSN code and a GST rate.
- Every location carries a GSTIN and state, which determines CGST/SGST vs IGST.
- **Output GST** is captured on sales; **Input GST** on purchases.
- All tax arithmetic goes through one shared function, so invoices, the GST summary
  and GSTR-3B can't compute tax differently.
- GSTR-1 and GSTR-3B are prepared from the same derived postings as the books.

---

## 9. HR and payroll

```
Employee → Attendance (hours) → Payroll (draft → approved → paid)
                ↑                        ↓
          Leave approval        Advances auto-deducted
```

Payroll is not a spreadsheet — approving it **posts to the books** through dedicated
per-employee ledgers (salary payable, salary paid, advances), so wage costs appear in
the trial balance like any other expense.

---

## 10. Security and access control

Two independent layers:

**1. Permissions — what you can *see and do***
41 modules, each grantable per role, with separate view/create/edit/delete rights.
94 permission rows are currently configured. Default is **deny** — a new role sees
nothing until access is granted. Permission level 1 (owner) always has full access.

**2. Location scoping — what *data* you get**
Enforced on the server. An outlet user's queries are filtered to that outlet; they
cannot retrieve another location's data even by manipulating the request.

**Also in place:** passwords hashed with bcrypt, forced password change on first
login, login rate limiting, signed session tokens, an audit log of changes (21
entries), and login history (5 attempts recorded).

---

## 11. Current data state

| Area | Records |
|------|---------|
| Sales | 50 |
| Customers | 19 |
| Purchases | 6 |
| Production batches | 4 |
| Stock transfers | 14 |
| Stock entries / batches | 23 / 33 |
| Account ledgers | 71 |
| Journal vouchers | 6 (12 lines) |
| Payments / Receipts | 3 / 2 |
| Employees | 3 |
| Permission rows | 94 |

**Trial balance: ₹2,61,837.43 debit = ₹2,61,837.43 credit.**

---

## 12. Verified working

All 20 entry flows were tested end-to-end through the browser: POS sale, purchase,
production batch, stock transfer (dispatch *and* receive), sales return, journal
voucher, unbalanced-journal rejection, contra, payment, receipt, credit note, debit
note, leave apply/approve, attendance, advance, payroll generate/approve, coupon,
item price, head-office expense, location expense. The trial balance stayed balanced
throughout.

---

## 13. Known gaps

Honest list of what is *not* built:

- **Bill of Materials templates** — the table exists but is empty, so production
  doesn't yet validate materials against a standard recipe.
- **Coupon rules** — coupons support percentage/fixed and a validity window, but not
  minimum-purchase or maximum-usage limits. There is nowhere to store those yet.
- **Opening balances** — the table exists but is unpopulated, so the books start from
  first transaction rather than from prior accounts.
- **Purchase returns** — table exists, flow not built.
- **Some generated API type definitions are stale.** They under-declare fields the
  server genuinely returns. This is cosmetic and does not affect behaviour, but it
  means those type definitions should not be trusted as documentation.
