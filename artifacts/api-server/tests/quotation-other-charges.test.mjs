/**
 * Quotation Other Charges — focused integration coverage.
 *
 * Run: node artifacts/api-server/tests/quotation-other-charges.test.mjs
 *
 * This suite intentionally exercises quotations through the public API:
 * charges are document-only until conversion, are validated as Direct Income
 * ledgers, and are copied into the sale handoff.
 */
import pg from 'pg';
import bcrypt from 'bcryptjs';

const BASE = process.env.API_URL || 'http://localhost:8080/api';
const TAG = `ZZTEST Quotation Charges ${Date.now()}`;
let token = '';
let passed = 0;
let failed = 0;
const failures = [];
const createdQuotes = [];
const createdSales = [];
const createdLedgers = [];

const assert = (label, condition, detail = '') => {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failed++; failures.push(label); }
};
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;

async function api(method, path, body) {
  const options = { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } };
  if (body !== undefined) options.body = JSON.stringify(body);
  const response = await fetch(`${BASE}${path}`, options);
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data };
}
const get = path => api('GET', path);
const post = (path, body) => api('POST', path, body);
const put = (path, body) => api('PUT', path, body);

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const PROBE_USER = 'quotation_charges_probe';
const PROBE_PASS = 'Quotation#Charges1';
async function setupProbeUser() {
  await pool.query('DELETE FROM login_lockouts WHERE username = $1', [PROBE_USER]).catch(() => {});
  await pool.query('DELETE FROM login_attempts WHERE username = $1', [PROBE_USER]).catch(() => {});
  await pool.query('DELETE FROM employees WHERE username = $1', [PROBE_USER]).catch(() => {});
  await pool.query(
    `INSERT INTO employees
       (name, username, password_hash, hierarchy_id, branch_type, branch_id,
        salary, join_date, is_active, must_change_password)
     SELECT 'Quotation Charges Probe', $1, $2, (SELECT MIN(id) FROM hierarchies),
            'headoffice', 1, 1, CURRENT_DATE, true, false`,
    [PROBE_USER, bcrypt.hashSync(PROBE_PASS, 10)],
  );
}
async function teardownProbeUser() {
  await pool.query('DELETE FROM login_lockouts WHERE username = $1', [PROBE_USER]).catch(() => {});
  await pool.query('DELETE FROM login_attempts WHERE username = $1', [PROBE_USER]).catch(() => {});
  await pool.query('DELETE FROM employees WHERE username = $1', [PROBE_USER]).catch(() => {});
}
async function cleanup() {
  for (const id of createdSales.slice().reverse()) {
    await post(`/sales/${id}/cancel`, { reason: 'quotation other-charge test cleanup' }).catch(() => {});
    const { rows } = await pool.query('SELECT invoice_number FROM sales WHERE id = $1', [id]);
    if (rows[0]) {
      await pool.query('DELETE FROM receipts WHERE voucher_number = $1', [rows[0].invoice_number]).catch(() => {});
    }
    await pool.query('DELETE FROM sale_payments WHERE sale_id = $1', [id]).catch(() => {});
    await pool.query('DELETE FROM sales WHERE id = $1', [id]).catch(() => {});
  }
  for (const id of createdQuotes) await api('DELETE', `/quotations/${id}`).catch(() => {});
  if (createdQuotes.length) {
    await pool.query(
      'DELETE FROM quotation_share_links WHERE quotation_id = ANY($1::int[])',
      [createdQuotes],
    ).catch(() => {});
    // Converted quotations are intentionally protected from the public
    // DELETE endpoint; the test cleanup removes its disposable rows only
    // after the converted sale has been removed.
    await pool.query('DELETE FROM quotations WHERE id = ANY($1::int[])', [createdQuotes]).catch(() => {});
  }
  if (createdLedgers.length) {
    await pool.query('DELETE FROM account_ledgers WHERE id = ANY($1::int[])', [createdLedgers]).catch(() => {});
  }
  if (!process.env.TEST_USERNAME) await teardownProbeUser();
  await pool.end();
}

