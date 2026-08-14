import { disabledWarehouseError, WAREHOUSE_DISABLED_CODE } from "../lib/warehouseLifecycle";
import { Router, type Response } from "express";
import { requireModuleAction, requireModuleView, hasModuleAction } from "../middleware/permissions";
import { clearLoginFailures } from "../middleware/auth";
import { nextVoucherNumber, financialYearLabel } from "../lib/voucherNumber";
import { isIsoDate } from "../lib/dateInput";
import {
  db, pool, hierarchiesTable, employeesTable, payrollTable, attendanceTable,
  leavesTable, warehousesTable, outletsTable, payComponentsTable,
} from "@workspace/db";
import { PasswordService } from '../lib/password';
import { DEFAULT_INITIAL_PASSWORD, ADMIN_RESET_PASSWORD } from '../lib/passwordPolicy';
import { eq, and, gte, lte, sql } from "drizzle-orm";
import { getLocationFilter } from "../lib/requestLocation";
import { logActivity } from "../lib/audit";
import { getUserDataScope, scopeBranchWhere, isLocationInScope } from "../lib/dataScope";
import { parseDateRange } from "../lib/queryFilters";
import { outletWritesBlocked, OUTLETS_DISABLED_MESSAGE, OUTLETS_DISABLED_CODE } from "../lib/featureFlags";
import { parsePaging, setPagingHeaders, applyPaging } from "../lib/paging";
import { resolveChartParentId } from "../lib/chartGroups";
import { provisionSalaryLedgers } from "../lib/payrollLedgers";
import {
  accruedForMonth, lockSalaryAccrual, recalcUnapprovedSalaryAccruals,
  runSalaryAccrual, dailyAccrualRate, reaccrueForAttendanceChange,
  withEmployeeAccrualLock, DEFAULT_WORKING_DAYS, loadAccrualCutover, type Querier,
} from "../lib/salaryAccrual";
import {
  loadAttendanceThresholds, loadPayrollSettings, monthLeaveSummary,
  loadHolidaySet, calendarDayInfo, PUNCHED_HOURS_JOIN,
} from "../lib/attendanceFactor";
import { ownLocationScope, scopeCashLedgerIds } from "../lib/moneyScope";
import {
  respondIfMonthLocked, isMonthLocked, monthLockedBody, ymOfDate,
} from "../lib/periodLock";
import {
  CreateHierarchyBody, UpdateHierarchyBody, DeleteHierarchyParams,
  CreateEmployeeBody, UpdateEmployeeBody, GetEmployeeParams, DeleteEmployeeParams,
  CheckInBody, CheckOutBody, ApplyLeaveBody, ApproveLeaveBody,
  ListPayrollQueryParams, ListAttendanceQueryParams, ListLeavesQueryParams,
} from "@workspace/api-zod";

const router = Router();

/**
 * Resolves which cash/bank ledger a salary payment or employee advance leaves
 * from. Salary payable and advance ledgers stay payroll-owned (they never
 * appear in manual voucher pickers — paying them anywhere else would let the
 * payroll dues double-pay); only the MONEY side is selectable here.
 *
 * Rules mirror manual payment vouchers: the account must sit in the Cash/Bank
 * tree and be active; Head Office may use any till or bank account, a branch
 * caller only their own till. With no selection, Head Office keeps the
 * standard Cash/Bank default; a branch caller falls back to their own till —
 * NEVER silently to Head Office money — and must pick explicitly if their
 * scope holds more than one till.
 *
 * Also reports which root the account sits under (`tree`, so the recorded
 * payment mode cannot contradict the account) and the owning location when the
 * account is a warehouse/outlet till (so the voucher can be stamped and located
 * reports see the till movement). Head-office money returns a null location:
 * payroll vouchers paid from HO cash stay company-level, as they always were.
 */
type ResolvedPayLedger = {
  id: number;
  tree: "cash" | "bank";
  locationType: "warehouse" | "outlet" | null;
  locationId: number | null;
};

async function resolvePayLedger(
  employee: unknown,
  payLedgerId: unknown,
  fallbackCode: "STD-CASH" | "STD-BANK",
): Promise<ResolvedPayLedger | { error: string }> {
  const scope = ownLocationScope(employee as Parameters<typeof ownLocationScope>[0]);
  let id: number;
  if (payLedgerId === undefined || payLedgerId === null || payLedgerId === "") {
    if (scope.isHeadOffice) {
      const { rows: [std] } = await pool.query(
        `SELECT id FROM account_ledgers WHERE code = $1 LIMIT 1`, [fallbackCode],
      );
      if (!std) return { error: `The standard ${fallbackCode === "STD-BANK" ? "bank" : "cash"} ledger is missing.` };
      id = std.id;
    } else {
      const own = await scopeCashLedgerIds(scope);
      if (own.length !== 1) return { error: "Pick which cash account this is paid from." };
      id = own[0]!;
    }
  } else {
    id = Number(payLedgerId);
    if (!Number.isInteger(id) || id <= 0) return { error: "Invalid payment account." };
  }
  // Same descendant walk the cash/bank picker endpoint uses, so what the UI
  // offers and what the server accepts can never drift apart.
  const { rows } = await pool.query(
    `SELECT id, parent_id, code, is_active FROM account_ledgers`,
  );
  const cashSet = new Set<number>();
  const bankSet = new Set<number>();
  for (const r of rows) {
    if (r.code === "STD-CASH") cashSet.add(r.id);
    if (r.code === "STD-BANK") bankSet.add(r.id);
  }
  for (let i = 0; i < 4; i++) {
    for (const r of rows) {
      if (!r.parent_id) continue;
      if (cashSet.has(r.parent_id)) cashSet.add(r.id);
      if (bankSet.has(r.parent_id)) bankSet.add(r.id);
    }
  }
  const row = rows.find((r: any) => r.id === id);
  const tree: "cash" | "bank" | null = cashSet.has(id) ? "cash" : bankSet.has(id) ? "bank" : null;
  if (!row || !tree || row.is_active === false) {
    return { error: "Pick an active cash or bank account for the payment." };
  }
  if (!scope.isHeadOffice) {
    const own = await scopeCashLedgerIds(scope);
    if (!own.includes(id)) return { error: "You can only pay from your own location's cash." };
  }
  // Owning location for the voucher stamp. Warehouse first: a mirror location
  // (same place existing as warehouse AND outlet, one shared till) must
  // resolve to ONE identity, not whichever row happens to come back.
  const { rows: [locRow] } = await pool.query(
    `SELECT lt, lid FROM (
       SELECT 'warehouse' AS lt, id AS lid, 0 AS ord FROM warehouses WHERE cash_ledger_id = $1
       UNION ALL
       SELECT 'outlet' AS lt, id AS lid, 1 AS ord FROM outlets WHERE cash_ledger_id = $1
     ) x ORDER BY ord LIMIT 1`, [id],
  );
  return {
    id, tree,
    locationType: (locRow?.lt as "warehouse" | "outlet" | undefined) ?? null,
    locationId: locRow ? Number(locRow.lid) : null,
  };
}


// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Re-price an employee's open salary accruals after their attendance moved.
 *
 * Attendance is what a day of salary is now worth, so every path that writes an
 * attendance row has to give the books a chance to follow it. This is a latency
 * optimisation over the hourly sweep, not the only route to correctness — which
 * is exactly why a failure is logged and swallowed rather than surfaced. An
 * accounting hiccup must not stop someone recording that they turned up, and
 * the sweep re-prices the day within the hour regardless.
 */
async function reaccrue(employeeId: number, cause: string): Promise<void> {
  try {
    await reaccrueForAttendanceChange(pool, employeeId);
  } catch (e) {
    console.error(`[hr] salary re-accrual after ${cause} failed for employee ${employeeId}:`, e);
  }
}

/**
 * Serialise an attendance write against the salary machinery, and refuse it if
 * the month it lands in has been signed off.
 *
 * Approval takes the per-employee accrual lock and re-reads attendance inside it
 * to check the payroll it is about to post still matches. That check is only
 * worth anything if attendance writers take the same lock. Without it a
 * correction can commit in the window between approval's read and its commit;
 * the correction's own re-accrual then queues behind the approval, finds the
 * month approved, and skips it. The correction is silently lost — after telling
 * the user their salary had been recalculated.
 *
 * Holding the lock across the check and the write forces one order or the other:
 * either approval goes first and this write is refused with a reason, or this
 * write goes first and approval refuses itself as stale.
 *
 * `dates` are all the days the write touches; every one of their months is
 * checked, so a leave range spanning a closed month is refused as a whole rather
 * than applied in part.
 */
async function withAttendanceWrite<T>(
  employeeId: number,
  dates: string[],
  write: (q: Querier) => Promise<T>,
): Promise<T> {
  return withEmployeeAccrualLock(pool, employeeId, async (q) => {
    const months = new Map<string, [number, number]>();
    for (const d of dates) {
      const [y, m] = d.split("-").map(Number);
      months.set(`${y}-${m}`, [y, m]);
    }
    for (const [y, m] of months.values()) {
      const { rows: [locked] } = await q.query(
        `SELECT status FROM payroll
          WHERE employee_id = $1 AND year = $2 AND month = $3
            AND status IN ('approved','paid') LIMIT 1`,
        [employeeId, y, m],
      );
      if (locked) {
        throw Object.assign(new Error(
          `Payroll for ${String(m).padStart(2, "0")}/${y} is already ${locked.status}. `
          + `Attendance for a signed-off month cannot be changed — post a journal adjustment instead.`,
        ), { conflict: true });
      }
    }
    return write(q);
  });
}

/** Shape a raw `attendance` row as the API returns it (camelCase, no leaked columns). */
function attendanceRowToApi(r: any) {
  return {
    id: r.id,
    employeeId: r.employee_id,
    date: r.date,
    status: r.status,
    checkIn: r.check_in,
    checkOut: r.check_out,
    checkInLat: r.check_in_lat,
    checkInLng: r.check_in_lng,
    checkOutLat: r.check_out_lat,
    checkOutLng: r.check_out_lng,
  };
}

/** Shape a raw `attendance_punches` row for the API. */
function punchToApi(p: any) {
  return {
    id: p.id,
    punchIn: p.punch_in ? new Date(p.punch_in).toISOString() : null,
    punchOut: p.punch_out ? new Date(p.punch_out).toISOString() : null,
    inLat: p.in_lat != null ? Number(p.in_lat) : null,
    inLng: p.in_lng != null ? Number(p.in_lng) : null,
    outLat: p.out_lat != null ? Number(p.out_lat) : null,
    outLng: p.out_lng != null ? Number(p.out_lng) : null,
  };
}

/** YYYY-MM-DD from a pg date value (comes back as a JS Date, not a string). */
function pgDateStr(d: any): string {
  return typeof d === "string" ? d.slice(0, 10) : new Date(d).toISOString().split("T")[0];
}

/**
 * Register display settings, from the same general_settings JSON that holds
 * the pay thresholds. These shape what the register SHOWS (late, overtime) —
 * they deliberately play no part in what a day is WORTH (see attendanceFactor).
 */
interface AttendanceWorkSettings {
  dayStartTime: string;      // "HH:MM" — expected start of the working day
  lateGraceMinutes: number;  // arriving within this many minutes is not late
  standardWorkHours: number; // hours beyond this count as overtime
  timeZone: string;          // IANA zone the day start is expressed in
}

async function loadAttendanceWorkSettings(): Promise<AttendanceWorkSettings> {
  const { rows: [row] } = await pool.query(`SELECT general_settings FROM company_settings LIMIT 1`);
  const gs = (row?.general_settings as Record<string, any>) ?? {};
  return {
    dayStartTime: /^\d{2}:\d{2}$/.test(String(gs.dayStartTime ?? "")) ? String(gs.dayStartTime) : "09:00",
    lateGraceMinutes: Number.isFinite(Number(gs.lateGraceMinutes)) ? Number(gs.lateGraceMinutes) : 10,
    standardWorkHours: Number(gs.standardWorkHours ?? gs.fullDayHours ?? 9),
    timeZone: String(gs.timeZone ?? "Asia/Kolkata"),
  };
}

/**
 * Today's date in the company's operational timezone. A check-in at 00:30 IST
 * is a session of THAT local day; the UTC calendar (which is still on the
 * previous date until 05:30 IST) must never decide which day a punch — and
 * therefore a day's pay — lands on.
 */
async function businessTodayStr(): Promise<string> {
  const ws = await loadAttendanceWorkSettings();
  return new Date().toLocaleDateString("en-CA", { timeZone: ws.timeZone });
}

/** Minutes past local midnight of a timestamp, in the given IANA zone. */
function minutesInZone(ts: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(ts);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return (h % 24) * 60 + m;
}

/**
 * The derived register fields for one attendance row + its punches.
 *
 * workingHours: total closed-punch hours when punches exist; otherwise the
 * first-in→last-out span — the same preference dayFactor applies, so the
 * register never shows hours that disagree with what the day is being paid on.
 */
function derivePunchFields(
  att: { checkIn: string | null; checkOut: string | null },
  punches: any[],
  ws: AttendanceWorkSettings,
) {
  const api = punches.map(punchToApi);
  const closed = api.filter((p) => p.punchIn && p.punchOut);
  const open = api.find((p) => p.punchIn && !p.punchOut) ?? null;

  let workingHours: number | null = null;
  if (closed.length > 0) {
    workingHours = round2(closed.reduce(
      (s, p) => s + (new Date(p.punchOut!).getTime() - new Date(p.punchIn!).getTime()) / 3_600_000, 0));
  } else if (att.checkIn && att.checkOut) {
    workingHours = round2((new Date(att.checkOut).getTime() - new Date(att.checkIn).getTime()) / 3_600_000);
  }

  const firstInIso = api.length > 0 ? api[0].punchIn : att.checkIn;
  let lateMinutes: number | null = null;
  if (firstInIso) {
    const [sh, sm] = ws.dayStartTime.split(":").map(Number);
    const diff = minutesInZone(new Date(firstInIso), ws.timeZone) - (sh * 60 + sm) - ws.lateGraceMinutes;
    lateMinutes = diff > 0 ? diff : 0;
  }

  const overtimeHours = workingHours != null && !open
    ? Math.max(0, round2(workingHours - ws.standardWorkHours)) : null;

  return {
    punches: api,
    workingHours,
    lateMinutes,
    overtimeHours,
    openPunchIn: open?.punchIn ?? null,
  };
}

/** All punches for a date window, keyed `${employeeId}|${YYYY-MM-DD}`, in punch order. */
async function loadPunchMap(
  q: Querier, from: string, to: string, employeeId?: number,
): Promise<Map<string, any[]>> {
  const params: unknown[] = [from, to];
  let cond = "";
  if (employeeId) { params.push(employeeId); cond = " AND employee_id = $3"; }
  const { rows } = await q.query(
    `SELECT * FROM attendance_punches
      WHERE date >= $1 AND date <= $2${cond}
      ORDER BY punch_in ASC`,
    params,
  );
  const map = new Map<string, any[]>();
  for (const p of rows) {
    const key = `${p.employee_id}|${pgDateStr(p.date)}`;
    const list = map.get(key) ?? [];
    list.push(p);
    map.set(key, list);
  }
  return map;
}

