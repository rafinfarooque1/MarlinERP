/**
 * POS Other Charges — integration tests
 * Run: node artifacts/api-server/tests/pos-other-charges.test.mjs
 *
 * Rules under test (mirrors the Purchase Bill "Other Charges" system):
 *   · Charges are flat post-tax amounts folded into total_amount; subtotal and
 *     tax_total stay goods-only (charges carry NO GST — taxable value is
 *     unchanged by a charge).
 *   · Books: revenue = total − tax − charges; each charge posts Cr to its own
 *     expense ledger; the Dr side (cash/clearing/customer) carries the FULL
 *     total. Trial balance stays balanced.
 *   · Validation on the EFFECTIVE ledger (NEW sales): postable, active,
 *     INCOME-type, strictly under Direct Income (SYS-DIRINC), not a system
 *     ledger; amounts > 0, paise precision. Historical sales that charged
 *     expense ledgers are grandfathered on EDIT (stored ids stay legal).
 *   · Edit REPLACES the stored list when supplied, preserves it when the field
 *     is absent, clears it on []. No duplicate postings after an edit.
 *   · Cancel reverses everything (derived postings skip cancelled sales).
 *   · A ledger referenced by any sale's charges cannot be deleted.
 *   · Charge postings are stamped to the SELLING location.
 *   · The invoice PDF shows one row per charge with the ledger's name.
 *
 * Runs against the DEVELOPMENT database the dev API server is using. Creates
 * clearly-marked ZZTEST fixtures and deletes every one of them at the end.
 */

import pg from 'pg';
import bcrypt from 'bcryptjs';
import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';

const BASE = process.env.API_URL || 'http://localhost:8080/api';
const TAG = 'ZZTEST';
const WH = 2; // Marlin Mangaluru Depot — same warehouse the other suites use

let authToken = '';
let passed = 0, failed = 0;
const failures = [];

function assert(label, condition, detail = '') {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; failures.push(label); }
}
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) < eps;

async function apiReq(method, path, body, token = authToken) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(`${BASE}${path}`, opts);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}
const post = (p, b, t) => apiReq('POST', p, b, t);
const put = (p, b, t) => apiReq('PUT', p, b, t);
const get = (p, t) => apiReq('GET', p, undefined, t);
const del = (p, t) => apiReq('DELETE', p, undefined, t);
const r2 = (n) => Math.round(n * 100) / 100;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sql = (text, params) => pool.query(text, params);

async function saleRow(id) {
  const { rows } = await sql(
    `SELECT invoice_number, subtotal::numeric AS subtotal, tax_total::numeric AS tax_total,
            discount_total::numeric AS discount_total, total_amount::numeric AS total,
            other_charges, location_type, location_id, cancelled_at
       FROM sales WHERE id = $1`, [id]);
  return rows[0];
}
async function snapshotTB() {
  const res = await get('/accounts/trial-balance');
  const rows = res.data?.rows ?? [];
  return {
    totalDr: r2(rows.reduce((s, r) => s + Number(r.debit ?? 0), 0)),
    totalCr: r2(rows.reduce((s, r) => s + Number(r.credit ?? 0), 0)),
    balanced: res.data?.balanced ?? true,
  };
}
/** Ledger-statement entries mentioning an invoice number. */
async function stmtEntries(accountId, inv) {
  const res = await get(`/accounts/ledger-statement?accountId=${accountId}&fromDate=2026-08-01&toDate=2026-08-31`);
  const entries = res.data?.entries ?? res.data?.rows ?? [];
  return entries.filter(e => JSON.stringify(e).includes(inv));
}

const fixtures = { vendorId: 0, itemA: 0, customerId: 0, ledgerPack: 0, ledgerFreight: 0, ledgerLegacyExp: 0 };
const createdPurchases = [];
const createdSales = [];

