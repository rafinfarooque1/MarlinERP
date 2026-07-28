import { pgTable, text, serial, timestamp, boolean, integer, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { hierarchiesTable } from "./hr";

export const permissionsTable = pgTable("permissions", {
  id: serial("id").primaryKey(),
  hierarchyId: integer("hierarchy_id").notNull().references(() => hierarchiesTable.id),
  module: text("module").notNull(),
  canView: boolean("can_view").notNull().default(false),
  canAdd: boolean("can_add").notNull().default(false),
  canEdit: boolean("can_edit").notNull().default(false),
  canDelete: boolean("can_delete").notNull().default(false),
  canDownload: boolean("can_download").notNull().default(false),
  canPrint: boolean("can_print").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  // Exactly one row per role per page. Duplicates would make the effective
  // rights depend on row order, since guards fold the rows with json_object_agg.
  uniqueIndex("permissions_hierarchy_module_uq").on(t.hierarchyId, t.module),
]);

export const insertPermissionSchema = createInsertSchema(permissionsTable).omit({ id: true, updatedAt: true });
export type InsertPermission = z.infer<typeof insertPermissionSchema>;
export type Permission = typeof permissionsTable.$inferSelect;
