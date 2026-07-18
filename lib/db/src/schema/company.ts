import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const companySettingsTable = pgTable("company_settings", {
  id: serial("id").primaryKey(),
  companyName: text("company_name").notNull().default("Marlin Frozen Fruits"),
  address: text("address"),
  phone: text("phone"),
  email: text("email"),
  website: text("website"),
  gstNumber: text("gst_number"),
  panNumber: text("pan_number"),
  logoUrl: text("logo_url"),
  currency: text("currency").notNull().default("INR"),
  financialYear: text("financial_year").notNull().default("2024-25"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertCompanySettingsSchema = createInsertSchema(companySettingsTable).omit({ id: true, updatedAt: true });
export type InsertCompanySettings = z.infer<typeof insertCompanySettingsSchema>;
export type CompanySettings = typeof companySettingsTable.$inferSelect;
