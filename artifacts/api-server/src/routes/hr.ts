import { Router } from "express";
import { requireModuleAction, requireModuleView } from "../middleware/permissions";
import { nextVoucherNumber } from "../lib/voucherNumber";
import {
  db, pool, hierarchiesTable, employeesTable, payrollTable, attendanceTable,
  leavesTable, warehousesTable, outletsTable, payComponentsTable,
} from "@workspace/db";
import { PasswordService } from '../lib/password';
import { DEFAULT_INITIAL_PASSWORD } from '../lib/passwordPolicy';
import { eq, and, gte, lte, sql } from "drizzle-orm";
import { logActivity } from "../lib/audit";
import { getUserDataScope, scopeBranchWhere } from "../lib/dataScope";
import {
  CreateHierarchyBody, UpdateHierarchyBody, DeleteHierarchyParams,
  CreateEmployeeBody, UpdateEmployeeBody, GetEmployeeParams, DeleteEmployeeParams,
  CheckInBody, CheckOutBody, ApplyLeaveBody, ApproveLeaveBody,
  ListPayrollQueryParams, ListAttendanceQueryParams, ListLeavesQueryParams,
} from "@workspace/api-zod";

const router = Router();

// ── Helpers ────────────────────────────────────────────────────────────────

async function getBranchName(branchType: string, branchId: number): Promise<string> {
  if (branchType === "headoffice") return "Head Office";
  if (branchType === "warehouse") {
    const [w] = await db.select().from(warehousesTable).where(eq(warehousesTable.id, branchId)).limit(1);
    return w?.name ?? "Warehouse";
  }
  if (branchType === "outlet") {
    const [o] = await db.select().from(outletsTable).where(eq(outletsTable.id, branchId)).limit(1);
    return o?.name ?? "Outlet";
  }
  return "Unknown";
}

// Allowances only support 'fixed' or 'percent_of_basic' (not percent_of_gross,
// since gross is not yet known when allowances are computed).
type AllowanceType = "fixed" | "percent_of_basic";
type DeductionType = "fixed" | "percent_of_basic" | "percent_of_gross";

interface AllowanceComp {
  name: string;
  type: AllowanceType;
  value: number;
  enabled?: boolean;
}

interface DeductionComp {
  name: string;
  type: DeductionType;
  value: number;
  enabled?: boolean;
}

const ALLOWANCE_TYPES = new Set<string>(["fixed", "percent_of_basic"]);
const DEDUCTION_TYPES = new Set<string>(["fixed", "percent_of_basic", "percent_of_gross"]);

function validateComponents(allowances: unknown[], deductions: unknown[]): string | null {
  for (const a of allowances) {
    const c = a as any;
    if (typeof c.name !== "string" || !c.name.trim()) return "Allowance name is required";
    if (!ALLOWANCE_TYPES.has(c.type)) return `Invalid allowance type: ${c.type}. Must be fixed or percent_of_basic`;
    if (typeof c.value !== "number" || c.value < 0) return "Allowance value must be a non-negative number";
  }
  for (const d of deductions) {
    const c = d as any;
    if (typeof c.name !== "string" || !c.name.trim()) return "Deduction name is required";
    if (!DEDUCTION_TYPES.has(c.type)) return `Invalid deduction type: ${c.type}`;
    if (typeof c.value !== "number" || c.value < 0) return "Deduction value must be a non-negative number";
  }
  return null;
}

function round2(n: number) { return Math.round(n * 100) / 100; }

const MONTH_LABELS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// ── Statutory contribution rates ───────────────────────────────────────────
// PF and ESI are company-wide statutory obligations, so the rates live in
// company settings rather than on each employee. Every generated payroll run
// stores the rates it used (see StatutorySnapshot) so that a later rate change
// can never alter a period that has already been approved or paid.
export interface StatutoryRates {
  pfEnabled: boolean;
  pfEmployeePercent: number;
  pfEmployerPercent: number;
  esiEnabled: boolean;
  esiEmployeePercent: number;
  esiEmployerPercent: number;
}

const STATUTORY_DEFAULTS: StatutoryRates = {
  pfEnabled: true,  pfEmployeePercent: 12,   pfEmployerPercent: 12,
  esiEnabled: true, esiEmployeePercent: 0.75, esiEmployerPercent: 3.25,
};

async function loadStatutoryRates(): Promise<StatutoryRates> {
  try {
    const { rows: [r] } = await pool.query(
      `SELECT pf_enabled, pf_employee_percent, pf_employer_percent,
              esi_enabled, esi_employee_percent, esi_employer_percent
         FROM company_settings LIMIT 1`
    );
    if (!r) return { ...STATUTORY_DEFAULTS };
    return {
      pfEnabled:  r.pf_enabled !== false,
      pfEmployeePercent:  Number(r.pf_employee_percent  ?? 12),
      pfEmployerPercent:  Number(r.pf_employer_percent  ?? 12),
      esiEnabled: r.esi_enabled !== false,
      esiEmployeePercent: Number(r.esi_employee_percent ?? 0.75),
      esiEmployerPercent: Number(r.esi_employer_percent ?? 3.25),
    };
  } catch {
    // Columns not migrated yet — fall back to the statutory defaults.
    return { ...STATUTORY_DEFAULTS };
  }
}

/**
 * PF and ESI used to be modelled as ordinary per-employee deductions, seeded
 * from a hard-coded default list. Now that they are computed centrally from
 * company settings, any legacy component with a statutory name would deduct the
 * same contribution a second time. Drop those, but only for the scheme that is
 * actually switched on — a company that keeps PF off should keep honouring a
 * manually configured PF line.
 */
const PF_NAME_RE  = /\b(pf|epf|provident)\b/i;
const ESI_NAME_RE = /\b(esi|esic)\b/i;

function stripStatutoryDuplicates(deductions: DeductionComp[], rates: StatutoryRates): DeductionComp[] {
  return deductions.filter(d => {
    const name = String(d.name ?? "");
    if (rates.pfEnabled  && PF_NAME_RE.test(name))  return false;
    if (rates.esiEnabled && ESI_NAME_RE.test(name)) return false;
    return true;
  });
}

function computePayroll(opts: {
  baseSalary: number;
  workingDays: number;
  presentDays: number;
  allowances: AllowanceComp[];
  deductions: DeductionComp[];
  rates?: StatutoryRates;
}) {
  const { baseSalary, workingDays, presentDays, allowances, deductions } = opts;
  const lopDays = Math.max(0, workingDays - presentDays);
  const perDayRate = workingDays > 0 ? baseSalary / workingDays : 0;
  const lopDeduction = round2(lopDays * perDayRate);
  const effectiveBasic = round2(baseSalary - lopDeduction);

  // Allowances: fixed or percent_of_basic only
  const allowancesBreakdown: { name: string; amount: number }[] = [];
  let allowancesTotal = 0;
  for (const a of allowances) {
    if (a.enabled === false) continue;
    const amount = a.type === "fixed"
      ? round2(a.value)
      : round2(effectiveBasic * a.value / 100);
    allowancesBreakdown.push({ name: a.name, amount });
    allowancesTotal += amount;
  }
  allowancesTotal = round2(allowancesTotal);
  const grossPay = round2(effectiveBasic + allowancesTotal);

  // Statutory contributions. PF is levied on basic pay, ESI on gross — both on
  // the post-LOP figures, because a day not worked is not wages.
  const rates = opts.rates ?? { ...STATUTORY_DEFAULTS, pfEnabled: false, esiEnabled: false };
  const pfEmployee  = rates.pfEnabled  ? round2(effectiveBasic * rates.pfEmployeePercent  / 100) : 0;
  const pfEmployer  = rates.pfEnabled  ? round2(effectiveBasic * rates.pfEmployerPercent  / 100) : 0;
  const esiEmployee = rates.esiEnabled ? round2(grossPay       * rates.esiEmployeePercent / 100) : 0;
  const esiEmployer = rates.esiEnabled ? round2(grossPay       * rates.esiEmployerPercent / 100) : 0;

  // Deductions: fixed, percent_of_basic, or percent_of_gross
  const otherDeductionsBreakdown: { name: string; amount: number }[] = [];
  let otherDeductionsTotal = 0;
  for (const d of deductions) {
    if (d.enabled === false) continue;
    let amount: number;
    if (d.type === "fixed") amount = round2(d.value);
    else if (d.type === "percent_of_basic") amount = round2(effectiveBasic * d.value / 100);
    else amount = round2(grossPay * d.value / 100); // percent_of_gross
    otherDeductionsBreakdown.push({ name: d.name, amount });
    otherDeductionsTotal += amount;
  }
  otherDeductionsTotal = round2(otherDeductionsTotal);

  // The stored breakdown is the audit record of what was withheld, so the
  // statutory lines belong in it alongside the configured deductions. Only the
  // employee's share reduces take-home pay; the employer's share is a separate
  // cost carried by the business and never subtracted from the employee.
  const deductionsBreakdown = [
    ...otherDeductionsBreakdown,
    ...(pfEmployee  > 0 ? [{ name: `Provident Fund (${rates.pfEmployeePercent}% of basic)`, amount: pfEmployee  }] : []),
    ...(esiEmployee > 0 ? [{ name: `ESI (${rates.esiEmployeePercent}% of gross)`,           amount: esiEmployee }] : []),
  ];
  const deductionsTotal = round2(otherDeductionsTotal + pfEmployee + esiEmployee);
  const netPay = round2(grossPay - deductionsTotal);

  return {
    lopDays, lopDeduction, effectiveBasic, grossPay,
    allowancesTotal, allowancesBreakdown,
    deductions: deductionsTotal, deductionsBreakdown,
    otherDeductions: otherDeductionsTotal, otherDeductionsBreakdown,
    pfEmployee, pfEmployer, esiEmployee, esiEmployer,
    // Full cost to the business: what the employee earns plus the employer's
    // statutory share. This is the amount that must hit the P&L.
    employerCost: round2(grossPay + pfEmployer + esiEmployer),
    netPay,
  };
}

