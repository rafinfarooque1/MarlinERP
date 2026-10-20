import assert from "node:assert/strict";
import { stockAsOf } from "../src/lib/books";

const queries: Array<{ sql: string; params: unknown[] }> = [];
const q = {
  async query(sql: string, params: unknown[] = []) {
    queries.push({ sql, params });
    if (sql.includes("FROM historical_stock_evidence") && sql.includes("source_document")) {
      return { rows: [{ id: 7, source_document: "Approved count sheet ABC-31" }] };
    }
    if (sql.includes("FROM historical_stock_evidence_lines")) {
      const scopeType = params[1];
      const scopeId = params[2];
      const all = [
        { material_type: "item", ref_id: 1, branch_type: "warehouse", branch_id: 3, quantity: "12", unit_cost: "5", value: "60" },
        { material_type: "material", ref_id: 2, branch_type: "outlet", branch_id: 4, quantity: "2", unit_cost: "8", value: "16" },
      ];
      return { rows: scopeType ? all.filter((r) => r.branch_type === scopeType && r.branch_id === scopeId) : all };
    }
    if (sql.includes("FROM stock_reservations")) return { rows: [] };
    if (sql.includes("FROM items")) return { rows: [{ id: 1, name: "Finished good", unit: "kg", unit_cost: 999 }] };
    if (sql.includes("FROM materials")) return { rows: [{ id: 2, name: "Raw material", unit: "kg", unit_cost: 999 }] };
    throw new Error(`Unexpected query in read-only unit test: ${sql}`);
  },
};

const all = await stockAsOf("2026-08-31", null, q as any);
assert.equal(all.reliable, true);
assert.equal(all.total, 76);
assert.equal(all.items.length, 2);
assert.equal(all.items[0].unitCost, 5, "Approved historical cost must override current master cost.");
assert.equal(all.evidenceSource, "Approved count sheet ABC-31");

const warehouse = await stockAsOf("2026-08-31", { branchType: "warehouse", branchId: 3 }, q as any);
assert.equal(warehouse.total, 60);
assert.equal(warehouse.items.length, 1);
assert.equal(warehouse.items[0].materialType, "item");

const invalid = await stockAsOf("2026-02-30", null, q as any);
assert.equal(invalid.total, 0);
assert.equal(queries.length, 9, "Invalid dates must return without querying or writing.");
console.log("historical-stock-evidence: approved date, multi-location filtering, historical cost, and invalid date passed");
