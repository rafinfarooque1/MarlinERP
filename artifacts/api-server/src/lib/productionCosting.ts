// ── True batch costing: labour allocation + capitalisation postings ─────────
//
// A manufactured batch costs what went into it:
//
//   rm_cost      raw material consumed              (materials master)
// + pm_cost      packing material consumed          (raw_materials master)
// + labour_cost  that day's production payroll, shared across the day's batches
// + overhead     rm+pm × overhead_percent           (unchanged legacy behaviour)
// = total_cost   →  cost_per_unit = total_cost / good units produced
//
// cost_per_unit is the ONE valuation cost: it is what the produced lot carries
// in stock_batches, so valuation, profitability and the books all read the same
// number instead of each inventing their own.
//
// LABOUR IS A DAILY POOL, NOT A PER-BATCH FIGURE. Production staff are paid for
// a day, not for a batch, so the day's wage cost is spread across every batch
// that location made that day, weighted by quantity produced. That means
// recording (or deleting) a batch re-spreads labour across its siblings — which
// is why every write goes through reallocateDayLabour() rather than costing one
// row in isolation. The allocation always sums to exactly the day's pool.
//
// Because purchases and payroll are already expensed when they happen,
// capitalising a batch into stock must relieve the expense side by the same
// amount or the cost is counted twice:
//
//   Dr Finished Goods Inventory   /  Cr Production Cost Absorbed
//
// Deleting a batch posts the mirror image, and a re-spread posts only the
// difference, so the pair always nets to the value actually held in stock.

import { nextVoucherNumber } from "./voucherNumber";

export type Queryable = { query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

/** Which location manufactured a batch. Never the retired 'production' branch. */
export interface ProdLocation { type: string; id: number }

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

/** How a batch's labour figure was arrived at. Stored so a cost can be explained. */
export type LabourMethod = "payroll" | "manual" | "none";

export interface DayLabourPool {
  /** Total production wage cost for the day at this location. */
  amount: number;
  /** Production staff who actually worked (fractional for half days). */
  staffDays: number;
  staffCount: number;
}

/**
 * The day's production wage cost at one location, derived from attendance.
 *
 * Only employees flagged as production staff count — an office or sales
 * salary is not a manufacturing cost. A day is valued at salary ÷ working
 * days per month, scaled by the fraction of the day actually worked. Leave is
 * paid by payroll but produces nothing, so it contributes no batch cost.
 */
export async function labourPoolForDay(
  c: Queryable,
  date: string,
  loc: ProdLocation,
): Promise<DayLabourPool> {
  const { rows: [csRow] } = await c.query(`SELECT general_settings FROM company_settings LIMIT 1`);
  const gs = (csRow?.general_settings as Record<string, any>) ?? {};
  const fullDayHours = Number(gs.fullDayHours ?? 9);
  const halfDayHours = Number(gs.halfDayHours ?? 4.5);

  // Head Office staff carry branch_id 0 in some rows, so match on type only
  // there; warehouses and outlets match both type and id.
  const isHo = loc.type === "headoffice";
  const { rows } = await c.query(
    `SELECT e.id, COALESCE(e.salary, 0)::numeric AS salary,
            a.status, a.check_in, a.check_out,
            COALESCE(pc.working_days_per_month, 26) AS working_days
     FROM employees e
     JOIN attendance a ON a.employee_id = e.id AND a.date = $1::date
     LEFT JOIN pay_components pc ON pc.employee_id = e.id
     WHERE e.is_active = TRUE
       AND e.is_production_staff = TRUE
       AND e.branch_type = $2
       AND ($3::boolean OR e.branch_id = $4)`,
    [date, loc.type, isHo, loc.id],
  );

  let amount = 0;
  let staffDays = 0;
  const seen = new Set<number>();
  for (const r of rows) {
    let fraction = 0;
    if (r.check_in && r.check_out) {
      const hrs = (new Date(r.check_out).getTime() - new Date(r.check_in).getTime()) / 3_600_000;
      fraction = hrs >= fullDayHours ? 1 : hrs >= halfDayHours ? 0.5 : 0;
    } else if (r.check_in) {
      fraction = 1; // on the floor, not yet checked out
    } else if (r.status === "present") {
      fraction = 1;
    } else if (r.status === "half_day") {
      fraction = 0.5;
    }
    // 'leave' and 'absent' → 0: paid or not, no production work happened.
    if (fraction <= 0) continue;
    const workingDays = Math.max(1, Number(r.working_days) || 26);
    amount += (Number(r.salary) / workingDays) * fraction;
    staffDays += fraction;
    seen.add(Number(r.id));
  }

  return { amount: r2(amount), staffDays: r3(staffDays), staffCount: seen.size };
}

export interface BatchCostRow {
  id: number;
  itemId: number;
  batchNumber: string;
  producedQuantity: number;
  wastageQty: number;
  rmCost: number;
  pmCost: number;
  overheadPercent: number;
  overheadAmount: number;
  labourCost: number;
  labourMethod: LabourMethod;
  totalCost: number;
  costPerUnit: number;
  wastageValue: number;
  /** total_cost as stored before this reallocation — for the adjustment posting. */
  totalCostBefore: number;
}

export interface DayAllocation {
  pool: DayLabourPool;
  rows: BatchCostRow[];
  /** Labour actually spread across payroll-costed batches (equals pool when any exist). */
  allocated: number;
}

/**
 * Re-spread the day's labour pool across every batch that location produced on
 * that date, then rewrite each batch's derived costs and its lot valuation.
 *
 * Call inside the transaction that inserted or deleted a batch. Rows are locked
 * FOR UPDATE so two concurrent batches on the same day cannot both allocate the
 * whole pool.
 *
 * Batches with a manual labour figure keep it and are excluded from the spread —
 * the fallback exists precisely for days where attendance cannot answer.
 */
/**
 * Serialise everything that touches one location's batches on one date.
 *
 * FOR UPDATE cannot lock a row a concurrent request has not inserted yet, so two
 * simultaneous batches for the same day could each spread the pool over an
 * incomplete sibling set and overwrite each other. This lock closes that gap and
 * is held to the end of the caller's transaction.
 *
 * LOCK ORDER — every production write path must take locks in this order, or two
 * requests can hold one lock each and wait forever for the other:
 *   1. this day+location labour lock (sorted by date when two days are involved)
 *   2. the per-item `production-stock` advisory lock
 *   3. row locks (`SELECT … FOR UPDATE`)
 * Advisory locks are re-entrant within a transaction, so taking this one early
 * and again inside reallocateDayLabour() is free.
 */
export async function lockLabourDay(c: Queryable, date: string, loc: ProdLocation): Promise<void> {
  await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    `labour:${date}:${loc.type}:${loc.id}`,
  ]);
}

