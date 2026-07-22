import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const warehousesTable = pgTable("warehouses", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  state: text("state").notNull(),
  gstNumber: text("gst_number").notNull(),
  address: text("address"),
  contactPerson: text("contact_person"),
  phone: text("phone"),
  upiId: text("upi_id"),
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
