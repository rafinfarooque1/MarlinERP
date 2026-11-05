import assert from "node:assert/strict";

const BASE = process.env.API_URL || "http://localhost:8080/api";
const round2 = (value) => Math.round(Number(value ?? 0) * 100) / 100;

const login = await fetch(`${BASE}/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    username: process.env.TEST_USERNAME,
    password: process.env.TEST_PASSWORD,
  }),
});
const loginData = await login.json();
assert.ok(loginData.token, "fixture user logs in");

const query = new URLSearchParams({
  fromDate: "1900-01-01",
  toDate: "2099-12-31",
});
const response = await fetch(`${BASE}/gst/summary?${query}`, {
  headers: { Authorization: `Bearer ${loginData.token}` },
});
const body = await response.json();
assert.equal(response.status, 200, "GST summary endpoint succeeds");

for (const [label, items] of [
  ["sales", body.salesByItem],
  ["purchases", body.purchasesByItem],
]) {
  assert.ok(Array.isArray(items), `${label} item-wise rows are present`);
  assert.ok(items.every((row) =>
    typeof row.itemName === "string" && row.itemName.length > 0 &&
    Number.isFinite(Number(row.quantity)) &&
    ["taxRate", "taxableValue", "cgst", "sgst", "igst", "taxAmount"].every((key) => Number.isFinite(Number(row[key])))),
  `${label} item rows have names and finite GST values`);
}

function assertItemTotalsMatchRateRows(items, rateRows, label) {
  const grouped = new Map();
  for (const item of items) {
    const rate = Number(item.taxRate);
    const aggregate = grouped.get(rate) ?? { taxableValue: 0, cgst: 0, sgst: 0, igst: 0, taxAmount: 0 };
    for (const key of Object.keys(aggregate)) aggregate[key] += Number(item[key] ?? 0);
    grouped.set(rate, aggregate);
  }

  const rates = new Map(rateRows.map((row) => [Number(row.taxRate), row]));
  assert.deepEqual(
    [...grouped.keys()].sort((a, b) => a - b),
    [...rates.keys()].sort((a, b) => a - b),
    `${label} item rows cover the same GST rates`,
  );
  for (const [rate, totals] of grouped) {
    const expected = rates.get(rate);
    const roundingTolerance = Math.max(0.02, items.length * 0.005);
    for (const key of Object.keys(totals)) {
      assert.ok(
        Math.abs(round2(totals[key]) - round2(expected[key])) <= roundingTolerance,
        `${label} ${key} reconciles at ${rate}% (item rows ${totals[key]}, rate summary ${expected[key]})`,
      );
    }
  }
}

assertItemTotalsMatchRateRows(body.salesByItem, body.salesByRate, "sales");
assertItemTotalsMatchRateRows(body.purchasesByItem, body.purchasesByRate, "purchases");

console.log(
  `GST item-wise summary verified: ${body.salesByItem.length} sales rows, ` +
  `${body.purchasesByItem.length} purchase rows.`,
);
