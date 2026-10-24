import assert from "node:assert/strict";
import { stockAsOf } from "../src/lib/books";
import { resolveHistoricalBatchCoverage } from "../src/lib/historicalStockEvidenceRules";

type Doc = {
  docType: string; docId: number; txnType: string; qty: number; lines: any[];
  purchaseLines?: any[]; returnLines?: any[]; purchaseReturnLines?: any[];
  purchaseSourceLines?: any[]; receivedQty?: number;
};

function makeCase(args: {
  expected: number; cost: number; batch: string; purchase: number;
  inbound: number[]; outbound: number[]; sales: number[];
  returns?: number[]; purchaseReturns?: number[]; zeroSale?: number;
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
  for (const qty of args.returns ?? []) docs.push({
    docType: "sales_return", docId: id++, txnType: "sales_return", qty,
    lines: [],
    returnLines: [{ itemId: 9, quantity: qty, batchRestore: [{ batchNumber: args.batch, quantity: qty, unitCost: args.cost }] }],
  });
  for (const qty of args.purchaseReturns ?? []) docs.push({
    docType: "purchase_return", docId: id++, txnType: "purchase_return", qty: -qty,
    lines: [],
    purchaseReturnLines: [{ lineIndex: 0, materialType: "item", materialId: 9, quantity: qty, unitCost: args.cost }],
    purchaseSourceLines: docs[0].purchaseLines,
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
  const allocations = docs.flatMap((d) => (d.docType === "purchase" ? d.purchaseLines! : d.docType === "sales_return"
    ? d.returnLines!.flatMap((line) => line.batchRestore)
    : d.docType === "purchase_return"
    ? d.purchaseReturnLines!.map((line) => ({
        batchNumber: d.purchaseSourceLines![line.lineIndex].batchNumber,
        quantity: line.quantity, unitCost: line.unitCost,
      }))
    : d.lines.flatMap((l) => d.docType === "sale"
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
const returnedLot = makeCase({
  expected: 70, cost: 42.5, batch: "PUR-20260615-00001", purchase: 100,
  inbound: [], outbound: [], sales: [40], returns: [10],
});
const purchaseReturnedLot = makeCase({
  expected: 90, cost: 42.5, batch: "PUR-20260615-00002", purchase: 100,
  inbound: [], outbound: [], sales: [], purchaseReturns: [10],
});
const transferredPurchasedLot = {
  expected: 25,
  cost: 90,
  batch: "PUR-20260520-00455",
  purchaseBatchCosts: [{
    material_type: "item", ref_id: 9,
    batch_number: "PUR-20260520-00455", unit_cost: "90",
  }],
  docs: [{
    docType: "stock_transfer", docId: 501, txnType: "transfer_in", qty: 25,
    lines: [{
      materialType: "item", itemId: 9, quantity: 25,
      batchBreakdown: [{ batchNumber: "PUR-20260520-00455", quantity: 25, unitCost: 90 }],
    }],
    receivedQty: 25,
  }],
};

for (const fixture of [mango, strawberry, returnedLot, purchaseReturnedLot]) {
  const resolved = resolveHistoricalBatchCoverage(fixture.expected, fixture.movements, fixture.allocations);
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.unitCost, fixture.cost);
    assert.equal(resolved.batchNumber, fixture.batch);
    assert.equal(Math.round(fixture.expected * resolved.unitCost * 100) / 100,
      fixture.expected * fixture.cost, "the supported lot cost values the reconciled cutoff quantity");
  }
}

const multiBatch = resolveHistoricalBatchCoverage(80, [
  { txnType: "purchase", txnDate: "2026-06-01", docType: "purchase", docId: 1, qtyChange: 40 },
  { txnType: "purchase", txnDate: "2026-06-02", docType: "purchase", docId: 2, qtyChange: 60 },
  { txnType: "sale", txnDate: "2026-06-03", docType: "sale", docId: 3, qtyChange: -20 },
], [
  { docType: "purchase", docId: 1, batchNumber: "LOT-A", quantity: 40, unitCost: 10, purchaseCost: true },
  { docType: "purchase", docId: 2, batchNumber: "LOT-B", quantity: 60, unitCost: 20, purchaseCost: true },
  { docType: "sale", docId: 3, batchNumber: "LOT-A", quantity: 20, unitCost: 10 },
]);
assert.equal(multiBatch.ok, true, "complete evidence may support more than one batch and purchase cost");
if (multiBatch.ok) assert.equal(multiBatch.unitCost, 17.5, "mixed batches are valued at their weighted historical unit cost");

assert.equal(resolveHistoricalBatchCoverage(mango.expected, mango.movements, mango.allocations.slice(0, -1)).ok, false,
  "missing source allocations fail closed");
assert.equal(resolveHistoricalBatchCoverage(mango.expected, mango.movements.map((m, i) => i === 0 ? { ...m, txnDate: null } : m), mango.allocations).ok, false,
  "undated movements fail closed");
assert.equal(resolveHistoricalBatchCoverage(mango.expected, mango.movements.map((m, i) => i === 0 ? { ...m, txnDate: "2026-02-30" } : m), mango.allocations).ok, false,
  "impossible business dates fail closed");
assert.equal(resolveHistoricalBatchCoverage(mango.expected + 1, mango.movements, mango.allocations).ok, false,
  "ledger and cutoff quantity conflicts fail closed");
assert.equal(resolveHistoricalBatchCoverage(mango.expected, mango.movements, mango.allocations.map((a, i) => i === 1 ? { ...a, batchNumber: "OTHER" } : a)).ok, false,
  "conflicting batches fail closed");
assert.equal(resolveHistoricalBatchCoverage(mango.expected, mango.movements, mango.allocations.map((a) => ({ ...a, unitCost: a.purchaseCost ? 90 : 91 }))).ok, false,
  "purchase and allocation cost conflicts fail closed");
assert.equal(resolveHistoricalBatchCoverage(mango.expected, mango.movements, mango.allocations.map((a) => ({ ...a, purchaseCost: false }))).ok, false,
  "purchase-backed cost evidence is required");
const purchaseAllocation = mango.allocations.find((a) => a.purchaseCost)!;
const conflictingPurchaseCosts = [
  ...mango.allocations.filter((a) => !a.purchaseCost),
  { ...purchaseAllocation, quantity: 1032, unitCost: 90 },
  { ...purchaseAllocation, quantity: 1032, unitCost: 91 },
];
assert.equal(resolveHistoricalBatchCoverage(mango.expected, mango.movements, conflictingPurchaseCosts).ok, false,
  "conflicting purchase-cost evidence fails closed");
assert.equal(resolveHistoricalBatchCoverage(mango.expected, mango.movements, [
  ...mango.allocations,
  { docType: "purchase", docId: 999, batchNumber: mango.batch, quantity: 1, unitCost: 90 },
]).ok, false, "source allocations without matching ledger documents fail closed");
assert.equal(resolveHistoricalBatchCoverage(25, [{
  txnType: "transfer_in", txnDate: "2026-08-26", docType: "stock_transfer", docId: 501, qtyChange: 25,
}], [{
  docType: "stock_transfer", docId: 501, batchNumber: transferredPurchasedLot.batch,
  quantity: 25, unitCost: 90,
}], [{ batchNumber: transferredPurchasedLot.batch, unitCost: 90 }]).ok, true,
"a transferred batch may use its exact purchase-line cost when a dated purchase ledger row proves its source");
assert.equal(resolveHistoricalBatchCoverage(25, [{
  txnType: "transfer_in", txnDate: "2026-08-26", docType: "stock_transfer", docId: 501, qtyChange: 25,
}], [{
  docType: "stock_transfer", docId: 501, batchNumber: transferredPurchasedLot.batch,
  quantity: 25, unitCost: 90,
}], [
  ...transferredPurchasedLot.purchaseBatchCosts,
  { batchNumber: transferredPurchasedLot.batch, unitCost: 91 },
]).ok, false, "conflicting purchase-line costs for a batch remain unverified");
assert.equal(resolveHistoricalBatchCoverage(25, [{
  txnType: "purchase", txnDate: "2026-08-26", docType: "purchase", docId: 501, qtyChange: 50,
}, {
  txnType: "purchase_reversal", txnDate: "2026-08-27", docType: "purchase", docId: 501, qtyChange: -25,
}], [{
  docType: "purchase", docId: 501, batchNumber: transferredPurchasedLot.batch,
  quantity: 25, unitCost: 90, purchaseCost: true,
}]).ok, true, "purchase reversals resolve only when the current source line exactly reconciles the net ledger movement");
assert.equal(resolveHistoricalBatchCoverage(25, [{
  txnType: "purchase", txnDate: "2026-08-26", docType: "purchase", docId: 501, qtyChange: 50,
}, {
  txnType: "purchase_reversal", txnDate: "2026-08-27", docType: "purchase", docId: 501, qtyChange: -26,
}], [{
  docType: "purchase", docId: 501, batchNumber: transferredPurchasedLot.batch,
  quantity: 25, unitCost: 90, purchaseCost: true,
}]).ok, false, "purchase reversals with a source-line/net quantity mismatch fail closed");
assert.equal(resolveHistoricalBatchCoverage(25, [{
  txnType: "purchase", txnDate: "2026-08-26", docType: "purchase", docId: 505, qtyChange: 25,
}, {
  txnType: "purchase", txnDate: "2026-08-26", docType: "purchase", docId: 506, qtyChange: 10,
}, {
  txnType: "purchase_reversal", txnDate: "2026-08-27", docType: "purchase", docId: 506, qtyChange: -10,
}], [{
  docType: "purchase", docId: 505, batchNumber: transferredPurchasedLot.batch,
  quantity: 25, unitCost: 90, purchaseCost: true,
}]).ok, true, "balanced zero-net purchase reversals need no active batch allocation");
assert.equal(resolveHistoricalBatchCoverage(25, [{
  txnType: "purchase", txnDate: "2026-08-26", docType: "purchase", docId: 503, qtyChange: 25,
}, {
  txnType: "purchase_reversal", txnDate: "2026-08-27", docType: "purchase", docId: 503, qtyChange: -25,
}], [
  { docType: "purchase", docId: 503, batchNumber: transferredPurchasedLot.batch, quantity: 25, unitCost: 90, purchaseCost: true },
]).ok, false, "zero-net purchase lines with an unmatched allocation fail closed");
assert.equal(resolveHistoricalBatchCoverage(25, [{
  txnType: "purchase", txnDate: "2026-08-26", docType: "purchase", docId: 504, qtyChange: 25,
}, {
  txnType: "purchase_reversal", txnDate: "2026-08-27", docType: "purchase", docId: 504, qtyChange: -25,
}], [
  { docType: "purchase", docId: 504, batchNumber: transferredPurchasedLot.batch, quantity: 25, unitCost: 90, purchaseCost: true },
]).ok, false, "zero-net purchase reversals with stale source allocations fail quantity reconciliation");
const staleNonStockPurchase = resolveHistoricalBatchCoverage(8, [
  { txnType: "purchase", txnDate: "2026-06-12", docType: "purchase", docId: 40, qtyChange: 10, unitCost: 190 },
  { txnType: "purchase", txnDate: "2026-07-04", docType: "purchase", docId: 38, qtyChange: 1, unitCost: 1200 },
  { txnType: "sale", txnDate: "2026-07-22", docType: "sale", docId: 1006, qtyChange: -1, unitCost: 1200 },
  { txnType: "sale", txnDate: "2026-07-28", docType: "sale", docId: 1032, qtyChange: -2, unitCost: 190 },
], [
  { docType: "purchase", docId: 40, batchNumber: "PUR-20260612-00327", quantity: 10, unitCost: 190, purchaseCost: true },
  { docType: "sale", docId: 1006, batchNumber: "PUR-20260704-00323", quantity: 1, unitCost: 1200 },
  { docType: "sale", docId: 1032, batchNumber: "PUR-20260612-00327", quantity: 2, unitCost: 190 },
]);
assert.equal(staleNonStockPurchase.ok, true,
  "a removed non-stock purchase line may neutralize only an exact, fully-consumed matching sale batch");
if (staleNonStockPurchase.ok) {
  assert.equal(staleNonStockPurchase.value, 1520,
    "the consumed non-stock batch contributes no value to the remaining historical stock");
}
const verifiedAdjustment = resolveHistoricalBatchCoverage(5, [
  { txnType: "purchase", txnDate: "2026-08-25", docType: "purchase", docId: 505, qtyChange: 3 },
  { txnType: "adjustment", txnDate: "2026-08-27", docType: "stock_verification", docId: 506, qtyChange: 2 },
], [
  { docType: "purchase", docId: 505, batchNumber: "PUR-1", quantity: 3, unitCost: 10, purchaseCost: true },
  { docType: "stock_verification", docId: 506, batchNumber: "ADJ-506", quantity: 2, unitCost: 115.07, costEvidence: true },
]);
assert.equal(verifiedAdjustment.ok, true, "a positive count adjustment uses its persisted verification cost and adjustment batch");
if (verifiedAdjustment.ok) assert.equal(verifiedAdjustment.value, 260.14);
assert.equal(resolveHistoricalBatchCoverage(5, [
  { txnType: "purchase", txnDate: "2026-08-25", docType: "purchase", docId: 505, qtyChange: 3 },
  { txnType: "adjustment", txnDate: "2026-08-27", docType: "stock_verification", docId: 506, qtyChange: 2 },
], [
  { docType: "purchase", docId: 505, batchNumber: "PUR-1", quantity: 3, unitCost: 10, purchaseCost: true },
  { docType: "stock_verification", docId: 506, batchNumber: "ADJ-506", quantity: 2, unitCost: 115.07 },
]).ok, false, "an adjustment batch without trusted persisted cost evidence fails closed");
const reversedSaleId = strawberry.movements.find((m) => m.txnType === "sale_reversal")?.docId;
assert.ok(reversedSaleId != null);
assert.equal(resolveHistoricalBatchCoverage(strawberry.expected, strawberry.movements,
  strawberry.allocations.filter((a) => a.docId !== reversedSaleId)).ok, true,
  "a fully balanced sale/reversal pair with zero net quantity does not require a current sale line");

type StockAsOfFixture = {
  docs: Doc[];
  expected: number;
  cost: number;
  batch: string;
  purchaseBatchCosts?: Array<{
    material_type: string; ref_id: number; batch_number: string; unit_cost: string;
  }>;
};

function dbFor(fixture: StockAsOfFixture) {
  const reversedSaleId = fixture.docs.find((d) => d.txnType === "sale_reversal")?.docId;
  const rows = fixture.docs.map((d) => ({
    txn_type: d.txnType, txn_date: "2026-09-20", doc_type: d.docType, doc_id: d.docId,
    qty_change: d.qty,
    purchase_lines: d.purchaseLines ?? null,
    sale_lines: d.docType === "sale"
      ? d.docId === reversedSaleId ? [{ itemId: 88, quantity: 1, batchBreakdown: [] }] : d.lines
      : null,
    sales_return_lines: d.returnLines ?? null,
    purchase_return_lines: d.purchaseReturnLines ?? null,
    purchase_source_lines: d.purchaseSourceLines ?? null,
    transfer_lines: d.docType === "stock_transfer" ? d.lines : null,
    received_lines: d.docType === "stock_transfer" && d.txnType === "transfer_in"
      ? d.lines.map(({ batchBreakdown: _ignored, ...line }) => ({ ...line, quantity: d.receivedQty ?? line.quantity, costPrice: 0 }))
      : null,
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
      if (sql.includes("historical purchase batch cost catalog")) {
        return { rows: fixture.purchaseBatchCosts ?? [] };
      }
      if (sql.includes("purchase_return_lines") && sql.includes("purchase_source_lines") && sql.includes("received_line_items")) return { rows };
      if (sql.includes("FROM stock_reservations")) return { rows: [] };
      if (sql.includes("FROM stock_transfers t")) return { rows: [] };
      if (sql.includes("FROM items")) return { rows: [{ id: 9, name: fixture.batch, unit: "kg", unit_cost: "999" }] };
      throw new Error(`Unexpected read-only test query: ${sql}`);
    },
  };
}

for (const fixture of [mango, strawberry, returnedLot, purchaseReturnedLot, transferredPurchasedLot]) {
  const result = await stockAsOf("2026-09-30", null, dbFor(fixture) as any);
  assert.equal(result.reliable, true, `stockAsOf accepts fully dated, purchase-backed batch coverage: ${result.note}`);
  assert.equal(result.items[0]?.stock, fixture.expected);
  assert.equal(result.items[0]?.unitCost, fixture.cost);
  assert.equal(result.total, fixture.expected * fixture.cost);
}

console.log("historical-batch-fallback: purchase-backed lots, returns, and ambiguous evidence resolve or fail closed");
