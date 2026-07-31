import { Router } from "express";
import { db, companySettingsTable, permissionsTable, hierarchiesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { pool } from "@workspace/db";
import { SetPermissionBody } from "@workspace/api-zod";
import { PasswordService } from "../lib/password";
import { invalidatePolicyCache } from "../lib/passwordPolicy";
import { getActiveLockouts } from "../middleware/auth";
import { requireModuleView, requireModuleAction } from "../middleware/permissions";
import { normalizeUpiId } from "../lib/upi";

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
async function extraSettingsFields(id: number): Promise<{
  paymentTerms: string | null; invoiceFooter: string | null; productionOverheadPercent: number;
  passwordMinLength: number; passwordRequireUppercase: boolean; passwordRequireNumber: boolean; passwordRequireSpecial: boolean;
  generalSettings: Record<string, any> | null;
  gstTransferInvoicing: boolean; branchTransferPrefix: string;
  pfEnabled: boolean; pfEmployeePercent: number; pfEmployerPercent: number;
  esiEnabled: boolean; esiEmployeePercent: number; esiEmployerPercent: number;
  upiEnabled: boolean; upiId: string; upiPayeeName: string;
  showUpiQrOnInvoice: boolean; showBankDetailsOnInvoice: boolean;
  bankBranch: string; accountType: string; bankAccountHolder: string;
}> {
  const { rows: [r] } = await pool.query<any>(
    `SELECT payment_terms, invoice_footer, production_overhead_percent,
            password_min_length, password_require_uppercase, password_require_number, password_require_special,
            general_settings, gst_transfer_invoicing, branch_transfer_prefix,
            pf_enabled, pf_employee_percent, pf_employer_percent,
            esi_enabled, esi_employee_percent, esi_employer_percent,
            upi_enabled, upi_id, upi_payee_name,
            show_upi_qr_on_invoice, show_bank_details_on_invoice,
            bank_branch, account_type, bank_account_holder
     FROM company_settings WHERE id = $1`, [id]
  );
  return {
    paymentTerms: r?.payment_terms ?? null,
    invoiceFooter: r?.invoice_footer ?? null,
    productionOverheadPercent: Number(r?.production_overhead_percent ?? 0),
    passwordMinLength: Number(r?.password_min_length ?? 8),
    passwordRequireUppercase: !!r?.password_require_uppercase,
    passwordRequireNumber: !!r?.password_require_number,
    passwordRequireSpecial: !!r?.password_require_special,
    generalSettings: r?.general_settings ?? null,
    gstTransferInvoicing: r?.gst_transfer_invoicing !== false,
    branchTransferPrefix: r?.branch_transfer_prefix ?? 'BTR',
    pfEnabled: r?.pf_enabled !== false,
    pfEmployeePercent: Number(r?.pf_employee_percent ?? 12),
    pfEmployerPercent: Number(r?.pf_employer_percent ?? 12),
    esiEnabled: r?.esi_enabled !== false,
    esiEmployeePercent: Number(r?.esi_employee_percent ?? 0.75),
    esiEmployerPercent: Number(r?.esi_employer_percent ?? 3.25),
    // Invoice payment presentation. Defaults are "on" so an existing invoice
    // keeps printing what it printed before these switches existed.
    upiEnabled: r?.upi_enabled !== false,
    upiId: r?.upi_id ?? '',
    upiPayeeName: r?.upi_payee_name ?? '',
    showUpiQrOnInvoice: r?.show_upi_qr_on_invoice !== false,
    showBankDetailsOnInvoice: r?.show_bank_details_on_invoice !== false,
    bankBranch: r?.bank_branch ?? '',
    accountType: r?.account_type ?? '',
    bankAccountHolder: r?.bank_account_holder ?? '',
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

router.patch("/company/settings", requireModuleAction("page:/company/settings", "edit"), async (req, res): Promise<void> => {
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

  // General settings blob (raw JSONB column — stores Invoice & Billing,
  // Payroll, Notifications, Regional panel values from the Settings page).
  let generalSettingsUpdate: Record<string, any> | undefined;
  if ('generalSettings' in req.body) {
    const v = (req.body as any).generalSettings;
    if (v !== null && (typeof v !== 'object' || Array.isArray(v))) {
      res.status(400).json({ error: 'generalSettings must be an object or null' }); return;
    }
    generalSettingsUpdate = v ?? {};
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

  // GST transfer invoicing (raw columns). The switch controls WHETHER a
  // cross-GSTIN transfer raises a tax invoice — it never changes how a transfer
  // is classified: that is decided automatically from the two GSTINs and is not
  // a user choice. Turning it off reverts to journal-voucher-only treatment,
  // which keeps the books balanced but leaves the supply out of GSTR-1.
  // Transfers already invoiced are untouched; each transfer remembers the
  // document it was raised with.
  const transferUpdates: Array<[column: string, value: boolean | string]> = [];
  if ('gstTransferInvoicing' in req.body) {
    const v = (req.body as any).gstTransferInvoicing;
    if (typeof v !== 'boolean') { res.status(400).json({ error: 'gstTransferInvoicing must be a boolean' }); return; }
    transferUpdates.push(['gst_transfer_invoicing', v]);
  }
  if ('branchTransferPrefix' in req.body) {
    const v = (req.body as any).branchTransferPrefix;
    if (typeof v !== 'string' || !/^[A-Za-z0-9-]{1,10}$/.test(v.trim())) {
      res.status(400).json({ error: 'branchTransferPrefix must be 1–10 letters, digits or hyphens' }); return;
    }
    transferUpdates.push(['branch_transfer_prefix', v.trim().toUpperCase()]);
  }

  // Statutory payroll (raw columns). PF and ESI are company-wide obligations,
  // so the rates live here rather than on each employee. Changing a rate only
  // affects payroll generated afterwards — every run stores the rates it used,
  // so an approved period keeps the figures the employee was actually paid on.
  const statutoryUpdates: Array<[column: string, value: boolean | number]> = [];
  for (const [bodyKey, column] of [
    ['pfEnabled',  'pf_enabled'],
    ['esiEnabled', 'esi_enabled'],
  ] as const) {
    if (bodyKey in req.body) {
      const v = (req.body as any)[bodyKey];
      if (typeof v !== 'boolean') { res.status(400).json({ error: `${bodyKey} must be a boolean` }); return; }
      statutoryUpdates.push([column, v]);
    }
  }
  for (const [bodyKey, column, max] of [
    ['pfEmployeePercent',  'pf_employee_percent',  100],
    ['pfEmployerPercent',  'pf_employer_percent',  100],
    ['esiEmployeePercent', 'esi_employee_percent', 100],
    ['esiEmployerPercent', 'esi_employer_percent', 100],
  ] as const) {
    if (bodyKey in req.body) {
      const v = Number((req.body as any)[bodyKey]);
      if (!Number.isFinite(v) || v < 0 || v > max) {
        res.status(400).json({ error: `${bodyKey} must be a number between 0 and ${max}` }); return;
      }
      statutoryUpdates.push([column, Math.round(v * 100) / 100]);
    }
  }

  // Password policy (raw columns) — minLength 6–32, three boolean complexity flags
  const policyUpdates: Array<[column: string, value: number | boolean]> = [];
  if ('passwordMinLength' in req.body) {
    const v = Number((req.body as any).passwordMinLength);
    if (!Number.isInteger(v) || v < 6 || v > 32) {
      res.status(400).json({ error: "passwordMinLength must be an integer between 6 and 32" });
      return;
    }
    policyUpdates.push(['password_min_length', v]);
  }
  for (const [bodyKey, column] of [
    ['passwordRequireUppercase', 'password_require_uppercase'],
    ['passwordRequireNumber', 'password_require_number'],
    ['passwordRequireSpecial', 'password_require_special'],
  ] as const) {
    if (bodyKey in req.body) {
      const v = (req.body as any)[bodyKey];
      if (typeof v !== 'boolean') { res.status(400).json({ error: `${bodyKey} must be a boolean` }); return; }
      policyUpdates.push([column, v]);
    }
  }

  // Invoice payment presentation (raw columns). These control what an invoice
  // ASKS FOR — they never touch how a payment is recorded or posted.
  const invoicePayUpdates: Array<[column: string, value: string | boolean | null]> = [];
  for (const [bodyKey, column] of [
    ['upiEnabled', 'upi_enabled'],
    ['showUpiQrOnInvoice', 'show_upi_qr_on_invoice'],
    ['showBankDetailsOnInvoice', 'show_bank_details_on_invoice'],
  ] as const) {
    if (bodyKey in req.body) {
      const v = (req.body as any)[bodyKey];
      if (typeof v !== 'boolean') { res.status(400).json({ error: `${bodyKey} must be a boolean` }); return; }
      invoicePayUpdates.push([column, v]);
    }
  }
  if ('upiId' in req.body) {
    // Shared with the per-location UPI ID on warehouses: both feed the same
    // invoice QR, so they must accept and reject exactly the same values.
    const upi = normalizeUpiId((req.body as any).upiId);
    if (!upi.ok) { res.status(400).json({ error: upi.error }); return; }
    invoicePayUpdates.push(['upi_id', upi.value]);
  }
  for (const [bodyKey, column, max] of [
    ['upiPayeeName',      'upi_payee_name',      60],
    ['bankBranch',        'bank_branch',         80],
    ['accountType',       'account_type',        40],
    ['bankAccountHolder', 'bank_account_holder', 80],
  ] as const) {
    if (bodyKey in req.body) {
      const v = (req.body as any)[bodyKey];
      if (v !== null && typeof v !== 'string') { res.status(400).json({ error: `${bodyKey} must be a string or null` }); return; }
      const t = typeof v === 'string' ? v.trim() : '';
      if (t.length > max) { res.status(400).json({ error: `${bodyKey} must be ${max} characters or fewer` }); return; }
      invoicePayUpdates.push([column, t || null]);
    }
  }

  if (Object.keys(data).length === 0 && pdfUpdates.length === 0 && overheadUpdate === undefined && policyUpdates.length === 0 && generalSettingsUpdate === undefined && transferUpdates.length === 0 && statutoryUpdates.length === 0 && invoicePayUpdates.length === 0) { res.status(400).json({ error: "No valid fields to update" }); return; }

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
  for (const [column, value] of policyUpdates) {
    await pool.query(`UPDATE company_settings SET ${column} = $1 WHERE id = $2`, [value, row.id]);
  }
  if (policyUpdates.length > 0) invalidatePolicyCache();
  for (const [column, value] of transferUpdates) {
    await pool.query(`UPDATE company_settings SET ${column} = $1 WHERE id = $2`, [value, row.id]);
  }
  for (const [column, value] of statutoryUpdates) {
    await pool.query(`UPDATE company_settings SET ${column} = $1 WHERE id = $2`, [value, row.id]);
  }
  for (const [column, value] of invoicePayUpdates) {
    await pool.query(`UPDATE company_settings SET ${column} = $1 WHERE id = $2`, [value, row.id]);
  }
  if (generalSettingsUpdate !== undefined) {
    await pool.query(`UPDATE company_settings SET general_settings = $1 WHERE id = $2`, [JSON.stringify(generalSettingsUpdate), row.id]);
  }
  res.json({ ...row, ...(await extraSettingsFields(row.id)) });
});

// ── Login history (Phase 7) ────────────────────────────────────────────────
// Server-paginated login attempts + live lockout status. Guarded by the
// 'Login History' module (any-of with Settings so admins keep access even
// before the new module is saved on the Permissions page).
router.get("/company/login-history", requireModuleView(["page:/company/login-history", "page:/company/settings"]), async (req, res): Promise<void> => {
  const page = Math.max(parseInt(String(req.query.page ?? '1'), 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '25'), 10) || 25, 1), 200);
  const username = typeof req.query.username === 'string' ? req.query.username.trim() : '';
  const success = typeof req.query.success === 'string' ? req.query.success : '';

  const conds: string[] = [];
  const params: unknown[] = [];
  if (username) { params.push(`%${username}%`); conds.push(`username ILIKE $${params.length}`); }
  if (success === 'true' || success === 'false') { params.push(success === 'true'); conds.push(`success = $${params.length}`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const { rows: [{ total }] } = await pool.query<any>(
    `SELECT COUNT(*)::int AS total FROM login_attempts ${where}`, params,
  );
  const { rows } = await pool.query<any>(
    `SELECT la.id, la.username, la.employee_id, la.success, la.ip, la.user_agent, la.reason, la.created_at,
            e.name AS employee_name
     FROM login_attempts la
     LEFT JOIN employees e ON e.id = la.employee_id
     ${where}
     ORDER BY la.id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, (page - 1) * limit],
  );

  res.json({
    total: Number(total ?? 0),
    page,
    limit,
    rows: rows.map((r: any) => ({
      id: r.id,
      username: r.username,
      employeeId: r.employee_id,
      employeeName: r.employee_name ?? null,
      success: !!r.success,
      ip: r.ip,
      userAgent: r.user_agent,
      reason: r.reason,
      createdAt: r.created_at,
    })),
    lockedAccounts: getActiveLockouts(),
  });
});

// ── Permissions ────────────────────────────────────────────────────────────
router.get("/company/permissions", async (req, res): Promise<void> => {
  const employee = (req as any).employee as { hierarchyId?: number } | undefined;
  if (!employee?.hierarchyId) {
    res.status(403).json({ error: "Permission context is unavailable" });
    return;
  }
  const [currentHierarchy] = await db.select().from(hierarchiesTable)
    .where(eq(hierarchiesTable.id, employee.hierarchyId)).limit(1);
  if (!currentHierarchy) {
    res.status(403).json({ error: "Permission context is unavailable" });
    return;
  }
  // The shell needs its own rows to decide which pages may render. Returning
  // the complete cross-role matrix to every logged-in employee turned that
  // bootstrap request into a permissions disclosure. Level 1 alone retains
  // the full matrix required by the permission-administration screen.
  const rows = currentHierarchy.level === 1
    ? await db.select().from(permissionsTable).orderBy(permissionsTable.id)
    : await db.select().from(permissionsTable)
      .where(eq(permissionsTable.hierarchyId, employee.hierarchyId))
      .orderBy(permissionsTable.id);
  const hierarchyRows = currentHierarchy.level === 1
    ? await db.select().from(hierarchiesTable)
    : [currentHierarchy];
  const hMap = new Map(hierarchyRows.map((h) => [h.id, h.name]));
  res.json(rows.map((r) => ({
    ...r,
    hierarchyName: hMap.get(r.hierarchyId) ?? "",
  })));
});

router.post("/company/permissions", requireModuleAction("page:/company/permissions", "edit"), async (req, res): Promise<void> => {
  const parsed = SetPermissionBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  // Upsert must match on hierarchy AND module — matching hierarchy alone
  // would make every module save overwrite the same single row. Done as a
  // single ON CONFLICT statement so two admins saving the same page at once
  // cannot both miss an existing row and insert a duplicate.
  const [row] = await db.insert(permissionsTable)
    .values(parsed.data)
    .onConflictDoUpdate({
      target: [permissionsTable.hierarchyId, permissionsTable.module],
      set: parsed.data,
    })
    .returning();

  const [h] = await db.select().from(hierarchiesTable).where(eq(hierarchiesTable.id, row.hierarchyId)).limit(1);
  res.json({ ...row, hierarchyName: h?.name ?? "" });
});

// ── RBAC legacy all-true audit (read-only, no data changes) ──────────────────
// Surfaces permission rows that have every flag set to true — the fingerprint
// of the one-time seeding migrations (permission_seed_existing_v1 and the
// per_link_permissions_v1 grant-fallback). Those migrations ran exactly once;
// admins can use this endpoint to identify roles that still hold the seeded
// all-true baseline and review whether finer-grained access is appropriate.
//
// This endpoint NEVER modifies permissions. It is an observability tool only.
router.get("/company/permissions/rbac-audit", requireModuleView("page:/company/permissions"), async (_req, res): Promise<void> => {
  // A row is considered "legacy all-true" when ALL six primary permission flags
  // are true — that is the exact value written by both seeding migrations.
  // Rows that an admin has partially revoked (e.g. can_view=true, can_delete=false)
  // are NOT flagged — they show deliberate configuration, not an untouched seed.
  const { rows: legacyRows } = await pool.query<any>(`
    SELECT
      p.id,
      p.hierarchy_id,
      h.name  AS hierarchy_name,
      h.level AS hierarchy_level,
      p.module,
      p.can_view,
      p.can_add,
      p.can_edit,
      p.can_delete,
      p.can_download,
      p.can_print,
      p.can_approve,
      p.can_share,
      p.updated_at
    FROM permissions p
    JOIN hierarchies h ON h.id = p.hierarchy_id
    WHERE p.can_view    = true
      AND p.can_add     = true
      AND p.can_edit    = true
      AND p.can_delete  = true
      AND p.can_download = true
      AND p.can_print   = true
    ORDER BY h.level ASC, h.name ASC, p.module ASC
  `);

  // Summary: how many unique (hierarchy, module) pairs are all-true vs. total
  const { rows: [totals] } = await pool.query<any>(`
    SELECT
      COUNT(*) FILTER (
        WHERE can_view AND can_add AND can_edit AND can_delete AND can_download AND can_print
      )::int AS all_true_count,
      COUNT(*)::int AS total_count
    FROM permissions
  `);

  // Seeding migrations that write all-true rows; present so the caller can
  // confirm whether those specific runs have been logged.
  const SEED_MIGRATION_NAMES = [
    'permission_seed_existing_v1',
    'per_link_permissions_v1',
  ];
  const { rows: seedLog } = await pool.query<any>(
    `SELECT name, applied_at FROM migration_log WHERE name = ANY($1::text[]) ORDER BY applied_at ASC`,
    [SEED_MIGRATION_NAMES],
  );

  res.json({
    summary: {
      allTrueCount: Number(totals?.all_true_count ?? 0),
      totalCount:   Number(totals?.total_count ?? 0),
    },
    seedingMigrations: seedLog.map((r: any) => ({
      name:      r.name,
      appliedAt: r.applied_at,
    })),
    legacyAllTrueRows: legacyRows.map((r: any) => ({
      id:             r.id,
      hierarchyId:    r.hierarchy_id,
      hierarchyName:  r.hierarchy_name,
      hierarchyLevel: Number(r.hierarchy_level),
      module:         r.module,
      updatedAt:      r.updated_at,
    })),
  });
});

// ── Reset all company data (dangerous — wipes all transactional records) ──────
router.post("/company/reset", requireModuleAction("page:/company/settings", "delete"), async (_req, res): Promise<void> => {
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
    // NOTE: migration_log is intentionally NOT truncated here. Schema-level
    // migrations (per_link_permissions_v1, permission_seed_existing_v1, etc.)
    // must not re-run after a data reset — re-running the permission seeder
    // would widen every role created post-reset to all-true, defeating the
    // default-deny model. Only business-data and auth records are wiped.
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
