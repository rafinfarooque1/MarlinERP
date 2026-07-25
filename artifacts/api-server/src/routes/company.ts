import { Router } from "express";
import { db, companySettingsTable, permissionsTable, hierarchiesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { pool } from "@workspace/db";
import { SetPermissionBody } from "@workspace/api-zod";
import { PasswordService } from "../lib/password";

const router = Router();

// Allowed fields for company settings update
const ALLOWED_COMPANY_FIELDS = new Set([
  'companyName', 'address', 'city', 'state', 'pincode',
  'phone', 'email', 'website', 'gstNumber', 'panNumber',
  'bankName', 'bankAccount', 'ifscCode', 'logoUrl',
  'currency', 'financialYear', 'invoicePrefix',
  'fyStartMonth', 'voucherPrefixes',
]);

function pickCompanyFields(body: Record<string, any>) {
  const result: Record<string, any> = {};
  for (const key of ALLOWED_COMPANY_FIELDS) {
    if (key in body) result[key] = body[key];
  }
  return result;
}

// ── Company Settings ──────────────────────────────────────────────────────

// Extra settings live in raw columns (not in the Drizzle schema): invoice-PDF
// text fields plus the default production overhead percentage (Phase 5).
async function extraSettingsFields(id: number): Promise<{ paymentTerms: string | null; invoiceFooter: string | null; productionOverheadPercent: number }> {
  const { rows: [r] } = await pool.query<any>(
    `SELECT payment_terms, invoice_footer, production_overhead_percent FROM company_settings WHERE id = $1`, [id]
  );
  return {
    paymentTerms: r?.payment_terms ?? null,
    invoiceFooter: r?.invoice_footer ?? null,
    productionOverheadPercent: Number(r?.production_overhead_percent ?? 0),
  };
}

router.get("/company/settings", async (_req, res): Promise<void> => {
  const rows = await db.select().from(companySettingsTable).limit(1);
  let row = rows[0];
  if (!row) {
    [row] = await db.insert(companySettingsTable).values({}).returning();
  }
  res.json({ ...row, ...(await extraSettingsFields(row.id)) });
});

router.patch("/company/settings", async (req, res): Promise<void> => {
  const data = pickCompanyFields(req.body);

  // paymentTerms / invoiceFooter are handled via raw SQL (columns added by
  // startup migration; Drizzle's .set() would drop unknown keys).
  const pdfUpdates: Array<[column: string, value: string | null]> = [];
  for (const [bodyKey, column] of [['paymentTerms', 'payment_terms'], ['invoiceFooter', 'invoice_footer']] as const) {
    if (bodyKey in req.body) {
      const v = (req.body as any)[bodyKey];
      if (v !== null && typeof v !== 'string') { res.status(400).json({ error: `${bodyKey} must be a string or null` }); return; }
      pdfUpdates.push([column, typeof v === 'string' && v.trim() ? v.trim() : null]);
    }
  }

  // Default production overhead % (raw column, numeric 0–100)
  let overheadUpdate: number | undefined;
  if ('productionOverheadPercent' in req.body) {
    const v = Number((req.body as any).productionOverheadPercent);
    if (!Number.isFinite(v) || v < 0 || v > 100) {
      res.status(400).json({ error: "productionOverheadPercent must be a number between 0 and 100" });
      return;
    }
    overheadUpdate = Math.round(v * 100) / 100;
  }

  if (Object.keys(data).length === 0 && pdfUpdates.length === 0 && overheadUpdate === undefined) { res.status(400).json({ error: "No valid fields to update" }); return; }

  const rows = await db.select().from(companySettingsTable).limit(1);
  let row;
  if (rows.length === 0) {
    [row] = await db.insert(companySettingsTable).values(data).returning();
  } else if (Object.keys(data).length > 0) {
    [row] = await db.update(companySettingsTable).set(data).where(eq(companySettingsTable.id, rows[0].id)).returning();
  } else {
    row = rows[0];
  }
  for (const [column, value] of pdfUpdates) {
    await pool.query(`UPDATE company_settings SET ${column} = $1 WHERE id = $2`, [value, row.id]);
  }
  if (overheadUpdate !== undefined) {
    await pool.query(`UPDATE company_settings SET production_overhead_percent = $1 WHERE id = $2`, [overheadUpdate, row.id]);
  }
  res.json({ ...row, ...(await extraSettingsFields(row.id)) });
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
    // Payments & reconciliation (most dependent — clear first)
    'sale_payments',
    'reconciliation_batch_items',
    'reconciliation_batches',
    'cash_deposits',
    'payments',
    'receipts',
    // Core transactional
    'sales',
    'purchases',
    'stock_entries',
    'stock_transfers',
    'productions',
    'expenses',
    // Customer & vendor transactional
    'customers',
    'vendors',
    'coupons',
    // HR transactional
    'payroll',
    'attendance',
    'leaves',
    // Permissions (before hierarchies)
    'permissions',
    // Dependent master data (before their parents)
    'item_prices',
    'bom_templates',
    // Item & inventory master
    'items',
    'raw_materials',
    'materials',
    // Org & location master
    'warehouses',
    'outlets',
    'employees',
    'hierarchies',
    'pay_components',
    // Logs
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

  // ── Purge dynamic account ledgers (warehouse, outlet, customer, vendor) ────
  // System ledger groups (SYS-*, STD-*) are kept so the chart of accounts
  // skeleton stays intact. Only per-entity codes are removed.
  try {
    await pool.query(`
      DELETE FROM account_ledgers
      WHERE code ~ '^(WH-CASH|WH-SAL|WH-PUR|OUTLET-CASH|OUTLET-SAL|CUST-|VEND-)'
         OR (is_system_group = false AND code NOT LIKE 'SYS-%' AND code NOT LIKE 'STD-%'
             AND parent_id IS NOT NULL
             AND id NOT IN (SELECT DISTINCT parent_id FROM account_ledgers WHERE parent_id IS NOT NULL))
    `);
  } catch { /* ignore if table doesn't exist */ }

  // Reset invoice sequence on company_settings
  try {
    await pool.query(`UPDATE company_settings SET invoice_sequence = 0`);
  } catch { /* ignore */ }

  // ── Reseed baseline auth so login works immediately after reset ───────────
  // Step 1: fresh level-1 hierarchy (all others were wiped above)
  const { rows: [hierRow] } = await pool.query(`
    INSERT INTO hierarchies (name, level, description)
    VALUES ('Management', 1, 'Full access — seeded by system reset')
    RETURNING id
  `);
  const hierResult = hierRow ?? (await pool.query(`SELECT id FROM hierarchies WHERE level = 1 LIMIT 1`)).rows[0];

  // Step 2: reseed admin employee with fresh bcrypt password
  if (hierResult) {
    const adminHash = await PasswordService.hash('marlin1458');
    await pool.query(`
      INSERT INTO employees (name, username, password_hash, hierarchy_id, branch_type, branch_id, salary, join_date, is_active, must_change_password)
      VALUES ('Administrator', 'admin', $1, $2, 'headoffice', 0, 0, CURRENT_DATE, true, true)
      ON CONFLICT (username) DO UPDATE
        SET password_hash = $1, hierarchy_id = $2, is_active = true, must_change_password = true
    `, [adminHash, hierResult.id]);
  }

  res.json({ ok: true, message: 'All company data has been reset successfully.' });
});

export default router;
