import assert from "node:assert/strict";
import { balanceSheetAssetsTotal } from "../src/lib/books";

const fixedAssets = 100;
const currentAssets = 50;
const closingStock = 10;
const nonStockLiabilities = 50;
const cumulativeProfitBeforeStock = 100;
const retainedEarnings = cumulativeProfitBeforeStock + closingStock;
const assets = balanceSheetAssetsTotal(fixedAssets, currentAssets, closingStock);
const liabilitiesAndEquity = nonStockLiabilities + retainedEarnings;

assert.equal(assets, 160);
assert.equal(liabilitiesAndEquity, 160);
assert.equal(assets - liabilitiesAndEquity, 0, "closing stock belongs in assets as well as P&L carry-forward");
assert.equal(
  balanceSheetAssetsTotal(fixedAssets, currentAssets, 0) - liabilitiesAndEquity,
  -closingStock,
  "omitting the inventory asset creates a balance-sheet gap equal to closing stock",
);

console.log("Closing stock is included in Balance Sheet assets and reconciles with P&L carry-forward.");
