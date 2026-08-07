/**
 * POS MRP floor — integration tests
 * Run: node artifacts/api-server/tests/mrp-floor.test.mjs
 *
 * Rule: a sale line's MRP (unitPrice) may EQUAL or EXCEED the Item Master
 * MRP, never go below it. Reductions must go through the discount fields so
 * MRP, selling price and discount stay separate figures in reports.
 * Enforced on CREATE and EDIT, in the API (this suite) and the POS UI.
 *
 * Grandfathering: editing an old invoice whose saved price predates a later
 * master-MRP increase stays possible as long as the price is not reduced
 * further — the edit floor is min(master MRP, the line's previously saved
 * price). New sales always use the current master.
 *
 * Runs against the DEVELOPMENT database via the dev API server. Every sale it
 * creates is cancelled at the end, and any item MRP it changes is restored.
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

const createdSales = [];
let restoreMrp = null; // { itemId, mrp }
async function cleanup() {
  if (restoreMrp) {
    await patch(`/items/${restoreMrp.itemId}`, { mrp: restoreMrp.mrp }).catch(() => {});
  }
  for (const id of createdSales) {
    await post(`/sales/${id}/cancel`, { reason: 'mrp-floor test cleanup' }).catch(() => {});
  }
}

const SPEC_MESSAGE = 'MRP cannot be lower than the Item Master MRP. Use Discount if you want to reduce the selling price.';

// ── Auth ─────────────────────────────────────────────────────────────────────
const loginRes = await post('/auth/login', { username: process.env.TEST_USERNAME || 'admin', password: process.env.TEST_PASSWORD || 'marlin1458' });
authToken = loginRes.data?.token ?? '';
assert('Admin login returns a token', !!authToken, `status=${loginRes.status}`);
if (!authToken) { console.error('FATAL: no token'); process.exit(1); }

// ── Fixture discovery: a warehouse holding an item WITH a master MRP + stock ─
const [itemsRes, warehousesRes] = await Promise.all([get('/items'), get('/warehouses')]);
const items = itemsRes.data ?? [];
const warehouses = warehousesRes.data ?? [];

let loc = null, item = null, zeroMrpItem = null;
for (const wh of warehouses) {
  const stockRes = await get(`/stock?branchType=warehouse&branchId=${wh.id}`);
  const rows = stockRes.data ?? [];
  const withMrp = rows
    .map(r => ({ r, it: items.find(i => i.id === r.itemId) }))
    .filter(x => x.it && Number(x.it.mrp) > 0 && Number(x.r.quantity) >= 10);
  if (withMrp.length && !loc) {
    loc = wh; item = withMrp[0].it;
    const noMrp = rows
      .map(r => items.find(i => i.id === r.itemId && Number(i?.mrp ?? 0) <= 0 && Number(r.quantity) >= 5))
      .filter(Boolean);
    zeroMrpItem = noMrp[0] ?? null;
    break;
  }
}
assert('Found a warehouse with an MRP-priced item in stock', !!(loc && item),
  `warehouses=${warehouses.length}`);
if (!loc || !item) { await cleanup(); process.exit(1); }

const MASTER = Number(item.mrp);
const today = new Date().toISOString().slice(0, 10);
console.log(`  (using warehouse=${loc.id} item=${item.id} masterMRP=₹${MASTER})`);

const saleBase = {
  outletId: loc.id, locationType: 'warehouse', locationId: loc.id,
  saleDate: today, paymentMode: 'cash',
};
const mkLine = (over = {}) => ({ itemId: item.id, quantity: 1, unitPrice: MASTER, taxAmount: 0, ...over });

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[1] CREATE below master MRP is rejected');
{
  const r = await post('/sales', { ...saleBase, lineItems: [mkLine({ unitPrice: MASTER - 1 })] });
  assert('Rejected with 400', r.status === 400, `status=${r.status}`);
  assert('Error carries the spec message', String(r.data?.error ?? '').includes(SPEC_MESSAGE),
    JSON.stringify(r.data).slice(0, 200));
  assert('Error code is MRP_BELOW_MASTER', r.data?.code === 'MRP_BELOW_MASTER', `code=${r.data?.code}`);
}

console.log('\n[1b] Boundary: even a fraction of a paisa below is rejected (strict compare, no epsilon)');
{
  const paisaBelow = await post('/sales', { ...saleBase, lineItems: [mkLine({ unitPrice: MASTER - 0.01 })] });
  assert('One paisa below rejected', paisaBelow.status === 400 && paisaBelow.data?.code === 'MRP_BELOW_MASTER',
    `status=${paisaBelow.status} code=${paisaBelow.data?.code}`);
  const subPaisa = await post('/sales', { ...saleBase, lineItems: [mkLine({ unitPrice: MASTER - 0.004 })] });
  assert('Sub-paisa below (₹' + (MASTER - 0.004) + ') rejected', subPaisa.status === 400 && subPaisa.data?.code === 'MRP_BELOW_MASTER',
    `status=${subPaisa.status} code=${subPaisa.data?.code}`);
}

console.log('\n[2] CREATE at exactly master MRP is accepted');
let equalSaleId = 0;
{
  const r = await post('/sales', { ...saleBase, lineItems: [mkLine()] });
  assert('Sale created', r.status < 300 && !r.data?.error, JSON.stringify(r.data).slice(0, 200));
  if (r.data?.id) {
    createdSales.push(r.data.id); equalSaleId = r.data.id;
    assert('Stored unitPrice = master MRP', close(r.data.lineItems?.[0]?.unitPrice, MASTER),
      `got ${r.data.lineItems?.[0]?.unitPrice}`);
  }
}

console.log('\n[3] CREATE above master MRP is accepted');
{
  const r = await post('/sales', { ...saleBase, lineItems: [mkLine({ unitPrice: MASTER + 25 })] });
  assert('Sale created above MRP', r.status < 300 && !r.data?.error, JSON.stringify(r.data).slice(0, 200));
  if (r.data?.id) createdSales.push(r.data.id);
}

console.log('\n[4] Discount below MRP still works — MRP stored intact, discount separate');
{
  const r = await post('/sales', { ...saleBase, lineItems: [mkLine({ unitDiscount: Math.min(10, MASTER / 2) })] });
  assert('Discounted sale created', r.status < 300 && !r.data?.error, JSON.stringify(r.data).slice(0, 200));
  if (r.data?.id) {
    createdSales.push(r.data.id);
    const li = r.data.lineItems?.[0] ?? {};
    assert('unitPrice NOT overwritten by the discount', close(li.unitPrice, MASTER), `got ${li.unitPrice}`);
    assert('Discount recorded as its own figure', Number(li.discount) > 0, `discount=${li.discount}`);
  }
}

console.log('\n[5] EDIT: price may rise, may not fall below the floor');
{
  const up = await put(`/sales/${equalSaleId}`, { ...saleBase, lineItems: [mkLine({ unitPrice: MASTER + 10 })] });
  assert('Edit raising the price succeeds', up.status < 300 && !up.data?.error,
    JSON.stringify(up.data).slice(0, 200));
  const down = await put(`/sales/${equalSaleId}`, { ...saleBase, lineItems: [mkLine({ unitPrice: MASTER - 5 })] });
  assert('Edit lowering below master is rejected', down.status === 400 && down.data?.code === 'MRP_BELOW_MASTER',
    `status=${down.status} code=${down.data?.code}`);
  // leave the sale at master for the grandfathering scenario below
  const back = await put(`/sales/${equalSaleId}`, { ...saleBase, lineItems: [mkLine()] });
  assert('Edit back to exactly master succeeds', back.status < 300 && !back.data?.error,
    JSON.stringify(back.data).slice(0, 200));
}

console.log('\n[6] Grandfathering: master MRP rises AFTER the sale was saved');
{
  restoreMrp = { itemId: item.id, mrp: MASTER };
  const bump = await patch(`/items/${item.id}`, { mrp: MASTER + 50 });
  assert('Item master MRP raised for the scenario', bump.status < 300, `status=${bump.status}`);

  // Old invoice saved at the old master: keeping its price must still work…
  const keep = await put(`/sales/${equalSaleId}`, { ...saleBase, lineItems: [mkLine()] });
  assert('Edit keeping the old (grandfathered) price succeeds', keep.status < 300 && !keep.data?.error,
    JSON.stringify(keep.data).slice(0, 200));
  // …but reducing it further must not.
  const lower = await put(`/sales/${equalSaleId}`, { ...saleBase, lineItems: [mkLine({ unitPrice: MASTER - 5 })] });
  assert('Edit reducing below the saved price is rejected', lower.status === 400 && lower.data?.code === 'MRP_BELOW_MASTER',
    `status=${lower.status} code=${lower.data?.code}`);
  // A NEW sale is held to the CURRENT master, not the old one.
  const fresh = await post('/sales', { ...saleBase, lineItems: [mkLine()] });
  assert('New sale at the old master is rejected after the rise',
    fresh.status === 400 && fresh.data?.code === 'MRP_BELOW_MASTER',
    `status=${fresh.status} code=${fresh.data?.code}`);
  if (fresh.data?.id) createdSales.push(fresh.data.id);

  const restore = await patch(`/items/${item.id}`, { mrp: MASTER });
  assert('Item master MRP restored', restore.status < 300, `status=${restore.status}`);
  if (restore.status < 300) restoreMrp = null;
}

console.log('\n[7] Items without a master MRP have no floor');
if (zeroMrpItem) {
  const r = await post('/sales', {
    ...saleBase,
    lineItems: [{ itemId: zeroMrpItem.id, quantity: 1, unitPrice: 50, taxAmount: 0 }],
  });
  assert('Sale of a no-MRP item at any price succeeds', r.status < 300 && !r.data?.error,
    JSON.stringify(r.data).slice(0, 200));
  if (r.data?.id) createdSales.push(r.data.id);
} else {
  console.log('  (no zero-MRP item with stock at this warehouse — skipped)');
}

// ── Cleanup & summary ────────────────────────────────────────────────────────
await cleanup();
console.log(`\n${passed} passed, ${failed} failed${failed ? ` — ${failures.join('; ')}` : ''}`);
process.exit(failed ? 1 : 0);
