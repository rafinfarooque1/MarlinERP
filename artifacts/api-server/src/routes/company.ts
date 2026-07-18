import { Router } from "express";
import { db, companySettingsTable, permissionsTable, hierarchiesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { UpdateCompanySettingsBody, SetPermissionBody } from "@workspace/api-zod";

const router = Router();

// ── Company Settings ──────────────────────────────────────────────────────
router.get("/company/settings", async (_req, res): Promise<void> => {
  const rows = await db.select().from(companySettingsTable).limit(1);
  if (rows.length === 0) {
    // Create default settings
    const [row] = await db.insert(companySettingsTable).values({}).returning();
    res.json(row);
    return;
  }
  res.json(rows[0]);
});

router.patch("/company/settings", async (req, res): Promise<void> => {
  const parsed = UpdateCompanySettingsBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const rows = await db.select().from(companySettingsTable).limit(1);
  let row;
  if (rows.length === 0) {
    [row] = await db.insert(companySettingsTable).values(parsed.data).returning();
  } else {
    [row] = await db.update(companySettingsTable).set(parsed.data).where(eq(companySettingsTable.id, rows[0].id)).returning();
  }
  res.json(row);
});

// ── Permissions ────────────────────────────────────────────────────────────
router.get("/company/permissions", async (_req, res): Promise<void> => {
  const rows = await db.select().from(permissionsTable).orderBy(permissionsTable.id);
  const hierarchies = await db.select().from(hierarchiesTable);
  const hMap = new Map(hierarchies.map((h) => [h.id, h.name]));
  res.json(rows.map((r) => ({
    ...r,
    hierarchyName: hMap.get(r.hierarchyId) ?? "",
  })));
});

router.post("/company/permissions", async (req, res): Promise<void> => {
  const parsed = SetPermissionBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  // Upsert
  const [existing] = await db.select().from(permissionsTable)
    .where(eq(permissionsTable.hierarchyId, parsed.data.hierarchyId))
    .limit(1);

  let row;
  if (existing) {
    [row] = await db.update(permissionsTable).set(parsed.data).where(eq(permissionsTable.id, existing.id)).returning();
  } else {
    [row] = await db.insert(permissionsTable).values(parsed.data).returning();
  }

  const [h] = await db.select().from(hierarchiesTable).where(eq(hierarchiesTable.id, row.hierarchyId)).limit(1);
  res.json({ ...row, hierarchyName: h?.name ?? "" });
});

export default router;
