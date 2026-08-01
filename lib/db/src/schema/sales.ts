import { pgTable, text, serial, timestamp, numeric, integer, jsonb, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const salesTable = pgTable("sales", {
  id: serial("id").primaryKey(),
  invoiceNumber: text("invoice_number").notNull(),
  // Nullable ON PURPOSE: warehouse sales carry NULL here and resolve their
  // place via location_type + location_id. Re-adding .notNull() makes
  // drizzle push emit SET NOT NULL, which fails on live data.
  outletId: integer("outlet_id"),
  customerId: integer("customer_id"),
  saleDate: date("sale_date", { mode: "string" }).notNull(),
  lineItems: jsonb("line_items").notNull().default([]),
  subtotal: numeric("subtotal", { precision: 12, scale: 2 }).notNull().default("0"),
  taxTotal: numeric("tax_total", { precision: 12, scale: 2 }).notNull().default("0"),
  discountTotal: numeric("discount_total", { precision: 12, scale: 2 }).notNull().default("0"),
  // Pre-tax invoice-level discount, allocated proportionally across lines (each
  // line stores its billDiscountShare). Distinct from discountTotal, which is
  // the post-tax coupon deduction. Column added by boot migration.
  billDiscount: numeric("bill_discount", { precision: 12, scale: 2 }).notNull().default("0"),
  totalAmount: numeric("total_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  paymentMode: text("payment_mode").notNull(),
  couponCode: text("coupon_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertSaleSchema = createInsertSchema(salesTable).omit({ id: true, invoiceNumber: true, createdAt: true });
export type InsertSale = z.infer<typeof insertSaleSchema>;
export type Sale = typeof salesTable.$inferSelect;
