import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { requireModuleView, requireModuleAction } from "../middleware/permissions";
import { getUserDataScope, type DataScope } from "../lib/dataScope";
import { nextVoucherNumber } from "../lib/voucherNumber";
import { logActivity } from "../lib/audit";
import {
  runRentAccrual, isPeriodAccrualComplete, rentMonthCoverage, recalcUnapprovedRentAccruals, dailyRentRate,
} from "../lib/rentAccrual";
import { provisionRentLedgers } from "../lib/rentLedgers";

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

  const { rows: [wh] } = await pool.query<{ name: string }>(`SELECT name FROM warehouses WHERE id = $1`, [warehouseId]);
  if (!wh) { res.status(404).json({ error: "Warehouse not found" }); return; }

  await pool.query(
    `INSERT INTO warehouse_rent_agreements (warehouse_id) VALUES ($1) ON CONFLICT (warehouse_id) DO NOTHING`,
    [warehouseId],
  );
  const { rows: [before] } = await pool.query(
    `SELECT * FROM warehouse_rent_agreements WHERE warehouse_id = $1`, [warehouseId],
  );

  const b = (req.body ?? {}) as Record<string, any>;
  const monthlyRent = b.monthlyRent !== undefined ? Number(b.monthlyRent) : num(before.monthly_rent);
  if (!Number.isFinite(monthlyRent) || monthlyRent < 0) {
    res.status(400).json({ error: "Monthly rent must be zero or a positive amount." }); return;
  }
  const dueDay = b.dueDay !== undefined ? Number(b.dueDay) : Number(before.due_day ?? 5);
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) {
    res.status(400).json({ error: "Payment due day must be a day of the month (1–31)." }); return;
  }

  const startDate = b.startDate !== undefined ? (b.startDate || null) : ymd(before.start_date);
  const endDate   = b.endDate   !== undefined ? (b.endDate   || null) : ymd(before.end_date);
  if (startDate && endDate && endDate < startDate) {
    res.status(400).json({ error: "Agreement end date cannot be before the start date." }); return;
  }

  const status = b.status !== undefined ? String(b.status) : String(before.status);
  if (!["active", "inactive"].includes(status)) {
    res.status(400).json({ error: "Status must be active or inactive." }); return;
  }
  // Activating rent with no start date would accrue nothing and look broken.
  if (status === "active" && !startDate) {
    res.status(400).json({ error: "Set an agreement start date before activating rent." }); return;
  }
  if (status === "active" && monthlyRent <= 0) {
    res.status(400).json({ error: "Set a monthly rent amount before activating rent." }); return;
  }

  // Stamp the switch-off date on the transition, and clear it on re-activation.
  let inactiveFrom = ymd(before.inactive_from);
  if (status === "inactive" && before.status === "active") inactiveFrom = b.inactiveFrom || today();
  if (status === "active") inactiveFrom = null;

  await pool.query(
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

  // Ledgers are provisioned lazily too: a warehouse created before the chart of
  // accounts was seeded gets them on its first edit rather than never.
  await provisionRentLedgers(pool, warehouseId, wh.name);

  // A change to the rent or to when the agreement starts rewrites every
  // unapproved month's daily accrual at the new terms: an open month is
  // recalculated in full rather than running at two rates for one month.
  // Approved and paid months are financially final and are left untouched.
  const prevRent = num(before.monthly_rent);
  const rentChanged = b.monthlyRent !== undefined && Math.abs(monthlyRent - prevRent) > 0.004;
  const startChanged = b.startDate !== undefined && startDate !== ymd(before.start_date);

  if (rentChanged || startChanged) {
    // The reason travels outside the field list so the audit trail can say why
    // the figures moved.
    const reason = typeof b.revisionReason === "string" ? b.revisionReason.trim().slice(0, 500) : "";
    try {
      const recalc = await recalcUnapprovedRentAccruals(pool, warehouseId);
      const now = new Date();
      const basis = recalc.monthsRecalculated[0]
        ?? { year: now.getFullYear(), month: now.getMonth() + 1 };
      const asLabel = (m: { year: number; month: number }) => `${String(m.month).padStart(2, "0")}/${m.year}`;
      const months = recalc.monthsRecalculated.map(asLabel);

      logActivity({
        action: "UPDATE", module: "rent", entityType: "rent_accrual", entityId: warehouseId,
        user: req.employee?.username ?? "system",
        description:
          `Rent revised for ${wh.name} — ₹${prevRent.toLocaleString("en-IN")} → ₹${monthlyRent.toLocaleString("en-IN")}/month; `
          + `${recalc.entriesReversed} daily accrual entr${recalc.entriesReversed === 1 ? "y" : "ies"} reversed, `
          + `${recalc.entriesRegenerated} regenerated`
          + (months.length ? ` for ${months.join(", ")}` : " (nothing accrued yet)")
          + (reason ? ` — reason: ${reason}` : ""),
        metadata: {
          warehouseId, warehouseName: wh.name,
          previousAmount: prevRent, newAmount: monthlyRent,
          previousDailyAccrual: dailyRentRate(prevRent, basis.year, basis.month),
          newDailyAccrual: dailyRentRate(monthlyRent, basis.year, basis.month),
          dailyRateBasisMonth: asLabel(basis),
          previousStartDate: ymd(before.start_date), newStartDate: startDate,
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
    } catch (e) {
      // The agreement itself is saved. Accrual is an idempotent catch-up, so a
      // failure here self-heals on the next hourly pass — but it must be loud,
      // because until then the open month is still accruing at the old rent.
      console.error("[rent] accrual recalculation after edit failed:", e);
    }
  } else if (status === "active") {
    // Catch up immediately so activating rent shows accrual without waiting an hour.
    try { await runRentAccrual(pool); } catch (e) { console.error("[rent] accrual after edit failed:", e); }
  }

  logActivity({
    action: "UPDATE", module: "rent", entityType: "rent_agreement", entityId: warehouseId,
    description: `Rent agreement updated for ${wh.name} — ₹${monthlyRent.toLocaleString("en-IN")}/month, ${status}`,
    user: req.employee?.username ?? "system",
    metadata: { before: { monthlyRent: num(before.monthly_rent), status: before.status }, after: { monthlyRent, status } },
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
router.post("/rent/periods/:warehouseId/:year/:month/approve", requireModuleAction(PERM, "approve"), async (req, res): Promise<void> => {
  const warehouseId = parseInt(req.params.warehouseId, 10);
  const year = parseInt(req.params.year, 10);
  const month = parseInt(req.params.month, 10);
  const scope = await getUserDataScope(req.employee!);
  if (!requireHeadOffice(scope, res)) return;

  const { rows: [existing] } = await pool.query<{ status: string }>(
    `SELECT status FROM rent_periods WHERE warehouse_id = $1 AND year = $2 AND month = $3`,
    [warehouseId, year, month],
  );
  if (existing && existing.status !== "pending") {
    res.status(400).json({ error: `This month is already ${existing.status}.` }); return;
  }
  if (!await isPeriodAccrualComplete(pool, warehouseId, year, month)) {
    res.status(400).json({
      error: "This month is still accruing. Approve it once the month has ended so the approved amount is final.",
    });
    return;
  }

  // Catch this warehouse up before freezing the month. Approval is the point of
  // no return — nothing tops a month up afterwards, because approved months are
  // excluded from the sweep — so a day lost to downtime has to be recovered now
  // rather than quietly written off.
  await runRentAccrual(pool, { warehouseId });

  const { rows: [agg] } = await pool.query<{ total: string; name: string }>(
    `SELECT COALESCE(SUM(r.amount), 0) AS total, MAX(w.name) AS name
       FROM rent_accruals r JOIN warehouses w ON w.id = r.warehouse_id
      WHERE r.warehouse_id = $1 AND r.year = $2 AND r.month = $3`,
    [warehouseId, year, month],
  );
  if (!agg || num(agg.total) <= 0) {
    res.status(400).json({ error: "There is no accrued rent to approve for this month." }); return;
  }

  const coverage = await rentMonthCoverage(pool, warehouseId, year, month);
  if (!coverage.complete) {
    res.status(400).json({
      error: `This month has only accrued ₹${coverage.accruedTotal.toLocaleString("en-IN")} of the ₹${coverage.expectedTotal.toLocaleString("en-IN")} the agreement is worth, so approving it would understate the expense permanently. Check the agreement dates and rent amount, then try again.`,
    });
    return;
  }

  await pool.query(
    `INSERT INTO rent_periods (warehouse_id, year, month, status, approved_at, approved_by)
     VALUES ($1, $2, $3, 'approved', NOW(), $4)
     ON CONFLICT (warehouse_id, year, month)
     DO UPDATE SET status = 'approved', approved_at = NOW(), approved_by = EXCLUDED.approved_by
     WHERE rent_periods.status = 'pending'`,
    [warehouseId, year, month, req.employee?.username ?? "system"],
  );

  logActivity({
    action: "UPDATE", module: "rent", entityType: "rent_period", entityId: warehouseId,
    description: `Rent approved for ${agg.name} — ${String(month).padStart(2, "0")}/${year}, ₹${round2(num(agg.total)).toLocaleString("en-IN")}`,
    user: req.employee?.username ?? "system", metadata: { warehouseId, year, month, amount: round2(num(agg.total)) },
  });

  res.json({ warehouseId, year, month, status: "approved", amount: round2(num(agg.total)) });
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

  const b = (req.body ?? {}) as Record<string, any>;
  const paymentMode = String(b.paymentMode ?? "cash").toLowerCase();
  const paymentDate = ymd(b.paymentDate) ?? today();
  const reference = String(b.referenceNumber ?? "");
  const remarks = String(b.remarks ?? "");

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
      `INSERT INTO journal_vouchers (voucher_type, voucher_number, voucher_date, narration, total_amount, created_by)
       VALUES ('journal', $1, $2, $3, $4, $5) RETURNING id`,
      [voucherNumber, paymentDate, narration, requested.toFixed(2), req.employee?.username ?? "system"],
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
