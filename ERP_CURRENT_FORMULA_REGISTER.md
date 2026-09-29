# Frozen Fruits ERP — Current Formula Register

**Audit status:** IN PROGRESS — Phases 1–6 partial
**Snapshot date:** 2026-09-29
**Verified formula/algorithm groups:** 32 (partial audit; not a total count of all ERP formulas)
**Production database:** NOT QUERIED

No formula is recorded as verified until its current implementation and inputs are traced. Test filenames below were inspected but the tests were not executed in this documentation pass. Prior documents and memory are discovery aids, not proof.

## Verified formula and algorithm groups

| ID | Formula / algorithm in current source | Source | Notes / caveats |
|---|---|---|---|
| F-001 | P&L `revenue = salesGroup + directIncome`; `COGS = openingStock + purchases + directExpenses - closingStock`; `grossProfit = revenue - COGS`; margin = `round2(part / revenue * 100)` or zero when `abs(revenue) < 0.005`. Transfer-in/out nodes are excluded from operating groups. | `artifacts/api-server/src/lib/books.ts:1293-1316` | Sales and expense groups already contain their posting/return treatment. |
| F-002 | `totalExpenses = opening + purchases + directExpenses + indirectExpenses`; `totalIncomes = sales + closingStock + directIncome + indirectIncome`; `netProfit = totalIncomes - totalExpenses`. | `artifacts/api-server/src/lib/books.ts:1306-1311` | Transfer-in/out accounts are stripped before these totals. |
| F-003 | Cumulative BS: `retainedEarnings = cumulativeIncome + closingStock - cumulativeExpense`; `assets = fixedAssets + currentAssets + closingStock`; `liabilities = capital + loans + currentLiabilities + retainedEarnings`; difference = `assets - liabilities`. | `artifacts/api-server/src/lib/books.ts:1318-1353` | Opening balances are outside the derived-posting stream and are included cumulatively. |
| F-004 | Transfer boundary adjustment = period transfer movements + closing in-transit value − opening in-transit value. | `artifacts/api-server/src/lib/books.ts:204-221,511-557` | Transfer-In/Out ledger balances are stripped from operating P&L totals; dated stock boundaries carry the transfer value once. |
| F-005 | Sale posting: revenue credit = `total_amount - tax_total - valid other_charges`; output GST is split only when heads agree with stored tax within ₹0.05, otherwise posted to Duty & Tax. Customer-control debit is the full invoice total; collection legs post against their effective cash/clearing/destination ledger. | `artifacts/api-server/src/routes/journal.ts:1325-1603` | Sale-linked receipts are excluded from ordinary receipt derivation to avoid duplicate money. Cancelled ordinary sales are omitted; branch-transfer invoices remain until their reversal-note path. |
| F-006 | Purchase posting: where GST heads exist and agree with line/document tax within ₹0.05, debit Purchases for `amount - inputTax`, debit input GST heads, and credit vendor for bill amount plus other charges. Otherwise debit the full amount to Purchases. Each valid other charge is a separate expense debit. | `artifacts/api-server/src/routes/journal.ts:1620-1694` | Purchase stock cost is separately based on taxable goods value net of GST/discount in `routes/purchases.ts:822-900`; other charges are not stock cost. |
| F-007 | `lineTaxHeads`: use stored CGST/SGST/IGST when present; otherwise, for a positive legacy tax amount, all goes to IGST for `igst`/`inter`; otherwise CGST = rounded half and SGST = exact remainder. | `artifacts/api-server/src/lib/gst.ts:1-44` | Valid GST slabs are 0%, 5%, 12%, 18%, 28%. |
| F-008 | GSTR-3B ITC set-off order: IGST credit → IGST, then CGST, then SGST; CGST credit → CGST then IGST; SGST credit → SGST then IGST. | `artifacts/api-server/src/routes/gst.ts:783-799` | Negative purchase-note ITC first increases the corresponding liability. |
| F-009 | Sale position: `amountDue = round2(invoiceTotal - creditAdjustments)`; `rawOutstanding = round2(amountDue - amountReceived)`. Cancelled sales report zero outstanding and overpaid. Otherwise outstanding is positive raw value above ₹0.005; overpaid is positive negative-raw value beyond the same tolerance. | `artifacts/api-server/src/lib/salePaymentPosition.ts:69-104` | The helper also derives paid/unpaid/partially-paid state from money, not payment mode. As-of variants cap payments and returns by business date (`:140-193`). |
| F-010 | Available stock = `round3(max(0, stock_entries quantity - active reservations))`. | `artifacts/api-server/src/routes/stock.ts:279-308` | `hold` reduces availability; `in_transit` is already deducted and is not subtracted again. |
| F-011 | Live valuation prefers the latest dated product/location checkpoint (checkpoint value ÷ quantity, otherwise checkpoint unit cost), then master average cost and manual cost. Historical readers differ: the stock-valuation `asOf` path uses dated checkpoints and movements and excludes incomplete evidence; historical P&L/Balance Sheet rewinds current quantity, uses the checkpoint when present, otherwise falls back to current master cost while marking the result unreliable. | `artifacts/api-server/src/lib/valuation.ts:87-119,224-317`; `artifacts/api-server/src/routes/inventory-batches.ts:288-316`; `artifacts/api-server/src/lib/books.ts:642-657,742-904,1182-1226,1423-1454` | The valuation route disables transit for `asOf`; historical statement valuation adds sender-owned in-transit stock. Numeric parity is NOT VERIFIED. |
| F-012 | On-hand row value = `round2(quantity × rawUnitCost)`; an as-of row with checkpoint value uses that checkpoint value. Available = `round3(max(0, quantity - reserved))`. Display unit cost is rounded separately from value multiplication. | `artifacts/api-server/src/lib/valuation.ts:307-339` | Product identity includes product kind and location. |
| F-013 | In-transit value uses dispatched unit cost, not mutable master cost. Multiple transit rows blend unit cost as weighted average `(oldQty × oldCost + newQty × newCost) / (oldQty + newQty)`, rounded to four decimals; grand total = on-hand value + in-transit value. | `artifacts/api-server/src/lib/valuation.ts:342-399,445-498` | Missing positive dispatch cost is excluded and reported as incomplete evidence. |
| F-014 | FEFO allocation: order positive lots by `expiry_date ASC NULLS LAST, id ASC`; per lot, available = `round3(max(0, lot quantity - reserved))`; take = `min(available, remaining)` and round remainder to three decimals. | `artifacts/api-server/src/lib/batches.ts:82-110` | Explicit selected batches are handled before FEFO in `:113-218`; residual may remain untracked. |
| F-015 | Production: `materialCost = round2(rawMaterialCost + packingMaterialCost)`; `overhead = round2(materialCost × overheadPercent / 100)`; `totalCost = round2(materialCost + overhead + labour)`; `costPerUnit = round4(totalCost / goodUnits)` when good units and cost are positive; `wastageValue = round2(totalCost × wastageQty / (goodUnits + wastageQty))`. Daily labour pool is allocated by produced quantity; the last batch absorbs rounding. | `artifacts/api-server/src/lib/productionCosting.ts:218-275` | Helper math traced; all route callers and business scenarios remain pending. |
| F-016 | Attendance day contribution: explicit present = 1 workday; explicit half-day = 0.5 work + 0.5 casual leave; for punch days, closed-session hours at/above full threshold = 1, at/above half threshold = 0.5 work + 0.5 casual leave, below half = 0. Holidays, weekly offs and leave use configured policy. | `artifacts/api-server/src/lib/attendanceFactor.ts:291-331` | Defaults are 9h full and 4.5h half; company settings may configure them. Punch duration sums closed sessions, not first-in to last-out span. |
| F-017 | Month payable days = `min(calendarDays, worked + paidOff + min(casualLeave, casualAllowance) + min(sickLeave, sickAllowance))`; if LOP is enabled, LOP = `max(0, calendarDays - payableDays)`, otherwise payable = calendar days and LOP = 0. | `artifacts/api-server/src/lib/attendanceFactor.ts:426-483` | Uses actual calendar-month length. Empty-month behavior differs before/after attendance cutover and when LOP is disabled. |
| F-018 | Payroll: LOP = `max(0, workingDays - presentDays)`; per-day basic = `baseSalary / workingDays`; effective basic = base salary less rounded LOP deduction. Gross = effective basic + allowances. PF applies to effective basic; ESI applies to gross. Net = `round2(max(0, gross - employee deductions))`; employer cost = gross + employer PF + employer ESI. | `artifacts/api-server/src/routes/hr.ts:646-722` | Rates are configurable; defaults are not legal certification. Fixed and percentage allowances/deductions are rounded per component. |
| F-019 | Daily salary accrual: cumulative payable = capped cumulative work + paid-off days + capped casual/sick allowances; expected amount = monthly basic less rounded LOP against the unrounded daily rate; each stored daily amount = rounded expected-to-date − prior expected-to-date. | `artifacts/api-server/src/lib/salaryAccrual.ts:540-604` | Actual calendar days form the monthly basis. Cumulative differences avoid per-day rounding drift; locked/closed cases are skipped. |
| F-020 | Asset purchase: `taxable = round2(quantity × acquisitionCost)`; computed GST = `round2(taxable × GST rate / 100)`; total asset cost = taxable + accepted GST. GST is capitalized in this path. | `artifacts/api-server/src/routes/assets.ts:331-348,450-510` | Supplied GST is subject to route validation. |
| F-021 | Monthly straight-line depreciation = `round2(totalCost / usefulLifeMonths)`, capped at `round2(max(0, totalCost - previouslyPosted))`; one run per asset/month is enforced. | `artifacts/api-server/src/routes/assets.ts:1090-1197` | No salvage value or day-proration was found. No depreciation-specific automated test was identified in the inspected test search. |
| F-022 | Disposal book value = `round2(max(0, grossCost - min(grossCost, max(0, accumulatedDepreciationThroughDisposalMonth))))`. | `artifacts/api-server/src/routes/assets.ts:959-1085` | Disposal date is not itself depreciated unless a run for that month has already been posted; statutory intent is NOT VERIFIED. |
| F-023 | Exclusive GST: `taxable = round2(gross)`; `tax = round2(taxable × rate / 100)`. Inclusive GST: `taxable = round2(gross / (1 + rate/100))`; `tax = round2(gross - taxable)`. Intra-state splits already-rounded tax in paise: CGST gets the floored half and SGST the remainder; inter-state uses IGST. | `artifacts/api-server/src/routes/sales.ts:72-107` | Inclusive is the historical default; explicit `priceMode: "exclusive"` uses taxable-base input. |
| F-024 | Sale per-unit discount is `round2(unitDiscount × quantity)`; legacy `discount` is line-total. Bill discount is allocated in integer paise by largest remainder, capped by each line basis. `sale total = round2(subtotal + taxTotal - couponDiscount + otherChargesTotal)`. | `artifacts/api-server/src/routes/sales.ts:234-337,898-937` | Coupon is post-tax and cannot exceed subtotal + tax. Sale charges are paise-clean, add to total and have no GST. |
| F-025 | Purchase line: `lineSubtotal=round2(qty×unitCost)`; `discount=round2(lineSubtotal×discountPct/100)`; `net=lineSubtotal-discount`; inclusive tax extracts taxable as `round2(net/(1+gst/100))`, exclusive uses net as taxable and adds calculated tax. Bill raw total is `round2(taxableTotal+taxTotal)`, goods `totalAmount=Math.round(rawTotal)` (whole rupee), and `roundOff=round2(totalAmount-rawTotal)`. | `lib/purchase-pricing/src/index.ts:146-199,267-287`; API caller `artifacts/api-server/src/routes/purchases.ts:698-721` | API purchase other charges are outside goods total and purchase inventory cost; payable includes goods total + charges. API does not pass charge total to the optional inward-charge allocator. |
| F-026 | Return line prorating uses `fraction = returnedQty / soldOrPurchasedQty`; taxable and each GST head are individually `round2(storedLineValue × fraction)`; line tax is the sum of rounded heads and gross is rounded taxable + tax. | `artifacts/api-server/src/routes/returns.ts:308-316,1243-1268` | Return quantity is capped by prior returns. Sale and purchase other charges are excluded from return amounts; sale stock/batches are restored and purchase stock/lots are reduced. |
| F-027 | Explicit bill allocation amounts are money-rounded to two decimals and cannot exceed the voucher. `advance = money2(voucherAmount - sum(allocations))`. Vendor payment allocations cap against bill goods total + other charges; unapplied amount remains vendor advance. | `artifacts/api-server/src/routes/accounts.ts:987-1022,1287-1421` | Payables are ledger-authoritative; unallocated relief is applied FIFO after explicit allocations/advance applications. |
| F-028 | Ledger raw net = Σ(debit − credit). Natural display: vendor payable = `−net`; customer receivable = `+net`; cash/bank = `+net`. A subtree balance sums its descendants. | `artifacts/api-server/src/lib/ledgerBalances.ts:34-46,119-186,239-300` | Opening balances are converted to debit/credit postings; location slices intentionally exclude company-level openings in this index. |
| F-029 | Cash/Bank Book opening = pre-window Σ(Dr−Cr); running/closing = opening + in-window Σ(Dr−Cr), after authorized location filtering. Trial Balance shows positive net on debit and negative net on credit; it is balanced when `abs(totalDebit-totalCredit) < 0.01`. | `artifacts/api-server/src/routes/journal.ts:1939-2047,2098-2169` | Cash/Bank Book has a branch-only special rule for authorized ledger openings under location filter; opening entries are not bank-reconciliation eligible. |
| F-030 | Bank review batch selected gross = Σ abs(Dr−Cr); processing charge may not exceed gross; selected net = gross − charge. Reconciliation identity is exact `(ledger_id, entry_id)` and a batch updates metadata/status rather than creating accounting postings. | `artifacts/api-server/src/routes/reconciliation.ts:1237-1240,1580-1597,1635-1697,1726-1756` | This is internal posting review, not a bank-statement closing-balance reconciliation; no external statement ending-balance formula was found in the inspected path. |
| F-031 | Legacy dashboard `totalSalesAmount` = `SUM(sales.total_amount)` over the dashboard's filtered sales set; the source excludes cancelled and branch-transfer sales. `total_amount` is the invoice total including GST and sale charges. | `artifacts/api-server/src/routes/dashboard.ts:163-168,200`; invoice total in `routes/sales.ts:898-937` | Gross invoice turnover is not P&L net-of-GST revenue. Dashboard BI GP/NP/COGS use `buildBooks()`; do not compare its profit figures to this gross sales tile as though the bases match. |
| F-032 | Dashboard BI operating expenses = canonical `buildBooks()` direct-expense total + indirect-expense total, with production overlay excluded. Salary and rent subtrees are separately derived; dashboard “other” expense = total operating expenses − salary − rent. | `artifacts/api-server/src/lib/dashboardFinancials.ts:350-400`; canonical group totals `src/lib/books.ts:1293-1316` | Reuses the P&L group totals rather than re-summing an unrelated expense subtree. The split is a dashboard presentation, not a new posting. No tests were run in this audit. |