async function cleanup() {
  for (const id of createdSales.slice().reverse()) {
    await post(`/sales/${id}/cancel`, { reason: 'test cleanup' }).catch(() => {});
    const row = await saleRow(id).catch(() => null);
    if (row) await sql(`DELETE FROM receipts WHERE voucher_number = $1`, [row.invoice_number]);
    await sql(`DELETE FROM sale_payments WHERE sale_id = $1`, [id]);
    await sql(`DELETE FROM sales WHERE id = $1`, [id]);
  }
  createdSales.length = 0;
  for (const id of createdPurchases) { await del(`/purchases/${id}`).catch(() => {}); }
  createdPurchases.length = 0;
  await sql(`DELETE FROM purchases WHERE vendor_id IN (SELECT id FROM vendors WHERE name LIKE $1)`, [`${TAG}%`]);
  await sql(`DELETE FROM stock_ledger WHERE item_name LIKE $1`, [`${TAG}%`]);
  const ids = (await sql(`SELECT id FROM items WHERE name LIKE $1`, [`${TAG}%`])).rows.map(r => r.id);
  if (ids.length) {
    await sql(`DELETE FROM stock_batches WHERE item_id = ANY($1::int[]) AND material_type = 'item'`, [ids]);
    await sql(`DELETE FROM stock_entries WHERE item_id = ANY($1::int[]) AND material_type = 'item'`, [ids]);
  }
  await sql(`DELETE FROM items WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM account_ledgers WHERE name LIKE $1 AND code LIKE 'VEND-%'`, [`${TAG}%`]);
  await sql(`DELETE FROM vendors WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM account_ledgers WHERE name LIKE $1 AND code LIKE 'CUST-%'`, [`${TAG}%`]);
  await sql(`DELETE FROM customers WHERE name LIKE $1`, [`${TAG}%`]);
  // Charge ledgers last — nothing references them once the sales are gone.
  await sql(`DELETE FROM account_ledgers WHERE name LIKE $1 AND type IN ('expense','income') AND is_group = false`, [`${TAG}%`]);
}

