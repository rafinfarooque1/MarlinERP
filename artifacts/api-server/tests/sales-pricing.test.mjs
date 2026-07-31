/**
 * Per-line Taxable pricing modes (GST-inclusive vs GST-exclusive) — integration tests
 * Run: node artifacts/api-server/tests/sales-pricing.test.mjs
 *
 * Covers the acceptance criteria for the POS "Taxable" checkbox:
 *   1. Default (no priceMode / 'inclusive'): entered price is the FINAL
 *      GST-inclusive price — taxable = price / (1 + rate/100), tax extracted.
 *      NEVER price − rate% (that under-extracts the included GST).
 *   2. 'exclusive' ("Taxable" checked): entered price is the taxable BASE —
 *      GST added on top, total = base + tax.
 *   3. Line discounts apply BEFORE the mode math in both modes (no double-apply).
 *   4. Mixed-mode invoices total correctly.
 *   5. The mode is persisted per line and survives edit round-trips; edits are
 *      recomputed from the SAVED/submitted mode, never re-derived from GSTIN.
 *   6. Historical lines without the field read as inclusive (no migration).
 *   7. Invoice PDF renders from stored values; books stay balanced and output
 *      GST heads move by exactly the sale's taxTotal.
 *
 * Runs against the DEVELOPMENT database via the dev API server. Every sale it
 * creates is cancelled at the end (cancellation restores stock).
 */

const BASE = process.env.API_URL || 'http://localhost:8080/api';

let authToken = '';
let passed = 0, failed = 0;
const failures = [];