function enrichPayroll(r: any, emp?: any) {
  return {
    ...r,
    employeeName: emp?.name ?? r.employeeName ?? r.employee_name ?? "",
    baseSalary:        Number(r.baseSalary       ?? r.base_salary        ?? 0),
    lopDeduction:      Number(r.lopDeduction      ?? r.lop_deduction      ?? 0),
    grossPay:          Number(r.grossPay          ?? r.gross_pay          ?? 0),
    allowancesTotal:   Number(r.allowancesTotal   ?? r.allowances_total   ?? 0),
    allowancesBreakdown: r.allowancesBreakdown    ?? r.allowances_breakdown ?? [],
    deductions:        Number(r.deductions        ?? 0),
    deductionsBreakdown: r.deductionsBreakdown    ?? r.deductions_breakdown ?? [],
    netPay:            Number(r.netPay            ?? r.net_pay            ?? 0),
    bonus:             Number(r.bonus             ?? 0),
    totalAmount:       Number(r.totalAmount       ?? r.total_amount       ?? r.netPay ?? r.net_pay ?? 0),
    lopDays:           Number(r.lopDays           ?? r.lop_days           ?? 0),
    workingDays:       Number(r.workingDays       ?? r.working_days       ?? 26),
    presentDays:       Number(r.presentDays       ?? r.present_days       ?? 26),
    // workflow
    status:            r.status ?? 'draft',
    approvedAt:        r.approvedAt   ?? r.approved_at   ?? null,
    extraAmount:       Number(r.extraAmount   ?? r.extra_amount   ?? 0),
    extraNote:         r.extraNote    ?? r.extra_note    ?? null,
    paidAmount:        Number(r.paidAmount    ?? r.paid_amount    ?? 0),
    paymentMode:       r.paymentMode  ?? r.payment_mode  ?? null,
    advanceDeduction:  Number(r.advanceDeduction ?? r.advance_deduction ?? 0),
    // statutory
    pfEmployee:        Number(r.pfEmployee   ?? r.pf_employee   ?? 0),
    pfEmployer:        Number(r.pfEmployer   ?? r.pf_employer   ?? 0),
    esiEmployee:       Number(r.esiEmployee  ?? r.esi_employee  ?? 0),
    esiEmployer:       Number(r.esiEmployer  ?? r.esi_employer  ?? 0),
    statutorySnapshot: r.statutorySnapshot ?? r.statutory_snapshot ?? null,
  };
}

// ── Ledger provisioning helper ─────────────────────────────────────────────
async function findOrProvisionLedger(
  code: string,
  name: string,
  type: string,
  parentCode: string,
  description: string,
): Promise<number | null> {
  const { rows: [existing] } = await pool.query(`SELECT id FROM account_ledgers WHERE code = $1 LIMIT 1`, [code]);
  if (existing) return existing.id;
  const { rows: [parent] } = await pool.query(`SELECT id FROM account_ledgers WHERE code = $1 LIMIT 1`, [parentCode]);
  // Section follows the ledger type. This used to be hard-coded to
  // 'balance_sheet', which stamped every per-employee salary ledger as a
  // balance-sheet account even though it is an expense.
  const section = (type === "expense" || type === "income") ? "profit_loss" : "balance_sheet";
  const { rows: [created] } = await pool.query(
    `INSERT INTO account_ledgers (name, type, code, section, parent_id, is_group, is_system_group, description)
     VALUES ($1, $2, $3, $4, $5, false, false, $6)
     ON CONFLICT DO NOTHING RETURNING id`,
    [name, type, code, section, parent?.id ?? null, description],
  );
  if (created) return created.id;
  const { rows: [retry] } = await pool.query(`SELECT id FROM account_ledgers WHERE code = $1 LIMIT 1`, [code]);
  return retry?.id ?? null;
}

/** Look up a standard ledger by code, failing loudly if seeding never ran. */
async function requireLedgerId(code: string): Promise<number> {
  const { rows: [row] } = await pool.query(`SELECT id FROM account_ledgers WHERE code = $1 LIMIT 1`, [code]);
  if (!row) throw new Error(`Ledger ${code} is missing from the chart of accounts`);
  return row.id;
}

/**
 * Post the salary approval voucher and move the payroll row to 'approved'.
 *
 * Everything happens in one transaction: the voucher, its lines, the advance
 * recoveries it closes and the status change. Either the books and the payroll
 * row both move or neither does — approval can no longer be recorded against
 * accounting that failed to post.
 */
