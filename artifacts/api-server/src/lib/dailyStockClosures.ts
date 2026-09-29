import type { PgPool as Pool } from "@workspace/db";
import { isIsoDate } from "./dateInput";

export const STOCK_DAILY_CLOSE_LOCK_KEY = "stock_daily_close_global";

type QueryResult<Row = Record<string, unknown>> = {
  rows: Row[];
  rowCount?: number | null;
};

type Queryable = {
  query: (...args: any[]) => Promise<QueryResult<any>>;
};

type Client = Queryable & {
  release?: () => void;
};

const BASELINE_TABLE = "stock_daily_close_baseline";
const BASELINE_ENTRIES_TABLE = "stock_daily_close_baseline_entries";
const RUNS_TABLE = "stock_daily_close_runs";
const ENTRIES_TABLE = "stock_daily_close_entries";

function domainError(message: string, code: string, statusCode: number) {
  return Object.assign(new Error(message), { code, statusCode, status: statusCode });
}

function validTimeZone(raw: unknown): string {
  const candidate = String(raw ?? "").trim() || "Asia/Kolkata";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: candidate }).format();
    return candidate;
  } catch {
    return "Asia/Kolkata";
  }
}

async function companyTimeZone(db: Queryable): Promise<string> {
  const { rows: [settings] } = await db.query(
    `SELECT general_settings FROM company_settings LIMIT 1`,
  );
  const general = settings?.general_settings as Record<string, unknown> | null | undefined;
  return validTimeZone(general?.timeZone);
}