function assert(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const round2 = n => Math.round(n * 100) / 100;
const close = (a, b, eps = 0.011) => Math.abs(Number(a) - Number(b)) <= eps;

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
const get = (p, t) => apiReq('GET', p, undefined, t);
const post = (p, b, t) => apiReq('POST', p, b, t);
const put = (p, b, t) => apiReq('PUT', p, b, t);

const createdSales = [];
async function cleanup() {
  for (const id of createdSales) {
    await post(`/sales/${id}/cancel`, { reason: 'sales-pricing test cleanup' }).catch(() => {});
  }
}

// Reference math — the SPEC formulas, written independently of the server code.
function expectInclusive(qty, price, rate, discount = 0) {
  const gross = qty * price - discount;
  const taxable = rate > 0 ? round2(gross / (1 + rate / 100)) : gross;
  const tax = round2(gross - taxable);
  return { taxable, tax, total: round2(gross) };
}
function expectExclusive(qty, price, rate, discount = 0) {
  const taxable = round2(qty * price - discount);
  const tax = round2(taxable * rate / 100);
  return { taxable, tax, total: round2(taxable + tax) };
}

// ── Auth ─────────────────────────────────────────────────────────────────────
const loginRes = await post('/auth/login', { username: 'admin', password: 'marlin1458' });
authToken = loginRes.data?.token ?? '';
assert('Admin login returns a token', !!authToken, `status=${loginRes.status}`);
if (!authToken) { console.error('FATAL: no token'); process.exit(1); }

// ── Fixture discovery: a warehouse holding a GST item with stock ─────────────
const [itemsRes, warehousesRes] = await Promise.all([get('/items'), get('/warehouses')]);
const items = itemsRes.data ?? [];
const warehouses = warehousesRes.data ?? [];

let loc = null, item = null;
for (const wh of warehouses) {
  const stockRes = await get(`/stock?branchType=warehouse&branchId=${wh.id}`);
  const rows = stockRes.data ?? [];
  const cand = rows
    .map(r => ({ r, it: items.find(i => i.id === r.itemId) }))
    .filter(x => x.it && Number(x.it.taxRate) > 0 && Number(x.r.quantity) >= 10)
    // prefer a 5% item so the spec's worked example (₹200 → 190.48/210) runs verbatim
    .sort((a, b) => (Number(a.it.taxRate) === 5 ? -1 : 0) - (Number(b.it.taxRate) === 5 ? -1 : 0));
  if (cand.length) { loc = wh; item = cand[0].it; break; }
}
assert('Found a warehouse with a GST-rated item in stock', !!(loc && item),
  `warehouses=${warehouses.length}`);
if (!loc || !item) { await cleanup(); process.exit(1); }
const RATE = Number(item.taxRate);
const today = new Date().toISOString().slice(0, 10);
console.log(`  (using warehouse=${loc.id} item=${item.id} rate=${RATE}%)`);

const saleBase = {
  outletId: loc.id, locationType: 'warehouse', locationId: loc.id,
  saleDate: today, paymentMode: 'cash',
};
const mkLine = (over = {}) => ({ itemId: item.id, quantity: 1, unitPrice: 200, discount: 0, taxAmount: 0, ...over });

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[1] Backward compat: line WITHOUT priceMode = GST-inclusive');
{
  const r = await post('/sales', { ...saleBase, lineItems: [mkLine()] });
  assert('Sale created', r.status < 300 && !r.data?.error, JSON.stringify(r.data).slice(0, 200));
  if (r.data?.id) {
    createdSales.push(r.data.id);
    const li = r.data.lineItems[0];
    const exp = expectInclusive(1, 200, RATE);
    assert('Taxable extracted with ÷(1+r/100)', close(li.lineSubtotal, exp.taxable),
      `got ${li.lineSubtotal}, want ${exp.taxable}`);
    assert('NOT the wrong price−rate% formula', !close(li.lineSubtotal, 200 - 200 * RATE / 100, 0.001)
      || close(exp.taxable, 200 - 200 * RATE / 100, 0.001), `subtotal=${li.lineSubtotal}`);
    assert('Tax = gross − taxable', close(li.taxAmount, exp.tax), `got ${li.taxAmount}, want ${exp.tax}`);
    assert('Grand total = entered price (inclusive)', close(r.data.totalAmount, exp.total),
      `got ${r.data.totalAmount}, want ${exp.total}`);
    assert('Stored priceMode is inclusive', li.priceMode === 'inclusive', `got ${li.priceMode}`);
  }
}

console.log('\n[2] Explicit exclusive: price is the taxable base, GST on top');
let exclSaleId = 0;
{
  const r = await post('/sales', { ...saleBase, lineItems: [mkLine({ priceMode: 'exclusive' })] });
  assert('Sale created', r.status < 300 && !r.data?.error, JSON.stringify(r.data).slice(0, 200));
  if (r.data?.id) {
    createdSales.push(r.data.id); exclSaleId = r.data.id;
    const li = r.data.lineItems[0];
    const exp = expectExclusive(1, 200, RATE);
    assert('Taxable = entered price', close(li.lineSubtotal, exp.taxable), `got ${li.lineSubtotal}`);
    assert('Tax added on top', close(li.taxAmount, exp.tax), `got ${li.taxAmount}, want ${exp.tax}`);
    assert('Grand total = base + GST', close(r.data.totalAmount, exp.total),
      `got ${r.data.totalAmount}, want ${exp.total}`);
    assert('Stored priceMode is exclusive', li.priceMode === 'exclusive', `got ${li.priceMode}`);
    if (RATE === 5) {
      assert('Spec example: ₹200 @5% checked → ₹210.00', close(r.data.totalAmount, 210), `got ${r.data.totalAmount}`);
    }
    const half = round2(exp.tax / 2);
    const intra = Number(li.igst ?? 0) === 0;
    assert('GST split into heads', intra ? (close(li.cgst, half) && close(li.sgst, half)) : close(li.igst, exp.tax),
      `cgst=${li.cgst} sgst=${li.sgst} igst=${li.igst}`);
  }
}

console.log('\n[3] Discount applies BEFORE the mode math (both modes, once)');
{
  const rEx = await post('/sales', { ...saleBase, lineItems: [mkLine({ discount: 20, priceMode: 'exclusive' })] });
  if (rEx.data?.id) createdSales.push(rEx.data.id);
  const expEx = expectExclusive(1, 200, RATE, 20);
  assert('Exclusive: tax on discounted base', close(rEx.data?.lineItems?.[0]?.taxAmount, expEx.tax),
    `got ${rEx.data?.lineItems?.[0]?.taxAmount}, want ${expEx.tax}`);
  assert('Exclusive: total = (base−disc) + tax', close(rEx.data?.totalAmount, expEx.total),
    `got ${rEx.data?.totalAmount}, want ${expEx.total}`);

  const rIn = await post('/sales', { ...saleBase, lineItems: [mkLine({ discount: 20, priceMode: 'inclusive' })] });
  if (rIn.data?.id) createdSales.push(rIn.data.id);
  const expIn = expectInclusive(1, 200, RATE, 20);
  assert('Inclusive: tax extracted from discounted gross', close(rIn.data?.lineItems?.[0]?.taxAmount, expIn.tax),
    `got ${rIn.data?.lineItems?.[0]?.taxAmount}, want ${expIn.tax}`);
  assert('Inclusive: total = gross − discount', close(rIn.data?.totalAmount, expIn.total),
    `got ${rIn.data?.totalAmount}, want ${expIn.total}`);
}

console.log('\n[4] Mixed-mode invoice totals = sum of per-line results');
{
  const r = await post('/sales', {
    ...saleBase,
    lineItems: [mkLine({ priceMode: 'inclusive' }), mkLine({ priceMode: 'exclusive' })],
  });
  assert('Mixed sale created', r.status < 300 && !r.data?.error, JSON.stringify(r.data).slice(0, 200));
  if (r.data?.id) {
    createdSales.push(r.data.id);
    const expIn = expectInclusive(1, 200, RATE);
    const expEx = expectExclusive(1, 200, RATE);
    assert('Subtotal = sum of taxables', close(r.data.subtotal, round2(expIn.taxable + expEx.taxable)),
      `got ${r.data.subtotal}`);
    assert('Tax total = sum of taxes', close(r.data.taxTotal, round2(expIn.tax + expEx.tax)),
      `got ${r.data.taxTotal}`);
    assert('Grand total = sum of line totals', close(r.data.totalAmount, round2(expIn.total + expEx.total)),
      `got ${r.data.totalAmount}`);
    assert('Each line kept ITS OWN mode',
      r.data.lineItems[0].priceMode === 'inclusive' && r.data.lineItems[1].priceMode === 'exclusive');
  }
}

console.log('\n[5] Edit round-trip: saved mode loads, edits recompute from the SUBMITTED mode');
{
  // GET returns the stored mode (what the Edit form rehydrates from)
  const g1 = await get(`/sales/${exclSaleId}`);
  assert('GET returns stored exclusive mode', g1.data?.lineItems?.[0]?.priceMode === 'exclusive',
    `got ${g1.data?.lineItems?.[0]?.priceMode}`);

  // Edit WITHOUT changing the mode — totals must not shift
  const expEx = expectExclusive(1, 200, RATE);
  const e1 = await put(`/sales/${exclSaleId}`, { ...saleBase, lineItems: [mkLine({ priceMode: 'exclusive' })] });
  assert('Unchanged-mode edit keeps the total', close(e1.data?.totalAmount, expEx.total),
    `got ${e1.data?.totalAmount}, want ${expEx.total}`);

  // Flip exclusive → inclusive on edit — recomputed to the new mode
  const expIn = expectInclusive(1, 200, RATE);
  const e2 = await put(`/sales/${exclSaleId}`, { ...saleBase, lineItems: [mkLine({ priceMode: 'inclusive' })] });
  assert('Mode flip recomputes totals', close(e2.data?.totalAmount, expIn.total),
    `got ${e2.data?.totalAmount}, want ${expIn.total}`);
  const g2 = await get(`/sales/${exclSaleId}`);
  assert('Flipped mode persisted', g2.data?.lineItems?.[0]?.priceMode === 'inclusive',
    `got ${g2.data?.lineItems?.[0]?.priceMode}`);
}

console.log('\n[6] Historical lines without priceMode still read + render (inclusive fallback)');
{
  const listRes = await get('/sales?limit=200');
  const list = Array.isArray(listRes.data) ? listRes.data : (listRes.data?.rows ?? []);
  const legacy = list.find(s =>
    !createdSales.includes(s.id) && (s.lineItems ?? []).some(li => li.priceMode === undefined));
  if (!legacy) {
    console.log('  (no legacy sale without priceMode found — skipping)');
  } else {
    const g = await get(`/sales/${legacy.id}`);
    assert('Legacy sale still reads fine', g.status === 200 && !g.data?.error);
    const li = (g.data?.lineItems ?? []).find(l => l.priceMode === undefined && Number(l.taxRate) > 0);
    if (li) {
      const exp = expectInclusive(Number(li.quantity), Number(li.unitPrice), Number(li.taxRate), Number(li.discount ?? 0));
      assert('Legacy line matches inclusive math (stored values untouched)',
        close(li.lineSubtotal, exp.taxable), `got ${li.lineSubtotal}, want ${exp.taxable}`);
    }
    const pdfR = await fetch(`${BASE}/sales/${legacy.id}/invoice.pdf`, { headers: { Authorization: `Bearer ${authToken}` } });
    assert('Legacy invoice PDF renders', pdfR.status === 200 &&
      (pdfR.headers.get('content-type') ?? '').includes('pdf'), `status=${pdfR.status}`);
  }
}

console.log('\n[7] Invoice PDF for an exclusive-mode sale renders from stored values');
{
  const pdfR = await fetch(`${BASE}/sales/${exclSaleId}/invoice.pdf`, { headers: { Authorization: `Bearer ${authToken}` } });
  assert('Exclusive-sale invoice PDF renders', pdfR.status === 200 &&
    (pdfR.headers.get('content-type') ?? '').includes('pdf'), `status=${pdfR.status}`);
}

console.log('\n[8] Accounting: output GST heads move by exactly the sale taxTotal');
{
  const tb = async () => {
    const res = await get('/accounts/trial-balance');
    const rows = res.data?.rows ?? [];
    const outGst = rows
      .filter(r => ['STD-OUT-CGST', 'STD-OUT-SGST', 'STD-OUT-IGST', 'STD-DTX'].includes(r.code))
      .reduce((s, r) => s + Number(r.credit ?? 0) - Number(r.debit ?? 0), 0);
    return {
      balanced: res.data?.balanced ?? true,
      outGst: round2(outGst),
      dr: round2(rows.reduce((s, r) => s + Number(r.debit ?? 0), 0)),
      cr: round2(rows.reduce((s, r) => s + Number(r.credit ?? 0), 0)),
    };
  };
  const before = await tb();
  const r = await post('/sales', { ...saleBase, lineItems: [mkLine({ priceMode: 'exclusive', quantity: 2 })] });
  assert('Accounting-check sale created', !r.data?.error, JSON.stringify(r.data).slice(0, 150));
  if (r.data?.id) {
    createdSales.push(r.data.id);
    const after = await tb();
    assert('Trial balance still balanced', after.balanced && close(after.dr, after.cr),
      `dr=${after.dr} cr=${after.cr}`);
    assert('Output GST heads grew by the sale taxTotal',
      close(after.outGst - before.outGst, Number(r.data.taxTotal)),
      `Δ=${round2(after.outGst - before.outGst)}, taxTotal=${r.data.taxTotal}`);
  }
}

console.log('\n[9] Odd-paise tax: CGST + SGST must sum EXACTLY to the line tax');
{
  // Pick a price whose tax lands on an odd paise so an independent
  // round-each-half split would drift (e.g. @5%: base 100.50 → tax 5.03).
  // Search a few candidates in case the fixture rate isn't 5%.
  let done = false;
  for (const price of [100.5, 100.1, 100.3, 100.7, 100.9, 101.1, 33.33]) {
    const tax = round2(price * RATE / 100);
    if (Math.round(tax * 100) % 2 === 0) continue; // even paise — halves split cleanly
    const r = await post('/sales', { ...saleBase, lineItems: [mkLine({ unitPrice: price, priceMode: 'exclusive' })] });
    assert('Odd-paise sale created', !r.data?.error, JSON.stringify(r.data).slice(0, 150));
    if (r.data?.id) {
      createdSales.push(r.data.id);
      const li = r.data.lineItems[0];
      if (Number(li.igst ?? 0) > 0) {
        assert('IGST equals line tax', close(li.igst, li.taxAmount, 0.001));
      } else {
        assert('cgst + sgst === taxAmount exactly',
          Math.round((Number(li.cgst) + Number(li.sgst)) * 100) === Math.round(Number(li.taxAmount) * 100),
          `cgst=${li.cgst} sgst=${li.sgst} tax=${li.taxAmount}`);
        assert('Halves differ by at most one paisa',
          Math.abs(Math.round((Number(li.cgst) - Number(li.sgst)) * 100)) <= 1,
          `cgst=${li.cgst} sgst=${li.sgst}`);
      }
    }
    done = true;
    break;
  }
  if (!done) console.log(`  (no odd-paise candidate at rate ${RATE}% — skipped)`);
}

// ── Cleanup + summary ────────────────────────────────────────────────────────
console.log('\n[cleanup] cancelling test sales…');
await cleanup();
{
  const fs = await get('/accounts/financial-statements');
  const integ = fs.data?.integrity ?? {};
  assert('Books integrity balanced after cleanup', integ.balanced === true,
    JSON.stringify(integ).slice(0, 200));
}

console.log(`\n${'='.repeat(60)}\n${passed} passed, ${failed} failed`);
if (failures.length) { console.log('Failures:'); failures.forEach(f => console.log(`  - ${f}`)); }
process.exit(failed ? 1 : 0);