async function postSalaryApproval(opts: {
  payroll: any;
  empLabel: string;
  voucherDate: string;
  periodLabel: string;
  createdBy: string;
}): Promise<{ updated: any; netPay: number; salaryCost: number; voucherNumber: string }> {
  const { payroll: pr, empLabel, voucherDate, periodLabel, createdBy } = opts;
  const employeeId = Number(pr.employee_id);

  const extraAmt    = round2(Number(pr.extra_amount ?? 0));
  const grossPay    = round2(Number(pr.gross_pay ?? 0));
  const pfEmployee  = round2(Number(pr.pf_employee ?? 0));
  const pfEmployer  = round2(Number(pr.pf_employer ?? 0));
  const esiEmployee = round2(Number(pr.esi_employee ?? 0));
  const esiEmployer = round2(Number(pr.esi_employer ?? 0));
  const advanceRec  = round2(Number(pr.advance_deduction ?? 0));
  const netPay      = round2(Number(pr.net_pay ?? 0) + extraAmt);

  // Withholdings other than PF/ESI, derived so the voucher always balances even
  // for rows generated before the statutory columns existed.
  const totalDeductions = round2(Number(pr.deductions ?? 0));
  const otherDeductions = round2(Math.max(0, totalDeductions - pfEmployee - esiEmployee));

  // Salary expense carries gross pay plus anything added by hand (arrears,
  // bonus). Employer contributions are separate expenses.
  const salaryCost = round2(grossPay + extraAmt);
  const debitTotal = round2(salaryCost + pfEmployer + esiEmployer);

  const salExpId = await findOrProvisionLedger(
    `SAL-EMP-${employeeId}`, `Salary - ${empLabel}`, 'expense', 'SYS-INDEXP',
    `Salary expense for ${empLabel}`,
  );
  const salPayId = await findOrProvisionLedger(
    `SAL-PAY-${employeeId}`, `Salary Payable - ${empLabel}`, 'liability', 'SYS-CURL',
    `Salary payable to ${empLabel}`,
  );
  if (!salExpId || !salPayId) throw new Error("Could not provision the employee's salary ledgers");

  const advLedgerId = advanceRec > 0.004
    ? await findOrProvisionLedger(
        `ADV-EMP-${employeeId}`, `Advance to ${empLabel}`, 'asset', 'SYS-CURA',
        `Salary advance paid to ${empLabel}`)
    : null;
  if (advanceRec > 0.004 && !advLedgerId) throw new Error("Could not provision the employee's advance ledger");

  const debits: Array<[number, number]> = [[salExpId, salaryCost]];
  const credits: Array<[number, number]> = [];
  if (pfEmployer  > 0.004) debits.push([await requireLedgerId('STD-PF-EMPR'),  pfEmployer]);
  if (esiEmployer > 0.004) debits.push([await requireLedgerId('STD-ESI-EMPR'), esiEmployer]);

  const pfPayable  = round2(pfEmployee + pfEmployer);
  const esiPayable = round2(esiEmployee + esiEmployer);
  if (pfPayable      > 0.004) credits.push([await requireLedgerId('STD-PF-PAY'),  pfPayable]);
  if (esiPayable     > 0.004) credits.push([await requireLedgerId('STD-ESI-PAY'), esiPayable]);
  if (otherDeductions > 0.004) credits.push([await requireLedgerId('STD-EMP-DED'), otherDeductions]);
  if (advanceRec      > 0.004 && advLedgerId) credits.push([advLedgerId, advanceRec]);
  if (netPay          > 0.004) credits.push([salPayId, netPay]);

  const creditTotal = round2(credits.reduce((s, [, amt]) => s + amt, 0));
  if (Math.abs(creditTotal - debitTotal) > 0.02) {
    throw new Error(
      `Salary entry does not balance (debit ${debitTotal.toFixed(2)} vs credit ${creditTotal.toFixed(2)}) — payroll figures are inconsistent`
    );
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Re-read under a row lock so two concurrent approvals cannot both post.
    const { rows: [locked] } = await client.query(
      `SELECT status FROM payroll WHERE id = $1 FOR UPDATE`, [pr.id],
    );
    if (!locked) throw new Error("Payroll record disappeared");
    if (locked.status === 'approved' || locked.status === 'paid') {
      throw new Error("This payroll was already approved by someone else");
    }

    const voucherNumber = await nextVoucherNumber(client, "journal", voucherDate);
    const narration = `Salary Approved — ${empLabel} — ${periodLabel}`;
    const { rows: [jv] } = await client.query(
      `INSERT INTO journal_vouchers (voucher_type, voucher_number, voucher_date, narration, total_amount, created_by)
       VALUES ('journal', $1, $2, $3, $4, $5) RETURNING id`,
      [voucherNumber, voucherDate, narration, debitTotal.toFixed(2), createdBy],
    );

    for (const [ledgerId, amt] of debits) {
      await client.query(
        `INSERT INTO journal_voucher_lines (voucher_id, ledger_id, debit, credit) VALUES ($1, $2, $3, 0)`,
        [jv.id, ledgerId, amt.toFixed(2)],
      );
    }
    for (const [ledgerId, amt] of credits) {
      await client.query(
        `INSERT INTO journal_voucher_lines (voucher_id, ledger_id, debit, credit) VALUES ($1, $2, 0, $3)`,
        [jv.id, ledgerId, amt.toFixed(2)],
      );
    }

    // Close the advances this run recovered. They were claimed at generation
    // time, so only the ones still attached to this payroll are marked.
    const claimedIds: number[] = Array.isArray(pr.advance_ids) ? pr.advance_ids.map(Number) : [];
    if (claimedIds.length) {
      await client.query(
        `UPDATE employee_advances SET is_deducted = TRUE, deducted_payroll_id = $1
          WHERE id = ANY($2::int[]) AND is_deducted = FALSE`,
        [pr.id, claimedIds],
      );
    }

    const { rows: [updated] } = await client.query(
      `UPDATE payroll SET status = 'approved', approved_at = NOW() WHERE id = $1 RETURNING *`,
      [pr.id],
    );

    await client.query("COMMIT");
    return { updated, netPay, salaryCost, voucherNumber };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ── Hierarchies ───────────────────────────────────────────────────────────
router.get("/hr/hierarchies", async (_req, res): Promise<void> => {
  const rows = await db.select().from(hierarchiesTable).orderBy(hierarchiesTable.level);
  res.json(rows);
});

router.post("/hr/hierarchies", requireModuleAction("Hierarchy", "add"), async (req, res): Promise<void> => {
  const parsed = CreateHierarchyBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [row] = await db.insert(hierarchiesTable).values(parsed.data).returning();
  res.status(201).json(row);
});

router.patch("/hr/hierarchies/:id", requireModuleAction("Hierarchy", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const parsed = UpdateHierarchyBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [row] = await db.update(hierarchiesTable).set(parsed.data).where(eq(hierarchiesTable.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(row);
});

router.delete("/hr/hierarchies/:id", requireModuleAction("Hierarchy", "delete"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  await db.delete(hierarchiesTable).where(eq(hierarchiesTable.id, id));
  res.status(204).send();
});

// ── Employees ─────────────────────────────────────────────────────────────
router.get("/hr/employees", requireModuleView("Employees"), async (req, res): Promise<void> => {
  const scopeEmp = (req as any).employee as { branchType: string; branchId: number } | undefined;

  const scopeParams: unknown[] = [];
  let scopeCond = 'TRUE';
  if (scopeEmp && scopeEmp.branchType !== 'headoffice') {
    const scope = await getUserDataScope(scopeEmp);
    scopeCond = scopeBranchWhere(scope, scopeParams, 'e');
  }

  const [{ rows }, hierarchies] = await Promise.all([
    pool.query(
      `SELECT e.id, e.name, e.username, e.email, e.phone,
              e.hierarchy_id AS "hierarchyId", e.branch_type AS "branchType", e.branch_id AS "branchId",
              e.salary, e.join_date AS "joinDate", e.photo_url AS "photoUrl",
              e.is_active AS "isActive", e.must_change_password AS "mustChangePassword",
              e.is_production_staff AS "isProductionStaff"
       FROM employees e WHERE ${scopeCond} ORDER BY e.id`,
      scopeParams,
    ),
    db.select().from(hierarchiesTable),
  ]);

  const hMap = new Map(hierarchies.map((h) => [h.id, h.name]));
  const enriched = await Promise.all((rows as any[]).map(async (e) => ({
    id: e.id, name: e.name, username: e.username, email: e.email ?? null, phone: e.phone ?? null,
    hierarchyId: e.hierarchyId, hierarchyName: hMap.get(e.hierarchyId) ?? "",
    branchType: e.branchType, branchId: e.branchId,
    branchName: await getBranchName(e.branchType, e.branchId),
    salary: Number(e.salary), joinDate: e.joinDate, photoUrl: e.photoUrl ?? null, isActive: e.isActive, mustChangePassword: e.mustChangePassword ?? false,
    isProductionStaff: e.isProductionStaff ?? false,
  })));
  res.json(enriched);
});

/** Marks whether an employee works on the factory floor. Their salary for a day
 *  is what gets spread across that day's batches as labour cost, so this flag
 *  decides who is counted. `is_production_staff` is a raw-migration column and
 *  invisible to drizzle, so it is read and written with explicit SQL. */
async function saveProductionStaffFlag(id: number, body: any): Promise<boolean | undefined> {
  const raw = body?.isProductionStaff;
  if (raw === undefined || raw === null) return undefined;
  const flag = raw === true || raw === "true" || raw === 1 || raw === "1";
  await pool.query(`UPDATE employees SET is_production_staff = $1 WHERE id = $2`, [flag, id]);
  return flag;
}

async function readProductionStaffFlag(id: number): Promise<boolean> {
  const { rows } = await pool.query(`SELECT is_production_staff FROM employees WHERE id = $1`, [id]);
  return rows[0]?.is_production_staff ?? false;
}

router.post("/hr/employees", requireModuleAction("Employees", "add"), async (req, res): Promise<void> => {
  const parsed = CreateEmployeeBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [row] = await db.insert(employeesTable).values({
    ...parsed.data,
    salary: String(parsed.data.salary),
    passwordHash: await PasswordService.hash(DEFAULT_INITIAL_PASSWORD),
    mustChangePassword: true,
  }).returning();
  const [h] = await db.select().from(hierarchiesTable).where(eq(hierarchiesTable.id, row.hierarchyId)).limit(1);
  const isProductionStaff = (await saveProductionStaffFlag(row.id, req.body)) ?? false;

  // Give the employee a real pay structure row straight away. Payroll reads its
  // allowances and deductions from this table, so an employee without a row
  // would silently fall back to whatever the code happened to default to.
  await db.insert(payComponentsTable)
    .values({ employeeId: row.id, allowances: [], deductions: [] })
    .onConflictDoNothing()
    .catch((e) => console.warn("[hr/employees] pay structure seed failed:", e));

  logActivity({
    action: "CREATE", module: "hr", entityType: "employee", entityId: row.id,
    description: `New employee ${row.name} added (${h?.name ?? "role"}) — salary ₹${Number(row.salary).toLocaleString("en-IN")}`,
    metadata: { after: { id: row.id, name: row.name, salary: Number(row.salary), hierarchyName: h?.name, isProductionStaff } },
  }).catch(() => {});

  res.status(201).json({
    id: row.id, name: row.name, username: row.username, email: row.email ?? null, phone: row.phone ?? null,
    hierarchyId: row.hierarchyId, hierarchyName: h?.name ?? "",
    branchType: row.branchType, branchId: row.branchId,
    branchName: await getBranchName(row.branchType, row.branchId),
    salary: Number(row.salary), joinDate: row.joinDate, photoUrl: row.photoUrl ?? null,
    isActive: row.isActive, mustChangePassword: row.mustChangePassword ?? true,
    isProductionStaff,
  });
});

router.get("/hr/employees/:id", requireModuleView("Employees"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const [row] = await db.select().from(employeesTable).where(eq(employeesTable.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const [h] = await db.select().from(hierarchiesTable).where(eq(hierarchiesTable.id, row.hierarchyId)).limit(1);
  res.json({
    id: row.id, name: row.name, username: row.username, email: row.email ?? null, phone: row.phone ?? null,
    hierarchyId: row.hierarchyId, hierarchyName: h?.name ?? "",
    branchType: row.branchType, branchId: row.branchId,
    branchName: await getBranchName(row.branchType, row.branchId),
    salary: Number(row.salary), joinDate: row.joinDate, photoUrl: row.photoUrl ?? null, isActive: row.isActive,
    isProductionStaff: await readProductionStaffFlag(id),
  });
});

router.patch("/hr/employees/:id", requireModuleAction("Employees", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const [before] = await db.select().from(employeesTable).where(eq(employeesTable.id, id)).limit(1);
  const parsed = UpdateEmployeeBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const updateData: Record<string, unknown> = { ...parsed.data };
  if (parsed.data.salary !== undefined) updateData.salary = String(parsed.data.salary);
  const beforeFlag = await readProductionStaffFlag(id);
  // The production-staff flag lives outside the validated body, so a request
  // that only toggles it has nothing for drizzle to set — read the row instead
  // of asking for an empty UPDATE.
  const [row] = Object.keys(updateData).length > 0
    ? await db.update(employeesTable).set(updateData).where(eq(employeesTable.id, id)).returning()
    : await db.select().from(employeesTable).where(eq(employeesTable.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const [h] = await db.select().from(hierarchiesTable).where(eq(hierarchiesTable.id, row.hierarchyId)).limit(1);
  const isProductionStaff = (await saveProductionStaffFlag(id, req.body)) ?? beforeFlag;

  logActivity({
    action: "UPDATE", module: "hr", entityType: "employee", entityId: row.id,
    description: `Employee ${row.name} updated`,
    metadata: {
      before: before ? { name: before.name, salary: Number(before.salary), isActive: before.isActive, isProductionStaff: beforeFlag } : undefined,
      after: { name: row.name, salary: Number(row.salary), isActive: row.isActive, isProductionStaff },
      changes: Object.keys(parsed.data),
    },
  }).catch(() => {});

  res.json({
    id: row.id, name: row.name, username: row.username, email: row.email ?? null, phone: row.phone ?? null,
    hierarchyId: row.hierarchyId, hierarchyName: h?.name ?? "",
    branchType: row.branchType, branchId: row.branchId,
    branchName: await getBranchName(row.branchType, row.branchId),
    salary: Number(row.salary), joinDate: row.joinDate, photoUrl: row.photoUrl ?? null, isActive: row.isActive, mustChangePassword: row.mustChangePassword ?? false,
    isProductionStaff,
  });
});

router.delete("/hr/employees/:id", requireModuleAction("Employees", "delete"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.id, id)).limit(1);
  await db.delete(employeesTable).where(eq(employeesTable.id, id));
  logActivity({
    action: "DELETE", module: "hr", entityType: "employee", entityId: id,
    description: `Employee ${emp?.name ?? `#${id}`} deleted`,
    metadata: { before: emp ? { id: emp.id, name: emp.name, salary: Number(emp.salary) } : undefined },
  }).catch(() => {});
  res.status(204).send();
});

// ── Pay Components (per-employee pay structure) ───────────────────────────

router.get("/hr/pay-components/:employeeId", async (req, res): Promise<void> => {
  const employeeId = parseInt(req.params.employeeId, 10);
  // Non-headoffice employees may only read their own pay structure
  const scopeEmp = (req as any).employee as { id: number; branchType: string } | undefined;
  if (scopeEmp && scopeEmp.branchType !== 'headoffice' && scopeEmp.id !== employeeId) {
    res.status(403).json({ error: "You can only view your own pay structure." });
    return;
  }
  const [row] = await db.select().from(payComponentsTable).where(eq(payComponentsTable.employeeId, employeeId)).limit(1);
  if (!row) {
    // Return sensible defaults if no pay structure has been configured
    res.json({
      employeeId,
      workingDaysPerMonth: 26,
      allowances: [
        { name: "HRA", type: "percent_of_basic", value: 40, enabled: true },
        { name: "DA", type: "percent_of_basic", value: 10, enabled: true },
        { name: "Travel Allowance", type: "fixed", value: 1000, enabled: true },
      ],
      deductions: [
        { name: "PF (Employee 12%)", type: "percent_of_basic", value: 12, enabled: true },
        { name: "ESI (0.75%)", type: "percent_of_gross", value: 0.75, enabled: true },
        { name: "TDS", type: "fixed", value: 0, enabled: false },
      ],
    });
    return;
  }
  res.json(row);
});

router.put("/hr/pay-components/:employeeId", requireModuleAction("Payroll", "edit"), async (req, res): Promise<void> => {
  const employeeId = parseInt(req.params.employeeId, 10);
  const { workingDaysPerMonth, allowances, deductions } = req.body;

  // Validate working days
  const wd = Number(workingDaysPerMonth ?? 26);
  if (!Number.isInteger(wd) || wd < 1 || wd > 31) {
    res.status(400).json({ error: "workingDaysPerMonth must be an integer between 1 and 31" });
    return;
  }

  // Validate arrays
  if (!Array.isArray(allowances) || !Array.isArray(deductions)) {
    res.status(400).json({ error: "allowances and deductions must be arrays" });
    return;
  }
  const validationError = validateComponents(allowances, deductions);
  if (validationError) { res.status(400).json({ error: validationError }); return; }

  const [existing] = await db.select().from(payComponentsTable).where(eq(payComponentsTable.employeeId, employeeId)).limit(1);
  let row;
  if (existing) {
    [row] = await db.update(payComponentsTable)
      .set({ workingDaysPerMonth: wd, allowances, deductions })
      .where(eq(payComponentsTable.id, existing.id))
      .returning();
  } else {
    [row] = await db.insert(payComponentsTable)
      .values({ employeeId, workingDaysPerMonth: wd, allowances, deductions })
      .returning();
  }
  res.json(row);
});

// ── Payroll ───────────────────────────────────────────────────────────────

router.get("/hr/payroll", requireModuleView("Payroll"), async (req, res): Promise<void> => {
  const qp = ListPayrollQueryParams.safeParse(req.query);
  const scopeEmp = (req as any).employee as { id: number; branchType: string; branchId: number } | undefined;

  // Non-headoffice employees only see their own payroll
  let empIdFilter: number | null = null;
  if (scopeEmp && scopeEmp.branchType !== 'headoffice') {
    // Map logged-in user → their employee record
    const empRow = await db.select().from(employeesTable).where(eq(employeesTable.id, scopeEmp.id)).limit(1);
    empIdFilter = empRow[0]?.id ?? null;
  }

  // Use raw SQL so the new startup-migration columns are included
  let whereParts = ['1=1'];
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };

  if (qp.success && qp.data.year)  whereParts.push(`pr.year  = ${p(Number(qp.data.year))}`);
  if (qp.success && qp.data.month) whereParts.push(`pr.month = ${p(Number(qp.data.month))}`);
  if (empIdFilter !== null) whereParts.push(`pr.employee_id = ${p(empIdFilter)}`);

  const { rows } = await pool.query(
    `SELECT pr.*, e.name AS employee_name, e.branch_type, e.branch_id
     FROM payroll pr
     JOIN employees e ON e.id = pr.employee_id
     WHERE ${whereParts.join(' AND ')}
     ORDER BY pr.id`,
    params,
  );

  const enriched = await Promise.all(rows.map(async (r: any) => ({
    ...enrichPayroll(r),
    employeeName: r.employee_name ?? "",
    branchName: await getBranchName(r.branch_type, r.branch_id),
  })));
  res.json(enriched);
});

// Generate payroll for a month — creates or updates records for all employees (or one)
router.post("/hr/payroll/generate", requireModuleAction("Payroll", "add"), async (req, res): Promise<void> => {
  const { month, year, employeeId, forceRegenerate = false } = req.body;
  if (!month || !year) { res.status(400).json({ error: "month and year are required" }); return; }

  // Fetch work-hour thresholds from company generalSettings
  const { rows: [csRow] } = await pool.query(
    `SELECT general_settings FROM company_settings LIMIT 1`
  );
  const gs = (csRow?.general_settings as Record<string, any>) ?? {};
  const fullDayHours = Number(gs.fullDayHours ?? 9);
  const halfDayHours = Number(gs.halfDayHours ?? 4.5);

  // Rates in force right now. Snapshotted onto every row this run writes, so
  // changing them later only affects runs generated after the change.
  const rates = await loadStatutoryRates();

  // Fetch employees to generate for
  let employees = await db.select().from(employeesTable).where(eq(employeesTable.isActive, true));
  if (employeeId) employees = employees.filter(e => e.id === Number(employeeId));

  // Date range for the month
  const monthStr = String(month).padStart(2, "0");
  const daysInMonth = new Date(year, month, 0).getDate();
  const startDate = `${year}-${monthStr}-01`;
  const endDate = `${year}-${monthStr}-${String(daysInMonth).padStart(2, "0")}`;

  // Fetch attendance for the whole month (raw SQL to get checkIn/checkOut timestamps)
  const { rows: monthAttendance } = await pool.query(
    `SELECT employee_id AS "employeeId", date, check_in AS "checkIn", check_out AS "checkOut", status
     FROM attendance WHERE date >= $1 AND date <= $2`,
    [startDate, endDate],
  );

  const results = [];

  for (const emp of employees) {
    // Check for existing payroll record (raw SQL to read new columns)
    const { rows: [existing] } = await pool.query(
      `SELECT * FROM payroll WHERE employee_id = $1 AND month = $2 AND year = $3 LIMIT 1`,
      [emp.id, month, year],
    );

    // A run that has been approved or paid is a posted document: it has a
    // journal voucher against it and its statutory figures are what the
    // employee was told. Regenerating would silently contradict both, so it is
    // skipped even when forceRegenerate is set.
    if (existing && (existing.is_paid || existing.status === 'approved' || existing.status === 'paid')) {
      results.push({ ...enrichPayroll(existing, emp), branchName: await getBranchName(emp.branchType, emp.branchId), employeeName: emp.name });
      continue;
    }

    // Fetch pay components. Every employee has a row (seeded at creation and
    // back-filled by migration), so an absent row means an empty structure —
    // basic pay only, plus the statutory contributions.
    const [pc] = await db.select().from(payComponentsTable).where(eq(payComponentsTable.employeeId, emp.id)).limit(1);
    const workingDays = pc?.workingDaysPerMonth ?? 26;
    const allowances: AllowanceComp[] = (pc?.allowances as AllowanceComp[]) ?? [];
    const deductions = stripStatutoryDuplicates((pc?.deductions as DeductionComp[]) ?? [], rates);

    // Hours-based present-days calculation
    const empAtt = monthAttendance.filter((a: any) => Number(a.employeeId) === emp.id);
    let effectivePresentDays: number;
    if (empAtt.length === 0) {
      effectivePresentDays = workingDays; // no data → assume full attendance
    } else {
      let pd = 0;
      for (const a of empAtt) {
        if (a.status === "leave") { pd += 1; continue; } // leave days count as full (no LOP)
        if (a.checkIn && a.checkOut) {
          const hrs = (new Date(a.checkOut).getTime() - new Date(a.checkIn).getTime()) / 3_600_000;
          if (hrs >= fullDayHours) pd += 1;
          else if (hrs >= halfDayHours) pd += 0.5;
          // else 0 (LOP)
        } else if (a.checkIn) {
          pd += 1; // only checked in, no check-out yet → count as full day
        } else if (a.status === "present") {
          pd += 1;
        } else if (a.status === "half_day") {
          pd += 0.5;
        }
      }
      effectivePresentDays = pd;
    }

    // Advances awaiting recovery. A draft run *claims* the advances it nets off
    // (deducted_payroll_id) without marking them recovered; approval completes
    // the recovery. Without the claim, two open drafts would each deduct the
    // same advance, and re-running generate for a later month would recover an
    // advance that an earlier month had already taken back.
    if (existing) {
      await pool.query(
        `UPDATE employee_advances SET deducted_payroll_id = NULL
          WHERE deducted_payroll_id = $1 AND is_deducted = FALSE`,
        [existing.id],
      );
    }
    const { rows: advances } = await pool.query(
      `SELECT id, amount FROM employee_advances
        WHERE employee_id = $1 AND is_deducted = FALSE AND deducted_payroll_id IS NULL
        ORDER BY date ASC, id ASC`,
      [emp.id],
    );

    const baseSalary = Number(emp.salary);
    const computed = computePayroll({ baseSalary, workingDays, presentDays: effectivePresentDays, allowances, deductions, rates });

    // Recovery can never push take-home pay below zero, and an advance is only
    // ever recovered whole — a part-recovered advance would leave the credit
    // posted to the advance ledger out of step with the advances actually
    // closed. Take advances in date order while they still fit in net pay;
    // anything that does not fit stays outstanding for a later run.
    const claimedIds: number[] = [];
    let advanceDeduction = 0;
    let recoverable = computed.netPay;
    for (const a of advances) {
      const amt = Number(a.amount);
      if (amt <= recoverable + 0.005) {
        claimedIds.push(Number(a.id));
        advanceDeduction = round2(advanceDeduction + amt);
        recoverable = round2(recoverable - amt);
      }
    }
    const netPayAfterAdvance = round2(computed.netPay - advanceDeduction);

    const snapshot = {
      ...rates,
      basicPay: computed.effectiveBasic,
      grossPay: computed.grossPay,
      pfEmployee: computed.pfEmployee, pfEmployer: computed.pfEmployer,
      esiEmployee: computed.esiEmployee, esiEmployer: computed.esiEmployer,
      otherDeductions: computed.otherDeductions,
      otherDeductionsBreakdown: computed.otherDeductionsBreakdown,
      employerCost: computed.employerCost,
      capturedAt: new Date().toISOString(),
    };
    const periodLabel = `${MONTH_LABELS[Number(month) - 1] ?? month} ${year}`;

    const writeCols = [
      emp.id, month, year, String(baseSalary), workingDays, effectivePresentDays,
      computed.lopDays, String(computed.lopDeduction), String(computed.grossPay),
      String(computed.allowancesTotal), JSON.stringify(computed.allowancesBreakdown),
      String(computed.deductions), JSON.stringify(computed.deductionsBreakdown),
      String(netPayAfterAdvance), String(advanceDeduction),
      String(computed.pfEmployee), String(computed.pfEmployer),
      String(computed.esiEmployee), String(computed.esiEmployer),
      JSON.stringify(snapshot), JSON.stringify(claimedIds), periodLabel,
    ];

    let row: any;
    if (existing) {
      const { rows: [updated] } = await pool.query(
        `UPDATE payroll SET
           employee_id=$1, month=$2, year=$3, base_salary=$4, working_days=$5, present_days=$6,
           lop_days=$7, lop_deduction=$8, gross_pay=$9, allowances_total=$10, allowances_breakdown=$11,
           deductions=$12, deductions_breakdown=$13, net_pay=$14, total_amount=$14,
           status='draft', advance_deduction=$15,
           pf_employee=$16, pf_employer=$17, esi_employee=$18, esi_employer=$19,
           statutory_snapshot=$20, advance_ids=$21, pay_period_label=$22
         WHERE id=$23 RETURNING *`,
        [...writeCols, existing.id],
      );
      row = updated;
    } else {
      const { rows: [inserted] } = await pool.query(
        `INSERT INTO payroll
           (employee_id, month, year, base_salary, working_days, present_days,
            lop_days, lop_deduction, gross_pay, allowances_total, allowances_breakdown,
            deductions, deductions_breakdown, net_pay, total_amount, advance_deduction,
            pf_employee, pf_employer, esi_employee, esi_employer,
            statutory_snapshot, advance_ids, pay_period_label, bonus, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$15,
                 $16,$17,$18,$19,$20,$21,$22,'0','draft')
         RETURNING *`,
        writeCols,
      );
      row = inserted;
    }

    if (row && claimedIds.length) {
      await pool.query(
        `UPDATE employee_advances SET deducted_payroll_id = $1
          WHERE id = ANY($2::int[]) AND is_deducted = FALSE AND deducted_payroll_id IS NULL`,
        [row.id, claimedIds],
      );
    }

    results.push({
      ...enrichPayroll(row, emp),
      branchName: await getBranchName(emp.branchType, emp.branchId),
      employeeName: emp.name,
    });
  }

  res.json(results);
});

// Edit extra amount / note (for authorised managers before approval)
router.patch("/hr/payroll/:id", requireModuleAction("Payroll", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const { extraAmount = 0, extraNote = null } = req.body;
  // Draft only. An extra amount changes net pay, and approval has already posted
  // a salary voucher for the old figure — editing after that would leave the
  // payslip saying one thing and the ledger another, with nothing to reconcile
  // them. Correcting an approved run means reversing it, not amending it.
  const { rows: [row] } = await pool.query(
    `UPDATE payroll SET extra_amount = $1, extra_note = $2 WHERE id = $3 AND status = 'draft' RETURNING *`,
    [String(Number(extraAmount)), extraNote, id],
  );
  if (!row) {
    const { rows: [cur] } = await pool.query(`SELECT status FROM payroll WHERE id = $1`, [id]);
    if (!cur) { res.status(404).json({ error: "Not found" }); return; }
    res.status(409).json({
      error: `This payroll is already ${cur.status}, so its amounts are locked. Salary has been posted to the accounts for this period — reverse the approval if the figures need to change.`,
    });
    return;
  }
  const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.id, row.employee_id)).limit(1);
  res.json({ ...enrichPayroll(row, emp), branchName: emp ? await getBranchName(emp.branchType, emp.branchId) : "" });
});

// Approve payroll → post the full statutory salary entry.
//
// The old entry debited salary expense with *net* pay, which understated the
// cost of employing someone by every rupee withheld and hid the PF/ESI
// liability entirely. The correct entry recognises the whole cost and splits
// what is owed to whom:
//
//   Dr  Salary - <employee>            gross pay + any extra (arrears/bonus)
//   Dr  Employer PF Contribution       employer's PF share
//   Dr  Employer ESI Contribution      employer's ESI share
//     Cr  PF Payable                   employee + employer PF
//     Cr  ESI Payable                  employee + employer ESI
//     Cr  Employee Deductions Payable  other withholdings (TDS, fines…)
//     Cr  Advance to <employee>         advance recovered this run
//     Cr  Salary Payable - <employee>   net take-home pay
//
// Both sides come to gross + extra + employer contributions, so the voucher
// balances. The two employer ledgers and the per-employee salary ledger all sit
// under Indirect Expenses, which is what carries salary into the P&L.
router.post("/hr/payroll/:id/approve", requireModuleAction("Payroll", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const today = new Date().toISOString().split("T")[0];

  const { rows: [existing] } = await pool.query(`SELECT * FROM payroll WHERE id = $1`, [id]);
  if (!existing) { res.status(404).json({ error: "Not found" }); return; }
  if (existing.status === 'paid')     { res.status(400).json({ error: "Already paid" }); return; }
  if (existing.status === 'approved') { res.status(400).json({ error: "Already approved" }); return; }

  const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.id, existing.employee_id)).limit(1);
  const monthStr = String(existing.month).padStart(2, "0");
  const empLabel = emp?.name ?? `Employee #${existing.employee_id}`;

  try {
    const posting = await postSalaryApproval({
      payroll: existing,
      empLabel,
      voucherDate: today,
      periodLabel: existing.pay_period_label || `${monthStr}/${existing.year}`,
      createdBy: req.employee?.username ?? "system",
    });

    logActivity({ action: "UPDATE", module: "payroll", entityType: "payroll", entityId: id,
      description: `Payroll approved for ${empLabel} — ${monthStr}/${existing.year}`,
      metadata: { netPay: posting.netPay, salaryCost: posting.salaryCost, voucherNumber: posting.voucherNumber },
    }).catch(() => {});

    res.json({ ...enrichPayroll(posting.updated, emp), branchName: emp ? await getBranchName(emp.branchType, emp.branchId) : "" });
  } catch (e: any) {
    // Approval used to swallow posting failures, leaving payroll marked
    // approved with no accounting behind it. The status now moves only if the
    // voucher committed, so a failure here means nothing changed.
    console.error("[payroll/approve] posting failed:", e);
    res.status(500).json({ error: `Could not post the salary entry, so the payroll was not approved: ${e?.message ?? "unknown error"}` });
  }
});

// Pay payroll — supports partial payments and payment mode
router.post("/hr/payroll/:id/pay", requireModuleAction("Payroll", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const today = new Date().toISOString().split("T")[0];
  const payAmount = Number(req.body.amount ?? 0);
  const paymentMode: string = req.body.paymentMode ?? "cash";

  const { rows: [existing] } = await pool.query(`SELECT * FROM payroll WHERE id = $1`, [id]);
  if (!existing) { res.status(404).json({ error: "Not found" }); return; }
  if (existing.status === 'paid') { res.status(400).json({ error: "Already fully paid" }); return; }
  // Payment discharges the salary payable that approval creates. Paying a draft
  // used to quietly post the approval entry as a side effect, which meant a
  // salary could reach the books without anyone approving it.
  if (existing.status !== 'approved') {
    res.status(400).json({ error: "Approve this payroll before recording a payment." });
    return;
  }

  const extraAmt   = Number(existing.extra_amount ?? 0);
  const totalNet   = round2(Number(existing.net_pay ?? 0) + extraAmt);
  const alreadyPaid = Number(existing.paid_amount ?? 0);
  const payNow     = payAmount > 0 ? round2(payAmount) : round2(totalNet - alreadyPaid);
  const newPaidAmt = round2(alreadyPaid + payNow);
  const isFullyPaid = newPaidAmt >= totalNet - 0.005;
  const newStatus   = isFullyPaid ? 'paid' : 'approved';

  const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.id, existing.employee_id)).limit(1);
  const monthStr = String(existing.month).padStart(2, "0");

  if (payNow <= 0.004) {
    res.status(400).json({ error: "Payment amount must be greater than zero." });
    return;
  }

  // Credit the salary payable ledger for this employee; debit cash/bank.
  const salPayId = await findOrProvisionLedger(
    `SAL-PAY-${existing.employee_id}`,
    `Salary Payable - ${emp?.name ?? `Employee #${existing.employee_id}`}`,
    'liability', 'SYS-CURL',
    `Salary payable to ${emp?.name ?? `Employee #${existing.employee_id}`}`,
  );
  const { rows: [cashRow] } = await pool.query(
    paymentMode === 'bank'
      ? `SELECT id FROM account_ledgers WHERE code = 'STD-BANK' LIMIT 1`
      : `SELECT id FROM account_ledgers WHERE code = 'STD-CASH' LIMIT 1`,
  );
  const payLedgerId = cashRow?.id ?? null;
  if (!salPayId || !payLedgerId) {
    res.status(500).json({
      error: "Cannot record this payment: the salary payable or cash/bank ledger is missing. No payment was recorded.",
    });
    return;
  }

  // The voucher and the payroll row move together or not at all. Marking a
  // salary paid while its cash entry failed would show the money as gone from
  // the payroll screen and still sitting in the cash ledger.
  let row: any;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const voucherNumber = await nextVoucherNumber(client, "journal", today);
    const narration = `Salary Payment${isFullyPaid ? '' : ' (Partial)'} — ${emp?.name ?? `Emp #${existing.employee_id}`} — ${monthStr}/${existing.year}`;
    const { rows: [jv] } = await client.query(
      `INSERT INTO journal_vouchers (voucher_type, voucher_number, voucher_date, narration, total_amount, created_by)
       VALUES ('journal', $1, $2, $3, $4, $5) RETURNING id`,
      [voucherNumber, today, narration, payNow.toFixed(2), req.employee?.username ?? "system"],
    );
    // Dr Salary Payable / Cr Cash or Bank
    await client.query(
      `INSERT INTO journal_voucher_lines (voucher_id, ledger_id, debit, credit)
       VALUES ($1, $2, $3, 0), ($1, $4, 0, $3)`,
      [jv.id, salPayId, payNow.toFixed(2), payLedgerId],
    );
    // Re-read under the row lock so two concurrent payments cannot each think
    // they are settling the same outstanding balance.
    const { rows: [locked] } = await client.query(
      `SELECT paid_amount, status FROM payroll WHERE id = $1 FOR UPDATE`, [id],
    );
    if (!locked || locked.status === 'paid') {
      throw Object.assign(new Error("Already fully paid"), { httpStatus: 400 });
    }
    const lockedPaid = round2(Number(locked.paid_amount ?? 0) + payNow);
    const lockedFull = lockedPaid >= totalNet - 0.005;
    const { rows: [updated] } = await client.query(
      `UPDATE payroll
       SET paid_amount = $1, payment_mode = $2, is_paid = $3, paid_date = $4, status = $5
       WHERE id = $6 RETURNING *`,
      [String(lockedPaid), paymentMode, lockedFull, lockedFull ? today : null, lockedFull ? 'paid' : 'approved', id],
    );
    await client.query("COMMIT");
    row = updated;
  } catch (e: any) {
    await client.query("ROLLBACK").catch(() => {});
    const status = e?.httpStatus ?? 500;
    res.status(status).json({
      error: status === 400
        ? e.message
        : "Could not record the salary payment. Nothing was changed — please try again.",
    });
    return;
  } finally {
    client.release();
  }

  logActivity({ action: "UPDATE", module: "payroll", entityType: "payroll", entityId: id,
    description: `Salary ${isFullyPaid ? 'paid' : 'partial payment'} for ${emp?.name ?? `Emp #${existing.employee_id}`} — ₹${payNow.toLocaleString("en-IN")} via ${paymentMode}`,
    metadata: { payNow, totalNet, newPaidAmt, isFullyPaid } }).catch(() => {});

  res.json({ ...enrichPayroll(row, emp), branchName: emp ? await getBranchName(emp.branchType, emp.branchId) : "" });
});

