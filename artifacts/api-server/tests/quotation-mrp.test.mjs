/**
 * Quotation MRP override — integration tests
 * Run: node artifacts/api-server/tests/quotation-mrp.test.mjs
 *
 * Rule: the quotation MRP (line unitPrice) is editable, but only UPWARD —
 * it may equal or exceed the Item Master MRP, never undercut it. The raised
 * figure lives on the quotation document alone (line.masterMrp records what
 * the Item Master said at save time); the Item Master row is never written.
 * Grandfathering on edit mirrors sales: floor = min(master, saved price).
 * Conversion: the sale takes the quotation's (possibly raised) MRP as its
 * selling price and preserves the quote's discounts.
 *
 * Runs against the DEVELOPMENT database via the dev API server. Every sale
 * it creates is cancelled, every quotation deleted, and any item MRP it
 * changes is restored.
 */

const BASE = process.env.API_URL || 'http://localhost:8080/api';

let authToken = '';
let passed = 0, failed = 0;
const failures = [];

function assert(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
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
const patch = (p, b, t) => apiReq('PATCH', p, b, t);
const del = (p, t) => apiReq('DELETE', p, undefined, t);

const createdQuotes = [];
const createdSales = [];
let restoreMrp = null; // { itemId, mrp }
async function cleanup() {
  for (const id of createdSales) {
    await post(`/sales/${id}/cancel`, { reason: 'quotation-mrp test cleanup' }).catch(() => {});
  }
  for (const id of createdQuotes) {
    await del(`/quotations/${id}`).catch(() => {});
  }
  if (restoreMrp) {
    await patch(`/items/${restoreMrp.itemId}`, { mrp: restoreMrp.mrp }).catch(() => {});
  }
}

const SPEC_MESSAGE = 'Quotation MRP cannot be lower than the Item Master MRP';

// ── Auth ─────────────────────────────────────────────────────────────────────
const loginRes = await post('/auth/login', {
  username: process.env.TEST_USERNAME || 'admin',
  password: process.env.TEST_PASSWORD || 'marlin1458',
});
authToken = loginRes.data?.token ?? '';
assert('Admin login returns a token', !!authToken, `status=${loginRes.status}`);
if (!authToken) { console.error('FATAL: no token'); process.exit(1); }

// ── Fixture: a warehouse holding an item WITH a master MRP + stock ──────────
const [itemsRes, warehousesRes] = await Promise.all([get('/items'), get('/warehouses')]);
const items = itemsRes.data ?? [];
const warehouses = warehousesRes.data ?? [];

let loc = null, item = null;
for (const wh of warehouses) {
  const stockRes = await get(`/stock?branchType=warehouse&branchId=${wh.id}`);
  const rows = stockRes.data ?? [];
  const withMrp = rows
    .map(r => ({ r, it: items.find(i => i.id === r.itemId) }))
    .filter(x => x.it && Number(x.it.mrp) > 0 && Number(x.r.quantity) >= 10);
  if (withMrp.length) { loc = wh; item = withMrp[0].it; break; }
}
assert('Found a warehouse with an MRP-priced item in stock', !!(loc && item), `warehouses=${warehouses.length}`);
if (!loc || !item) { await cleanup(); process.exit(1); }

const MASTER = Number(item.mrp);
const today = new Date().toISOString().slice(0, 10);
console.log(`  (using warehouse=${loc.id} item=${item.id} masterMRP=₹${MASTER})`);

const quoteBase = {
  locationType: 'warehouse', locationId: loc.id,
  quoteDate: today, status: 'draft', discountTotal: 0,
};
const mkLine = (over = {}) => ({ itemId: item.id, quantity: 1, unitPrice: MASTER, taxAmount: 0, ...over });

const masterNow = async () => {
  const r = await get('/items');
  return Number((r.data ?? []).find(i => i.id === item.id)?.mrp ?? NaN);
};

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[1] CREATE at exactly the master MRP is allowed');
let quoteAtMaster = null;
{
  const r = await post('/quotations', { ...quoteBase, lineItems: [mkLine()] });
  assert('201/200 created', r.status === 200 || r.status === 201, `status=${r.status} ${JSON.stringify(r.data).slice(0, 150)}`);
  if (r.data?.id) { createdQuotes.push(r.data.id); quoteAtMaster = r.data; }
  const line = r.data?.lineItems?.[0];
  assert('Stored line carries masterMrp = master', close(line?.masterMrp, MASTER), `masterMrp=${line?.masterMrp}`);
  assert('Stored unitPrice = master', close(line?.unitPrice, MASTER), `unitPrice=${line?.unitPrice}`);
}

console.log('\n[2] CREATE above the master MRP is allowed (quote-level raise)');
const RAISED = Math.round((MASTER + 10) * 100) / 100;
let quoteRaised = null;
{
  const r = await post('/quotations', { ...quoteBase, lineItems: [mkLine({ unitPrice: RAISED, quantity: 2 })] });
  assert('Created', r.status === 200 || r.status === 201, `status=${r.status} ${JSON.stringify(r.data).slice(0, 150)}`);
  if (r.data?.id) { createdQuotes.push(r.data.id); quoteRaised = r.data; }
  const line = r.data?.lineItems?.[0];
  assert('Quote stores the RAISED MRP', close(line?.unitPrice, RAISED), `unitPrice=${line?.unitPrice}`);
  assert('Quote records original master MRP on the line', close(line?.masterMrp, MASTER), `masterMrp=${line?.masterMrp}`);
  assert('Item Master MRP unchanged after raise', close(await masterNow(), MASTER));
}

console.log('\n[3] CREATE below the master MRP is rejected with the spec message');
{
  const r = await post('/quotations', { ...quoteBase, lineItems: [mkLine({ unitPrice: MASTER - 1 })] });
  assert('Rejected with 400', r.status === 400, `status=${r.status}`);
  assert('Error carries the spec message', String(r.data?.error ?? '').includes(SPEC_MESSAGE), JSON.stringify(r.data).slice(0, 250));
  assert('Message names the master figure', String(r.data?.error ?? '').includes(`₹${MASTER.toFixed(2)}`), String(r.data?.error).slice(0, 200));
  assert('Error code is MRP_BELOW_MASTER', r.data?.code === 'MRP_BELOW_MASTER', `code=${r.data?.code}`);
}

console.log('\n[3b] Boundary: one paisa below is rejected (strict compare, no epsilon)');
{
  const r = await post('/quotations', { ...quoteBase, lineItems: [mkLine({ unitPrice: MASTER - 0.01 })] });
  assert('One paisa below rejected', r.status === 400 && r.data?.code === 'MRP_BELOW_MASTER', `status=${r.status} code=${r.data?.code}`);
}

console.log('\n[4] EDIT: reducing below the floor is rejected; harmless edits stay allowed');
{
  const r = await put(`/quotations/${quoteAtMaster.id}`, { ...quoteBase, lineItems: [mkLine({ unitPrice: MASTER - 1 })] });
  assert('Reduce-below-master on edit rejected', r.status === 400 && r.data?.code === 'MRP_BELOW_MASTER', `status=${r.status} code=${r.data?.code}`);
  const ok = await put(`/quotations/${quoteAtMaster.id}`, { ...quoteBase, lineItems: [mkLine({ quantity: 3 })] });
  assert('Qty-only edit at the same MRP allowed', ok.status === 200, `status=${ok.status} ${JSON.stringify(ok.data).slice(0, 150)}`);
}

console.log('\n[5] EDIT grandfathering: master MRP rises AFTER the quote was saved');
{
  restoreMrp = { itemId: item.id, mrp: MASTER };
  const bumped = Math.round((MASTER + 50) * 100) / 100;
  const pr = await patch(`/items/${item.id}`, { mrp: bumped });
  assert('Raised the master MRP for the scenario', pr.status === 200, `status=${pr.status}`);

  // The old quote keeps its saved price as the floor — editable, not reducible.
  const ok = await put(`/quotations/${quoteAtMaster.id}`, { ...quoteBase, lineItems: [mkLine({ quantity: 4 })] });
  assert('Old quote still editable at its saved price', ok.status === 200, `status=${ok.status} ${JSON.stringify(ok.data).slice(0, 200)}`);
  const bad = await put(`/quotations/${quoteAtMaster.id}`, { ...quoteBase, lineItems: [mkLine({ unitPrice: MASTER - 1 })] });
  assert('...but still cannot go below its saved price', bad.status === 400 && bad.data?.code === 'MRP_BELOW_MASTER', `status=${bad.status}`);

  // A NEW quote must meet the new, higher master.
  const newQuote = await post('/quotations', { ...quoteBase, lineItems: [mkLine()] });
  assert('New quote at the OLD master is rejected after the rise', newQuote.status === 400 && newQuote.data?.code === 'MRP_BELOW_MASTER', `status=${newQuote.status}`);

  const rr = await patch(`/items/${item.id}`, { mrp: MASTER });
  assert('Restored the master MRP', rr.status === 200, `status=${rr.status}`);
  restoreMrp = null;
}

console.log('\n[6] CONVERSION: the sale uses the quotation MRP as its selling price');
{
  const saleRes = await post('/sales', {
    outletId: loc.id, locationType: 'warehouse', locationId: loc.id,
    saleDate: today, paymentMode: 'cash',
    quotationId: quoteRaised.id,
    lineItems: quoteRaised.lineItems.map(li => ({
      itemId: li.itemId, quantity: li.quantity, unitPrice: li.unitPrice, taxAmount: 0,
    })),
  });
  assert('Sale created from the raised-MRP quote', saleRes.status === 200 || saleRes.status === 201, `status=${saleRes.status} ${JSON.stringify(saleRes.data).slice(0, 200)}`);
  const sale = saleRes.data;
  if (sale?.id) createdSales.push(sale.id);
  const sLine = sale?.lineItems?.[0];
  assert('Sale line price = quotation MRP (raised)', close(sLine?.unitPrice, RAISED), `unitPrice=${sLine?.unitPrice}`);
  assert('Sale total matches the quotation total', close(sale?.totalAmount, quoteRaised.totalAmount), `sale=${sale?.totalAmount} quote=${quoteRaised.totalAmount}`);
  assert('Item Master MRP unchanged after conversion', close(await masterNow(), MASTER));

  const qAfter = await get(`/quotations/${quoteRaised.id}`);
  assert('Quotation marked converted', !!qAfter.data?.convertedSaleId, JSON.stringify(qAfter.data).slice(0, 120));
}

console.log('\n[7] AUDIT: activity log records the MRP raise with user + timestamp');
// The audit trail is written to the activity_log table (lib/audit.ts); there
// is no list API for it, so this check reads the table directly.
if (process.env.DATABASE_URL) {
  const { execSync } = await import('node:child_process');
  const sql = `SELECT json_build_object('user', "user", 'createdAt', created_at, 'overrides', metadata->'mrpOverrides') FROM activity_log WHERE module='quotations' AND entity_id=${Number(quoteRaised.id)} AND metadata ? 'mrpOverrides' ORDER BY id DESC LIMIT 1`;
  let row = null;
  try {
    const out = execSync(`psql "$DATABASE_URL" -Atc ${JSON.stringify(sql)}`, { encoding: 'utf8' }).trim();
    row = out ? JSON.parse(out) : null;
  } catch { /* psql unavailable */ }
  assert('Activity log row carries mrpOverrides metadata', !!row?.overrides?.length, JSON.stringify(row));
  if (row?.overrides?.length) {
    const o = row.overrides[0];
    assert('Audit records original master MRP', close(o.masterMrp, MASTER), JSON.stringify(o));
    assert('Audit records the new quotation MRP', close(o.quotationMrp, RAISED), JSON.stringify(o));
    assert('Audit records the user', !!row.user, JSON.stringify(row).slice(0, 120));
    assert('Audit records date & time', !!row.createdAt, '');
  }
} else {
  console.log('  (skipped — DATABASE_URL not set)');
}

console.log('\n[8] Item Master MRP never changed at any point');
assert('Final master MRP equals the original', close(await masterNow(), MASTER));

// ── Cleanup & summary ────────────────────────────────────────────────────────
await cleanup();
console.log(`\n${passed} passed, ${failed} failed${failed ? ` — ${failures.join('; ')}` : ''}`);
process.exit(failed ? 1 : 0);