“Verified” means source traced, not tests executed or legal/accounting correctness certified.

## Relevant test suites found (not executed)

- `artifacts/api-server/tests/accounting.test.mjs`
- `artifacts/api-server/tests/accounting-audit-acceptance.test.mjs`
- `artifacts/api-server/tests/stock-dating.test.mjs`
- `artifacts/api-server/tests/stock-valuation-location-cost.test.mjs`
- `artifacts/api-server/tests/stock-transfer-receiving.test.mjs`
- `artifacts/api-server/tests/balance-reconciliation.test.mjs`
- `artifacts/api-server/tests/gst.test.mjs`
- `artifacts/api-server/tests/gst-recon-b2c.test.mjs`
- `artifacts/api-server/tests/sales-report-definition.test.mjs`
- `artifacts/api-server/tests/lop-payroll.test.mjs`
- `artifacts/api-server/tests/salary-accrual.test.mjs`
- `artifacts/api-server/tests/payroll-autocalc.test.mjs`
- `artifacts/api-server/tests/assets.test.mjs` — disposal coverage found; no depreciation-specific test identified.
- `artifacts/api-server/tests/sales-pricing.test.mjs` — GST modes and paise behavior.
- `artifacts/api-server/tests/sale-discounts.test.mjs` — discount allocation and legacy line semantics.
- `artifacts/api-server/tests/bill-settlement.test.mjs` — customer/vendor allocations and advances.
- `artifacts/api-server/tests/location-returns.test.mjs` — sale/purchase returns and location effects.
- `artifacts/api-server/tests/balance-reconciliation.test.mjs` and `location-books.test.mjs` — books and balance parity assertions.
- `artifacts/api-server/tests/cash-bank-locations.test.mjs` and `dashboard-parity.test.mjs` — availability and dashboard/report parity assertions.

