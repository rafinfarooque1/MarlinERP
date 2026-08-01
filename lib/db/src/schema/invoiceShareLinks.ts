import { pgTable, text, serial, timestamp, integer, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { salesTable } from "./sales";
import { employeesTable } from "./hr";

/**
 * Public share links for invoice PDFs.
 *
 * A row is the *authority* for one customer-facing link. The public URL carries
 * a random `publicId` (never the sale id) plus a secret token, and every request
 * is checked against this row — so a link can be revoked, expires on a fixed
 * date, and its use is counted.
 *
 * The token lives on the row because a link has to be re-shown: Copy Link and
 * Share on WhatsApp both hand out the existing active link long after it was
 * minted. Hashing it and deriving the live value from a server secret instead
 * would tie every customer's link to that secret's rotation, and hashing it
 * without a derivation would make re-sending impossible — for protection that
 * does not apply, since the invoice itself sits in `sales` beside this row.
 */
export const invoiceShareLinksTable = pgTable("invoice_share_links", {
  id: serial("id").primaryKey(),
  /** Random, opaque public identifier — this is what appears in the URL. */
  // Uniqueness comes from the NAMED index below (matches the live DB).
  // Do not add .unique() here: drizzle would name that constraint
  // invoice_share_links_public_id_unique, see it as missing, and its push
  // raises an interactive truncate prompt that kills post-merge setup.
  publicId: text("public_id").notNull(),
  saleId: integer("sale_id").notNull().references(() => salesTable.id),
  /** The link's secret, 256 random bits as hex. Compared in constant time. */
  token: text("token").notNull(),
  /** active | expired | revoked */
  status: text("status").notNull().default("active"),
  createdBy: integer("created_by").references(() => employeesTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  accessCount: integer("access_count").notNull().default(0),
  lastAccessAt: timestamp("last_access_at", { withTimezone: true }),
  revokedBy: integer("revoked_by").references(() => employeesTable.id),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("invoice_share_links_public_id_uq").on(t.publicId),
]);

export const insertInvoiceShareLinkSchema = createInsertSchema(invoiceShareLinksTable)
  .omit({ id: true, createdAt: true });
export type InsertInvoiceShareLink = z.infer<typeof insertInvoiceShareLinkSchema>;
export type InvoiceShareLink = typeof invoiceShareLinksTable.$inferSelect;
