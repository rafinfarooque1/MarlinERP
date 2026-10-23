import assert from "node:assert/strict";
import { stockAsOf } from "../src/lib/books";
import { resolveHistoricalBatchCoverage } from "../src/lib/historicalStockEvidenceRules";

type Doc = {
  docType: string; docId: number; txnType: string; qty: number; lines: any[];
  purchaseLines?: any[];
};

function makeCase(args: {
  expected: number; cost: number; batch: string; purchase: number;
  inbound: number[]; outbound: number[]; sales: number[]; zeroSale?: number;
}) {
  const docs: Doc[] = [{
    docType: "purchase", docId: 78, txnType: "purchase", qty: args.purchase,
    lines: [], purchaseLines: [{ materialType: "item", materialId: 9, quantity: args.purchase, batchNumber: args.batch, costPerUnit: args.cost }],
  }];
  let id = 1;
  for (const qty of args.inbound) docs.push({
    docType: "stock_transfer", docId: id++, txnType: "transfer_in", qty,
    lines: [{ materialType: "item", itemId: 9, quantity: qty, batchBreakdown: [{ batchNumber: args.batch, quantity: qty, unitCost: args.cost }] }],
  });
  for (const qty of args.outbound) docs.push({
    docType: "stock_transfer", docId: id++, txnType: "transfer_out", qty: -qty,
    lines: [{ materialType: "item", itemId: 9, quantity: qty, batchBreakdown: [{ batchNumber: args.batch, quantity: qty, unitCost: args.cost }] }],
  });
  for (const qty of args.sales) docs.push({
    docType: "sale", docId: id++, txnType: "sale", qty: -qty,
    lines: [{ itemId: 9, quantity: qty, batchBreakdown: [{ batchNumber: args.batch, quantity: qty, unitCost: args.cost }] }],
  });
  if (args.zeroSale) docs.push({
    docType: "sale", docId: id++, txnType: "sale", qty: -args.zeroSale,
    lines: [{ itemId: 9, quantity: args.zeroSale, batchBreakdown: [{ batchNumber: args.batch, quantity: args.zeroSale, unitCost: args.cost }] }],
  }, {
    docType: "sale", docId: id - 1, txnType: "sale_reversal", qty: args.zeroSale,
    lines: [{ itemId: 9, quantity: args.zeroSale, batchBreakdown: [{ batchNumber: args.batch, quantity: args.zeroSale, unitCost: args.cost }] }],
  });
  const movements = docs.map((d) => ({
    txnType: d.txnType, txnDate: "2026-09-20", docType: d.docType, docId: d.docId, qtyChange: d.qty,
  }));
  const allocations = docs.flatMap((d) => (d.docType === "purchase" ? d.purchaseLines! : d.lines.flatMap((l) => d.docType === "sale"
    ? l.batchBreakdown.map((b: any) => ({ ...b, docType: d.docType, docId: d.docId }))
    : l.batchBreakdown.map((b: any) => ({ ...b, docType: d.docType, docId: d.docId }))))
    .map((a: any) => ({
      docType: d.docType, docId: d.docId, batchNumber: a.batchNumber,
      quantity: a.quantity, unitCost: a.unitCost ?? a.costPerUnit,
      purchaseCost: d.docType === "purchase",
    })));
  return { docs, movements, allocations, expected: args.expected, cost: args.cost, batch: args.batch };
}

const mango = makeCase({
  expected: 984, cost: 90, batch: "PUR-20260520-00455", purchase: 2064,
  inbound: [30, 17], outbound: [80, 20, 20, 40, 60, 60], sales: [30, 17, 400, 400],
});
const strawberry = makeCase({
  expected: 8697, cost: 213, batch: "PUR-20260826-00454", purchase: 11190,
  inbound: [33], outbound: [50, 50, 1, 99, 100, 40, 70], sales: [33, 50, 33, 2000], zeroSale: 33,
});

for (const fixture of [mango, strawberry]) {
  const resolved = resolveHistoricalBatchCoverage(fixture.expected, fixture.movements, fixture.allocations);
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.unitCost, fixture.cost);
    assert.equal(resolved.batchNumber, fixture.batch);
    assert.equal(Math.round(fixture.expected * resolved.unitCost * 100) / 100,
      fixture.expected * fixture.cost, "the supported lot cost values the reconciled cutoff quantity");
  }
}

