import assert from "node:assert/strict";
import { stockAsOf } from "../src/lib/books";

function fakeDb(checkpoint: "exact" | "prior" | "later" | "none") {
  return {
    async query(sql: string) {
      if (sql.includes("FROM historical_stock_evidence") && sql.includes("source_document")) {
        return { rows: [] };
      }
      if (sql.includes("LEFT JOIN purchases p") && sql.includes("received_line_items")) {
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
        assert.match(sql, /scs\.as_of_date <= \$1::date/, "Historical valuation may carry forward a dated checkpoint.");
        assert.match(sql, /scs\.as_of_date DESC, scs\.id DESC/, "The newest eligible checkpoint must win.");
        if (checkpoint === "none") return { rows: [] };
        const date = checkpoint === "exact" ? "2026-09-30"
          : checkpoint === "later" ? "2026-09-25" : "2026-09-14";
        const unitCost = checkpoint === "later" ? "7" : "5";
        return {
          rows: [{
            material_type: "item",
            ref_id: 9,
            branch_type: "warehouse",
            branch_id: 3,
            quantity: "10",
            unit_cost: unitCost,
            value: String(Number(unitCost) * 10),
            as_of_date: date,
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

const exact = await stockAsOf("2026-09-30", null, fakeDb("exact") as any);
assert.equal(exact.reliable, true, "An exact-date persisted checkpoint is authoritative.");
assert.equal(exact.total, 50, "Use the persisted checkpoint value.");
assert.equal(exact.items[0]?.unitCost, 5, "Do not substitute the current product-master cost.");

const prior = await stockAsOf("2026-09-30", null, fakeDb("prior") as any);
assert.equal(prior.reliable, true, "A prior checkpoint is valid when its quantity reconciles and no later movement is present.");
assert.equal(prior.total, 50, "Carry forward the persisted historical value rather than recomputing from current cost.");

const later = await stockAsOf("2026-09-30", null, fakeDb("later") as any);
assert.equal(later.reliable, true, "The latest checkpoint before the requested date is selected.");
assert.equal(later.total, 70, "A later checkpoint supersedes an older one.");

const missing = await stockAsOf("2026-09-30", null, fakeDb("none") as any);
assert.equal(missing.reliable, false, "A genuinely absent checkpoint remains unverified.");
assert.equal(missing.total, 0, "Do not include an unverified historical on-hand value.");
assert.match(missing.note ?? "", /Current ERP stock data is present/);
assert.match(missing.note ?? "", /current item costs were not substituted/);

console.log("historical-stock-checkpoint-carry-forward: exact-date checkpoints are accepted; current ERP costs are not substituted for missing history");
