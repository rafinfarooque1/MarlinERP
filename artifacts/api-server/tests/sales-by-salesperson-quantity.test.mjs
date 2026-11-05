import assert from "node:assert/strict";

const BASE = process.env.API_URL || "http://localhost:8080/api";
const round2 = (value) => Math.round(Number(value ?? 0) * 100) / 100;
const round3 = (value) => Math.round(Number(value ?? 0) * 1000) / 1000;

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

async function get(path) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${loginData.token}` },
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data };
}

const range = "from=1900-01-01&to=2099-12-31";
const [salespeople, items] = await Promise.all([
  get(`/reports/sales-by-salesperson?${range}`),
  get(`/reports/sales-by-item?${range}`),
]);

assert.equal(salespeople.status, 200, "By Salesman endpoint succeeds");
assert.equal(items.status, 200, "By Item endpoint succeeds");
assert.ok(salespeople.data.rows.every((row) => Number.isFinite(Number(row.quantity))),
  "every salesperson row includes a finite quantity");
assert.ok(salespeople.data.rows.every((row) =>
  row.quantity > 0
    ? Number.isFinite(Number(row.averagePerKg))
    : row.averagePerKg == null),
"average per kg is finite for positive quantities and blank when quantity is zero");
assert.equal(
  round3(salespeople.data.rows.reduce((sum, row) => sum + Number(row.quantity), 0)),
  round3(salespeople.data.totals.quantity),
  "salesperson row quantities reconcile with the report total",
);
assert.equal(
  round3(salespeople.data.totals.quantity),
  round3(items.data.totals.qty),
  "By Salesman quantity matches By Item for the same date and location scope",
);
const itemQuantity = Number(items.data.totals.qty);
const expectedAverage = itemQuantity > 0
  ? round2(Number(items.data.totals.total) / itemQuantity)
  : null;
assert.equal(
  salespeople.data.totals.averagePerKg == null
    ? null
    : round2(salespeople.data.totals.averagePerKg),
  expectedAverage,
  "total average per kg equals merchandise item total divided by quantity",
);

console.log(
  `By Salesman quantity and average verified: ${round3(salespeople.data.totals.quantity)} qty, ` +
  `${salespeople.data.totals.averagePerKg == null ? "n/a" : round3(salespeople.data.totals.averagePerKg)} per kg`,
);
