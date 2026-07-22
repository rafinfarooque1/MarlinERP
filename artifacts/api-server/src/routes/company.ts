import { Router } from "express";
import { db, companySettingsTable, permissionsTable, hierarchiesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { pool } from "@workspace/db";
import { SetPermissionBody } from "@workspace/api-zod";

const router = Router();

// Allowed fields for company settings update
const ALLOWED_COMPANY_FIELDS = new Set([
  'companyName', 'address', 'city', 'state', 'pincode',
  'phone', 'email', 'website', 'gstNumber', 'panNumber',
  'bankName', 'bankAccount', 'ifscCode', 'logoUrl',
  'currency', 'financialYear', 'invoicePrefix',
]);

function pickCompanyFields(body: Record<string, any>) {
  const result: Record<string, any> = {};
  for (const key of ALLOWED_COMPANY_FIELDS) {
    if (key in body) result[key] = body[key];
  }
  return result;
}

// ── Company Settings ──────────────────────────────────────────────────────
router.get("/company/settings", async (_req, res): Promise<void> => {
  const rows = await db.select().from(companySettingsTable).limit(1);
  if (rows.length === 0) {
    const [row] = await db.insert(companySettingsTable).values({}).returning();
    res.json(row);
    return;
  }
  res.json(rows[0]);
});

router.patch("/company/settings", async (req, res): Promise<void> => {
  const data = pickCompanyFields(req.body);
  if (Object.keys(data).length === 0) { res.status(400).json({ error: "No valid fields to update" }); return; }

  const rows = await db.select().from(companySettingsTable).limit(1);
  let row;
  if (rows.length === 0) {
    [row] = await db.insert(companySettingsTable).values(data).returning();
  } else {
    [row] = await db.update(companySettingsTable).set(data).where(eq(companySettingsTable.id, rows[0].id)).returning();
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

// ── Reset all company data (dangerous — wipes all transactional records) ──────
router.post("/company/reset", async (_req, res): Promise<void> => {
  const TRUNCATE_TABLES = [
    'sale_payments',
    'reconciliation_batch_items',
    'reconciliation_batches',
    'cash_deposits',
    'sales',
    'purchases',
    'stock_entries',
    'customers',
    'coupons',
    'productions',
    'payroll',
    'attendance',
    'leaves',
    'expenses',
    'activity_log',
    'migration_log',
  ];

  // Truncate all transactional tables in one shot (RESTART IDENTITY cascades sequences)
  for (const table of TRUNCATE_TABLES) {
    try {
      await pool.query(`TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`);
    } catch {
      // table may not exist yet — skip silently
    }
  }

  // Reset invoice sequence on company_settings
  try {
    await pool.query(`UPDATE company_settings SET invoice_sequence = 0`);
  } catch {
    // ignore
  }

  res.json({ ok: true, message: 'All company data has been reset successfully.' });
});

export default router;
