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

function computePayroll(opts: {
  baseSalary: number;
  workingDays: number;
  presentDays: number;
  allowances: AllowanceComp[];
  deductions: DeductionComp[];
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

  // Deductions: fixed, percent_of_basic, or percent_of_gross
  const deductionsBreakdown: { name: string; amount: number }[] = [];
  let deductionsTotal = 0;
  for (const d of deductions) {
    if (d.enabled === false) continue;
    let amount: number;
    if (d.type === "fixed") amount = round2(d.value);
    else if (d.type === "percent_of_basic") amount = round2(effectiveBasic * d.value / 100);
    else amount = round2(grossPay * d.value / 100); // percent_of_gross
    deductionsBreakdown.push({ name: d.name, amount });
    deductionsTotal += amount;
  }
  deductionsTotal = round2(deductionsTotal);
  const netPay = round2(grossPay - deductionsTotal);

  return {
    lopDays, lopDeduction, effectiveBasic, grossPay,
    allowancesTotal, allowancesBreakdown,
    deductions: deductionsTotal, deductionsBreakdown, netPay,
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
  const { rows: [created] } = await pool.query(
    `INSERT INTO account_ledgers (name, type, code, section, parent_id, is_group, is_system_group, description)
     VALUES ($1, $2, $3, 'balance_sheet', $4, false, false, $5)
     ON CONFLICT DO NOTHING RETURNING id`,
    [name, type, code, parent?.id ?? null, description],
  );
  if (created) return created.id;
  const { rows: [retry] } = await pool.query(`SELECT id FROM account_ledgers WHERE code = $1 LIMIT 1`, [code]);
  return retry?.id ?? null;
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
              e.is_active AS "isActive", e.must_change_password AS "mustChangePassword"
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
  })));
  res.json(enriched);
});

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

  logActivity({
    action: "CREATE", module: "hr", entityType: "employee", entityId: row.id,
    description: `New employee ${row.name} added (${h?.name ?? "role"}) — salary ₹${Number(row.salary).toLocaleString("en-IN")}`,
    metadata: { after: { id: row.id, name: row.name, salary: Number(row.salary), hierarchyName: h?.name } },
  }).catch(() => {});

  res.status(201).json({
    id: row.id, name: row.name, username: row.username, email: row.email ?? null, phone: row.phone ?? null,
    hierarchyId: row.hierarchyId, hierarchyName: h?.name ?? "",
    branchType: row.branchType, branchId: row.branchId,
    branchName: await getBranchName(row.branchType, row.branchId),
    salary: Number(row.salary), joinDate: row.joinDate, photoUrl: row.photoUrl ?? null,
    isActive: row.isActive, mustChangePassword: row.mustChangePassword ?? true,
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
  });
});

