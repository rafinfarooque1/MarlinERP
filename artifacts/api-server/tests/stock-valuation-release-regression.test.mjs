import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");

const [route, appRoutes, headOfficeScreen, reportsScreen] = await Promise.all([
  read("artifacts/api-server/src/routes/inventory-batches.ts"),
  read("artifacts/marlin-erp/src/App.tsx"),
  read("artifacts/marlin-erp/src/pages/headoffice/InventoryReports.tsx"),
  read("artifacts/marlin-erp/src/pages/reports/sections/InventoryReports.tsx"),
]);

function testRouteDateSelection() {
  assert.match(route, /router\.get\("\/stock\/valuation"/);
  assert.match(route, /const today = await companyTodayISO\(pool\)/);
  assert.match(route, /const historicalAsOf = asOf && asOf < today \? asOf : undefined/);
  assert.match(route, /asOf: historicalAsOf,\s*includeInTransit: true/);
  assert.match(route, /if \(asOf && asOf > today\)/);
}

function testReportRoutesAndDates() {
  assert.match(appRoutes, /path="\/headoffice\/inventory-reports"/);
  assert.match(appRoutes, /path="\/reports\/:cat"/);
  assert.match(headOfficeScreen, /useGetStockValuation\(valuationParams\)/);
  assert.match(reportsScreen, /params\.asOf = asOf/);
  assert.match(reportsScreen, /const \{ data, isLoading \} = useGetStockValuation\(params\)/);
  assert.match(reportsScreen, /const today = \(\) => formatDate\(new Date\(\)\)/);
}

function testBothScreensAndExportsSeparateCalculationFromApproval() {
  const sharedExplanation =
    "This status describes calculation reliability only; it does not approve or change accountant-review records.";
  for (const [name, source] of [
    ["Head Office Inventory Reports", headOfficeScreen],
    ["Reports Center Inventory Reports", reportsScreen],
  ]) {
    assert.ok(source.includes(sharedExplanation), `${name} explains that reliability is not approval`);
    assert.match(source, /reliable \? 'status' : 'alert'/);
    assert.match(source, /Calculation Reliability['"]?,?\s*.*reliable === false \? 'Partial' : 'Reconciled'/s);
    assert.match(source, /Review\s*\/\s*Approval State['"]?,?\s*.*Not changed by this report/s);
  }

  // Head Office CSV export
  assert.match(headOfficeScreen, /downloadCSV\('stock-valuation\.csv'/);
  assert.match(headOfficeScreen, /'Calculation Reliability': val\?\.reliable === false \? 'Partial' : 'Reconciled'/);
  assert.match(headOfficeScreen, /'Review \/ Approval State': 'Not changed by this report'/);
  assert.match(headOfficeScreen, /'Calculation Note': val\?\.note \?\? ''/);

  // Reports Center CSV and PDF metadata
  assert.match(reportsScreen, /downloadCSV\('stock-valuation\.csv'/);
  assert.match(reportsScreen, /'Calculation Reliability': data\?\.reliable === false \? 'Partial' : 'Reconciled'/);
  assert.match(reportsScreen, /'Review \/ Approval State': 'Not changed by this report'/);
  assert.match(reportsScreen, /\['Calculation reliability', data\?\.reliable === false \? 'Partial' : 'Reconciled'\]/);
  assert.match(reportsScreen, /\['Review \/ approval state', 'Not changed by this report'\]/);
}

testRouteDateSelection();
testReportRoutesAndDates();
testBothScreensAndExportsSeparateCalculationFromApproval();

console.log("stock-valuation-release-regression: date routing, both report screens, CSV, and PDF reliability/approval contracts passed");