// Level-1 probe user, provisioned directly in the DB (never 'admin') when no
// TEST_USERNAME/TEST_PASSWORD pair is exported — same pattern as the
// partial/overpay suite.
const PROBE_USER = 'pos_charges_probe';
const PROBE_PASS = 'Probe#Charges1';
async function setupProbeUser() {
  await teardownProbeUser();
  await sql(
    `INSERT INTO employees (name, username, password_hash, hierarchy_id, branch_type, branch_id, salary, join_date, is_active, must_change_password)
     SELECT 'POS Charges Probe', $1, $2, (SELECT MIN(id) FROM hierarchies), 'headoffice', 1, 1, CURRENT_DATE, true, false`,
    [PROBE_USER, bcrypt.hashSync(PROBE_PASS, 10)]);
}
async function teardownProbeUser() {
  await sql(`DELETE FROM login_lockouts WHERE username = $1`, [PROBE_USER]);
  await sql(`DELETE FROM login_attempts WHERE username = $1`, [PROBE_USER]);
  await sql(`DELETE FROM employees WHERE username = $1`, [PROBE_USER]);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[0] Authentication and fixtures');

let usingProbe = false;
if (!process.env.TEST_USERNAME) { await setupProbeUser(); usingProbe = true; }
const loginRes = await post('/auth/login', {
  username: process.env.TEST_USERNAME || PROBE_USER,
  password: process.env.TEST_USERNAME ? process.env.TEST_PASSWORD : PROBE_PASS,
});
authToken = loginRes.data?.token ?? '';
assert('Admin-level login returns a token', !!authToken, `status=${loginRes.status}`);
if (!authToken) { console.error('FATAL: no token'); process.exit(1); }

await cleanup(); // in case a previous run died mid-way
const tbBefore = await snapshotTB();

fixtures.vendorId = (await sql(
  `INSERT INTO vendors (name, state, gst_number) VALUES ($1,'Karnataka','29ZZOCH1234F1Z5') RETURNING id`,
  [`${TAG} OC Vendor`])).rows[0].id;
fixtures.itemA = (await sql(
  `INSERT INTO items (name, unit, hsn_code, tax_rate, mrp, item_code, barcode, status)
   VALUES ($1,'KG','08119010',5,100,'FG-ZZTEST-OC','2900000000311','active') RETURNING id`,
  [`${TAG} OC Item A5`])).rows[0].id;

// Charge ledgers: postable INCOME ledgers under Direct Income (SYS-DIRINC) —
// exactly what the dropdown offers and the server accepts for NEW sales.
const { rows: [dirInc] } = await sql(`SELECT id FROM account_ledgers WHERE code = 'SYS-DIRINC'`);
assert('Direct Income group (SYS-DIRINC) exists to parent the charge ledgers', !!dirInc);
for (const [key, name] of [['ledgerPack', 'Packing & Transport'], ['ledgerFreight', 'Freight Recovered']]) {
  fixtures[key] = (await sql(
    `INSERT INTO account_ledgers (name, type, section, parent_id, is_system_group, description)
     VALUES ($1, 'income', 'profit_loss', $2, false, 'disposable test fixture') RETURNING id`,
    [`${TAG} ${name}`, dirInc.id])).rows[0].id;
}
// A legacy-style expense ledger (outside SYS-PUR) — refused on NEW sales,
// grandfathered when a historical sale already stores it.
const { rows: [expGroup] } = await sql(
  `WITH RECURSIVE pur AS (
     SELECT id FROM account_ledgers WHERE code = 'SYS-PUR'
     UNION ALL SELECT l.id FROM account_ledgers l JOIN pur p ON l.parent_id = p.id
   )
   SELECT id FROM account_ledgers
    WHERE type = 'expense' AND is_group = true AND id NOT IN (SELECT id FROM pur)
    ORDER BY id LIMIT 1`);
assert('An expense group outside SYS-PUR exists for the legacy fixture', !!expGroup);
fixtures.ledgerLegacyExp = (await sql(
  `INSERT INTO account_ledgers (name, type, section, parent_id, is_system_group, description)
   VALUES ($1, 'expense', 'profit_loss', $2, false, 'disposable test fixture') RETURNING id`,
  [`${TAG} Legacy Cartage`, expGroup.id])).rows[0].id;

// Registered customer with headroom for a credit sale.
{
  const c = await post('/customers', { name: `${TAG} OC Buyer`, phone: '9111100077', state: 'Karnataka' });
  fixtures.customerId = c.data?.id ?? 0;
  assert('Customer created via API', c.status === 201 && fixtures.customerId > 0, JSON.stringify(c.data).slice(0, 150));
  await sql(`UPDATE customers SET credit_limit = 100000 WHERE id = $1`, [fixtures.customerId]).catch(() => {});
}

// Stock: 200 units into the warehouse.
{
  const res = await post('/purchases', {
    vendorId: fixtures.vendorId, purchaseDate: '2026-08-01', vendorInvoiceDate: '2026-07-31',
    locationType: 'warehouse', locationId: WH,
    lineItems: [{ materialType: 'item', materialId: fixtures.itemA, quantity: 200, unitCost: 50, mfgDate: '2026-07-01', expiryDate: '2027-07-01' }],
  });
  if (res.status === 201 && res.data?.id) createdPurchases.push(res.data.id);
  assert('Stock purchase lands', res.status === 201, JSON.stringify(res.data).slice(0, 150));
}

const salePayload = (lineItems, extra = {}) => ({
  outletId: WH, locationType: 'warehouse', locationId: WH,
  saleDate: '2026-08-02', paymentMode: 'cash', lineItems, ...extra,
});
async function createSale(lineItems, extra = {}) {
  const res = await post('/sales', salePayload(lineItems, extra));
  if (res.status === 201 && res.data?.id) createdSales.push(res.data.id);
  return res;
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[A] Validation: NEW sales accept only postable Direct Income ledgers');
{
  const badAmount = await createSale(
    [{ itemId: fixtures.itemA, quantity: 1, unitPrice: 100 }],
    { otherCharges: [{ ledgerId: fixtures.ledgerPack, amount: 0 }] });
  assert('Zero amount refused (400)', badAmount.status === 400, `status=${badAmount.status}`);

  const badPrecision = await createSale(
    [{ itemId: fixtures.itemA, quantity: 1, unitPrice: 100 }],
    { otherCharges: [{ ledgerId: fixtures.ledgerPack, amount: 10.005 }] });
  assert('Sub-paise amount refused (400)', badPrecision.status === 400, `status=${badPrecision.status}`);

  const badExpense = await createSale(
    [{ itemId: fixtures.itemA, quantity: 1, unitPrice: 100 }],
    { otherCharges: [{ ledgerId: fixtures.ledgerLegacyExp, amount: 10 }] });
  assert('Expense ledger refused on a NEW sale (400)', badExpense.status === 400, `status=${badExpense.status}`);

  // An income ledger OUTSIDE the SYS-DIRINC subtree (e.g. under Sales) is
  // barred too — the rule is "Direct Income", not "any income".
  const { rows: [incomeElsewhere] } = await sql(
    `WITH RECURSIVE di AS (
       SELECT id FROM account_ledgers WHERE code = 'SYS-DIRINC'
       UNION ALL SELECT l.id FROM account_ledgers l JOIN di d ON l.parent_id = d.id
     )
     SELECT id FROM account_ledgers
      WHERE type = 'income' AND is_group = false AND id NOT IN (SELECT id FROM di)
      ORDER BY id LIMIT 1`);
  if (incomeElsewhere) {
    const badOutside = await createSale(
      [{ itemId: fixtures.itemA, quantity: 1, unitPrice: 100 }],
      { otherCharges: [{ ledgerId: incomeElsewhere.id, amount: 10 }] });
    assert('Income ledger outside SYS-DIRINC refused (400)', badOutside.status === 400, `status=${badOutside.status}`);
  }
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[B] Cash walk-in sale with two charges: total includes them, goods figures do not');
let saleB = null, saleBRow = null;
{
  // 10 × ₹100 inclusive of 5% GST → subtotal 952.38, tax 47.62, goods 1000.
  const res = await createSale(
    [{ itemId: fixtures.itemA, quantity: 10, unitPrice: 100 }],
    { otherCharges: [{ ledgerId: fixtures.ledgerPack, amount: 50 }, { ledgerId: fixtures.ledgerFreight, amount: 30.25 }] });
  assert('Sale accepted', res.status === 201, JSON.stringify(res.data).slice(0, 200));
  saleB = res.data;
  saleBRow = await saleRow(saleB.id);
  assert('total_amount = goods 1000 + charges 80.25', near(saleBRow.total, 1080.25), `total=${saleBRow.total}`);
  assert('subtotal stays goods-only (952.38)', near(saleBRow.subtotal, 952.38), `subtotal=${saleBRow.subtotal}`);
  assert('tax_total stays goods-only (47.62) — charges carry NO GST', near(saleBRow.tax_total, 47.62), `tax=${saleBRow.tax_total}`);
  const oc = saleBRow.other_charges ?? [];
  assert('Stored jsonb has both rows', Array.isArray(oc) && oc.length === 2, JSON.stringify(oc));
  assert('Response echoes otherCharges + otherChargesTotal', (saleB.otherCharges?.length === 2) && near(saleB.otherChargesTotal, 80.25), JSON.stringify(saleB.otherCharges));
  const { rows: [rec] } = await sql(`SELECT amount::numeric AS amount, location_type, location_id FROM receipts WHERE voucher_number = $1`, [saleBRow.invoice_number]);
  assert('Receipt settles the FULL total incl charges', rec && near(rec.amount, 1080.25), `amount=${rec?.amount}`);
  assert('Receipt stamped to the selling warehouse', rec && rec.location_type === 'warehouse' && Number(rec.location_id) === WH, JSON.stringify(rec));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[C] Books: each charge credits its ledger; trial balance stays balanced');
{
  const inv = saleBRow.invoice_number;
  const packEntries = await stmtEntries(fixtures.ledgerPack, inv);
  const frtEntries = await stmtEntries(fixtures.ledgerFreight, inv);
  assert('Packing ledger shows ONE Cr 50.00 for the invoice',
    packEntries.length === 1 && near(packEntries[0].credit ?? 0, 50), JSON.stringify(packEntries).slice(0, 200));
  assert('Freight ledger shows ONE Cr 30.25 for the invoice',
    frtEntries.length === 1 && near(frtEntries[0].credit ?? 0, 30.25), JSON.stringify(frtEntries).slice(0, 200));
  const tb = await snapshotTB();
  assert('Trial balance balanced after the charged sale', tb.balanced && near(tb.totalDr, tb.totalCr), `Dr=${tb.totalDr} Cr=${tb.totalCr}`);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[D] Control sale without charges: identical goods figures (taxable value unchanged)');
{
  const res = await createSale([{ itemId: fixtures.itemA, quantity: 10, unitPrice: 100 }]);
  assert('Control sale accepted', res.status === 201);
  const row = await saleRow(res.data.id);
  assert('Same subtotal as the charged sale', near(row.subtotal, saleBRow.subtotal), `${row.subtotal} vs ${saleBRow.subtotal}`);
  assert('Same tax as the charged sale', near(row.tax_total, saleBRow.tax_total), `${row.tax_total} vs ${saleBRow.tax_total}`);
  assert('Control total = goods only (1000)', near(row.total, 1000), `total=${row.total}`);
  assert('Control stored charges = []', Array.isArray(row.other_charges) && row.other_charges.length === 0, JSON.stringify(row.other_charges));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[E] Credit sale to a registered customer: dues and debtor include the charges');
let saleE = null;
{
  const res = await createSale(
    [{ itemId: fixtures.itemA, quantity: 5, unitPrice: 100 }],
    { paymentMode: 'credit', customerId: fixtures.customerId, otherCharges: [{ ledgerId: fixtures.ledgerPack, amount: 25 }] });
  assert('Credit sale accepted', res.status === 201, JSON.stringify(res.data).slice(0, 200));
  saleE = res.data;
  assert('Total = 500 goods + 25 charge', near(saleE.totalAmount, 525), `total=${saleE.totalAmount}`);
  assert('Amount due includes the charge', near(saleE.amountDue ?? saleE.balanceDue, 525), `due=${saleE.amountDue ?? saleE.balanceDue}`);
  const custEntries = await stmtEntries(
    (await sql(`SELECT id FROM account_ledgers WHERE code = $1`, [`CUST-${fixtures.customerId}`])).rows[0]?.id ?? 0,
    saleE.invoiceNumber);
  assert('Customer ledger Dr = FULL total incl charge',
    custEntries.some(e => near(e.debit ?? 0, 525)), JSON.stringify(custEntries).slice(0, 200));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[F] Edit semantics: replace / preserve / clear — never duplicate');
{
  const base = {
    outletId: WH, locationType: 'warehouse', locationId: WH, saleDate: '2026-08-02',
    paymentMode: 'cash', lineItems: [{ itemId: fixtures.itemA, quantity: 10, unitPrice: 100 }],
  };
  // Replace: two charges → one bigger one.
  const rep = await put(`/sales/${saleB.id}`, { ...base, otherCharges: [{ ledgerId: fixtures.ledgerPack, amount: 100 }] });
  assert('Edit with a new list accepted', rep.status === 200, JSON.stringify(rep.data).slice(0, 200));
  let row = await saleRow(saleB.id);
  assert('Stored charges REPLACED (1 row, not 3)', (row.other_charges ?? []).length === 1, JSON.stringify(row.other_charges));
  assert('Total recomputed: 1000 + 100', near(row.total, 1100), `total=${row.total}`);
  const frtAfter = await stmtEntries(fixtures.ledgerFreight, row.invoice_number);
  assert('Old freight leg GONE from the books (no duplicates)', frtAfter.length === 0, JSON.stringify(frtAfter).slice(0, 150));
  const packAfter = await stmtEntries(fixtures.ledgerPack, row.invoice_number);
  assert('Packing ledger shows exactly ONE Cr 100', packAfter.length === 1 && near(packAfter[0].credit ?? 0, 100), JSON.stringify(packAfter).slice(0, 150));
  const { rows: [rec] } = await sql(`SELECT amount::numeric AS amount FROM receipts WHERE voucher_number = $1`, [row.invoice_number]);
  assert('Receipt restated to the new total', rec && near(rec.amount, 1100), `amount=${rec?.amount}`);

  // Preserve: PUT with the field ABSENT keeps the stored charges.
  const keep = await put(`/sales/${saleB.id}`, { ...base });
  assert('Edit without the field accepted', keep.status === 200);
  row = await saleRow(saleB.id);
  assert('Charges PRESERVED when the field is absent', (row.other_charges ?? []).length === 1 && near(row.total, 1100), `total=${row.total} oc=${JSON.stringify(row.other_charges)}`);

  // Clear: PUT with [] removes them.
  const clear = await put(`/sales/${saleB.id}`, { ...base, otherCharges: [] });
  assert('Edit with [] accepted', clear.status === 200);
  row = await saleRow(saleB.id);
  assert('Charges CLEARED, total back to goods-only', (row.other_charges ?? []).length === 0 && near(row.total, 1000), `total=${row.total}`);
  const packGone = await stmtEntries(fixtures.ledgerPack, row.invoice_number);
  assert('No charge leg remains in the books', packGone.length === 0, JSON.stringify(packGone).slice(0, 150));

  // Put a charge back for the delete-guard and location tests below.
  await put(`/sales/${saleB.id}`, { ...base, otherCharges: [{ ledgerId: fixtures.ledgerPack, amount: 50 }] });
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[F2] Grandfathering: a historical expense-ledger charge stays legal on EDIT');
{
  // Simulate a pre-rule sale that charged an expense ledger: create clean,
  // then plant the stored jsonb directly (the API would refuse it today).
  const legacy = await createSale([{ itemId: fixtures.itemA, quantity: 1, unitPrice: 100 }]);
  assert('Legacy carrier sale created', legacy.status === 201, JSON.stringify(legacy.data).slice(0, 150));
  await sql(`UPDATE sales SET other_charges = $1::jsonb WHERE id = $2`,
    [JSON.stringify([{ ledgerId: fixtures.ledgerLegacyExp, amount: 40 }]), legacy.data.id]);

  const base = {
    outletId: WH, locationType: 'warehouse', locationId: WH, saleDate: '2026-08-02',
    paymentMode: 'cash', lineItems: [{ itemId: fixtures.itemA, quantity: 1, unitPrice: 100 }],
  };
  // Edit that KEEPS the stored legacy ledger — grandfathered, accepted.
  const keep = await put(`/sales/${legacy.data.id}`, { ...base, otherCharges: [{ ledgerId: fixtures.ledgerLegacyExp, amount: 40 }] });
  assert('Edit keeping the stored expense charge accepted (grandfathered)', keep.status === 200, `status=${keep.status} ${JSON.stringify(keep.data).slice(0, 150)}`);
  let row = await saleRow(legacy.data.id);
  assert('Legacy charge stored and priced into the total (100 + 40)', near(row.total, 140) && (row.other_charges ?? []).length === 1, `total=${row.total}`);
  const expEntries = await stmtEntries(fixtures.ledgerLegacyExp, row.invoice_number);
  assert('Legacy charge still posts to ITS OWN (expense) ledger', expEntries.length === 1 && near(expEntries[0].credit ?? 0, 40), JSON.stringify(expEntries).slice(0, 150));

  // Edit swapping to a Direct Income ledger — plainly legal.
  const swap = await put(`/sales/${legacy.data.id}`, { ...base, otherCharges: [{ ledgerId: fixtures.ledgerFreight, amount: 40 }] });
  assert('Edit swapping legacy → Direct Income accepted', swap.status === 200, `status=${swap.status}`);

  // Grandfathering is PER SALE: an edit may not introduce an expense ledger
  // the sale never stored (saleB only ever charged the income ledgers).
  const smuggle = await put(`/sales/${saleB.id}`, { ...base, lineItems: [{ itemId: fixtures.itemA, quantity: 10, unitPrice: 100 }], otherCharges: [{ ledgerId: fixtures.ledgerLegacyExp, amount: 10 }] });
  assert('Edit introducing a NEW expense charge refused (400)', smuggle.status === 400, `status=${smuggle.status} ${JSON.stringify(smuggle.data).slice(0, 150)}`);
  const tb = await snapshotTB();
  assert('Trial balance balanced after the grandfather dance', tb.balanced && near(tb.totalDr, tb.totalCr), `Dr=${tb.totalDr} Cr=${tb.totalCr}`);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[G] Ledger delete guard: a ledger referenced by a sale cannot be deleted');
{
  const res = await del(`/accounts/chart/${fixtures.ledgerPack}`);
  assert('Delete refused while a sale references the ledger', res.status >= 400, `status=${res.status} ${JSON.stringify(res.data).slice(0, 150)}`);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[H] Location stamping: the charge posting sits in the selling warehouse slice');
{
  const range = 'fromDate=2026-08-02&toDate=2026-08-02';
  const whSlice = await get(`/reports/fin/day-book?${range}&locationType=warehouse&locationId=${WH}`);
  const hoSlice = await get(`/reports/fin/day-book?${range}&locationType=headoffice`);
  const whText = JSON.stringify(whSlice.data);
  const hoText = JSON.stringify(hoSlice.data);
  const inv = saleBRow.invoice_number;
  assert('Warehouse day book carries the charged invoice', whText.includes(inv), `status=${whSlice.status}`);
  assert('Head-office day book does NOT', !hoText.includes(inv), `status=${hoSlice.status}`);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[I] Invoice PDF: one row per charge, named after the ledger');
{
  const r = await fetch(`${BASE}/sales/${saleB.id}/invoice.pdf`, { headers: { Authorization: `Bearer ${authToken}` } });
  assert('PDF endpoint responds', r.status === 200, `status=${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const tmp = `/tmp/zztest-oc-${saleB.id}.pdf`;
  writeFileSync(tmp, buf);
  let text = '';
  try { text = execSync(`pdftotext ${tmp} -`, { encoding: 'utf8' }); } catch (e) { text = ''; }
  unlinkSync(tmp);
  assert('PDF names the charge ledger', text.includes('Packing & Transport'), text.slice(0, 200));
  assert('PDF grand total includes the charge (1,050.00)', /1,?050\.00/.test(text), '');
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[J] Cancel: every consequence of a charged sale reverses');
{
  const res = await createSale(
    [{ itemId: fixtures.itemA, quantity: 2, unitPrice: 100 }],
    { otherCharges: [{ ledgerId: fixtures.ledgerFreight, amount: 15 }] });
  assert('Charged sale to cancel accepted', res.status === 201);
  const inv = res.data.invoiceNumber;
  const cancel = await post(`/sales/${res.data.id}/cancel`, { reason: 'test' });
  assert('Cancel accepted', cancel.status === 200, JSON.stringify(cancel.data).slice(0, 150));
  const frt = await stmtEntries(fixtures.ledgerFreight, inv);
  assert('Charge leg gone from the books after cancel', frt.length === 0, JSON.stringify(frt).slice(0, 150));
  const tb = await snapshotTB();
  assert('Trial balance still balanced', tb.balanced && near(tb.totalDr, tb.totalCr), `Dr=${tb.totalDr} Cr=${tb.totalCr}`);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[K] Returns: charges are NOT refunded (by design, matching purchase returns)');
{
  // Walk-in cash sale: 2 × ₹100 (5% incl) = ₹200 goods + ₹20 charge = ₹220.
  const res = await createSale(
    [{ itemId: fixtures.itemA, quantity: 2, unitPrice: 100 }],
    { otherCharges: [{ ledgerId: fixtures.ledgerFreight, amount: 20 }] });
  assert('Charged sale to return accepted', res.status === 201);
  const ret = await post('/sales-returns', {
    saleId: res.data.id, returnDate: '2026-08-03', reason: `${TAG} full return of charged sale`,
    lines: [{ lineIndex: 0, quantity: 2 }],
  });
  assert('Full return accepted', ret.status === 201, JSON.stringify(ret.data).slice(0, 200));
  assert('Refund covers goods + GST ONLY (₹200), never the ₹20 charge',
    near(ret.data?.totalAmount, 200), `refund=${ret.data?.totalAmount}`);
  const frt = await stmtEntries(fixtures.ledgerFreight, res.data.invoiceNumber);
  assert('Charge ledger credit still stands after the return',
    frt.length === 1 && near(frt[0].credit ?? 0, 20), JSON.stringify(frt).slice(0, 150));
  const tb = await snapshotTB();
  assert('Trial balance balanced after the return', tb.balanced && near(tb.totalDr, tb.totalCr), `Dr=${tb.totalDr} Cr=${tb.totalCr}`);
  // Inline cleanup of what the return created (the sale itself is handled by cleanup()).
  if (ret.data?.refundPaymentId) await sql(`DELETE FROM payments WHERE id = $1`, [ret.data.refundPaymentId]);
  if (ret.data?.creditNoteId) await sql(`DELETE FROM journal_vouchers WHERE id = $1`, [ret.data.creditNoteId]);
  if (ret.data?.id) await sql(`DELETE FROM sales_returns WHERE id = $1`, [ret.data.id]);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[Z] Cleanup and final trial balance');
await cleanup();
{
  const tb = await snapshotTB();
  assert('Trial balance balanced after cleanup', tb.balanced && near(tb.totalDr, tb.totalCr), `Dr=${tb.totalDr} Cr=${tb.totalCr}`);
  assert('Trial balance totals back to the starting point',
    near(tb.totalDr, tbBefore.totalDr, 0.05) && near(tb.totalCr, tbBefore.totalCr, 0.05),
    `before Dr=${tbBefore.totalDr} after Dr=${tb.totalDr}`);
}

if (usingProbe) await teardownProbeUser();
await pool.end();
console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) { console.error('FAILED:', failures.join(' | ')); process.exit(1); }
