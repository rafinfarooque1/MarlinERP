import type { PgPool as Pool } from "@workspace/db";
import { STOCK_DAILY_CLOSE_LOCK_KEY } from "../lib/dailyStockClosures";

const MIGRATION_NAME = "stock_daily_closures_baseline_v1";

function resolveTimeZone(raw: unknown): string {
  const candidate = String(raw ?? "").trim() || "Asia/Kolkata";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: candidate }).format();
    return candidate;
  } catch {
    return "Asia/Kolkata";
  }
}

/**
 * Additive future-only daily quantity evidence. Historical stock is not
 * reconstructed. The baseline and all existing stock rows are preserved.
 */
export async function addStockDailyClosures(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TABLE IF NOT EXISTS stock_daily_close_baseline (
        id                  SMALLINT PRIMARY KEY CHECK (id = 1),
        baseline_date       DATE NOT NULL,
        time_zone           TEXT NOT NULL,
        baseline_ledger_id  BIGINT NOT NULL,
        baseline_rows       INTEGER NOT NULL,
        captured_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      );

      CREATE TABLE IF NOT EXISTS stock_daily_close_baseline_entries (
        material_type TEXT NOT NULL,
        ref_id        INTEGER NOT NULL,
        branch_type   TEXT NOT NULL,
        branch_id     INTEGER NOT NULL,
        quantity      NUMERIC NOT NULL,
        PRIMARY KEY (material_type, ref_id, branch_type, branch_id)
      );

      CREATE TABLE IF NOT EXISTS stock_daily_close_runs (
        close_date    DATE PRIMARY KEY,
        time_zone     TEXT NOT NULL,
        baseline_date DATE NOT NULL,
        snapshot_rows INTEGER NOT NULL DEFAULT 0,
        completed_at  TIMESTAMPTZ,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS stock_daily_close_entries (
        close_date    DATE NOT NULL REFERENCES stock_daily_close_runs(close_date) ON DELETE RESTRICT,
        material_type TEXT NOT NULL,
        ref_id        INTEGER NOT NULL,
        branch_type   TEXT NOT NULL,
        branch_id     INTEGER NOT NULL,
        quantity      NUMERIC NOT NULL,
        PRIMARY KEY (close_date, material_type, ref_id, branch_type, branch_id)
      );

      CREATE INDEX IF NOT EXISTS idx_stock_daily_close_entries_key
        ON stock_daily_close_entries(material_type, ref_id, branch_type, branch_id, close_date);
    `);

    // Wait for any already-running stock writers, then freeze writes only while
    // the one-time baseline and ledger high-water mark are captured together.
    // These locks are held briefly and do not alter existing stock data.
    await client.query(`LOCK TABLE stock_entries IN SHARE MODE`);
    await client.query(`LOCK TABLE stock_ledger IN SHARE MODE`);
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [STOCK_DAILY_CLOSE_LOCK_KEY],
    );

    const { rows: existingBaseline } = await client.query(
      `SELECT id FROM stock_daily_close_baseline WHERE id = 1`,
    );
    const { rows: marker } = await client.query(
      `SELECT 1 FROM migration_log WHERE name = $1`,
      [MIGRATION_NAME],
    );
    if (marker.length > 0 && existingBaseline.length === 0) {
      throw new Error(`${MIGRATION_NAME} is marked complete but the baseline row is missing; refusing to fabricate a replacement.`);
    }

    if (existingBaseline.length === 0) {
      const { rows: [settings] } = await client.query(
        `SELECT general_settings FROM company_settings LIMIT 1`,
      );
      const general = settings?.general_settings as Record<string, unknown> | null | undefined;
      const timeZone = resolveTimeZone(general?.timeZone);
      const { rows: [dateRow] } = await client.query(
        `SELECT (clock_timestamp() AT TIME ZONE $1)::date::text AS baseline_date`,
        [timeZone],
      );
      const baselineDate = String(dateRow?.baseline_date ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(baselineDate)) {
        throw new Error("Could not establish the company-local stock baseline date.");
      }
      const { rows: [highWater] } = await client.query(
        `SELECT COALESCE(MAX(id), 0)::bigint::text AS ledger_id FROM stock_ledger`,
      );
      const { rows: [count] } = await client.query(
        `SELECT COUNT(*)::int AS row_count FROM stock_entries`,
      );
      const baselineLedgerId = String(highWater?.ledger_id ?? "0");
      const baselineRows = Number(count?.row_count ?? 0);

      await client.query(
        `INSERT INTO stock_daily_close_baseline
           (id, baseline_date, time_zone, baseline_ledger_id, baseline_rows, captured_at)
         VALUES (1, $1::date, $2, $3::bigint, $4, clock_timestamp())`,
        [baselineDate, timeZone, baselineLedgerId, baselineRows],
      );
      await client.query(
        `INSERT INTO stock_daily_close_baseline_entries
           (material_type, ref_id, branch_type, branch_id, quantity)
         SELECT material_type, item_id, branch_type, branch_id, quantity::numeric
           FROM stock_entries`,
      );
      console.log(
        `[migration] ${MIGRATION_NAME}: captured a future-only baseline for ${baselineRows} stock key(s) on ${baselineDate} (${timeZone})`,
      );
    }

    await client.query(
      `INSERT INTO migration_log (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
      [MIGRATION_NAME],
    );

    await client.query(`
      CREATE OR REPLACE FUNCTION guard_stock_ledger_daily_close_date()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $stock_close_guard$
      DECLARE
        company_zone TEXT;
        company_today DATE;
        baseline_day DATE;
        baseline_zone TEXT;
        last_closed_day DATE;
        movement_day DATE;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('${STOCK_DAILY_CLOSE_LOCK_KEY}'));
        SELECT COALESCE(NULLIF(general_settings->>'timeZone', ''), 'Asia/Kolkata')
          INTO company_zone
          FROM company_settings
         LIMIT 1;
        company_zone := COALESCE(company_zone, 'Asia/Kolkata');
        BEGIN
        company_today := (clock_timestamp() AT TIME ZONE company_zone)::date;
        EXCEPTION WHEN invalid_parameter_value THEN
          company_zone := 'Asia/Kolkata';
          company_today := (clock_timestamp() AT TIME ZONE company_zone)::date;
        END;
        movement_day := COALESCE(NEW.txn_date, company_today);
        SELECT b.baseline_date, b.time_zone INTO baseline_day, baseline_zone
          FROM stock_daily_close_baseline b
         WHERE b.id = 1;
        IF baseline_day IS NULL THEN
          RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = 'STOCK_DAILY_BASELINE_MISSING: stock baseline is not established';
        END IF;
        IF company_zone <> baseline_zone THEN
          RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = 'STOCK_DAILY_TIMEZONE_CHANGED: company timezone differs from the stock baseline';
        END IF;
        SELECT MAX(r.close_date) INTO last_closed_day
          FROM stock_daily_close_runs r
         WHERE r.completed_at IS NOT NULL;
        IF company_today - 1 >= baseline_day
           AND (last_closed_day IS NULL OR last_closed_day < company_today - 1)
           AND movement_day <= company_today - 1 THEN
          RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = 'STOCK_DAILY_CLOSE_REQUIRED: backdated stock movement falls in an unverified daily-close interval';
        END IF;
        IF movement_day < baseline_day THEN
          RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = 'STOCK_DATE_BEFORE_BASELINE: stock movement predates the trusted baseline';
        END IF;
        IF last_closed_day IS NOT NULL AND movement_day <= last_closed_day THEN
          RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = 'STOCK_DAILY_DATE_CLOSED: stock movement is dated on or before a closed date';
        END IF;
        NEW.txn_date := movement_day;
        RETURN NEW;
      END;
      $stock_close_guard$;
    `);
    await client.query(`
      DO $stock_close_trigger$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
            FROM pg_trigger
           WHERE tgname = 'trg_stock_ledger_daily_close_guard'
             AND tgrelid = 'stock_ledger'::regclass
             AND NOT tgisinternal
        ) THEN
          EXECUTE 'CREATE TRIGGER trg_stock_ledger_daily_close_guard
                   BEFORE INSERT OR UPDATE OF txn_date ON stock_ledger
                   FOR EACH ROW
                   EXECUTE FUNCTION guard_stock_ledger_daily_close_date()';
        END IF;
      END;
      $stock_close_trigger$;
    `);

    await client.query("COMMIT");
    console.log(`[migration] ${MIGRATION_NAME}: future daily close tables and write guard ready`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}