router.patch("/hr/employees/:id", requireModuleAction("Employees", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const [before] = await db.select().from(employeesTable).where(eq(employeesTable.id, id)).limit(1);
  const parsed = UpdateEmployeeBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const updateData: Record<string, unknown> = { ...parsed.data };
  if (parsed.data.salary !== undefined) updateData.salary = String(parsed.data.salary);
  const [row] = await db.update(employeesTable).set(updateData).where(eq(employeesTable.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const [h] = await db.select().from(hierarchiesTable).where(eq(hierarchiesTable.id, row.hierarchyId)).limit(1);

  logActivity({
    action: "UPDATE", module: "hr", entityType: "employee", entityId: row.id,
    description: `Employee ${row.name} updated`,
    metadata: {
      before: before ? { name: before.name, salary: Number(before.salary), isActive: before.isActive } : undefined,
      after: { name: row.name, salary: Number(row.salary), isActive: row.isActive },
      changes: Object.keys(parsed.data),
    },
  }).catch(() => {});

  res.json({
    id: row.id, name: row.name, username: row.username, email: row.email ?? null, phone: row.phone ?? null,
    hierarchyId: row.hierarchyId, hierarchyName: h?.name ?? "",
    branchType: row.branchType, branchId: row.branchId,
    branchName: await getBranchName(row.branchType, row.branchId),
    salary: Number(row.salary), joinDate: row.joinDate, photoUrl: row.photoUrl ?? null, isActive: row.isActive, mustChangePassword: row.mustChangePassword ?? false,
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

    if (existing && existing.is_paid && !forceRegenerate) {
      results.push({ ...enrichPayroll(existing, emp), branchName: await getBranchName(emp.branchType, emp.branchId), employeeName: emp.name });
      continue;
    }

    // Fetch pay components (or use defaults)
    const [pc] = await db.select().from(payComponentsTable).where(eq(payComponentsTable.employeeId, emp.id)).limit(1);
    const workingDays = pc?.workingDaysPerMonth ?? 26;
    const allowances: AllowanceComp[] = (pc?.allowances as AllowanceComp[]) ?? [
      { name: "HRA", type: "percent_of_basic", value: 40, enabled: true },
      { name: "DA", type: "percent_of_basic", value: 10, enabled: true },
      { name: "Travel Allowance", type: "fixed", value: 1000, enabled: true },
    ];
    const deductions: DeductionComp[] = (pc?.deductions as DeductionComp[]) ?? [
      { name: "PF (Employee 12%)", type: "percent_of_basic", value: 12, enabled: true },
      { name: "ESI (0.75%)", type: "percent_of_gross", value: 0.75, enabled: true },
    ];

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

    // Pending advances for this employee
    const { rows: advances } = await pool.query(
      `SELECT id, amount FROM employee_advances WHERE employee_id = $1 AND is_deducted = FALSE`,
      [emp.id],
    );
    const advanceDeduction = round2(advances.reduce((s: number, a: any) => s + Number(a.amount), 0));

    const baseSalary = Number(emp.salary);
    const computed = computePayroll({ baseSalary, workingDays, presentDays: effectivePresentDays, allowances, deductions });
    const netPayAfterAdvance = round2(Math.max(0, computed.netPay - advanceDeduction));

    let row: any;
    if (existing && !existing.is_paid) {
      const { rows: [updated] } = await pool.query(
        `UPDATE payroll SET
           employee_id=$1, month=$2, year=$3, base_salary=$4, working_days=$5, present_days=$6,
           lop_days=$7, lop_deduction=$8, gross_pay=$9, allowances_total=$10, allowances_breakdown=$11,
           deductions=$12, deductions_breakdown=$13, net_pay=$14, total_amount=$14,
           status='draft', advance_deduction=$15
         WHERE id=$16 RETURNING *`,
        [emp.id, month, year, String(baseSalary), workingDays, effectivePresentDays,
         computed.lopDays, String(computed.lopDeduction), String(computed.grossPay),
         String(computed.allowancesTotal), JSON.stringify(computed.allowancesBreakdown),
         String(computed.deductions), JSON.stringify(computed.deductionsBreakdown),
         String(netPayAfterAdvance), String(advanceDeduction), existing.id],
      );
      row = updated;
    } else if (!existing) {
      const { rows: [inserted] } = await pool.query(
        `INSERT INTO payroll
           (employee_id, month, year, base_salary, working_days, present_days,
            lop_days, lop_deduction, gross_pay, allowances_total, allowances_breakdown,
            deductions, deductions_breakdown, net_pay, total_amount, bonus, status, advance_deduction)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,'0','draft',$15)
         RETURNING *`,
        [emp.id, month, year, String(baseSalary), workingDays, effectivePresentDays,
         computed.lopDays, String(computed.lopDeduction), String(computed.grossPay),
         String(computed.allowancesTotal), JSON.stringify(computed.allowancesBreakdown),
         String(computed.deductions), JSON.stringify(computed.deductionsBreakdown),
         String(netPayAfterAdvance), String(advanceDeduction)],
      );
      row = inserted;
    } else {
      row = existing; // paid, skip update
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
  const { rows: [row] } = await pool.query(
    `UPDATE payroll SET extra_amount = $1, extra_note = $2 WHERE id = $3 AND status != 'paid' RETURNING *`,
    [String(Number(extraAmount)), extraNote, id],
  );
  if (!row) { res.status(404).json({ error: "Not found or already paid" }); return; }
  const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.id, row.employee_id)).limit(1);
  res.json({ ...enrichPayroll(row, emp), branchName: emp ? await getBranchName(emp.branchType, emp.branchId) : "" });
});

// Approve payroll → Dr Salary Expense / Cr Salary Payable (per employee)
router.post("/hr/payroll/:id/approve", requireModuleAction("Payroll", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const today = new Date().toISOString().split("T")[0];

  const { rows: [existing] } = await pool.query(`SELECT * FROM payroll WHERE id = $1`, [id]);
  if (!existing) { res.status(404).json({ error: "Not found" }); return; }
  if (existing.status === 'paid') { res.status(400).json({ error: "Already paid" }); return; }

  const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.id, existing.employee_id)).limit(1);
  const monthStr = String(existing.month).padStart(2, "0");

  // Extra amount is added to net pay for accounting purposes
  const extraAmt = Number(existing.extra_amount ?? 0);
  const netPay   = Number(existing.net_pay ?? 0) + extraAmt;

  try {
    // Per-employee expense ledger under Indirect Expenses
    const salExpId = await findOrProvisionLedger(
      `SAL-EMP-${existing.employee_id}`,
      `Salary - ${emp?.name ?? `Employee #${existing.employee_id}`}`,
      'expense', 'SYS-INDEXP',
      `Salary expense for ${emp?.name ?? `Employee #${existing.employee_id}`}`,
    );
    // Per-employee payable ledger under Current Liabilities
    const salPayId = await findOrProvisionLedger(
      `SAL-PAY-${existing.employee_id}`,
      `Salary Payable - ${emp?.name ?? `Employee #${existing.employee_id}`}`,
      'liability', 'SYS-CURL',
      `Salary payable to ${emp?.name ?? `Employee #${existing.employee_id}`}`,
    );

    if (salExpId && salPayId && netPay > 0.004) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const voucherNumber = await nextVoucherNumber(client, "journal", today);
        const narration = `Salary Approved — ${emp?.name ?? `Emp #${existing.employee_id}`} — ${monthStr}/${existing.year}`;
        const { rows: [jv] } = await client.query(
          `INSERT INTO journal_vouchers (voucher_type, voucher_number, voucher_date, narration, total_amount, created_by)
           VALUES ('journal', $1, $2, $3, $4, $5) RETURNING id`,
          [voucherNumber, today, narration, netPay.toFixed(2), req.employee?.username ?? "system"],
        );
        await client.query(
          `INSERT INTO journal_voucher_lines (voucher_id, ledger_id, debit, credit)
           VALUES ($1, $2, $3, 0), ($1, $4, 0, $3)`,
          [jv.id, salExpId, netPay.toFixed(2), salPayId],
        );
        await client.query("COMMIT");
      } catch (e) { await client.query("ROLLBACK").catch(() => {}); console.warn("[payroll/approve] JV error:", e); }
      finally { client.release(); }
    }
  } catch (e) { console.warn("[payroll/approve] Ledger error:", e); }

  const { rows: [updated] } = await pool.query(
    `UPDATE payroll SET status = 'approved', approved_at = NOW() WHERE id = $1 RETURNING *`,
    [id],
  );
  logActivity({ action: "UPDATE", module: "payroll", entityType: "payroll", entityId: id,
    description: `Payroll approved for ${emp?.name ?? `Emp #${existing.employee_id}`} — ${monthStr}/${existing.year}`,
    metadata: { netPay } }).catch(() => {});

  res.json({ ...enrichPayroll(updated, emp), branchName: emp ? await getBranchName(emp.branchType, emp.branchId) : "" });
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

  const extraAmt   = Number(existing.extra_amount ?? 0);
  const totalNet   = round2(Number(existing.net_pay ?? 0) + extraAmt);
  const alreadyPaid = Number(existing.paid_amount ?? 0);
  const payNow     = payAmount > 0 ? round2(payAmount) : round2(totalNet - alreadyPaid);
  const newPaidAmt = round2(alreadyPaid + payNow);
  const isFullyPaid = newPaidAmt >= totalNet - 0.005;
  const newStatus   = isFullyPaid ? 'paid' : 'approved';

  const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.id, existing.employee_id)).limit(1);
  const monthStr = String(existing.month).padStart(2, "0");

  try {
    // Credit the salary payable ledger for this employee; debit cash/bank
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

    if (salPayId && payLedgerId && payNow > 0.004) {
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
        await client.query("COMMIT");
      } catch (e) { await client.query("ROLLBACK").catch(() => {}); console.warn("[payroll/pay] JV error:", e); }
      finally { client.release(); }
    }

    // If approval JV wasn't created yet (status was draft), create it now too
    if (existing.status === 'draft') {
      const salExpId = await findOrProvisionLedger(
        `SAL-EMP-${existing.employee_id}`,
        `Salary - ${emp?.name ?? `Employee #${existing.employee_id}`}`,
        'expense', 'SYS-INDEXP',
        `Salary expense for ${emp?.name ?? `Employee #${existing.employee_id}`}`,
      );
      if (salExpId && salPayId && totalNet > 0.004) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const vn = await nextVoucherNumber(client, "journal", today);
          const nar = `Salary Approved — ${emp?.name ?? `Emp #${existing.employee_id}`} — ${monthStr}/${existing.year}`;
          const { rows: [jv2] } = await client.query(
            `INSERT INTO journal_vouchers (voucher_type, voucher_number, voucher_date, narration, total_amount, created_by)
             VALUES ('journal', $1, $2, $3, $4, $5) RETURNING id`,
            [vn, today, nar, totalNet.toFixed(2), req.employee?.username ?? "system"],
          );
          await client.query(
            `INSERT INTO journal_voucher_lines (voucher_id, ledger_id, debit, credit) VALUES ($1, $2, $3, 0), ($1, $4, 0, $3)`,
            [jv2.id, salExpId, totalNet.toFixed(2), salPayId],
          );
          await client.query("COMMIT");
        } catch (e) { await client.query("ROLLBACK").catch(() => {}); }
        finally { client.release(); }
      }
    }
  } catch (acctErr) { console.warn("[payroll/pay] Accounting error:", acctErr); }

  const { rows: [row] } = await pool.query(
    `UPDATE payroll
     SET paid_amount = $1, payment_mode = $2, is_paid = $3, paid_date = $4, status = $5
     WHERE id = $6 RETURNING *`,
    [String(newPaidAmt), paymentMode, isFullyPaid, isFullyPaid ? today : null, newStatus, id],
  );

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