/** Map a `{ conflict: true }` refusal to 409; anything else is a real failure. */
function sendAttendanceWriteError(res: Response, e: any, context: string): void {
  if (e?.conflict) { res.status(409).json({ error: e.message }); return; }
  console.error(`[hr] ${context} failed:`, e);
  res.status(500).json({ error: e?.message ?? "Attendance could not be saved" });
}

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
    // The raw row carries employee_id only; every client reads employeeId, so a
    // missing alias makes lookups keyed on it silently miss instead of failing.
    employeeId:   Number(emp?.id ?? r.employeeId ?? r.employee_id ?? 0),
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
    // Leave-policy snapshot (Aug 2026): null on rows generated before the LOP
    // change — the UI and payslip must OMIT the leave line then, never show 0.
    paidLeaveUsed:     r.paidLeaveUsed    ?? r.paid_leave_used    ?? null,
    paidLeaveAllowed:  r.paidLeaveAllowed ?? r.paid_leave_allowed ?? null,
    // Sick-leave snapshot: null on runs generated before the sick policy —
    // omit, never zero, exactly like the casual pair above.
    sickLeaveUsed:     r.sickLeaveUsed    ?? r.sick_leave_used    ?? null,
    sickLeaveAllowed:  r.sickLeaveAllowed ?? r.sick_leave_allowed ?? null,
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
  // Per-employee ledgers file inside their own sub-group ("Salary Payable",
  // "Salary Expense", "Employee Advances") rather than as loose siblings of
  // every other current liability — the container is created on demand.
  const parentId = await resolveChartParentId(pool, parentCode);
  // Section follows the ledger type. This used to be hard-coded to
  // 'balance_sheet', which stamped every per-employee salary ledger as a
  // balance-sheet account even though it is an expense.
  const section = (type === "expense" || type === "income") ? "profit_loss" : "balance_sheet";
  const { rows: [created] } = await pool.query(
    `INSERT INTO account_ledgers (name, type, code, section, parent_id, is_group, is_system_group, description)
     VALUES ($1, $2, $3, $4, $5, false, false, $6)
     ON CONFLICT DO NOTHING RETURNING id`,
    [name, type, code, section, parentId, description],
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
 *
 * Approval does not recognise the month's salary — daily accrual already did,
 * day by day, as it was earned. What this posts is the **true-up**: the
 * difference between the figure payroll finally computed and what has already
 * been accrued, plus the statutory legs only a payroll run knows.
 */
async function postSalaryApproval(opts: {
  payroll: any;
  empLabel: string;
  voucherDate: string;
  periodLabel: string;
  createdBy: string;
}): Promise<{ updated: any; netPay: number; salaryCost: number; voucherNumber: string | null; accrued: number }> {
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

  const { expenseLedgerId: salExpId, payableLedgerId: salPayId } =
    await provisionSalaryLedgers(pool, employeeId, empLabel);
  if (!salExpId || !salPayId) throw new Error("Could not provision the employee's salary ledgers");

  // Statutory legs are recognised for the first time here: only a payroll run
  // knows PF, ESI, other withholdings and the advance it recovered, so daily
  // accrual never touches them and they are posted in full.
  const fixedDebits: Array<[number, number]> = [];
  const fixedCredits: Array<[number, number]> = [];
  if (pfEmployer  > 0.004) fixedDebits.push([await requireLedgerId('STD-PF-EMPR'),  pfEmployer]);
  if (esiEmployer > 0.004) fixedDebits.push([await requireLedgerId('STD-ESI-EMPR'), esiEmployer]);

  const pfPayable  = round2(pfEmployee + pfEmployer);
  const esiPayable = round2(esiEmployee + esiEmployer);
  if (pfPayable       > 0.004) fixedCredits.push([await requireLedgerId('STD-PF-PAY'),  pfPayable]);
  if (esiPayable      > 0.004) fixedCredits.push([await requireLedgerId('STD-ESI-PAY'), esiPayable]);
  if (otherDeductions > 0.004) fixedCredits.push([await requireLedgerId('STD-EMP-DED'), otherDeductions]);
  // NO advance leg (owner decision, Aug 2026): the advance already sits as a
  // DEBIT on this employee's Salary Payable ledger (it was disbursed as
  // Dr Salary Payable / Cr till, or moved there by the one-time migration).
  // Approval credits Salary Payable with the FULL net (before the advance
  // offset) and the existing debit nets it down to the cash actually owed.

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Re-read under a row lock so two concurrent approvals cannot both post.
    const { rows: [locked] } = await client.query(
      `SELECT status FROM payroll WHERE id = $1 FOR UPDATE`, [pr.id],
    );
    if (!locked) throw new Error("Payroll record disappeared");
    if (locked.status === 'approved' || locked.status === 'paid') {
      throw Object.assign(
        new Error("This payroll was already approved by someone else"), { conflict: true });
    }

    // Month lock: approval posts the true-up voucher into the payroll month, so
    // it may not run once that accounting period is locked. Re-checked inside
    // the transaction — a check on the pool could go stale before the voucher.
    if (await isMonthLocked(client as unknown as Querier, Number(pr.year), Number(pr.month))) {
      await client.query("ROLLBACK");
      throw Object.assign(new Error("Month locked"), {
        monthLocked: monthLockedBody(Number(pr.year), Number(pr.month)),
      });
    }

    // Serialise against the accrual sweep for this employee, then read what the
    // month has already recognised. Both must happen inside this transaction:
    // reading the accrued figure on the pool would let a sweep insert one more
    // day between the read and the voucher, and that day would then be charged
    // twice. Once this commits the month is 'approved', which is also what stops
    // the sweep adding any further day to it.
    await lockSalaryAccrual(client as unknown as Querier, employeeId);

    // Refuse a payroll row that attendance has moved on from.
    //
    // Generation reads attendance and freezes gross/net onto the payroll row;
    // approval posts the difference between that frozen figure and what the
    // month has actually accrued. Attendance can be corrected in between, and
    // the accrual re-prices itself immediately while the payroll row does not —
    // so approving a stale draft would true up to a number the attendance no
    // longer supports and quietly post the gap as salary cost. Recomputed here,
    // inside the lock, because the check is only worth anything if no sweep can
    // run between the check and the voucher.
    const { thresholds: liveThresholds, policy: livePolicy } = await loadPayrollSettings(pool);
    const wd = livePolicy.workingDays;
    const mStr = String(pr.month).padStart(2, "0");
    const lastDay = new Date(Number(pr.year), Number(pr.month), 0).getDate();
    const { rows: attRows } = await client.query(
      `SELECT a.date, a.check_in AS "checkIn", a.check_out AS "checkOut", a.status,
              a.leave_type AS "leaveType",
              ap.punched_hours AS "punchedHours"
         FROM attendance a
         ${PUNCHED_HOURS_JOIN("a")}
        WHERE a.employee_id = $1 AND a.date >= $2 AND a.date <= $3`,
      [employeeId, `${pr.year}-${mStr}-01`, `${pr.year}-${mStr}-${String(lastDay).padStart(2, "0")}`],
    );
    // Mirror generation EXACTLY — same last-working-day clamp, same employed-
    // days cap, same untracked-month rule — or every approval of an affected
    // month would 409 forever against the draft generation itself wrote.
    const monthFirst = `${pr.year}-${mStr}-01`;
    const monthLast = `${pr.year}-${mStr}-${String(lastDay).padStart(2, "0")}`;
    const { rows: [empEmployment] } = await client.query(
      `SELECT to_char(last_working_date, 'YYYY-MM-DD') AS lwd FROM employees WHERE id = $1`,
      [employeeId],
    );
    const liveLwd: string | null = empEmployment?.lwd ?? null;
    const liveAtt = liveLwd
      ? attRows.filter((a: any) => attDateStr(a.date) <= liveLwd)
      : attRows;
    const liveCutover = await loadAccrualCutover(pool);
    const liveCalendar = {
      year: Number(pr.year), month: Number(pr.month),
      holidays: await loadHolidaySet(pool, monthFirst, monthLast),
      untrackedIsAbsent: monthFirst >= liveCutover,
    };
    // Recomputed with the live company leave policy. Comparing payable days
    // alone is not enough: an allowance or working-days change can leave the
    // payable count untouched (no leave taken) while the per-day rate or the
    // stored leave snapshot is now wrong — so every policy-bearing stored
    // figure is checked, and any drift forces a regenerate.
    const liveSummary = monthLeaveSummary(liveAtt, livePolicy, liveThresholds, liveCalendar);
    let livePresentDays = liveSummary.payableDays;
    const liveDaysCap = employedDaysCap(liveLwd, monthFirst, monthLast);
    if (liveDaysCap != null) livePresentDays = Math.min(livePresentDays, liveDaysCap);
    const storedPresentDays = Number(pr.present_days ?? wd);
    const attendanceMoved = Math.abs(livePresentDays - storedPresentDays) > 0.005;
    const drift = (stored: unknown, live: number) =>
      stored == null || Math.abs(Number(stored) - live) > 0.005;
    const policyMoved =
      drift(pr.working_days, wd) ||
      drift(pr.lop_days, liveSummary.lopDays) ||
      drift(pr.paid_leave_used, liveSummary.paidLeaveUsed) ||
      drift(pr.paid_leave_allowed, livePolicy.paidCasualLeavesPerMonth) ||
      drift(pr.sick_leave_used, liveSummary.paidSickLeaveUsed) ||
      drift(pr.sick_leave_allowed, livePolicy.paidSickLeavesPerMonth);
    if (attendanceMoved || policyMoved) {
      throw Object.assign(new Error(
        (attendanceMoved
          ? `Attendance for ${mStr}/${pr.year} changed after this payroll was generated ` +
            `(${storedPresentDays} paid day(s) on the payroll, ${livePresentDays} in attendance now). `
          : `The company payroll policy (working days / paid leave / LOP) changed after this payroll was generated. `) +
        `Regenerate the payroll so it matches, then approve it.`,
      ), { conflict: true });
    }

    const accrued = await accruedForMonth(
      client as unknown as Querier, employeeId, Number(pr.year), Number(pr.month),
    );

    // The true-up. Daily accrual has already booked `accrued` as Dr Salary
    // Expense / Cr Salary Payable across the month, so approval posts only the
    // difference up to the figure payroll computed.
    //
    // Either leg can go negative — heavy loss of pay, or a month accrued in full
    // and then approved for less, leaves the accrual overstated — and the true-up
    // then reverses the excess (Cr Salary Expense / Dr Salary Payable). The
    // identity that makes this voucher balance survives subtracting the same
    // figure from one debit and one credit, so it balances in either direction.
    const debits: Array<[number, number]> = [...fixedDebits];
    const credits: Array<[number, number]> = [...fixedCredits];
    const place = (
      natural: Array<[number, number]>,
      opposite: Array<[number, number]>,
      ledgerId: number,
      signed: number,
    ) => {
      if (signed > 0.004) natural.push([ledgerId, signed]);
      else if (signed < -0.004) opposite.push([ledgerId, round2(-signed)]);
    };
    place(debits, credits, salExpId, round2(salaryCost - accrued));
    // Salary Payable is credited with the full net INCLUDING the advance
    // recovered — the advance's debit is already sitting on this same ledger,
    // so the remaining balance after this voucher is exactly the cash to pay.
    place(credits, debits, salPayId, round2(netPay + advanceRec - accrued));

    const debitTotal  = round2(debits.reduce((s, [, amt]) => s + amt, 0));
    const creditTotal = round2(credits.reduce((s, [, amt]) => s + amt, 0));
    if (Math.abs(creditTotal - debitTotal) > 0.02) {
      throw new Error(
        `Salary entry does not balance (debit ${debitTotal.toFixed(2)} vs credit ${creditTotal.toFixed(2)}) — payroll figures are inconsistent`
      );
    }

    // A month accrued to exactly what payroll computed, with no statutory legs,
    // has nothing left to post. Approval still locks the month; writing an
    // empty voucher for it would only put a phantom in the register.
    let voucherNumber: string | null = null;
    if (debits.length > 0 || credits.length > 0) {
      voucherNumber = await nextVoucherNumber(client, "journal", voucherDate);
      const narration = accrued > 0.004
        ? `Salary Approved (true-up on ₹${accrued.toFixed(2)} accrued daily) — ${empLabel} — ${periodLabel}`
        : `Salary Approved — ${empLabel} — ${periodLabel}`;
      const { rows: [jv] } = await client.query(
        `INSERT INTO journal_vouchers (voucher_type, voucher_number, voucher_date, narration, total_amount, created_by,
                                      origin, source_module)
         VALUES ('journal', $1, $2, $3, $4, $5, 'system', 'payroll') RETURNING id`,
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
    }

    // Close the advances this run recovered. They were claimed at generation
    // time, and approval requires every claim to STILL be attached to this run
    // and unsettled — if one was released or settled some other way since the
    // draft was written, the draft's deduction figure is stale, and posting it
    // would settle an advance twice. Refuse and ask for a regenerate instead.
    const claimedIds: number[] = Array.isArray(pr.advance_ids) ? pr.advance_ids.map(Number) : [];
    if (claimedIds.length) {
      // A claimed LEGACY advance (old ADV-EMP flow, no payment voucher) only
      // nets correctly on Salary Payable if ITS OWN balance was confirmed
      // moved there — the boot migration stamps `migrated_voucher_id` on every
      // pending legacy row it reconciled against the transferred ledger
      // balance. A global "migration ran" marker is NOT proof for this row:
      // the old create path could leave a pending row with no ledger debit at
      // all (swallowed voucher failure), and settling such a row would credit
      // Salary Payable against money the books never received. Per-row
      // evidence or refusal — nothing in between.
      const { rows: unconfirmedLegacy } = await client.query(
        `SELECT id FROM employee_advances
          WHERE id = ANY($1::int[]) AND payment_voucher_id IS NULL AND migrated_voucher_id IS NULL`,
        [claimedIds],
      );
      if (unconfirmedLegacy.length) {
        throw new Error(
          `Advance #${unconfirmedLegacy.map((r: any) => r.id).join(", #")} predates the Salary Payable migration and has no confirmed transferred balance. ` +
          `Approving would settle money the books never received. Restart the server so the boot migration can reconcile it (it logs any mismatch), resolve the advance row, then regenerate this payroll.`,
        );
      }
      const closed = await client.query(
        `UPDATE employee_advances SET is_deducted = TRUE, deducted_payroll_id = $1
          WHERE id = ANY($2::int[]) AND is_deducted = FALSE AND deducted_payroll_id = $1`,
        [pr.id, claimedIds],
      );
      if (closed.rowCount !== claimedIds.length) {
        throw new Error(
          `The advances attached to this payroll changed after the draft was generated (one may have been recovered in cash). Regenerate payroll for this month, check the figures, then approve.`,
        );
      }
    }

    const { rows: [updated] } = await client.query(
      `UPDATE payroll SET status = 'approved', approved_at = NOW() WHERE id = $1 RETURNING *`,
      [pr.id],
    );

    await client.query("COMMIT");
    return { updated, netPay, salaryCost, voucherNumber, accrued };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ── Hierarchies ───────────────────────────────────────────────────────────
// Serves the Hierarchy, Employees and Permissions pages.
// Deliberately UNGUARDED, like GET /company/permissions. usePermission() and the
// app shell read the hierarchy list on every page to work out what the signed-in
// user is allowed to see — guarding it makes permission resolution itself require
// a permission, and every page 403s for everyone below top level.
router.get("/hr/hierarchies", async (req, res): Promise<void> => {
  const paging = parsePaging(req.query as Record<string, unknown>);
  const all = await db.select().from(hierarchiesTable).orderBy(hierarchiesTable.level);
  // Per-role headcount drives the Delete button's disabled state. It is only
  // added for callers who may delete roles: this endpoint is deliberately
  // unguarded (see above), and company-wide headcount per role is not something
  // every signed-in user should read off the app shell. Everyone else gets the
  // same shape as before — the key is omitted, never zeroed.
  const caller = (req as any).employee as { hierarchyId?: number } | undefined;
  let out: Array<Record<string, unknown>> = all;
  if (await hasModuleAction(caller?.hierarchyId, "page:/hr/hierarchy", "delete")) {
    const { rows } = await pool.query(
      `SELECT hierarchy_id, COUNT(*)::int AS n FROM employees GROUP BY hierarchy_id`,
    );
    const counts = new Map<number, number>(rows.map((r: any) => [Number(r.hierarchy_id), Number(r.n)]));
    out = all.map((h) => ({ ...h, employeeCount: counts.get(h.id) ?? 0 }));
  }
  setPagingHeaders(res, out.length, paging);
  res.json(applyPaging(out, paging));
});

// Roles form a reporting chain: every role names the role it reports to, and
// exactly one root (the top-level administrative role) reports to nobody.
// `level` is DERIVED from the chain — root = 1, child = parent + 1 — and is
// never client-writable. It survives in the table because the permission
// middleware grants level-1 roles full access as a hardcoded override, which
// is also why every guard below protects the root so carefully: reparenting
// into or out of the root position would mint or revoke a super-admin role.

/** Case-insensitive duplicate-name check; `excludeId` skips the row being edited. */
async function duplicateRoleName(name: string, excludeId?: number): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT id FROM hierarchies WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) ${excludeId ? "AND id <> $2" : ""} LIMIT 1`,
    excludeId ? [name, excludeId] : [name],
  );
  return rows.length > 0;
}

/** True when `ancestorId` appears anywhere on the chain from `startId` upward (inclusive). */
async function reportingChainContains(
  startId: number,
  ancestorId: number,
  q: { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> } = pool,
): Promise<boolean> {
  const { rows } = await q.query(
    `WITH RECURSIVE up AS (
       SELECT id, reports_to_id, 0 AS depth FROM hierarchies WHERE id = $1
       UNION ALL
       SELECT h.id, h.reports_to_id, up.depth + 1
         FROM hierarchies h JOIN up ON h.id = up.reports_to_id
        WHERE up.depth < 100
     )
     SELECT 1 FROM up WHERE id = $2 LIMIT 1`,
    [startId, ancestorId],
  );
  return rows.length > 0;
}

router.post("/hr/hierarchies", requireModuleAction("page:/hr/hierarchy", "add"), async (req, res): Promise<void> => {
  const parsed = CreateHierarchyBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const name = parsed.data.name.trim();
  if (!name) { res.status(400).json({ error: "Role name is required" }); return; }

  // Every new role must report to an existing one, so a second root — which
  // the middleware would treat as a second super-admin role — cannot be
  // created through this route regardless of who asks.
  const [parent] = await db.select().from(hierarchiesTable).where(eq(hierarchiesTable.id, parsed.data.reportsToId));
  if (!parent) { res.status(400).json({ error: "The role this one reports to does not exist" }); return; }

  if (await duplicateRoleName(name)) {
    res.status(409).json({ error: `A role named "${name}" already exists` }); return;
  }
  const [row] = await db.insert(hierarchiesTable).values({
    name,
    description: parsed.data.description,
    reportsToId: parent.id,
    level: parent.level + 1,
  }).returning();
  res.status(201).json(row);
});

router.patch("/hr/hierarchies/:id", requireModuleAction("page:/hr/hierarchy", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid role id" }); return; }
  const parsed = UpdateHierarchyBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  if (parsed.data.name !== undefined && parsed.data.name.trim() === "") {
    res.status(400).json({ error: "Role name is required" }); return;
  }

  const [existing] = await db.select().from(hierarchiesTable).where(eq(hierarchiesTable.id, id));
  if (!existing) { res.status(404).json({ error: "Not found" }); return; }

  const reparenting = parsed.data.reportsToId !== undefined && parsed.data.reportsToId !== existing.reportsToId;
  let newParent: typeof existing | undefined;
  if (reparenting) {
    // The root reports to nobody — moving it under another role would strip
    // the administrative override from everyone assigned to it.
    if (existing.level === 1) {
      res.status(403).json({ error: "This is the top-level administrative role. It cannot report to another role; its name and description can be changed." });
      return;
    }
    const parentId = parsed.data.reportsToId!;
    if (parentId === id) { res.status(400).json({ error: "A role cannot report to itself" }); return; }
    [newParent] = await db.select().from(hierarchiesTable).where(eq(hierarchiesTable.id, parentId));
    if (!newParent) { res.status(400).json({ error: "The role this one reports to does not exist" }); return; }
    // No cycles: the new manager must not itself (transitively) report to the
    // role being edited.
    if (await reportingChainContains(parentId, id)) {
      res.status(409).json({ error: `"${newParent.name}" is below "${existing.name}" in the reporting chain — that would create a loop` });
      return;
    }
  }

  if (parsed.data.name !== undefined && await duplicateRoleName(parsed.data.name, id)) {
    res.status(409).json({ error: `A role named "${parsed.data.name.trim()}" already exists` }); return;
  }

  // In-place UPDATE of the same row: employees.hierarchy_id and the permission
  // rows both key off this id, so assignments and RBAC follow automatically.
  // A reparent re-derives the level of this role AND everything below it in
  // the same transaction, so the chain and the levels can never disagree.
  const updates: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) updates.name = parsed.data.name.trim();
  if (parsed.data.description !== undefined) updates.description = parsed.data.description;
  if (reparenting) updates.reportsToId = newParent!.id;

  const client = await pool.connect();
  let row: typeof existing;
  try {
    await client.query("BEGIN");
    if (reparenting) {
      // One structure edit at a time. The cycle check above ran outside this
      // transaction (a fast, friendly refusal) — but two concurrent reparents
      // (A→B and B→A) could each pass that check and commit a loop the
      // level-1 override would then walk forever. The advisory lock
      // serialises structure edits, and the check is REPEATED here against
      // the now-stable tree before anything is written.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('hierarchies_structure'))`);
      const { rows: freshParent } = await client.query(
        `SELECT id, name, level FROM hierarchies WHERE id = $1`, [newParent!.id],
      );
      if (!freshParent.length) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "The role this one reports to does not exist" });
        return;
      }
      if (await reportingChainContains(newParent!.id, id, client)) {
        await client.query("ROLLBACK");
        res.status(409).json({ error: `"${freshParent[0].name}" is below "${existing.name}" in the reporting chain — that would create a loop` });
        return;
      }
      updates.level = freshParent[0].level + 1;
    }
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [col, key] of [["name", "name"], ["description", "description"], ["reports_to_id", "reportsToId"], ["level", "level"]] as const) {
      if (key in updates) { params.push(updates[key]); sets.push(`${col} = $${params.length}`); }
    }
    if (sets.length === 0) { await client.query("ROLLBACK"); res.json(existing); return; }
    const { rows: [updated] } = await client.query(
      `UPDATE hierarchies SET ${sets.join(", ")} WHERE id = $1
       RETURNING id, name, level, reports_to_id AS "reportsToId", description, created_at AS "createdAt"`,
      params,
    );
    if (reparenting) {
      // Depth-bounded as defense in depth — the lock + check above keep the
      // tree acyclic, so the bound only matters for hand-edited data.
      await client.query(
        `WITH RECURSIVE sub AS (
           SELECT id, level, 0 AS depth FROM hierarchies WHERE id = $1
           UNION ALL
           SELECT h.id, sub.level + 1, sub.depth + 1
             FROM hierarchies h JOIN sub ON h.reports_to_id = sub.id
            WHERE sub.depth < 100
         )
         UPDATE hierarchies h SET level = sub.level FROM sub WHERE h.id = sub.id AND h.level <> sub.level`,
        [id],
      );
    }
    await client.query("COMMIT");
    row = updated;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  const fields: Array<"name" | "description" | "reportsToId"> = ["name", "description", "reportsToId"];
  const changedFields = fields.filter(f => f in updates && (updates as any)[f] !== (existing as any)[f]);
  logActivity({
    action: "UPDATE", module: "hr", entityType: "hierarchy", entityId: id,
    description: `Role "${existing.name}" updated${changedFields.length ? ` (${changedFields.join(", ")})` : ""}`,
    user: (req as any).employee?.username ?? undefined,
    metadata: {
      changedFields,
      before: { name: existing.name, reportsToId: existing.reportsToId, description: existing.description },
      after: { name: row.name, reportsToId: row.reportsToId, description: row.description },
    },
  }).catch(() => {});

  res.json(row);
});

