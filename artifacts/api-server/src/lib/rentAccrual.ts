import { pool as _pool } from "@workspace/db";

/** The shared pg pool, typed structurally so these helpers stay injectable. */
type Pool = typeof _pool;

/**
 * Daily rent accrual.
 *
 * Rent is recognised as it is incurred, not when it is paid: every day each
 * active agreement books `monthly_rent / days_in_month` as expense against the
 * warehouse's Rent Payable. Approval and payment settle that liability later and
 * never touch the expense — so the P&L shows the rent that belongs to the period
 * regardless of whether anyone has paid yet.
 *
 * Two things make this safe to run on a timer:
 *
 *  - It is a **catch-up**, not a tick. It accrues every missing day between the
 *    agreement start and today, so a server that was asleep for a week produces
 *    the same result as one that ran every night.
 *  - It is **idempotent**, guaranteed by the unique index on
 *    (warehouse_id, accrual_date) rather than by remembering when it last ran.
 *    Running it twice in a minute cannot double-charge a day.
 */

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** pg hands back a JS Date for `date` columns; normalise to a YYYY-MM-DD string. */
function ymd(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) {
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, "0");
    const d = String(v.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

const parse = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return { y: y!, m: m!, d: d! };
};

const addDays = (s: string, n: number): string => {
  const { y, m, d } = parse(s);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return ymd(dt)!;
};

const minDate = (...xs: (string | null)[]) => xs.filter(Boolean).sort()[0] as string | undefined;
const maxDate = (...xs: (string | null)[]) => xs.filter(Boolean).sort().pop() as string | undefined;

export interface RentAgreementRow {
  warehouse_id: number;
  monthly_rent: string | number;
  start_date: unknown;
  end_date: unknown;
  status: string;
  inactive_from: unknown;
}

export type RentAccrualTerms = Pick<
  RentAgreementRow,
  "monthly_rent" | "start_date" | "end_date" | "status" | "inactive_from"
>;

/** These are the agreement fields that can change the amount or covered days. */
export function rentAccrualTermsChanged(before: RentAccrualTerms, after: RentAccrualTerms): boolean {
  return Math.abs(Number(before.monthly_rent) - Number(after.monthly_rent)) > 0.000001
    || ymd(before.start_date) !== ymd(after.start_date)
    || ymd(before.end_date) !== ymd(after.end_date)
    || before.status !== after.status
    || ymd(before.inactive_from) !== ymd(after.inactive_from);
}

export const RENT_COVERAGE_TOLERANCE = 0.01;

/** Accept only a penny of rounding variance; larger shortfalls and excesses are both unsafe. */
export function rentCoverageMatches(expected: number, accrued: number): boolean {
  return Math.abs(accrued - expected) <= RENT_COVERAGE_TOLERANCE + 1e-9;
}

/**
 * The last date an agreement can accrue: bounded by its end date and, if it has
 * been switched off, by the day before it went inactive. Historical accruals are
 * never removed — going inactive only stops future days.
 */
function coverageEnd(a: RentAgreementRow, asOf: string): string | undefined {
  const inactiveFrom = ymd(a.inactive_from);
  return minDate(
    asOf,
    ymd(a.end_date),
    a.status !== "active" && inactiveFrom ? addDays(inactiveFrom, -1) : null,
  );
}

export interface AccrualResult {
  daysAccrued: number;
  warehousesTouched: number;
  totalAmount: number;
}

/** Anything that can run a query — the pool, or a client inside a transaction. */
export type Querier = {
  query: <T = any>(text: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount: number | null }>;
};

const monthKey = (year: number, month: number) => `${year}-${month}`;

/**
 * Three writers touch one warehouse's accruals: the hourly sweep, a rent
 * revision, and approval. The revision deletes a month and rebuilds it, so a
 * sweep that interleaves between the two halves would re-create those days from
 * the agreement it read before the change — leaving one month carrying two
 * different daily rates. Serialising per warehouse costs nothing (no two writers
 * ever want the same warehouse) and removes the whole class of interleaving.
 */
const LOCK_CLASS = 8202;

/** Take the per-warehouse accrual lock for the rest of the caller's transaction. */
export async function lockRentAccrual(q: Querier, warehouseId: number): Promise<void> {
  await q.query(`SELECT pg_advisory_xact_lock($1::int, $2::int)`, [LOCK_CLASS, warehouseId]);
}

