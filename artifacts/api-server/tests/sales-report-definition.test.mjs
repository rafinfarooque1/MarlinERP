/**
 * Sales Register ↔ By Item report-definition regression.
 *
 * This is a read-only check against the development data captured for the
 * Reports Center reconciliation:
 *   warehouse 2, 2026-09-11 through 2026-09-13
 *
 * The two reports intentionally have different meanings:
 *   - Sales Register = complete invoice value, including invoice-level charges.
 *   - By Item = merchandise line totals after tax; invoice-level charges cannot
 *     be attributed to an item and are therefore excluded.
 *
 * Run through the normal fixture wrapper:
 *   node tests/run-with-fixture-auth.mjs tests/sales-report-definition.test.mjs
 */
import assert from "node:assert/strict";
import pg from "pg";
import { createTestAdmin } from "./support/testAuth.mjs";

const BASE = process.env.API_URL || "http://localhost:8080/api";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const fixture = await createTestAdmin(pool, "ZZREPORT");
let token = "";

async function api(path) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data };
}

const near = (a, b, tolerance = 0.005) => Math.abs(Number(a) - Number(b)) <= tolerance;
const ids = [1517, 1518, 1519, 1520, 1521, 1522, 1529, 1530, 1531, 1536, 1540, 1541, 1542, 1546, 1547];
const scope = "from=2026-09-11&to=2026-09-13&locationType=warehouse&locationId=2";

