/**
 * Data Import module — Tally/Zoho-style migration of old-ERP masters.
 *
 * Pipeline per module (customers / vendors / ledgers):
 *   1. GET  /imports/templates/:module      → pre-filled sample .xlsx
 *   2. POST /imports/parse                  → upload + validate → batch preview
 *   3. POST /imports/batches/:id/commit     → create records (same code paths
 *                                             as manual creation), row by row
 *   4. GET  /imports/batches                → history
 *   5. POST /imports/batches/:id/rollback   → delete ONLY that batch's records
 *
 * Commit goes through lib/partyCreate.ts, lib/chartGroups.insertChartAccount
 * and lib/openingBalances.ts — the exact code manual creation uses — so ledger
 * auto-provisioning, location stamping and audit stamps behave identically.
 *
 * Rollback eligibility is decided from ACTUAL state at rollback time (ledger
 * postings, sales/purchases, child ledgers), never from the history flag: a
 * batch that looks rollback-able in the list can still refuse with per-record
 * reasons if its records have since been used.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import express from "express";
import ExcelJS from "exceljs";
import { pool } from "@workspace/db";
import { requireModuleView, requireModuleAction } from "../middleware/permissions";
import { logActivity } from "../lib/audit";
import {
  createCustomerWithLedger, createVendorWithLedger,
  ensureCustomerLedger, ensureVendorLedger,
} from "../lib/partyCreate";
import { insertChartAccount, loadLedgerUsage } from "../lib/chartGroups";
import { upsertOpeningBalance, currentFinancialYear } from "../lib/openingBalances";

const router: IRouter = Router();

const PERM = "page:/company/import";

type ImportModule = "customers" | "vendors" | "ledgers";
const MODULES: ImportModule[] = ["customers", "vendors", "ledgers"];

function asModule(v: unknown): ImportModule | null {
  const s = String(v ?? "").toLowerCase();
  return (MODULES as string[]).includes(s) ? (s as ImportModule) : null;
}

// ── Column specs ─────────────────────────────────────────────────────────────

interface ColSpec {
  key: string;
  header: string;
  required?: boolean;
  example: string | number;
  hint: string;
  /** normalized header aliases that map onto this column */
  aliases: string[];
}

/** lower-case and strip everything that is not a letter or digit. */
const normHeader = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const PARTY_COMMON: ColSpec[] = [
  { key: "phone", header: "Phone", example: "9876543210", hint: "10-digit mobile (91/0 prefix accepted)", aliases: ["phone", "mobile", "phoneno", "mobileno", "phonenumber", "mobilenumber", "contact", "contactno"] },
  { key: "email", header: "Email", example: "accounts@example.com", hint: "Email address", aliases: ["email", "emailid", "emailaddress", "mail"] },
  { key: "gstNumber", header: "GSTIN", example: "33AAACM1234F1Z5", hint: "15-character GSTIN, blank if unregistered", aliases: ["gstin", "gstno", "gstnumber", "gst", "gstinno"] },
  { key: "pan", header: "PAN", example: "AAACM1234F", hint: "10-character PAN, blank if unknown", aliases: ["pan", "panno", "pannumber"] },
  { key: "state", header: "State", example: "Tamil Nadu", hint: "State name", aliases: ["state", "statename"] },
  { key: "address", header: "Address", example: "12 Market Road, Chennai", hint: "Full address", aliases: ["address", "billingaddress", "addr"] },
];

const OPENING_COLS: ColSpec[] = [
  { key: "openingBalance", header: "Opening Balance", example: 25000, hint: "Amount as on migration date; blank or 0 for none", aliases: ["openingbalance", "opening", "openingbal", "obalance", "openingamount", "balance"] },
  { key: "openingType", header: "Opening Type (Dr/Cr)", example: "Dr", hint: "Dr or Cr", aliases: ["openingtype", "openingtypedrcr", "drcr", "balancetype", "type", "openingdrcr"] },
];

const NOTES_COL: ColSpec = { key: "notes", header: "Notes", example: "Migrated from old ERP", hint: "Free text", aliases: ["notes", "remarks", "note", "comment", "comments"] };

const TEMPLATES: Record<ImportModule, { title: string; columns: ColSpec[] }> = {
  customers: {
    title: "Customers",
    columns: [
      { key: "name", header: "Name", required: true, example: "Fresh Mart Traders", hint: "Customer name (required, must be unique)", aliases: ["name", "customername", "customer", "partyname", "party"] },
      ...PARTY_COMMON,
      { key: "creditLimit", header: "Credit Limit", example: 50000, hint: "₹ credit limit; blank or 0 for none", aliases: ["creditlimit", "creditlimitrs", "creditamount"] },
      ...OPENING_COLS,
      NOTES_COL,
    ],
  },
  vendors: {
    title: "Vendors",
    columns: [
      { key: "name", header: "Name", required: true, example: "Global Fruits Supply Co", hint: "Vendor name (required, must be unique)", aliases: ["name", "vendorname", "vendor", "suppliername", "supplier", "partyname", "party"] },
      ...PARTY_COMMON,
      ...OPENING_COLS,
      NOTES_COL,
    ],
  },
  ledgers: {
    title: "Ledgers",
    columns: [
      { key: "name", header: "Ledger Name", required: true, example: "Office Electricity", hint: "Ledger name (required, must be unique)", aliases: ["ledgername", "name", "accountname", "account", "ledger"] },
      { key: "group", header: "Ledger Group", required: true, example: "Indirect Expense", hint: "Must match an existing group — see the 'Valid Groups' sheet", aliases: ["ledgergroup", "group", "under", "parentgroup", "parent", "groupname", "accountgroup"] },
      ...OPENING_COLS,
      { key: "gstApplicable", header: "GST Applicable", example: "No", hint: "Yes or No", aliases: ["gstapplicable", "gst", "gstyn"] },
      NOTES_COL,
    ],
  },
};