try {
  if (!process.env.TEST_USERNAME) await setupProbeUser();
  const login = await api('POST', '/auth/login', {
    username: process.env.TEST_USERNAME || PROBE_USER,
    password: process.env.TEST_USERNAME ? process.env.TEST_PASSWORD : PROBE_PASS,
  });
  token = login.data?.token ?? '';
  assert('Admin login returns a token', !!token, `status=${login.status}`);
  if (!token) throw new Error('No authentication token');

  const [warehouses, items] = await Promise.all([get('/warehouses'), get('/items')]);
  let location;
  let item;
  for (const warehouse of warehouses.data ?? []) {
    const stock = await get(`/stock?branchType=warehouse&branchId=${warehouse.id}`);
    const candidate = (stock.data ?? [])
      .map(row => ({ row, item: (items.data ?? []).find(i => Number(i.id) === Number(row.itemId)) }))
      .find(x => x.item && Number(x.row.quantity) >= 1 && String(x.item.status ?? 'active') !== 'inactive');
    if (candidate) { location = warehouse; item = candidate.item; break; }
  }
  assert('Found a usable warehouse/item fixture', !!(location && item));
  if (!location || !item) throw new Error('No warehouse item fixture');

  const { rows: [parent] } = await pool.query(
    `SELECT id FROM account_ledgers WHERE code = 'SYS-DIRINC' LIMIT 1`,
  );
  assert('Direct Income group exists', !!parent);
  if (!parent) throw new Error('No Direct Income group');
  for (const suffix of ['Packing', 'Delivery']) {
    const { rows: [ledger] } = await pool.query(
      `INSERT INTO account_ledgers
         (name, type, section, parent_id, is_group, is_system_group, description)
       VALUES ($1, 'income', 'profit_loss', $2, false, false, 'disposable quotation test fixture')
       RETURNING id`,
      [`${TAG} ${suffix}`, parent.id],
    );
    createdLedgers.push(Number(ledger.id));
  }
  const [packingLedger, deliveryLedger] = createdLedgers;
  const today = new Date().toISOString().slice(0, 10);
  const unitPrice = Number(item.mrp) > 0 ? Number(item.mrp) : 100;
  const lineItems = [{ itemId: Number(item.id), quantity: 1, unitPrice, taxAmount: 0 }];
  const base = {
    locationType: 'warehouse', locationId: Number(location.id), quoteDate: today,
    status: 'draft', discountTotal: 0, lineItems,
  };

  console.log('\n[1] Create, response/list/detail persistence, total and no GST');
  const before = await pool.query('SELECT COUNT(*)::int AS n FROM journal_vouchers');
  const created = await post('/quotations', {
    ...base,
    otherCharges: [
      { ledgerId: packingLedger, amount: 25.00 },
      { ledgerId: deliveryLedger, amount: 10.25 },
    ],
  });
  assert('Quotation with multiple charges accepted', created.status === 201 || created.status === 200, `status=${created.status}`);
  const quoteId = Number(created.data?.id);
  if (quoteId) createdQuotes.push(quoteId);
  assert('Response returns both charge rows', created.data?.otherCharges?.length === 2, JSON.stringify(created.data?.otherCharges));
  assert('Charges total is 35.25', near(created.data?.otherChargesTotal, 35.25), `total=${created.data?.otherChargesTotal}`);
  assert('Quoted total includes charges', near(created.data?.totalAmount, Number(created.data?.subtotal) + Number(created.data?.taxTotal) + 35.25), JSON.stringify(created.data));
  const after = await pool.query('SELECT COUNT(*)::int AS n FROM journal_vouchers');
  assert('Creating a quotation posts no accounting entries', Number(after.rows[0].n) === Number(before.rows[0].n));

  const detail = await get(`/quotations/${quoteId}`);
  assert('Detail returns named charge ledgers', detail.status === 200 && detail.data?.otherCharges?.every(c => !!c.ledgerName));
  const list = await get('/quotations?limit=200');
  const listed = (list.data?.rows ?? list.data ?? []).find(q => Number(q.id) === quoteId);
  assert('List exposes the charge total', listed && near(listed.otherChargesTotal, 35.25));
  const share = await post(`/quotations/${quoteId}/share-token`, {});
  const pdf = share.data?.token
    ? await get(`/public/quotations/${encodeURIComponent(share.data.token)}.pdf`)
    : { status: 0, data: null };
  assert('Quotation PDF endpoint still renders with charges', pdf.status === 200 && typeof pdf.data !== 'object');

  console.log('\n[2] Invalid ledger rejection and edit replacement/clear');
  const { rows: [salesLedger] } = await pool.query(
    `SELECT id FROM account_ledgers
      WHERE COALESCE(is_group, false) = true AND code <> 'SYS-DIRINC'
      ORDER BY id LIMIT 1`,
  );
  if (salesLedger) {
    const invalid = await post('/quotations', { ...base, otherCharges: [{ ledgerId: Number(salesLedger.id), amount: 1 }] });
    assert('Non-Direct-Income ledger rejected', invalid.status === 400, `status=${invalid.status}`);
  } else {
    assert('Non-Direct-Income ledger exists for rejection probe', false);
  }
  const replaced = await put(`/quotations/${quoteId}`, {
    ...base,
    otherCharges: [{ ledgerId: deliveryLedger, amount: 7.50 }],
  });
  assert('Edit replaces the charge list', replaced.status === 200 && replaced.data?.otherCharges?.length === 1);
  assert('Replacement recalculates total', near(replaced.data?.otherChargesTotal, 7.50));
  const cleared = await put(`/quotations/${quoteId}`, { ...base, otherCharges: [] });
  assert('Edit with [] clears charges', cleared.status === 200 && (cleared.data?.otherCharges?.length ?? -1) === 0);
  assert('Cleared quotation returns to goods total', near(cleared.data?.totalAmount, Number(cleared.data?.subtotal) + Number(cleared.data?.taxTotal)));

  console.log('\n[3] Quotation-to-sale conversion preserves charges');
  const convertible = await post('/quotations', {
    ...base,
    otherCharges: [{ ledgerId: packingLedger, amount: 12.34 }],
  });
  assert('Convertible quotation accepted', convertible.status === 201 || convertible.status === 200);
  const convertibleId = Number(convertible.data?.id);
  if (convertibleId) createdQuotes.push(convertibleId);
  const sale = await post('/sales', {
    locationType: 'warehouse', locationId: Number(location.id), outletId: Number(location.id),
    saleDate: today, paymentMode: 'cash', quotationId: convertibleId,
    lineItems: lineItems.map(li => ({ ...li, priceMode: 'inclusive' })),
    otherCharges: convertible.data?.otherCharges,
  });
  assert('Sale conversion accepted', sale.status === 201, `status=${sale.status} ${JSON.stringify(sale.data).slice(0, 200)}`);
  const saleId = Number(sale.data?.id);
  if (saleId) createdSales.push(saleId);
  assert('Converted sale preserves charge row', sale.data?.otherCharges?.length === 1 && near(sale.data?.otherCharges?.[0]?.amount, 12.34));
  assert('Converted sale total includes charge', near(sale.data?.otherChargesTotal, 12.34));
  const converted = await get(`/quotations/${convertibleId}`);
  assert('Quotation remains readable with its original charge', converted.data?.otherCharges?.length === 1);
} catch (error) {
  console.error(error);
  failed++;
  failures.push(error.message);
} finally {
  await cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.error(`FAILED: ${failures.join(' | ')}`);
  process.exit(1);
}