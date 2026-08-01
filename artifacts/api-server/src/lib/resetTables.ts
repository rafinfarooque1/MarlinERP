/**
 * The single, maintained list of transactional tables for BOTH reset
 * endpoints: `/company/clear-transactions` deletes exactly these (masters
 * preserved), and `/company/reset` spreads them into its full factory-reset
 * list. Kept in its own module so tests can import it without pulling in the
 * router (and its live DB pool).
 *
 * Order matters: children before parents — clear-transactions issues plain
 * DELETEs in this order.
 *
 * Every new transactional table MUST be added here, or resets will strand its
 * rows pointing at truncated masters / reused ids (this exact drift produced
 * the prod ghost-row incident and, later, quotations surviving a reset).
 */
export const TXN_RESET_TABLES = [
  "invoice_share_links",
  // Quotations are transactional documents too: children (share links) before
  // parents. Leaving them behind would strand quotes pointing at truncated
  // customers/locations, and stale converted_sale_id values would collide
  // with reused sale ids after RESTART IDENTITY.
  "quotation_share_links",
  "quotations",
  "sale_payments",
  "sales_returns",
  "purchase_returns",
  "reconciliation_batch_items",
  "reconciliation_batches",
  "cash_deposits",
  "receipts",
  "payments",
  "expenses",
  "journal_voucher_lines",
  "journal_vouchers",
  "stock_reservations",
  "stock_verifications",
  "stock_transfers",
  "productions",
  "stock_ledger",
  "stock_batches",
  "stock_entries",
  "sales",
  "purchases",
  "asset_purchases",
  "payroll",
  "employee_advances",
  "salary_accruals",
  "rent_accruals",
  "rent_payments",
  "rent_periods",
  // Punch rows feed worked-hours; leaving them behind would silently re-feed
  // stale hours into any attendance recreated after the reset.
  "attendance_punches",
  "attendance",
  "leaves",
] as const;
