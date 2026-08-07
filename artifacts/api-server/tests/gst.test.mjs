/**
 * GST Compliance Tests
 * Run: node artifacts/api-server/tests/gst.test.mjs
 *
 * Verifies:
 * 1. Customer state persists through POST /customers
 * 2. Vendor state persists through POST /vendors
 * 3. Same-state sales → CGST + SGST (no IGST)
 * 4. Other-state sales → IGST (no CGST/SGST)
 * 5. Invoice number follows the per-location series format (SERIES/FY/NNN…)
 *
 * The suite READS the company's configured state and derives its fixtures
 * from it — it never writes company settings (a shared live config).
 */

const BASE = process.env.API_URL || 'http://localhost:8080/api';
let authToken = '';
let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
  };
}

async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  return r.json();
}

async function get(path) {
  const r = await fetch(`${BASE}${path}`, { headers: authHeaders() });
  return r.json();
}

// ── Setup ──────────────────────────────────────────────────────────────────

{
  const login = await post('/auth/login', {
    username: process.env.TEST_USERNAME || 'admin',
    password: process.env.TEST_PASSWORD || 'marlin1458',
  });
  authToken = login.token ?? '';
  assert('Login returns a token', !!authToken, JSON.stringify(login).slice(0, 120));
  if (!authToken) { console.error('Cannot continue without auth'); process.exit(1); }
}

// The SELLER's state decides intra vs inter. Seller identity is the selling
// location, not the company (company settings may leave state blank) — so
// resolve from company settings first, then the first outlet, then default.
const settings = await get('/company/settings');
const outletsForState = await get('/outlets');
const companyState = settings.state
  || (Array.isArray(outletsForState) ? outletsForState[0]?.state : '')
  || 'Karnataka';
console.log(`  (seller state resolved as: ${companyState})`);

// One state that is NOT the company's, for the inter-state fixture.
const otherState = companyState === 'Tamil Nadu' ? 'Kerala' : 'Tamil Nadu';

// ── Test 1: Customer state persistence ─────────────────────────────────────
console.log('\n[1] Customer state persistence');

const sameStateCustomer = await post('/customers', {
  name: `GSTTEST Same-State Customer ${Date.now()}`,
  phone: `97${String(Date.now()).slice(-8)}`,
  state: companyState,
});
assert('Customer created without error', !sameStateCustomer.error, sameStateCustomer.error);
assert('Customer state persisted', sameStateCustomer.state === companyState, `got: ${sameStateCustomer.state}`);

const otherStateCustomer = await post('/customers', {
  name: `GSTTEST Other-State Customer ${Date.now()}`,
  phone: `96${String(Date.now()).slice(-8)}`,
  state: otherState,
});
assert('Other-state customer created', !otherStateCustomer.error, otherStateCustomer.error);
assert('Other-state customer state persisted', otherStateCustomer.state === otherState, `got: ${otherStateCustomer.state}`);

// Read back to verify DB persistence
const readBack = await get(`/customers/${sameStateCustomer.id}`);
assert('Customer state persists on read-back', readBack.state === companyState, `got: ${readBack.state}`);

// ── Test 2: Vendor state persistence ───────────────────────────────────────
console.log('\n[2] Vendor state persistence');

const vendor = await post('/vendors', {
  name: `GSTTEST Vendor ${Date.now()}`,
  gstNumber: '29XYZ1234A1Z9',
  state: 'Karnataka',
});
assert('Vendor created', !vendor.error, vendor.error);
assert('Vendor state persisted', vendor.state === 'Karnataka', `got: ${vendor.state}`);

const vendorRead = await get(`/vendors/${vendor.id}`);
assert('Vendor state persists on read-back', vendorRead.state === 'Karnataka', `got: ${vendorRead.state}`);

// ── Test 3: Need an outlet and item with GST rate ─────────────────────────
const outlets = await get('/outlets');
const items = await get('/items');
const outletId = Array.isArray(outlets) ? outlets[0]?.id : undefined;
const itemList = Array.isArray(items) ? items : [];
const item = itemList.find(i => Number(i.taxRate ?? i.tax_rate) > 0);