router.delete("/hr/hierarchies/:id", requireModuleAction("page:/hr/hierarchy", "delete"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid role id" }); return; }

  // Structure edit → same advisory lock the reparent path takes, so tree
  // changes (add-under, reparent) cannot interleave with the child check.
  // Employee ASSIGNMENT does not take this lock — there the safety net is the
  // employees.hierarchy_id FK: an assignment committing between the count
  // below and the DELETE makes the delete fail 23503, which the catch maps
  // back to the same "employees assigned" refusal. Either way no orphan.
  let deleted: { name: string; reportsToId: number | null; description: string | null } | null = null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('hierarchies_structure'))`);

    const { rows: [existing] } = await client.query(
      `SELECT id, name, level, reports_to_id AS "reportsToId", description
         FROM hierarchies WHERE id = $1 FOR UPDATE`, [id],
    );
    if (!existing) { await client.query("ROLLBACK"); res.status(404).json({ error: "Not found" }); return; }
    // Deleting the level-1 role would revoke the administrative override for
    // everyone assigned to it — same RBAC exception the create/edit guards
    // protect, closed off here too.
    if (Number(existing.level) === 1) {
      await client.query("ROLLBACK");
      res.status(403).json({ error: "The top-level administrative role cannot be deleted." });
      return;
    }
    const { rows: [child] } = await client.query(
      `SELECT name FROM hierarchies WHERE reports_to_id = $1 LIMIT 1`, [id],
    );
    if (child) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: `This hierarchy contains child hierarchies (e.g. "${child.name}"). Delete or move the child hierarchies first.` });
      return;
    }
    const { rows: [emp] } = await client.query(
      `SELECT COUNT(*)::int AS n FROM employees WHERE hierarchy_id = $1`, [id],
    );
    if (Number(emp?.n ?? 0) > 0) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "This hierarchy cannot be deleted because one or more employees are assigned to it. Please transfer or remove all employees from this hierarchy before deleting." });
      return;
    }

    // The role's permission rows are owned by the role — permissions.hierarchy_id
    // carries a NO ACTION FK, so without this cleanup the delete below fails on
    // every role that has ever been seeded a permission row (i.e. all of them).
    await client.query(`DELETE FROM permissions WHERE hierarchy_id = $1`, [id]);
    await client.query(`DELETE FROM hierarchies WHERE id = $1`, [id]);
    await client.query("COMMIT");
    deleted = existing;
  } catch (e: any) {
    await client.query("ROLLBACK").catch(() => {});
    // Any FK the pre-checks raced with (or a referencing table added later)
    // refuses politely instead of surfacing as a 500 — the row survives, so
    // nothing can orphan. Name the blocker when Postgres tells us which it is.
    if (e?.code === "23503") {
      res.status(409).json({
        error: e?.table === "employees"
          ? "This hierarchy cannot be deleted because one or more employees are assigned to it. Please transfer or remove all employees from this hierarchy before deleting."
          : e?.table === "hierarchies"
            ? "This hierarchy contains child hierarchies. Delete or move the child hierarchies first."
            : "This hierarchy cannot be deleted because other records still reference it.",
      });
      return;
    }
    throw e;
  } finally {
    client.release();
  }
  if (!deleted) { res.status(500).json({ error: "Delete did not complete" }); return; }

  logActivity({
    action: "DELETE", module: "hr", entityType: "hierarchy", entityId: id,
    description: `Role "${deleted.name}" deleted`,
    user: (req as any).employee?.username ?? undefined,
    metadata: { before: { id, name: deleted.name, reportsToId: deleted.reportsToId, description: deleted.description } },
  }).catch(() => {});
  res.status(204).send();
});

// ── Employees ─────────────────────────────────────────────────────────────
router.get("/hr/employees", requireModuleView("page:/hr/employees"), async (req, res): Promise<void> => {
  const scopeEmp = (req as any).employee as { branchType: string; branchId: number } | undefined;

  const scopeParams: unknown[] = [];
  let scopeCond = 'TRUE';
  if (scopeEmp && scopeEmp.branchType !== 'headoffice') {
    const scope = await getUserDataScope(scopeEmp);
    scopeCond = scopeBranchWhere(scope, scopeParams, 'e');
  }

  const paging = parsePaging(req.query as Record<string, unknown>);
  const [{ rows }, hierarchies] = await Promise.all([
    pool.query(
      `SELECT e.id, e.name, e.username, e.email, e.phone,
              e.hierarchy_id AS "hierarchyId", e.branch_type AS "branchType", e.branch_id AS "branchId",
              e.salary, e.join_date AS "joinDate", e.photo_url AS "photoUrl",
              e.is_active AS "isActive", e.must_change_password AS "mustChangePassword",
              e.is_production_staff AS "isProductionStaff",
              e.employment_status AS "employmentStatus",
              to_char(e.last_working_date, 'YYYY-MM-DD') AS "lastWorkingDate"
       FROM employees e WHERE ${scopeCond} ORDER BY e.id`,
      scopeParams,
    ),
    db.select().from(hierarchiesTable),
  ]);

  const total = (rows as any[]).length;
  const page = applyPaging(rows as any[], paging);
  setPagingHeaders(res, total, paging);
  const hMap = new Map(hierarchies.map((h) => [h.id, h.name]));
  const enriched = await Promise.all(page.map(async (e) => ({
    id: e.id, name: e.name, username: e.username, email: e.email ?? null, phone: e.phone ?? null,
    hierarchyId: e.hierarchyId, hierarchyName: hMap.get(e.hierarchyId) ?? "",
    branchType: e.branchType, branchId: e.branchId,
    branchName: await getBranchName(e.branchType, e.branchId),
    salary: Number(e.salary), joinDate: e.joinDate, photoUrl: e.photoUrl ?? null, isActive: e.isActive, mustChangePassword: e.mustChangePassword ?? false,
    isProductionStaff: e.isProductionStaff ?? false,
    employmentStatus: e.employmentStatus ?? "active",
    lastWorkingDate: e.lastWorkingDate ?? null,
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

/** Every status other than 'active' means "no longer on the payroll" and
 *  implies is_active = FALSE. 'inactive' is the legacy plain deactivation;
 *  'resigned' and 'terminated' record WHY someone left. */
const EMPLOYMENT_STATUSES = ["active", "resigned", "terminated", "inactive"];

/** Employment status + last working date are raw-migration columns (invisible
 *  to drizzle), read and written with explicit SQL like the production-staff
 *  flag. The date comes back as text so no timezone can shift it. */
async function readEmploymentFields(id: number): Promise<{ status: string; lastWorkingDate: string | null }> {
  const { rows } = await pool.query(
    `SELECT employment_status AS s, to_char(last_working_date, 'YYYY-MM-DD') AS lwd
       FROM employees WHERE id = $1`,
    [id],
  );
  return { status: rows[0]?.s ?? "active", lastWorkingDate: rows[0]?.lwd ?? null };
}

/** Same conversion `dayStr` in the attendance-factor module uses, so a pg DATE
 *  compares against a YYYY-MM-DD string identically everywhere. */
const attDateStr = (d: unknown): string =>
  d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);

/** How many days of a month employment covered, or null for the whole month.
 *  Shared by payroll generation and approval — they must cap identically or
 *  every approval of a leaver's month would 409 against generation's own draft. */
function employedDaysCap(lwd: string | null, monthFirst: string, monthLast: string): number | null {
  if (!lwd || lwd >= monthLast) return null;
  return lwd < monthFirst ? 0 : Number(lwd.slice(8, 10));
}

/** Tear down a stale draft payroll, releasing its advance claims so a later
 *  month can recover them. Serializes with approval by taking the SAME payroll
 *  row lock approval takes, and re-checking the status while holding it —
 *  releasing the advances first and only then discovering (via a 0-row DELETE)
 *  that approval won the race would still commit the release and strand the
 *  approval's advance deduction. Returns true if the draft was removed. */
async function teardownDraftPayroll(payrollId: number): Promise<boolean> {
  const zc = await pool.connect();
  try {
    await zc.query("BEGIN");
    const { rows: [locked] } = await zc.query(
      `SELECT status FROM payroll WHERE id = $1 FOR UPDATE`, [payrollId],
    );
    if (!locked || locked.status !== "draft") {
      await zc.query("ROLLBACK");
      return false;
    }
    await zc.query(
      `UPDATE employee_advances SET deducted_payroll_id = NULL
        WHERE deducted_payroll_id = $1 AND is_deducted = FALSE`,
      [payrollId],
    );
    await zc.query(`DELETE FROM payroll WHERE id = $1`, [payrollId]);
    await zc.query("COMMIT");
    return true;
  } catch (e) {
    await zc.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    zc.release();
  }
}

router.post("/hr/employees", requireModuleAction("page:/hr/employees", "add"), async (req, res): Promise<void> => {
  const parsed = CreateEmployeeBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  // Posting new staff to an outlet is new outlet activity. People already
  // assigned to one keep their posting, so historical payroll and attendance
  // still resolve to a real location.
  if ((parsed.data as any).branchType === 'outlet' && await outletWritesBlocked(pool)) {
    res.status(409).json({ error: OUTLETS_DISABLED_MESSAGE, code: OUTLETS_DISABLED_CODE }); return;
  }
  // Login lookup is case-insensitive (and a unique index on LOWER(username)
  // enforces it at the DB level), so a case-variant duplicate must be a clean
  // 400 here — not a raw constraint error at insert time.
  const newUsername = parsed.data.username.trim();
  if (!newUsername) { res.status(400).json({ error: 'Username is required' }); return; }
  const { rows: [dupe] } = await pool.query(
    `SELECT id FROM employees WHERE LOWER(TRIM(username)) = LOWER($1) LIMIT 1`, [newUsername],
  );
  if (dupe) {
    res.status(400).json({ error: 'Username is already taken (usernames are case-insensitive)' });
    return;
  }
  const [row] = await db.insert(employeesTable).values({
    ...parsed.data,
    username: newUsername,
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
    employmentStatus: "active", lastWorkingDate: null,
  });
});

router.get("/hr/employees/:id", requireModuleView("page:/hr/employees"), async (req, res): Promise<void> => {
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
    ...(await readEmploymentFields(id).then((f) => ({
      employmentStatus: f.status, lastWorkingDate: f.lastWorkingDate,
    }))),
  });
});

router.patch("/hr/employees/:id", requireModuleAction("page:/hr/employees", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const [before] = await db.select().from(employeesTable).where(eq(employeesTable.id, id)).limit(1);
  const parsed = UpdateEmployeeBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  // Only a *move* to an outlet is blocked. Someone already stationed at one can
  // still have their phone number or salary corrected, otherwise turning the
  // module off would freeze those staff records outright.
  //
  // The comparison is on the EFFECTIVE destination, not on what the payload
  // happens to mention: a PATCH carrying only `branchId` would otherwise walk an
  // employee from one outlet to another without ever naming a branchType.
  const nextBranchType = (parsed.data as any).branchType ?? (before as any)?.branchType;
  const nextBranchId   = (parsed.data as any).branchId   ?? (before as any)?.branchId;
  const stayingPut = (before as any)?.branchType === 'outlet'
    && Number((before as any)?.branchId) === Number(nextBranchId);
  const movingToOutlet = nextBranchType === 'outlet' && !stayingPut;
  if (movingToOutlet && await outletWritesBlocked(pool)) {
    res.status(409).json({ error: OUTLETS_DISABLED_MESSAGE, code: OUTLETS_DISABLED_CODE }); return;
  }

  // Employment status and last working date travel outside the validated body
  // (zod strips unknown keys) and live in raw-migration columns invisible to
  // drizzle — the production-staff pattern. The status is the richer truth and
  // is_active is DERIVED from it, so the two can never disagree; a legacy
  // isActive-only toggle is mapped back onto a status rather than written alone.
  const prevEmployment = await readEmploymentFields(id);
  const rawStatus = (req.body as any)?.employmentStatus;
  if (rawStatus !== undefined && !EMPLOYMENT_STATUSES.includes(String(rawStatus))) {
    res.status(400).json({ error: `employmentStatus must be one of: ${EMPLOYMENT_STATUSES.join(", ")}` });
    return;
  }
  const rawLwd = (req.body as any)?.lastWorkingDate;
  if (rawLwd !== undefined && rawLwd !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(rawLwd))) {
    res.status(400).json({ error: "lastWorkingDate must be a YYYY-MM-DD date" });
    return;
  }
  let nextStatus: string | undefined = rawStatus !== undefined ? String(rawStatus) : undefined;
  if (nextStatus === undefined && (parsed.data as any).isActive !== undefined) {
    // Legacy toggle: reactivation restores 'active'; deactivation records
    // 'inactive' unless a richer status (resigned/terminated) is already stored.
    nextStatus = (parsed.data as any).isActive
      ? "active"
      : (prevEmployment.status !== "active" ? prevEmployment.status : "inactive");
  }
  const effStatus = nextStatus ?? prevEmployment.status;
  // An active employee has no leaving day; a non-active one always has one —
  // it is the boundary salary accrues up to, so it defaults to today rather
  // than being left blank (guard the effective value, not just the body).
  const effLwd = effStatus === "active"
    ? null
    : ((rawLwd !== undefined ? (rawLwd as string | null) : prevEmployment.lastWorkingDate)
        ?? new Date().toISOString().slice(0, 10));
  if (nextStatus !== undefined) (parsed.data as any).isActive = nextStatus === "active";
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

  const employmentChanged = effStatus !== prevEmployment.status
    || (effLwd ?? null) !== (prevEmployment.lastWorkingDate ?? null);
  if (employmentChanged) {
    await pool.query(
      `UPDATE employees SET employment_status = $1, last_working_date = $2 WHERE id = $3`,
      [effStatus, effLwd, id],
    );
    logActivity({
      action: "UPDATE", module: "hr", entityType: "employee", entityId: id,
      user: (req as any).employee?.username ?? "system",
      description: effStatus === "active"
        ? `Employee ${row.name} reactivated`
        : `Employee ${row.name} marked ${effStatus} — last working day ${effLwd}`,
      metadata: {
        employeeId: id, employeeName: row.name,
        previousStatus: prevEmployment.status, newStatus: effStatus,
        previousLastWorkingDate: prevEmployment.lastWorkingDate, newLastWorkingDate: effLwd,
      },
    }).catch(() => {});
  }
  if (employmentChanged && effStatus !== "active") {
    // Leaving (or a corrected leaving day) re-bounds the books immediately:
    // open days after the last working date are torn down and the rest
    // re-priced, inside the employee's accrual lock. Idempotent — the hourly
    // sweep now covers ex-employees with a recorded date and would catch up
    // anyway, so a failure here is loud but not fatal.
    try {
      await recalcUnapprovedSalaryAccruals(pool, id);
    } catch (e) {
      console.error("[hr] accrual cleanup after employment change failed:", e);
    }
  }

  const prevSalary = before ? Number(before.salary) : 0;
  const newSalary = Number(row.salary);
  const salaryChanged = parsed.data.salary !== undefined && Math.abs(newSalary - prevSalary) > 0.004;
  const reactivated = Boolean(before) && before!.isActive === false && row.isActive === true;

  // Bringing someone back must not backfill the months they spent deactivated as
  // though they had been employed throughout — accrual resumes from today.
  if (reactivated) {
    await pool.query(
      `UPDATE employees SET salary_accrual_resume_from = CURRENT_DATE WHERE id = $1`, [id],
    ).catch((e) => console.error("[hr] could not stamp the accrual resume date:", e));
  }

  if (salaryChanged) {
    // A revision rewrites every unapproved month's daily accrual at the new
    // salary: an open month is recalculated in full rather than running at two
    // rates. Approved and paid months are financially final and are left alone.
    //
    // The reason travels outside the validated body because zod strips unknown
    // keys, so it is read from the raw request.
    const reason = typeof (req.body as any)?.revisionReason === "string"
      ? String((req.body as any).revisionReason).trim().slice(0, 500)
      : "";
    try {
      const recalc = await recalcUnapprovedSalaryAccruals(pool, id);
      const now = new Date();
      const basis = recalc.monthsRecalculated[0]
        ?? { year: now.getFullYear(), month: now.getMonth() + 1 };
      // The daily rate is per working-days basis now, not per calendar month, so
      // the audit entry has to quote the same basis the engine priced with —
      // the company-wide policy since the Aug 2026 LOP change.
      const revWorkingDays = (await loadPayrollSettings(pool)).policy.workingDays;
      const asLabel = (m: { year: number; month: number }) => `${String(m.month).padStart(2, "0")}/${m.year}`;
      const months = recalc.monthsRecalculated.map(asLabel);

      logActivity({
        action: "UPDATE", module: "payroll", entityType: "salary_accrual", entityId: id,
        user: req.employee?.username ?? "system",
        description:
          `Salary revised for ${row.name} — ₹${prevSalary.toLocaleString("en-IN")} → ₹${newSalary.toLocaleString("en-IN")}; `
          + `${recalc.entriesReversed} daily accrual entr${recalc.entriesReversed === 1 ? "y" : "ies"} reversed, `
          + `${recalc.entriesRegenerated} regenerated`
          + (months.length ? ` for ${months.join(", ")}` : " (nothing accrued yet)")
          + (reason ? ` — reason: ${reason}` : ""),
        metadata: {
          employeeId: id, employeeName: row.name,
          previousAmount: prevSalary, newAmount: newSalary,
          previousDailyAccrual: dailyAccrualRate(prevSalary, revWorkingDays),
          newDailyAccrual: dailyAccrualRate(newSalary, revWorkingDays),
          dailyRateBasisMonth: asLabel(basis),
          dailyRateWorkingDays: revWorkingDays,
          reason: reason || null,
          monthsRecalculated: months,
          entriesReversed: recalc.entriesReversed,
          entriesRegenerated: recalc.entriesRegenerated,
          previousAccruedTotal: recalc.previousTotal,
          newAccruedTotal: recalc.newTotal,
          revisedBy: req.employee?.username ?? "system",
          revisedAt: now.toISOString(),
        },
      }).catch(() => {});
    } catch (e) {
      // The salary itself is saved. Accrual is an idempotent catch-up, so a
      // failure here self-heals on the next hourly pass — but it must be loud,
      // because until then the open month is still accruing at the old rate.
      console.error("[hr] salary accrual recalculation failed:", e);
    }
  } else if (reactivated) {
    try { await runSalaryAccrual(pool, { employeeId: id }); }
    catch (e) { console.error("[hr] salary accrual after reactivation failed:", e); }
  }

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
    employmentStatus: effStatus, lastWorkingDate: effLwd,
  });
});

router.delete("/hr/employees/:id", requireModuleAction("page:/hr/employees", "delete"), async (req, res): Promise<void> => {
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

router.get("/hr/pay-components/:employeeId", requireModuleView("page:/hr/employees"), async (req, res): Promise<void> => {
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

router.put("/hr/pay-components/:employeeId", requireModuleAction(["page:/hr/employees", "page:/hr/payroll"], "edit"), async (req, res): Promise<void> => {
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

router.get("/hr/payroll", requireModuleView("page:/hr/payroll"), async (req, res): Promise<void> => {
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

  // Global location context — HR rows follow the EMPLOYEE's branch. The
  // employee master itself stays global; only transactional lists narrow.
  const viewLoc = getLocationFilter(req);
  if (viewLoc) {
    whereParts.push(`e.branch_type = ${p(viewLoc.locationType)}`);
    if (viewLoc.locationType !== 'headoffice') whereParts.push(`e.branch_id = ${p(viewLoc.locationId)}`);
  }

  const paging = parsePaging(req.query as Record<string, unknown>);
  const { rows } = await pool.query(
    `SELECT pr.*, e.name AS employee_name, e.branch_type, e.branch_id
     FROM payroll pr
     JOIN employees e ON e.id = pr.employee_id
     WHERE ${whereParts.join(' AND ')}
     ORDER BY pr.id`,
    params,
  );

  const total = rows.length;
  const page = applyPaging(rows, paging);
  setPagingHeaders(res, total, paging);
  const enriched = await Promise.all(page.map(async (r: any) => ({
    ...enrichPayroll(r),
    employeeName: r.employee_name ?? "",
    branchName: await getBranchName(r.branch_type, r.branch_id),
  })));
  res.json(enriched);
});

// Generate payroll for a month — creates or updates records for all employees (or one)
router.post("/hr/payroll/generate", requireModuleAction("page:/hr/payroll", "add"), async (req, res): Promise<void> => {
  const { month, year, employeeId, forceRegenerate = false } = req.body;
  if (!month || !year) { res.status(400).json({ error: "month and year are required" }); return; }

  // Month lock: payroll is a dated financial record for (year, month). A locked
  // accounting period may not have a run generated into it.
  if (await isMonthLocked(pool, Number(year), Number(month))) {
    res.status(423).json(monthLockedBody(Number(year), Number(month))); return;
  }

  // The same thresholds and company-wide leave policy the daily accrual engine
  // prices a day at, loaded from one place. Payroll and the books must not be
  // able to disagree about what a given day of attendance was worth.
  const { thresholds, policy } = await loadPayrollSettings(pool);

  // Rates in force right now. Snapshotted onto every row this run writes, so
  // changing them later only affects runs generated after the change.
  const rates = await loadStatutoryRates();

  // Fetch employees to generate for. Ex-employees whose last working day falls
  // inside or after this month still get a run for the days they served —
  // leaving stops FUTURE pay, not pay already earned. The employment columns
  // are raw-migration columns (invisible to drizzle), read separately and merged.
  const { rows: employmentRows } = await pool.query(
    `SELECT id, employment_status AS status, to_char(last_working_date, 'YYYY-MM-DD') AS lwd
       FROM employees`,
  );
  const employmentById = new Map<number, { status: string; lwd: string | null }>(
    employmentRows.map((r: any) => [Number(r.id), { status: String(r.status ?? "active"), lwd: r.lwd ?? null }]),
  );
  let employees = await db.select().from(employeesTable);
  if (employeeId) employees = employees.filter(e => e.id === Number(employeeId));

  // Date range for the month
  const monthStr = String(month).padStart(2, "0");
  const daysInMonth = new Date(year, month, 0).getDate();
  const startDate = `${year}-${monthStr}-01`;
  const endDate = `${year}-${monthStr}-${String(daysInMonth).padStart(2, "0")}`;

  employees = employees.filter((e) => {
    if (e.isActive) return true;
    const lwd = employmentById.get(e.id)?.lwd ?? null;
    // A legacy deactivation records no leaving day, so there is nothing to
    // bound a partial month by — those employees stay excluded as before.
    return lwd != null && lwd >= startDate;
  });

  // Attendance-era months (on or after the accrual cutover) pay only recorded
  // attendance: a month with no rows at all earns nothing — never assume
  // presence. Months before the cutover keep the legacy full-pay convention;
  // they were never expected to have rows and their history must stand.
  const attendanceFrom = await loadAccrualCutover(pool);
  const untrackedIsAbsent = startDate >= attendanceFrom;

  // Fetch attendance for the whole month (raw SQL to get checkIn/checkOut
  // timestamps, plus total punched hours — multi-punch days are priced on the
  // total, not the first-in→last-out span).
  const { rows: monthAttendance } = await pool.query(
    `SELECT a.employee_id AS "employeeId", a.date, a.check_in AS "checkIn", a.check_out AS "checkOut", a.status,
            a.leave_type AS "leaveType",
            ap.punched_hours AS "punchedHours"
     FROM attendance a
     ${PUNCHED_HOURS_JOIN("a")}
     WHERE a.date >= $1 AND a.date <= $2`,
    [startDate, endDate],
  );

  // Company calendar for the month: holidays and weekly offs pay rowless days
  // in tracked months, so the summary needs to see them.
  const monthCalendar = {
    year: Number(year), month: Number(month),
    holidays: await loadHolidaySet(pool, startDate, endDate),
    untrackedIsAbsent,
  };

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
    // Working days are COMPANY-WIDE policy (Company → Settings → Payroll), not
    // per employee — the owner's rule since the Aug 2026 LOP change. The old
    // per-employee `pay_components.working_days_per_month` is deliberately no
    // longer read.
    const workingDays = policy.workingDays;
    const allowances: AllowanceComp[] = (pc?.allowances as AllowanceComp[]) ?? [];
    const deductions = stripStatutoryDuplicates((pc?.deductions as DeductionComp[]) ?? [], rates);

    // Month summary from the one shared rule: worked days + casual leave, with
    // leave paid up to the company allowance and loss of pay beyond it. The
    // daily accrual engine walks the very same policy across the month, which
    // is what makes the month-end true-up a rounding difference rather than a
    // real correction.
    // Attendance past the last working day earns nothing even if rows exist —
    // the day a record was corrected is not the day it was worked — and the
    // payable total is capped at the days the month actually contained
    // employment, so a pre-cutover (untracked, full-pay) month cannot pay past
    // the exit either.
    const lwd = employmentById.get(emp.id)?.lwd ?? null;
    const empAtt = monthAttendance.filter((a: any) =>
      Number(a.employeeId) === emp.id && (!lwd || attDateStr(a.date) <= lwd));
    const leaveSummary = monthLeaveSummary(empAtt, policy, thresholds, monthCalendar);
    let effectivePresentDays = leaveSummary.payableDays;
    const daysCap = employedDaysCap(lwd, startDate, endDate);
    if (daysCap != null) effectivePresentDays = Math.min(effectivePresentDays, daysCap);

    // No employment or no attendance means no pay — and no payroll row either.
    // A zero-payable month generates nothing, and a stale draft from before
    // the rule (or before the leaving was recorded) is torn down with its
    // advance claims released, so a later month can still recover them.
    // Approved and paid rows never reach here (skipped above).
    if (effectivePresentDays <= 0.004) {
      if (existing) await teardownDraftPayroll(existing.id);
      continue;
    }

    // Advances awaiting recovery. A draft run *claims* the advances it nets off
    // (deducted_payroll_id) without marking them recovered; approval completes
    // the recovery. Without the claim, two open drafts would each deduct the
    // same advance, and re-running generate for a later month would recover an
    // advance that an earlier month had already taken back.
    //
    // Release → select → payroll write → claim runs as ONE transaction with the
    // advance rows locked (FOR UPDATE): the cash-recovery endpoint locks the
    // same rows before settling, so an advance can never be both deducted here
    // and recovered in cash — whichever commits first, the other sees it. The
    // rowCount assert on the claim is belt-and-braces for that guarantee.
    const advClient = await pool.connect();
    let row: any;
    let claimedIds: number[] = [];
    let advanceDeduction = 0;
    try {
      await advClient.query("BEGIN");
      if (existing) {
        await advClient.query(
          `UPDATE employee_advances SET deducted_payroll_id = NULL
            WHERE deducted_payroll_id = $1 AND is_deducted = FALSE`,
          [existing.id],
        );
      }
      const { rows: advances } = await advClient.query(
        `SELECT id, amount FROM employee_advances
          WHERE employee_id = $1 AND is_deducted = FALSE AND deducted_payroll_id IS NULL
          ORDER BY date ASC, id ASC
          FOR UPDATE`,
        [emp.id],
      );

    const baseSalary = Number(emp.salary);
    const computed = computePayroll({ baseSalary, workingDays, presentDays: effectivePresentDays, allowances, deductions, rates });

    // Recovery can never push take-home pay below zero, and an advance is only
    // ever recovered whole — a part-recovered advance would leave the credit
    // posted to the advance ledger out of step with the advances actually
    // closed. Take advances in date order while they still fit in net pay;
    // anything that does not fit stays outstanding for a later run.
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
      // Leave-policy snapshot for the payslip: how much paid casual and sick
      // leave this run actually credited, and what each allowance was at
      // generation time.
      leaveSummary.paidLeaveUsed, policy.paidCasualLeavesPerMonth,
      leaveSummary.paidSickLeaveUsed, policy.paidSickLeavesPerMonth,
    ];

    if (existing) {
      const { rows: [updated] } = await advClient.query(
        `UPDATE payroll SET
           employee_id=$1, month=$2, year=$3, base_salary=$4, working_days=$5, present_days=$6,
           lop_days=$7, lop_deduction=$8, gross_pay=$9, allowances_total=$10, allowances_breakdown=$11,
           deductions=$12, deductions_breakdown=$13, net_pay=$14, total_amount=$14,
           status='draft', advance_deduction=$15,
           pf_employee=$16, pf_employer=$17, esi_employee=$18, esi_employer=$19,
           statutory_snapshot=$20, advance_ids=$21, pay_period_label=$22,
           paid_leave_used=$23, paid_leave_allowed=$24,
           sick_leave_used=$25, sick_leave_allowed=$26
         WHERE id=$27 RETURNING *`,
        [...writeCols, existing.id],
      );
      row = updated;
    } else {
      const { rows: [inserted] } = await advClient.query(
        `INSERT INTO payroll
           (employee_id, month, year, base_salary, working_days, present_days,
            lop_days, lop_deduction, gross_pay, allowances_total, allowances_breakdown,
            deductions, deductions_breakdown, net_pay, total_amount, advance_deduction,
            pf_employee, pf_employer, esi_employee, esi_employer,
            statutory_snapshot, advance_ids, pay_period_label, paid_leave_used,
            paid_leave_allowed, sick_leave_used, sick_leave_allowed, bonus, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$15,
                 $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,'0','draft')
         RETURNING *`,
        writeCols,
      );
      row = inserted;
    }

    if (row && claimedIds.length) {
      const claim = await advClient.query(
        `UPDATE employee_advances SET deducted_payroll_id = $1
          WHERE id = ANY($2::int[]) AND is_deducted = FALSE AND deducted_payroll_id IS NULL`,
        [row.id, claimedIds],
      );
      if (claim.rowCount !== claimedIds.length) {
        // Should be impossible with the rows locked above; refuse rather than
        // write a draft whose deduction disagrees with the claims.
        throw new Error(`Advance claim conflict for ${emp.name} — an advance changed while payroll was being generated. Run generate again.`);
      }
    }
      await advClient.query("COMMIT");
    } catch (e) {
      await advClient.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      advClient.release();
    }

    results.push({
      ...enrichPayroll(row, emp),
      branchName: await getBranchName(emp.branchType, emp.branchId),
      employeeName: emp.name,
    });
  }

  // Drafts for people who had already left before the month began are stale
  // documents that the loop above never visits (those employees are excluded
  // from the run). Tear them down, releasing their advance claims, rather than
  // leaving ghost rows that show a full month's pay for someone who had left.
  // Approved and paid rows are financially final and untouched, and legacy
  // deactivations without a leaving date keep their old drafts as before.
  if (!employeeId) {
    const { rows: staleDrafts } = await pool.query(
      `SELECT p.id FROM payroll p
         JOIN employees e ON e.id = p.employee_id
        WHERE p.month = $1 AND p.year = $2 AND p.status = 'draft'
          AND e.is_active = FALSE
          AND e.last_working_date IS NOT NULL
          AND to_char(e.last_working_date, 'YYYY-MM-DD') < $3`,
      [month, year, startDate],
    );
    for (const d of staleDrafts) {
      await teardownDraftPayroll(d.id);
    }
  }

  res.json(results);
});

// Edit extra amount / note (for authorised managers before approval)
router.patch("/hr/payroll/:id", requireModuleAction("page:/hr/payroll", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const { extraAmount = 0, extraNote = null } = req.body;

  // Month lock: editing a payroll row is a change to that (year, month) record,
  // so refuse if its accounting period is locked. Checked before the write.
  const { rows: [ym] } = await pool.query(`SELECT year, month FROM payroll WHERE id = $1`, [id]);
  if (ym && await isMonthLocked(pool, Number(ym.year), Number(ym.month))) {
    res.status(423).json(monthLockedBody(Number(ym.year), Number(ym.month))); return;
  }

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

// ── Salary accrual register ────────────────────────────────────────────────
//
// What daily accrual has recognised, by employee and month. The mirror of
// GET /rent/accruals, and the answer to "why does the P&L already show salary
// for a month nobody has approved?".
router.get("/hr/salary-accruals", requireModuleView("page:/hr/payroll"), async (req, res): Promise<void> => {
  const params: unknown[] = [];

  // LBAC: a branch user sees the accrual of the employees they can already see.
  const scopeEmp = (req as any).employee as { branchType: string; branchId: number } | undefined;
  let scopeCond = 'TRUE';
  if (scopeEmp && scopeEmp.branchType !== 'headoffice') {
    const scope = await getUserDataScope(scopeEmp);
    scopeCond = scopeBranchWhere(scope, params, 'e');
  }

  const q = req.query as Record<string, unknown>;
  let filters = '';
  if (q.employeeId !== undefined && q.employeeId !== '') {
    params.push(parseInt(String(q.employeeId), 10));
    filters += ` AND a.employee_id = $${params.length}`;
  }
  if (q.year !== undefined && q.year !== '') {
    params.push(parseInt(String(q.year), 10));
    filters += ` AND a.year = $${params.length}`;
  }
  if (q.month !== undefined && q.month !== '') {
    params.push(parseInt(String(q.month), 10));
    filters += ` AND a.month = $${params.length}`;
  }

  // Global location context — accruals follow the employee's branch.
  const accrualViewLoc = getLocationFilter(req);
  if (accrualViewLoc) {
    params.push(accrualViewLoc.locationType);
    filters += ` AND e.branch_type = $${params.length}`;
    if (accrualViewLoc.locationType !== 'headoffice') {
      params.push(accrualViewLoc.locationId);
      filters += ` AND e.branch_id = $${params.length}`;
    }
  }

  const { rows } = await pool.query(
    `SELECT a.employee_id, e.name AS employee_name, a.year, a.month,
            COUNT(*)::int AS days,
            SUM(a.amount)::numeric(15,2) AS accrued,
            MAX(a.monthly_salary)::numeric(15,2) AS monthly_salary,
            MAX(a.days_in_month)::int AS days_in_month,
            MAX(a.working_days)::int AS working_days,
            SUM(a.attendance_factor)::numeric(6,2) AS paid_days,
            COUNT(*) FILTER (WHERE a.amount > 0.004)::int AS earning_days,
            MIN(a.accrual_date) AS first_day, MAX(a.accrual_date) AS last_day,
            COALESCE(MAX(p.status), 'none') AS payroll_status
       FROM salary_accruals a
       JOIN employees e ON e.id = a.employee_id
       LEFT JOIN payroll p ON p.employee_id = a.employee_id AND p.year = a.year AND p.month = a.month
      WHERE ${scopeCond}${filters}
      GROUP BY a.employee_id, e.name, a.year, a.month
      ORDER BY a.year DESC, a.month DESC, e.name`,
    params,
  );

  res.json(rows.map((r: any) => ({
    employeeId: Number(r.employee_id),
    employeeName: r.employee_name,
    year: Number(r.year),
    month: Number(r.month),
    days: Number(r.days),
    accrued: Number(r.accrued),
    monthlySalary: Number(r.monthly_salary),
    daysInMonth: Number(r.days_in_month),
    // Calendar days evaluated vs. days that actually earned, and the paid-day
    // total attendance produced. `days` alone stopped meaning "days charged"
    // once absent days began being recorded as zero-value rows.
    earningDays: Number(r.earning_days ?? 0),
    paidDays: Number(r.paid_days ?? 0),
    workingDays: Number(r.working_days ?? DEFAULT_WORKING_DAYS),
    dailyAccrual: dailyAccrualRate(
      Number(r.monthly_salary),
      Number(r.working_days ?? DEFAULT_WORKING_DAYS),
    ),
    firstDay: r.first_day instanceof Date ? r.first_day.toISOString().slice(0, 10) : r.first_day,
    lastDay: r.last_day instanceof Date ? r.last_day.toISOString().slice(0, 10) : r.last_day,
    payrollStatus: r.payroll_status,
    // An approved or paid month is financially final: the sweep will not extend
    // it and a salary revision will not recalculate it.
    locked: r.payroll_status === 'approved' || r.payroll_status === 'paid',
  })));
});

// Approve payroll → true up the month and post the statutory legs.
//
// Salary itself is NOT recognised here. Daily accrual has been booking
// Dr Salary - <employee> / Cr Salary Payable - <employee> every day of the
// month as it was earned, so what approval posts is the difference between the
// figure payroll finally computed and what has already been accrued, plus the
// legs only a payroll run knows:
//
//   Dr  Salary - <employee>            gross + extra MINUS what already accrued
//   Dr  Employer PF Contribution       employer's PF share
//   Dr  Employer ESI Contribution      employer's ESI share
//     Cr  PF Payable                   employee + employer PF
//     Cr  ESI Payable                  employee + employer ESI
//     Cr  Employee Deductions Payable  other withholdings (TDS, fines…)
//     Cr  Advance to <employee>         advance recovered this run
//     Cr  Salary Payable - <employee>   net take-home MINUS what already accrued
//
// Subtracting the accrued figure from one debit and one credit leaves the two
// sides equal, so the voucher still balances — and either of those two lines
// flips side when the accrual overstated the month. The two employer ledgers and
// the per-employee salary ledger all sit under Indirect Expenses, which is what
// carries salary into the P&L.
//
// Approval also LOCKS the month: from here the accrual sweep adds no further day
// to it and a salary revision leaves it alone.
router.post("/hr/payroll/:id/approve", requireModuleAction("page:/hr/payroll", "edit"), async (req, res): Promise<void> => {
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
      metadata: {
        netPay: posting.netPay, salaryCost: posting.salaryCost, voucherNumber: posting.voucherNumber,
        // The month was already in the books to this extent before approval; the
        // voucher above carries only the remainder.
        alreadyAccrued: posting.accrued,
        trueUpExpense: round2(posting.salaryCost - posting.accrued),
      },
    }).catch(() => {});

    res.json({ ...enrichPayroll(posting.updated, emp), branchName: emp ? await getBranchName(emp.branchType, emp.branchId) : "" });
  } catch (e: any) {
    // Approval used to swallow posting failures, leaving payroll marked
    // approved with no accounting behind it. The status now moves only if the
    // voucher committed, so a failure here means nothing changed.
    //
    // A refusal the approver can act on — stale attendance, someone else got
    // there first — is a 409 with the reason verbatim. Only a genuine posting
    // failure is a 500, so the UI can tell "you need to do something" apart
    // from "the server broke".
    if (e?.monthLocked) { res.status(423).json(e.monthLocked); return; }
    if (e?.conflict) { res.status(409).json({ error: e.message }); return; }
    console.error("[payroll/approve] posting failed:", e);
    res.status(500).json({ error: `Could not post the salary entry, so the payroll was not approved: ${e?.message ?? "unknown error"}` });
  }
});

// Pay payroll — supports partial payments and payment mode
router.post("/hr/payroll/:id/pay", requireModuleAction("page:/hr/payroll", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const today = new Date().toISOString().split("T")[0];
  const payAmount = Number(req.body.amount ?? 0);
  const paymentMode: string = req.body.paymentMode ?? "cash";
  if (!["cash", "bank", "upi"].includes(paymentMode)) {
    res.status(400).json({ error: "Payment mode must be cash, bank or upi." });
    return;
  }

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

  // Month lock: the payment posts a voucher dated `today` and settles the
  // payable of the payroll month, so BOTH must be open. Pre-checked before the
  // transaction opens.
  const payMonthFirst = `${existing.year}-${String(existing.month).padStart(2, "0")}-01`;
  if (await respondIfMonthLocked(res, pool, [payMonthFirst, today], "salary payment")) return;

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
  // The caller may pick WHICH till or bank account pays (e.g. a warehouse or
  // outlet cash box). Head Office defaults to the standard Cash/Bank ledger by
  // mode (UPI settles into the bank account, not the cash drawer). The
  // RECORDED mode is then derived from the account actually used, so the
  // payroll row can never claim "cash" for money that left a bank account.
  const resolvedPay = await resolvePayLedger(
    (req as any).employee, req.body.payLedgerId, paymentMode === 'cash' ? 'STD-CASH' : 'STD-BANK',
  );
  if ('error' in resolvedPay) { res.status(400).json({ error: resolvedPay.error }); return; }
  const payLedgerId = resolvedPay.id;
  {
    const disabledMsg = await disabledWarehouseError(pool, [{ type: resolvedPay.locationType, id: resolvedPay.locationId }]);
    if (disabledMsg) { res.status(409).json({ error: disabledMsg, code: WAREHOUSE_DISABLED_CODE }); return; }
  }
  const effectiveMode = resolvedPay.tree === 'bank'
    ? (paymentMode === 'upi' ? 'upi' : 'bank')
    : 'cash';
  if (!salPayId) {
    res.status(500).json({
      error: "Cannot record this payment: the salary payable ledger is missing. No payment was recorded.",
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
    // Stamped with the paying till's location (null for HO money): a salary
    // paid from a warehouse or outlet cash box must show up in that location's
    // report slice, not vanish into the company bucket.
    const { rows: [jv] } = await client.query(
      `INSERT INTO journal_vouchers (voucher_type, voucher_number, voucher_date, narration, total_amount, created_by,
                                    origin, source_module, location_type, location_id)
       VALUES ('journal', $1, $2, $3, $4, $5, 'system', 'payroll', $6, $7) RETURNING id`,
      [voucherNumber, today, narration, payNow.toFixed(2), req.employee?.username ?? "system",
       resolvedPay.locationType, resolvedPay.locationId],
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
      [String(lockedPaid), effectiveMode, lockedFull, lockedFull ? today : null, lockedFull ? 'paid' : 'approved', id],
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
    description: `Salary ${isFullyPaid ? 'paid' : 'partial payment'} for ${emp?.name ?? `Emp #${existing.employee_id}`} — ₹${payNow.toLocaleString("en-IN")} via ${effectiveMode}`,
    metadata: { payNow, totalNet, newPaidAmt, isFullyPaid } }).catch(() => {});

  res.json({ ...enrichPayroll(row, emp), branchName: emp ? await getBranchName(emp.branchType, emp.branchId) : "" });
});

// ── Employee Advances ──────────────────────────────────────────────────────
router.get("/hr/advances", async (req, res): Promise<void> => {
  const scopeEmp = (req as any).employee as { id: number; branchType: string; hierarchyId?: number } | undefined;
  if (!scopeEmp) { res.status(401).json({ error: "Authentication required" }); return; }
  // An employee may ALWAYS read their OWN advances — the employee app's Home
  // tile and payslip deductions depend on it. The page right gates the wider
  // view (other employees' advances): lacking it forces self-scope instead of
  // a 403. Non-HO callers were already self-scoped even WITH the right.
  const canViewAllAdvances = await hasModuleAction(scopeEmp.hierarchyId, "page:/hr/advances", "view");
  const advConds: string[] = [];
  const params: unknown[] = [];
  if (!canViewAllAdvances || scopeEmp.branchType !== 'headoffice') {
    params.push(scopeEmp.id);
    advConds.push(`ea.employee_id = $${params.length}`);
  }
  // Global location context — advances follow the employee's branch.
  const advViewLoc = getLocationFilter(req);
  if (advViewLoc) {
    params.push(advViewLoc.locationType);
    advConds.push(`e.branch_type = $${params.length}`);
    if (advViewLoc.locationType !== 'headoffice') {
      params.push(advViewLoc.locationId);
      advConds.push(`e.branch_id = $${params.length}`);
    }
  }
  const empFilter = advConds.length ? `WHERE ${advConds.join(' AND ')}` : '';
  const paging = parsePaging(req.query as Record<string, unknown>);
  const { rows } = await pool.query(
    `SELECT ea.*, e.name AS employee_name
     FROM employee_advances ea JOIN employees e ON e.id = ea.employee_id
     ${empFilter} ORDER BY ea.created_at DESC`,
    params,
  );
  setPagingHeaders(res, rows.length, paging);
  res.json(applyPaging(rows, paging).map((r: any) => ({
    id: r.id, employeeId: r.employee_id, employeeName: r.employee_name,
    amount: Number(r.amount), date: r.date, note: r.note,
    isDeducted: r.is_deducted, deductedPayrollId: r.deducted_payroll_id,
    // NULL = legacy row from the old ADV-EMP flow. Pending legacy rows are
    // locked for edit/delete (their balance was migrated to Salary Payable);
    // the UI hides those buttons on this flag.
    paymentVoucherId: r.payment_voucher_id ?? null,
    createdAt: r.created_at,
  })));
});

router.post("/hr/advances", requireModuleAction("page:/hr/advances", "add"), async (req, res): Promise<void> => {
  const { employeeId, date, note } = req.body;
  // Validate the decimal STRING (≤ 2dp) — number inputs post strings and
  // NUMERIC does the maths, so never round-trip through float formatting.
  const amtStr = String(req.body.amount ?? "").trim();
  if (!employeeId || !amtStr) { res.status(400).json({ error: "employeeId and amount are required" }); return; }
  if (!/^\d+(\.\d{1,2})?$/.test(amtStr) || Number(amtStr) <= 0) {
    res.status(400).json({ error: "Amount must be a positive number with at most 2 decimals" }); return;
  }
  const amount = Number(amtStr).toFixed(2);
  const today = new Date().toISOString().split("T")[0];
  const advDate = date ?? today;
  if (!isIsoDate(advDate)) { res.status(400).json({ error: "date must be a real calendar date in YYYY-MM-DD form" }); return; }

  // Month lock: an advance is a new payment dated advDate — it may not be
  // recorded into a locked accounting period.
  if (await respondIfMonthLocked(res, pool, [advDate], "employee advance")) return;

  // Resolve the paying account BEFORE anything is written: an invalid account
  // must reject the whole request, not leave an advance with no accounting
  // behind it.
  const resolvedAdv = await resolvePayLedger((req as any).employee, req.body.payLedgerId, 'STD-CASH');
  if ('error' in resolvedAdv) { res.status(400).json({ error: resolvedAdv.error }); return; }
  {
    const disabledMsg = await disabledWarehouseError(pool, [{ type: resolvedAdv.locationType, id: resolvedAdv.locationId }]);
    if (disabledMsg) { res.status(409).json({ error: disabledMsg, code: WAREHOUSE_DISABLED_CODE }); return; }
  }

  const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.id, Number(employeeId))).limit(1);
  if (!emp) { res.status(404).json({ error: "Employee not found" }); return; }

  // Books (owner decision, Aug 2026): an advance is a PAYMENT VOUCHER against
  // the employee's Salary Payable ledger — Dr Salary Payable / Cr till — which
  // drives the payable negative until payroll accrues against it. There is NO
  // separate Employee Advance asset ledger and NO separate recovery flow any
  // more. The voucher is stamped source='employee_advance' so the manual
  // voucher endpoints refuse to edit or delete it (this endpoint owns it).
  // Voucher and advance row commit together or not at all — the old flow wrote
  // them in separate transactions and swallowed voucher errors, which could
  // leave an advance with no accounting behind it.
  const { payableLedgerId } = await provisionSalaryLedgers(pool, Number(employeeId), emp.name);
  if (!payableLedgerId) {
    res.status(500).json({ error: "Could not provision the employee's Salary Payable ledger. No advance was recorded." });
    return;
  }

  let row: any;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const vn = await nextVoucherNumber(client, "payment", advDate);
    const { rows: [pv] } = await client.query(
      `INSERT INTO payments (voucher_number, payment_date, paid_from_ledger_id, paid_to_ledger_id, amount, narration,
                             location_type, location_id, created_by, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'employee_advance') RETURNING id, voucher_number`,
      [vn, advDate, resolvedAdv.id, payableLedgerId, amount,
       `Advance to ${emp.name}`, resolvedAdv.locationType, resolvedAdv.locationId,
       (req as any).employee?.username ?? "system"],
    );
    const { rows: [inserted] } = await client.query(
      `INSERT INTO employee_advances (employee_id, amount, date, note, is_deducted, payment_voucher_id)
       VALUES ($1, $2, $3, $4, false, $5) RETURNING *`,
      [employeeId, amount, advDate, note ?? null, pv.id],
    );
    await client.query("COMMIT");
    row = { ...inserted, voucher_number: pv.voucher_number };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  logActivity({ action: "CREATE", module: "payroll", entityType: "employee_advance", entityId: row.id,
    description: `Advance of ₹${Number(amount).toLocaleString("en-IN")} to ${emp.name} — payment voucher ${row.voucher_number} against Salary Payable`,
    metadata: { amount: Number(amount), date: advDate, paymentVoucherId: row.payment_voucher_id, voucherNumber: row.voucher_number },
  }).catch(() => {});

  res.status(201).json({
    id: row.id, employeeId: row.employee_id, employeeName: emp.name,
    amount: Number(row.amount), date: row.date, note: row.note,
    isDeducted: row.is_deducted, deductedPayrollId: row.deducted_payroll_id,
    paymentVoucherId: row.payment_voucher_id,
    createdAt: row.created_at,
  });
});

// The cash "Advance Recovery" workflow is RETIRED (owner decision, Aug 2026):
// an advance now lives as a debit on the employee's Salary Payable ledger and
// payroll settles it — one settlement path. Historical recoveries stay fully
// readable through GET /hr/advances (module-retirement pattern: total hide of
// the write path, reads keep serving history).

// Edit a pending advance (amount / date / note). Only an advance no payroll
// run has touched may change — once it is settled or reserved, the recovery
// figures were built on the stored amount, so an edit would desync the books.
// The linked disbursement voucher is updated in the same transaction.
router.patch("/hr/advances/:id", requireModuleAction("page:/hr/advances", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid advance id" }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;

  // Validate the decimal STRING (≤ 2dp) — number inputs post strings and
  // NUMERIC does the maths, so never round-trip through float formatting.
  let newAmount: string | undefined;
  if (b.amount !== undefined) {
    const s = String(b.amount).trim();
    if (!/^\d+(\.\d{1,2})?$/.test(s) || Number(s) <= 0) {
      res.status(400).json({ error: "Amount must be a positive number with at most 2 decimals" }); return;
    }
    newAmount = Number(s).toFixed(2);
  }
  let newDate: string | undefined;
  if (b.date !== undefined) {
    if (!isIsoDate(b.date)) {
      res.status(400).json({ error: "date must be a real calendar date in YYYY-MM-DD form" }); return;
    }
    newDate = b.date;
  }
  const noteProvided = b.note !== undefined;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [adv] } = await client.query(
      `SELECT *, date::text AS date_text FROM employee_advances WHERE id = $1 FOR UPDATE`, [id],
    );
    if (!adv) { await client.query("ROLLBACK"); res.status(404).json({ error: "Advance not found" }); return; }
    if (adv.is_deducted) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "This advance is already recovered — it can no longer be edited. Delete it and record a fresh one if it was wrong." });
      return;
    }
    if (adv.deducted_payroll_id !== null) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "This advance is reserved by a payroll run. Remove it from that run first." });
      return;
    }
    if (!adv.payment_voucher_id) {
      // Legacy row (old ADV-EMP flow): its outstanding balance was moved to
      // Salary Payable by the one-time migration, which the linked journal
      // voucher knows nothing about — editing that voucher would desync the
      // migrated figure. Locked; adjust with a manual journal voucher instead.
      await client.query("ROLLBACK");
      res.status(400).json({ error: "This advance was recorded under the old Employee Advance system and its balance now lives on Salary Payable — it can no longer be edited. Post a journal voucher if the figures need adjusting." });
      return;
    }

    const oldDate: string = adv.date_text;
    const effDate = newDate ?? oldDate;
    // Month lock: an edit may neither touch an advance inside a locked month
    // nor move it into/out of one — check BOTH the stored date and the new one.
    for (const d of [oldDate, effDate]) {
      const ym = ymOfDate(d);
      if (ym && await isMonthLocked(client, ym.year, ym.month)) {
        await client.query("ROLLBACK");
        res.status(423).json(monthLockedBody(ym.year, ym.month));
        return;
      }
    }

    const effAmount = newAmount ?? Number(adv.amount).toFixed(2);
    const { rows: [updated] } = await client.query(
      `UPDATE employee_advances SET amount = $2, date = $3, note = $4
       WHERE id = $1 RETURNING *, date::text AS date_text`,
      [id, effAmount, effDate, noteProvided ? (String(b.note ?? "").trim() || null) : adv.note],
    );

    // Keep the disbursement payment voucher in lockstep (date, amount).
    {
      const { rows: [pv] } = await client.query(
        `SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [adv.payment_voucher_id],
      );
      if (pv) {
        // Voucher numbers are FY-scoped: a date moved into another financial
        // year needs a number from that year's sequence; same-FY edits keep it.
        let vn = String(pv.voucher_number);
        const curFy = vn.split("/")[1] ?? "";
        let fyStart = 4;
        try {
          const { rows } = await client.query(`SELECT fy_start_month FROM company_settings LIMIT 1`);
          fyStart = Number(rows[0]?.fy_start_month ?? 4) || 4;
        } catch { /* defaults */ }
        if (financialYearLabel(effDate, fyStart) !== curFy) {
          vn = await nextVoucherNumber(client, "payment", effDate);
        }
        await client.query(
          `UPDATE payments SET voucher_number = $2, payment_date = $3, amount = $4 WHERE id = $1`,
          [pv.id, vn, effDate, effAmount],
        );
      }
    }
    await client.query("COMMIT");

    const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.id, Number(updated.employee_id))).limit(1);
    logActivity({ action: "UPDATE", module: "payroll", entityType: "employee_advance", entityId: id,
      description: `Advance to ${emp?.name ?? `Employee #${updated.employee_id}`} edited`,
      metadata: {
        old: { amount: Number(adv.amount), date: oldDate, note: adv.note },
        new: { amount: Number(updated.amount), date: updated.date_text, note: updated.note },
      },
    }).catch(() => {});

    res.json({
      id: updated.id, employeeId: updated.employee_id, employeeName: emp?.name ?? "",
      amount: Number(updated.amount), date: updated.date_text, note: updated.note,
      isDeducted: updated.is_deducted, deductedPayrollId: updated.deducted_payroll_id,
      createdAt: updated.created_at,
    });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
});

