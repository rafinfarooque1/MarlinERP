/**
 * Sales-list received-ledger labels.
 *
 * Protects the distinction between the payment method stored on a sale and the
 * Cash & Bank account that actually received each payment:
 *   - legacy direct-cash rows resolve the location cash ledger;
 *   - receipt-backed bank/UPI rows use their explicit destination;
 *   - split collections expose every distinct destination;
 *   - clearing-only history exposes no destination, allowing the UI to use its
 *     normalized payment-mode fallback instead of showing Electronic Clearing.
 *
 * Run with the API server already listening:
 *   node artifacts/api-server/tests/sales-received-ledger.test.mjs
 */
import pg from "pg";
import bcrypt from "bcryptjs";

const BASE = "http://localhost:8080/api";
const sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (text, params = []) => (await sql.query(text, params)).rows;
const TAG = `ZZ received-ledger-${Date.now()}`;
const USERNAME = `received_ledger_probe_${Date.now()}`;
const PASSWORD = "Probe#ReceivedLedger1";
let authToken = "";
let passed = 0;
let failed = 0;
const saleIds = [];
const receiptIds = [];

function assert(label, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

async function apiGet(path) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data };
}

async function insertSale(invoiceNumber, location, paymentMode, amount = 100, legacyOutletIdentity = false) {
  const isOutlet = location.location_type === "outlet";
  const outletId = isOutlet ? location.id : null;
  const storedLocationType = legacyOutletIdentity && isOutlet ? null : location.location_type;
  const storedLocationId = legacyOutletIdentity && isOutlet ? null : location.id;
  const rows = await q(
    `INSERT INTO sales
       (invoice_number, outlet_id, sale_date, line_items, subtotal, tax_total,
        discount_total, total_amount, payment_mode, amount_paid, payment_status,
        location_type, location_id)
     VALUES ($1, $2, CURRENT_DATE, '[]'::jsonb, $3, 0, 0, $3, $4, $3, 'paid', $5, $6)
     RETURNING id`,
    [invoiceNumber, outletId, amount, paymentMode, storedLocationType, storedLocationId],
  );
  saleIds.push(Number(rows[0].id));
  return Number(rows[0].id);
}

async function insertReceipt(fromLedgerId, toLedgerId, amount, outletId) {
  const rows = await q(
    `INSERT INTO receipts
       (receipt_date, received_from_ledger_id, received_in_ledger_id, amount,
        narration, location_type, location_id, source)
     VALUES (CURRENT_DATE, $1, $2, $3, $4, 'outlet', $5, 'sale')
     RETURNING id`,
    [fromLedgerId, toLedgerId, amount, TAG, outletId],
  );
  receiptIds.push(Number(rows[0].id));
  return Number(rows[0].id);
}

async function insertPayment(saleId, outletId, method, amount, receiptId = null) {
  await q(
    `INSERT INTO sale_payments
       (sale_id, payment_date, method, amount, clearing_receipt_id, outlet_id, source)
     VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, 'test')`,
    [saleId, method, amount, receiptId, outletId],
  );
}

async function setupUser() {
  const hash = bcrypt.hashSync(PASSWORD, 10);
  await q(
    `INSERT INTO employees
       (name, username, password_hash, hierarchy_id, branch_type, branch_id,
        salary, join_date, is_active, must_change_password)
     SELECT 'Received Ledger Probe', $1, $2, MIN(id), 'headoffice', 1, 1,
            CURRENT_DATE, true, false
       FROM hierarchies`,
    [USERNAME, hash],
  );
}

async function teardownUser() {
  await q(`DELETE FROM login_lockouts WHERE username = $1`, [USERNAME]);
  await q(`DELETE FROM login_attempts WHERE username = $1`, [USERNAME]);
  await q(`DELETE FROM employees WHERE username = $1`, [USERNAME]);
}