// ── Employee Advances ──────────────────────────────────────────────────────
router.get("/hr/advances", requireModuleView("Payroll"), async (req, res): Promise<void> => {
  const scopeEmp = (req as any).employee as { id: number; branchType: string } | undefined;
  let empFilter = '';
  const params: unknown[] = [];
  if (scopeEmp && scopeEmp.branchType !== 'headoffice') {
    empFilter = `WHERE ea.employee_id = $1`;
    params.push(scopeEmp.id);
  }
  const { rows } = await pool.query(
    `SELECT ea.*, e.name AS employee_name
     FROM employee_advances ea JOIN employees e ON e.id = ea.employee_id
     ${empFilter} ORDER BY ea.created_at DESC`,
    params,
  );
  res.json(rows.map((r: any) => ({
    id: r.id, employeeId: r.employee_id, employeeName: r.employee_name,
    amount: Number(r.amount), date: r.date, note: r.note,
    isDeducted: r.is_deducted, deductedPayrollId: r.deducted_payroll_id,
    createdAt: r.created_at,
  })));
});

router.post("/hr/advances", requireModuleAction("Payroll", "add"), async (req, res): Promise<void> => {
  const { employeeId, amount, date, note } = req.body;
  if (!employeeId || !amount) { res.status(400).json({ error: "employeeId and amount are required" }); return; }
  const today = new Date().toISOString().split("T")[0];
  const advDate = date ?? today;

  const { rows: [row] } = await pool.query(
    `INSERT INTO employee_advances (employee_id, amount, date, note, is_deducted)
     VALUES ($1, $2, $3, $4, false) RETURNING *`,
    [employeeId, String(Number(amount)), advDate, note ?? null],
  );
  const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.id, Number(employeeId))).limit(1);

  // Accounting: Dr Advance-to-Employee / Cr Cash
  try {
    const advLedgerId = await findOrProvisionLedger(
      `ADV-EMP-${employeeId}`,
      `Advance - ${emp?.name ?? `Employee #${employeeId}`}`,
      'asset', 'SYS-CURA',
      `Advance recoverable from ${emp?.name ?? `Employee #${employeeId}`}`,
    );
    const { rows: [cashRow] } = await pool.query(`SELECT id FROM account_ledgers WHERE code = 'STD-CASH' LIMIT 1`);
    if (advLedgerId && cashRow && Number(amount) > 0.004) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const vn = await nextVoucherNumber(client, "journal", advDate);
        const { rows: [jv] } = await client.query(
          `INSERT INTO journal_vouchers (voucher_type, voucher_number, voucher_date, narration, total_amount, created_by)
           VALUES ('journal', $1, $2, $3, $4, $5) RETURNING id`,
          [vn, advDate, `Advance to ${emp?.name ?? `Employee #${employeeId}`}`, Number(amount).toFixed(2), req.employee?.username ?? "system"],
        );
        await client.query(
          `INSERT INTO journal_voucher_lines (voucher_id, ledger_id, debit, credit)
           VALUES ($1, $2, $3, 0), ($1, $4, 0, $3)`,
          [jv.id, advLedgerId, Number(amount).toFixed(2), cashRow.id],
        );
        await client.query("COMMIT");
      } catch (e) { await client.query("ROLLBACK").catch(() => {}); console.warn("[advances] JV error:", e); }
      finally { client.release(); }
    }
  } catch (e) { console.warn("[advances] Accounting error:", e); }

  res.status(201).json({
    id: row.id, employeeId: row.employee_id, employeeName: emp?.name ?? "",
    amount: Number(row.amount), date: row.date, note: row.note,
    isDeducted: row.is_deducted, deductedPayrollId: row.deducted_payroll_id,
    createdAt: row.created_at,
  });
});

