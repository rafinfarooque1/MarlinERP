import { disabledWarehouseError, WAREHOUSE_DISABLED_CODE } from "../lib/warehouseLifecycle";
import { Router, type IRouter, type Response } from "express";
import { pool } from "@workspace/db";
import { requireModuleView, requireModuleAction } from "../middleware/permissions";
import { getUserDataScope, type DataScope } from "../lib/dataScope";
import { nextVoucherNumber } from "../lib/voucherNumber";
import { logActivity } from "../lib/audit";
import { isIsoDate } from "../lib/dateInput";
import {
  runRentAccrual, runRentAccrualLocked, isPeriodAccrualComplete, rentMonthCoverage,
  recalcUnapprovedRentAccrualsLocked, withWarehouseRentLock, rentAccrualTermsChanged, dailyRentRate,
} from "../lib/rentAccrual";
import { provisionRentLedgers } from "../lib/rentLedgers";
import { assertMonthOpen, handlePeriodLocked, respondIfMonthLocked } from "../lib/periodLock";

const router: IRouter = Router();
const PERM = "page:/hr/rent";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v: unknown) => Number(v ?? 0);

/** pg returns a JS Date for `date` columns; the API speaks YYYY-MM-DD strings. */
function ymd(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) {
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, "0")}-${String(v.getUTCDate()).padStart(2, "0")}`;
  }
  return String(v).slice(0, 10);
}
const today = () => ymd(new Date())!;
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Rejects an impossible from/to before it reaches a DATE comparison (22007). */
function badDateRange(q: Record<string, string | undefined>, res: Response): boolean {
  if ((q.from && !isIsoDate(q.from)) || (q.to && !isIsoDate(q.to))) {
    res.status(400).json({ error: "from/to must be real calendar dates in YYYY-MM-DD form" });
    return true;
  }
  return false;
}

/**
 * Rent is a warehouse-level record, so scope reduces to the warehouse list.
 * An outlet user has no warehouses in scope and therefore sees nothing — which
 * is the intended answer, not a bug: rent is not an outlet concern.
 */
function scopeWhere(scope: DataScope, params: unknown[], col: string): string {
  if (scope.isHeadOffice) return "TRUE";
  if (scope.warehouseIds.length === 0) return "FALSE";
  params.push(scope.warehouseIds);
  return `${col} = ANY($${params.length}::int[])`;
}

/**
 * Setting rent terms, approving and paying are all head-office actions; a
 * warehouse may only look. `what` names the attempted action so the refusal
 * reads true on every route — a user editing an agreement should not be told
 * something about approving or paying.
 */
function requireHeadOffice(scope: DataScope, res: any, what = "approve or pay rent"): boolean {
  if (scope.isHeadOffice) return true;
  res.status(403).json({ error: `Only Head Office can ${what}.` });
  return false;
}

/**
 * Payment deadline for a rent month, clamped to months shorter than the due day.
 *
 * The deadline falls on the due day of the FOLLOWING month, because a month's
 * rent cannot be approved until it has finished accruing. Dating it inside its
 * own month would mark every month overdue while it was still accruing — July
 * rent would read "overdue" on 29 July even though nobody is yet allowed to
 * approve, let alone pay it.
 */
function dueDateFor(year: number, month: number, dueDay: number): string {
  const y = month === 12 ? year + 1 : year;
  const m = month === 12 ? 1 : month + 1;
  const d = Math.min(Math.max(1, dueDay || 5), daysInMonth(y, m));
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rent master
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every warehouse appears here, with or without an agreement — the estate list
 * and the rent list are the same list, so a newly built warehouse cannot be
 * silently missing from rent reporting.
 */
/**
 * One shape for an agreement, shared by the list and the edit response.
 *
 * The edit handler used to return the raw UPDATE row, which is snake_case and
 * carries none of the accrued/paid aggregates — so the client silently read
 * `undefined` for half the record right after saving it. Both paths now go
 * through this loader so the two can never describe the same row differently.
 */
async function loadAgreements(where: string, params: unknown[]) {
  const { rows } = await pool.query(
    `SELECT w.id AS warehouse_id, w.name AS warehouse_name,
            a.id, a.monthly_rent, a.security_deposit, a.agreement_number,
            a.landlord_name, a.landlord_phone, a.landlord_email, a.landlord_address,
            a.start_date, a.end_date, a.due_day, a.status, a.inactive_from,
            a.expense_ledger_id, a.payable_ledger_id,
            le.name AS expense_ledger_name, lp.name AS payable_ledger_name,
            COALESCE(acc.total, 0)  AS total_accrued,
            COALESCE(pay.total, 0)  AS total_paid
       FROM warehouses w
       LEFT JOIN warehouse_rent_agreements a ON a.warehouse_id = w.id
       LEFT JOIN account_ledgers le ON le.id = a.expense_ledger_id
       LEFT JOIN account_ledgers lp ON lp.id = a.payable_ledger_id
       LEFT JOIN (SELECT warehouse_id, SUM(amount) AS total FROM rent_accruals GROUP BY warehouse_id) acc
              ON acc.warehouse_id = w.id
       LEFT JOIN (SELECT warehouse_id, SUM(amount) AS total FROM rent_payments GROUP BY warehouse_id) pay
              ON pay.warehouse_id = w.id
      WHERE ${where}
      ORDER BY w.name`,
    params,
  );

  return rows.map((r) => ({
    id: r.id,
    warehouseId: r.warehouse_id,
    warehouseName: r.warehouse_name,
    monthlyRent: num(r.monthly_rent),
    securityDeposit: num(r.security_deposit),
    agreementNumber: r.agreement_number ?? "",
    landlordName: r.landlord_name ?? "",
    landlordPhone: r.landlord_phone ?? "",
    landlordEmail: r.landlord_email ?? "",
    landlordAddress: r.landlord_address ?? "",
    startDate: ymd(r.start_date),
    endDate: ymd(r.end_date),
    dueDay: Number(r.due_day ?? 5),
    status: r.status ?? "inactive",
    inactiveFrom: ymd(r.inactive_from),
    expenseLedgerId: r.expense_ledger_id,
    payableLedgerId: r.payable_ledger_id,
    expenseLedgerName: r.expense_ledger_name ?? "",
    payableLedgerName: r.payable_ledger_name ?? "",
    totalAccrued: round2(num(r.total_accrued)),
    totalPaid: round2(num(r.total_paid)),
    totalOutstanding: round2(num(r.total_accrued) - num(r.total_paid)),
  }));
}

router.get("/rent/agreements", requireModuleView(PERM), async (req, res): Promise<void> => {
  const scope = await getUserDataScope(req.employee!);
  const params: unknown[] = [];
  const where = scopeWhere(scope, params, "w.id");
  res.json(await loadAgreements(where, params));
});

/**
 * Edit the agreement. Deactivating stamps `inactive_from` so accrual stops from
 * that date forward while every historical accrual, approval and payment stays
 * exactly where it was.
 */
router.patch("/rent/agreements/:warehouseId", requireModuleAction(PERM, "edit"), async (req, res): Promise<void> => {
  const warehouseId = parseInt(req.params.warehouseId, 10);
  const scope = await getUserDataScope(req.employee!);
  // Rent terms are a Head Office concern, not a warehouse one. Scope alone is
  // not enough here: it would let a warehouse user set the rent charged against
  // their own warehouse, which lands straight in the P&L as expense they chose.
  if (!requireHeadOffice(scope, res, "change rent terms")) return;

  const b = (req.body ?? {}) as Record<string, any>;
  const parseDateField = (value: unknown, label: string): string | null => {
    if (value == null || value === "") return null;
    const date = String(value).trim();
    if (!isIsoDate(date)) throw Object.assign(new Error(`${label} must be a real calendar date in YYYY-MM-DD form.`), { httpStatus: 400 });
    return date;
  };

  let outcome: {
    warehouseName: string;
    before: any;
    saved: any;
    monthlyRent: number;
    status: string;
    reason: string;
    recalc: Awaited<ReturnType<typeof recalcUnapprovedRentAccrualsLocked>> | null;
  };
  try {
    outcome = await withWarehouseRentLock(pool, warehouseId, async (q) => {
      const { rows: [wh] } = await q.query<{ name: string }>(
        `SELECT name FROM warehouses WHERE id = $1`, [warehouseId],
      );
      if (!wh) throw Object.assign(new Error("Warehouse not found"), { httpStatus: 404 });

      await q.query(
        `INSERT INTO warehouse_rent_agreements (warehouse_id) VALUES ($1)
         ON CONFLICT (warehouse_id) DO NOTHING`,
        [warehouseId],
      );
      const { rows: [before] } = await q.query(
        `SELECT * FROM warehouse_rent_agreements WHERE warehouse_id = $1 FOR UPDATE`,
        [warehouseId],
      );
      if (!before) throw new Error("Rent agreement could not be loaded.");

      const monthlyRent = b.monthlyRent !== undefined ? Number(b.monthlyRent) : num(before.monthly_rent);
      if (!Number.isFinite(monthlyRent) || monthlyRent < 0) {
        throw Object.assign(new Error("Monthly rent must be zero or a positive amount."), { httpStatus: 400 });
      }
      const dueDay = b.dueDay !== undefined ? Number(b.dueDay) : Number(before.due_day ?? 5);
      if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) {
        throw Object.assign(new Error("Payment due day must be a day of the month (1–31)."), { httpStatus: 400 });
      }

      const startDate = b.startDate !== undefined ? parseDateField(b.startDate, "Agreement start date") : ymd(before.start_date);
      const endDate = b.endDate !== undefined ? parseDateField(b.endDate, "Agreement end date") : ymd(before.end_date);
      if (startDate && endDate && endDate < startDate) {
        throw Object.assign(new Error("Agreement end date cannot be before the start date."), { httpStatus: 400 });
      }

      const status = b.status !== undefined ? String(b.status) : String(before.status);
      if (!["active", "inactive"].includes(status)) {
        throw Object.assign(new Error("Status must be active or inactive."), { httpStatus: 400 });
      }
      if (status === "active" && !startDate) {
        throw Object.assign(new Error("Set an agreement start date before activating rent."), { httpStatus: 400 });
      }
      if (status === "active" && monthlyRent <= 0) {
        throw Object.assign(new Error("Set a monthly rent amount before activating rent."), { httpStatus: 400 });
      }

      let inactiveFrom = ymd(before.inactive_from);
      if (status === "active") {
        inactiveFrom = null;
      } else if (b.inactiveFrom !== undefined) {
        inactiveFrom = parseDateField(b.inactiveFrom, "Inactive date");
      } else if (before.status === "active") {
        inactiveFrom = today();
      }

      const { rows: [saved] } = await q.query(
        `UPDATE warehouse_rent_agreements SET
           monthly_rent = $1, security_deposit = $2, agreement_number = $3,
           landlord_name = $4, landlord_phone = $5, landlord_email = $6, landlord_address = $7,
           start_date = $8, end_date = $9, due_day = $10, status = $11, inactive_from = $12,
           updated_at = NOW()
         WHERE warehouse_id = $13 RETURNING *`,
        [
          monthlyRent,
          b.securityDeposit !== undefined ? Number(b.securityDeposit) : num(before.security_deposit),
          b.agreementNumber !== undefined ? String(b.agreementNumber) : before.agreement_number,
          b.landlordName    !== undefined ? String(b.landlordName)    : before.landlord_name,
          b.landlordPhone   !== undefined ? String(b.landlordPhone)   : before.landlord_phone,
          b.landlordEmail   !== undefined ? String(b.landlordEmail)   : before.landlord_email,
          b.landlordAddress !== undefined ? String(b.landlordAddress) : before.landlord_address,
          startDate, endDate, dueDay, status, inactiveFrom, warehouseId,
        ],
      );
      if (!saved) throw new Error("Rent agreement could not be saved.");

      // Keep ledger creation/linking in this transaction too: a later rebuild
      // failure must roll back every part of this agreement edit.
      await provisionRentLedgers(q as unknown as typeof pool, warehouseId, wh.name);

      const reason = typeof b.revisionReason === "string" ? b.revisionReason.trim().slice(0, 500) : "";
      const accrualChanged = rentAccrualTermsChanged(before, saved);
      const recalc = accrualChanged
        ? await recalcUnapprovedRentAccrualsLocked(q, warehouseId)
        : null;
      if (!accrualChanged && status === "active") {
        await runRentAccrualLocked(q, warehouseId);
      }

      return { warehouseName: wh.name, before, saved, monthlyRent, status, reason, recalc };
    });
  } catch (e: any) {
    if (e?.httpStatus) { res.status(e.httpStatus).json({ error: e.message }); return; }
    console.error("[rent] agreement update/recalculation failed; transaction rolled back:", e);
    res.status(500).json({ error: "Rent agreement could not be saved. No agreement or accrual changes were committed." });
    return;
  }

  if (outcome.recalc) {
    const { recalc, before, saved, warehouseName, monthlyRent, reason } = outcome;
    const now = new Date();
    const basis = recalc.monthsRecalculated[0]
      ?? { year: now.getFullYear(), month: now.getMonth() + 1 };
    const asLabel = (m: { year: number; month: number }) => `${String(m.month).padStart(2, "0")}/${m.year}`;
    const months = recalc.monthsRecalculated.map(asLabel);

    logActivity({
      action: "UPDATE", module: "rent", entityType: "rent_accrual", entityId: warehouseId,
      user: req.employee?.username ?? "system",
      description:
        `Rent terms revised for ${warehouseName} — ₹${num(before.monthly_rent).toLocaleString("en-IN")} → ₹${monthlyRent.toLocaleString("en-IN")}/month; `
        + `${recalc.entriesReversed} daily accrual entr${recalc.entriesReversed === 1 ? "y" : "ies"} reversed, `
        + `${recalc.entriesRegenerated} regenerated`
        + (months.length ? ` for ${months.join(", ")}` : " (nothing accrued yet)")
        + (reason ? ` — reason: ${reason}` : ""),
      metadata: {
        warehouseId, warehouseName,
        previousAmount: num(before.monthly_rent), newAmount: monthlyRent,
        previousDailyAccrual: dailyRentRate(num(before.monthly_rent), basis.year, basis.month),
        newDailyAccrual: dailyRentRate(monthlyRent, basis.year, basis.month),
        dailyRateBasisMonth: asLabel(basis),
        previousStartDate: ymd(before.start_date), newStartDate: ymd(saved.start_date),
        previousEndDate: ymd(before.end_date), newEndDate: ymd(saved.end_date),
        previousStatus: before.status, newStatus: saved.status,
        previousInactiveFrom: ymd(before.inactive_from), newInactiveFrom: ymd(saved.inactive_from),
        reason: reason || null,
        monthsRecalculated: months,
        entriesReversed: recalc.entriesReversed,
        entriesRegenerated: recalc.entriesRegenerated,
        previousAccruedTotal: recalc.previousTotal,
        newAccruedTotal: recalc.newTotal,
        revisedBy: req.employee?.username ?? "system",
        revisedAt: now.toISOString(),
      },
    });
  }

  logActivity({
    action: "UPDATE", module: "rent", entityType: "rent_agreement", entityId: warehouseId,
    description: `Rent agreement updated for ${outcome.warehouseName} — ₹${outcome.monthlyRent.toLocaleString("en-IN")}/month, ${outcome.status}`,
    user: req.employee?.username ?? "system",
    metadata: {
      before: { monthlyRent: num(outcome.before.monthly_rent), status: outcome.before.status },
      after: { monthlyRent: outcome.monthlyRent, status: outcome.status },
    },
  });

  const [fresh] = await loadAgreements("w.id = $1", [warehouseId]);
  res.json(fresh);
});

// ─────────────────────────────────────────────────────────────────────────────
// Accruals — the Rent Register
// ─────────────────────────────────────────────────────────────────────────────

router.get("/rent/accruals", requireModuleView(PERM), async (req, res): Promise<void> => {
  const scope = await getUserDataScope(req.employee!);
  const params: unknown[] = [];
  const conds = [scopeWhere(scope, params, "r.warehouse_id")];

  const q = req.query as Record<string, string | undefined>;
  if (badDateRange(q, res)) return;
  if (q.warehouseId) { params.push(Number(q.warehouseId)); conds.push(`r.warehouse_id = $${params.length}`); }
  if (q.from)        { params.push(q.from);                conds.push(`r.accrual_date >= $${params.length}`); }
  if (q.to)          { params.push(q.to);                  conds.push(`r.accrual_date <= $${params.length}`); }
  if (q.year)        { params.push(Number(q.year));        conds.push(`r.year = $${params.length}`); }
  if (q.month)       { params.push(Number(q.month));       conds.push(`r.month = $${params.length}`); }

  const { rows } = await pool.query(
    `SELECT r.*, w.name AS warehouse_name
       FROM rent_accruals r JOIN warehouses w ON w.id = r.warehouse_id
      WHERE ${conds.join(" AND ")}
      ORDER BY r.accrual_date DESC, w.name`,
    params,
  );

  res.json(rows.map((r) => ({
    id: r.id,
    warehouseId: r.warehouse_id,
    warehouseName: r.warehouse_name,
    accrualDate: ymd(r.accrual_date),
    year: r.year,
    month: r.month,
    amount: round2(num(r.amount)),
    monthlyRent: round2(num(r.monthly_rent)),
    daysInMonth: r.days_in_month,
  })));
});

/** Manual catch-up. The scheduler runs this hourly; this is the "run it now" door. */
router.post("/rent/accrue", requireModuleAction(PERM, "edit"), async (req, res): Promise<void> => {
  const scope = await getUserDataScope(req.employee!);
  if (!requireHeadOffice(scope, res)) return;
  const result = await runRentAccrual(pool);
  logActivity({
    action: "CREATE", module: "rent", entityType: "rent_accrual", entityId: 0,
    description: `Rent accrual run — ${result.daysAccrued} day(s) across ${result.warehousesTouched} warehouse(s), ₹${result.totalAmount.toLocaleString("en-IN")}`,
    user: req.employee?.username ?? "system", metadata: { ...result },
  });
  res.json(result);
});

// ─────────────────────────────────────────────────────────────────────────────
// Periods — approval and payment
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One row per warehouse-month that has accrued anything, with the money split
 * three ways: accrued (what the P&L has taken), paid, and the difference still
 * owed. Outstanding is derived, never stored, so a partial payment or a late
 * accrual cannot leave a stale balance behind.
 */
router.get("/rent/periods", requireModuleView(PERM), async (req, res): Promise<void> => {
  const scope = await getUserDataScope(req.employee!);
  const params: unknown[] = [];
  const conds = [scopeWhere(scope, params, "acc.warehouse_id")];

  const q = req.query as Record<string, string | undefined>;
  if (q.warehouseId) { params.push(Number(q.warehouseId)); conds.push(`acc.warehouse_id = $${params.length}`); }
  if (q.year)        { params.push(Number(q.year));        conds.push(`acc.year = $${params.length}`); }
  if (q.month)       { params.push(Number(q.month));       conds.push(`acc.month = $${params.length}`); }

  const { rows } = await pool.query(
    `SELECT acc.warehouse_id, acc.year, acc.month,
            w.name AS warehouse_name,
            SUM(acc.amount) AS accrued,
            MAX(acc.days_in_month) AS days_in_month,
            COUNT(*) AS days_accrued,
            COALESCE(p.status, 'pending') AS status,
            p.approved_at, p.approved_by,
            COALESCE(a.due_day, 5) AS due_day,
            COALESCE(pay.total, 0) AS paid
       FROM rent_accruals acc
       JOIN warehouses w ON w.id = acc.warehouse_id
       LEFT JOIN rent_periods p ON p.warehouse_id = acc.warehouse_id AND p.year = acc.year AND p.month = acc.month
       LEFT JOIN warehouse_rent_agreements a ON a.warehouse_id = acc.warehouse_id
       LEFT JOIN (SELECT warehouse_id, year, month, SUM(amount) AS total FROM rent_payments
                   GROUP BY warehouse_id, year, month) pay
              ON pay.warehouse_id = acc.warehouse_id AND pay.year = acc.year AND pay.month = acc.month
      WHERE ${conds.join(" AND ")}
      GROUP BY acc.warehouse_id, acc.year, acc.month, w.name, p.status, p.approved_at, p.approved_by, a.due_day, pay.total
      ORDER BY acc.year DESC, acc.month DESC, w.name`,
    params,
  );

  const wantStatus = q.status;
  const out = [];
  for (const r of rows) {
    const accrued = round2(num(r.accrued));
    const paid = round2(num(r.paid));
    const outstanding = round2(accrued - paid);
    const row = {
      warehouseId: r.warehouse_id,
      warehouseName: r.warehouse_name,
      year: r.year,
      month: r.month,
      accrued, paid, outstanding,
      daysAccrued: Number(r.days_accrued),
      daysInMonth: Number(r.days_in_month),
      status: r.status as string,
      approvedAt: r.approved_at,
      approvedBy: r.approved_by,
      dueDate: dueDateFor(r.year, r.month, Number(r.due_day)),
      accrualComplete: await isPeriodAccrualComplete(pool, r.warehouse_id, r.year, r.month),
    };
    if (!wantStatus || wantStatus === row.status) out.push(row);
  }
  res.json(out);
});

/**
 * Approval authorises payment. It deliberately does NOT post anything: the
 * expense was already recognised day by day, so gating recognition behind an
 * approval would understate the P&L for every unapproved month.
 */
// Approval is sign-off authority over the record — `edit` under the
// five-action model, same as payroll/leave/transfer approvals.
router.post("/rent/periods/:warehouseId/:year/:month/approve", requireModuleAction(PERM, "edit"), async (req, res): Promise<void> => {
  const warehouseId = parseInt(req.params.warehouseId, 10);
  const year = parseInt(req.params.year, 10);
  const month = parseInt(req.params.month, 10);
  const scope = await getUserDataScope(req.employee!);
  if (!requireHeadOffice(scope, res)) return;

  let approved: { name: string; amount: number };
  try {
    approved = await withWarehouseRentLock(pool, warehouseId, async (q) => {
      // The full catch-up, validation and state transition share the same
      // transaction and warehouse lock as revisions and the hourly sweep.
      await assertMonthOpen(q, year, month, "rent approval");

      const { rows: [existing] } = await q.query<{ status: string }>(
        `SELECT status FROM rent_periods
          WHERE warehouse_id = $1 AND year = $2 AND month = $3
          FOR UPDATE`,
        [warehouseId, year, month],
      );
      if (existing && existing.status !== "pending") {
        throw Object.assign(new Error(`This month is already ${existing.status}.`), { httpStatus: 400 });
      }
      if (!await isPeriodAccrualComplete(q, warehouseId, year, month)) {
        throw Object.assign(
          new Error("This month is still accruing. Approve it once the month has ended so the approved amount is final."),
          { httpStatus: 400 },
        );
      }

      // Caller already holds the lock: this avoids recursively acquiring it
      // while guaranteeing that a revision cannot delete rows between the
      // catch-up and the approval transition.
      await runRentAccrualLocked(q, warehouseId);

      const { rows: [agg] } = await q.query<{ total: string; name: string }>(
        `SELECT COALESCE(SUM(r.amount), 0) AS total, MAX(w.name) AS name
           FROM rent_accruals r JOIN warehouses w ON w.id = r.warehouse_id
          WHERE r.warehouse_id = $1 AND r.year = $2 AND r.month = $3`,
        [warehouseId, year, month],
      );
      if (!agg || num(agg.total) <= 0) {
        throw Object.assign(new Error("There is no accrued rent to approve for this month."), { httpStatus: 400 });
      }

      const coverage = await rentMonthCoverage(q, warehouseId, year, month);
      if (!coverage.complete) {
        const difference = round2(coverage.accruedTotal - coverage.expectedTotal);
        const direction = difference < 0 ? "under" : "over";
        throw Object.assign(
          new Error(
            `This month has accrued ₹${coverage.accruedTotal.toLocaleString("en-IN")} against ₹${coverage.expectedTotal.toLocaleString("en-IN")} expected `
            + `(₹${Math.abs(difference).toLocaleString("en-IN")} ${direction}). Check the agreement and accruals; approval would freeze an incorrect amount.`,
          ),
          { httpStatus: 400 },
        );
      }

      const { rows: [period] } = await q.query<{ status: string }>(
        `INSERT INTO rent_periods (warehouse_id, year, month, status, approved_at, approved_by)
         VALUES ($1, $2, $3, 'approved', NOW(), $4)
         ON CONFLICT (warehouse_id, year, month)
         DO UPDATE SET status = 'approved', approved_at = NOW(), approved_by = EXCLUDED.approved_by
         WHERE rent_periods.status = 'pending'
         RETURNING status`,
        [warehouseId, year, month, req.employee?.username ?? "system"],
      );
      if (!period) {
        throw Object.assign(new Error("This month was approved by another request."), { httpStatus: 400 });
      }
      return { name: String(agg.name ?? `Warehouse #${warehouseId}`), amount: round2(num(agg.total)) };
    });
  } catch (e: any) {
    if (handlePeriodLocked(res, e)) return;
    if (e?.httpStatus) { res.status(e.httpStatus).json({ error: e.message }); return; }
    console.error("[rent] approval transaction failed:", e);
    res.status(500).json({ error: "Could not approve rent. No approval changes were committed." });
    return;
  }

  logActivity({
    action: "UPDATE", module: "rent", entityType: "rent_period", entityId: warehouseId,
    description: `Rent approved for ${approved.name} — ${String(month).padStart(2, "0")}/${year}, ₹${approved.amount.toLocaleString("en-IN")}`,
    user: req.employee?.username ?? "system", metadata: { warehouseId, year, month, amount: approved.amount },
  });

  res.json({ warehouseId, year, month, status: "approved", amount: approved.amount });
});

