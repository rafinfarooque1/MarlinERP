import { Router } from "express";
import { db, hierarchiesTable, employeesTable, payrollTable, attendanceTable, leavesTable, warehousesTable, outletsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import {
  CreateHierarchyBody, UpdateHierarchyBody, DeleteHierarchyParams,
  CreateEmployeeBody, UpdateEmployeeBody, GetEmployeeParams, DeleteEmployeeParams,
  CheckInBody, CheckOutBody, ApplyLeaveBody, ApproveLeaveBody,
  ListPayrollQueryParams, ListAttendanceQueryParams, ListLeavesQueryParams,
} from "@workspace/api-zod";

const router = Router();

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
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const parsed = UpdateHierarchyBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [row] = await db.update(hierarchiesTable).set(parsed.data).where(eq(hierarchiesTable.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(row);
});

router.delete("/hr/hierarchies/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  await db.delete(hierarchiesTable).where(eq(hierarchiesTable.id, id));
  res.status(204).send();
});

// ── Employees ─────────────────────────────────────────────────────────────
router.get("/hr/employees", async (_req, res): Promise<void> => {
  const rows = await db.select().from(employeesTable).orderBy(employeesTable.id);
  const hierarchies = await db.select().from(hierarchiesTable);
  const hMap = new Map(hierarchies.map((h) => [h.id, h.name]));
  const enriched = await Promise.all(rows.map(async (e) => ({
    id: e.id,
    name: e.name,
    username: e.username,
    email: e.email ?? null,
    phone: e.phone ?? null,
    hierarchyId: e.hierarchyId,
    hierarchyName: hMap.get(e.hierarchyId) ?? "",
    branchType: e.branchType,
    branchId: e.branchId,
    branchName: await getBranchName(e.branchType, e.branchId),
    salary: Number(e.salary),
    joinDate: e.joinDate,
    photoUrl: e.photoUrl ?? null,
    isActive: e.isActive,
  })));
  res.json(enriched);
});

router.post("/hr/employees", async (req, res): Promise<void> => {
  const parsed = CreateEmployeeBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [row] = await db.insert(employeesTable).values({
    ...parsed.data,
    salary: String(parsed.data.salary),
    passwordHash: "default123",
  }).returning();
  const [h] = await db.select().from(hierarchiesTable).where(eq(hierarchiesTable.id, row.hierarchyId)).limit(1);
  res.status(201).json({
    ...row,
    hierarchyName: h?.name ?? "",
    branchName: await getBranchName(row.branchType, row.branchId),
    salary: Number(row.salary),
  });
});

router.get("/hr/employees/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const [row] = await db.select().from(employeesTable).where(eq(employeesTable.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const [h] = await db.select().from(hierarchiesTable).where(eq(hierarchiesTable.id, row.hierarchyId)).limit(1);
  res.json({
    id: row.id, name: row.name, username: row.username, email: row.email ?? null, phone: row.phone ?? null,
    hierarchyId: row.hierarchyId, hierarchyName: h?.name ?? "",
    branchType: row.branchType, branchId: row.branchId, branchName: await getBranchName(row.branchType, row.branchId),
    salary: Number(row.salary), joinDate: row.joinDate, photoUrl: row.photoUrl ?? null, isActive: row.isActive,
  });
});

router.patch("/hr/employees/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const parsed = UpdateEmployeeBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const updateData: Record<string, unknown> = { ...parsed.data };
  if (parsed.data.salary !== undefined) updateData.salary = String(parsed.data.salary);
  const [row] = await db.update(employeesTable).set(updateData).where(eq(employeesTable.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const [h] = await db.select().from(hierarchiesTable).where(eq(hierarchiesTable.id, row.hierarchyId)).limit(1);
  res.json({
    id: row.id, name: row.name, username: row.username, email: row.email ?? null, phone: row.phone ?? null,
    hierarchyId: row.hierarchyId, hierarchyName: h?.name ?? "",
    branchType: row.branchType, branchId: row.branchId, branchName: await getBranchName(row.branchType, row.branchId),
    salary: Number(row.salary), joinDate: row.joinDate, photoUrl: row.photoUrl ?? null, isActive: row.isActive,
  });
});

router.delete("/hr/employees/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  await db.delete(employeesTable).where(eq(employeesTable.id, id));
  res.status(204).send();
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
      ...r,
      employeeName: emp?.name ?? "",
      branchName: emp ? await getBranchName(emp.branchType, emp.branchId) : "",
      baseSalary: Number(r.baseSalary),
      deductions: Number(r.deductions),
      bonus: Number(r.bonus),
      totalAmount: Number(r.totalAmount),
    };
  }));
  res.json(enriched);
});

