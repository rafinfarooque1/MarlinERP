import { Router } from "express";
import {
  db, pool, hierarchiesTable, employeesTable, payrollTable, attendanceTable,
  leavesTable, warehousesTable, outletsTable, payComponentsTable,
} from "@workspace/db";
import { PasswordService } from '../lib/password';
import { DEFAULT_INITIAL_PASSWORD } from '../lib/passwordPolicy';
import { eq, and, gte, lte, sql } from "drizzle-orm";
import { logActivity } from "../lib/audit";
import {
  CreateHierarchyBody, UpdateHierarchyBody, DeleteHierarchyParams,
  CreateEmployeeBody, UpdateEmployeeBody, GetEmployeeParams, DeleteEmployeeParams,
  CheckInBody, CheckOutBody, ApplyLeaveBody, ApproveLeaveBody,
  ListPayrollQueryParams, ListAttendanceQueryParams, ListLeavesQueryParams,
} from "@workspace/api-zod";

const router = Router();

// ── Helpers ────────────────────────────────────────────────────────────────

async function getBranchName(branchType: string, branchId: number): Promise<string> {
  if (branchType === "production") return "Production Unit";
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
    employeeName: emp?.name ?? r.employeeName ?? "",
    baseSalary: Number(r.baseSalary),
    lopDeduction: Number(r.lopDeduction ?? 0),
    grossPay: Number(r.grossPay ?? 0),
    allowancesTotal: Number(r.allowancesTotal ?? 0),
    allowancesBreakdown: r.allowancesBreakdown ?? [],
    deductions: Number(r.deductions ?? 0),
    deductionsBreakdown: r.deductionsBreakdown ?? [],
    netPay: Number(r.netPay ?? 0),
    bonus: Number(r.bonus ?? 0),
    totalAmount: Number(r.totalAmount ?? r.netPay ?? 0),
    lopDays: r.lopDays ?? 0,
    workingDays: r.workingDays ?? 26,
    presentDays: r.presentDays ?? 26,
  };
}

// ── Hierarchies ───────────────────────────────────────────────────────────
router.get("/hr/hierarchies", async (_req, res): Promise<void> => {
  const rows = await db.select().from(hierarchiesTable).orderBy(hierarchiesTable.level);
  res.json(rows);
});

router.post("/hr/hierarchies", async (req, res): Promise<void> => {
  const parsed = CreateHierarchyBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [row] = await db.insert(hierarchiesTable).values(parsed.data).returning();
  res.status(201).json(row);
});

router.patch("/hr/hierarchies/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const parsed = UpdateHierarchyBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [row] = await db.update(hierarchiesTable).set(parsed.data).where(eq(hierarchiesTable.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(row);
});

router.delete("/hr/hierarchies/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  await db.delete(hierarchiesTable).where(eq(hierarchiesTable.id, id));
  res.status(204).send();
});

// ── Employees ─────────────────────────────────────────────────────────────
router.get("/hr/employees", async (_req, res): Promise<void> => {
  const rows = await db.select().from(employeesTable).orderBy(employeesTable.id);
  const hierarchies = await db.select().from(hierarchiesTable);
  const hMap = new Map(hierarchies.map((h) => [h.id, h.name]));
  const enriched = await Promise.all(rows.map(async (e) => ({
    id: e.id, name: e.name, username: e.username, email: e.email ?? null, phone: e.phone ?? null,
    hierarchyId: e.hierarchyId, hierarchyName: hMap.get(e.hierarchyId) ?? "",
    branchType: e.branchType, branchId: e.branchId,
    branchName: await getBranchName(e.branchType, e.branchId),
    salary: Number(e.salary), joinDate: e.joinDate, photoUrl: e.photoUrl ?? null, isActive: e.isActive, mustChangePassword: e.mustChangePassword ?? false,
  })));
  res.json(enriched);
});