// ── Attendance ────────────────────────────────────────────────────────────
router.get("/hr/attendance", async (req, res): Promise<void> => {
  const scopeEmp = (req as any).employee as { id: number; branchType: string } | undefined;

  // ── Month-range mode: ?year=YYYY&month=M returns all records for the month ──
  const yearParam = req.query.year ? Number(req.query.year) : null;
  const monthParam = req.query.month ? Number(req.query.month) : null;

  if (yearParam && monthParam && !isNaN(yearParam) && !isNaN(monthParam)) {
    const padM = String(monthParam).padStart(2, '0');
    const startDate = `${yearParam}-${padM}-01`;
    const lastDay = new Date(yearParam, monthParam, 0).getDate();
    const endDate = `${yearParam}-${padM}-${String(lastDay).padStart(2, '0')}`;

    // Scope: non-headoffice employees only see their own records
    const rows = await db.select().from(attendanceTable).where(
      scopeEmp && scopeEmp.branchType !== 'headoffice'
        ? and(gte(attendanceTable.date, startDate), lte(attendanceTable.date, endDate), eq(attendanceTable.employeeId, scopeEmp.id))
        : and(gte(attendanceTable.date, startDate), lte(attendanceTable.date, endDate))
    );

    const result = rows.map((r) => ({
      id: r.id,
      employeeId: r.employeeId,
      date: typeof r.date === 'string' ? r.date : (r.date as any).toISOString().split('T')[0],
      checkIn: r.checkIn?.toISOString() ?? null,
      checkOut: r.checkOut?.toISOString() ?? null,
      checkInLat: r.checkInLat ? Number(r.checkInLat) : null,
      checkInLng: r.checkInLng ? Number(r.checkInLng) : null,
      checkOutLat: r.checkOutLat ? Number(r.checkOutLat) : null,
      checkOutLng: r.checkOutLng ? Number(r.checkOutLng) : null,
      status: r.status ?? 'absent',
      hoursWorked: r.checkIn && r.checkOut
        ? round2((r.checkOut.getTime() - r.checkIn.getTime()) / 3_600_000)
        : null,
    }));

    res.json(result);
    return;
  }

  // ── Single-date mode (legacy / manager view) ─────────────────────────────
  const qp = ListAttendanceQueryParams.safeParse(req.query);
  const targetDate = (qp.success && qp.data.date) ? qp.data.date : new Date().toISOString().split("T")[0];
  const filterEmployeeId = qp.success && qp.data.employeeId ? Number(qp.data.employeeId) : null;

  // All active employees (or just one if filtered)
  let allEmployees = await db.select().from(employeesTable).where(eq(employeesTable.isActive, true));
  if (filterEmployeeId) allEmployees = allEmployees.filter((e) => e.id === filterEmployeeId);

  // Non-headoffice employees only see their own attendance row
  if (scopeEmp && scopeEmp.branchType !== 'headoffice') {
    allEmployees = allEmployees.filter((e) => e.id === scopeEmp.id);
  }

  // Existing attendance rows for that date
  const rows = await db.select().from(attendanceTable)
    .where(eq(attendanceTable.date, targetDate));
  const attMap = new Map(rows.map((r) => [r.employeeId, r]));

  // Merge: every active employee gets a row (synthetic absent if no record)
  const result = allEmployees.map((emp) => {
    const r = attMap.get(emp.id);
    if (r) {
      return {
        id: r.id,
        employeeId: emp.id,
        employeeName: emp.name,
        date: r.date,
        checkIn: r.checkIn?.toISOString() ?? null,
        checkOut: r.checkOut?.toISOString() ?? null,
        checkInLat: r.checkInLat ? Number(r.checkInLat) : null,
        checkInLng: r.checkInLng ? Number(r.checkInLng) : null,
        checkOutLat: r.checkOutLat ? Number(r.checkOutLat) : null,
        checkOutLng: r.checkOutLng ? Number(r.checkOutLng) : null,
        status: r.status,
        hoursWorked: r.checkIn && r.checkOut
          ? round2((r.checkOut.getTime() - r.checkIn.getTime()) / 3_600_000)
          : null,
      };
    }
    // No record yet — synthetic absent row
    return {
      id: null,
      employeeId: emp.id,
      employeeName: emp.name,
      date: targetDate,
      checkIn: null,
      checkOut: null,
      checkInLat: null,
      checkInLng: null,
      checkOutLat: null,
      checkOutLng: null,
      status: "absent",
      hoursWorked: null,
    };
  });

  // Sort: employees with check-in first, then absent; alphabetical within each group
  result.sort((a, b) => {
    if (!!a.checkIn !== !!b.checkIn) return a.checkIn ? -1 : 1;
    return a.employeeName.localeCompare(b.employeeName);
  });

  res.json(result);
});

