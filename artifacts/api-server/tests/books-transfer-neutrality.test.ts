import assert from "node:assert/strict";
import {
  applyStockTransferOpeningAdjustment,
  calculatePnlTotals,
  type StockAtDate,
  type StockTransferOpeningAdjustment,
} from "../src/lib/books";

const stock = (total: number, items: StockAtDate["items"] = [], inTransit = 0): StockAtDate => ({
  total,
  inTransit,
  items,
  reliable: true,
  note: null,
});

const adjustment = (
  qty: number,
  value: number,
): StockTransferOpeningAdjustment => ({
  total: value,
  reliable: true,
  note: null,
  lines: [{
    materialType: "material",
    refId: 7,
    qty,
    value,
    unitCost: 100,
    name: "Transfer fixture",
    unit: "ea",
  }],
});

const totals = (values: {
  openingStock: number;
  purchases?: number;
  directExpenses?: number;
  closingStock: number;
  sales?: number;
  directIncome?: number;
  otherIncome?: number;
  indirectExpenses?: number;
}) => calculatePnlTotals({
  sales: values.sales ?? 0,
  directIncome: values.directIncome ?? 0,
  openingStock: values.openingStock,
  purchases: values.purchases ?? 0,
  directExpenses: values.directExpenses ?? 0,
  closingStock: values.closingStock,
  otherIncome: values.otherIncome ?? 0,
  indirectExpenses: values.indirectExpenses ?? 0,
});

// Source: ₹400 of inventory leaves, and the authoritative closing valuation
// reflects the same movement. Transfer ledger income is deliberately not an
// input to the operating P&L calculation.
const sourceOpening = applyStockTransferOpeningAdjustment(
  stock(1_000, [{
    id: 7, name: "Transfer fixture", unit: "ea", stock: 10,
    unitCost: 100, total: 1_000, materialType: "material",
  }]),
  adjustment(-4, -400),
);
assert.equal(sourceOpening.total, 600);
assert.equal(totals({ openingStock: sourceOpening.total, closingStock: 600 }).grossProfit, 0);

// Destination: the same stock arrives; it does not create purchase cost or
// profit independently of the inventory boundary.
const destinationOpening = applyStockTransferOpeningAdjustment(stock(0), adjustment(4, 400));
assert.equal(destinationOpening.total, 400);
assert.equal(totals({ openingStock: destinationOpening.total, closingStock: 400 }).grossProfit, 0);

// Sender-owned transit is included once in the closing stock total. Its
// boundary value offsets dispatch movement; it is not added a second time.
const transitOpening = applyStockTransferOpeningAdjustment(stock(1_000), {
  total: 0,
  reliable: true,
  note: null,
  lines: [],
});
assert.equal(transitOpening.total, 1_000);
assert.equal(
  totals({ openingStock: transitOpening.total, closingStock: 600 + 400 }).costOfGoodsSold,
  0,
);

// No movement: equal opening and closing inventory yields zero COGS.
assert.equal(totals({ openingStock: 1_000, closingStock: 1_000 }).grossProfit, 0);

// Ordinary sales, purchases, direct and indirect costs still affect the
// authoritative calculation; a zero-sales shortcut cannot erase real losses.
assert.deepEqual(totals({
  openingStock: 100,
  purchases: 50,
  directExpenses: 10,
  closingStock: 70,
  sales: 120,
  otherIncome: 5,
  indirectExpenses: 10,
}), {
  revenue: 120,
  costOfGoodsSold: 90,
  grossProfit: 30,
  netProfit: 25,
});

// The example's indirect expense remains a real net loss if GP reconciles to 0.
assert.equal(totals({
  openingStock: 1_000,
  closingStock: 1_000,
  indirectExpenses: 1_258.07,
}).netProfit, -1_258.07);

console.log("Books transfer-neutrality calculation tests passed.");