## Remaining formula audit backlog

The following areas still need full route-to-reader coverage:

| Area | Formula families to trace | Status |
|---|---|---|
| Sales / POS | line subtotal, discount/coupon, charges, invoice total and route callers; profitability and all report definitions | PARTIAL |
| Purchases / returns | line pricing, return caps/reversals, bill settlement and vendor outstanding readers | PARTIAL |
| Financial statements | canonical `/accounts/financial-statements` feeds Reports Center and Chart of Accounts; Chart has a separate monthly endpoint; compare presentation, drilldowns and exports | PARTIAL — route-to-consumer chain is now source-mapped; rendered, monthly and export parity remain NOT VERIFIED |
| Balance Sheet / ledgers | cash/bank and party controls across every report and location path; retained-earnings/closing-stock presentation and location slices | PARTIAL — shared engine is mapped; parallel readers, drilldowns and exports are not exhaustively compared |
| GST | full GSTR/register/reconciliation/export parity and edge cases | PARTIAL |
| Inventory | ageing, all stock list/report readers, adjustment/verification, every writer, and historical stock valuation parity across report and statements | PARTIAL — the live valuation and distinct historical report/P&L paths are source-mapped; remaining writers/readers and numeric parity are NOT VERIFIED |
| Transfers / production | all transfer posting cases and production route callers of cost helpers | PARTIAL |
| Fixed assets | report parity and depreciation/disposal test evidence | PARTIAL |
| Payroll | payments/advances, statutory applicability and all payroll reports | PARTIAL |
| Dashboard | reconcile direct operational tiles, gross `totalSalesAmount`, and financial KPIs to their named reports across date/location scopes | PARTIAL |

## Formula record template

Each verified formula will get a stable ID and include:

- Formula name and exact expression/algorithm in code.
- Source file, function and line range at audit time.
- Inputs, rounding/paise behavior and output.
- Accounting, inventory, GST and location effects.
- Screens/reports/exports consuming the value.
- Related tests and verification result.
- Known alternative implementations or mismatches.

**DOCUMENTATION PROGRESS:** 32 source-backed groups recorded. Remaining items are coverage work, not a claim that unlisted code contains no other formulas.