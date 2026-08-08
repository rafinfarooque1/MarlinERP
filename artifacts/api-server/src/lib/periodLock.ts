/**
 * Accounting-period (month) locking.
 *
 * A month is OPEN unless a row exists in accounting_period_locks — locking is
 * the exception, so absence-of-row = open and no backfill is ever needed.
 * Only an Administrator (hierarchy level 1) may lock or unlock, via
 * routes/periods.ts; every lock/unlock is recorded in period_lock_events.
 *
 * EVERY write path that creates, edits or deletes a dated financial record
 * must call one of the assert helpers below with the record's BUSINESS date
 * (sale_date, purchase_date, voucher_date, payment_date, return_date,
 * production_date, transfer_date, payroll month, …) — and for edits, with
 * BOTH the stored row's date and the incoming date, so a record can neither
 * be changed inside a locked month nor moved into or out of one.
 *
 * Background jobs (accrual sweeps, B2C→B2B reclassification, resequencing)
 * must check isMonthLocked / filter with lockedMonthsAmong before touching
 * rows — a locked month is frozen for automation too, not just for users.
 */

/** Anything with a .query(text, params) method — pg Pool or a transaction client. */
export type Queryable = { query: (text: string, params?: any[]) => Promise<any> };

export const MONTH_LOCKED_MESSAGE =
  "This month is locked. Transactions in a locked month cannot be modified. Contact an Administrator to unlock the month.";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function monthLabel(year: number, month: number): string {
  return `${MONTH_NAMES[(month - 1 + 12) % 12] ?? month} ${year}`;
}

export class PeriodLockedError extends Error {
  readonly statusCode = 423;
  readonly code = "MONTH_LOCKED";
  readonly year: number;
  readonly month: number;
  /** What was being attempted, for logs — never shown to the user. */
  readonly context?: string;

  constructor(year: number, month: number, context?: string) {
    super(MONTH_LOCKED_MESSAGE);
    this.name = "PeriodLockedError";
    this.year = year;
    this.month = month;
    this.context = context;
  }
}

export function isPeriodLockedError(err: unknown): err is PeriodLockedError {
  return err instanceof PeriodLockedError;
}

export function periodLockedBody(err: PeriodLockedError): Record<string, unknown> {
  return {
    error: err.message,
    code: err.code,
    month: `${err.year}-${String(err.month).padStart(2, "0")}`,
    monthLabel: monthLabel(err.year, err.month),
  };
}

/**
 * Standard catch-branch helper: returns true (and sends the 423) when the
 * error is a period lock, false otherwise so the route's own handling runs.
 *
 *   } catch (err) {
 *     if (handlePeriodLocked(res, err)) return;
 *     …existing handling…
 */
export function handlePeriodLocked(
  res: { status: (n: number) => { json: (b: unknown) => unknown } },
  err: unknown,
): boolean {
  if (isPeriodLockedError(err)) {
    res.status(err.statusCode).json(periodLockedBody(err));
    return true;
  }
  return false;
}

/**
 * Extract {year, month} from a business date. Accepts the 'YYYY-MM-DD…'
 * strings used in request bodies AND the JS Date objects pg returns for
 * date/timestamptz columns (see pg-gotchas). Returns null for blank/invalid
 * input — callers treat that as "nothing to check" (their own date
 * validation rejects bad input separately).
 */
export function ymOfDate(d: string | Date | null | undefined): { year: number; month: number } | null {
  if (d == null) return null;
  const s = d instanceof Date ? (isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10)) : String(d).trim();
  const m = /^(\d{4})-(\d{1,2})/.exec(s);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!Number.isInteger(year) || month < 1 || month > 12) return null;
  return { year, month };
}

export async function isMonthLocked(q: Queryable, year: number, month: number): Promise<boolean> {
  const { rows } = await q.query(
    `SELECT 1 FROM accounting_period_locks WHERE year = $1 AND month = $2`,
    [year, month],
  );
  return rows.length > 0;
}

/** Throw PeriodLockedError if (year, month) is locked. */
export async function assertMonthOpen(
  q: Queryable,
  year: number,
  month: number,
  context?: string,
): Promise<void> {
  if (await isMonthLocked(q, year, month)) {
    throw new PeriodLockedError(year, month, context);
  }
}