router.post("/hr/attendance/check-in", async (req, res): Promise<void> => {
  const parsed = CheckInBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  // Non-headoffice employees may only check in for themselves
  const scopeEmpCI = (req as any).employee as { id: number; branchType: string } | undefined;
  if (scopeEmpCI && scopeEmpCI.branchType !== 'headoffice' && parsed.data.employeeId !== scopeEmpCI.id) {
    res.status(403).json({ error: "You can only check in for yourself." });
    return;
  }
  const today = new Date().toISOString().split("T")[0];
  const [existing] = await db.select().from(attendanceTable)
    .where(and(eq(attendanceTable.employeeId, parsed.data.employeeId), eq(attendanceTable.date, today)))
    .limit(1);
  let row;
  if (existing) {
    [row] = await db.update(attendanceTable)
      .set({ checkIn: new Date(), checkInLat: String(parsed.data.lat), checkInLng: String(parsed.data.lng) })
      .where(eq(attendanceTable.id, existing.id)).returning();
  } else {
    [row] = await db.insert(attendanceTable).values({
      employeeId: parsed.data.employeeId, date: today,
      checkIn: new Date(), checkInLat: String(parsed.data.lat), checkInLng: String(parsed.data.lng),
      status: "present",
    }).returning();
  }
  const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.id, row.employeeId)).limit(1);
  res.status(201).json({
    ...row, employeeName: emp?.name ?? "",
    checkIn: row.checkIn?.toISOString() ?? null, checkOut: row.checkOut?.toISOString() ?? null,
    checkInLat: row.checkInLat ? Number(row.checkInLat) : null,
    checkInLng: row.checkInLng ? Number(row.checkInLng) : null,
    checkOutLat: null, checkOutLng: null,
  });
});