assert.equal(resolveHistoricalBatchCoverage(mango.expected, mango.movements, mango.allocations.slice(0, -1)).ok, false,
  "missing source allocations fail closed");
assert.equal(resolveHistoricalBatchCoverage(mango.expected, mango.movements.map((m, i) => i === 0 ? { ...m, txnDate: null } : m), mango.allocations).ok, false,
  "undated movements fail closed");
assert.equal(resolveHistoricalBatchCoverage(mango.expected + 1, mango.movements, mango.allocations).ok, false,
  "ledger and cutoff quantity conflicts fail closed");
assert.equal(resolveHistoricalBatchCoverage(mango.expected, mango.movements, mango.allocations.map((a, i) => i === 1 ? { ...a, batchNumber: "OTHER" } : a)).ok, false,
  "conflicting batches fail closed");
assert.equal(resolveHistoricalBatchCoverage(mango.expected, mango.movements, mango.allocations.map((a) => ({ ...a, unitCost: a.purchaseCost ? 90 : 91 }))).ok, false,
  "purchase and allocation cost conflicts fail closed");
assert.equal(resolveHistoricalBatchCoverage(mango.expected, mango.movements, mango.allocations.map((a) => ({ ...a, purchaseCost: false }))).ok, false,
  "purchase-backed cost evidence is required");

function dbFor(fixture: typeof mango) {
  const rows = fixture.docs.map((d) => ({
    txn_type: d.txnType, txn_date: "2026-09-20", doc_type: d.docType, doc_id: d.docId,
    qty_change: d.qty,
    purchase_lines: d.purchaseLines ?? null,
    sale_lines: d.docType === "sale" ? d.lines : null,
    transfer_lines: d.docType === "stock_transfer" && d.txnType === "transfer_out" ? d.lines : null,
    received_lines: d.docType === "stock_transfer" && d.txnType === "transfer_in" ? d.lines : null,
  }));
  return {
    async query(sql: string) {
      if (sql.includes("FROM historical_stock_evidence") && sql.includes("source_document")) return { rows: [] };
      if (sql.includes("SELECT MIN(COALESCE(txn_date, created_at::date))")) return { rows: [{ first_move: "2026-05-01" }] };
      if (sql.includes("SELECT MIN(d)::date::text AS first_doc")) return { rows: [{ first_doc: "2026-05-01" }] };
      if (sql.includes("FROM stock_ledger sl") && sql.includes("GROUP BY 1, 2, 3, 4")) {
        return { rows: [{ material_type: "item", ref_id: 9, branch_type: "warehouse", branch_id: 5, after_qty: "0", all_qty: String(fixture.expected) }] };
      }
      if (sql.includes("FROM stock_entries se")) return { rows: [{ material_type: "item", ref_id: 9, branch_type: "warehouse", branch_id: 5, quantity: String(fixture.expected) }] };
      if (sql.includes("FROM stock_cost_snapshots scs")) return { rows: [] };
      if (sql.includes("LEFT JOIN purchases p") && sql.includes("received_line_items")) return { rows };
      if (sql.includes("FROM stock_reservations")) return { rows: [] };
      if (sql.includes("FROM stock_transfers t")) return { rows: [] };
      if (sql.includes("FROM items")) return { rows: [{ id: 9, name: fixture.batch, unit: "kg", unit_cost: "999" }] };
      throw new Error(`Unexpected read-only test query: ${sql}`);
    },
  };
}

for (const fixture of [mango, strawberry]) {
  const result = await stockAsOf("2026-09-30", null, dbFor(fixture) as any);
  assert.equal(result.reliable, true, "stockAsOf accepts fully dated, purchase-backed batch coverage");
  assert.equal(result.items[0]?.stock, fixture.expected);
  assert.equal(result.items[0]?.unitCost, fixture.cost);
  assert.equal(result.total, fixture.expected * fixture.cost);
}

console.log("historical-batch-fallback: both Ceevees cutoff lots resolve; ambiguous evidence fails closed");
