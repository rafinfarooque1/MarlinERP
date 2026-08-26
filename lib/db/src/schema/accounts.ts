import { pgTable, text, serial, timestamp, numeric, integer, date, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const accountLedgersTable = pgTable("account_ledgers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(), // asset, liability, income, expense, equity
  parentId: integer("parent_id"),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cashBankAccountsTable = pgTable("cash_bank_accounts", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  accountType: text("account_type").notNull(), // cash, bank
  bankName: text("bank_name"),
  // Both are text on purpose. An account number's leading zeros are
  // significant and it routinely exceeds Number.MAX_SAFE_INTEGER, so parsing
  // either as a number corrupts it.
  accountNumber: text("account_number"),
  ifscCode: text("ifsc_code"),
  balance: numeric("balance", { precision: 12, scale: 2 }).notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Legacy compatibility shadow for Cash/Bank ownership. New application code
 * uses the scalar location_type/location_id columns on cash_bank_accounts;
 * migration keeps at most one row here for older consumers.
 */
export const cashBankAccountLocationsTable = pgTable("cash_bank_account_locations", {
  id: serial("id").primaryKey(),
  accountId: integer("account_id").notNull().references(() => cashBankAccountsTable.id, { onDelete: "cascade" }),
  locationType: text("location_type").notNull(),
  // Head Office is represented consistently as id 0; branch values are the
  // corresponding warehouse/outlet ids.
  locationId: integer("location_id").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("cash_bank_account_locations_account_location_uniq")
    .on(table.accountId, table.locationType, table.locationId),
]);

export const expensesTable = pgTable("expenses", {
  id: serial("id").primaryKey(),
  ledgerAccountId: integer("ledger_account_id").notNull().references(() => accountLedgersTable.id),
  paymentAccountId: integer("payment_account_id").notNull().references(() => cashBankAccountsTable.id),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  // Real DATE column (mode 'string' keeps the 'YYYY-MM-DD' API contract).
  expenseDate: date("expense_date", { mode: "string" }).notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertAccountLedgerSchema = createInsertSchema(accountLedgersTable).omit({ id: true, createdAt: true });
export type InsertAccountLedger = z.infer<typeof insertAccountLedgerSchema>;
export type AccountLedger = typeof accountLedgersTable.$inferSelect;

export const insertCashBankAccountSchema = createInsertSchema(cashBankAccountsTable).omit({ id: true, balance: true, createdAt: true });
export type InsertCashBankAccount = z.infer<typeof insertCashBankAccountSchema>;
export type CashBankAccount = typeof cashBankAccountsTable.$inferSelect;

export const insertExpenseSchema = createInsertSchema(expensesTable).omit({ id: true, createdAt: true });
export type InsertExpense = z.infer<typeof insertExpenseSchema>;
export type Expense = typeof expensesTable.$inferSelect;