try {
  const login = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: fixture.username,
      password: fixture.password,
    }),
  });
  const loginData = await login.json();
  token = loginData.token;
  assert.ok(token, "report regression login returns a token");

  const [register, byItem, bySalesperson, byLocation, combined] = await Promise.all([
    api(`/reports/sales-register?${scope}`),
    api(`/reports/sales-by-item?${scope}`),
    api(`/reports/sales-by-salesperson?${scope}`),
    api(`/reports/sales-by-location?${scope}`),
    api(`/reports/sales-stock-combined?${scope}`),
  ]);

  assert.equal(register.status, 200, "Sales Register endpoint succeeds");
  assert.equal(byItem.status, 200, "By Item endpoint succeeds");

  assert.deepEqual(register.data.totals, {
    invoices: 15,
    subtotal: 18923.77,
    discount: 0,
    tax: 946.23,
    total: 20020,
    paid: 11405,
    balance: 8235,
  }, "Sales Register keeps the complete invoice totals");

  assert.deepEqual(byItem.data.totals, {
    items: 12,
    qty: 67,
    taxable: 18923.77,
    tax: 946.23,
    total: 19870,
  }, "By Item keeps the merchandise-line totals");

  assert.equal(register.data.totals.total - byItem.data.totals.total, 150,
    "the report difference is exactly the invoice-level charge");
  assert.equal(register.data.totals.total - register.data.totals.paid - register.data.totals.balance, 380,
    "the payment/outstanding difference is exactly the credit-note amount");

  const rows = (await pool.query(
    `SELECT id, invoice_number, total_amount::numeric AS total_amount,
            subtotal::numeric AS subtotal, tax_total::numeric AS tax_total,
            discount_total::numeric AS discount_total, other_charges, line_items
       FROM sales
      WHERE id = ANY($1::int[])
      ORDER BY sale_date, id`,
    [ids],
  )).rows;
  assert.equal(rows.length, 15, "the reconciled population contains exactly 15 invoices");

  const invoiceReconciliation = rows.map((row) => {
    const lines = Array.isArray(row.line_items) ? row.line_items : [];
    const itemTotal = lines.reduce(
      (sum, line) => sum + Number(line.lineTotal ?? ((line.lineSubtotal ?? line.taxableAmount ?? 0) + (line.taxAmount ?? 0))),
      0,
    );
    const itemTaxable = lines.reduce((sum, line) => sum + Number(line.lineSubtotal ?? line.taxableAmount ?? 0), 0);
    const itemTax = lines.reduce((sum, line) => sum + Number(line.taxAmount ?? 0), 0);
    const itemDiscount = lines.reduce((sum, line) => sum + Number(line.discount ?? 0), 0);
    const otherCharges = Array.isArray(row.other_charges)
      ? row.other_charges.reduce((sum, charge) => sum + Number(charge.amount ?? 0), 0)
      : 0;
    return {
      id: Number(row.id),
      invoice: row.invoice_number,
      itemTotal: Math.round(itemTotal * 100) / 100,
      taxable: Math.round(itemTaxable * 100) / 100,
      tax: Math.round(itemTax * 100) / 100,
      discount: Math.round(itemDiscount * 100) / 100,
      otherCharges: Math.round(otherCharges * 100) / 100,
      invoiceTotal: Number(row.total_amount),
      difference: Math.round((Number(row.total_amount) - itemTotal) * 100) / 100,
    };
  });
  const chargeRows = invoiceReconciliation.filter((row) => !near(row.difference, 0));
  assert.deepEqual(chargeRows.map((row) => row.id), [1529],
    "only one invoice contributes to the item/invoice gap");
  assert.equal(chargeRows[0].itemTotal, 2340, "the charged invoice item total is ₹2,340");
  assert.equal(chargeRows[0].otherCharges, 150, "the charged invoice stores ₹150 in other charges");
  assert.equal(chargeRows[0].invoiceTotal, 2490, "the charged invoice total is ₹2,490");
  assert.equal(chargeRows[0].difference, 150, "the charged invoice contributes ₹150");
  assert.equal(invoiceReconciliation.reduce((sum, row) => sum + row.difference, 0), 150,
    "invoice-level reconciliation sums to ₹150");

  const returns = (await pool.query(
    `SELECT sr.sale_id, sr.refund_mode, sr.total_amount::numeric AS total_amount,
            sr.credit_note_id
       FROM sales_returns sr
      WHERE sr.sale_id = 1530`,
  )).rows;
  assert.deepEqual(returns.map((row) => ({
    saleId: Number(row.sale_id),
    mode: row.refund_mode,
    amount: Number(row.total_amount),
    creditNoteId: Number(row.credit_note_id),
  })), [{ saleId: 1530, mode: "credit_note", amount: 380, creditNoteId: 384 }],
    "the ₹380 adjustment is the credit-note return against invoice 000929");

  const paymentSum = (await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::numeric AS amount
       FROM sale_payments
      WHERE sale_id = ANY($1::int[])`,
    [ids],
  )).rows[0];
  assert.equal(Number(paymentSum.amount), 11405,
    "sale payment rows agree with the register's collected amount");
  assert.equal(register.data.rows.find((row) => row.id === 1530)?.creditNotes, 380,
    "the register exposes the credit note on the affected invoice");
  assert.equal(register.data.rows.find((row) => row.id === 1530)?.balance, 0,
    "the credit note settles the affected invoice's remaining balance");

  for (const [name, response] of [["By Salesman", bySalesperson], ["By Location", byLocation]]) {
    assert.equal(response.status, 200, `${name} endpoint succeeds`);
    assert.equal(response.data.totals.invoices, 15, `${name} preserves the invoice population`);
    assert.equal(response.data.totals.total, 20020, `${name} uses complete invoice value`);
  }
  assert.equal(combined.status, 200, "Sales & Stock Summary endpoint succeeds");
  assert.equal(combined.data.sales.invoices, 15, "Sales & Stock Summary preserves the invoice population");
  assert.equal(combined.data.sales.revenue, 20020, "Sales & Stock Summary uses complete invoice value");

  console.log("\nSales report definition regression: PASS");
  console.log(JSON.stringify({ invoiceReconciliation, byItemTotals: byItem.data.totals }, null, 2));
} catch (error) {
  console.error("\nSales report definition regression: FAIL");
  console.error(error);
  process.exitCode = 1;
} finally {
  await fixture.cleanup();
  await pool.end();
}