export async function reallocateDayLabour(
  c: Queryable,
  date: string,
  loc: ProdLocation,
): Promise<DayAllocation> {
  await lockLabourDay(c, date, loc);

  const pool = await labourPoolForDay(c, date, loc);

  const { rows } = await c.query(
    `SELECT id, item_id, batch_number, produced_quantity, wastage_qty,
            rm_cost, pm_cost, overhead_percent, labour_cost, labour_method, total_cost
     FROM productions
     WHERE production_date = $1::date AND location_type = $2 AND location_id = $3
     ORDER BY id
     FOR UPDATE`,
    [date, loc.type, loc.id],
  );

  // Batches recorded before batch costing existed have no labour_method at all.
  // Their cost was never capitalised into the books, so re-spreading labour onto
  // them would post value for stock that was never posted in the first place —
  // and deleting them later would relieve more than was ever capitalised. They
  // are left exactly as they are, and take no share of the pool.
  const parsed = rows
    .filter((r: any) => r.labour_method !== null && r.labour_method !== undefined)
    .map((r: any) => ({
      id: Number(r.id),
      itemId: Number(r.item_id),
      batchNumber: String(r.batch_number ?? `B-${String(r.id).padStart(4, "0")}`),
      producedQuantity: Number(r.produced_quantity ?? 0),
      wastageQty: Number(r.wastage_qty ?? 0),
      rmCost: Number(r.rm_cost ?? 0),
      pmCost: Number(r.pm_cost ?? 0),
      overheadPercent: Number(r.overhead_percent ?? 0),
      labourCost: Number(r.labour_cost ?? 0),
      labourMethod: (r.labour_method ?? "none") as LabourMethod,
      totalCostBefore: Number(r.total_cost ?? 0),
    }));

  const manual = parsed.filter((p) => p.labourMethod === "manual");
  const spread = parsed.filter((p) => p.labourMethod !== "manual");

  // Weighted by quantity produced. Production runs carry no hours of their own,
  // so output is the available proxy for effort. The last batch absorbs the
  // rounding remainder, which keeps the allocation exactly equal to the pool.
  const shares = new Map<number, number>();
  for (const m of manual) shares.set(m.id, r2(Math.max(0, m.labourCost)));
  let allocated = 0;
  if (spread.length > 0 && pool.amount > 0.004) {
    const totalWeight = spread.reduce((s, p) => s + Math.max(0, p.producedQuantity), 0);
    let running = 0;
    spread.forEach((p, i) => {
      const isLast = i === spread.length - 1;
      const share = isLast
        ? r2(pool.amount - running)
        : r2(totalWeight > 0
            ? pool.amount * Math.max(0, p.producedQuantity) / totalWeight
            : pool.amount / spread.length);
      running = r2(running + share);
      shares.set(p.id, share);
    });
    allocated = r2(pool.amount);
  } else {
    for (const p of spread) shares.set(p.id, 0);
  }

  const out: BatchCostRow[] = [];
  for (const p of parsed) {
    const labourCost = r2(shares.get(p.id) ?? 0);
    const labourMethod: LabourMethod =
      p.labourMethod === "manual" ? "manual" : labourCost > 0.004 ? "payroll" : "none";
    const materialCost = r2(p.rmCost + p.pmCost);
    // Overhead behaviour is unchanged: a percentage of material cost. Labour is
    // a real measured cost and is added on top, never marked up.
    const overheadAmount = r2(materialCost * p.overheadPercent / 100);
    const totalCost = r2(materialCost + overheadAmount + labourCost);
    const gross = r3(p.producedQuantity + p.wastageQty);
    const costPerUnit = p.producedQuantity > 0 && totalCost > 0 ? r4(totalCost / p.producedQuantity) : 0;
    const wastageValue = p.wastageQty > 0 && gross > 0 && totalCost > 0
      ? r2(totalCost * p.wastageQty / gross) : 0;

    await c.query(
      `UPDATE productions SET
         material_cost = $1, overhead_amount = $2, labour_cost = $3, labour_method = $4,
         total_cost = $5, cost_per_unit = $6, wastage_value = $7
       WHERE id = $8`,
      [materialCost, overheadAmount, labourCost, labourMethod, totalCost, costPerUnit, wastageValue, p.id],
    );

    // The produced lot is valued at the batch's own cost per unit — the single
    // valuation cost. Zero-cost batches leave the existing lot value alone so a
    // costless run cannot wipe out a lot that was valued correctly before.
    if (costPerUnit > 0) {
      await c.query(
        `UPDATE stock_batches SET unit_cost = $1, updated_at = now()
         WHERE item_id = $2 AND material_type = 'item'
           AND branch_type = $3 AND branch_id = $4 AND batch_number = $5`,
        [r2(costPerUnit), p.itemId, loc.type, loc.id, p.batchNumber],
      );
    }

    out.push({
      id: p.id, itemId: p.itemId, batchNumber: p.batchNumber,
      producedQuantity: p.producedQuantity, wastageQty: p.wastageQty,
      rmCost: p.rmCost, pmCost: p.pmCost,
      overheadPercent: p.overheadPercent, overheadAmount,
      labourCost, labourMethod, totalCost, costPerUnit, wastageValue,
      totalCostBefore: p.totalCostBefore,
    });
  }

  return { pool, rows: out, allocated };
}

