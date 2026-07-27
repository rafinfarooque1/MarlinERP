# Marlin Frozen Fruits ERP — Business Process Document

**Version:** Post-Task-80  
**Date:** July 2026  
**Status:** Current implementation — read-only reference

---

## Table of Contents

1. [Business Overview](#1-business-overview)
2. [Organisation Structure](#2-organisation-structure)
3. [Purchase Process](#3-purchase-process)
4. [Production Process](#4-production-process)
5. [Inventory & Stock Management](#5-inventory--stock-management)
6. [Stock Transfers](#6-stock-transfers)
7. [Sales & Point of Sale](#7-sales--point-of-sale)
8. [Sales Returns](#8-sales-returns)
9. [Customer Credit & Outstanding](#9-customer-credit--outstanding)
10. [Accounts & Bookkeeping](#10-accounts--bookkeeping)
11. [GST Compliance](#11-gst-compliance)
12. [Payment Reconciliation](#12-payment-reconciliation)
13. [HR — Employees, Attendance, Payroll, Leave](#13-hr--employees-attendance-payroll-leave)
14. [Reports](#14-reports)
15. [Company Administration](#15-company-administration)
16. [End-to-End Business Flow](#16-end-to-end-business-flow)

---

## 1. Business Overview

Marlin Frozen Fruits manufactures and distributes frozen fruit products.

**Supply chain summary:**
```
Vendor → Purchase (raw materials/packaging) → Production (batching)
       → Warehouse (finished goods stock)
       → Transfer → Outlet (distribution point)
       → POS Sale (retail / B2B) → Cash/UPI/Card/Credit collection
       → Accounts (double-entry bookkeeping) → GST Returns
```

**Three branch types:**

| Branch Type | Data Scope | Typical Users |
|---|---|---|
| Head Office (HO) | Sees all warehouses and outlets | Management, accountants, production staff |
| Warehouse | Sees own warehouse + child outlets | Warehouse manager, store keeper |
| Outlet | Sees only own outlet | Sales staff, cashier |

---

## 2. Organisation Structure

### 2.1 Location Hierarchy

```
Head Office
├── Warehouse A
│   ├── Outlet A1
│   └── Outlet A2
├── Warehouse B
│   └── Outlet B1
└── (Direct outlets — orphans with no parent warehouse)
```

- Warehouses hold bulk finished-goods stock post-production.
- Outlets are retail/distribution points that receive stock from their parent warehouse.
- Head Office manages all locations, accounting, and reporting.

### 2.2 Role Hierarchy

Roles are defined in **HR → Hierarchy** with a numeric `level`:

| Level | Description |
|---|---|
| 1 | Management — full access to everything |
| 2–N | Custom roles — access only to modules explicitly granted |

Each employee is assigned:
1. A hierarchy level (role)
2. A branch type (`headoffice` / `warehouse` / `outlet`)
3. A branch ID (which specific warehouse or outlet)

These two assignments are independent but currently stored in the same employee record.

### 2.3 Default Users

On first startup the system seeds:
- **Username:** `admin` | **Password:** `marlin1458` | **Level:** 1 (Management)
- `must_change_password = true` is set — admin must change password on first login

---

## 3. Purchase Process

### 3.1 What Is Purchased

Marlin purchases three categories of inputs:

| Category | Table | Used In |
|---|---|---|
| Raw Materials | `raw_materials` | Production (e.g. whole fruit) |
| Materials / Packaging | `materials` | Production (e.g. boxes, bags, stickers) |
| Finished Goods | `items` | Direct resale without production |

### 3.2 Purchase Workflow

```
1. Raise purchase order → POST /purchases
   Input: vendor, date, warehouse, line items [{materialType, materialId, qty, rate, taxRate}]

2. System calculates:
   • subtotal = Σ(qty × rate)
   • tax_total = Σ(qty × rate × taxRate / 100)
   • total_amount = subtotal + tax_total − discount_total + round_off

3. Stock update:
   • stock_entries[warehouse][material] += quantity (upsert)
   • stock_ledger entry appended (type='purchase')

4. Weighted-average cost update:
   new_avg_cost = (existing_stock × old_avg + purchase_qty × purchase_rate) / (existing_stock + purchase_qty)
   → updates materials.avg_cost / raw_materials.avg_cost

5. GST input credit ledgers auto-posted (if tax_rate > 0):
   DR STD-INP-CGST / STD-INP-SGST / STD-INP-IGST (Input Tax Credit)
   CR STD-PUR (Purchase expense)

6. Vendor ledger (VEND-{id}) credited for the total payable
```

### 3.3 Purchase Return

When goods are returned to vendor:
- Stock is reduced
- WAC recalculated
- Reverse accounting entries created
- Voucher number format: `PR/FY/NNNN`

### 3.4 Key Rules

- GST rates must be valid slabs: 0%, 5%, 12%, 18%, 28%
- HSN codes are stored on materials and items
- A vendor ledger (`VEND-{id}` under Sundry Creditors) is auto-created when a vendor record is created
- Purchases cannot be deleted if linked accounting entries exist

---

## 4. Production Process

### 4.1 Overview

Production converts raw materials and packaging into finished goods (items). Each production run creates a **batch** with a batch number, expiry date, and quantity produced.

### 4.2 Bill of Materials (BOM)

Each finished item can have one BOM template:
```
BOM Template for "Mango 500g Pack":
  - Raw Material: Alphonso Mango    — 600g per unit
  - Material:     500g BOPP Bag     — 1 per unit
  - Material:     Cardboard Box     — 0.1 per unit (1 box per 10 packs)
```

BOM quantities are per **one unit** of finished output.

### 4.3 Production Batch Workflow

```
1. Manager creates production batch → POST /production
   Input: itemId, quantity, productionDate, expiryDate, warehouseId, lineItems (actual consumption), overheadPercent, wastage

2. System validates:
   • Warns if actual consumption exceeds BOM template quantities (NOT yet blocking)

3. Material deduction:
   • For each consumed material: stock_entries[warehouse][material] -= consumed_qty
   • stock_ledger entry (type='production', negative for materials)

4. Finished good addition:
   • stock_entries[warehouse][item] += quantity_produced
   • stock_batches row created:
     { warehouseId, itemId, batchNumber, quantity, costPerUnit, productionDate, expiryDate }
   • stock_ledger entry (type='production', positive for finished good)

5. Production costing (if material costs available):
   • material_cost = Σ(consumed_qty × avg_cost_of_material)
   • overhead_amount = material_cost × overhead_percent / 100
   • total_cost = material_cost + overhead_amount
   • cost_per_unit = total_cost / quantity_produced

6. Wastage recording:
   • wastage = [{materialId, qty, reason}]
   • wastage_qty and wastage_value stored on batch
```

### 4.4 Production Costing

- Production overhead % is set at company level (Company Settings)
- Per-batch overhead can be overridden
- Pre-existing batches have NULL cost fields (not retroactively costed)
- `cost_per_unit` flows into `stock_batches` for FEFO valuation

### 4.5 Production Reports

Production reports show:
- Total quantity produced per item and date range
- Material consumption vs BOM expected
- Wastage analysis
- Cost per unit trends

---

## 5. Inventory & Stock Management

### 5.1 Stock Architecture

Two complementary layers:

| Layer | Table | Purpose |
|---|---|---|
| Current quantity | `stock_entries` | One row per (location × item) — the live balance |
| Movement history | `stock_ledger` | Append-only audit trail — every movement recorded |
| Batch tracking | `stock_batches` | Per-batch quantities for FEFO |

### 5.2 Stock Entry Sources

| Movement Type | Direction | Triggered by |
|---|---|---|
| `production` | +item, −materials | Production batch creation |
| `purchase` | +material | Purchase order recording |
| `transfer_out` | −item | Transfer dispatch |
| `transfer_in` | +item | Transfer approval |
| `sale` | −item | Sale recording |
| `return` | +item | Sales return |
| `adjustment` | ± | Stock verification reconciliation |

### 5.3 FEFO (First Expired, First Out)

When stock is deducted (for sales or transfers), batches are consumed in **expiry-date order** (earliest expiry first):

```
consumeBatchesFEFO(location, itemId, requiredQty):
  batches = SELECT * FROM stock_batches
            WHERE location AND item_id = itemId
            ORDER BY expiry_date ASC NULLS LAST
  
  for each batch in order:
    take = min(batch.remaining_qty, remaining_required)
    deduct take from batch
    record {batchNumber, qty, costPerUnit}
    remaining_required -= take
  
  if remaining_required > 0:
    return untracked remainder (fallback for stock without batch records)
```

The `untracked` quantity handles stock that existed before batch tracking was introduced.

### 5.4 Item Pricing

Location-specific prices override the item's default MRP:

```
Price resolution order:
1. Exact match: item_prices WHERE item_id = X AND outlet_id = Y
2. Warehouse match: item_prices WHERE item_id = X AND warehouse_id = Z
3. Global: item_prices WHERE item_id = X AND outlet_id IS NULL AND warehouse_id IS NULL
4. Fallback: items.mrp
```

Prices support `valid_from` and `valid_to` date ranges.

### 5.5 Stock Verification

Physical stock count process:
1. Verifier opens stock verification page, selects location and date
2. System shows current system quantity per item
3. Verifier enters physical count
4. Discrepancy is calculated: `system_qty − physical_qty`
5. On submit, stock_entries are adjusted to match physical count
6. stock_ledger entry (type='adjustment') records the discrepancy

### 5.6 Stock Ledger (Audit Trail)

Running balance is calculated at query time using a SQL window function:
```sql
SELECT *, SUM(quantity_change) OVER (
  PARTITION BY item_id, warehouse_id, outlet_id
  ORDER BY created_at, id
) AS running_balance
FROM stock_ledger
WHERE ...
```

This means the ledger is always accurate even if old entries are viewed out of order.

---

## 6. Stock Transfers

### 6.1 Purpose

Transfers move finished goods from one location to another:
- Warehouse → Outlet (primary distribution flow)
- Outlet → Warehouse (returns to warehouse)
- Warehouse → Warehouse (inter-warehouse)
- Outlet → Outlet (inter-outlet)

### 6.2 Transfer Workflow

```
┌──────────────────┐   POST /stock/transfers   ┌──────────────────┐
│   HO / Warehouse │ ──────────────────────────▶│  status=in_transit│
│   initiates      │                            │  Source stock     │
│   transfer       │                            │  deducted (FEFO) │
└──────────────────┘                            └──────────────────┘
                                                         │
                                    PATCH .../approve or .../reject
                                                         │
                           ┌─────────────────┬───────────┴──────────┐
                           ▼                 ▼                       ▼
                     status=approved   status=rejected        Goods received
                     Dest stock +=     Source stock           accounting JVs
                     received qty      restored               created
```

### 6.3 Dispatch (Create)

1. Select: from location, to location, items + quantities
2. System picks FEFO batches automatically
3. Source `stock_entries` deducted immediately (goods are "in transit")
4. `stock_batches` at source deducted
5. Transfer record created with `status = 'in_transit'`

### 6.4 Approve (Receive)

1. Receiver confirms received quantities (`received_line_items` may differ from dispatched)
2. Destination `stock_entries` increased by received quantities
3. New `stock_batches` rows created at destination (preserving original batch numbers, expiry dates, cost_per_unit)
4. GST accounting JVs auto-created based on transfer classification:

| Transfer type | GST treatment |
|---|---|
| Same GSTIN (internal) | No GST — simple stock movement JV |
| Same state, different GSTIN (intrastate) | CGST + SGST entries |
| Different state (interstate) | IGST entries |

**Classification logic:**
```
fromGstin == toGstin → 'internal'
fromGstin.substr(0,2) == toGstin.substr(0,2) → 'intrastate'
else → 'interstate'
```

### 6.5 Reject

1. Transfer marked `status = 'rejected'` with rejection_reason
2. Source stock entries restored
3. Source stock_batches restored

### 6.6 Delivery Challan

On any in-transit or approved transfer, a PDF delivery challan can be generated showing:
- FROM and TO addresses
- Item list with quantities and batch numbers
- No prices (challan is a movement document, not a tax invoice)

---

## 7. Sales & Point of Sale

### 7.1 Sale Types

| Payment Mode | Description | Settlement |
|---|---|---|
| `cash` | Physical cash | Settled immediately at creation |
| `upi` | UPI transfer | Settled immediately at creation |
| `card` | Card payment | Settled immediately at creation |
| `credit` | Credit sale | Goes to outstanding; settled via sale_payments |

### 7.2 POS Workflow (Branch)

```
1. Open POS → Select items, quantities, customer (optional)
2. Apply coupon code (optional) → POST /validate-coupon
3. Select payment mode
4. Submit → POST /sales

Server processing:
5. GST calculation (inclusive MRP-based):
   rate = item.tax_rate
   taxable_value = line_amount × 100 / (100 + rate)
   tax_amount = line_amount − taxable_value
   
   If customer has GSTIN and buyer's state ≠ seller's state:
     igst = tax_amount   (interstate)
   Else:
     cgst = sgst = tax_amount / 2   (intrastate)

6. Credit limit check (credit sales only):
   total_outstanding = unpaid credit sales for this customer
   If total_outstanding + new_sale_total > customer.credit_limit:
     BLOCK sale (unless authorized_by is set)

7. Stock deduction (FEFO):
   consumeBatchesFEFO() for each line item

8. Accounting postings:
   cash/upi/card:
     DR [Outlet Cash] or [Outlet Bank]   CR STD-SALES
     DR STD-DTX                          CR STD-OUT-CGST/SGST/IGST
   credit:
     DR CUST-{customerId} (Debtor)       CR STD-SALES
     DR STD-DTX                          CR STD-OUT-CGST/SGST/IGST

9. invoice_number assigned (auto-generated sequential)
10. Return: { sale, invoiceNumber }
```

### 7.3 GST on Sales (Inclusive MRP)

All sales use **tax-inclusive pricing** (MRP includes GST). The system back-calculates:

```
taxable_value = mrp_line_total × 100 / (100 + gst_rate%)
tax_on_line   = mrp_line_total − taxable_value
```

Line discounts (item-level `discount` field) are applied **before** GST calculation:
```
discounted_amount = qty × rate × (1 − discount%)
tax = discounted_amount − (discounted_amount × 100 / (100 + rate))
```

Bill-level `discount_total` is a coupon discount applied **after** all line totals and taxes (post-tax coupon, stored on `sales.discount_total`).

### 7.4 Coupon Validation

```
Coupon rules:
• discount_type = 'percentage': discount = min(order_total × value%, max_discount)
• discount_type = 'fixed': discount = value
• min_order_value: order must meet threshold
• valid_from / valid_to: date range check
• is_active: must be active
```

### 7.5 Invoice PDF

On request (`GET /sales/:id/pdf` or `/public/invoices/{token}.pdf`):
- Company header with name, GSTIN, address
- Customer name, GSTIN, address
- Line items table: name, HSN, qty, rate, taxable value, CGST%, SGST%, IGST%, total
- GST summary table by tax rate
- Amount in words
- UPI QR code (outlet's `upi_id` field)
- Public sharing: HMAC-signed token URL, valid indefinitely

### 7.6 HO Sales (Warehouse Direct Sales)

Warehouse staff can create sales directly (same API, `location_type = 'warehouse'`). Accounting uses the warehouse's own sales ledger (`WH-SAL-{id}`) instead of outlet ledger.

---

## 8. Sales Returns

### 8.1 Workflow

```
1. Identify original sale
2. Select items to return (subset or full)
3. Specify refund method (cash/bank/credit note)
4. Submit → POST /sales-returns

Server processing:
5. Stock restoration:
   stock_entries += returned quantities
   stock_batches: new batch rows OR existing batch quantities increased
   stock_ledger entry (type='return')

6. Accounting reversal:
   DR STD-SALES (reverse revenue)
   CR [Outlet Cash] or CUST-{id}
   (GST reversal entries for tax heads)

7. Voucher number: SR/FY/NNNN
8. original_sale.payment_status recalculated
```

---

## 9. Customer Credit & Outstanding

### 9.1 Credit Limit Enforcement

```
On every credit sale:
  total_due = SUM(total_amount − amount_paid) FROM sales
              WHERE customer_id = X AND payment_mode = 'credit'
              AND payment_status IN ('unpaid', 'partially_paid')
  
  if total_due + new_sale_total > customer.credit_limit:
    → BLOCK (403 error with reason)
    
Exception: authorized_by field can be set (manager override)
```

A credit_limit of 0 means no limit enforced.

### 9.2 Outstanding Management

**Receivables:** Credit sales not yet fully paid  
**Collections:** Recent payments received against credit sales  
**Payables:** Unpaid vendor balances (from purchase vendor ledger balances)

### 9.3 Payment Collection

```
POST /sale-payments/:saleId
  Input: { paymentDate, method, amount, referenceNumber }
  
  Process:
  1. Validate: amount ≤ remaining_due
  2. Insert sale_payments row
  3. Update sales.amount_paid += amount
  4. Recalculate sales.payment_status:
     amount_paid == 0              → 'unpaid'
     amount_paid < total_amount    → 'partially_paid'
     amount_paid >= total_amount   → 'paid'
  5. Create receipt voucher:
     DR STD-ELEC-CLR (UPI/card) or [Outlet Cash] (cash)
     CR CUST-{id}
```

---

## 10. Accounts & Bookkeeping

### 10.1 Chart of Accounts

Tally-compatible double-entry Chart of Accounts:

```
Balance Sheet
├── Capital Accounts (SYS-CAP)
├── Loans (Liability) (SYS-LOAN)
├── Current Liabilities (SYS-CURL)
│   ├── Duty & Tax (STD-DTX)
│   │   ├── Output CGST (STD-OUT-CGST)
│   │   ├── Output SGST (STD-OUT-SGST)
│   │   └── Output IGST (STD-OUT-IGST)
│   └── Sundry Creditors (SYS-CREDITORS)
│       └── VEND-{n} (auto-created per vendor)
├── Fixed Asset (SYS-FIXD)
└── Current Asset (SYS-CURA)
    ├── Bank (STD-BANK)
    │   └── [user-created bank accounts]
    ├── Cash (STD-CASH)
    │   ├── WH-CASH-{n} (auto per warehouse)
    │   └── OUTLET-CASH-{n} (auto per outlet)
    ├── Sundry Debtors (SYS-DEBTORS)
    │   └── CUST-{n} (auto-created per customer)
    ├── Input CGST (STD-INP-CGST)
    ├── Input SGST (STD-INP-SGST)
    ├── Input IGST (STD-INP-IGST)
    ├── Electronic Payment Clearing (STD-ELEC-CLR)
    └── Cash in Transit (STD-CIT)

Profit & Loss
├── Sales (SYS-SAL / STD-SALES)
│   ├── WH-SAL-{n} (auto per warehouse)
│   └── OUTLET-SAL-{n} (auto per outlet)
├── Purchase (SYS-PUR / STD-PUR)
│   └── WH-PUR-{n} (auto per warehouse)
├── Direct Expense (SYS-DIREXP)
├── Indirect Expense (SYS-INDEXP)
│   └── Bank & Processor Charges (STD-PROC-CHG)
├── Direct Income (SYS-DIRINC)
└── Indirect Income (SYS-INDINC)
```

System groups (code prefix `SYS-` or `STD-`) are protected — they cannot be deleted or renamed by users.

### 10.2 Voucher Types

| Type | Prefix | Debit | Credit | Use |
|---|---|---|---|---|
| Payment | PAY | Vendor/expense ledger | Cash/Bank | Paying vendors, expenses |
| Receipt | REC | Cash/Bank | Customer/income | Collecting payments |
| Journal | JV | Any ledger | Any ledger | Adjustments, corrections |
| Contra | CTR | Cash ↔ Bank | Cash ↔ Bank | Cash deposit, withdrawal |
| Credit Note | CN | Sales | Customer | Reduce customer outstanding |
| Debit Note | DN | Vendor | Purchase | Reduce vendor outstanding |

### 10.3 Voucher Numbering

Format: `{PREFIX}/{FY-LABEL}/{NNNN}`  
Example: `JV/2026-27/0042`

Financial year label is calculated from company_settings.fy_start_month (default: April).  
Sequence is per prefix per FY, stored in `voucher_sequences` with atomic increment.

### 10.4 Books of Accounts

| Book | Source | Description |
|---|---|---|
| Day Book | All vouchers | Chronological list of every transaction |
| Cash Book | Payments + Receipts (cash ledgers) | Cash receipts and payments |
| Bank Book | Payments + Receipts (bank ledgers) | Bank transactions |
| Trial Balance | All ledgers | Debit/credit totals to verify balance |

### 10.5 Ledger Statement

For any account ledger:
1. Query all payments, receipts, journal entries referencing this ledger
2. Calculate opening balance (sum of all prior transactions)
3. Compute running balance using window function
4. Display: date, voucher number, narration, debit, credit, running balance

### 10.6 Expenses

Two types of expenses:
1. **Location Expenses** (Operations → Expenses): Daily operational expenses at a branch (cash, petty cash, rent, etc.) — stored in `expenses` table with outlet_id/warehouse_id
2. **Accounts Expenses** (Accounts → Expenses): HO-level view of all expenses across all locations

### 10.7 Cash Balance (Operations)

Branch-level view showing:
- Opening balance for the day
- All cash sales for the period
- All expenses paid
- Current cash on hand

Calculated from:
- `sales` filtered by location and date
- `expenses` filtered by location and date

### 10.8 Cash in Outlet (Accounts)

HO aggregate view:
- Lists each outlet's cash position
- Based on outlet cash ledger balance (`OUTLET-CASH-{id}`)
- Useful for daily cash reconciliation across all outlets

---

## 11. GST Compliance

### 11.1 GST Registration

Each warehouse and outlet stores its own GSTIN. The company GSTIN is in Company Settings.

### 11.2 GST on Sales

**Rate slabs enforced:** 0%, 5%, 12%, 18%, 28% (invalid rates blocked on item creation)

**Intrastate sale** (buyer and seller in same state — first 2 digits of GSTIN match):
```
CGST = tax_amount / 2
SGST = tax_amount / 2
IGST = 0
```

**Interstate sale** (B2B with GSTIN from different state):
```
CGST = 0
SGST = 0
IGST = tax_amount
```

**B2C sale** (no customer GSTIN): always treated as intrastate CGST+SGST.

### 11.3 GST on Purchases

Input Tax Credit tracked per purchase line:
- `STD-INP-CGST` / `STD-INP-SGST` / `STD-INP-IGST` ledgers credited on purchase
- These become the ITC asset available for set-off

### 11.4 GST on Transfers

Transfers between locations with different GSTINs trigger GST JVs (see §6.4):
- Intrastate: CGST + SGST on transfer value
- Interstate: IGST on transfer value
- Internal (same GSTIN): No GST, movement JV only

### 11.5 GSTR-1 (Outward Supplies)

Breakdowns generated from `sales` table:

| Section | Criteria | Fields |
|---|---|---|
| B2B | customer has gst_number | Invoice number, date, customer name, GSTIN, place of supply, value, tax |
| B2C | no customer GSTIN or walk-in | Aggregated by state and tax rate |

### 11.6 GSTR-3B (Monthly Summary)

```
Outward supplies:
  taxable_value = Σ(sale.subtotal) for period
  output_tax    = Σ(cgst + sgst + igst per sale)

Inward supplies (ITC):
  input_cgst = Σ(purchase CGST for period)
  input_sgst = Σ(purchase SGST for period)
  input_igst = Σ(purchase IGST for period)

Net payable computation (set-off order):
  1. IGST credit → offset IGST, then CGST, then SGST
  2. CGST credit → offset CGST, then IGST
  3. SGST credit → offset SGST, then IGST
  4. Remaining = cash payment due
```

### 11.7 HSN Summary

Groups all sales/purchases by HSN code and GST rate, showing:
- Total quantity, taxable value, CGST, SGST, IGST, total tax

### 11.8 GST Reconciliation

Compares actual GST in the COA ledger accounts against GST computed from invoices. Identifies discrepancies — amounts in `STD-DTX` (Duty & Tax) that don't match computed GSTR figures.

**Known limitation:** Credit notes and debit notes currently do NOT reduce GST returns — this overstates output tax.

---

## 12. Payment Reconciliation

### 12.1 Purpose

Reconciliation matches digital payment receipts (UPI, card) collected at outlets with actual bank settlements received from the payment processor.

### 12.2 Flow

```
Day 1 — Sale with UPI/Card:
  DR STD-ELEC-CLR (clearing)    CR CUST-{id} or STD-SALES

Day 2–3 — Bank settles amount (typically T+2 for UPI):
  Accountant creates reconciliation batch:
    → Selects pending UPI/card payments from sale_payments
    → Enters gross amount, processor charges, net amount, settlement date
    → Links to bank ledger

  Batch posting:
  DR STD-BANK (actual receipt in bank)
  DR STD-PROC-CHG (bank charges)
  CR STD-ELEC-CLR (clear the clearing account)
```

### 12.3 Cash Deposit

Cash collected at outlet is physically deposited at bank:
```
1. Outlet creates cash deposit record
2. System creates:
   DR STD-CIT (Cash in Transit)    CR OUTLET-CASH-{id}

3. When bank confirms receipt:
   DR STD-BANK                     CR STD-CIT
```

---

## 13. HR — Employees, Attendance, Payroll, Leave

### 13.1 Employee Master

Each employee record stores:
- Personal details (name, phone, email, address)
- Work details (role/hierarchy, branch assignment, salary, join date)
- Login credentials (username + bcrypt hash)
- Work experience history (JSONB array)

### 13.2 Role (Hierarchy) Assignment

- Each employee is assigned one hierarchy level
- Level 1 = full system access
- Level 2–N = access determined by permissions set on that level

### 13.3 Attendance

**Check-in / Check-out:**
- Employee records check-in time with geo-location (lat/lng)
- Check-out recorded similarly
- Attendance status: `present` / `absent` / `half_day`

**Absent auto-generation:**
- For any date where an employee has no attendance record, a synthetic `absent` row is generated at query time

### 13.4 Leave Management

```
Leave workflow:
1. Employee applies → POST /hr/leave (status = 'pending')
2. Manager approves or rejects → PATCH /hr/leave/:id/approve
   { approved: true/false, remarks }
3. Status updated to 'approved' or 'rejected'
```

Leave types are free-form text (e.g. "Casual Leave", "Sick Leave").

### 13.5 Payroll

**Monthly payroll generation:**

```
POST /hr/payroll/generate { month: 'YYYY-MM' }

For each active employee:
1. Count present days and absent days in the month
2. LOP (Loss of Pay) = approved-absent days
3. lop_deduction = (lop_days × base_salary) / working_days_in_month
4. effective_basic = base_salary − lop_deduction

5. Allowances:
   type='fixed'           → value as-is
   type='percent_of_basic'→ value% × effective_basic

6. Deductions:
   type='fixed'               → value as-is
   type='percent_of_basic'    → value% × effective_basic
   type='percent_of_gross'    → value% × gross

7. gross = effective_basic + total_allowances
8. net_pay = gross − total_deductions

9. Payroll record saved
10. Payslip PDF available immediately
```

**Payslip PDF** shows:
- Employee name, month, department
- Earnings breakdown (basic + allowances)
- Deductions breakdown
- LOP days and deduction
- Net pay

---

## 14. Reports

### 14.1 Report Centre

Located at `/reports/:cat`. Multi-tab centre with categories: Sales, Inventory, Production, Purchases.

### 14.2 Sales Reports

| Report | Description |
|---|---|
| Sales Summary | Total sales, tax, discount by date range and location |
| By Location | Hierarchical table: warehouse → outlets → subtotals → grand total |
| By Item | Top items by revenue and quantity |
| By Customer | Customer-wise sales with outstanding balance |
| GST Summary | Monthly GST collected (CGST/SGST/IGST breakdown) |
| Combined | Compact multi-metric panel |

Export: PDF (A4, tabular, zebra rows) and CSV.

### 14.3 Inventory Reports

| Report | Description |
|---|---|
| Stock Status | Current quantity per item per location |
| Low Stock | Items below reorder level |
| Expiry Alert | Batches expiring within configurable days |
| Movement | Stock in/out by date range |
| Valuation | Stock value at avg cost or MRP |

### 14.4 Production Reports

| Report | Description |
|---|---|
| Production Summary | Batches by item, quantity produced, total cost |
| Material Consumption | Actual vs BOM expected per item |
| Wastage Analysis | Wastage quantity and value by item/period |
| Cost per Unit Trend | Cost movement over time |

### 14.5 Purchase Reports

| Report | Description |
|---|---|
| Purchase Register | All purchase bills with vendor, amount, GST |
| Vendor-wise Summary | Total purchases per vendor |
| Item-wise Summary | Total purchased per material/raw material |
| ITC Summary | Input tax credit available per period |

### 14.6 Dashboard KPIs

The main Dashboard (`/`) shows:
- **Cash balance** — sum of all cash ledger balances (STD-CASH subtree)
- **Bank balance** — sum of all bank ledger balances (STD-BANK subtree)
- **Total sales (today/week/month)** — aggregated from `sales` table
- **Stock value** — sum(quantity × cost_price) from stock_entries
- **Attendance today** — employees who checked in today
- **Sales trend** — daily revenue chart (last 30 days)
- **Top-selling items** — by revenue
- **Sales by location** — bar chart per warehouse/outlet
- **Low stock alerts** — items below reorder level
- **Recent activity** — audit log feed

---

## 15. Company Administration

### 15.1 Company Settings

| Setting | Effect |
|---|---|
| Company name | Appears on invoices and reports |
| GSTIN | Used on invoices and GST reports |
| Address | Appears on invoices |
| FY start month | Determines financial year label for voucher numbering |
| Production overhead % | Default overhead for new production batches |

### 15.2 Permissions Management

Admin (level-1) configures what each hierarchy level can do:

1. Select hierarchy level from tabs
2. For each module: toggle View, Add, Edit, Delete, Download
3. Group master toggle: enable/disable all modules in a group
4. Save — writes all rows to `permissions` table atomically

**Modules are grouped as:** Operations, Production, Inventory, Sales (HO), HR, Accounts, Dashboard, Company.

**Rules:**
- Level 1 always has full access (checkboxes disabled in UI)
- Unchecking View automatically unchecks Add/Edit/Delete
- Checking any write action automatically checks View

### 15.3 Audit Log

Every sensitive action is recorded with:
- Employee who performed it
- Action type
- Entity type and ID
- Before/after snapshot (JSONB)
- Timestamp

### 15.4 Login History

Tracks all login attempts (success and failure) with:
- Username, IP address, timestamp, success flag

Useful for security monitoring.

---

## 16. End-to-End Business Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    COMPLETE BUSINESS CYCLE                               │
└─────────────────────────────────────────────────────────────────────────┘

PROCUREMENT
  Vendor supplies raw materials + packaging
       ↓
  Purchase recorded → stock increased → WAC updated → ITC ledgers posted
       ↓
  Vendor ledger (VEND-{id}) shows payable outstanding
       ↓
  Pay vendor → Payment voucher → Vendor ledger cleared

PRODUCTION
  Materials consumed (FEFO from oldest batches)
       ↓
  Finished goods batch created with batch number + expiry date
       ↓
  Costing applied (material cost + overhead%)
       ↓
  Stock entries updated at warehouse

DISTRIBUTION
  Transfer initiated (Warehouse → Outlet)
       ↓
  FEFO batch deducted at warehouse (in transit)
       ↓
  Transfer approved at outlet → stock added
       ↓
  If interstate: GST JVs auto-created

SALES
  Customer walks into outlet / warehouse sales staff creates order
       ↓
  Items selected, coupon applied, GST calculated (inclusive MRP)
       ↓
  Credit limit checked (credit sales)
       ↓
  Stock deducted (FEFO) → Stock ledger appended
       ↓
  Invoice generated with sequential number
       ↓
  Accounting: Sales ledger, GST output ledger, Cash/Debtor ledger posted

COLLECTION
  Cash/UPI/Card: settled at sale creation
  Credit: recorded in outstanding → collected via sale_payments
       ↓
  UPI/Card: reconciled via reconciliation batch (T+2 bank settlement)
  Cash: deposit recorded → Cash in Transit → Bank confirmed

ACCOUNTS CLOSE
  Accountant reviews:
  - Day Book / Cash Book / Bank Book
  - Trial Balance (debits = credits)
  - Ledger statements for each account
  - GST: GSTR-3B computed (output − ITC = payable)
       ↓
  GST payment: Payment voucher → STD-DTX cleared → Bank debited
       ↓
  Month close: Payroll generated → Salary expense + employee payables

REPORTS
  Management reviews:
  - Sales by location (warehouse → outlet hierarchy)
  - Production efficiency (consumption vs BOM)
  - Stock valuation and expiry alerts
  - Outstanding receivables and payables
  - GST returns (GSTR-1, GSTR-3B)
  - Profit & Loss (via Trial Balance)
```

### 16.1 Accounting Flow Diagram

```
Sale (Cash)                   Sale (Credit)
     │                              │
     ▼                              ▼
DR Outlet-Cash             DR CUST-{id}
CR STD-SALES               CR STD-SALES
DR STD-DTX                 DR STD-DTX
CR STD-OUT-CGST/SGST       CR STD-OUT-CGST/SGST

     │                              │
     │                    Customer pays later
     │                              │
     │                              ▼
     │                    DR STD-ELEC-CLR
     │                    CR CUST-{id}
     │                              │
     │                    Bank settles T+2
     │                              │
     │                              ▼
     └──────────────────▶ DR STD-BANK
                           DR STD-PROC-CHG
                           CR STD-ELEC-CLR
```

### 16.2 GST Flow

```
Purchase                      Sale
    │                           │
    ▼                           ▼
DR STD-INP-CGST           DR STD-DTX
   STD-INP-SGST            CR STD-OUT-CGST
CR STD-PUR                    STD-OUT-SGST

            GST Return
                │
                ▼
    Output tax (from sales)
  − Input tax credit (from purchases)
  = Net tax payable
                │
                ▼
    Payment voucher
    DR STD-DTX
    CR STD-BANK
```