// Delete an advance recorded in error. A pending advance and a CASH-recovered
// one can go — their system vouchers (disbursement, and recovery if any) are
// removed in the same transaction, so the books unwind mechanically. An
// advance a payroll run deducted or reserved cannot be deleted: the salary
// figures were built on it.
router.delete("/hr/advances/:id", requireModuleAction("page:/hr/advances", "delete"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid advance id" }); return; }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [adv] } = await client.query(
      `SELECT *, date::text AS date_text FROM employee_advances WHERE id = $1 FOR UPDATE`, [id],
    );
    if (!adv) { await client.query("ROLLBACK"); res.status(404).json({ error: "Advance not found" }); return; }
    if (adv.deducted_payroll_id !== null) {
      await client.query("ROLLBACK");
      res.status(400).json({
        error: adv.is_deducted
          ? "This advance was recovered through a payroll run — it cannot be deleted."
          : "This advance is reserved by a payroll run. Remove it from that run first.",
      });
      return;
    }
    if (!adv.is_deducted && !adv.payment_voucher_id) {
      // Pending LEGACY row (old ADV-EMP flow): the one-time migration moved its
      // outstanding balance onto Salary Payable, and deleting the original
      // disbursement voucher alone would strand that transfer. Locked; adjust
      // with a manual journal voucher instead. (Cash-recovered legacy rows are
      // still deletable — their two vouchers net to zero, so removing both
      // unwinds cleanly.)
      await client.query("ROLLBACK");
      res.status(400).json({ error: "This advance was recorded under the old Employee Advance system and its balance was moved to Salary Payable — deleting it would break the books. Post a journal voucher if it needs reversing." });
      return;
    }

    const voucherIds = [adv.journal_voucher_id, adv.recovery_voucher_id]
      .filter((v): v is number => v !== null && v !== undefined);
    const lockDates: string[] = [adv.date_text];
    const voucherNumbers: string[] = [];
    if (voucherIds.length) {
      const { rows: jvs } = await client.query(
        `SELECT id, voucher_number, voucher_date::text AS d FROM journal_vouchers WHERE id = ANY($1) FOR UPDATE`,
        [voucherIds],
      );
      for (const jv of jvs) { lockDates.push(jv.d); voucherNumbers.push(jv.voucher_number); }
    }
    // New-flow advances disbursed a payment voucher — it goes with the row.
    let pvRow: { id: number } | null = null;
    if (adv.payment_voucher_id) {
      const { rows: [pv] } = await client.query(
        `SELECT id, voucher_number, payment_date::text AS d FROM payments WHERE id = $1 FOR UPDATE`,
        [adv.payment_voucher_id],
      );
      if (pv) { pvRow = pv; lockDates.push(pv.d); voucherNumbers.push(pv.voucher_number); }
    }
    // Month lock: the advance date AND every voucher it posted (a cash
    // recovery is dated the day the money came back) must be in open months.
    for (const d of Array.from(new Set(lockDates))) {
      const ym = ymOfDate(d);
      if (ym && await isMonthLocked(client, ym.year, ym.month)) {
        await client.query("ROLLBACK");
        res.status(423).json(monthLockedBody(ym.year, ym.month));
        return;
      }
    }

    if (voucherIds.length) {
      await client.query(`DELETE FROM journal_voucher_lines WHERE voucher_id = ANY($1)`, [voucherIds]);
      await client.query(`DELETE FROM journal_vouchers WHERE id = ANY($1)`, [voucherIds]);
    }
    if (pvRow) {
      await client.query(`DELETE FROM payments WHERE id = $1`, [pvRow.id]);
    }
    await client.query(`DELETE FROM employee_advances WHERE id = $1`, [id]);
    await client.query("COMMIT");

    const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.id, Number(adv.employee_id))).limit(1);
    logActivity({ action: "DELETE", module: "payroll", entityType: "employee_advance", entityId: id,
      description: `Advance of ₹${Number(adv.amount).toLocaleString("en-IN")} to ${emp?.name ?? `Employee #${adv.employee_id}`} deleted`,
      metadata: { amount: Number(adv.amount), date: adv.date_text, wasRecovered: adv.is_deducted, vouchersRemoved: voucherNumbers },
    }).catch(() => {});

    res.json({ success: true, vouchersRemoved: voucherNumbers });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
});