/**
 * Record a payment against an approved month. Partial is normal; the balance
 * simply stays outstanding and carries forward.
 *
 * Posts Dr Rent Payable / Cr Cash-or-Bank as one voucher inside a transaction:
 * the payment row and its accounting entry commit together or not at all, so a
 * payment can never show as recorded while the cash never left the books.
 */
// Recording a payment CREATES a payment record, so it is gated on the "add"
// action — matching the button's own permission check on the page. Guarding it
// as "edit" here while the UI showed it on "add" meant a user with one and not
// the other either lost a button that worked or saw one that 403'd.
router.post("/rent/periods/:warehouseId/:year/:month/pay", requireModuleAction(PERM, "add"), async (req, res): Promise<void> => {
  const warehouseId = parseInt(req.params.warehouseId, 10);
  const year = parseInt(req.params.year, 10);
  const month = parseInt(req.params.month, 10);
  const scope = await getUserDataScope(req.employee!);
  if (!requireHeadOffice(scope, res)) return;
  {
    const disabledMsg = await disabledWarehouseError(pool, [{ type: "warehouse", id: warehouseId }]);
    if (disabledMsg) { res.status(409).json({ error: disabledMsg, code: WAREHOUSE_DISABLED_CODE }); return; }
  }

  const b = (req.body ?? {}) as Record<string, any>;
  const paymentMode = String(b.paymentMode ?? "cash").toLowerCase();
  // ymd() only reshapes the value — it does not check the calendar, and this
  // date lands in payments.payment_date and journal_vouchers.voucher_date.
  const paymentDate = ymd(b.paymentDate) ?? today();
  if (!isIsoDate(paymentDate)) {
    res.status(400).json({ error: "paymentDate must be a real calendar date in YYYY-MM-DD form" }); return;
  }
  const reference = String(b.referenceNumber ?? "");
  const remarks = String(b.remarks ?? "");

  // Month lock: the payment posts a voucher dated paymentDate and settles the
  // payable of the period month, so BOTH must belong to open accounting periods.
  const periodMonthFirst = `${year}-${String(month).padStart(2, "0")}-01`;
  if (await respondIfMonthLocked(res, pool, [paymentDate, periodMonthFirst], "rent payment")) return;

  const { rows: [period] } = await pool.query<{ status: string }>(
    `SELECT status FROM rent_periods WHERE warehouse_id = $1 AND year = $2 AND month = $3`,
    [warehouseId, year, month],
  );
  if (!period) { res.status(404).json({ error: "No rent period found for this month." }); return; }
  if (period.status === "pending") {
    res.status(400).json({ error: "Approve this month's rent before recording a payment." }); return;
  }
  if (period.status === "paid") {
    res.status(400).json({ error: "This month's rent is already fully paid." }); return;
  }

  const { rows: [agg] } = await pool.query<{ accrued: string; paid: string; name: string; payable: number | null }>(
    `SELECT COALESCE((SELECT SUM(amount) FROM rent_accruals WHERE warehouse_id = $1 AND year = $2 AND month = $3), 0) AS accrued,
            COALESCE((SELECT SUM(amount) FROM rent_payments WHERE warehouse_id = $1 AND year = $2 AND month = $3), 0) AS paid,
            (SELECT name FROM warehouses WHERE id = $1) AS name,
            (SELECT payable_ledger_id FROM warehouse_rent_agreements WHERE warehouse_id = $1) AS payable`,
    [warehouseId, year, month],
  );
  const accrued = round2(num(agg?.accrued));
  const alreadyPaid = round2(num(agg?.paid));
  const outstanding = round2(accrued - alreadyPaid);

  const requested = b.amount !== undefined ? round2(Number(b.amount)) : outstanding;
  if (!Number.isFinite(requested) || requested <= 0.004) {
    res.status(400).json({ error: "Payment amount must be greater than zero." }); return;
  }
  // Rent Payable only holds what has actually accrued. Paying beyond it would
  // push the liability negative and show the warehouse as having prepaid rent
  // that was never recognised as an expense.
  if (requested > outstanding + 0.005) {
    res.status(400).json({
      error: `Payment exceeds the outstanding rent for this month (₹${outstanding.toLocaleString("en-IN")}).`,
    });
    return;
  }

  const payableLedgerId = agg?.payable ?? null;
  const { rows: [cashRow] } = await pool.query<{ id: number }>(
    paymentMode === "cash"
      ? `SELECT id FROM account_ledgers WHERE code = 'STD-CASH' LIMIT 1`
      : `SELECT id FROM account_ledgers WHERE code = 'STD-BANK' LIMIT 1`,
  );
  if (!payableLedgerId || !cashRow?.id) {
    res.status(500).json({
      error: "Cannot record this payment: the rent payable or cash/bank ledger is missing. No payment was recorded.",
    });
    return;
  }

  let paymentId: number;
  let finalStatus: string;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Re-read the paid total under a lock on the period row so two concurrent
    // payments cannot each settle the same outstanding balance.
    const { rows: [locked] } = await client.query<{ status: string }>(
      `SELECT status FROM rent_periods WHERE warehouse_id = $1 AND year = $2 AND month = $3 FOR UPDATE`,
      [warehouseId, year, month],
    );
    if (!locked || locked.status !== "approved") {
      throw Object.assign(new Error("This month is no longer awaiting payment."), { httpStatus: 400 });
    }
    const { rows: [paidNow] } = await client.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM rent_payments WHERE warehouse_id = $1 AND year = $2 AND month = $3`,
      [warehouseId, year, month],
    );
    const lockedOutstanding = round2(accrued - num(paidNow?.total));
    if (requested > lockedOutstanding + 0.005) {
      throw Object.assign(
        new Error(`Payment exceeds the outstanding rent for this month (₹${lockedOutstanding.toLocaleString("en-IN")}).`),
        { httpStatus: 400 },
      );
    }

    const voucherNumber = await nextVoucherNumber(client, "journal", paymentDate);
    const isFinal = requested >= lockedOutstanding - 0.005;
    const narration = `Rent Payment${isFinal ? "" : " (Partial)"} — ${agg?.name ?? `Warehouse #${warehouseId}`} — ${String(month).padStart(2, "0")}/${year}`;
    const { rows: [jv] } = await client.query<{ id: number }>(
      `INSERT INTO journal_vouchers (voucher_type, voucher_number, voucher_date, narration, total_amount, created_by,
                                    origin, source_module, location_type, location_id)
       VALUES ('journal', $1, $2, $3, $4, $5, 'system', 'rent', 'warehouse', $6) RETURNING id`,
      [voucherNumber, paymentDate, narration, requested.toFixed(2), req.employee?.username ?? "system", warehouseId],
    );
    // Dr Rent Payable / Cr Cash or Bank
    await client.query(
      `INSERT INTO journal_voucher_lines (voucher_id, ledger_id, debit, credit)
       VALUES ($1, $2, $3, 0), ($1, $4, 0, $3)`,
      [jv.id, payableLedgerId, requested.toFixed(2), cashRow.id],
    );
    const { rows: [payRow] } = await client.query<{ id: number }>(
      `INSERT INTO rent_payments (warehouse_id, year, month, payment_date, amount, payment_mode, reference_number, remarks, voucher_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [warehouseId, year, month, paymentDate, requested.toFixed(2), paymentMode, reference, remarks, jv.id, req.employee?.username ?? "system"],
    );
    finalStatus = isFinal ? "paid" : "approved";
    if (isFinal) {
      await client.query(
        `UPDATE rent_periods SET status = 'paid' WHERE warehouse_id = $1 AND year = $2 AND month = $3`,
        [warehouseId, year, month],
      );
    }
    await client.query("COMMIT");
    paymentId = payRow.id;
  } catch (e: any) {
    await client.query("ROLLBACK").catch(() => {});
    const status = e?.httpStatus ?? 500;
    res.status(status).json({
      error: status === 400 ? e.message : "Could not record the rent payment. Nothing was changed — please try again.",
    });
    return;
  } finally {
    client.release();
  }

  logActivity({
    action: "CREATE", module: "rent", entityType: "rent_payment", entityId: paymentId,
    description: `Rent ${finalStatus === "paid" ? "paid" : "partial payment"} for ${agg?.name ?? `Warehouse #${warehouseId}`} — ${String(month).padStart(2, "0")}/${year}, ₹${requested.toLocaleString("en-IN")} via ${paymentMode}`,
    user: req.employee?.username ?? "system",
    metadata: { warehouseId, year, month, amount: requested, paymentMode, reference },
  });

  res.status(201).json({ id: paymentId, warehouseId, year, month, amount: requested, status: finalStatus });
});