async function ledgerIdByCode(c: Queryable, code: string): Promise<number> {
  const { rows: [row] } = await c.query(`SELECT id FROM account_ledgers WHERE code = $1 LIMIT 1`, [code]);
  if (!row?.id) {
    // Fail loudly: a missing ledger means the batch would silently go unposted
    // and the books would disagree with stock.
    throw new Error(`Accounting ledger ${code} is missing — restart the server to provision it`);
  }
  return Number(row.id);
}

/**
 * Post the capitalisation (or its reversal) for manufactured stock.
 *
 * capitalise → Dr Finished Goods Inventory / Cr Production Cost Absorbed
 * relieve    → the mirror image (batch deleted, or its cost reduced)
 *
 * Runs on the caller's transaction client so the posting commits with the stock
 * move or not at all. Returns the voucher number, or null when there is nothing
 * material to post.
 */
export async function postProductionCostJv(c: Queryable, args: {
  date: string;
  narration: string;
  amount: number;
  direction: "capitalise" | "relieve";
  createdBy?: string | null;
}): Promise<string | null> {
  const amount = r2(Math.abs(args.amount));
  if (!(amount > 0.004)) return null;

  const fgLedger = await ledgerIdByCode(c, "STD-FG-INV");
  const absLedger = await ledgerIdByCode(c, "STD-PROD-ABS");
  const drLedger = args.direction === "capitalise" ? fgLedger : absLedger;
  const crLedger = args.direction === "capitalise" ? absLedger : fgLedger;

  const voucherNumber = await nextVoucherNumber(c, "journal", args.date);
  const { rows: [voucher] } = await c.query(
    `INSERT INTO journal_vouchers
       (voucher_type, voucher_number, voucher_date, narration, total_amount, created_by,
        origin, source_module)
     VALUES ('journal', $1, $2, $3, $4, $5, 'system', 'production') RETURNING id`,
    [voucherNumber, args.date, args.narration, amount, args.createdBy ?? "system"],
  );
  await c.query(
    `INSERT INTO journal_voucher_lines (voucher_id, ledger_id, debit, credit)
     VALUES ($1, $2, $3, 0), ($1, $4, 0, $3)`,
    [voucher.id, drLedger, amount, crLedger],
  );
  return voucherNumber;
}