router.post("/hr/payroll/:id/pay", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const today = new Date().toISOString().split("T")[0];
  const [row] = await db.update(payrollTable).set({ isPaid: true, paidDate: today }).where(eq(payrollTable.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.id, row.employeeId)).limit(1);
  res.json({
    ...row,
    employeeName: emp?.name ?? "",
    branchName: emp ? await getBranchName(emp.branchType, emp.branchId) : "",
    baseSalary: Number(row.baseSalary),
    deductions: Number(row.deductions),
    bonus: Number(row.bonus),
    totalAmount: Number(row.totalAmount),
  });
});

// ── Attendance ────────────────────────────────────────────────────────────
router.get("/hr/attendance", async (req, res): Promise<void> => {
  const qp = ListAttendanceQueryParams.safeParse(req.query);
  let rows = await db.select().from(attendanceTable).orderBy(attendanceTable.id);
  if (qp.success) {
    if (qp.data.employeeId) rows = rows.filter((r) => r.employeeId === Number(qp.data.employeeId));
    if (qp.data.date) rows = rows.filter((r) => r.date === qp.data.date);
  }
  const employees = await db.select().from(employeesTable);
  const eMap = new Map(employees.map((e) => [e.id, e.name]));
  res.json(rows.map((r) => ({
    ...r,
    employeeName: eMap.get(r.employeeId) ?? "",
    checkIn: r.checkIn?.toISOString() ?? null,
    checkOut: r.checkOut?.toISOString() ?? null,
    checkInLat: r.checkInLat ? Number(r.checkInLat) : null,
    checkInLng: r.checkInLng ? Number(r.checkInLng) : null,
    checkOutLat: r.checkOutLat ? Number(r.checkOutLat) : null,
    checkOutLng: r.checkOutLng ? Number(r.checkOutLng) : null,
  })));
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
      employeeId: parsed.data.employeeId,
      date: today,
      checkIn: new Date(),
      checkInLat: String(parsed.data.lat),
      checkInLng: String(parsed.data.lng),
      status: "present",
    }).returning();
  }
  const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.id, row.employeeId)).limit(1);
  res.status(201).json({
    ...row, employeeName: emp?.name ?? "",
    checkIn: row.checkIn?.toISOString() ?? null,
    checkOut: row.checkOut?.toISOString() ?? null,
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
    checkIn: row.checkIn?.toISOString() ?? null,
    checkOut: row.checkOut?.toISOString() ?? null,
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
  res.json(rows.map((r) => ({
    ...r,
    employeeName: eMap.get(r.employeeId) ?? "",
    approverName: null,
  })));
});

router.post("/hr/leaves", async (req, res): Promise<void> => {
  const parsed = ApplyLeaveBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [row] = await db.insert(leavesTable).values({ ...parsed.data, status: "pending" }).returning();
  const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.id, row.employeeId)).limit(1);
  res.status(201).json({ ...row, employeeName: emp?.name ?? "", approverName: null });
});

router.post("/hr/leaves/:id/approve", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const parsed = ApproveLeaveBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [row] = await db.update(leavesTable).set({ status: parsed.data.status, approvalNote: parsed.data.note ?? null }).where(eq(leavesTable.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.id, row.employeeId)).limit(1);
  res.json({ ...row, employeeName: emp?.name ?? "", approverName: null });
});

export default router;