router.post("/hr/employees", async (req, res): Promise<void> => {
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

router.get("/hr/employees/:id", async (req, res): Promise<void> => {
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

router.patch("/hr/employees/:id", async (req, res): Promise<void> => {
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

router.delete("/hr/employees/:id", async (req, res): Promise<void> => {
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

router.put("/hr/pay-components/:employeeId", async (req, res): Promise<void> => {
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

router.get("/hr/payroll", async (req, res): Promise<void> => {
  const qp = ListPayrollQueryParams.safeParse(req.query);
  let rows = await db.select().from(payrollTable).orderBy(payrollTable.id);
  if (qp.success) {
    if (qp.data.year) rows = rows.filter((r) => r.year === Number(qp.data.year));
    if (qp.data.month) rows = rows.filter((r) => r.month === Number(qp.data.month));
  }
  const employees = await db.select().from(employeesTable);
  const eMap = new Map(employees.map((e) => [e.id, e]));
  const enriched = await Promise.all(rows.map(async (r) => {
    const emp = eMap.get(r.employeeId);
    return {
      ...enrichPayroll(r),
      employeeName: emp?.name ?? "",
      branchName: emp ? await getBranchName(emp.branchType, emp.branchId) : "",
    };
  }));
  res.json(enriched);
});

// Generate payroll for a month — creates or updates records for all employees (or one)
router.post("/hr/payroll/generate", async (req, res): Promise<void> => {
  const { month, year, employeeId, forceRegenerate = false } = req.body;
  if (!month || !year) { res.status(400).json({ error: "month and year are required" }); return; }

  // Fetch employees to generate for
  let employees = await db.select().from(employeesTable).where(eq(employeesTable.isActive, true));
  if (employeeId) employees = employees.filter(e => e.id === Number(employeeId));

  // Date range for the month
  const monthStr = String(month).padStart(2, "0");
  const daysInMonth = new Date(year, month, 0).getDate();
  const startDate = `${year}-${monthStr}-01`;
  const endDate = `${year}-${monthStr}-${String(daysInMonth).padStart(2, "0")}`;

  // Fetch attendance for the whole month
  const monthAttendance = await db.select().from(attendanceTable)
    .where(and(gte(attendanceTable.date, startDate), lte(attendanceTable.date, endDate)));

  const results = [];

  for (const emp of employees) {
    // Check for existing payroll record
    const [existing] = await db.select().from(payrollTable)
      .where(and(eq(payrollTable.employeeId, emp.id), eq(payrollTable.month, month), eq(payrollTable.year, year)))
      .limit(1);

    if (existing && existing.isPaid && !forceRegenerate) {
      // Skip paid records unless forced
      results.push(enrichPayroll(existing, emp));
      continue;
    }

    // Fetch pay components (or use defaults)
    const [pc] = await db.select().from(payComponentsTable).where(eq(payComponentsTable.employeeId, emp.id)).limit(1);
    const workingDays = pc?.workingDaysPerMonth ?? 26;
    const allowances: PayComp[] = (pc?.allowances as PayComp[]) ?? [
      { name: "HRA", type: "percent_of_basic", value: 40, enabled: true },
      { name: "DA", type: "percent_of_basic", value: 10, enabled: true },
      { name: "Travel Allowance", type: "fixed", value: 1000, enabled: true },
    ];
    const deductions: PayComp[] = (pc?.deductions as PayComp[]) ?? [
      { name: "PF (Employee 12%)", type: "percent_of_basic", value: 12, enabled: true },
      { name: "ESI (0.75%)", type: "percent_of_gross", value: 0.75, enabled: true },
    ];

    // Count present days from attendance
    const empAtt = monthAttendance.filter(a => a.employeeId === emp.id);
    const presentDays = empAtt.filter(a => a.status === "present" || !!a.checkIn).length;
    // If no attendance data, assume full attendance
    const effectivePresentDays = empAtt.length === 0 ? workingDays : presentDays;

    const baseSalary = Number(emp.salary);
    const computed = computePayroll({ baseSalary, workingDays, presentDays: effectivePresentDays, allowances, deductions });

    const payrollData = {
      employeeId: emp.id,
      month,
      year,
      baseSalary: String(baseSalary),
      workingDays,
      presentDays: effectivePresentDays,
      lopDays: computed.lopDays,
      lopDeduction: String(computed.lopDeduction),
      grossPay: String(computed.grossPay),
      allowancesTotal: String(computed.allowancesTotal),
      allowancesBreakdown: computed.allowancesBreakdown,
      deductions: String(computed.deductions),
      deductionsBreakdown: computed.deductionsBreakdown,
      netPay: String(computed.netPay),
      totalAmount: String(computed.netPay),
    };

    let row;
    if (existing && !existing.isPaid) {
      [row] = await db.update(payrollTable).set(payrollData).where(eq(payrollTable.id, existing.id)).returning();
    } else if (!existing) {
      [row] = await db.insert(payrollTable).values({ ...payrollData, bonus: "0" }).returning();
    } else {
      row = existing; // paid, skip update
    }

    results.push({
      ...enrichPayroll(row!, emp),
      branchName: await getBranchName(emp.branchType, emp.branchId),
      employeeName: emp.name,
    });
  }

  res.json(results);
});

router.post("/hr/payroll/:id/pay", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const today = new Date().toISOString().split("T")[0];
  const [row] = await db.update(payrollTable).set({ isPaid: true, paidDate: today }).where(eq(payrollTable.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.id, row.employeeId)).limit(1);

  logActivity({
    action: "UPDATE", module: "payroll", entityType: "payroll", entityId: row.id,
    description: `Payroll marked paid for ${emp?.name ?? `Employee #${row.employeeId}`} — ${row.month}/${row.year} — ₹${Number(row.netPay ?? 0).toLocaleString("en-IN")}`,
    metadata: { after: { employeeId: row.employeeId, month: row.month, year: row.year, netPay: Number(row.netPay), paidDate: today } },
  }).catch(() => {});

  res.json({
    ...enrichPayroll(row),
    employeeName: emp?.name ?? "",
    branchName: emp ? await getBranchName(emp.branchType, emp.branchId) : "",
  });
});

// ── Attendance ────────────────────────────────────────────────────────────
router.get("/hr/attendance", async (req, res): Promise<void> => {
  const qp = ListAttendanceQueryParams.safeParse(req.query);
  const targetDate = (qp.success && qp.data.date) ? qp.data.date : new Date().toISOString().split("T")[0];
  const filterEmployeeId = qp.success && qp.data.employeeId ? Number(qp.data.employeeId) : null;

  // All active employees (or just one if filtered)
  let allEmployees = await db.select().from(employeesTable).where(eq(employeesTable.isActive, true));
  if (filterEmployeeId) allEmployees = allEmployees.filter((e) => e.id === filterEmployeeId);

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
        hoursWorked: r.hoursWorked ?? null,
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
router.get("/hr/leaves", async (req, res): Promise<void> => {
  const qp = ListLeavesQueryParams.safeParse(req.query);
  let rows = await db.select().from(leavesTable).orderBy(leavesTable.id);
  if (qp.success) {
    if (qp.data.employeeId) rows = rows.filter((r) => r.employeeId === Number(qp.data.employeeId));
    if (qp.data.status) rows = rows.filter((r) => r.status === qp.data.status);
  }
  const employees = await db.select().from(employeesTable);
  const eMap = new Map(employees.map((e) => [e.id, e.name]));
  res.json(rows.map((r) => ({ ...r, employeeName: eMap.get(r.employeeId) ?? "", approverName: null })));
});

router.post("/hr/leaves", async (req, res): Promise<void> => {
  const parsed = ApplyLeaveBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [row] = await db.insert(leavesTable).values({ ...parsed.data, status: "pending" }).returning();
  const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.id, row.employeeId)).limit(1);
  res.status(201).json({ ...row, employeeName: emp?.name ?? "", approverName: null });
});

router.post("/hr/leaves/:id/approve", async (req, res): Promise<void> => {
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
router.post("/hr/employees/:id/reset-password", async (req, res): Promise<void> => {
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
