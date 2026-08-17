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
import { validateLogoDataUrl } from "../lib/logoImage";
import { createBackup } from "../lib/backup/create";
import { runSalaryAccrual } from "../lib/salaryAccrual";
import { objectStorageConfigured } from "../lib/backup/files";
import { ObjectStorageService } from "../lib/objectStorage";
import { readApkManifest } from "../lib/apkRelease";
import { logActivity } from "../lib/audit";
import { ensureStandardOrgTree } from "../migrations/orgHierarchyRestructure";

const router = Router();

// RETIRED mobile-APK settings keys. The Android release is owned entirely by
// the automated build pipeline (EAS build → object-storage manifest, see
// lib/apkRelease.ts) — nothing reads these keys any more. The PATCH below
// strips them from both the client payload and the stored blob so stale
// copies cannot linger or be forged back in.
const RETIRED_MOBILE_KEYS: string[] = [
  "androidApkObjectPath", "androidApkFileName", "androidApkSize", "androidApkUploadedAt",
  "androidApkUrl", "androidAppVersion",
];

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

// Logo parsing/validation lives in ../lib/logoImage so the per-warehouse
// letterhead upload enforces exactly the same rules.

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

  // Logo: only an inline PNG/JPEG data URI is stored — the invoice PDF embeds
  // the image bytes directly (jsPDF cannot fetch a URL or draw an SVG). Empty
  // string or null clears it. The app resizes uploads to ≤512px before
  // sending, so anything near the body limit is rejected rather than stored.
  if ('logoUrl' in data) {
    const logo = validateLogoDataUrl(data.logoUrl);
    if (!logo.ok) { res.status(400).json({ error: logo.error }); return; }
    data.logoUrl = logo.value;
  }

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
    // Payroll leave-policy keys are money-bearing: they set the per-day salary
    // rate and the paid-leave allowance for every employee. The blob replaces
    // the stored one wholesale, so the incoming object IS the effective value —
    // validate it here, not just in the UI.
    const gsu: Record<string, any> = v ?? {};
    generalSettingsUpdate = gsu;
    // `payrollWorkingDays` is retired (Aug 2026): the working-days basis is the
    // payroll month's actual calendar length now (see monthWorkingDays), so the
    // key is neither validated nor read. Stale copies in stored blobs are
    // harmless. `salaryDay` was likewise retired — it was display-only; the
    // actual pay date is the payment voucher's date.
    // POS opening payment mode: only the two modes a new sale can be created
    // with. Anything else stored here would silently fall back client-side, so
    // reject it up front.
    if (gsu.defaultSalesPaymentMode !== undefined && gsu.defaultSalesPaymentMode !== null
        && gsu.defaultSalesPaymentMode !== 'credit' && gsu.defaultSalesPaymentMode !== 'cash') {
      res.status(400).json({ error: 'Default Sales Payment Mode must be Credit or Cash' }); return;
    }
    if (gsu.paidCasualLeavesPerMonth !== undefined && gsu.paidCasualLeavesPerMonth !== null) {
      const pl = Number(gsu.paidCasualLeavesPerMonth);
      if (!Number.isFinite(pl) || pl < 0) {
        res.status(400).json({ error: 'Paid Casual Leaves Per Month must be zero or more' }); return;
      }
      if (pl > 31) {
        res.status(400).json({ error: 'Paid Casual Leaves Per Month cannot exceed 31 — no month has more days' }); return;
      }
    }
    if (gsu.lopEnabled !== undefined && gsu.lopEnabled !== null && typeof gsu.lopEnabled !== 'boolean') {
      res.status(400).json({ error: 'Enable Loss of Pay must be on or off' }); return;
    }
    if (gsu.paidSickLeavesPerMonth !== undefined && gsu.paidSickLeavesPerMonth !== null) {
      const sl = Number(gsu.paidSickLeavesPerMonth);
      if (!Number.isFinite(sl) || sl < 0) {
        res.status(400).json({ error: 'Paid Sick Leaves Per Month must be zero or more' }); return;
      }
      if (sl > 31) {
        res.status(400).json({ error: 'Paid Sick Leaves Per Month cannot exceed 31 — no month has more days' }); return;
      }
    }
    // Weekly-off rules: each entry is a weekday (0=Sunday…6=Saturday), which
    // occurrences of it in the month ('all' or a list of 1–5), and whether the
    // day is paid outright or deducts a casual leave. Malformed rules are
    // rejected here rather than silently dropped at read time — a rule the
    // admin thinks exists but doesn't would misprice every month.
    if (gsu.weeklyOffs !== undefined && gsu.weeklyOffs !== null) {
      if (!Array.isArray(gsu.weeklyOffs)) {
        res.status(400).json({ error: 'weeklyOffs must be a list of weekly-off rules' }); return;
      }
      for (const r of gsu.weeklyOffs) {
        const day = Number(r?.day);
        if (!r || typeof r !== 'object' || !Number.isInteger(day) || day < 0 || day > 6) {
          res.status(400).json({ error: 'Each weekly off needs a valid day of the week' }); return;
        }
        if (r.policy !== 'paid' && r.policy !== 'casual_leave') {
          res.status(400).json({ error: 'Each weekly off must be Paid or Deducts Casual Leave' }); return;
        }
        const weeksOk = r.weeks === 'all'
          || (Array.isArray(r.weeks) && r.weeks.length > 0
              && r.weeks.every((w: any) => Number.isInteger(Number(w)) && Number(w) >= 1 && Number(w) <= 5));
        if (!weeksOk) {
          res.status(400).json({ error: 'Each weekly off must apply to every week or to specific weeks (1st–5th)' }); return;
        }
      }
    }
    if (gsu.weeklyOffExhaustedAction !== undefined && gsu.weeklyOffExhaustedAction !== null
        && gsu.weeklyOffExhaustedAction !== 'ask' && gsu.weeklyOffExhaustedAction !== 'absent') {
      res.status(400).json({ error: 'When casual leave is exhausted, the action must be Ask or Mark Unpaid' }); return;
    }
    // Mobile app distribution settings: these feed PUBLIC endpoints
    // (GET /api/public/app + /api/public/app/apk), so only vetted URLs may
    // ever be stored — anything else could turn the QR into an open redirect
    // to a javascript:/data: payload. Empty/null means "not available yet"
    // and the UI shows an honest notice instead of a dead button.
    //
    // Scheme rules per key:
    //  - androidApkUrl: where the server FETCHES the APK from when someone
    //    clicks Download APK. https only; http://localhost is tolerated in
    //    development builds only — the file must never travel over plain http
    //    in prod, and in prod a localhost URL would be an SSRF against our own
    //    services (the download endpoint is public).
    //  - iosInstallUrl: an Apple-supported install destination — a TestFlight
    //    https link, a real App Store https link, or an itms-services://
    //    OTA-manifest link (ad-hoc/enterprise distribution). NEVER a raw .ipa
    //    file; iPhones cannot install one from a browser, so offering it would
    //    be a fake download — reject it outright.
    //  - legacy mobileApp*Url keys: kept readable so old stored blobs still
    //    save, plain http(s).
    for (const [key, label, schemes] of [
      ['iosInstallUrl',        'iOS installation link',   'ios-install'],
      ['mobileAppIosUrl',      'App Store link',          'http'],
      ['mobileAppAndroidUrl',  'Google Play link',        'http'],
      ['mobileAppFallbackUrl', 'Fallback download page link', 'http'],
    ] as const) {
      const v = gsu[key];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'string') { res.status(400).json({ error: `${label} must be a URL or empty` }); return; }
      const t = v.trim();
      if (t === '') { gsu[key] = ''; continue; }
      if (t.length > 500) { res.status(400).json({ error: `${label} must be 500 characters or fewer` }); return; }
      let ok = false;
      try {
        const u = new URL(t);
        if (schemes === 'ios-install') {
          ok = u.protocol === 'https:' || u.protocol === 'itms-services:';
          if (ok && /\.ipa$/i.test(u.pathname)) {
            res.status(400).json({ error: `${label} must not point at an .ipa file — iPhones cannot install one from a browser. Use a TestFlight link or an itms-services:// install link instead.` });
            return;
          }
        } else {
          ok = u.protocol === 'https:' || u.protocol === 'http:';
        }
      } catch { ok = false; }
      if (!ok) { res.status(400).json({ error: `${label} must be a full https:// link${schemes === 'ios-install' ? ' (or an itms-services:// install link)' : ''}` }); return; }
      gsu[key] = t;
    }
    // App version labels are display strings shown in the download window —
    // keep them short and filename-safe. (The ANDROID version is no longer a
    // setting: it is recorded by the build pipeline from the app source.)
    for (const [key, label] of [
      ['iosAppVersion',     'iOS app version'],
    ] as const) {
      const v = gsu[key];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'string') { res.status(400).json({ error: `${label} must be text like 1.0.0` }); return; }
      const t = v.trim();
      if (t.length > 50) { res.status(400).json({ error: `${label} must be 50 characters or fewer` }); return; }
      if (t && !/^[\w. +()-]*$/.test(t)) { res.status(400).json({ error: `${label} may only contain letters, numbers, dots, dashes and spaces` }); return; }
      gsu[key] = t;
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
    const { rows: [prevRow] } = await pool.query(
      `SELECT general_settings FROM company_settings WHERE id = $1`, [row.id]);
    const prevGS = typeof prevRow?.general_settings === "string"
      ? JSON.parse(prevRow.general_settings) : (prevRow?.general_settings ?? {});
    // The retired mobile-APK keys are dropped outright: the Android release
    // lives in the object-storage manifest now (lib/apkRelease.ts), so any
    // copy of these keys — sent by an old client OR already in the stored
    // blob — is stripped inside the UPDATE itself.
    for (const k of RETIRED_MOBILE_KEYS) {
      delete (generalSettingsUpdate as Record<string, unknown>)[k];
    }
    await pool.query(
      `UPDATE company_settings
         SET general_settings = $1::jsonb - $3::text[]
       WHERE id = $2`,
      [JSON.stringify(generalSettingsUpdate), row.id, RETIRED_MOBILE_KEYS],
    );
    // A changed pay policy immediately changes what open days are worth — the
    // salary books must follow now, not at the next hourly sweep. Locked
    // (approved/paid) months are skipped by the sweep itself.
    const PAY_POLICY_KEYS = [
      "paidCasualLeavesPerMonth", "paidSickLeavesPerMonth",
      "lopEnabled", "weeklyOffs", "weeklyOffExhaustedAction",
    ];
    const policyChanged = PAY_POLICY_KEYS.some((k) =>
      JSON.stringify(prevGS?.[k] ?? null) !== JSON.stringify(generalSettingsUpdate?.[k] ?? null));
    if (policyChanged) {
      await runSalaryAccrual(pool).catch((e) =>
        console.error("[settings] accrual re-run after pay-policy change failed:", e));
    }
  }
  res.json({ ...row, ...(await extraSettingsFields(row.id)) });
});

