import assert from "node:assert/strict";
import test from "node:test";
import {
  assertStockDatesOpen,
  assertStockLedgerRestatementOpen,
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