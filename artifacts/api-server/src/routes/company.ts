import { Router } from "express";
import { db, companySettingsTable, permissionsTable, hierarchiesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { pool } from "@workspace/db";
import { SetPermissionBody } from "@workspace/api-zod";
import { PasswordService } from "../lib/password";
import { invalidatePolicyCache } from "../lib/passwordPolicy";
import { getActiveLockouts } from "../middleware/auth";
import { requireModuleView, requireModuleAction } from "../middleware/permissions";

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
    const v = (req.body as any).upiId;
    if (v !== null && typeof v !== 'string') { res.status(400).json({ error: 'upiId must be a string or null' }); return; }
    const vpa = typeof v === 'string' ? v.trim() : '';
    // A malformed VPA produces a QR that scans and then fails in the customer's
    // UPI app, with nothing on the invoice to explain why. Reject it here.
    if (vpa && !/^[A-Za-z0-9.\-_]{2,64}@[A-Za-z][A-Za-z0-9.\-]{1,63}$/.test(vpa)) {
      res.status(400).json({ error: 'upiId must be a valid UPI address, e.g. marlin@okhdfcbank' }); return;
    }
    invoicePayUpdates.push(['upi_id', vpa || null]);
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
router.get("/company/permissions", async (_req, res): Promise<void> => {
  const rows = await db.select().from(permissionsTable).orderBy(permissionsTable.id);
  const hierarchies = await db.select().from(hierarchiesTable);
  const hMap = new Map(hierarchies.map((h) => [h.id, h.name]));
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