// ── Cell / value normalisation ───────────────────────────────────────────────

/** exceljs cell values can be rich objects — flatten to a trimmed string. */
function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as any;
    if (typeof o.text === "string") return o.text.trim();
    if (Array.isArray(o.richText)) return o.richText.map((r: any) => r.text ?? "").join("").trim();
    if (o.result !== undefined) return cellText(o.result);
    if (o.hyperlink && typeof o.hyperlink === "string") return String(o.text ?? o.hyperlink).trim();
  }
  return String(v).trim();
}

/** '' → null; strips ₹, commas and spaces; NaN/negative rejected by caller. */
function parseMoney(s: string): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[₹,\s]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN as unknown as number;
}

function parseOpeningType(s: string): "debit" | "credit" | null | "invalid" {
  const t = s.toLowerCase().replace(/[^a-z]/g, "");
  if (!t) return null;
  if (["dr", "debit", "d"].includes(t)) return "debit";
  if (["cr", "credit", "c"].includes(t)) return "credit";
  return "invalid";
}

function parseYesNo(s: string): boolean | null | "invalid" {
  const t = s.toLowerCase().replace(/[^a-z]/g, "");
  if (!t) return null;
  if (["yes", "y", "true", "applicable"].includes(t)) return true;
  if (["no", "n", "false", "notapplicable", "na"].includes(t)) return false;
  return "invalid";
}

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Accepts bare 10-digit, or with 0 / 91 / +91 prefixes. Returns digits or null. */
function parsePhone(s: string): string | null | "invalid" {
  if (!s) return null;
  const digits = s.replace(/[^\d]/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  return "invalid";
}

// ── Ledger group resolution ──────────────────────────────────────────────────

interface ParentCandidate {
  id: number;
  name: string;
  type: string;
  section: string | null;
  isGroup: boolean;
}

/**
 * Valid parents for an imported ledger: every active group in the chart, plus
 * the Sundry Debtors / Sundry Creditors heads (leaf ledgers that already parent
 * the auto-provisioned party ledgers — the manual route allows leaf parents as
 * sub-ledger holders, so the import does too).
 */
async function loadParentCandidates(): Promise<ParentCandidate[]> {
  const { rows } = await pool.query<any>(`
    SELECT id, name, type, section, is_group FROM account_ledgers
    WHERE is_active IS NOT FALSE
      AND (is_group = true OR is_system_group = true OR code IN ('SYS-DEBTORS', 'SYS-CREDITORS'))
  `);
  return rows.map((r: any) => ({
    id: Number(r.id), name: String(r.name), type: String(r.type),
    section: r.section ?? null, isGroup: Boolean(r.is_group),
  }));
}

/** Common old-ERP spellings → this chart's group names. */
const GROUP_ALIASES: Record<string, string> = {
  asset: "Current Asset", assets: "Current Asset", currentassets: "Current Asset",
  fixedassets: "Fixed Asset", fixedasset: "Fixed Asset",
  liability: "Current Liabilities", liabilities: "Current Liabilities", currentliability: "Current Liabilities",
  loans: "Loans (Liability)", loan: "Loans (Liability)", loansliability: "Loans (Liability)",
  capital: "Capital Accounts", capitalaccount: "Capital Accounts", capitalaccounts: "Capital Accounts",
  purchases: "Purchase", purchaseaccounts: "Purchase",
  salesaccounts: "Sales", sale: "Sales",
  directexpenses: "Direct Expense", indirectexpenses: "Indirect Expense",
  expense: "Indirect Expense", expenses: "Indirect Expense",
  directincomes: "Direct Income", indirectincomes: "Indirect Income",
  income: "Indirect Income", incomes: "Indirect Income",
};

function resolveGroup(raw: string, candidates: ParentCandidate[]): ParentCandidate | null {
  const n = normHeader(raw);
  if (!n) return null;
  const byNorm = new Map(candidates.map((c) => [normHeader(c.name), c]));
  const direct = byNorm.get(n);
  if (direct) return direct;
  // singular/plural slack: "Fixed Assets" → "Fixed Asset"
  const singular = n.endsWith("s") ? n.slice(0, -1) : `${n}s`;
  const loose = byNorm.get(singular);
  if (loose) return loose;
  const alias = GROUP_ALIASES[n];
  if (alias) return byNorm.get(normHeader(alias)) ?? null;
  return null;
}

const groupSuggestion = (candidates: ParentCandidate[]) =>
  `Valid groups: ${candidates.map((c) => c.name).sort((a, b) => a.localeCompare(b)).join(", ")}`;

// ── Validation ───────────────────────────────────────────────────────────────

interface RowVerdict {
  status: "valid" | "warning" | "error";
  reason: string | null;
  suggestion: string | null;
  duplicateOfId: number | null;
  /** normalized values the commit will use */
  norm: Record<string, unknown>;
}

interface ValidateContext {
  existingByName: Map<string, number>;
  /** existing ledger flags for duplicate messaging (ledgers module only) */
  existingLedgerMeta?: Map<string, { id: number; system: boolean }>;
  seenNames: Map<string, number>; // lower name → first row number in this file
  parentCandidates?: ParentCandidate[];
}

function validateRow(
  module: ImportModule,
  rowNumber: number,
  values: Record<string, string>,
  ctx: ValidateContext,
): RowVerdict {
  const errors: string[] = [];
  const warnings: string[] = [];
  const suggestions: string[] = [];
  const norm: Record<string, unknown> = {};
  let duplicateOfId: number | null = null;

  const name = (values.name ?? "").trim();
  if (!name) {
    errors.push(module === "ledgers" ? "Ledger Name is required" : "Name is required");
  } else if (name.length < 2) {
    errors.push("Name must be at least 2 characters");
  } else if (name.length > 120) {
    errors.push("Name is limited to 120 characters");
  }
  norm.name = name;

  // in-file duplicate: the SECOND occurrence is the error
  if (name) {
    const key = name.toLowerCase();
    const first = ctx.seenNames.get(key);
    if (first !== undefined) {
      errors.push(`Duplicate of row ${first} in this file`);
      suggestions.push("Keep one row per name — remove or rename the duplicate");
    } else {
      ctx.seenNames.set(key, rowNumber);
      const existing = ctx.existingByName.get(key);
      if (existing !== undefined) {
        duplicateOfId = existing;
        if (module === "ledgers" && ctx.existingLedgerMeta?.get(key)?.system) {
          errors.push(`"${name}" already exists as a system account and cannot be imported over`);
          suggestions.push("Rename this ledger, or record its opening balance on the existing account");
        } else {
          warnings.push(`"${name}" already exists — will be skipped or updated per your choice at commit`);
        }
      }
    }
  }

  if (module === "customers" || module === "vendors") {
    const gst = (values.gstNumber ?? "").trim().toUpperCase();
    if (gst) {
      if (!GSTIN_RE.test(gst)) {
        errors.push(`GSTIN "${gst}" is not a valid 15-character GSTIN`);
        suggestions.push("Format: 2-digit state code + PAN + entity digit + Z + check digit, e.g. 33AAACM1234F1Z5");
      }
      norm.gstNumber = gst;
    }
    const pan = (values.pan ?? "").trim().toUpperCase();
    if (pan) {
      if (!PAN_RE.test(pan)) {
        errors.push(`PAN "${pan}" is not a valid 10-character PAN`);
        suggestions.push("Format: 5 letters + 4 digits + 1 letter, e.g. AAACM1234F");
      }
      norm.pan = pan;
    }
    if (gst && pan && GSTIN_RE.test(gst) && PAN_RE.test(pan) && gst.slice(2, 12) !== pan) {
      warnings.push("PAN does not match the PAN embedded in the GSTIN");
    }
    const phone = parsePhone((values.phone ?? "").trim());
    if (phone === "invalid") {
      errors.push(`Phone "${values.phone}" is not a 10-digit number`);
      suggestions.push("Use a 10-digit mobile number (91/0 prefix accepted)");
    } else if (phone) {
      norm.phone = phone;
    }
    const email = (values.email ?? "").trim();
    if (email) {
      if (!EMAIL_RE.test(email)) {
        errors.push(`Email "${email}" does not look like an email address`);
        suggestions.push("Use name@domain.tld, or leave blank");
      }
      norm.email = email.toLowerCase();
    }
    if ((values.state ?? "").trim()) norm.state = values.state.trim();
    if ((values.address ?? "").trim()) norm.address = values.address.trim();
    if ((values.notes ?? "").trim()) norm.notes = values.notes.trim();

    if (module === "customers") {
      const cl = parseMoney((values.creditLimit ?? "").trim());
      if (cl !== null) {
        if (!Number.isFinite(cl) || cl < 0) errors.push(`Credit Limit "${values.creditLimit}" must be a number ≥ 0`);
        else norm.creditLimit = cl;
      }
    }
  }

  if (module === "ledgers") {
    const groupRaw = (values.group ?? "").trim();
    const candidates = ctx.parentCandidates ?? [];
    if (!groupRaw) {
      errors.push("Ledger Group is required");
      suggestions.push(groupSuggestion(candidates));
    } else {
      const parent = resolveGroup(groupRaw, candidates);
      if (!parent) {
        errors.push(`"${groupRaw}" is not a valid ledger group`);
        suggestions.push(groupSuggestion(candidates));
      } else {
        norm.groupName = parent.name;
        norm.groupId = parent.id;
        norm.groupType = parent.type;
        if (normHeader(parent.name) !== normHeader(groupRaw)) {
          warnings.push(`Group "${groupRaw}" matched "${parent.name}"`);
        }
      }
    }
    const gstApp = parseYesNo((values.gstApplicable ?? "").trim());
    if (gstApp === "invalid") warnings.push(`GST Applicable "${values.gstApplicable}" not understood — leaving unset (use Yes or No)`);
    else if (gstApp !== null) norm.gstApplicable = gstApp;
    if ((values.notes ?? "").trim()) norm.notes = values.notes.trim();
  }

  // Opening balance + Dr/Cr — all three modules
  const ob = parseMoney((values.openingBalance ?? "").trim());
  if (ob !== null) {
    if (!Number.isFinite(ob) || ob < 0) {
      errors.push(`Opening Balance "${values.openingBalance}" must be a number ≥ 0`);
    } else if (ob > 0) {
      norm.openingBalance = ob;
      const t = parseOpeningType((values.openingType ?? "").trim());
      if (t === "invalid") {
        errors.push(`Opening Type "${values.openingType}" must be Dr or Cr`);
      } else if (t === null) {
        const fallback =
          module === "customers" ? "debit"
          : module === "vendors" ? "credit"
          : ["asset", "expense"].includes(String(norm.groupType ?? "")) ? "debit" : "credit";
        norm.openingType = fallback;
        warnings.push(`Opening Type blank — defaulting to ${fallback === "debit" ? "Dr" : "Cr"}`);
      } else {
        norm.openingType = t;
      }
    }
  }

  if (errors.length > 0) {
    return { status: "error", reason: errors.join("; "), suggestion: suggestions[0] ?? null, duplicateOfId, norm };
  }
  if (warnings.length > 0) {
    return { status: "warning", reason: warnings.join("; "), suggestion: suggestions[0] ?? null, duplicateOfId, norm };
  }
  return { status: "valid", reason: null, suggestion: null, duplicateOfId, norm };
}

// ── Serialisation ────────────────────────────────────────────────────────────

function batchJson(b: any) {
  return {
    id: Number(b.id),
    module: b.module,
    filename: b.filename,
    status: b.status,
    totalRows: Number(b.total_rows),
    validRows: Number(b.valid_rows),
    warningRows: Number(b.warning_rows),
    errorRows: Number(b.error_rows),
    importedRows: Number(b.imported_rows),
    updatedRows: Number(b.updated_rows),
    skippedRows: Number(b.skipped_rows),
    failedRows: Number(b.failed_rows),
    createdBy: b.created_by,
    createdAt: b.created_at,
    committedAt: b.committed_at,
    committedBy: b.committed_by,
    rolledBackAt: b.rolled_back_at,
    rolledBackBy: b.rolled_back_by,
    // "available" from cheap state — actual eligibility is re-decided at
    // rollback time from live usage.
    rollbackAvailable:
      b.status === "committed" && !b.rolled_back_at &&
      (Number(b.imported_rows) > 0),
  };
}

function rowJson(r: any) {
  const raw = r.raw ?? {};
  return {
    id: Number(r.id),
    rowNumber: Number(r.row_number),
    status: r.status,
    reason: r.reason ?? null,
    suggestion: r.suggestion ?? null,
    duplicateOfId: r.duplicate_of_id == null ? null : Number(r.duplicate_of_id),
    values: raw.values ?? {},
    createdRecordType: r.created_record_type ?? null,
    createdRecordId: r.created_record_id == null ? null : Number(r.created_record_id),
    createdLedgerId: r.created_ledger_id == null ? null : Number(r.created_ledger_id),
  };
}

const username = (req: Request) => (req as any).employee?.username ?? "system";

// ── 1. Sample templates ──────────────────────────────────────────────────────

router.get("/imports/templates/:module", requireModuleAction(PERM, "download"), async (req: Request, res: Response): Promise<void> => {
  const module = asModule(req.params.module);
  if (!module) { res.status(400).json({ error: `Unknown import module — use one of: ${MODULES.join(", ")}` }); return; }
  const spec = TEMPLATES[module];

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(spec.title);

  ws.columns = spec.columns.map((c) => ({
    header: c.required ? `${c.header} *` : c.header,
    key: c.key,
    width: Math.max(16, c.header.length + 6),
  }));
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  spec.columns.forEach((c, i) => {
    const cell = headerRow.getCell(i + 1);
    if (c.required) cell.font = { bold: true, color: { argb: "FFC00000" } };
    cell.note = c.hint + (c.required ? " — REQUIRED" : "");
  });
  ws.addRow(spec.columns.map((c) => c.example));
  ws.views = [{ state: "frozen", ySplit: 1 }];

  // Second sheet: how to fill + (for ledgers) the live list of valid groups.
  const help = wb.addWorksheet(module === "ledgers" ? "Valid Groups" : "Instructions");
  help.getColumn(1).width = 60;
  help.addRow(["How to use this template"]).font = { bold: true };
  help.addRow(["• Columns marked * (red) are required. Keep the header row unchanged."]);
  help.addRow(["• Replace the example row with your data — one record per row."]);
  help.addRow(["• Opening Type is Dr or Cr. Opening Balance is the amount as on migration date."]);
  help.addRow([""]);
  if (module === "ledgers") {
    help.addRow(["Valid Ledger Group values (current chart of accounts):"]).font = { bold: true };
    for (const c of await loadParentCandidates()) help.addRow([c.name]);
  } else {
    help.addRow(["Names must be unique — a name that already exists is flagged as a duplicate,"]);
    help.addRow(["and you choose at commit time whether to skip it or update the existing record."]);
  }

  const buf = await wb.xlsx.writeBuffer();
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${module}-import-sample.xlsx"`);
  res.send(Buffer.from(buf as ArrayBuffer));
});

// ── 2. Upload + parse + validate ─────────────────────────────────────────────

const MAX_ROWS = 2000;

router.post(
  "/imports/parse",
  requireModuleAction(PERM, "add"),
  // Raw body (like the backup upload): the file is parsed server-side anyway,
  // so a multipart wrapper or a presigned round-trip buys nothing.
  express.raw({ type: () => true, limit: "10mb" }),
  async (req: Request, res: Response): Promise<void> => {
    const module = asModule(req.query.module);
    if (!module) { res.status(400).json({ error: `Pass ?module= one of: ${MODULES.join(", ")}` }); return; }
    const filename = String(req.query.filename ?? "upload.xlsx").replace(/[^A-Za-z0-9 ._()-]/g, "_").slice(-120);
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: "The uploaded file was empty." }); return;
    }

    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(body as any);
    } catch {
      res.status(400).json({ error: "That file could not be read as an Excel (.xlsx) workbook. Download the sample and fill it in." });
      return;
    }
    const ws = wb.worksheets[0];
    if (!ws || ws.rowCount < 2) {
      res.status(400).json({ error: "The first sheet has no data rows below the header." }); return;
    }

    // Map headers → column keys via the alias table.
    const spec = TEMPLATES[module];
    const colForIdx = new Map<number, string>();
    const headerCells = ws.getRow(1);
    headerCells.eachCell((cell, colNumber) => {
      const h = normHeader(cellText(cell.value).replace(/\*/g, ""));
      if (!h) return;
      const match = spec.columns.find((c) => c.aliases.includes(h) || normHeader(c.header) === h);
      if (match && ![...colForIdx.values()].includes(match.key)) colForIdx.set(colNumber, match.key);
    });
    const mappedKeys = new Set(colForIdx.values());
    const missingRequired = spec.columns.filter((c) => c.required && !mappedKeys.has(c.key));
    if (missingRequired.length > 0) {
      res.status(400).json({
        error: `Required column${missingRequired.length > 1 ? "s" : ""} not found: ${missingRequired.map((c) => c.header).join(", ")}. Keep the sample's header row unchanged.`,
      });
      return;
    }

    // Existing-name index for duplicate detection.
    const existingByName = new Map<string, number>();
    const existingLedgerMeta = new Map<string, { id: number; system: boolean }>();
    if (module === "ledgers") {
      const { rows } = await pool.query<any>(
        `SELECT id, lower(name) AS lname, (code IS NOT NULL OR is_group = true OR is_system_group = true) AS system
           FROM account_ledgers`,
      );
      for (const r of rows) {
        if (!existingByName.has(r.lname)) {
          existingByName.set(r.lname, Number(r.id));
          existingLedgerMeta.set(r.lname, { id: Number(r.id), system: Boolean(r.system) });
        }
      }
    } else {
      const { rows } = await pool.query<any>(`SELECT id, lower(name) AS lname FROM ${module}`);
      for (const r of rows) if (!existingByName.has(r.lname)) existingByName.set(r.lname, Number(r.id));
    }

    const ctx: ValidateContext = {
      existingByName,
      existingLedgerMeta: module === "ledgers" ? existingLedgerMeta : undefined,
      seenNames: new Map(),
      parentCandidates: module === "ledgers" ? await loadParentCandidates() : undefined,
    };

    // Walk data rows. Row numbers reported to the user are SPREADSHEET rows.
    const parsed: Array<{ rowNumber: number; values: Record<string, string>; verdict: RowVerdict }> = [];
    for (let rn = 2; rn <= ws.rowCount; rn++) {
      const row = ws.getRow(rn);
      const values: Record<string, string> = {};
      let hasAny = false;
      for (const [colNumber, key] of colForIdx) {
        const text = cellText(row.getCell(colNumber).value);
        if (text) hasAny = true;
        values[key] = text;
      }
      if (!hasAny) continue; // blank line
      if (parsed.length >= MAX_ROWS) {
        res.status(400).json({ error: `That file has more than ${MAX_ROWS} rows — split it into smaller files.` });
        return;
      }
      parsed.push({ rowNumber: rn, values, verdict: validateRow(module, rn, values, ctx) });
    }
    if (parsed.length === 0) {
      res.status(400).json({ error: "No data rows found below the header." }); return;
    }

    const counts = { valid: 0, warning: 0, error: 0 };
    for (const p of parsed) counts[p.verdict.status]++;

    const emp = (req as any).employee as { branchType?: string; branchId?: number } | undefined;
    const { rows: [batch] } = await pool.query(
      `INSERT INTO import_batches (module, filename, status, total_rows, valid_rows, warning_rows, error_rows, created_by, location_type, location_id)
       VALUES ($1, $2, 'validated', $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [module, filename, parsed.length, counts.valid, counts.warning, counts.error,
       username(req), emp?.branchType ?? "headoffice", emp?.branchId ?? 0],
    );

    const rowsOut: any[] = [];
    for (const p of parsed) {
      const { rows: [r] } = await pool.query(
        `INSERT INTO import_rows (batch_id, row_number, raw, status, reason, suggestion, duplicate_of_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [batch.id, p.rowNumber, JSON.stringify({ values: p.values, norm: p.verdict.norm }),
         p.verdict.status, p.verdict.reason, p.verdict.suggestion, p.verdict.duplicateOfId],
      );
      rowsOut.push(r);
    }

    logActivity({
      action: "CREATE", module: "imports", entityType: "import_batch", entityId: Number(batch.id),
      description: `Validated ${module} import "${filename}" — ${parsed.length} rows (${counts.valid} valid, ${counts.warning} warnings, ${counts.error} errors)`,
      user: username(req),
    }).catch(() => {});

    res.status(201).json({ batch: batchJson(batch), rows: rowsOut.map(rowJson) });
  },
);

