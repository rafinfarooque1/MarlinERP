import { pgTable, text, serial, timestamp, numeric, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const materialsTable = pgTable("materials", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  unit: text("unit").notNull(),
  description: text("description"),
  currentStock: numeric("current_stock", { precision: 10, scale: 3 }).notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const rawMaterialsTable = pgTable("raw_materials", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  unit: text("unit").notNull(),
  description: text("description"),
  currentStock: numeric("current_stock", { precision: 10, scale: 3 }).notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const itemsTable = pgTable("items", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  hsnCode: text("hsn_code").notNull(),
  taxRate: numeric("tax_rate", { precision: 5, scale: 2 }).notNull().default("0"),
  unit: text("unit").notNull(),
  description: text("description"),
  productionStock: numeric("production_stock", { precision: 10, scale: 3 }).notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const stockEntriesTable = pgTable("stock_entries", {
  id: serial("id").primaryKey(),
  itemId: integer("item_id").notNull().references(() => itemsTable.id),
  branchType: text("branch_type").notNull(), // headoffice, warehouse, outlet
  branchId: integer("branch_id").notNull(),
  quantity: numeric("quantity", { precision: 10, scale: 3 }).notNull().default("0"),
  costPrice: numeric("cost_price", { precision: 10, scale: 2 }).notNull().default("0"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const itemPricesTable = pgTable("item_prices", {
  id: serial("id").primaryKey(),
  itemId: integer("item_id").notNull().references(() => itemsTable.id),
  outletId: integer("outlet_id").notNull(),
  price: numeric("price", { precision: 10, scale: 2 }).notNull().default("0"),
  validFrom: text("valid_from"), // optional YYYY-MM-DD
  validTo: text("valid_to"),     // optional YYYY-MM-DD
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// ── Batch-level inventory (Phase 3) ────────────────────────────────────────
// stock_entries remains the quantity source of truth; stock_batches is an
// additive breakdown of each (location, item) quantity into batches with
// mfg/expiry dates and unit cost. Batches may total less than the stock entry
// (the residual is "untracked" legacy quantity) but are never negative.
export const stockBatchesTable = pgTable("stock_batches", {
  id: serial("id").primaryKey(),
  itemId: integer("item_id").notNull().references(() => itemsTable.id),
  branchType: text("branch_type").notNull(), // headoffice, warehouse, outlet
  branchId: integer("branch_id").notNull(),
  batchNumber: text("batch_number").notNull(),
  mfgDate: text("mfg_date"),      // YYYY-MM-DD
  expiryDate: text("expiry_date"), // YYYY-MM-DD
  quantity: numeric("quantity", { precision: 12, scale: 3 }).notNull().default("0"),
  unitCost: numeric("unit_cost", { precision: 12, scale: 2 }).notNull().default("0"),
  source: text("source"),   // production | purchase | transfer | opening | adjustment
  sourceId: integer("source_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});
export type StockBatch = typeof stockBatchesTable.$inferSelect;

// Physical stock verification: counted quantities per location with variance
// adjustments. lines: [{ itemId, systemQty, countedQty, variance, reason }]
export const stockVerificationsTable = pgTable("stock_verifications", {
  id: serial("id").primaryKey(),
  branchType: text("branch_type").notNull(),
  branchId: integer("branch_id").notNull(),
  verifyDate: text("verify_date").notNull(),
  notes: text("notes"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type StockVerification = typeof stockVerificationsTable.$inferSelect;

export const insertMaterialSchema = createInsertSchema(materialsTable).omit({ id: true, currentStock: true, createdAt: true, updatedAt: true });
export type InsertMaterial = z.infer<typeof insertMaterialSchema>;
export type Material = typeof materialsTable.$inferSelect;

export const insertRawMaterialSchema = createInsertSchema(rawMaterialsTable).omit({ id: true, currentStock: true, createdAt: true, updatedAt: true });
export type InsertRawMaterial = z.infer<typeof insertRawMaterialSchema>;
export type RawMaterial = typeof rawMaterialsTable.$inferSelect;

export const insertItemSchema = createInsertSchema(itemsTable).omit({ id: true, productionStock: true, createdAt: true, updatedAt: true });
export type InsertItem = z.infer<typeof insertItemSchema>;
export type Item = typeof itemsTable.$inferSelect;