/**
 * Post the net effect of a re-spread on batches OTHER than the one just written.
 * Their labour share moved, so the value capitalised must move with it.
 */
export async function postReallocationAdjustment(c: Queryable, args: {
  date: string;
  rows: BatchCostRow[];
  excludeId?: number;
  reason: string;
  createdBy?: string | null;
}): Promise<string | null> {
  const delta = r2(args.rows
    .filter((r) => r.id !== args.excludeId)
    .reduce((s, r) => s + (r.totalCost - r.totalCostBefore), 0));
  if (Math.abs(delta) <= 0.004) return null;
  return postProductionCostJv(c, {
    date: args.date,
    narration: `${args.reason} — labour re-spread across the day's batches`,
    amount: delta,
    direction: delta > 0 ? "capitalise" : "relieve",
    createdBy: args.createdBy,
  });
}

/** Human label for a production/purchase location, for narrations and logs. */
export async function locationLabel(c: Queryable, loc: ProdLocation): Promise<string> {
  if (loc.type === "headoffice") return "Head Office";
  const table = loc.type === "outlet" ? "outlets" : "warehouses";
  const { rows: [row] } = await c.query(`SELECT name FROM ${table} WHERE id = $1 LIMIT 1`, [loc.id]);
  return row?.name ?? `${loc.type} #${loc.id}`;
}

/**
 * Resolve and validate the location a purchase or production run belongs to.
 *
 * Head Office may act for any location; every other caller is pinned to its
 * own. Returns an error message instead of throwing so routes can answer 400.
 */
export async function resolveActingLocation(c: Queryable, args: {
  employee?: { branchType?: string; branchId?: number } | undefined;
  requested?: { type?: unknown; id?: unknown } | undefined;
}): Promise<{ loc: ProdLocation } | { error: string }> {
  const empType = args.employee?.branchType ?? "headoffice";
  const empId = Number(args.employee?.branchId ?? 0);

  if (empType !== "headoffice") {
    const own: ProdLocation = { type: empType, id: empId };
    const reqType = typeof args.requested?.type === "string" ? args.requested.type : null;
    const reqId = args.requested?.id !== undefined && args.requested?.id !== null && args.requested?.id !== ""
      ? Number(args.requested.id) : null;
    if ((reqType && reqType !== own.type) || (reqId !== null && reqId !== own.id)) {
      return { error: "You can only record this for your own location" };
    }
    return { loc: own };
  }

  // Head Office caller: default to Head Office, or act for a named location.
  const reqType = typeof args.requested?.type === "string" && args.requested.type
    ? args.requested.type : "headoffice";
  if (reqType === "headoffice") return { loc: { type: "headoffice", id: 1 } };
  if (reqType !== "warehouse" && reqType !== "outlet") {
    return { error: "Location must be Head Office, a warehouse or an outlet" };
  }
  const reqId = Number(args.requested?.id ?? 0);
  if (!Number.isInteger(reqId) || reqId <= 0) {
    return { error: `Select which ${reqType} this belongs to` };
  }
  const table = reqType === "outlet" ? "outlets" : "warehouses";
  const { rows: [row] } = await c.query(`SELECT id FROM ${table} WHERE id = $1 LIMIT 1`, [reqId]);
  if (!row) return { error: `${reqType === "outlet" ? "Outlet" : "Warehouse"} #${reqId} does not exist` };
  return { loc: { type: reqType, id: reqId } };
}