router.post("/hr/attendance/check-out", async (req, res): Promise<void> => {
  const parsed = CheckOutBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  // Non-headoffice employees may only check out for themselves
  const scopeEmpCO = (req as any).employee as { id: number; branchType: string } | undefined;
  if (scopeEmpCO && scopeEmpCO.branchType !== 'headoffice' && parsed.data.employeeId !== scopeEmpCO.id) {
    res.status(403).json({ error: "You can only check out for yourself." });
    return;
  }
  const today = new Date().toISOString().split("T")[0];
  const [existing] = await db.select().from(attendanceTable)
    .where(and(eq(attendanceTable.employeeId, parsed.data.employeeId), eq(attendanceTable.date, today)))
    .limit(1);
  if (!existing) { res.status(404).json({ error: "No check-in found for today" }); return; }
  const [row] = await db.update(attendanceTable)
    .set({ checkOut: new Date(), checkOutLat: String(parsed.data.lat), checkOutLng: String(parsed.data.lng) })
    .where(eq(attendanceTable.id, existing.id)).returning();
  const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.id, row.employeeId)).limit(1);
  res.json({
    ...row, employeeName: emp?.name ?? "",
    checkIn: row.checkIn?.toISOString() ?? null, checkOut: row.checkOut?.toISOString() ?? null,
    checkInLat: row.checkInLat ? Number(row.checkInLat) : null,
    checkInLng: row.checkInLng ? Number(row.checkInLng) : null,
    checkOutLat: row.checkOutLat ? Number(row.checkOutLat) : null,
    checkOutLng: row.checkOutLng ? Number(row.checkOutLng) : null,
  });
});

