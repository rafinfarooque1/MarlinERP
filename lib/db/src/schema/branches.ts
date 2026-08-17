import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * A warehouse is the ERP's billing profile: the legal identity that issues a
 * sales invoice. Sales record the location they were raised at, and the invoice
 * resolves its seller details from that stored location — never from the
 * company profile and never from whoever happens to be reprinting it.
 *
 * The company profile still owns the logo and the invoice numbering series;
 * everything a tax invoice must state about the *seller* lives here.
 */
export const warehousesTable = pgTable("warehouses", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  state: text("state").notNull(),
  gstNumber: text("gst_number").notNull(),
  address: text("address"),
  contactPerson: text("contact_person"),
  phone: text("phone"),
  upiId: text("upi_id"),

  // ── Billing & invoice profile ──────────────────────────────────────────────
  /** Legal/trade name printed on invoices. Falls back to `name` when unset. */
  billingName: text("billing_name"),
  email: text("email"),
  city: text("city"),
  district: text("district"),
  pincode: text("pincode"),
  /** Two-digit GST state code. Previously raw-SQL only; now part of the model. */
  stateCode: text("state_code"),
  fssaiNumber: text("fssai_number"),

  bankAccountHolder: text("bank_account_holder"),
  bankName: text("bank_name"),
  bankBranch: text("bank_branch"),
  bankAccountNumber: text("bank_account_number"),
  ifscCode: text("ifsc_code"),

  invoiceFooter: text("invoice_footer"),
  authorizedSignatory: text("authorized_signatory"),
  /** Letterhead logo as an inline PNG/JPEG data URI. Null = use company logo. */
  logoUrl: text("logo_url"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const outletsTable = pgTable("outlets", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  warehouseId: integer("warehouse_id").notNull().references(() => warehousesTable.id),
  address: text("address"),
  contactPerson: text("contact_person"),
  phone: text("phone"),
  upiId: text("upi_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertWarehouseSchema = createInsertSchema(warehousesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertWarehouse = z.infer<typeof insertWarehouseSchema>;
export type Warehouse = typeof warehousesTable.$inferSelect;

export const insertOutletSchema = createInsertSchema(outletsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertOutlet = z.infer<typeof insertOutletSchema>;
export type Outlet = typeof outletsTable.$inferSelect;
