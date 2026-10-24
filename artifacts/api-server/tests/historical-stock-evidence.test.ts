import assert from "node:assert/strict";
import { stockAsOf } from "../src/lib/books";
import {
  duplicateHistoricalEvidenceKeys,
  missingHistoricalEvidenceKeys,
  historicalTransferReceiptConflicts,
  isHistoricalTransferReceiptReconciled,
} from "../src/lib/historicalStockEvidenceRules";

const expectedKeys = [
  { materialType: "item", refId: 82, branchType: "warehouse", branchId: 4 },
  { materialType: "item", refId: 41, branchType: "warehouse", branchId: 4 },
];
assert.equal(missingHistoricalEvidenceKeys(expectedKeys, [expectedKeys[0]]).length, 1, "Incomplete schedules must identify uncovered keys.");
assert.equal(duplicateHistoricalEvidenceKeys([expectedKeys[0], expectedKeys[0]]).length, 1, "Duplicate product/location lines must be rejected.");

const conflictRows = await historicalTransferReceiptConflicts({
  async query(sql, params = []) {
    assert.match(sql, /p\.branch_transfer_id=t\.id/);
    assert.match(sql, /received_line_items/);
    assert.match(sql, /COALESCE\(source_transfer\.received_date::date,source_voucher\.voucher_date::date,\s*source_purchase\.purchase_date::date,sl\.created_at::date\)/);
    assert.doesNotMatch(sql, /COALESCE\(txn_date,created_at::date\)<=\$1::date/);
    assert.deepEqual(params, ["2026-08-31"]);
    return { rows: [
      {
        transfer_id: 3, material_type: "item", ref_id: 82, destination_type: "warehouse",
        destination_id: 4, quantity: "95", received_date: null,
        receipt_evidence_date: "2026-08-31", dispatched_quantity: "100",
        received_quantity: "95", reserved_quantity_at_cutoff: "5", reservation_count: 1,
        all_reservations_released_by_cutoff: false,
      },
      {
        transfer_id: 4, material_type: "item", ref_id: 41, destination_type: "warehouse",
        destination_id: 3, quantity: "20", received_date: null,
        receipt_evidence_date: null, dispatched_quantity: "20",
        received_quantity: "20", reserved_quantity_at_cutoff: "0", reservation_count: 1,
        all_reservations_released_by_cutoff: false,
      },
    ] };
  },
}, "2026-08-31");
assert.equal(conflictRows.length, 1);
assert.equal(conflictRows[0].transfer_id, 4, "Missing linked receipt evidence must still block approval.");
assert.equal(isHistoricalTransferReceiptReconciled({
  received_date: null,
  receipt_evidence_date: "2026-08-31",
  quantity: "95",
  received_quantity: "95",
  dispatched_quantity: "100",
  reserved_quantity_at_cutoff: "5",
  reservation_count: 1,
  all_reservations_released_by_cutoff: false,
}, "2026-08-31"), true, "An evidenced partial receipt must reconcile while its shortage remains reserved in transit.");
const productionPartialReceiptShapes = [
  { dispatched: 35, received: 30, transit: 5 },
  { dispatched: 27, received: 26, transit: 1 },
  { dispatched: 27, received: 26, transit: 1 },
  { dispatched: 20, received: 18, transit: 2 },
  { dispatched: 72, received: 36, transit: 36 },
];
for (const receipt of productionPartialReceiptShapes) {
  assert.equal(isHistoricalTransferReceiptReconciled({
    received_date: "2026-09-09",
    receipt_evidence_date: "2026-09-09",
    quantity: String(receipt.received),
    received_quantity: String(receipt.received),
    dispatched_quantity: String(receipt.dispatched),
    reserved_quantity_at_cutoff: String(receipt.transit),
    reservation_count: 2,
    all_reservations_released_by_cutoff: false,
  }, "2026-09-30"), true, "A partial destination receipt must remain on hand while only its undelivered balance stays in transit.");
}
assert.equal(isHistoricalTransferReceiptReconciled({
  received_date: null,
  receipt_evidence_date: "2026-09-01",
  quantity: "95",
  received_quantity: "95",
  dispatched_quantity: "100",
  reserved_quantity_at_cutoff: "5",
  reservation_count: 1,
  all_reservations_released_by_cutoff: false,
}, "2026-08-31"), false, "Receipt evidence after the cutoff must not be counted.");
assert.equal(isHistoricalTransferReceiptReconciled({
  received_date: null,
  receipt_evidence_date: null,
  quantity: "50",
  received_quantity: "50",
  dispatched_quantity: "50",
  reserved_quantity_at_cutoff: "0",
  reservation_count: 1,
  all_reservations_released_by_cutoff: true,
}, "2026-08-31"), true, "A fully released reservation with a matching receipt ledger remains valid legacy evidence.");

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
console.log("historical-stock-evidence: completeness, duplicate lines, transit receipt conflict, location filtering, historical cost, and invalid date passed");