if (!outletId || !item) {
  console.log('\n[3,4] Skipping sale tests — no outlet or taxable item found');
  console.log(`  (outlet: ${outletId}, item: ${item?.id})`);
} else {
  const taxRate = Number(item.taxRate ?? item.tax_rate);
  // The MRP floor refuses lines priced below the master MRP, so the fixture
  // price is the MRP itself (or ₹100 when no MRP is set).
  const mrp = Number(item.mrp ?? 0);
  const price = mrp > 0 ? mrp : 100;
  const today = new Date().toISOString().slice(0, 10);

  // ── Test 3: Same-state sale → CGST + SGST ────────────────────────────────
  console.log(`\n[3] Same-state sale (${companyState} customer → ${companyState} company) → CGST + SGST`);

  const intraSale = await post('/sales', {
    outletId,
    customerId: sameStateCustomer.id,
    saleDate: today,
    paymentMode: 'cash',
    lineItems: [{ itemId: item.id, quantity: 1, unitPrice: price, discount: 0, taxAmount: 0 }],
  });

  assert('Intra-state sale created', !intraSale.error, JSON.stringify(intraSale).slice(0, 200));

  if (!intraSale.error) {
    const li = intraSale.lineItems?.[0];
    assert('Intra-state: taxType is cgst_sgst', li?.taxType === 'cgst_sgst', `got: ${li?.taxType}`);
    assert('Intra-state: IGST is 0', Number(li?.igst) === 0, `got: ${li?.igst}`);
    assert('Intra-state: CGST > 0', Number(li?.cgst) > 0, `got: ${li?.cgst}`);
    assert('Intra-state: SGST > 0', Number(li?.sgst) > 0, `got: ${li?.sgst}`);
    // CGST and SGST may differ by exactly one paisa on odd-paise totals
    // (half + exact remainder split) — never more.
    assert('Intra-state: CGST ≈ SGST (≤ 1 paisa apart)',
      Math.abs(Number(li?.cgst) - Number(li?.sgst)) <= 0.011, `cgst:${li?.cgst} sgst:${li?.sgst}`);
    const expectedTax = Math.round(price * taxRate / 100 * 100) / 100;
    assert(`Intra-state: taxAmount ≈ ${taxRate}% of subtotal`,
      Math.abs(Number(li?.taxAmount) - expectedTax) < 0.02, `expected:${expectedTax} got:${li?.taxAmount}`);
  }

  // ── Test 4: Other-state sale → IGST ─────────────────────────────────────
  console.log(`\n[4] Other-state sale (${otherState} customer) → IGST`);

  const interSale = await post('/sales', {
    outletId,
    customerId: otherStateCustomer.id,
    saleDate: today,
    paymentMode: 'upi',
    lineItems: [{ itemId: item.id, quantity: 2, unitPrice: price, discount: 0, taxAmount: 0 }],
  });

  assert('Inter-state sale created', !interSale.error, JSON.stringify(interSale).slice(0, 200));

  if (!interSale.error) {
    const li = interSale.lineItems?.[0];
    assert('Inter-state: taxType is igst', li?.taxType === 'igst', `got: ${li?.taxType}`);
    assert('Inter-state: CGST is 0', Number(li?.cgst) === 0, `got: ${li?.cgst}`);
    assert('Inter-state: SGST is 0', Number(li?.sgst) === 0, `got: ${li?.sgst}`);
    assert('Inter-state: IGST > 0', Number(li?.igst) > 0, `got: ${li?.igst}`);
    const expectedTax = Math.round(2 * price * taxRate / 100 * 100) / 100;
    assert(`Inter-state: IGST ≈ ${taxRate}% of subtotal`,
      Math.abs(Number(li?.igst) - expectedTax) < 0.02, `expected:${expectedTax} got:${li?.igst}`);

    // ── Test 5: Invoice number format ─────────────────────────────────────
    // Per-location series: SERIES/FY/serial (e.g. SB2C/2026-27/000025).
    console.log('\n[5] Invoice number format');
    const inv = interSale.invoiceNumber || '';
    assert('Invoice matches SERIES/FY/serial format',
      /^[A-Z0-9]+\/\d{4}-\d{2}\/\d+$/.test(inv), `got: ${inv}`);
    const [, fySeg, serialSeg] = inv.split('/');
    // FY derived from the sale date (April–March financial year).
    const d = new Date(today);
    const fyStart = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
    const expectedFy = `${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}`;
    assert('Invoice FY segment matches sale date FY', fySeg === expectedFy, `got: ${fySeg} expected: ${expectedFy}`);
    assert('Sequential: serial is > 0', parseInt(serialSeg, 10) > 0, `got: ${inv}`);
  }
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('ALL TESTS PASSED');
}
