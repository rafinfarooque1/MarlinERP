import { Router } from "express";
import { db, activityLogTable } from "@workspace/db";
import { desc, and, gte, lte, eq, ilike, sql } from "drizzle-orm";

const router = Router();

/**
 * GET /audit/logs
 * Query params:
 *   page       (default 1)
 *   limit      (default 50, max 200)
 *   module     filter by module name
 *   action     CREATE | UPDATE | DELETE
 *   user       filter by username (partial match)
 *   dateFrom   ISO date string (inclusive)
 *   dateTo     ISO date string (inclusive, end-of-day)
 *   search     full-text search against description
 */
router.get("/audit/logs", async (req, res): Promise<void> => {
  const page  = Math.max(1, parseInt(String(req.query.page  ?? "1"),   10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10) || 50));
  const offset = (page - 1) * limit;

  const { module: mod, action, user, dateFrom, dateTo, search } = req.query as Record<string, string>;

  const conditions = [];

  if (mod)      conditions.push(eq(activityLogTable.module, mod));
  if (action)   conditions.push(eq(activityLogTable.action, action));
  if (user)     conditions.push(ilike(activityLogTable.user, `%${user}%`));
  if (search)   conditions.push(ilike(activityLogTable.description, `%${search}%`));
  if (dateFrom) conditions.push(gte(activityLogTable.createdAt, new Date(dateFrom)));
  if (dateTo) {
    // Include the whole day
    const end = new Date(dateTo);
    end.setHours(23, 59, 59, 999);
    conditions.push(lte(activityLogTable.createdAt, end));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  // Count total for pagination
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(activityLogTable)
    .where(where);

  const rows = await db
    .select()
    .from(activityLogTable)
    .where(where)
    .orderBy(desc(activityLogTable.createdAt))
    .limit(limit)
    .offset(offset);

  res.json({
    total: count,
    page,
    limit,
    totalPages: Math.ceil(count / limit),
    logs: rows.map(r => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      metadata: r.metadata ?? null,
    })),
  });
});

/**
 * GET /audit/logs/:id — single log entry with full metadata
 */
router.get("/audit/logs/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const [row] = await db.select().from(activityLogTable).where(eq(activityLogTable.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ...row, createdAt: row.createdAt.toISOString(), metadata: row.metadata ?? null });
});

export default router;