async function companyToday(db: Queryable, timeZone: string): Promise<string> {
  const { rows: [row] } = await db.query(
    `SELECT (clock_timestamp() AT TIME ZONE $1)::date::text AS company_today`,
    [timeZone],
  );
  const today = String(row?.company_today ?? "");
  if (!isIsoDate(today)) {
    throw new Error("Could not resolve the current company-local business date.");
  }
  return today;
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

async function lockCloseState(db: Queryable): Promise<void> {
  await db.query(
    `SELECT pg_advisory_xact_lock(hashtext($1))`,
    [STOCK_DAILY_CLOSE_LOCK_KEY],
  );
}

async function readBaselineAndClosedThrough(db: Queryable): Promise<{
  baselineDate: string;
  baselineTimeZone: string;
  baselineLedgerId: string;
  closedThrough: string | null;
}> {
  const { rows: [state] } = await db.query(
    `SELECT b.baseline_date::text AS baseline_date,
            b.time_zone AS baseline_time_zone,
            b.baseline_ledger_id::text AS baseline_ledger_id,
            (SELECT MAX(r.close_date)::text
               FROM ${RUNS_TABLE} r
              WHERE r.completed_at IS NOT NULL) AS closed_through
       FROM ${BASELINE_TABLE} b
      WHERE b.id = 1`,
  );
  if (!state?.baseline_date) {
    throw domainError(
      "The future-only stock baseline is not available; stock writes are paused until it is established.",
      "STOCK_DAILY_BASELINE_MISSING",
      503,
    );
  }
  return {
    baselineDate: String(state.baseline_date),
    baselineTimeZone: String(state.baseline_time_zone),
    baselineLedgerId: String(state.baseline_ledger_id),
    closedThrough: state.closed_through == null ? null : String(state.closed_through),
  };
}

/**
 * Close every elapsed company-local stock day. The snapshot source is the
 * committed stock_entries state, never a reconstruction of older ledger rows.
 * If catch-up spans multiple dates, it proceeds only when there was no later
 * stock movement after the first missing date; otherwise the exact older
 * quantity cannot be independently established and the close fails closed.
 */
export async function ensureDailyStockClosures(pool: Pool): Promise<{ closedDates: number; throughDate: string | null }> {
  const cached = cachedCloseCheck();
  if (cached) return cached;
  const client = await pool.connect() as unknown as Client;
  let inTransaction = false;
  try {
    await client.query("BEGIN");
    inTransaction = true;
    await lockCloseState(client);

    const timeZone = await companyTimeZone(client);
    const today = await companyToday(client, timeZone);
    const throughDate = addDays(today, -1);
    const { baselineDate, baselineTimeZone, baselineLedgerId, closedThrough } = await readBaselineAndClosedThrough(client);
    if (timeZone !== baselineTimeZone) {
      throw domainError(
        `The company timezone changed from ${baselineTimeZone} to ${timeZone} after the stock baseline. Daily closes and stock writes are paused until the baseline policy is reviewed.`,
        "STOCK_DAILY_TIMEZONE_CHANGED",
        503,
      );
    }
    const firstDueDate = closedThrough ? addDays(closedThrough, 1) : baselineDate;
    if (throughDate < firstDueDate) {
      await client.query("COMMIT");
      inTransaction = false;
      lastSuccessfulCheckAt = Date.now();
      lastSuccessfulCompanyDay = today;
      lastSuccessfulTimeZone = timeZone;
      lastKnownClosedThrough = closedThrough;
      return { closedDates: 0, throughDate: closedThrough };
    }

    // A catch-up may safely materialize multiple dates only if quantities did
    // not move after the first missing date. Otherwise current stock cannot
    // prove an earlier close without relying on the historical ledger rollup.
    const { rows: [movement] } = await client.query(
      `SELECT MAX((sl.created_at AT TIME ZONE $1)::date)::text AS last_movement_date
         FROM stock_ledger sl
        WHERE sl.id > $2::bigint
          AND sl.qty_change::numeric <> 0
          AND (sl.created_at AT TIME ZONE $1)::date > $3::date`,
      [timeZone, baselineLedgerId, firstDueDate],
    );
    if (movement?.last_movement_date) {
      throw domainError(
        `Daily stock close is overdue from ${firstDueDate}; a later stock movement exists on ${movement.last_movement_date}. No historical quantity was reconstructed, so the close remains unverified.`,
        "STOCK_DAILY_CLOSE_GAP",
        503,
      );
    }

    // Detect stock-entry mutations that bypassed the transactional ledger
    // writer after the baseline. A mismatch leaves the close incomplete.
    const { rows: [reconciliation] } = await client.query(
      `WITH keys AS (
         SELECT material_type, ref_id, branch_type, branch_id
           FROM ${BASELINE_ENTRIES_TABLE}
         UNION
         SELECT material_type, ref_id, branch_type, branch_id
           FROM stock_ledger
          WHERE id > $1::bigint
         UNION
         SELECT material_type, item_id AS ref_id, branch_type, branch_id
           FROM stock_entries
       ),
       expected AS (
         SELECT k.material_type, k.ref_id, k.branch_type, k.branch_id,
                COALESCE(b.quantity, 0)::numeric
                + COALESCE(SUM(sl.qty_change::numeric), 0)::numeric AS quantity
           FROM keys k
           LEFT JOIN ${BASELINE_ENTRIES_TABLE} b
             ON b.material_type = k.material_type AND b.ref_id = k.ref_id
            AND b.branch_type = k.branch_type AND b.branch_id = k.branch_id
           LEFT JOIN stock_ledger sl
             ON sl.material_type = k.material_type AND sl.ref_id = k.ref_id
            AND sl.branch_type = k.branch_type AND sl.branch_id = k.branch_id
            AND sl.id > $1::bigint
          GROUP BY k.material_type, k.ref_id, k.branch_type, k.branch_id, b.quantity
       ),
       actual AS (
         SELECT material_type, item_id AS ref_id, branch_type, branch_id,
                quantity::numeric AS quantity
           FROM stock_entries
       )
       SELECT COUNT(*)::int AS mismatch_count
         FROM expected e
         FULL OUTER JOIN actual a
           ON a.material_type = e.material_type AND a.ref_id = e.ref_id
          AND a.branch_type = e.branch_type AND a.branch_id = e.branch_id
        WHERE COALESCE(e.quantity, 0)::numeric <> COALESCE(a.quantity, 0)::numeric`,
      [baselineLedgerId],
    );
    const mismatchCount = Number(reconciliation?.mismatch_count ?? 0);
    if (mismatchCount > 0) {
      throw domainError(
        `The future stock stream differs from current stock for ${mismatchCount} product/location key(s). Daily closes remain unverified until the stock discrepancy is resolved.`,
        "STOCK_DAILY_CLOSE_RECONCILIATION",
        503,
      );
    }

    await client.query(
      `INSERT INTO ${RUNS_TABLE} (close_date, time_zone, baseline_date)
       SELECT dates.close_date::date, $3, $4::date
         FROM generate_series($1::date, $2::date, interval '1 day') AS dates(close_date)
       ON CONFLICT (close_date) DO NOTHING`,
      [firstDueDate, throughDate, timeZone, baselineDate],
    );
    const { rows: [pending] } = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM ${RUNS_TABLE}
        WHERE close_date BETWEEN $1::date AND $2::date
          AND completed_at IS NULL`,
      [firstDueDate, throughDate],
    );
    const pendingDates = Number(pending?.count ?? 0);

    if (pendingDates > 0) {
      // One SQL statement materializes the complete daily key set; no ledger
      // rows are loaded or iterated in application memory.
      await client.query(
        `WITH due_dates AS (
           SELECT close_date
             FROM ${RUNS_TABLE}
            WHERE close_date BETWEEN $1::date AND $2::date
              AND completed_at IS NULL
         ),
         keys AS (
           SELECT material_type, ref_id, branch_type, branch_id
             FROM ${BASELINE_ENTRIES_TABLE}
           UNION
           SELECT material_type, item_id AS ref_id, branch_type, branch_id
             FROM stock_entries
           UNION
           SELECT material_type, ref_id, branch_type, branch_id
             FROM stock_ledger
            WHERE id > $3::bigint
         ),
         current_stock AS (
           SELECT material_type, item_id AS ref_id, branch_type, branch_id,
                  quantity::numeric AS quantity
             FROM stock_entries
         )
         INSERT INTO ${ENTRIES_TABLE}
           (close_date, material_type, ref_id, branch_type, branch_id, quantity)
         SELECT d.close_date, k.material_type, k.ref_id, k.branch_type, k.branch_id,
                COALESCE(s.quantity, 0)::numeric
           FROM due_dates d
           CROSS JOIN keys k
           LEFT JOIN current_stock s
             ON s.material_type = k.material_type AND s.ref_id = k.ref_id
            AND s.branch_type = k.branch_type AND s.branch_id = k.branch_id`,
        [firstDueDate, throughDate, baselineLedgerId],
      );
      await client.query(
        `UPDATE ${RUNS_TABLE} r
            SET snapshot_rows = (
                  SELECT COUNT(*)::int FROM ${ENTRIES_TABLE} e
                   WHERE e.close_date = r.close_date
                ),
                completed_at = clock_timestamp()
          WHERE r.close_date BETWEEN $1::date AND $2::date
            AND r.completed_at IS NULL`,
        [firstDueDate, throughDate],
      );
    }

    const { rows: [closed] } = await client.query(
      `SELECT COUNT(*)::int AS count, MAX(close_date)::text AS through_date
         FROM ${RUNS_TABLE}
        WHERE close_date BETWEEN $1::date AND $2::date
          AND completed_at IS NOT NULL`,
      [firstDueDate, throughDate],
    );
    const closedDates = Number(closed?.count ?? 0);
    await client.query("COMMIT");
    inTransaction = false;
    lastSuccessfulCheckAt = Date.now();
    lastSuccessfulCompanyDay = today;
    lastSuccessfulTimeZone = timeZone;
    lastKnownClosedThrough = closed?.through_date == null ? throughDate : String(closed.through_date);
    return {
      closedDates,
      throughDate: lastKnownClosedThrough,
    };
  } catch (error) {
    if (inTransaction) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release?.();
  }
}

/**
 * Every stock-ledger writer must call this with its transaction client before
 * committing. It serializes the movement against close capture and refuses
 * writes before the baseline, on closed dates, or while a due close is missing.
 */
async function assertDateSetOpenLocked(
  db: Queryable,
  dates: Array<string | null | undefined>,
): Promise<{ timeZone: string; today: string; normalizedDates: string[] }> {
  const timeZone = await companyTimeZone(db);
  const today = await companyToday(db, timeZone);
  const { baselineDate, baselineTimeZone, closedThrough } = await readBaselineAndClosedThrough(db);
  if (timeZone !== baselineTimeZone) {
    throw domainError(
      `The company timezone changed from ${baselineTimeZone} to ${timeZone} after the stock baseline. Daily closes and stock writes are paused until the baseline policy is reviewed.`,
      "STOCK_DAILY_TIMEZONE_CHANGED",
      503,
    );
  }
  const dueThrough = addDays(today, -1);
  const closePending = dueThrough >= baselineDate && (!closedThrough || closedThrough < dueThrough);

  const normalizedDates = dates.map((value) => {
    const date = value == null ? today : String(value);
    if (!isIsoDate(date)) throw new Error("Invalid stock business date");
    if (date < baselineDate) {
      throw domainError(
        `Stock changes dated before the new baseline (${baselineDate}) are not supported. Use a current-date correction.`,
        "STOCK_DATE_BEFORE_BASELINE",
        409,
      );
    }
    if (closedThrough && date <= closedThrough) {
      throw domainError(
        `Stock date ${date} is closed through ${closedThrough}. Backdated changes on closed dates are blocked; use a current-date correction.`,
        "STOCK_DAILY_DATE_CLOSED",
        409,
      );
    }
    if (closePending && date <= dueThrough) {
      throw domainError(
        `Daily stock close is pending through ${dueThrough}; backdated changes in that unverified interval are blocked. Current-date corrections remain available.`,
        "STOCK_DAILY_CLOSE_REQUIRED",
        409,
      );
    }
    return date;
  });
  return { timeZone, today, normalizedDates };
}

export async function assertStockDatesOpen(
  db: Queryable,
  dates: Array<string | null | undefined>,
): Promise<{ timeZone: string; today: string; normalizedDates: string[] }> {
  await lockCloseState(db);
  return assertDateSetOpenLocked(db, dates);
}

/**
 * A document-date edit rewrites existing ledger rows as well as assigning the
 * new date. Both sides must still be open; moving a closed movement forward
 * would otherwise rewrite history while appearing to be a current correction.
 */
export async function assertStockLedgerRestatementOpen(
  db: Queryable,
  docType: string,
  docId: number,
  newDate: string,
): Promise<void> {
  await lockCloseState(db);
  const { rows } = await db.query(
    `SELECT DISTINCT txn_date::text AS txn_date
       FROM stock_ledger
      WHERE doc_type = $1 AND doc_id = $2`,
    [docType, docId],
  );
  await assertDateSetOpenLocked(
    db,
    [newDate, ...rows.map((row: { txn_date: string | null }) => row.txn_date)],
  );
}

let scheduler: NodeJS.Timeout | null = null;
const CLOSE_CHECK_CACHE_MS = 15_000;
let lastSuccessfulCheckAt = 0;
let lastSuccessfulCompanyDay = "";
let lastSuccessfulTimeZone = "Asia/Kolkata";
let lastKnownClosedThrough: string | null = null;

function localDay(timeZone: string): string {
  return new Date().toLocaleDateString("en-CA", { timeZone });
}

function cachedCloseCheck(): { closedDates: number; throughDate: string | null } | null {
  if (!lastSuccessfulCheckAt || Date.now() - lastSuccessfulCheckAt >= CLOSE_CHECK_CACHE_MS) return null;
  try {
    if (localDay(lastSuccessfulTimeZone) === lastSuccessfulCompanyDay) {
      return { closedDates: 0, throughDate: lastKnownClosedThrough };
    }
  } catch {
    // A timezone change or invalid cached value forces a fresh database check.
  }
  return null;
}

export function startDailyStockCloseScheduler(pool: Pool): void {
  if (scheduler) return;
  const tick = async () => {
    try {
      const result = await ensureDailyStockClosures(pool);
      if (result.closedDates > 0) {
        console.log(`[stock-close] closed ${result.closedDates} day(s) through ${result.throughDate}`);
      }
    } catch (error) {
      console.error("[stock-close] daily close failed; dates remain unverified:", error);
    }
  };
  void tick();
  scheduler = setInterval(() => void tick(), 60 * 1000);
  scheduler.unref?.();
}