// ── Attendance ────────────────────────────────────────────────────────────
router.get("/hr/attendance", requireModuleView("page:/hr/attendance"), async (req, res): Promise<void> => {
  const scopeEmp = (req as any).employee as { id: number; branchType: string } | undefined;

  // ── Range mode: ?year=YYYY&month=M (whole month) or ?from/?to (arbitrary
  //    range, YYYY-MM-DD) return all records in the period ──
  const yearParam = req.query.year ? Number(req.query.year) : null;
  const monthParam = req.query.month ? Number(req.query.month) : null;
  const dr = parseDateRange(req.query as Record<string, unknown>);
  if (!dr.ok) { res.status(400).json({ error: dr.error }); return; }

  let startDate = '';
  let endDate = '';
  if (yearParam && monthParam && !isNaN(yearParam) && !isNaN(monthParam)) {
    const padM = String(monthParam).padStart(2, '0');
    startDate = `${yearParam}-${padM}-01`;
    const lastDay = new Date(yearParam, monthParam, 0).getDate();
    endDate = `${yearParam}-${padM}-${String(lastDay).padStart(2, '0')}`;
  } else if (dr.from || dr.to) {
    startDate = dr.from;
    endDate = dr.to;
  }

  // Global location context — attendance follows the employee's branch.
  const attViewLoc = getLocationFilter(req);

  if (startDate || endDate) {
    // Scope: non-headoffice employees only see their own records
    const rangeConds = [
      startDate ? gte(attendanceTable.date, startDate) : undefined,
      endDate ? lte(attendanceTable.date, endDate) : undefined,
      scopeEmp && scopeEmp.branchType !== 'headoffice' ? eq(attendanceTable.employeeId, scopeEmp.id) : undefined,
      attViewLoc
        ? (attViewLoc.locationType === 'headoffice'
            ? sql`${attendanceTable.employeeId} IN (SELECT id FROM employees WHERE branch_type = 'headoffice')`
            : sql`${attendanceTable.employeeId} IN (SELECT id FROM employees WHERE branch_type = ${attViewLoc.locationType} AND branch_id = ${attViewLoc.locationId})`)
        : undefined,
    ].filter((c): c is NonNullable<typeof c> => c !== undefined);
    const rows = await db.select().from(attendanceTable).where(and(...rangeConds));

    // leave_type is a raw-migration column, invisible to the drizzle row —
    // read it by id so a stored sick day round-trips as sick, not casual.
    const ltMap = new Map<number, string>();
    if (rows.length) {
      const { rows: lt } = await pool.query(
        `SELECT id, leave_type FROM attendance WHERE id = ANY($1) AND leave_type IS NOT NULL`,
        [rows.map((r) => r.id)],
      );
      for (const r of lt) ltMap.set(Number(r.id), String(r.leave_type));
    }

    const ws = await loadAttendanceWorkSettings();
    const punchMap = await loadPunchMap(
      pool,
      startDate || '0001-01-01', endDate || '9999-12-31',
      scopeEmp && scopeEmp.branchType !== 'headoffice' ? scopeEmp.id : undefined,
    );

    const result = rows.map((r) => {
      const date = typeof r.date === 'string' ? r.date : (r.date as any).toISOString().split('T')[0];
      const checkIn = r.checkIn?.toISOString() ?? null;
      const checkOut = r.checkOut?.toISOString() ?? null;
      const derived = derivePunchFields(
        { checkIn, checkOut }, punchMap.get(`${r.employeeId}|${date}`) ?? [], ws,
      );
      return {
        id: r.id,
        employeeId: r.employeeId,
        date,
        checkIn,
        checkOut,
        checkInLat: r.checkInLat ? Number(r.checkInLat) : null,
        checkInLng: r.checkInLng ? Number(r.checkInLng) : null,
        checkOutLat: r.checkOutLat ? Number(r.checkOutLat) : null,
        checkOutLng: r.checkOutLng ? Number(r.checkOutLng) : null,
        status: r.status ?? 'absent',
        leaveType: ltMap.get(r.id) ?? null,
        // hoursWorked keeps its historical meaning (multi-punch aware via
        // derived.workingHours — the same figure the day is paid on).
        hoursWorked: derived.workingHours,
        ...derived,
      };
    });

    const paging = parsePaging(req.query as Record<string, unknown>);
    setPagingHeaders(res, result.length, paging);
    res.json(applyPaging(result, paging));
    return;
  }

  // ── Single-date mode (legacy / manager view) ─────────────────────────────
  const qp = ListAttendanceQueryParams.safeParse(req.query);
  const targetDate = (qp.success && qp.data.date) ? qp.data.date : await businessTodayStr();
  const filterEmployeeId = qp.success && qp.data.employeeId ? Number(qp.data.employeeId) : null;

  // All active employees (or just one if filtered)
  let allEmployees = await db.select().from(employeesTable).where(eq(employeesTable.isActive, true));
  if (filterEmployeeId) allEmployees = allEmployees.filter((e) => e.id === filterEmployeeId);

  // Non-headoffice employees only see their own attendance row
  if (scopeEmp && scopeEmp.branchType !== 'headoffice') {
    allEmployees = allEmployees.filter((e) => e.id === scopeEmp.id);
  }

  // Global location context narrows the register to one branch's employees.
  if (attViewLoc) {
    allEmployees = allEmployees.filter((e) =>
      e.branchType === attViewLoc.locationType &&
      (attViewLoc.locationType === 'headoffice' || Number(e.branchId) === attViewLoc.locationId));
  }

  // Existing attendance rows for that date
  const rows = await db.select().from(attendanceTable)
    .where(eq(attendanceTable.date, targetDate));
  const attMap = new Map(rows.map((r) => [r.employeeId, r]));

  // leave_type is a raw-migration column, invisible to the drizzle row —
  // read it separately so a stored sick day round-trips as sick, not casual.
  const dayLtMap = new Map<number, string>();
  {
    const { rows: lt } = await pool.query(
      `SELECT id, leave_type FROM attendance WHERE date = $1 AND leave_type IS NOT NULL`,
      [targetDate],
    );
    for (const r of lt) dayLtMap.set(Number(r.id), String(r.leave_type));
  }

  const wsDay = await loadAttendanceWorkSettings();
  const dayPunchMap = await loadPunchMap(pool, targetDate, targetDate);

  // What the company calendar says about this date: a rowless day on a holiday
  // or configured weekly off displays as that, not as absent — matching how the
  // pay formula prices it. A stored row still outvotes the calendar.
  const { policy: dayPolicy } = await loadPayrollSettings(pool);
  const dayCal = calendarDayInfo(targetDate, dayPolicy, await loadHolidaySet(pool, targetDate, targetDate));
  const syntheticStatus = dayCal.holiday ? "company_holiday" : dayCal.weeklyOff ? "weekly_off" : "absent";

  const emptyDerived = {
    punches: [] as any[], workingHours: null as number | null,
    lateMinutes: null as number | null, overtimeHours: null as number | null,
    openPunchIn: null as string | null,
  };

  // Merge: every active employee gets a row (synthetic absent if no record)
  const result = allEmployees.map((emp) => {
    const r = attMap.get(emp.id);
    if (r) {
      const checkIn = r.checkIn?.toISOString() ?? null;
      const checkOut = r.checkOut?.toISOString() ?? null;
      const derived = derivePunchFields(
        { checkIn, checkOut }, dayPunchMap.get(`${emp.id}|${targetDate}`) ?? [], wsDay,
      );
      return {
        id: r.id,
        employeeId: emp.id,
        employeeName: emp.name,
        date: r.date,
        checkIn,
        checkOut,
        checkInLat: r.checkInLat ? Number(r.checkInLat) : null,
        checkInLng: r.checkInLng ? Number(r.checkInLng) : null,
        checkOutLat: r.checkOutLat ? Number(r.checkOutLat) : null,
        checkOutLng: r.checkOutLng ? Number(r.checkOutLng) : null,
        status: r.status,
        leaveType: dayLtMap.get(r.id) ?? null,
        hoursWorked: derived.workingHours,
        ...derived,
      };
    }
    // No record yet — synthetic row: absent, unless the calendar pays the day.
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
      status: syntheticStatus,
      leaveType: null,
      hoursWorked: null,
      ...emptyDerived,
    };
  });

  // Sort: employees with check-in first, then absent; alphabetical within each group
  result.sort((a, b) => {
    if (!!a.checkIn !== !!b.checkIn) return a.checkIn ? -1 : 1;
    return a.employeeName.localeCompare(b.employeeName);
  });

  const paging = parsePaging(req.query as Record<string, unknown>);
  setPagingHeaders(res, result.length, paging);
  res.json(applyPaging(result, paging));
});

