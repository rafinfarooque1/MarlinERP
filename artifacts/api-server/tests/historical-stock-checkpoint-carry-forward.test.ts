import assert from "node:assert/strict";
import { stockAsOf } from "../src/lib/books";

function fakeDb(hasExactDateCheckpoint: boolean) {
  return {
    async query(sql: string) {
      if (sql.includes("FROM historical_stock_evidence") && sql.includes("source_document")) {
        return { rows: [] };
      }
      if (sql.includes("SELECT MIN(COALESCE(txn_date, created_at::date))")) {
        return { rows: [{ first_move: "2026-09-01" }] };
      }
      if (sql.includes("SELECT MIN(d)::date::text AS first_doc")) {
        return { rows: [{ first_doc: "2026-09-01" }] };
      }
      if (sql.includes("FROM stock_ledger sl") && sql.includes("GROUP BY 1, 2, 3, 4")) {
        return {
          rows: [{
            material_type: "item",
            ref_id: 9,
            branch_type: "warehouse",
            branch_id: 3,
            after_qty: "0",
            all_qty: "10",
          }],
        };
      }
      if (sql.includes("FROM stock_entries se")) {
        return {
          rows: [{
            material_type: "item",
            ref_id: 9,
            branch_type: "warehouse",
            branch_id: 3,
            quantity: "10",
          }],
        };
      }
      if (sql.includes("FROM stock_cost_snapshots scs")) {
        assert.match(sql, /scs\.as_of_date = \$1::date/, "Historical valuation requires a checkpoint on the requested date.");
        if (!hasExactDateCheckpoint) return { rows: [] };
        return {
          rows: [{
            material_type: "item",
            ref_id: 9,
            branch_type: "warehouse",
            branch_id: 3,
            quantity: "10",
            unit_cost: "5",
            value: "50",
            as_of_date: "2026-09-30",
          }],
        };
      }
      if (sql.includes("FROM stock_reservations r")) return { rows: [] };
      if (sql.includes("FROM stock_transfers t")) return { rows: [] };
      if (sql.includes("FROM items")) {
        return { rows: [{ id: 9, name: "Frozen mango", unit: "kg", unit_cost: "999" }] };
      }
      throw new Error(`Unexpected read-only stock history query: ${sql}`);
    },
  };
}

const exact = await stockAsOf("2026-09-30", null, fakeDb(true) as any);
assert.equal(exact.reliable, true, "An exact-date persisted checkpoint is authoritative.");
assert.equal(exact.total, 50, "Use the persisted checkpoint value.");
assert.equal(exact.items[0]?.unitCost, 5, "Do not substitute the current product-master cost.");

const missingExact = await stockAsOf("2026-09-30", null, fakeDb(false) as any);
assert.equal(missingExact.reliable, false, "A checkpoint from another date is not enough to establish historical cost.");
assert.equal(missingExact.total, 0, "Do not include an unverified historical on-hand value.");
assert.match(missingExact.note ?? "", /Current ERP stock data is present/);
assert.match(missingExact.note ?? "", /current item costs were not substituted/);

console.log("historical-stock-checkpoint-carry-forward: exact-date checkpoints are accepted; current ERP costs are not substituted for missing history");