// ── Public mobile-app distribution endpoints ───────────────────────────────
// The app is deliberately NOT on Google Play / the App Store. Distribution is:
//   Android → direct APK download (server-proxied so the filename is clean)
//   iOS     → a configurable Apple-supported install link (TestFlight /
//             OTA manifest / a real store listing later). Never an .ipa file —
//             ordinary iPhones cannot install one from a browser.
//
// Both endpoints are PUBLIC (auth exemption in app.ts) because they are hit by
// phones that are not logged in (QR scans). They disclose only the configured
// install destinations — no business data.
const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// One read path for the distribution config. The Android side comes from
// the build pipeline's manifest in object storage (shape-validated on read,
// see lib/apkRelease.ts) — never from a setting or a URL. The iOS side stays
// a validated setting: defence in depth — the PATCH already validates, but
// these endpoints serve unauthenticated visitors, so the EXACT same rules
// are re-applied at read time.
async function readAppDistribution() {
  const [{ rows: [r] }, android] = await Promise.all([
    pool.query<any>(
      `SELECT company_name, general_settings FROM company_settings ORDER BY id LIMIT 1`,
    ),
    readApkManifest(),
  ]);
  const gs = typeof r?.general_settings === "string"
    ? JSON.parse(r.general_settings) : (r?.general_settings ?? {});
  // Mirrors the PATCH 'ios-install' rule, including the raw-.ipa refusal.
  const cleanIos = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    if (!t || t.length > 500) return null;
    try {
      const u = new URL(t);
      if (u.protocol !== "https:" && u.protocol !== "itms-services:") return null;
      if (/\.ipa$/i.test(u.pathname)) return null;
      return t;
    } catch { return null; }
  };
  const cleanVersion = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t && t.length <= 50 && /^[\w. +()-]*$/.test(t) ? t : null;
  };
  return {
    companyName: String(r?.company_name || "Marlin Frozen Fruits"),
    // null → no Android release published (honest unavailability, never stale)
    android,
    iosUrl: cleanIos(gs?.iosInstallUrl),
    iosVersion: cleanVersion(gs?.iosAppVersion),
  };
}

