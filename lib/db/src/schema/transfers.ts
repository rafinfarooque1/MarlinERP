import { pgTable, text, serial, timestamp, boolean, integer, jsonb, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const stockTransfersTable = pgTable("stock_transfers", {
  id: serial("id").primaryKey(),
  challanNumber: text("challan_number").notNull(),
  fromType: text("from_type").notNull(), // production, warehouse, outlet
  fromId: integer("from_id").notNull(),
  toType: text("to_type").notNull(), // headoffice, warehouse, outlet
  toId: integer("to_id").notNull(),
  transferDate: date("transfer_date", { mode: "string" }).notNull(),
  lineItems: jsonb("line_items").notNull().default([]),
  isInterstate: boolean("is_interstate").notNull().default(false),
  status: text("status").notNull().default("completed"), // pending, completed, cancelled
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertStockTransferSchema = createInsertSchema(stockTransfersTable).omit({ id: true, challanNumber: true, isInterstate: true, status: true, createdAt: true });
export type InsertStockTransfer = z.infer<typeof insertStockTransferSchema>;
export type StockTransfer = typeof stockTransfersTable.$inferSelect;