// What the register displays against: pay thresholds plus the display-only
// day-start / grace / overtime settings. Read-only; the values are edited
// through company settings' general_settings like the thresholds always were.
router.get("/hr/attendance/config", requireModuleView("page:/hr/attendance"), async (_req, res): Promise<void> => {
  const [settings, ws] = await Promise.all([
    loadPayrollSettings(pool),
    loadAttendanceWorkSettings(),
  ]);
  // `today` = the company's CURRENT operational date. Clients must key their
  // "today" views on this (or on `timeZone`) — a device outside the company
  // timezone that uses its own calendar asks for the wrong register day and
  // can't see the open session the server is holding for it.
  // weeklyOffs travels along so the calendar can shade configured off days
  // exactly as the server will price them.
  res.json({
    ...settings.thresholds, ...ws,
    weeklyOffs: settings.policy.weeklyOffs,
    today: new Date().toLocaleDateString("en-CA", { timeZone: ws.timeZone }),
  });
});

// ── Company holidays ─────────────────────────────────────────────────────────
// Admin-defined paid days. Every employee's tracked month pays them without an
// attendance row; a stored row for the date (worked, or a correction) outvotes
// the calendar per employee — that is the override mechanism, so there is no
// per-employee holiday table. Writes re-run the salary accrual sweep, which
// re-prices unapproved months only (signed-off months are locked and skipped).
// Listing stays view-guarded (not HO-only) on purpose: every employee's
// attendance calendar shades company holidays, so anyone who can see the
// register needs the list. Only the WRITES below are Head Office actions.
router.get("/hr/holidays", requireModuleView("page:/hr/attendance"), async (req, res): Promise<void> => {
  const year = Number((req.query as any)?.year);
  const params: unknown[] = [];
  let where = "";
  if (Number.isInteger(year) && year > 1900) {
    params.push(year);
    where = `WHERE EXTRACT(YEAR FROM holiday_date) = $1`;
  }
  const { rows } = await pool.query(
    `SELECT id, to_char(holiday_date, 'YYYY-MM-DD') AS date, name
       FROM company_holidays ${where} ORDER BY holiday_date`, params);
  res.json(rows);
});

router.post("/hr/holidays", requireModuleAction("page:/hr/attendance", "edit"), async (req, res): Promise<void> => {
  // Holidays move every employee's pay, so like attendance correction this is
  // a Head Office action even for branch managers holding the edit right.
  if ((req as any).employee?.branchType !== "headoffice") {
    res.status(403).json({ error: "Only Head Office can manage company holidays." });
    return;
  }
  const date = String((req.body as any)?.date ?? "").slice(0, 10);
  const name = String((req.body as any)?.name ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "date must be YYYY-MM-DD" }); return;
  }
  if (!name) { res.status(400).json({ error: "A holiday name is required" }); return; }
  const { rows: [row] } = await pool.query(
    `INSERT INTO company_holidays (holiday_date, name) VALUES ($1, $2)
     ON CONFLICT (holiday_date) DO NOTHING
     RETURNING id, to_char(holiday_date, 'YYYY-MM-DD') AS date, name`,
    [date, name],
  );
  if (!row) {
    res.status(409).json({ error: "That date is already a company holiday." });
    return;
  }
  // Re-price unapproved salary accruals across all employees — the holiday may
  // sit anywhere in their open months. Locked (signed-off) months are skipped
  // by the sweep itself.
  await runSalaryAccrual(pool).catch((e) =>
    console.error("[holidays] accrual re-run after create failed:", e));
  logActivity({
    action: "CREATE", module: "hr", entityType: "company_holiday", entityId: Number(row.id),
    description: `Company holiday added: ${name} on ${date}`,
    user: (req as any).employee?.username ?? "system",
    metadata: { date, name },
  }).catch(() => {});
  res.status(201).json(row);
});

