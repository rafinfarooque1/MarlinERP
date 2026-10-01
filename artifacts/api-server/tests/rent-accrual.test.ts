import assert from "node:assert/strict";
import test from "node:test";
import {
  isPeriodAccrualComplete,
  recalcUnapprovedRentAccruals,
  rentAccrualTermsChanged,
  rentMonthCoverage,
  runRentAccrual,
  withWarehouseRentLock,
  type Querier,
} from "../src/lib/rentAccrual.ts";

type QueryResult = { rows: any[]; rowCount?: number | null };
type QueryHandler = (sql: string, params?: unknown[]) => Promise<QueryResult> | QueryResult;

function fakeQuerier(handler: QueryHandler): Querier {
  return {
    async query<T = any>(sql: string, params?: unknown[]) {
      const result = await handler(sql, params);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? null };
    },
  };
}

function agreement(overrides: Record<string, unknown> = {}) {
  return {
    warehouse_id: 7,
    monthly_rent: "3100.00",
    start_date: "2026-01-01",
    end_date: null,
    status: "active",
    inactive_from: null,
    ...overrides,
  };
}

test("all agreement fields that affect rent coverage trigger a rebuild", () => {
  const original = agreement();
  for (const changed of [
    { monthly_rent: "3200.00" },
    { start_date: "2025-12-01" },
    { end_date: "2026-06-30" },
    { status: "inactive" },
    { inactive_from: "2026-02-01" },
  ]) {
    assert.equal(
      rentAccrualTermsChanged(original, { ...original, ...changed }),
      true,
      `${Object.keys(changed)[0]} must trigger a rebuild`,
    );
  }
  assert.equal(rentAccrualTermsChanged(original, { ...original }), false);
});

test("rent coverage accepts a penny of rounding variance but rejects under- and over-accrual", async () => {
  async function coverage(accrued: string) {
    const q = fakeQuerier(async (sql) => {
      if (sql.includes("FROM warehouse_rent_agreements")) {
        return { rows: [agreement()] };
      }
      if (sql.includes("FROM rent_accruals")) {
        return { rows: [{ total: accrued }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    return rentMonthCoverage(q, 7, 2026, 1);
  }

  assert.equal((await coverage("3100.00")).complete, true);
  assert.equal((await coverage("3099.99")).complete, true);
  assert.equal((await coverage("3100.01")).complete, true);
  assert.equal((await coverage("3099.98")).complete, false);
  assert.equal((await coverage("3100.02")).complete, false);
});

test("scheduled rent sweep re-reads the agreement after acquiring the warehouse lock", async () => {
  const events: string[] = [];
  const client = fakeQuerier(async (sql) => {
    events.push(sql);
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes("FROM warehouse_rent_agreements") && sql.includes("FOR UPDATE")) {
      // This is the current locked agreement. Its future start means no accrual
      // may be written; the locked row, not stale pre-lock terms, is authoritative.
      return { rows: [agreement({ start_date: "2026-01-20" })] };
    }
    throw new Error(`Unexpected locked query: ${sql}`);
  });
  const pool = {
    async query() { return { rows: [{ warehouse_id: 7 }], rowCount: 1 }; },
    async connect() {
      return { query: client.query.bind(client), release() {} };
    },
  } as unknown as Parameters<typeof runRentAccrual>[0];

  const result = await runRentAccrual(pool, { asOf: "2026-01-10" });
  const lockIndex = events.findIndex((sql) => sql.includes("pg_advisory_xact_lock"));
  const rereadIndex = events.findIndex((sql) => sql.includes("FROM warehouse_rent_agreements") && sql.includes("FOR UPDATE"));
  assert.equal(result.daysAccrued, 0);
  assert.ok(lockIndex >= 0 && rereadIndex > lockIndex, "agreement must be re-read after lock acquisition");
  assert.equal(events.filter((sql) => sql.includes("pg_advisory_xact_lock")).length, 1, "sweep must acquire one lock");
});

test("rent rebuild is one locked transaction and preserves approved and accounting-locked months", async () => {
  const events: string[] = [];
  const deletedDates: string[] = [];
  const client = fakeQuerier(async (sql, params) => {
    events.push(sql);
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes("DELETE FROM rent_accruals")) {
      assert.match(sql, /p\.status IN \('approved', 'paid'\)/);
      assert.match(sql, /FROM accounting_period_locks/);
      return {
        rows: [{ amount: "100.00", accrual_date: "2026-01-15", year: 2026, month: 1 }],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM warehouse_rent_agreements") && sql.includes("FOR UPDATE")) {
      return { rows: [agreement({ start_date: "2026-01-01" })] };
    }
    if (sql.includes("FROM rent_periods")) return { rows: [] };
    if (sql.includes("FROM accounting_period_locks")) return { rows: [] };
    if (sql.includes("MAX(accrual_date)")) return { rows: [{ last: null }] };
    if (sql.includes("COALESCE(SUM(amount), 0) AS total")) return { rows: [{ total: "0" }] };
    if (sql.includes("INSERT INTO rent_accruals")) {
      deletedDates.push(String(params?.[1]));
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO rent_periods")) return { rows: [], rowCount: 1 };
    throw new Error(`Unexpected query: ${sql}`);
  });
  const pool = {
    async connect() {
      return { query: client.query.bind(client), release() {} };
    },
  } as unknown as Parameters<typeof recalcUnapprovedRentAccruals>[0];

  const result = await recalcUnapprovedRentAccruals(pool, 7, {
    asOf: "2026-01-17",
  });
  assert.equal(result.entriesReversed, 1);
  assert.equal(result.entriesRegenerated, 17);
  assert.equal(deletedDates[0], "2026-01-01", "rebuild should cover dates before the earliest row removed");
  assert.equal(events.filter((sql) => sql.includes("pg_advisory_xact_lock")).length, 1);
  assert.equal(events[0], "BEGIN");
  assert.equal(events[events.length - 1], "COMMIT");
});

test("rent transaction rolls back when an agreement rebuild callback fails", async () => {
  const events: string[] = [];
  const client = fakeQuerier(async (sql) => {
    events.push(sql);
    return { rows: [] };
  });
  const pool = {
    async connect() {
      return { query: client.query.bind(client), release() {} };
    },
  } as unknown as Parameters<typeof withWarehouseRentLock>[0];

  await assert.rejects(
    withWarehouseRentLock(pool, 7, async (q) => {
      await q.query("UPDATE warehouse_rent_agreements SET monthly_rent = $1", [5000]);
      throw new Error("simulated rebuild failure");
    }),
    /simulated rebuild failure/,
  );
  assert.equal(events[0], "BEGIN");
  assert.ok(events.some((sql) => sql.includes("pg_advisory_xact_lock")));
  assert.equal(events[events.length - 1], "ROLLBACK");
  assert.equal(events.includes("COMMIT"), false);
});

test("period accrual completeness remains independent of agreement amount coverage", async () => {
  const q = fakeQuerier(async (sql) => {
    if (sql.includes("FROM warehouse_rent_agreements")) {
      return { rows: [agreement({ end_date: "2026-01-31" })] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  assert.equal(await isPeriodAccrualComplete(q, 7, 2026, 1, "2026-02-01"), true);
});