try {
  await teardownUser();
  await setupUser();

  const login = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  const loginBody = await login.json();
  authToken = loginBody?.token ?? "";
  assert("Probe user logs in", Boolean(authToken), `status=${login.status}`);
  if (!authToken) throw new Error("Unable to authenticate");

  const locationRows = await q(
    `SELECT 'outlet' AS location_type, id, cash_ledger_id
       FROM outlets
      WHERE cash_ledger_id IS NOT NULL
      UNION ALL
     SELECT 'warehouse' AS location_type, id, cash_ledger_id
       FROM warehouses
      WHERE cash_ledger_id IS NOT NULL
      ORDER BY id
      LIMIT 1`,
  );
  const outlet = locationRows[0];
  const ledgers = await q(
    `SELECT id, name, code
       FROM account_ledgers
      WHERE code IN ('STD-SALES', 'STD-ELEC-CLR')
         OR id = $1
      ORDER BY id`,
    [outlet?.cash_ledger_id ?? 0],
  );
  const salesLedger = ledgers.find(row => row.code === "STD-SALES");
  const clearingLedger = ledgers.find(row => row.code === "STD-ELEC-CLR");
  const cashLedger = ledgers.find(row => Number(row.id) === Number(outlet?.cash_ledger_id));
  const bankLedger = (await q(
    `SELECT al.id, al.name
       FROM cash_bank_accounts cba
       JOIN account_ledgers al ON al.id = cba.ledger_id
      WHERE cba.ledger_id <> $1
        AND cba.account_type IN ('bank', 'upi')
      ORDER BY cba.id
      LIMIT 1`,
    [outlet?.cash_ledger_id ?? 0],
  ))[0];
  assert("Fixture has a location cash ledger", Boolean(outlet && cashLedger), JSON.stringify(outlet));
  assert("Fixture has the standard sales and clearing ledgers", Boolean(salesLedger && clearingLedger));
  assert("Fixture has a second Cash & Bank ledger", Boolean(bankLedger), JSON.stringify(bankLedger));
  if (!outlet || !cashLedger || !bankLedger || !salesLedger || !clearingLedger) {
    throw new Error("Required ledger fixture is not available");
  }

  // Legacy direct cash: the route must resolve the location's cash ledger even
  // when the payment history row has no receipt-backed destination.
  const paymentOutletId = outlet.location_type === "outlet" ? outlet.id : 0;
  const legacyCash = await insertSale(`${TAG}-cash`, outlet, "cash", 100, true);
  await insertPayment(legacyCash, paymentOutletId, "cash", 100);

  const explicitBank = await insertSale(`${TAG}-bank`, outlet, "bank");
  await insertPayment(explicitBank, paymentOutletId, "bank", 100,
    await insertReceipt(salesLedger.id, bankLedger.id, 100, outlet.id));

  const split = await insertSale(`${TAG}-split`, outlet, "bank");
  await insertPayment(split, paymentOutletId, "cash", 40,
    await insertReceipt(salesLedger.id, cashLedger.id, 40, outlet.id));
  await insertPayment(split, paymentOutletId, "bank", 60,
    await insertReceipt(salesLedger.id, bankLedger.id, 60, outlet.id));

  const clearingOnly = await insertSale(`${TAG}-clearing`, outlet, "bank_transfer");
  await insertPayment(clearingOnly, paymentOutletId, "bank_transfer", 100,
    await insertReceipt(salesLedger.id, clearingLedger.id, 100, outlet.id));

  const response = await apiGet(`/sales?q=${encodeURIComponent(TAG)}`);
  assert("Sales list answers 200", response.status === 200, `status=${response.status}`);
  const rows = Array.isArray(response.data) ? response.data : response.data?.rows ?? [];
  const byInvoice = new Map(rows.map(row => [row.invoiceNumber, row]));
  const names = invoice => byInvoice.get(invoice)?.receivedLedgerNames ?? [];

  assert("Legacy direct cash uses the location cash ledger",
    names(`${TAG}-cash`).length === 1 && names(`${TAG}-cash`)[0] === cashLedger.name,
    JSON.stringify(names(`${TAG}-cash`)));
  assert("Explicit bank destination is shown",
    names(`${TAG}-bank`).length === 1 && names(`${TAG}-bank`)[0] === bankLedger.name,
    JSON.stringify(names(`${TAG}-bank`)));
  assert("Split collection shows both distinct destinations",
    names(`${TAG}-split`).length === 2 &&
      new Set(names(`${TAG}-split`)).size === 2 &&
      names(`${TAG}-split`).includes(cashLedger.name) &&
      names(`${TAG}-split`).includes(bankLedger.name),
    JSON.stringify(names(`${TAG}-split`)));
  assert("Clearing-only history has no received destination",
    names(`${TAG}-clearing`).length === 0,
    JSON.stringify(names(`${TAG}-clearing`)));
} finally {
  if (saleIds.length) await q(`DELETE FROM sale_payments WHERE sale_id = ANY($1::int[])`, [saleIds]);
  if (receiptIds.length) await q(`DELETE FROM receipts WHERE id = ANY($1::int[])`, [receiptIds]);
  if (saleIds.length) await q(`DELETE FROM sales WHERE id = ANY($1::int[])`, [saleIds]);
  await teardownUser();
  await sql.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}