router.delete("/hr/holidays/:id", requireModuleAction("page:/hr/attendance", "edit"), async (req, res): Promise<void> => {
  if ((req as any).employee?.branchType !== "headoffice") {
    res.status(403).json({ error: "Only Head Office can manage company holidays." });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid id" }); return; }
  const { rows: [gone] } = await pool.query(
    `DELETE FROM company_holidays WHERE id = $1
     RETURNING to_char(holiday_date, 'YYYY-MM-DD') AS date, name`, [id]);
  if (!gone) { res.status(404).json({ error: "Not found" }); return; }
  await runSalaryAccrual(pool).catch((e) =>
    console.error("[holidays] accrual re-run after delete failed:", e));
  logActivity({
    action: "DELETE", module: "hr", entityType: "company_holiday", entityId: id,
    description: `Company holiday removed: ${gone.name} on ${gone.date}`,
    user: (req as any).employee?.username ?? "system",
    metadata: { date: gone.date, name: gone.name },
  }).catch(() => {});
  res.json({ ok: true });
});

// ── Leave balance ────────────────────────────────────────────────────────────
// Casual + sick allocated / taken / remaining for one employee-month, computed
// by the SAME summary the pay formula uses — never a hand-rolled count.
router.get("/hr/leave-balance", requireModuleView("page:/hr/attendance"), async (req, res): Promise<void> => {
  const caller = (req as any).employee as { id: number; branchType: string } | undefined;
  let employeeId = Number((req.query as any)?.employeeId);
  // Non-Head-Office callers always get their own balance, whatever they ask for.
  if (!caller) { res.status(401).json({ error: "Authentication required" }); return; }
  if (caller.branchType !== "headoffice" || !Number.isInteger(employeeId) || employeeId <= 0) {
    employeeId = caller.id;
  }
  const now = new Date();
  const year = Number((req.query as any)?.year) || now.getFullYear();
  const month = Number((req.query as any)?.month) || now.getMonth() + 1;
  if (!Number.isInteger(year) || year < 1900 || !Number.isInteger(month) || month < 1 || month > 12) {
    res.status(400).json({ error: "Invalid year/month" }); return;
  }
  const mm = String(month).padStart(2, "0");
  const first = `${year}-${mm}-01`;
  const last = `${year}-${mm}-${String(new Date(year, month, 0).getDate()).padStart(2, "0")}`;
  const { policy, thresholds } = await loadPayrollSettings(pool);
  const { rows: monthRows } = await pool.query(
    `SELECT a.date, a.status, a.leave_type AS "leaveType",
            a.check_in AS "checkIn", a.check_out AS "checkOut",
            ap.punched_hours AS "punchedHours"
       FROM attendance a
       ${PUNCHED_HOURS_JOIN("a")}
      WHERE a.employee_id = $1 AND a.date >= $2 AND a.date <= $3`,
    [employeeId, first, last],
  );
  // Synthesised calendar days (rowless weekly offs / holidays) are bounded to
  // today: a Sunday three weeks from now is not leave already "taken". Stored
  // rows — leave approved in advance — still count whatever their date.
  const summary = monthLeaveSummary(monthRows, policy, thresholds, {
    year, month, holidays: await loadHolidaySet(pool, first, last),
    until: await businessTodayStr(),
  });
  res.json({
    employeeId, year, month, tracked: summary.tracked,
    casual: {
      allowed: policy.paidCasualLeavesPerMonth,
      taken: summary.leaveTaken,
      remaining: Math.max(0, policy.paidCasualLeavesPerMonth - summary.leaveTaken),
    },
    sick: {
      allowed: policy.paidSickLeavesPerMonth,
      taken: summary.sickLeaveTaken,
      remaining: Math.max(0, policy.paidSickLeavesPerMonth - summary.sickLeaveTaken),
    },
  });
});

router.post("/hr/attendance/check-in", requireModuleAction("page:/hr/attendance", "add"), async (req, res): Promise<void> => {
  const parsed = CheckInBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  // Non-headoffice employees may only check in for themselves
  const scopeEmpCI = (req as any).employee as { id: number; branchType: string } | undefined;
  if (scopeEmpCI && scopeEmpCI.branchType !== 'headoffice' && parsed.data.employeeId !== scopeEmpCI.id) {
    res.status(403).json({ error: "You can only check in for yourself." });
    return;
  }
  const today = await businessTodayStr();
  // Month lock: a punch is a dated attendance record (it re-prices salary
  // accrual for that day), so it may not land in a locked accounting period.
  if (await respondIfMonthLocked(res, pool, [today], "attendance check-in")) return;
  // Checking in writes the same figure approval reads, so it queues on the same
  // per-employee lock — see withAttendanceWrite.
  let row: any;
  let dayPunches: any[] = [];
  try {
    row = await withAttendanceWrite(parsed.data.employeeId, [today], async (q) => {
      // One open session at a time. A second check-in while one is open is a
      // mistake (a missed check-out), not a new session — refuse it so the
      // hours can never silently overlap.
      const { rows: [open] } = await q.query(
        `SELECT 1 FROM attendance_punches
          WHERE employee_id = $1 AND date = $2 AND punch_out IS NULL LIMIT 1`,
        [parsed.data.employeeId, today],
      );
      if (open) {
        throw Object.assign(new Error("Already checked in — check out before checking in again."), { conflict: true });
      }

      // A day recorded before punches existed has its hours only on the
      // attendance row. Re-checking in reopens the day (check_out goes back to
      // NULL below), so that earlier session must first be preserved as a
      // closed punch or its hours would vanish from the total.
      await q.query(
        `INSERT INTO attendance_punches (employee_id, date, punch_in, punch_out, in_lat, in_lng, out_lat, out_lng)
         SELECT a.employee_id, a.date, a.check_in, a.check_out,
                a.check_in_lat, a.check_in_lng, a.check_out_lat, a.check_out_lng
           FROM attendance a
          WHERE a.employee_id = $1 AND a.date = $2
            AND a.check_in IS NOT NULL AND a.check_out IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM attendance_punches p
                             WHERE p.employee_id = $1 AND p.date = $2)`,
        [parsed.data.employeeId, today],
      );

      await q.query(
        `INSERT INTO attendance_punches (employee_id, date, punch_in, in_lat, in_lng)
         VALUES ($1, $2, now(), $3, $4)`,
        [parsed.data.employeeId, today, String(parsed.data.lat), String(parsed.data.lng)],
      );

      // The attendance row keeps first-in / last-out: the first check-in of the
      // day owns check_in, and re-checking in reopens the day, so check_out is
      // cleared until the next check-out writes the new last-out. An open day
      // is provisionally whole (see dayFactor), exactly as before.
      const { rows: [r] } = await q.query(
        `INSERT INTO attendance (employee_id, date, status, check_in, check_in_lat, check_in_lng)
         VALUES ($1, $2, 'present', now(), $3, $4)
         ON CONFLICT (employee_id, date) DO UPDATE
            SET check_in     = COALESCE(attendance.check_in, EXCLUDED.check_in),
                check_in_lat = COALESCE(attendance.check_in_lat, EXCLUDED.check_in_lat),
                check_in_lng = COALESCE(attendance.check_in_lng, EXCLUDED.check_in_lng),
                check_out = NULL, check_out_lat = NULL, check_out_lng = NULL,
                status = CASE WHEN attendance.status = 'leave' THEN attendance.status ELSE 'present' END
         RETURNING *`,
        [parsed.data.employeeId, today, String(parsed.data.lat), String(parsed.data.lng)],
      );
      const { rows: ps } = await q.query(
        `SELECT * FROM attendance_punches WHERE employee_id = $1 AND date = $2 ORDER BY punch_in ASC`,
        [parsed.data.employeeId, today],
      );
      dayPunches = ps;
      return r;
    });
  } catch (e: any) {
    sendAttendanceWriteError(res, e, "check-in");
    return;
  }
  // Map the raw row explicitly rather than spreading it — spreading would leak
  // the snake_case columns into the API response alongside the camelCase ones.
  row = attendanceRowToApi(row);
  await reaccrue(row.employeeId, "check-in");
  const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.id, row.employeeId)).limit(1);
  res.status(201).json({
    ...row, employeeName: emp?.name ?? "",
    checkIn: row.checkIn?.toISOString() ?? null, checkOut: row.checkOut?.toISOString() ?? null,
    checkInLat: row.checkInLat ? Number(row.checkInLat) : null,
    checkInLng: row.checkInLng ? Number(row.checkInLng) : null,
    checkOutLat: null, checkOutLng: null,
    punches: dayPunches.map(punchToApi),
  });
});

router.post("/hr/attendance/check-out", requireModuleAction("page:/hr/attendance", "add"), async (req, res): Promise<void> => {
  const parsed = CheckOutBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  // Non-headoffice employees may only check out for themselves
  const scopeEmpCO = (req as any).employee as { id: number; branchType: string } | undefined;
  if (scopeEmpCO && scopeEmpCO.branchType !== 'headoffice' && parsed.data.employeeId !== scopeEmpCO.id) {
    res.status(403).json({ error: "You can only check out for yourself." });
    return;
  }
  const today = await businessTodayStr();
  // Month lock: a punch is a dated attendance record (it re-prices salary
  // accrual for that day), so it may not land in a locked accounting period.
  if (await respondIfMonthLocked(res, pool, [today], "attendance check-out")) return;
  let row: any;
  let dayPunchesOut: any[] = [];
  try {
    row = await withAttendanceWrite(parsed.data.employeeId, [today], async (q) => {
      // Close the open session if there is one. A day recorded before punches
      // existed has no punch rows at all — that legacy day keeps its old
      // behaviour exactly (the attendance row's check_out is simply updated).
      const { rows: [open] } = await q.query(
        `SELECT id FROM attendance_punches
          WHERE employee_id = $1 AND date = $2 AND punch_out IS NULL
          ORDER BY punch_in DESC LIMIT 1`,
        [parsed.data.employeeId, today],
      );
      if (open) {
        await q.query(
          `UPDATE attendance_punches SET punch_out = now(), out_lat = $2, out_lng = $3 WHERE id = $1`,
          [open.id, String(parsed.data.lat), String(parsed.data.lng)],
        );
      } else {
        const { rows: [hasPunches] } = await q.query(
          `SELECT 1 FROM attendance_punches WHERE employee_id = $1 AND date = $2 LIMIT 1`,
          [parsed.data.employeeId, today],
        );
        if (hasPunches) {
          // Every session today is already closed — checking out again without
          // checking in first would have nothing to price.
          throw Object.assign(new Error(
            "Already checked out — check in again to start a new session.",
          ), { conflict: true });
        }
      }
      const { rows: [r] } = await q.query(
        `UPDATE attendance
            SET check_out = now(), check_out_lat = $3, check_out_lng = $4
          WHERE employee_id = $1 AND date = $2
          RETURNING *`,
        [parsed.data.employeeId, today, String(parsed.data.lat), String(parsed.data.lng)],
      );
      if (!r) throw Object.assign(new Error("No check-in found for today"), { notFound: true });
      const { rows: ps } = await q.query(
        `SELECT * FROM attendance_punches WHERE employee_id = $1 AND date = $2 ORDER BY punch_in ASC`,
        [parsed.data.employeeId, today],
      );
      dayPunchesOut = ps;
      return r;
    });
  } catch (e: any) {
    if (e?.notFound) { res.status(404).json({ error: e.message }); return; }
    sendAttendanceWriteError(res, e, "check-out");
    return;
  }
  row = attendanceRowToApi(row);
  // Check-out is the moment the day stops being provisionally whole and is
  // priced on the hours actually worked, so the books have to be re-read here.
  await reaccrue(row.employeeId, "check-out");
  const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.id, row.employeeId)).limit(1);
  res.json({
    ...row, employeeName: emp?.name ?? "",
    checkIn: row.checkIn?.toISOString() ?? null, checkOut: row.checkOut?.toISOString() ?? null,
    checkInLat: row.checkInLat ? Number(row.checkInLat) : null,
    checkInLng: row.checkInLng ? Number(row.checkInLng) : null,
    checkOutLat: row.checkOutLat ? Number(row.checkOutLat) : null,
    checkOutLng: row.checkOutLng ? Number(row.checkOutLng) : null,
    punches: dayPunchesOut.map(punchToApi),
  });
});

// ── Leave ─────────────────────────────────────────────────────────────────
//
// Lifecycle: pending → approved | rejected | cancelled.
//
// A PENDING request has zero effect on attendance or pay. Only APPROVAL stamps
// the days as `leave` in the attendance table — which is the single source both
// the daily salary accrual and payroll generation read — so unapproved leave can
// never earn salary. Rejection and cancellation therefore have nothing to undo
// in the normal flow. (`approved_at` / `cancelled_at` are startup-migration
// columns invisible to drizzle, so every read and write here is raw SQL.)

/** Enriched leave row: employee, branch, role, approver — one query, no N+1. */
const LEAVE_SELECT = `
  SELECT l.id, l.employee_id AS "employeeId", e.name AS "employeeName",
         e.branch_type AS "branchType", e.branch_id AS "branchId",
         CASE e.branch_type
           WHEN 'headoffice' THEN 'Head Office'
           WHEN 'warehouse'  THEN COALESCE(w.name, 'Warehouse #' || e.branch_id)
           ELSE COALESCE(o.name, 'Outlet #' || e.branch_id)
         END AS "branchName",
         h.name AS "roleName",
         l.from_date AS "fromDate", l.to_date AS "toDate",
         l.leave_type AS "leaveType", l.reason, l.status,
         l.approved_by AS "approvedBy", ap.name AS "approverName",
         l.approval_note AS "approvalNote",
         l.approved_at AS "approvedAt", l.cancelled_at AS "cancelledAt",
         l.created_at AS "createdAt"
    FROM leaves l
    JOIN employees e ON e.id = l.employee_id
    LEFT JOIN hierarchies h ON h.id = e.hierarchy_id
    LEFT JOIN employees ap ON ap.id = l.approved_by
    LEFT JOIN warehouses w ON e.branch_type = 'warehouse' AND w.id = e.branch_id
    LEFT JOIN outlets   o ON e.branch_type = 'outlet'    AND o.id = e.branch_id`;

function leaveRowToApi(r: any) {
  const from = pgDateStr(r.fromDate), to = pgDateStr(r.toDate);
  let days = 0;
  if (/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
    const [fy, fm, fd] = from.split("-").map(Number);
    const [ty, tm, td] = to.split("-").map(Number);
    days = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000) + 1;
    if (days < 0) days = 0;
  }
  return {
    id: r.id, employeeId: r.employeeId, employeeName: r.employeeName ?? "",
    branchType: r.branchType ?? null, branchId: r.branchId ?? null,
    branchName: r.branchName ?? null, roleName: r.roleName ?? null,
    fromDate: from, toDate: to, days,
    leaveType: r.leaveType, reason: r.reason ?? null, status: r.status,
    approvedBy: r.approvedBy ?? null, approverName: r.approverName ?? null,
    approvalNote: r.approvalNote ?? null,
    approvedAt: r.approvedAt ? new Date(r.approvedAt).toISOString() : null,
    cancelledAt: r.cancelledAt ? new Date(r.cancelledAt).toISOString() : null,
    createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
  };
}

async function fetchLeaveById(id: number): Promise<any | null> {
  const { rows: [r] } = await pool.query(`${LEAVE_SELECT} WHERE l.id = $1`, [id]);
  return r ? leaveRowToApi(r) : null;
}