/** Run `fn` in a transaction holding that warehouse's accrual lock. */
export async function withWarehouseRentLock<T>(
  pool: Pool,
  warehouseId: number,
  fn: (q: Querier) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockRentAccrual(client as unknown as Querier, warehouseId);
    const out = await fn(client as unknown as Querier);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Warehouse-months already signed off, which no writer may touch again.
 *
 * Two things freeze a month, and both are unioned: the warehouse's own
 * approved/paid rent period (the original contract), and an accounting-period
 * lock on that calendar month. A locked accounting period is frozen for
 * automation exactly like an approved period — the sweep and the revision
 * rebuild must not accrue or delete a day inside it — so both sets flow into
 * the same `locked` guard the walk already respects.
 */
async function lockedRentMonths(q: Querier, warehouseId: number): Promise<Set<string>> {
  const { rows } = await q.query<{ year: number; month: number }>(
    `SELECT year, month FROM rent_periods
      WHERE warehouse_id = $1 AND status IN ('approved', 'paid')`,
    [warehouseId],
  );
  const set = new Set(rows.map((r) => monthKey(Number(r.year), Number(r.month))));
  const { rows: apRows } = await q.query<{ year: number; month: number }>(
    `SELECT year, month FROM accounting_period_locks`,
  );
  for (const r of apRows) set.add(monthKey(Number(r.year), Number(r.month)));
  return set;
}

/**
 * Accrue every outstanding day up to and including `asOf` (default: today).
 *
 * `monthly_rent / days_in_month` does not divide evenly (₹30,000 over 31 days is
 * ₹967.74, and 31 of those is ₹29,999.94). The last day an agreement covers in a
 * month therefore absorbs the rounding remainder, so a fully-covered month
 * totals the monthly rent to the paisa. The "last covered day" is derived from
 * the agreement and the calendar — never from today — otherwise accruing
 * mid-month would dump the whole remainder onto the current day.
 */
export async function runRentAccrual(
  pool: Pool,
  opts: { asOf?: string; warehouseId?: number; fromDate?: string } = {},
): Promise<AccrualResult> {
  const asOf = opts.asOf ?? ymd(new Date())!;

  const params: unknown[] = [];
  let only = "";
  if (opts.warehouseId !== undefined) {
    params.push(opts.warehouseId);
    only = ` AND warehouse_id = $${params.length}`;
  }

  const { rows: candidates } = await pool.query<{ warehouse_id: number }>(
    // Switched-off agreements stay in the sweep. They are bounded to the day
    // before they went inactive by coverageEnd(), so they cannot accrue past
    // their stop date — but any day missed BEFORE that (a restart, downtime, or
    // a deactivation that landed before the hourly catch-up ran) is still
    // recoverable. Filtering them out here would silently drop that expense
    // forever, which is the one failure this scheduler exists to prevent.
    // Rows that never accrued at all (auto-registered, inactive, no stop date)
    // are excluded: there is nothing to catch up.
    `SELECT warehouse_id
       FROM warehouse_rent_agreements
      WHERE monthly_rent > 0 AND start_date IS NOT NULL
        AND (status = 'active' OR inactive_from IS NOT NULL)${only}`,
    params,
  );

  const result: AccrualResult = { daysAccrued: 0, warehousesTouched: 0, totalAmount: 0 };

  for (const candidate of candidates) {
    const warehouseId = Number(candidate.warehouse_id);
    const per = await withWarehouseRentLock(pool, warehouseId, (q) =>
      runRentAccrualLocked(q, warehouseId, { asOf, fromDate: opts.fromDate }),
    );
    if (per.days > 0) {
      result.daysAccrued += per.days;
      result.totalAmount = round2(result.totalAmount + per.total);
      result.warehousesTouched++;
    }
  }

  return result;
}

/**
 * Catch up one warehouse while the caller already holds its rent advisory lock
 * and transaction. The agreement is deliberately re-read only after that lock:
 * a sweep which queued behind a PATCH must use the new terms, never its stale
 * candidate row from before it waited.
 */
export async function runRentAccrualLocked(
  q: Querier,
  warehouseId: number,
  opts: { asOf?: string; fromDate?: string } = {},
): Promise<{ days: number; total: number }> {
  const { rows: [agreement] } = await q.query<RentAgreementRow>(
    `SELECT warehouse_id, monthly_rent, start_date, end_date, status, inactive_from
       FROM warehouse_rent_agreements
      WHERE warehouse_id = $1
        AND monthly_rent > 0 AND start_date IS NOT NULL
        AND (status = 'active' OR inactive_from IS NOT NULL)
      FOR UPDATE`,
    [warehouseId],
  );
  if (!agreement) return { days: 0, total: 0 };
  return accrueAgreement(q, agreement, { asOf: opts.asOf ?? ymd(new Date())!, fromDate: opts.fromDate });
}

/**
 * Accrue one agreement. The caller must already hold that warehouse's accrual
 * lock, which is what lets the revision path reuse this inside its own
 * transaction instead of calling the sweep and deadlocking against itself.
 */
async function accrueAgreement(
  q: Querier,
  a: RentAgreementRow,
  opts: { asOf: string; fromDate?: string },
): Promise<{ days: number; total: number }> {
  const startDate = ymd(a.start_date);
  const endCover = coverageEnd(a, opts.asOf);
  if (!startDate || !endCover || endCover < startDate) return { days: 0, total: 0 };

  const locked = await lockedRentMonths(q, a.warehouse_id);

  // Resume from the day after the newest accrual rather than rescanning from
  // the agreement start every run. Days inside an approved month are skipped
  // without writing anything, so the cursor still walks past them to the months
  // that follow.
  //
  // `fromDate` overrides that cursor, and a rebuild MUST pass it: the newest
  // accrual can belong to an approved month that sits AFTER the month being
  // rebuilt (August approved, July still pending), and the cursor would then
  // resume past July and leave the days just deleted gone for good. Existing days
  // are protected by the unique index, so an earlier start is safe.
  const { rows: [last] } = await q.query(
    `SELECT MAX(accrual_date) AS last FROM rent_accruals WHERE warehouse_id = $1`,
    [a.warehouse_id],
  );
  const cursor = opts.fromDate ?? (last?.last ? addDays(ymd(last.last)!, 1) : null);
  const resumeFrom = maxDate(startDate, cursor)!;
  if (resumeFrom > endCover) return { days: 0, total: 0 };

  const monthlyRent = Number(a.monthly_rent);
  let days = 0;
  let total = 0;

  for (let day = resumeFrom; day <= endCover; day = addDays(day, 1)) {
    const { y, m } = parse(day);
    // An approved or paid month is financially final: no day may be added to it,
    // even one that was genuinely missed. Backfilling would restate a signed-off
    // period behind the approver's back.
    if (locked.has(monthKey(y, m))) continue;

    const dim = daysInMonth(y, m);

    // Last day of THIS month that the agreement covers — independent of asOf.
    const monthEnd = `${y}-${String(m).padStart(2, "0")}-${String(dim).padStart(2, "0")}`;
    const inactiveFrom = ymd(a.inactive_from);
    const lastCoveredInMonth = minDate(
      monthEnd,
      ymd(a.end_date),
      a.status !== "active" && inactiveFrom ? addDays(inactiveFrom, -1) : null,
    )!;

    let amount: number;
    if (day === lastCoveredInMonth) {
      // Absorb the remainder so the covered span totals exactly.
      const { rows: [sofar] } = await q.query(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM rent_accruals
          WHERE warehouse_id = $1 AND year = $2 AND month = $3`,
        [a.warehouse_id, y, m],
      );
      amount = round2(
        expectedMonthTotal(a, monthlyRent, y, m) - Number(sofar?.total ?? 0),
      );
    } else {
      amount = round2(monthlyRent / dim);
    }

    if (amount <= 0) continue;

    const { rowCount } = await q.query(
      `INSERT INTO rent_accruals (warehouse_id, accrual_date, year, month, amount, monthly_rent, days_in_month)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (warehouse_id, accrual_date) DO NOTHING`,
      [a.warehouse_id, day, y, m, amount, monthlyRent, dim],
    );
    if (rowCount) {
      days++;
      total = round2(total + amount);

      // A period row exists as soon as the month has any accrual, so the
      // approval queue never has to guess which months are outstanding.
      await q.query(
        `INSERT INTO rent_periods (warehouse_id, year, month) VALUES ($1, $2, $3)
         ON CONFLICT (warehouse_id, year, month) DO NOTHING`,
        [a.warehouse_id, y, m],
      );
    }
  }

  return { days, total };
}

/** What a fully-covered month is worth under an agreement, pro-rated for part months. */
function expectedMonthTotal(
  a: RentAgreementRow,
  monthlyRent: number,
  year: number,
  month: number,
): number {
  const dim = daysInMonth(year, month);
  const mm = String(month).padStart(2, "0");
  const monthEnd = `${year}-${mm}-${String(dim).padStart(2, "0")}`;
  const inactiveFrom = ymd(a.inactive_from);
  const lastCovered = minDate(
    monthEnd,
    ymd(a.end_date),
    a.status !== "active" && inactiveFrom ? addDays(inactiveFrom, -1) : null,
  )!;
  const firstCovered = maxDate(`${year}-${mm}-01`, ymd(a.start_date))!;
  if (lastCovered < firstCovered) return 0;
  const coveredDays = Math.round(
    (Date.parse(`${lastCovered}T00:00:00Z`) - Date.parse(`${firstCovered}T00:00:00Z`)) / 86_400_000,
  ) + 1;
  return round2((monthlyRent * coveredDays) / dim);
}

/**
 * Whether a month has actually accrued everything the agreement says it is worth.
 *
 * `isPeriodAccrualComplete` answers "has the month finished?"; this answers "did
 * every day of it reach the books?". Both are needed before approval, because
 * approval freezes the month and rent — unlike payroll — has no true-up voucher
 * afterwards to make up a shortfall.
 */
export async function rentMonthCoverage(
  pool: Querier,
  warehouseId: number,
  year: number,
  month: number,
): Promise<{ expectedTotal: number; accruedTotal: number; complete: boolean }> {
  const { rows: [a] } = await pool.query<RentAgreementRow>(
    `SELECT warehouse_id, monthly_rent, start_date, end_date, status, inactive_from
       FROM warehouse_rent_agreements WHERE warehouse_id = $1`,
    [warehouseId],
  );
  const { rows: [sofar] } = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM rent_accruals
      WHERE warehouse_id = $1 AND year = $2 AND month = $3`,
    [warehouseId, year, month],
  );
  const accruedTotal = round2(Number(sofar?.total ?? 0));
  // No agreement row left to judge against: treat what is there as complete
  // rather than blocking approval on a figure that can no longer be derived.
  if (!a) return { expectedTotal: accruedTotal, accruedTotal, complete: true };
  const expectedTotal = expectedMonthTotal(a, Number(a.monthly_rent), year, month);
  return { expectedTotal, accruedTotal, complete: rentCoverageMatches(expectedTotal, accruedTotal) };
}

/**
 * Whether a warehouse-month has finished accruing — i.e. today is past the last
 * day that month could accrue. Approving a still-accruing month would freeze a
 * figure that is about to change, so the UI uses this to gate the action.
 */
export async function isPeriodAccrualComplete(
  pool: Querier,
  warehouseId: number,
  year: number,
  month: number,
  asOf?: string,
): Promise<boolean> {
  const today = asOf ?? ymd(new Date())!;
  const { rows: [a] } = await pool.query<RentAgreementRow>(
    `SELECT warehouse_id, monthly_rent, start_date, end_date, status, inactive_from
       FROM warehouse_rent_agreements WHERE warehouse_id = $1`,
    [warehouseId],
  );
  if (!a) return true;

  const dim = daysInMonth(year, month);
  const monthEnd = `${year}-${String(month).padStart(2, "0")}-${String(dim).padStart(2, "0")}`;
  const inactiveFrom = ymd(a.inactive_from);
  const lastCovered = minDate(
    monthEnd,
    ymd(a.end_date),
    a.status !== "active" && inactiveFrom ? addDays(inactiveFrom, -1) : null,
  )!;
  return today > lastCovered;
}

export interface RentRecalcResult {
  monthsRecalculated: Array<{ year: number; month: number }>;
  entriesReversed: number;
  entriesRegenerated: number;
  previousTotal: number;
  newTotal: number;
}

/**
 * Rebuild every unapproved month for one warehouse at its current rent.
 *
 * A mid-month rent revision does not create a second rate for the rest of the
 * month: the owner's rule is that an unapproved month is recalculated *in full*
 * at the revised amount, so July at ₹30,000 revised to ₹60,000 on the 25th
 * accrues all of July at ₹60,000. Approved and paid months are excluded, so a
 * revision can never restate a signed-off period.
 *
 * Deleting and regenerating rather than adjusting keeps one rule for what a day
 * is worth. Both halves run in ONE transaction under the warehouse's accrual
 * lock: the sweep must not slip in between them and rebuild the month from the
 * rent it read before the revision, and a failure must leave the old month intact
 * rather than a hole for the next hourly pass to notice.
 *
 * The rebuild starts from the earliest day it deleted, not from the sweep's usual
 * cursor: the newest surviving accrual may belong to a LATER approved month, and
 * the cursor would then resume past everything just removed.
 */
export async function recalcUnapprovedRentAccruals(
  pool: Pool,
  warehouseId: number,
  opts: { asOf?: string } = {},
): Promise<RentRecalcResult> {
  return withWarehouseRentLock(pool, warehouseId, (q) =>
    recalcUnapprovedRentAccrualsLocked(q, warehouseId, opts),
  );
}

/**
 * Rebuild while the caller already holds this warehouse's lock and transaction.
 * Only unapproved, accounting-open months are removed; signed-off months remain
 * available as immutable history even when new agreement terms would differ.
 */
export async function recalcUnapprovedRentAccrualsLocked(
  q: Querier,
  warehouseId: number,
  opts: { asOf?: string } = {},
): Promise<RentRecalcResult> {
  const asOf = opts.asOf ?? ymd(new Date())!;
  const { rows: removed } = await q.query<{
    amount: string; accrual_date: unknown; year: number; month: number;
  }>(
    `DELETE FROM rent_accruals r
      WHERE r.warehouse_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM rent_periods p
           WHERE p.warehouse_id = r.warehouse_id AND p.year = r.year AND p.month = r.month
             AND p.status IN ('approved', 'paid')
        )
        AND NOT EXISTS (
          SELECT 1 FROM accounting_period_locks l
           WHERE l.year = r.year AND l.month = r.month
        )
      RETURNING amount, accrual_date, year, month`,
    [warehouseId],
  );

  const seen = new Map<string, { year: number; month: number }>();
  let previousTotal = 0;
  let earliest: string | null = null;
  for (const r of removed) {
    previousTotal = round2(previousTotal + Number(r.amount));
    seen.set(monthKey(Number(r.year), Number(r.month)), { year: Number(r.year), month: Number(r.month) });
    const d = ymd(r.accrual_date);
    if (d && (!earliest || d < earliest)) earliest = d;
  }

  // The PATCH has already written the revised agreement inside the same
  // transaction. Re-read it under the lock so no stale terms can leak into the
  // regeneration.
  const { rows: [a] } = await q.query<RentAgreementRow>(
    `SELECT warehouse_id, monthly_rent, start_date, end_date, status, inactive_from
       FROM warehouse_rent_agreements WHERE warehouse_id = $1 FOR UPDATE`,
    [warehouseId],
  );
  const eligible = a && Number(a.monthly_rent) > 0 && ymd(a.start_date)
    && (a.status === "active" || a.inactive_from);
  const regenerated = eligible
    ? await accrueAgreement(q, a!, {
        asOf,
        // Start from the current agreement boundary, not just the earliest row
        // removed: a revised start date or a previously missed day can precede
        // the first surviving accrual. The walk skips approved and accounting-
        // locked months, so replaying the full eligible range is safe.
        fromDate: minDate(earliest, ymd(a!.start_date)),
      })
    : { days: 0, total: 0 };

  return {
    monthsRecalculated: [...seen.values()].sort((x, y) => x.year - y.year || x.month - y.month),
    entriesReversed: removed.length,
    entriesRegenerated: regenerated.days,
    previousTotal,
    newTotal: regenerated.total,
  };
}

/** The per-day figure a monthly amount produces in a given month. */
export const dailyRentRate = (monthly: number, year: number, month: number) =>
  round2(monthly / daysInMonth(year, month));

let timer: NodeJS.Timeout | null = null;

/**
 * Run the accrual now, then hourly.
 *
 * Hourly rather than a single midnight alarm: the run is a cheap idempotent
 * catch-up, and an hourly cadence means a restart, a clock change or a few hours
 * of downtime all self-heal on the next pass instead of silently losing a day.
 */
export function startRentAccrualScheduler(pool: Pool): void {
  if (timer) return;
  const tick = async () => {
    try {
      const r = await runRentAccrual(pool);
      if (r.daysAccrued > 0) {
        console.log(
          `[rent] accrued ${r.daysAccrued} day(s) across ${r.warehousesTouched} warehouse(s), total ${r.totalAmount}`,
        );
      }
    } catch (e) {
      console.error("[rent] accrual run failed:", e);
    }
  };
  void tick();
  timer = setInterval(tick, 60 * 60 * 1000);
  timer.unref?.();
}