/**
 * Throw PeriodLockedError if the month containing `date` is locked.
 * Null/blank/invalid dates are a no-op — the route's own validation owns
 * rejecting those.
 */
export async function assertDateOpen(
  q: Queryable,
  date: string | Date | null | undefined,
  context?: string,
): Promise<void> {
  const ym = ymOfDate(date);
  if (!ym) return;
  await assertMonthOpen(q, ym.year, ym.month, context);
}

/**
 * Check several business dates in ONE query (deduplicated by month).
 * Use for edits (old date + new date), for documents whose side effects carry
 * their own dates (sale + payment), and for date ranges (leave spans).
 */
export async function assertDatesOpen(
  q: Queryable,
  dates: Array<string | Date | null | undefined>,
  context?: string,
): Promise<void> {
  const seen = new Map<string, { year: number; month: number }>();
  for (const d of dates) {
    const ym = ymOfDate(d);
    if (ym) seen.set(`${ym.year}-${ym.month}`, ym);
  }
  if (seen.size === 0) return;
  const list = [...seen.values()];
  const { rows } = await q.query(
    `SELECT year, month FROM accounting_period_locks
      WHERE (year, month) IN (${list.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(", ")})
      ORDER BY year, month LIMIT 1`,
    list.flatMap((ym) => [ym.year, ym.month]),
  );
  if (rows.length > 0) {
    throw new PeriodLockedError(Number(rows[0].year), Number(rows[0].month), context);
  }
}

/** The 423 response body for a locked month — for in-transaction call sites. */
export function monthLockedBody(year: number, month: number): Record<string, unknown> {
  return periodLockedBody(new PeriodLockedError(year, month));
}

/**
 * Route-level pre-check: sends the 423 and returns true when any of the given
 * business dates falls in a locked month. Use BEFORE opening a transaction:
 *
 *   if (await respondIfMonthLocked(res, pool, [saleDate])) return;
 */
export async function respondIfMonthLocked(
  res: { status: (n: number) => { json: (b: unknown) => unknown } },
  q: Queryable,
  dates: Array<string | Date | null | undefined>,
  context?: string,
): Promise<boolean> {
  try {
    await assertDatesOpen(q, dates, context);
    return false;
  } catch (err) {
    if (handlePeriodLocked(res, err)) return true;
    throw err;
  }
}

/**
 * For batch operations (imports, sweeps): which of these dates fall in locked
 * months? Returns the set of locked 'YYYY-MM' keys among the input dates.
 */
export async function lockedMonthsAmong(
  q: Queryable,
  dates: Array<string | Date | null | undefined>,
): Promise<Set<string>> {
  const seen = new Map<string, { year: number; month: number }>();
  for (const d of dates) {
    const ym = ymOfDate(d);
    if (ym) seen.set(`${ym.year}-${String(ym.month).padStart(2, "0")}`, ym);
  }
  const out = new Set<string>();
  if (seen.size === 0) return out;
  const list = [...seen.entries()];
  const { rows } = await q.query(
    `SELECT year, month FROM accounting_period_locks
      WHERE (year, month) IN (${list.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(", ")})`,
    list.flatMap(([, ym]) => [ym.year, ym.month]),
  );
  for (const r of rows) {
    out.add(`${Number(r.year)}-${String(Number(r.month)).padStart(2, "0")}`);
  }
  return out;
}

/** All locked months, newest first — for the admin UI and client pre-checks. */
export async function listLockedMonths(
  q: Queryable,
): Promise<Array<{ year: number; month: number; lockedBy: string; lockedAt: string }>> {
  const { rows } = await q.query(
    `SELECT year, month, locked_by, locked_at FROM accounting_period_locks ORDER BY year DESC, month DESC`,
  );
  return rows.map((r: any) => ({
    year: Number(r.year),
    month: Number(r.month),
    lockedBy: String(r.locked_by ?? ""),
    lockedAt: r.locked_at instanceof Date ? r.locked_at.toISOString() : String(r.locked_at),
  }));
}