/** Payment history — powers both the drill-down and the Paid Rent report. */
router.get("/rent/payments", requireModuleView(PERM), async (req, res): Promise<void> => {
  const scope = await getUserDataScope(req.employee!);
  const params: unknown[] = [];
  const conds = [scopeWhere(scope, params, "p.warehouse_id")];

  const q = req.query as Record<string, string | undefined>;
  if (badDateRange(q, res)) return;
  if (q.warehouseId) { params.push(Number(q.warehouseId)); conds.push(`p.warehouse_id = $${params.length}`); }
  if (q.year)        { params.push(Number(q.year));        conds.push(`p.year = $${params.length}`); }
  if (q.month)       { params.push(Number(q.month));       conds.push(`p.month = $${params.length}`); }
  if (q.from)        { params.push(q.from);                conds.push(`p.payment_date >= $${params.length}`); }
  if (q.to)          { params.push(q.to);                  conds.push(`p.payment_date <= $${params.length}`); }

  const { rows } = await pool.query(
    `SELECT p.*, w.name AS warehouse_name, jv.voucher_number
       FROM rent_payments p
       JOIN warehouses w ON w.id = p.warehouse_id
       LEFT JOIN journal_vouchers jv ON jv.id = p.voucher_id
      WHERE ${conds.join(" AND ")}
      ORDER BY p.payment_date DESC, p.id DESC`,
    params,
  );

  res.json(rows.map((r) => ({
    id: r.id,
    warehouseId: r.warehouse_id,
    warehouseName: r.warehouse_name,
    year: r.year,
    month: r.month,
    paymentDate: ymd(r.payment_date),
    amount: round2(num(r.amount)),
    paymentMode: r.payment_mode,
    referenceNumber: r.reference_number ?? "",
    remarks: r.remarks ?? "",
    voucherId: r.voucher_id,
    voucherNumber: r.voucher_number ?? "",
    createdBy: r.created_by,
    createdAt: r.created_at,
  })));
});

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard
// ─────────────────────────────────────────────────────────────────────────────

