import { pgTable, text, serial, timestamp, numeric, integer, jsonb, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { itemsTable } from "./inventory";

export const productionsTable = pgTable("productions", {
  id: serial("id").primaryKey(),
  itemId: integer("item_id").notNull().references(() => itemsTable.id),
  producedQuantity: numeric("produced_quantity", { precision: 10, scale: 3 }).notNull(),
  productionDate: date("production_date", { mode: "string" }).notNull(),
  materialUsed: jsonb("material_used").notNull().default([]),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertProductionSchema = createInsertSchema(productionsTable).omit({ id: true, createdAt: true });
export type InsertProduction = z.infer<typeof insertProductionSchema>;
export type Production = typeof productionsTable.$inferSelect;

// ── Bill of Materials Templates ───────────────────────────────────────────────

export const bomTemplatesTable = pgTable("bom_templates", {
  id: serial("id").primaryKey(),
  itemId: integer("item_id").notNull().references(() => itemsTable.id).unique(),
  // lines: [{ materialType: 'material'|'raw_material', materialId: number, quantity: number }]
  lines: jsonb("lines").notNull().default([]),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type BomTemplate = typeof bomTemplatesTable.$inferSelect;
