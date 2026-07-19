import { pgTable, text, serial, timestamp, integer, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const activityLogTable = pgTable("activity_log", {
  id: serial("id").primaryKey(),
  // Legacy fields (kept for backward compat)
  type: text("type").notNull().default(""),
  description: text("description").notNull().default(""),
  user: text("user").notNull().default("system"),
  // Extended audit fields
  action: text("action").notNull().default("CREATE"),   // CREATE | UPDATE | DELETE
  module: text("module").notNull().default(""),         // sales | purchases | production | hr | payroll | transfers
  entityType: text("entity_type").notNull().default(""),// sale | purchase | production | employee | payroll | …
  entityId: integer("entity_id"),                       // PK of the affected row
  metadata: jsonb("metadata"),                          // { before, after, summary } or any extra context
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertActivityLogSchema = createInsertSchema(activityLogTable).omit({ id: true, createdAt: true });
export type InsertActivityLog = z.infer<typeof insertActivityLogSchema>;
export type ActivityLog = typeof activityLogTable.$inferSelect;
