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
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const BASE = process.env.API_URL || 'http://localhost:8080/api';
const TAG = `ZZTEST Quotation Charges ${Date.now()}`;
let token = '';
let passed = 0;
let failed = 0;
const failures = [];
const createdQuotes = [];
const createdSales = [];
const createdLedgers = [];
const pdfDir = mkdtempSync(join(tmpdir(), 'quotation-pdf-'));
let pdfSeq = 0;
let originalLocationPayment = null;

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

async function fetchPdfText(path) {
  const response = await fetch(`${BASE}${path}`);
  const file = join(pdfDir, `q${++pdfSeq}.pdf`);
  writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  const text = response.status === 200
    ? execFileSync('pdftotext', [file, '-']).toString()
    : '';
  const pages = response.status === 200
    ? Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [file]).toString())?.[1] ?? 0)
    : 0;
  const imageCount = response.status === 200
    ? Math.max(0, execFileSync('pdfimages', ['-list', file]).toString().trim().split('\n').length - 2)
    : 0;
  const imageList = response.status === 200
    ? execFileSync('pdfimages', ['-list', file]).toString().trim().split('\n').slice(2)
    : [];
  const qrImageCount = imageList.filter(line => {
    const fields = line.trim().split(/\s+/);
    return fields[2] === 'image' && Number(fields[3]) === Number(fields[4]) && Number(fields[3]) >= 200;
  }).length;
  return { status: response.status, text, pages, imageCount, qrImageCount };
}

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
  if (originalLocationPayment) {
    await pool.query(
      `UPDATE warehouses
          SET bank_account_holder = $2, bank_name = $3, bank_account_number = $4,
              ifsc_code = $5, bank_branch = $6, upi_id = $7
        WHERE id = $1`,
      [originalLocationPayment.id, originalLocationPayment.bank_account_holder,
       originalLocationPayment.bank_name, originalLocationPayment.bank_account_number,
       originalLocationPayment.ifsc_code, originalLocationPayment.bank_branch,
       originalLocationPayment.upi_id],
    ).catch(() => {});
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
  originalLocationPayment = (await pool.query(
    `SELECT id, bank_account_holder, bank_name, bank_account_number,
            ifsc_code, bank_branch, upi_id
       FROM warehouses WHERE id = $1`,
    [location.id],
  )).rows[0] ?? null;

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

  const quotePdf = share.data?.token
    ? await fetchPdfText(`/public/quotations/${encodeURIComponent(share.data.token)}.pdf`)
    : { status: 0, text: '', pages: 0 };
  assert('Quotation PDF is a one-page document for one item', quotePdf.status === 200 && quotePdf.pages === 1);
  const { rows: [locationBank] } = await pool.query(
    `SELECT bank_account_holder, bank_name, bank_account_number, ifsc_code, bank_branch, upi_id
       FROM warehouses WHERE id = $1`,
    [location.id],
  );
  const locationBankValues = [
    locationBank?.bank_account_holder, locationBank?.bank_name,
    locationBank?.bank_account_number, locationBank?.ifsc_code, locationBank?.bank_branch,
  ].filter(value => String(value ?? '').trim());
  if (locationBankValues.length > 0) {
    assert('Quotation shows the selected warehouse bank section', quotePdf.text.includes('BANK DETAILS'));
    for (const value of locationBankValues) {
      assert(`Quotation prints selected bank value ${value}`, quotePdf.text.includes(String(value)));
    }
  } else {
    assert('Quotation omits the bank section when selected warehouse has no bank', !quotePdf.text.includes('BANK DETAILS'));
  }
  const locationUpiId = String(locationBank?.upi_id ?? '').trim();
  if (locationUpiId) {
    assert('Quotation prints the selected warehouse UPI ID', quotePdf.text.includes(locationUpiId));
    assert('Quotation embeds a QR image when the selected warehouse has UPI', quotePdf.qrImageCount >= 1);
  } else {
    assert('Quotation omits UPI details when selected warehouse has no UPI', !quotePdf.text.includes('UPI ID:'));
  }
  const { rows: [companyPayment] } = await pool.query(
    `SELECT upi_id FROM company_settings ORDER BY id LIMIT 1`,
  );
  if (!locationUpiId && String(companyPayment?.upi_id ?? '').trim()) {
    assert('Quotation does not fall back to company UPI', !quotePdf.text.includes(String(companyPayment.upi_id).trim()));
  }
  const { rows: unrelatedBanks } = await pool.query(
    `SELECT bank_account_number, upi_id FROM warehouses
      WHERE id <> $1 AND NULLIF(TRIM(bank_account_number), '') IS NOT NULL
      ORDER BY id LIMIT 3`,
    [location.id],
  );
  for (const row of unrelatedBanks) {
    if (!locationBankValues.includes(row.bank_account_number)) {
      assert(`Quotation does not leak unrelated account ${row.bank_account_number}`,
        !quotePdf.text.includes(row.bank_account_number));
    }
  }
  const { rows: unrelatedUpis } = await pool.query(
    `SELECT upi_id FROM warehouses
      WHERE id <> $1 AND NULLIF(TRIM(upi_id), '') IS NOT NULL
      ORDER BY id LIMIT 3`,
    [location.id],
  );
  for (const row of unrelatedUpis) {
    if (row.upi_id !== locationUpiId) {
      assert(`Quotation does not leak unrelated UPI ${row.upi_id}`,
        !quotePdf.text.includes(row.upi_id));
    }
  }

  const longQuote = await post('/quotations', {
    ...base,
    lineItems: Array.from({ length: 36 }, () => ({
      itemId: Number(item.id), quantity: 1, unitPrice, taxAmount: 0,
    })),
  });
  const longQuoteId = Number(longQuote.data?.id);
  if (longQuoteId) createdQuotes.push(longQuoteId);
  const longShare = longQuoteId
    ? await post(`/quotations/${longQuoteId}/share-token`, {})
    : { data: null };
  const longPdf = longShare.data?.token
    ? await fetchPdfText(`/public/quotations/${encodeURIComponent(longShare.data.token)}.pdf`)
    : { status: 0, text: '', pages: 0 };
  assert('Multi-page quotation PDF renders without losing the footer',
    longPdf.status === 200 && longPdf.pages >= 2
      && longPdf.text.includes('Thank You For Your Business!')
      && longPdf.text.includes('Authorised Signatory'));

  async function stateQuotePdf() {
    const stateQuote = await post('/quotations', base);
    const stateQuoteId = Number(stateQuote.data?.id);
    if (stateQuoteId) createdQuotes.push(stateQuoteId);
    const stateShare = stateQuoteId
      ? await post(`/quotations/${stateQuoteId}/share-token`, {})
      : { data: null };
    return stateShare.data?.token
      ? fetchPdfText(`/public/quotations/${encodeURIComponent(stateShare.data.token)}.pdf`)
      : { status: 0, text: '', pages: 0, imageCount: 0 };
  }

  await pool.query(
    `UPDATE warehouses
        SET bank_account_holder = 'Quotation State Account', bank_name = 'Quotation State Bank',
            bank_account_number = '123456789012', ifsc_code = 'QSTB0000001',
            bank_branch = 'State Branch', upi_id = ''
      WHERE id = $1`,
    [location.id],
  );
  const bankOnlyPdf = await stateQuotePdf();
  assert('Bank-only quotation omits UPI details and QR',
    bankOnlyPdf.status === 200
      && bankOnlyPdf.text.includes('BANK DETAILS')
      && !bankOnlyPdf.text.includes('UPI ID:')
      && bankOnlyPdf.qrImageCount === 0);

  await pool.query(
    `UPDATE warehouses
        SET bank_account_holder = '', bank_name = '', bank_account_number = '',
            ifsc_code = '', bank_branch = '', upi_id = 'quotation-state@upi'
      WHERE id = $1`,
    [location.id],
  );
  const upiOnlyPdf = await stateQuotePdf();
  assert('UPI-only quotation shows the UPI ID and QR without bank labels',
    upiOnlyPdf.status === 200
      && upiOnlyPdf.text.includes('SCAN TO PAY')
      && upiOnlyPdf.text.includes('quotation-state@upi')
      && !upiOnlyPdf.text.includes('BANK DETAILS')
      && upiOnlyPdf.qrImageCount >= 1);

  await pool.query(
    `UPDATE warehouses
        SET bank_account_holder = '', bank_name = '', bank_account_number = '',
            ifsc_code = '', bank_branch = '', upi_id = ''
      WHERE id = $1`,
    [location.id],
  );
  const noPaymentPdf = await stateQuotePdf();
  assert('Quotation hides the entire payment section when bank and UPI are absent',
    noPaymentPdf.status === 200
      && !noPaymentPdf.text.includes('BANK DETAILS')
      && !noPaymentPdf.text.includes('PAYMENT DETAILS')
      && !noPaymentPdf.text.includes('UPI ID:'));

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
  rmSync(pdfDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.error(`FAILED: ${failures.join(' | ')}`);
  process.exit(1);
}