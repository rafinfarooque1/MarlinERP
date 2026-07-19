/**
 * GST Compliance Tests
 * Run: node artifacts/api-server/tests/gst.test.mjs
 *
 * Verifies:
 * 1. Customer state persists through POST /customers
 * 2. Vendor state persists through POST /vendors
 * 3. Intra-state sales → CGST + SGST (no IGST)
 * 4. Inter-state sales → IGST (no CGST/SGST)
 * 5. Invoice number follows sequential format
 */

const BASE = process.env.API_URL || 'http://localhost:8080/api';
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

async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function patch(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function get(path) {
  const r = await fetch(`${BASE}${path}`);
  return r.json();
}

// ── Setup ──────────────────────────────────────────────────────────────────

// Set company state to Kerala
await patch('/company/settings', { companyName: 'Marlin Test', state: 'Kerala', invoicePrefix: 'TST', financialYear: '2025-26' });
const settings = await get('/company/settings');
assert('Company state saved', settings.state === 'Kerala', `got: ${settings.state}`);
assert('Invoice prefix saved', settings.invoicePrefix === 'TST', `got: ${settings.invoicePrefix}`);

// ── Test 1: Customer state persistence ─────────────────────────────────────
console.log('\n[1] Customer state persistence');

const keralaCustomer = await post('/customers', {
  name: 'Kerala Test Customer',
  phone: '9876543210',
  gstNumber: '32ABCDE1234F1Z5',
  state: 'Kerala',
});
assert('Customer created without error', !keralaCustomer.error, keralaCustomer.error);
assert('Customer state persisted', keralaCustomer.state === 'Kerala', `got: ${keralaCustomer.state}`);

const tnCustomer = await post('/customers', {
  name: 'Tamil Nadu Test Customer',
  gstNumber: '33FGHIJ5678K2Y6',
  state: 'Tamil Nadu',
});
assert('TN customer created', !tnCustomer.error, tnCustomer.error);
assert('TN customer state persisted', tnCustomer.state === 'Tamil Nadu', `got: ${tnCustomer.state}`);

// Read back to verify DB persistence
const readBack = await get(`/customers/${keralaCustomer.id}`);
assert('Customer state persists on read-back', readBack.state === 'Kerala', `got: ${readBack.state}`);

// ── Test 2: Vendor state persistence ───────────────────────────────────────
console.log('\n[2] Vendor state persistence');

const vendor = await post('/vendors', {
  name: 'Test Vendor Karnataka',
  gstNumber: '29XYZ1234A1Z9',
  state: 'Karnataka',
});
assert('Vendor created', !vendor.error, vendor.error);
assert('Vendor state persisted', vendor.state === 'Karnataka', `got: ${vendor.state}`);

const vendorRead = await get(`/vendors/${vendor.id}`);
assert('Vendor state persists on read-back', vendorRead.state === 'Karnataka', `got: ${vendorRead.state}`);

// ── Test 3: Need an outlet and item with GST rate ─────────────────────────
// Get first available outlet and item from the DB
const outlets = await get('/outlets');
const items = await get('/items');
const outletId = outlets?.[0]?.id;
const item = items?.find(i => Number(i.taxRate) > 0);

if (!outletId || !item) {
  console.log('\n[3,4] Skipping sale tests — no outlet or taxable item found');
  console.log(`  (outlet: ${outletId}, item: ${item?.id}, taxRate: ${item?.taxRate})`);
} else {
  const taxRate = Number(item.taxRate);
  // Get item price for this outlet
  const prices = await get(`/item-prices?outletId=${outletId}`);
  const price = prices.find(p => p.itemId === item.id)?.price || 100;

  // ── Test 3: Intra-state sale (Kerala customer → Kerala company) ──────────
  console.log('\n[3] Intra-state sale (CGST + SGST)');

  const intraSale = await post('/sales', {
    outletId,
    customerId: keralaCustomer.id,
    saleDate: '2026-07-19',
    paymentMode: 'cash',
    lineItems: [{ itemId: item.id, quantity: 1, unitPrice: Number(price), discount: 0, taxAmount: 0 }],
  });

  assert('Intra-state sale created', !intraSale.error, JSON.stringify(intraSale).slice(0, 200));

  if (!intraSale.error) {
    const li = intraSale.lineItems?.[0];
    assert('Intra-state: taxType is cgst_sgst', li?.taxType === 'cgst_sgst', `got: ${li?.taxType}`);
    assert('Intra-state: IGST is 0', Number(li?.igst) === 0, `got: ${li?.igst}`);
    assert('Intra-state: CGST > 0', Number(li?.cgst) > 0, `got: ${li?.cgst}`);
    assert('Intra-state: SGST > 0', Number(li?.sgst) > 0, `got: ${li?.sgst}`);
    assert('Intra-state: CGST === SGST', Math.abs(Number(li?.cgst) - Number(li?.sgst)) < 0.01, `cgst:${li?.cgst} sgst:${li?.sgst}`);
    const expectedTax = Math.round(Number(price) * taxRate / 100 * 100) / 100;
    assert(`Intra-state: taxAmount = ${taxRate}% of subtotal`, Math.abs(Number(li?.taxAmount) - expectedTax) < 0.01, `expected:${expectedTax} got:${li?.taxAmount}`);
  }

  // ── Test 4: Inter-state sale (TN customer → Kerala company) ─────────────
  console.log('\n[4] Inter-state sale (IGST)');

  const interSale = await post('/sales', {
    outletId,
    customerId: tnCustomer.id,
    saleDate: '2026-07-19',
    paymentMode: 'upi',
    lineItems: [{ itemId: item.id, quantity: 2, unitPrice: Number(price), discount: 0, taxAmount: 0 }],
  });

  assert('Inter-state sale created', !interSale.error, JSON.stringify(interSale).slice(0, 200));

  if (!interSale.error) {
    const li = interSale.lineItems?.[0];
    assert('Inter-state: taxType is igst', li?.taxType === 'igst', `got: ${li?.taxType}`);
    assert('Inter-state: CGST is 0', Number(li?.cgst) === 0, `got: ${li?.cgst}`);
    assert('Inter-state: SGST is 0', Number(li?.sgst) === 0, `got: ${li?.sgst}`);
    assert('Inter-state: IGST > 0', Number(li?.igst) > 0, `got: ${li?.igst}`);
    const expectedTax = Math.round(2 * Number(price) * taxRate / 100 * 100) / 100;
    assert(`Inter-state: IGST = ${taxRate}% of subtotal`, Math.abs(Number(li?.igst) - expectedTax) < 0.01, `expected:${expectedTax} got:${li?.igst}`);

    // ── Test 5: Invoice number format ─────────────────────────────────────
    console.log('\n[5] Invoice number format');
    const inv = interSale.invoiceNumber || '';
    assert('Invoice starts with configured prefix', inv.startsWith('TST/'), `got: ${inv}`);
    assert('Invoice has financial year segment', inv.includes('/2025-26/'), `got: ${inv}`);
    assert('Invoice ends with zero-padded sequence', /\/\d{4}$/.test(inv), `got: ${inv}`);
    assert('Sequential: sequence is > 0', parseInt(inv.split('/').pop()) > 0, `got: ${inv}`);
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
