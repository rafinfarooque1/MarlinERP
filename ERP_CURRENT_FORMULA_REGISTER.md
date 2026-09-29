# Frozen Fruits ERP — Current Formula Register

**Audit status:** IN PROGRESS — Phase 1 only  
**Snapshot date:** 2026-09-29  
**Verified formulas:** 0 in this phase  
**Production database:** NOT QUERIED

No formula is recorded as verified until its current implementation, inputs, output consumers and relevant tests are traced. Prior documents and memory are discovery aids, not proof of a formula.

## Formula audit backlog

The following formula families are in scope. Each remains **NOT VERIFIED** until Phase 2 or its owning module phase:

| Area | Formula families to trace | Status |
|---|---|---|
| Sales / POS | line subtotal, discount/coupon, other charges, GST split, grand total, paid, outstanding, COGS, profit | NOT VERIFIED |
| Purchases / returns | taxable goods value, discounts, other charges, GST, bill total, vendor outstanding, stock cost | NOT VERIFIED |
| Financial statements | net sales, purchase/return presentation, opening/closing stock, COGS, gross profit and margin, net profit and margin | NOT VERIFIED |
| Balance Sheet / ledgers | natural-side balances, assets/liabilities/equity, retained earnings, receivables, payables, cash and bank | NOT VERIFIED |
| GST | taxable value, CGST, SGST, IGST, output/input tax, return/reconciliation totals | NOT VERIFIED |
| Inventory | quantity, available quantity, stock value, weighted average, batch/FEFO consumption, in-transit value, ageing | NOT VERIFIED |
| Transfers / production | transfer value and postings, raw-material consumption, labour, overhead, batch total and unit cost | NOT VERIFIED |
| Fixed assets | depreciation, accumulated depreciation, net book value, disposal gain/loss | NOT VERIFIED |
| Payroll | attendance factors, LOP, gross/net pay, statutory deductions, advances, salary accrual/payment | NOT VERIFIED |

## Formula record template

Each verified formula will get a stable ID and include:

- Formula name and exact expression/algorithm in code.
- Source file, function and line range at audit time.
- Inputs, rounding/paise behavior and output.
- Accounting, inventory, GST and location effects.
- Screens/reports/exports consuming the value.
- Related tests and verification result.
- Known alternative implementations or mismatches.

**DOCUMENTATION PROGRESS:** Formula tracing has not started. Do not treat the backlog above as discovered or counted formulas.