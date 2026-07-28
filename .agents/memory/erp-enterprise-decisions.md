---
name: Marlin ERP enterprise programme decisions
description: Owner-confirmed decisions governing costing, transfers, outlets, GST and payroll — apply these rather than re-deriving or re-asking.
---

# Governing decisions

Confirmed by the owner. Treat as settled; do not re-litigate or re-ask.

## Labour cost is allocated from actual payroll

Production employee daily salary comes from attendance, then spreads across the batches that
location completed that day, weighted by quantity produced or production hours. Manual entry
per batch is the fallback when no payroll exists for the day.

Batch cost = raw material + packing material + labour + overheads.
Cost per unit = batch cost ÷ quantity produced, and that figure **is** the inventory
valuation cost — valuation, profitability and accounting all read it rather than each
deriving their own.

**Why:** the owner wants accuracy over simplicity and explicitly rejected percentage-of-material
and flat-rate shortcuts.

**How to apply:** allocated amounts must sum exactly to the day's production payroll cost.
Once provident fund and state insurance are enabled, allocate **full employer cost**, not
gross salary.

## Capitalising labour into inventory double-counts unless the P&L is restructured

This is the trap that follows from the decision above. If salary is charged as a period
expense *and* also sits inside closing stock value, the same rupee is counted twice.

**Why:** the existing P&L has no cost-of-production section and no movement-in-stock line — it
treats payroll as an operating expense and closing stock as an unrelated figure.

**How to apply:** whatever cost components enter inventory valuation must be the same
components charged in cost of production, offset by the change in stock. Test it by producing
a batch, selling none of it, and confirming gross profit does not move. Also: opening stock
must be the prior period's closing stock, never zero.

## Transfers stay two-step, always

Dispatch → in transit → receive → completed. One-step transfers are explicitly ruled out.
Each step takes effect immediately — no batch job, no manual posting.

Dispatch reduces source stock, creates in-transit stock, writes the stock ledger, updates
dashboard and reports. Receipt increases destination stock, clears in-transit, updates
valuation, accounting, reports and dashboard. Rejection reverses **every** stock and
accounting movement, including a credit note where a tax invoice was raised.

**Why:** matches the goods-in-transit control used by SAP, Oracle and Dynamics, which the
owner wants parity with.

## Opening balances are intentionally zero

The system has not gone live and no historical accounting is being migrated, so an empty
opening-balances table is **correct, not a gap**. Keep the feature working and reachable —
future deployments of this ERP will need it during implementation.

**How to apply:** never flag zero opening balances as a defect, and never build a migration
to backfill them for this deployment.

## Other standing decisions

- **Outlets convert to warehouses**, history preserved; Outlet then hides behind a Settings
  toggle defaulting off, with all outlet code left in place for reactivation.
- **Reserved stock is enforced, not merely displayed** — covers in-transit-outbound and
  confirmed-but-unfulfilled orders, and is blocked from new sales and transfers until released.
- **Invoice sharing** uses a secure link in a pre-filled message; PDF download stays.
- **Different-GSTIN transfer invoicing is forward-only** — historical transfers are never
  restated.
- **Provident fund and state insurance use statutory defaults** (12%, and 0.75% employee /
  3.25% employer) as editable company settings.
- **The sidebar is frozen.** New screens become tabs inside existing pages; no link may be
  added, renamed, reordered or merged.