// GET /public/app — the stable link printed QR codes carry. Sends each device
// where it can actually install from; shows an honest page otherwise.
router.get("/public/app", async (req, res): Promise<void> => {
  // Config changes must take effect on the next scan — never cache.
  res.set("Cache-Control", "no-store");
  const cfg = await readAppDistribution();

  const ua = String(req.get("user-agent") ?? "");
  const isIos     = /iPhone|iPad|iPod/i.test(ua);
  const isAndroid = /Android/i.test(ua);
  // The APK link points at OUR download endpoint, not the raw hosted file, so
  // the browser gets a clean filename and the hosting can move without
  // invalidating anything already printed or shared.
  const apkConfigured = Boolean(cfg.android);
  if (isAndroid && apkConfigured) { res.redirect(302, "/api/public/app/apk"); return; }
  if (isIos && cfg.iosUrl)        { res.redirect(302, cfg.iosUrl); return; }

  const company = escapeHtml(cfg.companyName);
  const btn = (href: string, label: string) =>
    `<a class="btn" href="${escapeHtml(href)}">${label}</a>`;
  const sections: string[] = [];
  if (apkConfigured) {
    sections.push(
      `<div class="plat"><h2>Android${cfg.android ? ` <span class="ver">Version ${escapeHtml(cfg.android.version)}</span>` : ""}</h2>
       ${btn("/api/public/app/apk", "Download APK")}
       <p class="note">Android may ask you to allow installation from this source.</p></div>`);
  } else {
    sections.push(`<div class="plat"><h2>Android</h2><p class="note">Android app download is not currently available.</p></div>`);
  }
  if (cfg.iosUrl) {
    sections.push(
      `<div class="plat"><h2>iPhone / iOS${cfg.iosVersion ? ` <span class="ver">Version ${escapeHtml(cfg.iosVersion)}</span>` : ""}</h2>
       ${btn(cfg.iosUrl, "Install iOS App")}</div>`);
  } else {
    sections.push(`<div class="plat"><h2>iPhone / iOS</h2><p class="note">iOS installation is not currently configured.</p></div>`);
  }
  res.status(200).type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${company} — Mobile App</title>
<style>
  body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:#f6f7f9;color:#111827;
       display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;box-sizing:border-box}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:36px 28px;max-width:420px;width:100%;
        text-align:center;box-shadow:0 8px 24px rgba(0,0,0,.06)}
  h1{font-size:20px;margin:0 0 6px}
  h2{font-size:15px;margin:0 0 10px}
  .ver{color:#6b7280;font-weight:500;font-size:12px}
  .sub{color:#6b7280;font-size:14px;line-height:1.6;margin:0 0 20px}
  .plat{border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin-top:12px}
  .note{color:#6b7280;font-size:12px;line-height:1.5;margin:10px 0 0}
  .btn{display:block;background:#111827;color:#fff;text-decoration:none;border-radius:10px;padding:13px 16px;
       font-size:14px;font-weight:600}
  .btn:hover{background:#1f2937}
</style></head>
<body><div class="card"><h1>${company} Mobile App</h1>
<p class="sub">Access your ERP from your phone.</p>${sections.join("")}</div></body></html>`);
});

// GET /public/app/apk — streams the current APK release to the browser as a
// real file download. The served object comes exclusively from the automated
// build pipeline's manifest (lib/apkRelease.ts) — no user input, no external
// URLs, no upload path. Honest 404 when no release is published; 502 if the
// manifest points at an object that has gone missing (storage outage or
// out-of-band deletion) — never a silent fallback.
router.get("/public/app/apk", async (_req, res): Promise<void> => {
  res.set("Cache-Control", "no-store");
  const cfg = await readAppDistribution();
  if (!cfg.android) {
    res.status(404).json({ error: "Android app download is not currently available." });
    return;
  }
  const fail = () => {
    if (!res.headersSent) res.status(502).json({ error: "The APK file could not be read from storage." });
    else res.destroy();
  };
  // Professional, stable filename: company name + the version the pipeline
  // recorded at build time (from the app source, not a hand-typed setting).
  const safe = (s: string) => s.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
  const base = safe(cfg.companyName) || "ERP";
  const fileName = `${base}-Mobile-v${safe(cfg.android.version)}.apk`;
  try {
    const svc = new ObjectStorageService();
    const objectFile = await svc.getObjectEntityFile(cfg.android.publishedPath);
    const [meta] = await objectFile.getMetadata();
    // Integrity gate: the object must still be the exact release the pipeline
    // recorded. A size mismatch means it was changed after publication
    // (corruption or an out-of-band write) — refuse to distribute unverified
    // bytes rather than serve them.
    const size = Number(meta.size ?? 0);
    if (!Number.isFinite(size) || size !== cfg.android.size) {
      console.error(`[public/app/apk] object size ${size} != manifest size ${cfg.android.size} — refusing to serve`);
      fail();
      return;
    }
    res.setHeader("Content-Type", "application/vnd.android.package-archive");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    // Deliberately NO Content-Length: the deployed platform's front-end
    // (Cloud Run) rejects non-chunked responses larger than 32 MB and
    // replaces them with an empty HTTP 500 before any byte is sent — the
    // ~90 MB APK must go out as a chunked stream. Dev has no such proxy,
    // which is why a fixed length "worked" there and only broke in
    // production. Size integrity is still enforced above via the manifest.
    const rs = objectFile.createReadStream();
    rs.on("error", (err) => {
      console.error("[public/app/apk] storage stream error:", err);
      fail();
    });
    rs.pipe(res);
  } catch (err) {
    console.error("[public/app/apk] published APK unavailable:", err);
    fail();
  }
});

// GET /public/app/info — machine-readable release availability for the web
// client (Download Mobile App modal + the Settings page's read-only Android
// release card). Public by design: it discloses exactly what the /public/app
// landing page already shows an unauthenticated visitor — nothing more.
router.get("/public/app/info", async (_req, res): Promise<void> => {
  res.set("Cache-Control", "no-store");
  const cfg = await readAppDistribution();
  res.json({
    companyName: cfg.companyName,
    android: cfg.android
      ? { available: true, version: cfg.android.version, size: cfg.android.size, builtAt: cfg.android.builtAt }
      : { available: false },
    ios: cfg.iosUrl
      ? { available: true, url: cfg.iosUrl, ...(cfg.iosVersion ? { version: cfg.iosVersion } : {}) }
      : { available: false },
  });
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
    lockedAccounts: await getActiveLockouts(),
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

  // Five-action model: the client sends view/add/edit/delete/download only.
  // The legacy print/approve/share columns are mirrored from download/edit on
  // every write so any stray reader of those columns can never disagree with
  // the live model. They are never read by the guards.
  const values = {
    ...parsed.data,
    canPrint:   parsed.data.canDownload ?? false,
    canShare:   parsed.data.canDownload ?? false,
    canApprove: parsed.data.canEdit ?? false,
  };

  // Upsert must match on hierarchy AND module — matching hierarchy alone
  // would make every module save overwrite the same single row. Done as a
  // single ON CONFLICT statement so two admins saving the same page at once
  // cannot both miss an existing row and insert a duplicate.
  const [row] = await db.insert(permissionsTable)
    .values(values)
    .onConflictDoUpdate({
      target: [permissionsTable.hierarchyId, permissionsTable.module],
      set: values,
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
  // A row is considered "legacy all-true" when ALL five permission flags are
  // true — that is the value the seeding migrations left behind (they wrote
  // every flag true; the retired print/approve/share flags are now mirrors).
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
      p.updated_at
    FROM permissions p
    JOIN hierarchies h ON h.id = p.hierarchy_id
    WHERE p.can_view    = true
      AND p.can_add     = true
      AND p.can_edit    = true
      AND p.can_delete  = true
      AND p.can_download = true
    ORDER BY h.level ASC, h.name ASC, p.module ASC
  `);

  // Summary: how many unique (hierarchy, module) pairs are all-true vs. total
  const { rows: [totals] } = await pool.query<any>(`
    SELECT
      COUNT(*) FILTER (
        WHERE can_view AND can_add AND can_edit AND can_delete AND can_download
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
  // EVERY transactional table comes from TXN_RESET_TABLES — the single,
  // maintained list shared with the "CLEAR ALL TRANSACTIONS" endpoint below —
  // so the two resets can never drift apart again. (This route once carried
  // its own stale copy of that list: it missed stock_batches, stock_ledger,
  // journal vouchers, accruals, rent and more, and the survivors re-attached
  // themselves to the new company's records because RESTART IDENTITY reissued
  // the same ids. See prod_reset_ghost_cleanup_v1.)
  const TRUNCATE_TABLES = [
    ...TXN_RESET_TABLES,
    // Master & register data — a full factory reset wipes masters too. The
    // masters-preserving variant is the "CLEAR ALL TRANSACTIONS" endpoint.
    'assets',
    'coupons',
    'permissions',
    'item_prices',
    'bom_templates',
    'customers',
    'vendors',
    'items',
    'raw_materials',
    'materials',
    'warehouse_rent_agreements',
    'warehouses',
    'outlets',
    'employees',
    'hierarchies',
    'pay_components',
    'cash_bank_accounts',
    // Numbering & logs — a fresh company starts numbering from 1
    'voucher_sequences',
    'opening_balances',
    'activity_log',
    'login_attempts',
    // Brute-force lockout state must reset with the accounts it guards: a
    // pre-reset lock on 'admin' would otherwise survive the reseed and block
    // the freshly created administrator for up to 15 minutes.
    'login_lockouts',
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

  // ── Standalone sequences ───────────────────────────────────────────────────
  // Document/batch/code numbering runs on global sequences not owned by any
  // truncated table, so RESTART IDENTITY never touches them. A fresh company
  // must not continue the old company's numbering. (Safe to restart here
  // because stock_batches and the item masters were truncated above.)
  for (const seq of ['purchase_batch_seq', 'item_code_seq_item', 'item_code_seq_material', 'item_code_seq_raw_material']) {
    try {
      await pool.query(`ALTER SEQUENCE ${seq} RESTART WITH 1`);
    } catch { /* sequence may not exist yet */ }
  }

  // ── Salary accrual anchor ──────────────────────────────────────────────────
  // The hourly sweep backfills accruals from this date; after a full reset it
  // must start from today, not from the old company's anchor.
  try {
    await pool.query(`UPDATE salary_accrual_config SET attendance_from = CURRENT_DATE`);
  } catch { /* table may not exist yet */ }

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

  // Reset invoice + quotation sequences on company_settings
  try {
    await pool.query(`UPDATE company_settings SET invoice_sequence = 0, quotation_sequence = 0`);
  } catch { /* ignore */ }

  // ── Reseed baseline auth so login works immediately after reset ───────────
  // Step 1: fresh level-1 hierarchy (all others were wiped above)
  const { rows: [hierRow] } = await pool.query(`
    INSERT INTO hierarchies (name, level, description)
    VALUES ('Administrator', 1, 'System administrator — unrestricted access')
    RETURNING id
  `);
  const hierResult = hierRow ?? (await pool.query(`SELECT id FROM hierarchies WHERE level = 1 LIMIT 1`)).rows[0];

  // Rebuild the standard org tree (Management + manager roles and Management's
  // seeded view-only permissions). The one-time restructure migration cannot
  // re-run — migration_log deliberately survives the reset — so without this a
  // reset company would keep only the Administrator role forever.
  await ensureStandardOrgTree(pool);

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

  // The Cash & Bank accounts and their openings were truncated above, but the
  // auto-maintained Opening Balance Adjustment ledger (STD-* code) survives the
  // purge. Recomputing against the now-empty openings removes it cleanly.
  try {
    const { rebalanceCashBankOpeningEquity } = await import("../lib/cashBankLedgers");
    await rebalanceCashBankOpeningEquity(pool);
  } catch (err) {
    console.error("[reset] cash-bank opening rebalance failed:", err);
  }

  res.json({ ok: true, message: 'All company data has been reset successfully.' });
});

// ── One-time transactional data reset ─────────────────────────────────────
// Clears ALL transactional documents (sales, purchases, expenses, vouchers,
// payroll, rent, stock movements) while preserving every master and all
// configuration. Unlike /company/reset above, masters (customers, vendors,
// employees, items, warehouses, ledgers, permissions, users) are untouched.
//
// Safety model:
//  - admin-only (delete right on company settings) + exact confirmation phrase
//  - a full backup is taken BEFORE anything is deleted (aborts if it fails)
//  - all deletes + counter/anchor resets run in ONE database transaction
//  - dryRun: true executes everything then rolls back, returning the counts
//
// Accrual anchors: the salary and rent engines backfill missing days from
// their anchor dates on an hourly sweep, so deleting accrual rows alone would
// see them regenerated within the hour. The reset therefore advances
// salary_accrual_config.attendance_from, employees.salary_accrual_resume_from
// and warehouse_rent_agreements.start_date to the reset date so accrual
// starts fresh from that day forward.
const TXN_RESET_CONFIRM_PHRASE = "CLEAR ALL TRANSACTIONS";

// Children before parents. Every table listed here is transactional; masters
// are deliberately absent. attendance/leaves are included per owner decision
// (payroll is cleared, so historical attendance would only feed stale re-runs).
// The list itself lives in lib/resetTables.ts so tests can import it without
// pulling in this router's live DB pool.
import { TXN_RESET_TABLES } from "../lib/resetTables";

router.post("/company/clear-transactions", requireModuleAction("page:/company/settings", "delete"), async (req, res): Promise<void> => {
  const { confirm, dryRun } = (req.body ?? {}) as { confirm?: string; dryRun?: boolean };
  if (confirm !== TXN_RESET_CONFIRM_PHRASE) {
    res.status(400).json({
      error: `Confirmation phrase required. Send { "confirm": "${TXN_RESET_CONFIRM_PHRASE}" } to proceed.`,
    });
    return;
  }

  // Reset date uses the same UTC-ymd convention as the accrual engines.
  const now = new Date();
  const resetDate = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;

  // ── Backup first (real runs only). If this fails, nothing is deleted. ───
  let backup: { id: number; filename: string } | null = null;
  if (!dryRun) {
    if (!objectStorageConfigured()) {
      res.status(503).json({ error: "Backups require object storage, which is not configured. Aborting: no data was changed." });
      return;
    }
    try {
      const b = await createBackup({
        scope: "complete",
        trigger: "manual",
        createdBy: req.employee?.username ?? "unknown",
        ip: (req.ip ?? "unknown").replace("::ffff:", ""),
      });
      backup = { id: b.id, filename: b.filename };
    } catch (err) {
      res.status(500).json({
        error: `Pre-reset backup failed — aborting, no data was changed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
  }

  const client = await pool.connect();
  const deleted: Record<string, number> = {};
  const resets: Record<string, number | string> = {};
  try {
    await client.query("BEGIN");

    // ── Quiesce barrier ────────────────────────────────────────────────────
    // 1. Take the SAME per-entity advisory locks the salary (class 8201) and
    //    rent (class 8202) accrual sweeps take. A mid-flight sweep computes
    //    its backfill from a pre-reset snapshot; without these locks it could
    //    insert stale accrual rows AFTER this transaction commits. Holding
    //    them means: an in-flight sweep finishes first (its rows get deleted
    //    below), and no new sweep can start until commit — after which it
    //    reads the advanced anchors and backfills nothing.
    await client.query(
      `SELECT pg_advisory_xact_lock(8201::int, id::int) FROM employees ORDER BY id`,
    );
    await client.query(
      `SELECT pg_advisory_xact_lock(8202::int, id::int) FROM warehouses ORDER BY id`,
    );
    // 2. Exclusive-lock every table being cleared so concurrent document
    //    writers (an in-flight sale/purchase/voucher) either commit before
    //    the wipe (and are deleted with everything else) or block until it
    //    commits (and then see empty tables + restarted counters).
    await client.query(
      `LOCK TABLE ${TXN_RESET_TABLES.join(", ")} IN ACCESS EXCLUSIVE MODE`,
    );

    for (const table of TXN_RESET_TABLES) {
      const r = await client.query(`DELETE FROM ${table}`);
      deleted[table] = r.rowCount ?? 0;
    }

    // Cached transactional aggregates on masters → zero. avg_cost is the
    // purchase/production-derived weighted average (raw-migration column) and
    // describes deleted history; the manually-set `cost` master field is kept.
    resets["items.production_stock/avg_cost"] = (await client.query(`UPDATE items SET production_stock = 0, avg_cost = 0 WHERE production_stock <> 0 OR COALESCE(avg_cost, 0) <> 0`)).rowCount ?? 0;
    resets["materials.current_stock/avg_cost"] = (await client.query(`UPDATE materials SET current_stock = 0, avg_cost = 0 WHERE current_stock <> 0 OR COALESCE(avg_cost, 0) <> 0`)).rowCount ?? 0;
    resets["raw_materials.current_stock/avg_cost"] = (await client.query(`UPDATE raw_materials SET current_stock = 0, avg_cost = 0 WHERE current_stock <> 0 OR COALESCE(avg_cost, 0) <> 0`)).rowCount ?? 0;
    resets["cash_bank_accounts.balance"] = (await client.query(`UPDATE cash_bank_accounts SET balance = 0 WHERE balance <> 0`)).rowCount ?? 0;
    resets["customers.total_purchases"] = (await client.query(`UPDATE customers SET total_purchases = 0 WHERE COALESCE(total_purchases, 0) <> 0`)).rowCount ?? 0;

    // Numbering restarts from 1 (owner decision). Safe only because the
    // document tables are now empty; the boot-time GREATEST() guard on
    // invoice_sequence stays a no-op with zero invoices.
    await client.query(`UPDATE company_settings SET invoice_sequence = 0, quotation_sequence = 0`);
    resets["company_settings.invoice_sequence"] = "0";
    resets["company_settings.quotation_sequence"] = "0";
    resets["voucher_sequences (rows deleted)"] = (await client.query(`DELETE FROM voucher_sequences`)).rowCount ?? 0;
    const seqExists = await client.query(`SELECT to_regclass('public.purchase_batch_seq') AS reg`);
    if (seqExists.rows[0]?.reg) {
      await client.query(`ALTER SEQUENCE purchase_batch_seq RESTART WITH 1`);
      resets["purchase_batch_seq"] = "restarted at 1";
    }

    // Accrual anchors → reset date, so the hourly sweeps do not backfill
    // the days just cleared. Only ever moved FORWARD.
    resets["salary_accrual_config.attendance_from"] = (await client.query(
      `UPDATE salary_accrual_config SET attendance_from = $1
        WHERE attendance_from IS NULL OR attendance_from < $1`, [resetDate],
    )).rowCount ?? 0;
    resets["employees.salary_accrual_resume_from"] = (await client.query(
      `UPDATE employees SET salary_accrual_resume_from = $1
        WHERE salary_accrual_resume_from IS NULL OR salary_accrual_resume_from < $1`, [resetDate],
    )).rowCount ?? 0;
    resets["warehouse_rent_agreements.start_date"] = (await client.query(
      `UPDATE warehouse_rent_agreements SET start_date = $1
        WHERE start_date IS NOT NULL AND start_date < $1`, [resetDate],
    )).rowCount ?? 0;

    if (dryRun) {
      await client.query("ROLLBACK");
    } else {
      await client.query("COMMIT");
    }
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* connection may be gone */ }
    res.status(500).json({
      error: `Transactional reset failed and was rolled back — no data was changed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  } finally {
    client.release();
  }

  // Cash & Bank accounts and their opening balances survive this reset BY
  // DESIGN: openings are part of each account's identity (masters), not
  // transaction history — the accounts keep the balances they were created
  // with. The recompute below is a consistency sweep, not a wipe: it re-derives
  // the equity counterweight from the surviving openings so the trial balance
  // stays balanced whatever state the books were left in.
  if (!dryRun) {
    try {
      const { rebalanceCashBankOpeningEquity } = await import("../lib/cashBankLedgers");
      await rebalanceCashBankOpeningEquity(pool);
    } catch (err) {
      console.error("[clear-transactions] cash-bank opening rebalance failed:", err);
    }
  }

  if (!dryRun) {
    logActivity({
      action: "DELETE",
      module: "company",
      entityType: "transactional_reset",
      description: `Cleared all transactional data (reset date ${resetDate}); masters preserved, sequences restarted`,
      user: req.employee?.username,
      metadata: { resetDate, backupId: backup?.id ?? null, deleted, resets },
    }).catch(() => { /* audit is best-effort */ });
  }

  res.json({
    ok: true,
    dryRun: !!dryRun,
    resetDate,
    backup,
    deleted,
    resets,
    message: dryRun
      ? "Dry run only — every change was rolled back. Counts show what a real run would delete."
      : "All transactional data cleared. Masters, configuration and numbering settings preserved; sequences restart from 1.",
  });
});

export default router;
