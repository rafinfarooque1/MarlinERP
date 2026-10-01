import assert from "node:assert/strict";
import test from "node:test";
import {
  assertStockDatesOpen,
  assertStockLedgerRestatementOpen,
  rebaseStockDailyCloseAfterReset,
} from "../src/lib/dailyStockClosures.ts";

type FakeState = {
  today: string;
  baselineDate: string;
  baselineTimeZone?: string;
  closedThrough: string | null;
  oldDates?: Array<string | null>;
  timeZone?: string;
};

function fakeDb(state: FakeState) {
  return {
    async query(sql: string) {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("SELECT general_settings")) {
        return { rows: [{ general_settings: { timeZone: state.timeZone ?? "Asia/Kolkata" } }] };
      }
      if (sql.includes("AS company_today")) {
        return { rows: [{ company_today: state.today }] };
      }
      if (sql.includes("baseline_time_zone")) {
        return {
          rows: [{
            baseline_date: state.baselineDate,
            baseline_time_zone: state.baselineTimeZone ?? "Asia/Kolkata",
            baseline_ledger_id: "41",
            closed_through: state.closedThrough,
          }],
        };
      }
      if (sql.includes("SELECT DISTINCT txn_date::text")) {
        return { rows: (state.oldDates ?? []).map(txn_date => ({ txn_date })) };
      }
      throw new Error(`Unexpected query in test: ${sql}`);
    },
  };
}

function rebaseFakeDb(opts: { baselineExists?: boolean; rowCount?: number } = {}) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const db = {
    calls,
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("SELECT id FROM stock_daily_close_baseline")) {
        return { rows: opts.baselineExists === false ? [] : [{ id: 1 }] };
      }
      if (sql.includes("SELECT general_settings")) {
        return { rows: [{ general_settings: { timeZone: "Pacific/Auckland" } }] };
      }
      if (sql.includes("AS company_today")) {
        return { rows: [{ company_today: "2026-10-01" }] };
      }
      if (sql.includes("LOCK TABLE")) return { rows: [] };
      if (sql.includes("AS ledger_id")) return { rows: [{ ledger_id: "47" }] };
      if (sql.includes("AS row_count")) return { rows: [{ row_count: opts.rowCount ?? 0 }] };
      if (sql.startsWith("DELETE FROM")) return { rows: [] };
      if (sql.includes("UPDATE stock_daily_close_baseline")) return { rows: [{ id: 1 }] };
      if (sql.includes("INSERT INTO stock_daily_close_baseline_entries")) return { rows: [] };
      throw new Error(`Unexpected query in reset test: ${sql}`);
    },
  };
  return db;
}

test("rejects stock dates before the future-only baseline", async () => {
  await assert.rejects(
    () => assertStockDatesOpen(fakeDb({
      today: "2026-09-30",
      baselineDate: "2026-09-29",
      closedThrough: "2026-09-29",
    }), ["2026-09-28"]),
    (error: any) => error.code === "STOCK_DATE_BEFORE_BASELINE" && error.statusCode === 409,
  );
});

test("rejects changes dated on a completed close", async () => {
  await assert.rejects(
    () => assertStockDatesOpen(fakeDb({
      today: "2026-09-30",
      baselineDate: "2026-09-29",
      closedThrough: "2026-09-29",
    }), ["2026-09-29"]),
    (error: any) => error.code === "STOCK_DAILY_DATE_CLOSED" && error.statusCode === 409,
  );
});

test("defaults an omitted date to the company-local current day", async () => {
  const result = await assertStockDatesOpen(fakeDb({
    today: "2026-09-30",
    baselineDate: "2026-09-29",
    closedThrough: "2026-09-29",
  }), [null]);
  assert.deepEqual(result.normalizedDates, ["2026-09-30"]);
});

test("blocks backdated writes in a missing close interval but allows the current date", async () => {
  await assert.rejects(
    () => assertStockDatesOpen(fakeDb({
      today: "2026-10-01",
      baselineDate: "2026-09-29",
      closedThrough: "2026-09-29",
    }), ["2026-09-30"]),
    (error: any) => error.code === "STOCK_DAILY_CLOSE_REQUIRED" && error.statusCode === 409,
  );
  const result = await assertStockDatesOpen(fakeDb({
    today: "2026-10-01",
    baselineDate: "2026-09-29",
    closedThrough: "2026-09-29",
  }), ["2026-10-01"]);
  assert.deepEqual(result.normalizedDates, ["2026-10-01"]);
});

