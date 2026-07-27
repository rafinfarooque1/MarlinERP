---
name: Payroll workflow
description: Three-state payroll workflow (draft→approved→paid), accounting entries, advances, and hours-based attendance scoring.
---

## Workflow states
- `draft` — generated, not yet approved
- `approved` — accounting entry created (Dr Salary Exp / Cr Salary Payable)
- `paid` — fully paid (or `paid_amount >= net_pay`); partial payments stay `approved`

## DB columns (added via startup migration — raw SQL only, invisible to Drizzle)
`payroll`: status, approved_at, extra_amount, extra_note, paid_amount, payment_mode, advance_deduction  
`employee_advances`: id, employee_id, amount, date, note, is_deducted, deducted_payroll_id, created_at  
`company_settings`: general_settings JSONB (holds fullDayHours, halfDayHours, and Settings.tsx keys)

## Accounting entries
| Event | Debit | Credit |
|-------|-------|--------|
| Approve | `SAL-EMP-{id}` under SYS-INDEXP | `SAL-PAY-{id}` under SYS-CURL |
| Pay | `SAL-PAY-{id}` | STD-CASH or STD-BANK |
| Advance | `ADV-EMP-{id}` under SYS-CURA | STD-CASH |

Ledgers are per-employee, auto-provisioned by `findOrProvisionLedger()` in hr.ts.

## Hours-based attendance scoring (payroll generate)
- `fullDayHours` / `halfDayHours` read from `company_settings.general_settings` (defaults: 9 / 4.5)
- Configurable via Settings page → Payroll section
- `leave` days always count as 1 full day (no LOP)
- Only checkIn without checkOut → counted as full day
- No attendance records → assume full attendance

## Advance deduction
- Pending advances fetched at generate time, summed → `advance_deduction` stored on payroll row
- `net_pay = max(0, computed_net - advance_deduction)`; advances NOT marked deducted at generate time
- Advances can only be added by headoffice users; non-HO employees see only their own

**Why:** Marking advances as deducted only at generate avoids issues if payroll is regenerated multiple times.