router.get("/rent/dashboard", requireModuleView(PERM), async (req, res): Promise<void> => {
  const scope = await getUserDataScope(req.employee!);
  const now = today();
  const [yStr, mStr] = now.split("-");
  const year = Number(yStr), month = Number(mStr);

  const p1: unknown[] = [];
  const scopeAcc = scopeWhere(scope, p1, "r.warehouse_id");
  const { rows: [monthAgg] } = await pool.query<{ accrued: string }>(
    `SELECT COALESCE(SUM(r.amount), 0) AS accrued FROM rent_accruals r
      WHERE ${scopeAcc} AND r.year = ${year} AND r.month = ${month}`, p1,
  );

  const p2: unknown[] = [];
  const scopePay = scopeWhere(scope, p2, "p.warehouse_id");
  const { rows: [paidAgg] } = await pool.query<{ paid: string }>(
    `SELECT COALESCE(SUM(p.amount), 0) AS paid FROM rent_payments p
      WHERE ${scopePay} AND p.year = ${year} AND p.month = ${month}`, p2,
  );

  const p4: unknown[] = [];
  const scopeMonthly = scopeWhere(scope, p4, "a.warehouse_id");
  const { rows: [committed] } = await pool.query<{ total: string; active: string }>(
    `SELECT COALESCE(SUM(a.monthly_rent), 0) AS total, COUNT(*) FILTER (WHERE a.status = 'active') AS active
       FROM warehouse_rent_agreements a WHERE ${scopeMonthly} AND a.status = 'active'`, p4,
  );

  const p5: unknown[] = [];
  const scopePeriods = scopeWhere(scope, p5, "acc.warehouse_id");
  const { rows: warehouseWise } = await pool.query(
    `SELECT acc.warehouse_id, w.name AS warehouse_name,
            SUM(acc.amount) FILTER (WHERE acc.year = ${year} AND acc.month = ${month}) AS month_accrued,
            SUM(acc.amount) AS total_accrued,
            COALESCE(MAX(pay.total), 0) AS total_paid
       FROM rent_accruals acc
       JOIN warehouses w ON w.id = acc.warehouse_id
       LEFT JOIN (SELECT warehouse_id, SUM(amount) AS total FROM rent_payments GROUP BY warehouse_id) pay
              ON pay.warehouse_id = acc.warehouse_id
      WHERE ${scopePeriods}
      GROUP BY acc.warehouse_id, w.name ORDER BY w.name`, p5,
  );

  const p6: unknown[] = [];
  const scopePending = scopeWhere(scope, p6, "p.warehouse_id");
  const { rows: [pending] } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM rent_periods p WHERE ${scopePending} AND p.status = 'pending'`, p6,
  );

  const chart = warehouseWise.map((r) => ({
    warehouseId: r.warehouse_id,
    warehouseName: r.warehouse_name,
    monthAccrued: round2(num(r.month_accrued)),
    totalAccrued: round2(num(r.total_accrued)),
    totalPaid: round2(num(r.total_paid)),
    outstanding: round2(num(r.total_accrued) - num(r.total_paid)),
  }));

  res.json({
    year, month,
    monthlyRentCommitted: round2(num(committed?.total)),
    activeAgreements: Number(committed?.active ?? 0),
    accruedThisMonth: round2(num(monthAgg?.accrued)),
    paidThisMonth: round2(num(paidAgg?.paid)),
    totalOutstanding: round2(chart.reduce((s, r) => s + r.outstanding, 0)),
    pendingApprovals: Number(pending?.count ?? 0),
    warehouseWise: chart,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ledger Posting Report
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every posting the module has generated, accruals and payments together, in
 * the debit/credit shape an accountant expects to reconcile against the ledger.
 */
router.get("/rent/ledger-postings", requireModuleView(PERM), async (req, res): Promise<void> => {
  const scope = await getUserDataScope(req.employee!);
  const q = req.query as Record<string, string | undefined>;
  if (badDateRange(q, res)) return;

  const pa: unknown[] = [];
  const condsA = [scopeWhere(scope, pa, "r.warehouse_id")];
  if (q.warehouseId) { pa.push(Number(q.warehouseId)); condsA.push(`r.warehouse_id = $${pa.length}`); }
  if (q.from) { pa.push(q.from); condsA.push(`r.accrual_date >= $${pa.length}`); }
  if (q.to)   { pa.push(q.to);   condsA.push(`r.accrual_date <= $${pa.length}`); }

  const { rows: accruals } = await pool.query(
    `SELECT r.accrual_date AS date, r.amount, w.name AS warehouse_name,
            le.name AS debit_ledger, lp.name AS credit_ledger
       FROM rent_accruals r
       JOIN warehouses w ON w.id = r.warehouse_id
       LEFT JOIN warehouse_rent_agreements a ON a.warehouse_id = r.warehouse_id
       LEFT JOIN account_ledgers le ON le.id = a.expense_ledger_id
       LEFT JOIN account_ledgers lp ON lp.id = a.payable_ledger_id
      WHERE ${condsA.join(" AND ")}`, pa,
  );

  const pp: unknown[] = [];
  const condsP = [scopeWhere(scope, pp, "p.warehouse_id")];
  if (q.warehouseId) { pp.push(Number(q.warehouseId)); condsP.push(`p.warehouse_id = $${pp.length}`); }
  if (q.from) { pp.push(q.from); condsP.push(`p.payment_date >= $${pp.length}`); }
  if (q.to)   { pp.push(q.to);   condsP.push(`p.payment_date <= $${pp.length}`); }

  const { rows: payments } = await pool.query(
    `SELECT p.payment_date AS date, p.amount, p.payment_mode, w.name AS warehouse_name,
            lp.name AS debit_ledger, jv.voucher_number
       FROM rent_payments p
       JOIN warehouses w ON w.id = p.warehouse_id
       LEFT JOIN warehouse_rent_agreements a ON a.warehouse_id = p.warehouse_id
       LEFT JOIN account_ledgers lp ON lp.id = a.payable_ledger_id
       LEFT JOIN journal_vouchers jv ON jv.id = p.voucher_id
      WHERE ${condsP.join(" AND ")}`, pp,
  );

  const out = [
    ...accruals.map((r) => ({
      date: ymd(r.date), warehouseName: r.warehouse_name, kind: "accrual" as const,
      narration: "Rent accrued", voucherNumber: "",
      debitLedger: r.debit_ledger ?? "Rent Expense", creditLedger: r.credit_ledger ?? "Rent Payable",
      amount: round2(num(r.amount)),
    })),
    ...payments.map((r) => ({
      date: ymd(r.date), warehouseName: r.warehouse_name, kind: "payment" as const,
      narration: `Rent paid via ${r.payment_mode}`, voucherNumber: r.voucher_number ?? "",
      debitLedger: r.debit_ledger ?? "Rent Payable",
      creditLedger: r.payment_mode === "cash" ? "Cash" : "Bank",
      amount: round2(num(r.amount)),
    })),
  ].sort((a, b) => String(b.date).localeCompare(String(a.date)));

  res.json(out);
});

export default router;
