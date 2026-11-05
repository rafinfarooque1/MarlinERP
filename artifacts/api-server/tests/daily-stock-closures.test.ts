import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeStockDates,
  rebaseStockDailyCloseAfterReset,
} from "../src/lib/dailyStockClosures.ts";

type FakeState = {
  today: string;
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

test("allows historical dates regardless of the daily close or baseline", async () => {
  const result = await normalizeStockDates(fakeDb({
    today: "2026-09-30",
  }), ["2020-01-01", "2026-09-29"]);
  assert.deepEqual(result.normalizedDates, ["2020-01-01", "2026-09-29"]);
});

test("defaults an omitted date to the company-local current day", async () => {
  const result = await normalizeStockDates(fakeDb({
    today: "2026-09-30",
  }), [null]);
  assert.deepEqual(result.normalizedDates, ["2026-09-30"]);
});

test("keeps historical date normalization available if the company timezone changes", async () => {
  const result = await normalizeStockDates(fakeDb({
    today: "2026-09-30",
    timeZone: "UTC",
  }), ["2026-09-29"]);
  assert.deepEqual(result.normalizedDates, ["2026-09-29"]);
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