/** Inclusive YYYY-MM-DD list for a leave range. */
function leaveDateList(fromDate: string, toDate: string): string[] {
  const [fy, fm, fd] = fromDate.split("-").map(Number);
  const [ty, tm, td] = toDate.split("-").map(Number);
  const cur = new Date(Date.UTC(fy, fm - 1, fd));
  const end = new Date(Date.UTC(ty, tm - 1, td));
  const dates: string[] = [];
  while (cur <= end) {
    dates.push(cur.toISOString().split("T")[0]);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

router.get("/hr/leaves", requireModuleView("page:/hr/attendance"), async (req, res): Promise<void> => {
  const qp = ListLeavesQueryParams.safeParse(req.query);
  const where: string[] = [];
  const params: unknown[] = [];

  // Who sees what: Head Office sees everything. A non-HO caller who holds EDIT
  // on this page is an approver and sees their own location's requests (their
  // warehouse plus its outlets — the same scope every other HR read uses).
  // Anyone else sees only their own history. The distinction is the page
  // right, not the branch: a warehouse supervisor without Edit is an employee
  // here, not a reviewer of their colleagues' requests.
  const scopeEmp = (req as any).employee as
    { id: number; branchType: string; branchId: number; hierarchyId: number } | undefined;
  if (scopeEmp && scopeEmp.branchType !== "headoffice") {
    const approver = await hasModuleAction(scopeEmp.hierarchyId, "page:/hr/attendance", "edit");
    if (approver) {
      const scope = await getUserDataScope(scopeEmp);
      where.push(scopeBranchWhere(scope, params, "e"));
    } else {
      params.push(scopeEmp.id);
      where.push(`l.employee_id = $${params.length}`);
    }
  }

  if (qp.success) {
    const f = qp.data;
    if (f.employeeId) { params.push(Number(f.employeeId)); where.push(`l.employee_id = $${params.length}`); }
    if (f.status)     { params.push(f.status);             where.push(`l.status = $${params.length}`); }
    if (f.leaveType)  { params.push(f.leaveType);          where.push(`l.leave_type = $${params.length}`); }
    // The date window matches any request that OVERLAPS it, not only requests
    // fully inside it — a leave spanning the month boundary belongs to both
    // months' views. Partial/malformed dates are dropped, not passed to pg.
    if (f.fromDate && /^\d{4}-\d{2}-\d{2}$/.test(f.fromDate)) { params.push(f.fromDate); where.push(`l.to_date >= $${params.length}`); }
    if (f.toDate   && /^\d{4}-\d{2}-\d{2}$/.test(f.toDate))   { params.push(f.toDate);   where.push(`l.from_date <= $${params.length}`); }
    if (f.branchType) { params.push(f.branchType);       where.push(`e.branch_type = $${params.length}`); }
    if (f.branchId)   { params.push(Number(f.branchId)); where.push(`e.branch_id = $${params.length}`); }
  }

  // Global location context — only when the page didn't pass its own branch
  // filter. Leaves follow the employee's branch like every other HR read.
  if (!(qp.success && (qp.data.branchType || qp.data.branchId))) {
    const leaveViewLoc = getLocationFilter(req);
    if (leaveViewLoc) {
      params.push(leaveViewLoc.locationType);
      where.push(`e.branch_type = $${params.length}`);
      if (leaveViewLoc.locationType !== 'headoffice') {
        params.push(leaveViewLoc.locationId);
        where.push(`e.branch_id = $${params.length}`);
      }
    }
  }

  const { rows } = await pool.query(
    `${LEAVE_SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY l.id DESC`,
    params,
  );
  const paging = parsePaging(req.query as Record<string, unknown>);
  setPagingHeaders(res, rows.length, paging);
  res.json(applyPaging(rows, paging).map(leaveRowToApi));
});

router.post("/hr/leaves", requireModuleAction("page:/hr/attendance", "add"), async (req, res): Promise<void> => {
  const parsed = ApplyLeaveBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  // Security: non-headoffice employees may only apply leave for themselves
  const scopeEmp = (req as any).employee as { id: number; branchType: string; username?: string } | undefined;
  if (scopeEmp && scopeEmp.branchType !== 'headoffice' && parsed.data.employeeId !== scopeEmp.id) {
    res.status(403).json({ error: "You can only apply leave for yourself." });
    return;
  }

  const { fromDate, toDate, leaveType } = parsed.data;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    res.status(400).json({ error: "Dates must be in YYYY-MM-DD format." });
    return;
  }
  if (toDate < fromDate) {
    res.status(400).json({ error: "'To' date cannot be before 'From' date." });
    return;
  }

  const { rows: [emp] } = await pool.query(
    `SELECT id, name FROM employees WHERE id = $1`, [parsed.data.employeeId]);
  if (!emp) { res.status(400).json({ error: "Employee not found" }); return; }

  // A pending request deliberately touches NOTHING but the leaves table: no
  // attendance stamp, no accrual lock, no salary effect. Attendance flips to
  // `leave` only at approval — pay follows approval, never the application.
  const { rows: [ins] } = await pool.query(
    `INSERT INTO leaves (employee_id, from_date, to_date, leave_type, reason, status)
     VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING id`,
    [parsed.data.employeeId, fromDate, toDate, leaveType, parsed.data.reason ?? null],
  );
  logActivity({
    action: "CREATE", module: "hr", entityType: "leave", entityId: ins.id,
    description: `Leave request #${ins.id} applied for ${emp.name} (${fromDate} → ${toDate}, ${leaveType})`,
    user: scopeEmp?.username ?? undefined,
    metadata: { employeeId: parsed.data.employeeId, fromDate, toDate, leaveType, reason: parsed.data.reason ?? null },
  }).catch(() => {});

  res.status(201).json(await fetchLeaveById(ins.id));
});

router.post("/hr/leaves/:id/approve", requireModuleAction("page:/hr/attendance", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = ApproveLeaveBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const decision = parsed.data.status;
  const note = (parsed.data.note ?? "").trim();
  if (decision === "rejected" && !note) {
    res.status(400).json({ error: "A reason is required when rejecting a leave request." });
    return;
  }

  const { rows: [leave] } = await pool.query(
    `SELECT l.id, l.employee_id AS "employeeId", l.from_date AS "fromDate",
            l.to_date AS "toDate", l.status, l.leave_type AS "leaveType",
            e.name AS "employeeName", e.branch_type AS "branchType", e.branch_id AS "branchId"
       FROM leaves l JOIN employees e ON e.id = l.employee_id
      WHERE l.id = $1`, [id]);
  if (!leave) { res.status(404).json({ error: "Not found" }); return; }

  const approver = (req as any).employee as
    { id: number; username: string; branchType: string; branchId: number; hierarchyId: number } | undefined;
  if (!approver) { res.status(401).json({ error: "Authentication required" }); return; }

  // Location scope first (404, never 403 — existence is itself information):
  // a warehouse-scoped approver decides only their own location's requests.
  if (approver.branchType !== "headoffice") {
    const scope = await getUserDataScope(approver);
    if (!isLocationInScope(scope, leave.branchType, leave.branchId)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
  }

  // Nobody decides their own request — Head Office and level-1 roles included.
  if (approver.id === leave.employeeId) {
    res.status(403).json({ error: "You cannot approve or reject your own leave request." });
    return;
  }

  if (leave.status !== "pending") {
    res.status(409).json({ error: `Only pending requests can be decided — this one is already ${leave.status}.` });
    return;
  }

  const fromStr = pgDateStr(leave.fromDate);
  const toStr = pgDateStr(leave.toDate);
  const leaveDates = leaveDateList(fromStr, toStr);

  // Month lock: approving stamps the whole span as paid leave (a financial
  // write), so if ANY day of the span falls in a locked accounting period the
  // approval is refused. Rejection is a pure status flip that stamps nothing —
  // refusing it would strand the request as pending forever — so it is left to
  // proceed. respondIfMonthLocked dedups the span by month.
  if (decision === "approved" && await respondIfMonthLocked(res, pool, leaveDates, "leave approval")) return;

  if (decision === "approved") {
    // Approval is the moment leave becomes paid attendance, so it is a salary
    // write: it takes the per-employee accrual lock, re-checks that no month in
    // the range has been signed off, re-reads the request's status under the
    // lock (a concurrent decision loses, not overwrites), and stamps the days.
    // A day the employee actually checked in on keeps its worked record — the
    // stamp skips it rather than overwriting hours with a leave label.
    try {
      await withAttendanceWrite(leave.employeeId, leaveDates, async (q) => {
        const { rows: [upd] } = await q.query(
          `UPDATE leaves
              SET status = 'approved', approved_by = $2, approval_note = $3, approved_at = now()
            WHERE id = $1 AND status = 'pending'
            RETURNING id`,
          [id, approver.id, note || null],
        );
        if (!upd) {
          throw Object.assign(
            new Error("This request was already decided — reload to see its current state."),
            { conflict: true },
          );
        }
        // The stamp carries the leave TYPE so the pay formula can charge the
        // right allowance: sick requests consume the sick allowance, everything
        // else (casual/annual/other) consumes casual — the pre-split behaviour.
        const stampType = leave.leaveType === "sick" ? "sick" : "casual";
        for (const dateStr of leaveDates) {
          await q.query(
            `INSERT INTO attendance (employee_id, date, status, leave_type)
             VALUES ($1, $2, 'leave', $3)
             ON CONFLICT (employee_id, date) DO UPDATE
               SET status = 'leave', leave_type = $3
             WHERE attendance.check_in IS NULL`,
            [leave.employeeId, dateStr, stampType],
          );
        }
      });
    } catch (e: any) {
      sendAttendanceWriteError(res, e, "leave approval");
      return;
    }
  } else {
    // Rejection: in the approval-gated flow a pending request never stamped
    // attendance, so there is normally nothing to undo — deliberately NOT
    // withAttendanceWrite, so a request touching an already signed-off month
    // can still be rejected (refusing that would strand it as pending forever).
    // The DELETE is a safety net for legacy stamps that predate approval
    // gating: only days the old apply-time sync itself created — `leave` with
    // no check-in, no punches, not covered by an approved leave, and not in a
    // signed-off payroll month — are taken back.
    try {
      await withEmployeeAccrualLock(pool, leave.employeeId, async (q) => {
        const { rows: [upd] } = await q.query(
          `UPDATE leaves
              SET status = 'rejected', approved_by = $2, approval_note = $3, approved_at = now()
            WHERE id = $1 AND status = 'pending'
            RETURNING id`,
          [id, approver.id, note],
        );
        if (!upd) {
          throw Object.assign(
            new Error("This request was already decided — reload to see its current state."),
            { conflict: true },
          );
        }
        await q.query(
          `DELETE FROM attendance a
            WHERE a.employee_id = $1 AND a.date BETWEEN $2 AND $3
              AND a.status = 'leave' AND a.check_in IS NULL
              AND NOT EXISTS (SELECT 1 FROM attendance_punches p
                               WHERE p.employee_id = a.employee_id AND p.date = a.date)
              AND NOT EXISTS (SELECT 1 FROM leaves al
                               WHERE al.status = 'approved' AND al.id <> $4
                                 AND al.employee_id = a.employee_id
                                 AND a.date BETWEEN al.from_date AND al.to_date)
              AND NOT EXISTS (SELECT 1 FROM payroll pr
                               WHERE pr.employee_id = a.employee_id
                                 AND pr.year  = EXTRACT(YEAR  FROM a.date)::int
                                 AND pr.month = EXTRACT(MONTH FROM a.date)::int
                                 AND pr.status IN ('approved','paid'))
              AND NOT EXISTS (SELECT 1 FROM accounting_period_locks apl
                               WHERE apl.year  = EXTRACT(YEAR  FROM a.date)::int
                                 AND apl.month = EXTRACT(MONTH FROM a.date)::int)`,
          [leave.employeeId, fromStr, toStr, id],
        );
      });
    } catch (e: any) {
      sendAttendanceWriteError(res, e, "leave rejection");
      return;
    }
  }

  // Re-price the employee's open accruals now that attendance moved (approval)
  // or a legacy stamp came off (rejection). Reads attendance under its own
  // accrual lock, so it prices exactly what was committed above.
  await reaccrue(leave.employeeId, `leave ${decision}`);

  logActivity({
    action: "UPDATE", module: "hr", entityType: "leave", entityId: id,
    description: `Leave request #${id} ${decision} for ${leave.employeeName} (${fromStr} → ${toStr})`
      + (decision === "rejected" ? ` — reason: ${note}` : ""),
    user: approver.username,
    metadata: { employeeId: leave.employeeId, decision, note: note || null, fromDate: fromStr, toDate: toStr },
  }).catch(() => {});

  res.json(await fetchLeaveById(id));
});

router.post("/hr/leaves/:id/cancel", requireModuleView("page:/hr/attendance"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const caller = (req as any).employee as { id: number; username: string } | undefined;
  if (!caller) { res.status(401).json({ error: "Authentication required" }); return; }

  const { rows: [leave] } = await pool.query(
    `SELECT l.id, l.employee_id AS "employeeId", l.status,
            l.from_date AS "fromDate", l.to_date AS "toDate", e.name AS "employeeName"
       FROM leaves l JOIN employees e ON e.id = l.employee_id
      WHERE l.id = $1`, [id]);
  if (!leave) { res.status(404).json({ error: "Not found" }); return; }

  // Cancellation belongs to the requester alone — approvers withdraw someone
  // else's request by rejecting it with a reason, which records who and why.
  if (caller.id !== leave.employeeId) {
    res.status(403).json({ error: "You can only cancel your own leave requests." });
    return;
  }
  if (leave.status !== "pending") {
    res.status(409).json({ error: `Only pending requests can be cancelled — this one is ${leave.status}.` });
    return;
  }

  // Month lock: a leave whose span touches a locked accounting period is frozen
  // in every direction, so it can neither be approved nor cancelled while the
  // month stays locked.
  const cancelDates = leaveDateList(pgDateStr(leave.fromDate), pgDateStr(leave.toDate));
  if (await respondIfMonthLocked(res, pool, cancelDates, "leave cancel")) return;

  // A pending request never touched attendance, so cancelling is a pure status
  // flip; the WHERE guards against a decision that landed since the read above.
  const { rows: [upd] } = await pool.query(
    `UPDATE leaves SET status = 'cancelled', cancelled_at = now()
      WHERE id = $1 AND status = 'pending' RETURNING id`, [id]);
  if (!upd) {
    res.status(409).json({ error: "This request was just decided by an approver — reload to see its current state." });
    return;
  }

  logActivity({
    action: "UPDATE", module: "hr", entityType: "leave", entityId: id,
    description: `Leave request #${id} cancelled by ${leave.employeeName} (${pgDateStr(leave.fromDate)} → ${pgDateStr(leave.toDate)})`,
    user: caller.username,
    metadata: { employeeId: leave.employeeId, fromDate: pgDateStr(leave.fromDate), toDate: pgDateStr(leave.toDate) },
  }).catch(() => {});

  res.json(await fetchLeaveById(id));
});

// ── Attendance correction ─────────────────────────────────────────────────
//
// Attendance now decides what a day of salary is worth, so a mistake in it is a
// mistake in the books. Before this route there was no way to fix one: rows were
// only ever created by check-in or by the leave sync, and nothing could edit
// them. A manager who marked the wrong person present had no remedy.
//
// It upserts on (employee, date) rather than taking a row id, because the most
// common correction — absent to present — has no row to address: an absent day
// is synthesised for display and was never stored.
router.put("/hr/attendance", requireModuleAction("page:/hr/attendance", "edit"), async (req, res): Promise<void> => {
  // Correcting attendance moves money, so it is a Head Office action. The
  // check-in routes let an employee record their own day; this one must not,
  // or anyone could award themselves a full day's pay for a day they missed.
  if ((req as any).employee?.branchType !== "headoffice") {
    res.status(403).json({ error: "Only Head Office can correct attendance." });
    return;
  }

  const employeeId = Number((req.body as any)?.employeeId);
  const date = String((req.body as any)?.date ?? "").slice(0, 10);
  const status = String((req.body as any)?.status ?? "");
  const VALID = ["present", "half_day", "absent", "leave", "company_holiday", "weekly_off"];
  if (!Number.isInteger(employeeId) || employeeId <= 0) {
    res.status(400).json({ error: "employeeId is required" }); return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "date must be YYYY-MM-DD" }); return;
  }
  if (!VALID.includes(status)) {
    res.status(400).json({ error: `status must be one of ${VALID.join(", ")}` }); return;
  }
  // Leave now has a type — sick draws on the sick allowance, casual on the
  // casual one. Only meaningful with status 'leave'; stored NULL otherwise.
  const leaveTypeRaw = (req.body as any)?.leaveType;
  const leaveType = status === "leave"
    ? (leaveTypeRaw === "sick" ? "sick" : "casual")
    : null;
  const force = (req.body as any)?.force === true;

  const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.id, employeeId)).limit(1);
  if (!emp) { res.status(404).json({ error: "Employee not found" }); return; }

  // Month lock: a correction re-prices the salary accrual for `date`, so it may
  // not touch a locked accounting period.
  if (await respondIfMonthLocked(res, pool, [date], "attendance correction")) return;

  // Casual-leave-deducting weekly off with the month's casual allowance already
  // exhausted: what happens is the company's choice. 'ask' makes the manager
  // confirm the unpaid day (409, resubmit with force); 'absent' converts the
  // day outright — the setting IS the answer, so force does not bypass it.
  // The check guards the EFFECTIVE stored status, and it is advisory for pay
  // (raced saves are still priced correctly), so it sits outside the write lock.
  let effectiveStatus = status;
  if (status === "weekly_off") {
    const { policy, thresholds } = await loadPayrollSettings(pool);
    const rule = calendarDayInfo(date, policy, new Set()).weeklyOff;
    const gateApplies = rule?.policy === "casual_leave"
      && (policy.weeklyOffExhaustedAction === "absent" || !force);
    if (gateApplies) {
      const [yy, mm] = date.split("-").map(Number);
      const mFirst = `${yy}-${String(mm).padStart(2, "0")}-01`;
      const mLast = `${yy}-${String(mm).padStart(2, "0")}-${String(new Date(yy, mm, 0).getDate()).padStart(2, "0")}`;
      const { rows: monthRows } = await pool.query(
        `SELECT a.date, a.status, a.leave_type AS "leaveType",
                a.check_in AS "checkIn", a.check_out AS "checkOut",
                ap.punched_hours AS "punchedHours"
           FROM attendance a
           ${PUNCHED_HOURS_JOIN("a")}
          WHERE a.employee_id = $1 AND a.date >= $2 AND a.date <= $3 AND a.date <> $4`,
        [employeeId, mFirst, mLast, date],
      );
      const proposed = [...monthRows, { date, status: "weekly_off" }];
      const summary = monthLeaveSummary(proposed, policy, thresholds, {
        year: yy, month: mm, holidays: await loadHolidaySet(pool, mFirst, mLast),
      });
      if (summary.leaveTaken > policy.paidCasualLeavesPerMonth) {
        if (policy.weeklyOffExhaustedAction === "absent") {
          effectiveStatus = "absent";
        } else {
          res.status(409).json({
            code: "CASUAL_LEAVE_EXHAUSTED",
            error: `${emp.name} has no casual leave left this month — this weekly off will be unpaid (loss of pay). Save anyway to confirm.`,
          });
          return;
        }
      }
    }
  }

  // Explicit hours win over the status label when supplied, because that is what
  // the day is priced on. Clearing them (null) drops the day back to being
  // judged on its status alone.
  const hasCheckIn = "checkIn" in (req.body as any);
  const hasCheckOut = "checkOut" in (req.body as any);
  const checkIn = hasCheckIn && (req.body as any).checkIn ? new Date((req.body as any).checkIn) : null;
  const checkOut = hasCheckOut && (req.body as any).checkOut ? new Date((req.body as any).checkOut) : null;
  if ((checkIn && isNaN(checkIn.getTime())) || (checkOut && isNaN(checkOut.getTime()))) {
    res.status(400).json({ error: "checkIn/checkOut must be valid timestamps" }); return;
  }

  // The signed-off-month check lives inside the lock, not before it: an approval
  // committing between check and write would otherwise leave this correction
  // stranded in a month that is now closed.
  let saved: any;
  try {
    saved = await withAttendanceWrite(employeeId, [date], async (q) => {
      const { rows: [r] } = await q.query(
        `INSERT INTO attendance (employee_id, date, status, leave_type, check_in, check_out)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (employee_id, date) DO UPDATE
            SET status     = EXCLUDED.status,
                leave_type = EXCLUDED.leave_type,
                check_in   = CASE WHEN $7 THEN EXCLUDED.check_in  ELSE attendance.check_in  END,
                check_out  = CASE WHEN $8 THEN EXCLUDED.check_out ELSE attendance.check_out END
         RETURNING id, employee_id, date, status, leave_type, check_in, check_out`,
        [employeeId, date, effectiveStatus, leaveType, checkIn, checkOut, hasCheckIn, hasCheckOut],
      );
      // A correction that sets the day's times explicitly is the new truth for
      // its hours, so the punch detail must follow: multi-punch days are priced
      // on total punched hours, and leaving old punches behind would silently
      // outvote the times the manager just set. The corrected day becomes one
      // session — or none, when the times were cleared. Status-only corrections
      // leave punches alone (recorded hours keep winning over the label, which
      // is this endpoint's long-standing contract).
      if (hasCheckIn || hasCheckOut) {
        await q.query(
          `DELETE FROM attendance_punches WHERE employee_id = $1 AND date = $2`,
          [employeeId, date],
        );
        if (r?.check_in && r?.check_out) {
          await q.query(
            `INSERT INTO attendance_punches (employee_id, date, punch_in, punch_out)
             VALUES ($1, $2, $3, $4)`,
            [employeeId, date, r.check_in, r.check_out],
          );
        }
      }
      return r;
    });
  } catch (e: any) {
    sendAttendanceWriteError(res, e, "attendance correction");
    return;
  }

  await reaccrue(employeeId, "attendance correction");

  logActivity({
    action: "UPDATE", module: "hr", entityType: "attendance", entityId: Number(saved?.id ?? 0),
    user: (req as any).employee?.username ?? "system",
    description: `Attendance corrected for ${emp.name} on ${date} → ${effectiveStatus}${leaveType ? ` (${leaveType})` : ""}${effectiveStatus !== status ? ` (requested ${status}; converted — casual leave exhausted)` : ""}`,
    metadata: { employeeId, date, status: effectiveStatus, requestedStatus: status, leaveType, checkIn, checkOut },
  }).catch(() => {});

  res.json({
    ...saved,
    employeeId: Number(saved?.employee_id),
    employeeName: emp.name,
    date,
    leaveType: saved?.leave_type ?? null,
    checkIn: saved?.check_in ? new Date(saved.check_in).toISOString() : null,
    checkOut: saved?.check_out ? new Date(saved.check_out).toISOString() : null,
  });
});

// ── Password Reset (admin action) ─────────────────────────────────────────────
router.post("/hr/employees/:id/reset-password", requireModuleAction("page:/hr/employees", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid employee id" }); return; }

  // Scope the lookup exactly like GET /hr/employees does. The edit right alone
  // is not enough: without this, a warehouse or outlet manager who may edit
  // their own team could reset a Head Office password — admin's included — by
  // POSTing an id they were never shown. Out-of-scope reads as "not found", so
  // the endpoint cannot be used to probe which ids exist.
  const scopeEmp = (req as any).employee as { branchType: string; branchId: number } | undefined;
  const lookupParams: unknown[] = [id];
  let scopeCond = 'TRUE';
  if (scopeEmp && scopeEmp.branchType !== 'headoffice') {
    const scope = await getUserDataScope(scopeEmp);
    scopeCond = scopeBranchWhere(scope, lookupParams, 'e');
  }
  const { rows: [emp] } = await pool.query(
    `SELECT e.id, e.name, e.username FROM employees e WHERE e.id = $1 AND ${scopeCond}`,
    lookupParams,
  );
  if (!emp) { res.status(404).json({ error: "Employee not found" }); return; }

  // must_change_password is cleared on purpose: the employee can sign in with
  // the reset password straight away and change it from Settings only if they
  // want to. See ADMIN_RESET_PASSWORD for why this is a deliberate trade-off.
  const newHash = await PasswordService.hash(ADMIN_RESET_PASSWORD);
  await pool.query(
    `UPDATE employees SET password_hash = $1, must_change_password = false WHERE id = $2`,
    [newHash, id],
  );

  // "Sign-in restored" must mean exactly that: an admin reset also clears any
  // active brute-force lockout, otherwise the employee stays 429-locked for up
  // to 15 minutes with a password the admin just handed them.
  await clearLoginFailures(emp.username);

  logActivity({
    action: "UPDATE", module: "hr", entityType: "employee", entityId: id,
    description: `PASSWORD_RESET for employee ${emp.name} (${emp.username}) — sign-in restored, no forced change`,
    user: (req as any).employee?.username ?? "admin",
  }).catch(() => {});

  // The password travels back so the screen shows exactly what the server set.
  // It is a server-owned constant; duplicating it in the client would let the
  // two drift and start telling employees the wrong thing.
  res.json({
    success: true,
    username: emp.username,
    password: ADMIN_RESET_PASSWORD,
    message: `Password reset. ${emp.name} can sign in as "${emp.username}" with ${ADMIN_RESET_PASSWORD}.`,
  });
});

export default router;