// ── Leave ─────────────────────────────────────────────────────────────────
router.get("/hr/leaves", requireModuleView("Leave"), async (req, res): Promise<void> => {
  const qp = ListLeavesQueryParams.safeParse(req.query);
  let rows = await db.select().from(leavesTable).orderBy(leavesTable.id);
  if (qp.success) {
    if (qp.data.employeeId) rows = rows.filter((r) => r.employeeId === Number(qp.data.employeeId));
    if (qp.data.status) rows = rows.filter((r) => r.status === qp.data.status);
  }
  // Non-headoffice employees only see their own leave records
  const scopeEmp = (req as any).employee as { id: number; branchType: string } | undefined;
  if (scopeEmp && scopeEmp.branchType !== 'headoffice') {
    rows = rows.filter((r) => r.employeeId === scopeEmp.id);
  }
  const employees = await db.select().from(employeesTable);
  const eMap = new Map(employees.map((e) => [e.id, e.name]));
  res.json(rows.map((r) => ({ ...r, employeeName: eMap.get(r.employeeId) ?? "", approverName: null })));
});

router.post("/hr/leaves", async (req, res): Promise<void> => {
  const parsed = ApplyLeaveBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  // Security: non-headoffice employees may only apply leave for themselves
  const scopeEmp = (req as any).employee as { id: number; branchType: string } | undefined;
  if (scopeEmp && scopeEmp.branchType !== 'headoffice' && parsed.data.employeeId !== scopeEmp.id) {
    res.status(403).json({ error: "You can only apply leave for yourself." });
    return;
  }

  const [row] = await db.insert(leavesTable).values({ ...parsed.data, status: "pending" }).returning();

  // Sync leave days into attendance table as status = 'leave'
  const startParts = parsed.data.fromDate.split('-').map(Number);
  const cur = new Date(Date.UTC(startParts[0], startParts[1] - 1, startParts[2]));
  const endParts = parsed.data.toDate.split('-').map(Number);
  const endD = new Date(Date.UTC(endParts[0], endParts[1] - 1, endParts[2]));
  while (cur <= endD) {
    const dateStr = cur.toISOString().split('T')[0];
    const [existing] = await db.select().from(attendanceTable)
      .where(and(eq(attendanceTable.employeeId, parsed.data.employeeId), eq(attendanceTable.date, dateStr)))
      .limit(1);
    if (existing) {
      await db.update(attendanceTable).set({ status: 'leave' }).where(eq(attendanceTable.id, existing.id));
    } else {
      await db.insert(attendanceTable).values({ employeeId: parsed.data.employeeId, date: dateStr, status: 'leave' });
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.id, row.employeeId)).limit(1);
  res.status(201).json({ ...row, employeeName: emp?.name ?? "", approverName: null });
});

router.post("/hr/leaves/:id/approve", requireModuleAction("Leave", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const parsed = ApproveLeaveBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [row] = await db.update(leavesTable)
    .set({ status: parsed.data.status, approvalNote: parsed.data.note ?? null })
    .where(eq(leavesTable.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.id, row.employeeId)).limit(1);
  res.json({ ...row, employeeName: emp?.name ?? "", approverName: null });
});

// ── Password Reset (admin action) ─────────────────────────────────────────────
router.post("/hr/employees/:id/reset-password", requireModuleAction("Employees", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.id, id)).limit(1);
  if (!emp) { res.status(404).json({ error: "Employee not found" }); return; }

  const newHash = await PasswordService.hash(DEFAULT_INITIAL_PASSWORD);
  await pool.query(
    `UPDATE employees SET password_hash = $1, must_change_password = true WHERE id = $2`,
    [newHash, id],
  );

  logActivity({
    action: "UPDATE", module: "hr", entityType: "employee", entityId: id,
    description: `PASSWORD_RESET for employee ${emp.name}`,
    user: (req as any).employee?.username ?? "admin",
  }).catch(() => {});

  res.json({ success: true, message: "Password has been reset. The employee must change it on next login." });
});

export default router;
