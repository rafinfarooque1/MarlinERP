/**
 * GENERATED FILE — do not edit by hand.
 * Source: artifacts/marlin-erp/src/lib/moduleRegistry.ts
 * Regenerate: pnpm --filter @workspace/scripts run permissions:write
 *
 * One permission key per sidebar link. The href is the identifier because link
 * names collide across sections ("Reports" appears three times).
 */

/** Every sidebar link, in sidebar order. */
export const PAGE_PERM_KEYS: readonly string[] = [
  "page:/",                            // General › Dashboard
  "page:/sales/pos",                   // Operations › Point of Sale
  "page:/transfers",                   // Operations › Stock Transfer
  "page:/sales/expenses",              // Operations › Expenses
  "page:/accounts/cash-in-outlet",     // Operations › Cash Balance
  "page:/headoffice/stock",            // Operations › Stock
  "page:/customers",                   // Operations › Customers
  "page:/production/production",       // Production › Batches
  "page:/production/reports",          // Production › Reports
  "page:/production/purchase",         // Production › Purchases
  "page:/vendors",                     // Production › Vendors
  "page:/production/units",            // Inventory › Units
  "page:/production/item-master",      // Inventory › Item Master
  "page:/headoffice/stock-ledger",     // Inventory › Stock Ledger
  "page:/headoffice/inventory-reports", // Inventory › Reports
  "page:/headoffice/stock-verification", // Inventory › Verification
  "page:/headoffice/warehouses",       // Inventory › Warehouses
  "page:/headoffice/outlets",          // Inventory › Outlets
  "page:/headoffice/item-price",       // Inventory › Item Prices
  "page:/returns",                     // Sales › Returns
  "page:/outstanding",                 // Sales › Outstanding
  "page:/coupons",                     // Sales › Coupons
  "page:/hr/employees",                // HR › Employees
  "page:/hr/attendance",               // HR › Attendance
  "page:/hr/payroll",                  // HR › Payroll
  "page:/hr/advances",                 // HR › Advances
  "page:/hr/rent",                     // HR › Rent Management
  "page:/hr/hierarchy",                // HR › Hierarchy
  "page:/accounts/chart",              // Accounts › Chart of Accounts
  "page:/accounts/ledger",             // Accounts › Ledger Statement
  "page:/accounts/cash-bank",          // Accounts › Cash & Bank
  "page:/accounts/vouchers",           // Accounts › Vouchers
  "page:/accounts/day-book",           // Accounts › Day Book
  "page:/accounts/cash-book",          // Accounts › Cash Book
  "page:/accounts/bank-book",          // Accounts › Bank Book
  "page:/accounts/trial-balance",      // Accounts › Trial Balance
  "page:/accounts/expenses",           // Accounts › Expenses
  "page:/accounts/gst",                // Accounts › GST Summary
  "page:/accounts/gst-returns",        // Accounts › GST Returns
  "page:/accounts/reconciliation",     // Accounts › Reconciliation
  "page:/reports/sales",               // Accounts › Reports
  "page:/company/settings",            // Company › Settings
  "page:/company/profile",             // Company › Company Profile
  "page:/company/audit",               // Company › Audit Log
  "page:/company/permissions",         // Company › Permissions
  "page:/company/login-history",       // Company › Login History
  "page:/company/backup",              // Company › Backup & Restore
];

/**
 * Old grouped module names -> the per-link keys that replace them.
 * Used once, by the migration that expands legacy rows into per-link rows.
 */
export const LEGACY_MODULE_TO_PAGES: Readonly<Record<string, readonly string[]>> = {
  "Point of Sale": ["page:/sales/pos"],
  "HO Transfers": ["page:/transfers"],
  "Location Expenses": ["page:/sales/expenses"],
  "Cash Balance": ["page:/accounts/cash-in-outlet"],
  "Units": ["page:/production/units"],
  "Items": ["page:/production/item-master"],
  "Production": ["page:/production/production", "page:/production/reports"],
  "Purchases": ["page:/production/purchase"],
  "Stock": ["page:/headoffice/stock"],
  "Stock Ledger": ["page:/headoffice/stock-ledger"],
  "Inventory Reports": ["page:/headoffice/inventory-reports"],
  "Stock Verification": ["page:/headoffice/stock-verification"],
  "Warehouses": ["page:/headoffice/warehouses"],
  "Outlets": ["page:/headoffice/outlets"],
  "Item Prices": ["page:/headoffice/item-price"],
  "Sales": ["page:/returns", "page:/outstanding"],
  "Customers": ["page:/customers"],
  "Vendors": ["page:/vendors"],
  "Coupons": ["page:/coupons"],
  "Employees": ["page:/hr/employees"],
  "Attendance": ["page:/hr/attendance"],
  "Payroll": ["page:/hr/payroll", "page:/hr/advances"],
  "Rent Management": ["page:/hr/rent"],
  "Hierarchy": ["page:/hr/hierarchy"],
  "Chart of Accounts": ["page:/accounts/chart"],
  "Ledger": ["page:/accounts/ledger"],
  "Cash & Bank": ["page:/accounts/cash-bank"],
  "Vouchers": ["page:/accounts/vouchers"],
  "Books": ["page:/accounts/day-book", "page:/accounts/cash-book", "page:/accounts/bank-book", "page:/accounts/trial-balance"],
  "Expenses": ["page:/accounts/expenses"],
  "GST Summary": ["page:/accounts/gst"],
  "GST Returns": ["page:/accounts/gst-returns"],
  "Reconciliation": ["page:/accounts/reconciliation"],
  "Reports": ["page:/reports/sales"],
  "Dashboard": ["page:/"],
  "Settings": ["page:/company/settings", "page:/company/profile", "page:/company/audit"],
  "Permissions": ["page:/company/permissions"],
  "Login History": ["page:/company/login-history"],
  "Backup & Restore": ["page:/company/backup"],
  "Location Stock": ["page:/headoffice/stock"],
  "Leave": ["page:/hr/attendance"],
  "Payments": ["page:/accounts/vouchers"],
  "Accounts Cash Balance": ["page:/accounts/cash-in-outlet"],
  "Materials": ["page:/production/item-master"],
  "Raw Materials": ["page:/production/item-master"],
  "Stock Transfers": ["page:/transfers"],
  "Location Transfers": ["page:/transfers"],
  "Sales Dashboard": ["page:/"],
  "Profile": ["page:/company/profile"],
};