// ── 3. History + detail ──────────────────────────────────────────────────────

router.get("/imports/batches", requireModuleView(PERM), async (_req: Request, res: Response): Promise<void> => {
  const { rows } = await pool.query(`SELECT * FROM import_batches ORDER BY id DESC LIMIT 200`);
  res.json({ batches: rows.map(batchJson) });
});

router.get("/imports/batches/:id", requireModuleView(PERM), async (req: Request, res: Response): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const { rows: [batch] } = await pool.query(`SELECT * FROM import_batches WHERE id = $1`, [id]);
  if (!batch) { res.status(404).json({ error: "Import batch not found" }); return; }
  const { rows } = await pool.query(`SELECT * FROM import_rows WHERE batch_id = $1 ORDER BY row_number`, [id]);
  res.json({ batch: batchJson(batch), rows: rows.map(rowJson) });
});

// ── 4. Commit ────────────────────────────────────────────────────────────────

router.post("/imports/batches/:id/commit", requireModuleAction(PERM, "add"), async (req: Request, res: Response): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const body = (req.body ?? {}) as { skipRowIds?: unknown; duplicateAction?: unknown };
  const duplicateAction = body.duplicateAction === "update" ? "update" : "skip";
  const skipSet = new Set<number>(
    Array.isArray(body.skipRowIds) ? body.skipRowIds.map(Number).filter(Number.isInteger) : [],
  );

  // The whole commit runs under the batch's advisory lock, held on a dedicated
  // connection for the duration of the row loop. Rollback takes the same lock
  // with try-lock semantics, so it can never interleave with a live commit —
  // without this, a rollback arriving mid-commit could delete the rows created
  // so far while the loop keeps creating more, leaving untracked records.
  const lockClient = await pool.connect();
  let locked = false;
  try {
  await lockClient.query(`SELECT pg_advisory_lock(hashtext($1))`, [`import_batch_${id}`]);
  locked = true;

  // Atomic claim — two concurrent commits of one batch must collapse to one.
  const { rows: [batch] } = await pool.query(
    `UPDATE import_batches SET status = 'committing', committed_at = NOW(), committed_by = $2
     WHERE id = $1 AND status = 'validated' RETURNING *`,
    [id, username(req)],
  );
  if (!batch) {
    const { rows: [b] } = await pool.query(`SELECT status FROM import_batches WHERE id = $1`, [id]);
    if (!b) { res.status(404).json({ error: "Import batch not found" }); return; }
    res.status(409).json({ error: `This batch is ${b.status === "committing" ? "already being committed" : `already ${String(b.status).replace("_", " ")}`} — refresh the history.` });
    return;
  }

  const module = batch.module as ImportModule;
  const emp = (req as any).employee as { branchType?: string; branchId?: number } | undefined;
  const stamp = { type: emp?.branchType ?? "headoffice", id: emp?.branchId ?? 0 };
  const user = username(req);
  const fy = await currentFinancialYear();

  const { rows: importRows } = await pool.query(
    `SELECT * FROM import_rows WHERE batch_id = $1 ORDER BY row_number`, [id],
  );

  const counts = { imported: 0, updated: 0, skipped: 0, failed: 0 };
  const failures: Array<{ rowNumber: number; name: string; reason: string }> = [];

  const setRow = (rowId: number, fields: Record<string, unknown>) => {
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
    return pool.query(`UPDATE import_rows SET ${sets} WHERE id = $1`, [rowId, ...keys.map((k) => fields[k])]);
  };

  for (const r of importRows) {
    const values = (r.raw?.values ?? {}) as Record<string, string>;
    const norm = (r.raw?.norm ?? {}) as Record<string, any>;
    const name = String(norm.name ?? values.name ?? "").trim();

    if (r.status === "error") {
      counts.skipped++; // error rows never commit; verdict text already explains why
      continue;
    }
    if (skipSet.has(Number(r.id))) {
      counts.skipped++;
      await setRow(r.id, { status: "skipped", reason: "Skipped by user at commit" });
      continue;
    }

    try {
      const opening = Number(norm.openingBalance ?? 0);
      const openingType = (norm.openingType ?? "debit") as "debit" | "credit";

      if (module === "customers" || module === "vendors") {
        // Re-check existence AT COMMIT TIME — another batch or a manual create
        // may have landed the same name since validation.
        const { rows: [dupe] } = await pool.query<any>(
          `SELECT id FROM ${module} WHERE lower(name) = lower($1) LIMIT 1`, [name],
        );
        if (dupe) {
          if (duplicateAction === "skip") {
            counts.skipped++;
            await setRow(r.id, { status: "skipped", reason: `"${name}" already exists — duplicates skipped`, duplicate_of_id: dupe.id });
            continue;
          }
          // Update the EXISTING record with the non-blank imported fields.
          const sets: string[] = []; const params: unknown[] = [];
          const put = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
          if (norm.phone !== undefined) put("phone", norm.phone);
          if (norm.email !== undefined) put("email", norm.email);
          if (norm.address !== undefined) put("address", norm.address);
          if (norm.gstNumber !== undefined) put("gst_number", norm.gstNumber);
          if (norm.state !== undefined) put("state", norm.state);
          if (norm.pan !== undefined) put("pan", norm.pan);
          if (norm.notes !== undefined) put("notes", norm.notes);
          if (module === "customers" && norm.creditLimit !== undefined) put("credit_limit", norm.creditLimit);
          if (sets.length > 0) {
            params.push(dupe.id);
            await pool.query(`UPDATE ${module} SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $${params.length}`, params);
          }
          let obNote = "";
          if (opening > 0) {
            const ledgerId = module === "customers"
              ? await ensureCustomerLedger(dupe.id, name)
              : await ensureVendorLedger(dupe.id, name);
            if (ledgerId) {
              await upsertOpeningBalance({
                ledgerId, balance: opening, balanceType: openingType,
                asOfDate: fy.startDate, financialYear: fy.label,
                notes: `Imported (batch #${id})`, user, ledgerName: name,
              });
              obNote = "; opening balance updated";
            } else obNote = "; opening balance NOT recorded (party ledger missing)";
          }
          counts.updated++;
          // No created ids stamped: rollback removes only records this batch
          // CREATED — updates to pre-existing records are not reversible here.
          await setRow(r.id, { status: "updated", reason: `Updated existing record${obNote}`, duplicate_of_id: dupe.id });
          continue;
        }

        // CREATE — the same code path as POST /customers|/vendors.
        const input: any = {
          name,
          ...(norm.phone !== undefined ? { phone: norm.phone } : {}),
          ...(norm.email !== undefined ? { email: norm.email } : {}),
          ...(norm.address !== undefined ? { address: norm.address } : {}),
          ...(norm.gstNumber !== undefined ? { gstNumber: norm.gstNumber } : {}),
          ...(norm.state !== undefined ? { state: norm.state } : {}),
          ...(norm.pan !== undefined ? { pan: norm.pan } : {}),
          ...(norm.notes !== undefined ? { notes: norm.notes } : {}),
        };
        const { row, ledgerId } = module === "customers"
          ? await createCustomerWithLedger(input, stamp)
          : await createVendorWithLedger(input, stamp);
        if (module === "customers" && norm.creditLimit !== undefined) {
          await pool.query(`UPDATE customers SET credit_limit = $1 WHERE id = $2`, [norm.creditLimit, row.id]);
        }
        let obId: number | null = null;
        let reason: string | null = null;
        if (opening > 0) {
          if (ledgerId) {
            const ob = await upsertOpeningBalance({
              ledgerId, balance: opening, balanceType: openingType,
              asOfDate: fy.startDate, financialYear: fy.label,
              notes: `Imported (batch #${id})`, user, ledgerName: name,
            });
            obId = ob.id;
          } else {
            reason = "Created, but the party ledger could not be provisioned — opening balance NOT recorded";
          }
        }
        counts.imported++;
        await setRow(r.id, {
          status: "imported", reason,
          created_record_type: module === "customers" ? "customer" : "vendor",
          created_record_id: row.id, created_ledger_id: ledgerId, opening_balance_id: obId,
        });
        continue;
      }

      // ── Ledgers ──
      const { rows: [dupe] } = await pool.query<any>(
        `SELECT id, code, is_group, is_system_group FROM account_ledgers WHERE lower(name) = lower($1) LIMIT 1`, [name],
      );
      if (dupe) {
        if (dupe.code || dupe.is_group || dupe.is_system_group) {
          counts.skipped++;
          await setRow(r.id, { status: "skipped", reason: `"${name}" already exists as a system account or group — cannot import over it`, duplicate_of_id: dupe.id });
          continue;
        }
        if (duplicateAction === "skip") {
          counts.skipped++;
          await setRow(r.id, { status: "skipped", reason: `"${name}" already exists — duplicates skipped`, duplicate_of_id: dupe.id });
          continue;
        }
        let obNote = "";
        if (opening > 0) {
          await upsertOpeningBalance({
            ledgerId: dupe.id, balance: opening, balanceType: openingType,
            asOfDate: fy.startDate, financialYear: fy.label,
            notes: `Imported (batch #${id})`, user, ledgerName: name,
          });
          obNote = "opening balance updated";
        }
        counts.updated++;
        await setRow(r.id, { status: "updated", reason: `Updated existing ledger${obNote ? ` — ${obNote}` : ""}`, duplicate_of_id: dupe.id });
        continue;
      }

      // Re-resolve the parent AT COMMIT TIME — it may have been renamed or
      // deactivated since validation.
      const candidates = await loadParentCandidates();
      const parent = norm.groupId
        ? candidates.find((c) => c.id === Number(norm.groupId)) ?? resolveGroup(String(values.group ?? ""), candidates)
        : resolveGroup(String(values.group ?? ""), candidates);
      if (!parent) {
        counts.failed++;
        failures.push({ rowNumber: r.row_number, name, reason: `Group "${values.group}" no longer exists` });
        await setRow(r.id, { status: "failed", reason: `Group "${values.group}" no longer exists — re-upload after fixing`, suggestion: groupSuggestion(candidates) });
        continue;
      }
      const descriptionParts: string[] = [];
      if (norm.notes) descriptionParts.push(String(norm.notes));
      if (norm.gstApplicable === true) descriptionParts.push("GST applicable");
      if (norm.gstApplicable === false) descriptionParts.push("GST not applicable");

      // Same code path as POST /accounts/chart — code stays NULL by design.
      const created = await insertChartAccount(pool, {
        name, type: parent.type, parentId: parent.id, section: parent.section,
        description: descriptionParts.length ? descriptionParts.join(" · ") : null,
        isGroup: false, user,
      });
      let obId: number | null = null;
      if (opening > 0) {
        const ob = await upsertOpeningBalance({
          ledgerId: created.id, balance: opening, balanceType: openingType,
          asOfDate: fy.startDate, financialYear: fy.label,
          notes: `Imported (batch #${id})`, user, ledgerName: name,
        });
        obId = ob.id;
      }
      counts.imported++;
      await setRow(r.id, {
        status: "imported", created_record_type: "ledger",
        created_record_id: created.id, created_ledger_id: created.id, opening_balance_id: obId,
      });
    } catch (e: any) {
      counts.failed++;
      const reason = String(e?.message ?? e).slice(0, 400);
      failures.push({ rowNumber: r.row_number, name, reason });
      await setRow(r.id, { status: "failed", reason }).catch(() => {});
    }
  }

  // Conditional on the state this commit claimed — never overwrite whatever
  // another actor may have written (defence in depth; the advisory lock
  // already makes that impossible).
  const { rows: [finished] } = await pool.query(
    `UPDATE import_batches SET status = 'committed',
        imported_rows = $2, updated_rows = $3, skipped_rows = $4, failed_rows = $5
     WHERE id = $1 AND status = 'committing' RETURNING *`,
    [id, counts.imported, counts.updated, counts.skipped, counts.failed],
  );
  if (!finished) {
    res.status(409).json({ error: "The batch state changed while committing — refresh the history and check its rows." });
    return;
  }

  logActivity({
    action: "CREATE", module: "imports", entityType: "import_batch", entityId: id,
    description: `Committed ${module} import "${batch.filename}" — ${counts.imported} imported, ${counts.updated} updated, ${counts.skipped} skipped, ${counts.failed} failed`,
    user,
  }).catch(() => {});

  res.json({ batch: batchJson(finished), summary: counts, failures });
  } finally {
    if (locked) await lockClient.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`import_batch_${id}`]).catch(() => {});
    lockClient.release();
  }
});

