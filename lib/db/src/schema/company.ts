import { pgTable, text, serial, timestamp, integer, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const companySettingsTable = pgTable("company_settings", {
  id: serial("id").primaryKey(),
  companyName: text("company_name").notNull().default("Marlin Frozen Fruits"),
  address: text("address"),
  city: text("city"),
  state: text("state"),
  pincode: text("pincode"),
  phone: text("phone"),
  email: text("email"),
  website: text("website"),
  gstNumber: text("gst_number"),
  panNumber: text("pan_number"),
  bankName: text("bank_name"),
  bankAccount: text("bank_account"),
  ifscCode: text("ifsc_code"),
  logoUrl: text("logo_url"),
  currency: text("currency").notNull().default("INR"),
  financialYear: text("financial_year").notNull().default("2025-26"),
  invoicePrefix: text("invoice_prefix").notNull().default("INV"),
  invoiceSequence: integer("invoice_sequence").notNull().default(0),
  fyStartMonth: integer("fy_start_month").notNull().default(4),
  voucherPrefixes: jsonb("voucher_prefixes"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertCompanySettingsSchema = createInsertSchema(companySettingsTable).omit({ id: true, updatedAt: true });
export type InsertCompanySettings = z.infer<typeof insertCompanySettingsSchema>;
export type CompanySettings = typeof companySettingsTable.$inferSelect;