test("does not allow a date edit to move a closed movement forward", async () => {
  await assert.rejects(
    () => assertStockLedgerRestatementOpen(fakeDb({
      today: "2026-09-30",
      baselineDate: "2026-09-29",
      closedThrough: "2026-09-29",
      oldDates: ["2026-09-29"],
    }), "purchase", 7, "2026-09-30"),
    (error: any) => error.code === "STOCK_DAILY_DATE_CLOSED" && error.statusCode === 409,
  );
});

test("blocks changes when the company timezone no longer matches the baseline", async () => {
  await assert.rejects(
    () => assertStockDatesOpen(fakeDb({
      today: "2026-09-30",
      baselineDate: "2026-09-29",
      baselineTimeZone: "Asia/Kolkata",
      timeZone: "UTC",
      closedThrough: "2026-09-29",
    }), ["2026-09-30"]),
    (error: any) => error.code === "STOCK_DAILY_TIMEZONE_CHANGED" && error.statusCode === 503,
  );
});

test("reset rebases the preserved snapshot to current stock and company-local date", async () => {
  const db = rebaseFakeDb({ rowCount: 0 });
  const result = await rebaseStockDailyCloseAfterReset(db);
  assert.deepEqual(result, {
    baselineDate: "2026-10-01",
    timeZone: "Pacific/Auckland",
    baselineLedgerId: "47",
    baselineRows: 0,
  });

  const labels = db.calls.map(({ sql }) => sql);
  const advisory = labels.findIndex(sql => sql.includes("pg_advisory_xact_lock"));
  const lockEntries = labels.findIndex(sql => sql.includes("LOCK TABLE stock_entries"));
  const lockLedger = labels.findIndex(sql => sql.includes("LOCK TABLE stock_ledger"));
  const deleteCloses = labels.findIndex(sql => sql.includes("DELETE FROM stock_daily_close_entries"));
  const deleteRuns = labels.findIndex(sql => sql.includes("DELETE FROM stock_daily_close_runs"));
  const deleteBaselineEntries = labels.findIndex(sql => sql.includes("DELETE FROM stock_daily_close_baseline_entries"));
  const updateBaseline = db.calls.find(call => call.sql.includes("UPDATE stock_daily_close_baseline"));
  const copyCurrent = labels.findIndex(sql => sql.includes("INSERT INTO stock_daily_close_baseline_entries"));

  assert.ok(advisory !== -1 && advisory < lockEntries && lockEntries < lockLedger,
    "global close lock is taken before stock tables are frozen");
  assert.ok(deleteCloses !== -1 && deleteCloses < deleteRuns
      && deleteRuns < deleteBaselineEntries && deleteBaselineEntries < copyCurrent,
    "old daily entries/runs/baseline entries are cleared before the new baseline entries are copied");
  assert.deepEqual(updateBaseline?.params, ["2026-10-01", "Pacific/Auckland", "47", 0],
    "the baseline uses the company-local date, current ledger high-water mark, and current stock row count");
  assert.equal(labels.some(sql => /^(?:DELETE FROM|TRUNCATE TABLE|UPDATE)\s+stock_(?:entries|ledger)\b/i.test(sql.trim())), false,
    "rebasing snapshots existing stock without modifying current stock or ledger rows");
});

test("reset fails closed if the preserved baseline row is missing", async () => {
  const db = rebaseFakeDb({ baselineExists: false });
  await assert.rejects(
    () => rebaseStockDailyCloseAfterReset(db),
    (error: any) => error.code === "STOCK_DAILY_BASELINE_MISSING" && error.statusCode === 503,
  );
  assert.equal(db.calls.some(({ sql }) => sql.startsWith("DELETE FROM")), false,
    "no snapshot rows are cleared when the baseline cannot be validated");
});

test("factory reset can rebase while its session-level close lock is already held", async () => {
  const db = rebaseFakeDb({ rowCount: 2 });
  const result = await rebaseStockDailyCloseAfterReset(db, { closeLockHeld: true });
  assert.equal(result.baselineRows, 2);
  assert.equal(db.calls.some(({ sql }) => sql.includes("pg_advisory_xact_lock")), false,
    "the helper must not wait on a second session's lock while the reset owns the global lock");
});