// ── 5. Rollback ──────────────────────────────────────────────────────────────

router.post("/imports/batches/:id/rollback", requireModuleAction(PERM, "delete"), async (req: Request, res: Response): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const user = username(req);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Try-lock, not wait: the commit endpoint holds this lock for its whole
    // row loop, so "busy" means a commit is running right now — surface that
    // instead of blocking the request until it finishes.
    const { rows: [lock] } = await client.query(
      `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS got`, [`import_batch_${id}`],
    );
    if (!lock?.got) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "This batch is being committed right now — wait for the commit to finish, then try again." });
      return;
    }
    const { rows: [batch] } = await client.query(`SELECT * FROM import_batches WHERE id = $1 FOR UPDATE`, [id]);
    if (!batch) { await client.query("ROLLBACK"); res.status(404).json({ error: "Import batch not found" }); return; }
    if (batch.rolled_back_at || batch.status === "rolled_back") {
      await client.query("ROLLBACK"); res.status(409).json({ error: "This batch was already rolled back." }); return;
    }
    // Only FULLY committed batches roll back. 'committing' is refused even
    // when the lock was free (e.g. the committing server died mid-loop) —
    // a half-committed batch needs eyes, not an automatic delete.
    if (batch.status !== "committed") {
      await client.query("ROLLBACK"); res.status(409).json({ error: "Only committed batches can be rolled back." }); return;
    }

    const { rows: created } = await client.query(
      `SELECT * FROM import_rows
        WHERE batch_id = $1 AND status = 'imported'
          AND (created_record_id IS NOT NULL OR created_ledger_id IS NOT NULL OR opening_balance_id IS NOT NULL)
        ORDER BY row_number`,
      [id],
    );
    if (created.length === 0) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "This batch created no records (only updates/skips), so there is nothing to roll back." });
      return;
    }

    const obIds = created.map((r: any) => r.opening_balance_id).filter((v: any) => v != null).map(Number);
    const ledgerIds = created.map((r: any) => r.created_ledger_id).filter((v: any) => v != null).map(Number);
    const customerIds = created.filter((r: any) => r.created_record_type === "customer").map((r: any) => Number(r.created_record_id));
    const vendorIds = created.filter((r: any) => r.created_record_type === "vendor").map((r: any) => Number(r.created_record_id));

    // 1. Opening balances go first — inside this txn, so if anything below
    //    blocks, the deletes are undone with the ROLLBACK.
    if (obIds.length > 0) await client.query(`DELETE FROM opening_balances WHERE id = ANY($1::int[])`, [obIds]);

    // 2. Eligibility from ACTUAL state. loadLedgerUsage runs on this client so
    //    it no longer sees the opening balances we just removed — anything left
    //    is genuine downstream usage.
    const blocked: Array<{ rowNumber: number; name: string; reason: string }> = [];
    const usage = await loadLedgerUsage(client as any);

    const childCounts = new Map<number, number>();
    if (ledgerIds.length > 0) {
      const { rows } = await client.query(
        `SELECT parent_id, COUNT(*)::int AS n FROM account_ledgers WHERE parent_id = ANY($1::int[]) GROUP BY parent_id`,
        [ledgerIds],
      );
      for (const r of rows) childCounts.set(Number(r.parent_id), Number(r.n));
    }

    // Party document usage — sources checked against information_schema so a
    // missing table can never crash the rollback.
    const partyUsage = async (table: string, col: string, ids: number[]) => {
      if (ids.length === 0) return new Map<number, number>();
      const { rows: [t] } = await client.query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
        [table, col],
      );
      if (!t) return new Map<number, number>();
      const { rows } = await client.query(
        `SELECT ${col} AS pid, COUNT(*)::int AS n FROM ${table} WHERE ${col} = ANY($1::int[]) GROUP BY ${col}`,
        [ids],
      );
      return new Map<number, number>(rows.map((r: any) => [Number(r.pid), Number(r.n)]));
    };
    const custSales = await partyUsage("sales", "customer_id", customerIds);
    const custQuotes = await partyUsage("quotations", "customer_id", customerIds);
    const vendPurchases = await partyUsage("purchases", "vendor_id", vendorIds);
    const vendAssets = await partyUsage("asset_purchases", "vendor_id", vendorIds);

    for (const r of created) {
      const name = String(r.raw?.norm?.name ?? r.raw?.values?.name ?? `row ${r.row_number}`);
      const reasons: string[] = [];
      const lid = r.created_ledger_id == null ? null : Number(r.created_ledger_id);
      if (lid != null) {
        const u = usage.get(lid);
        if (u && u.transactions > 0) reasons.push(`its ledger carries ${u.transactions} entr${u.transactions === 1 ? "y" : "ies"} (${u.transactionSources.join(", ")})`);
        if (u && u.references.length > 0) reasons.push(`its ledger is wired to ${u.references.join(", ")}`);
        const kids = childCounts.get(lid) ?? 0;
        if (kids > 0) reasons.push(`its ledger now has ${kids} sub-account${kids === 1 ? "" : "s"}`);
      }
      if (r.created_record_type === "customer") {
        const rid = Number(r.created_record_id);
        const s = custSales.get(rid) ?? 0; const q = custQuotes.get(rid) ?? 0;
        if (s > 0) reasons.push(`${s} sale${s === 1 ? "" : "s"} reference this customer`);
        if (q > 0) reasons.push(`${q} quotation${q === 1 ? "" : "s"} reference this customer`);
      }
      if (r.created_record_type === "vendor") {
        const rid = Number(r.created_record_id);
        const p = vendPurchases.get(rid) ?? 0; const a = vendAssets.get(rid) ?? 0;
        if (p > 0) reasons.push(`${p} purchase${p === 1 ? "" : "s"} reference this vendor`);
        if (a > 0) reasons.push(`${a} asset purchase${a === 1 ? "" : "s"} reference this vendor`);
      }
      if (reasons.length > 0) blocked.push({ rowNumber: Number(r.row_number), name, reason: reasons.join("; ") });
    }

    if (blocked.length > 0) {
      await client.query("ROLLBACK");
      res.status(409).json({
        error: `Cannot roll back: ${blocked.length} imported record${blocked.length === 1 ? " has" : "s have"} since been used. Remove that activity first, or leave the batch in place.`,
        blocked,
      });
      return;
    }

    // 3. Dependency order: opening balances (done) → ledgers → parties.
    if (ledgerIds.length > 0) await client.query(`DELETE FROM account_ledgers WHERE id = ANY($1::int[])`, [ledgerIds]);
    if (customerIds.length > 0) await client.query(`DELETE FROM customers WHERE id = ANY($1::int[])`, [customerIds]);
    if (vendorIds.length > 0) await client.query(`DELETE FROM vendors WHERE id = ANY($1::int[])`, [vendorIds]);

    await client.query(
      `UPDATE import_rows SET status = 'rolled_back' WHERE batch_id = $1 AND status = 'imported'`, [id],
    );
    const { rows: [finished] } = await client.query(
      `UPDATE import_batches SET status = 'rolled_back', rolled_back_at = NOW(), rolled_back_by = $2 WHERE id = $1 RETURNING *`,
      [id, user],
    );
    await client.query("COMMIT");

    logActivity({
      action: "DELETE", module: "imports", entityType: "import_batch", entityId: id,
      description: `Rolled back ${batch.module} import "${batch.filename}" — removed ${created.length} created record${created.length === 1 ? "" : "s"}`,
      user,
    }).catch(() => {});

    res.json({ batch: batchJson(finished), removed: created.length });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
});

export default router;
