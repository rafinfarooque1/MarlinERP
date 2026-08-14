/**
 * Quotation salesperson & payment-terms masters — integration tests
 * Run: node artifacts/api-server/tests/quotation-salesperson-terms.test.mjs
 *
 * Rules under test:
 * - quotation_payment_terms is a small managed list (Settings CRUD): seeded
 *   defaults, case-insensitive uniqueness, rename/delete never rewrite the
 *   TEXT already stored on quotations (grandfathered wording).
 * - GET /quotations/salespeople is a minimal ACTIVE-employee directory
 *   (id/name/branch only — no salary or contact fields).
 * - salespersonEmployeeId on create/edit must be an active employee at the
 *   quotation's location or Head Office; the server snapshots the NAME into
 *   the legacy `salesperson` text column so PDFs/lists/CSV need no changes.
 * - Legacy free-text salesperson values round-trip edits unchanged and an
 *   unchanged employee reference is grandfathered (no re-validation).
 * - Conversion to a sale is unaffected.
 *
 * Runs against the DEVELOPMENT database via the dev API server. Every sale it
 * creates is cancelled, every quotation deleted, every term it adds removed.
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
const del = (p, t) => apiReq('DELETE', p, undefined, t);

const createdQuotes = [];
const createdSales = [];
const createdTerms = [];
async function cleanup() {
  for (const id of createdSales) {
    await post(`/sales/${id}/cancel`, { reason: 'quotation salesperson/terms test cleanup' }).catch(() => {});
  }
  for (const id of createdQuotes) {
    await del(`/quotations/${id}`).catch(() => {});
  }
  for (const id of createdTerms) {
    await del(`/quotation-payment-terms/${id}`).catch(() => {});
  }
}

// ── Auth ─────────────────────────────────────────────────────────────────────
const loginRes = await post('/auth/login', {
  username: process.env.TEST_USERNAME || 'admin',
  password: process.env.TEST_PASSWORD || 'marlin1458',
});
authToken = loginRes.data?.token ?? '';
assert('Admin login returns a token', !!authToken, `status=${loginRes.status}`);
if (!authToken) { console.error('FATAL: no token'); process.exit(1); }

// ── Fixture: a warehouse holding a stocked MRP item (quote line must clear
// the MRP floor, same fixture the quotation-mrp suite uses) ─────────────────
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
  lineItems: [{ itemId: item.id, quantity: 1, unitPrice: MASTER, taxAmount: 0 }],
};

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[1] Payment terms master: seeded defaults are present');
const SEEDED = ['Advance', '7 Days', '15 Days', '30 Days', 'Against Delivery'];
{
  const r = await get('/quotation-payment-terms');
  assert('GET list returns 200', r.status === 200, `status=${r.status}`);
  const labels = (r.data ?? []).map(t => t.label);
  for (const want of SEEDED) {
    assert(`Seeded option present: ${want}`, labels.includes(want), `labels=${labels.join(', ')}`);
  }
  const sortOrders = (r.data ?? []).map(t => t.sortOrder);
  assert('Rows carry id/label/sortOrder', (r.data ?? []).every(t => t.id > 0 && typeof t.label === 'string' && Number.isFinite(t.sortOrder)), JSON.stringify(r.data?.[0]));
  assert('List is ordered by sortOrder', sortOrders.every((v, i) => i === 0 || v >= sortOrders[i - 1]), sortOrders.join(','));
}

console.log('\n[2] Payment terms CRUD: create, duplicate guard, rename, delete');
const CUSTOM = `Test Terms ${Date.now()}`;
let customTerm = null;
{
  const r = await post('/quotation-payment-terms', { label: CUSTOM });
  assert('POST creates with 201', r.status === 201, `status=${r.status} ${JSON.stringify(r.data).slice(0, 150)}`);
  customTerm = r.data;
  if (customTerm?.id) createdTerms.push(customTerm.id);

  const dup = await post('/quotation-payment-terms', { label: CUSTOM.toUpperCase() });
  assert('Case-insensitive duplicate rejected with 409', dup.status === 409, `status=${dup.status}`);
  if (dup.status === 201 && dup.data?.id) createdTerms.push(dup.data.id); // safety

  const blank = await post('/quotation-payment-terms', { label: '   ' });
  assert('Blank label rejected with 400', blank.status === 400, `status=${blank.status}`);

  const renamed = await apiReq('PATCH', `/quotation-payment-terms/${customTerm.id}`, { label: `${CUSTOM} v2` });
  assert('PATCH renames', renamed.status === 200 && renamed.data?.label === `${CUSTOM} v2`, `status=${renamed.status}`);

  const seedDup = await apiReq('PATCH', `/quotation-payment-terms/${customTerm.id}`, { label: 'advance' });
  assert('Rename onto a seeded label rejected with 409', seedDup.status === 409, `status=${seedDup.status}`);
}

console.log('\n[3] Renaming/deleting a term never rewrites stored quotations');
let quoteWithTerm = null;
{
  const r = await post('/quotations', { ...quoteBase, paymentTerms: `${CUSTOM} v2` });
  assert('Quote created with the custom term', r.status === 200 || r.status === 201, `status=${r.status} ${JSON.stringify(r.data).slice(0, 150)}`);
  quoteWithTerm = r.data;
  if (quoteWithTerm?.id) createdQuotes.push(quoteWithTerm.id);
  assert('Quote stores the term TEXT', quoteWithTerm?.paymentTerms === `${CUSTOM} v2`, `paymentTerms=${quoteWithTerm?.paymentTerms}`);

  const gone = await del(`/quotation-payment-terms/${customTerm.id}`);
  assert('DELETE succeeds', gone.status === 200 && gone.data?.success === true, `status=${gone.status}`);
  createdTerms.splice(createdTerms.indexOf(customTerm.id), 1);

  const again = await del(`/quotation-payment-terms/${customTerm.id}`);
  assert('Deleting twice → 404', again.status === 404, `status=${again.status}`);

  const q = await get(`/quotations/${quoteWithTerm.id}`);
  assert('Stored quotation still shows the deleted term wording', q.data?.paymentTerms === `${CUSTOM} v2`, `paymentTerms=${q.data?.paymentTerms}`);
}

console.log('\n[4] Salesperson directory: minimal, active-only');
let salespeople = [];
let hoEmployee = null;
let otherBranchEmployee = null;
{
  const r = await get('/quotations/salespeople');
  assert('GET /quotations/salespeople returns 200', r.status === 200, `status=${r.status}`);
  salespeople = r.data ?? [];
  assert('Directory is non-empty', salespeople.length > 0, `count=${salespeople.length}`);
  const sample = salespeople[0] ?? {};
  assert('Rows carry id/name/branchType', sample.id > 0 && !!sample.name && !!sample.branchType, JSON.stringify(sample));
  const leaked = ['salary', 'phone', 'email', 'username', 'password', 'bankAccount'].filter(k => k in sample);
  assert('No salary/contact/credential fields leak', leaked.length === 0, `leaked=${leaked.join(',')}`);

  hoEmployee = salespeople.find(e => e.branchType === 'headoffice');
  assert('Head-office staff present in the directory', !!hoEmployee, '');
  otherBranchEmployee = salespeople.find(e =>
    e.branchType !== 'headoffice' && !(e.branchType === 'warehouse' && Number(e.branchId) === Number(loc.id)));

  // Active-only: compare against the DB when available.
  if (process.env.DATABASE_URL) {
    const { execSync } = await import('node:child_process');
    try {
      const inactive = execSync(`psql "$DATABASE_URL" -Atc "SELECT COALESCE(json_agg(id), '[]') FROM employees WHERE is_active = false"`, { encoding: 'utf8' }).trim();
      const inactiveIds = new Set(JSON.parse(inactive || '[]').map(Number));
      const leakedInactive = salespeople.filter(e => inactiveIds.has(Number(e.id)));
      assert('Inactive employees are excluded', leakedInactive.length === 0, `leaked=${leakedInactive.map(e => e.id).join(',')}`);
    } catch { console.log('  (psql unavailable — skipped inactive check)'); }
  }
}

console.log('\n[5] Create with salespersonEmployeeId: snapshot + validation');
let quoteWithEmp = null;
{
  const r = await post('/quotations', { ...quoteBase, salespersonEmployeeId: hoEmployee.id });
  assert('Quote created with an HO employee as salesperson', r.status === 200 || r.status === 201, `status=${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  quoteWithEmp = r.data;
  if (quoteWithEmp?.id) createdQuotes.push(quoteWithEmp.id);
  assert('Response carries salespersonEmployeeId', Number(quoteWithEmp?.salespersonEmployeeId) === Number(hoEmployee.id), `got=${quoteWithEmp?.salespersonEmployeeId}`);
  assert('salesperson text = employee name snapshot', quoteWithEmp?.salesperson === hoEmployee.name, `salesperson=${quoteWithEmp?.salesperson}`);

  const bogus = await post('/quotations', { ...quoteBase, salespersonEmployeeId: 99999999 });
  assert('Unknown employee id rejected with 400', bogus.status === 400, `status=${bogus.status}`);
  if ((bogus.status === 200 || bogus.status === 201) && bogus.data?.id) createdQuotes.push(bogus.data.id);

  // Free text is IGNORED when an employee reference is provided.
  const both = await post('/quotations', { ...quoteBase, salespersonEmployeeId: hoEmployee.id, salesperson: 'Should Be Ignored' });
  assert('Free text ignored when employee id present', (both.status === 200 || both.status === 201) && both.data?.salesperson === hoEmployee.name, `salesperson=${both.data?.salesperson}`);
  if (both.data?.id) createdQuotes.push(both.data.id);

  if (otherBranchEmployee) {
    const wrong = await post('/quotations', { ...quoteBase, salespersonEmployeeId: otherBranchEmployee.id });
    assert('Employee from a DIFFERENT branch rejected with 400', wrong.status === 400, `status=${wrong.status} emp=${otherBranchEmployee.id}@${otherBranchEmployee.branchType}/${otherBranchEmployee.branchId}`);
    assert('Rejection names the employee', String(wrong.data?.error ?? '').includes(otherBranchEmployee.name), String(wrong.data?.error).slice(0, 120));
    if ((wrong.status === 200 || wrong.status === 201) && wrong.data?.id) createdQuotes.push(wrong.data.id);
  } else {
    console.log('  (no employee at another branch found — location-mismatch check skipped)');
  }
}

console.log('\n[6] Legacy free text: stored, round-trips edits, replaceable');
let legacyQuote = null;
const LEGACY_NAME = 'Legacy Salesperson (typed)';
{
  const r = await post('/quotations', { ...quoteBase, salesperson: LEGACY_NAME });
  assert('Quote created with free-text salesperson', r.status === 200 || r.status === 201, `status=${r.status}`);
  legacyQuote = r.data;
  if (legacyQuote?.id) createdQuotes.push(legacyQuote.id);
  assert('Free text stored verbatim', legacyQuote?.salesperson === LEGACY_NAME, `salesperson=${legacyQuote?.salesperson}`);
  assert('No employee reference on a legacy quote', legacyQuote?.salespersonEmployeeId == null, `id=${legacyQuote?.salespersonEmployeeId}`);

  // An edit that leaves salesperson alone (form sends the text back) keeps it.
  const edit = await put(`/quotations/${legacyQuote.id}`, {
    ...quoteBase, salesperson: LEGACY_NAME,
    lineItems: [{ itemId: item.id, quantity: 2, unitPrice: MASTER, taxAmount: 0 }],
  });
  assert('Qty-only edit keeps the legacy text', edit.status === 200 && edit.data?.salesperson === LEGACY_NAME, `status=${edit.status} salesperson=${edit.data?.salesperson}`);

  // Replacing with an employee swaps in the reference + name snapshot.
  const replace = await put(`/quotations/${legacyQuote.id}`, {
    ...quoteBase, salespersonEmployeeId: hoEmployee.id,
    lineItems: [{ itemId: item.id, quantity: 2, unitPrice: MASTER, taxAmount: 0 }],
  });
  assert('Replace with employee: reference stored', replace.status === 200 && Number(replace.data?.salespersonEmployeeId) === Number(hoEmployee.id), `status=${replace.status}`);
  assert('Replace with employee: name snapshot stored', replace.data?.salesperson === hoEmployee.name, `salesperson=${replace.data?.salesperson}`);

  // Clearing (null) drops both.
  const clear = await put(`/quotations/${legacyQuote.id}`, {
    ...quoteBase, salespersonEmployeeId: null,
    lineItems: [{ itemId: item.id, quantity: 2, unitPrice: MASTER, taxAmount: 0 }],
  });
  assert('Clearing salesperson drops reference and text', clear.status === 200 && clear.data?.salespersonEmployeeId == null && !clear.data?.salesperson, `id=${clear.data?.salespersonEmployeeId} text=${clear.data?.salesperson}`);
}

console.log('\n[7] Unchanged employee reference is grandfathered on edit');
{
  // Edit quoteWithEmp resending the SAME salespersonEmployeeId — must succeed
  // without re-validation (an employee who later resigns/moves must not lock
  // the quote), and keep the stored snapshot.
  const edit = await put(`/quotations/${quoteWithEmp.id}`, {
    ...quoteBase, salespersonEmployeeId: hoEmployee.id,
    lineItems: [{ itemId: item.id, quantity: 3, unitPrice: MASTER, taxAmount: 0 }],
  });
  assert('Edit with unchanged reference succeeds', edit.status === 200, `status=${edit.status}`);
  assert('Snapshot name preserved', edit.data?.salesperson === hoEmployee.name, `salesperson=${edit.data?.salesperson}`);
}

console.log('\n[8] Conversion regression: quote with salesperson converts to a sale');
{
  const q = await post('/quotations', { ...quoteBase, salespersonEmployeeId: hoEmployee.id, paymentTerms: '30 Days' });
  assert('Quote created', q.status === 200 || q.status === 201, `status=${q.status}`);
  const quote = q.data;
  if (quote?.id) createdQuotes.push(quote.id);

  const saleRes = await post('/sales', {
    outletId: loc.id, locationType: 'warehouse', locationId: loc.id,
    saleDate: today, paymentMode: 'cash',
    quotationId: quote.id,
    lineItems: quote.lineItems.map(li => ({
      itemId: li.itemId, quantity: li.quantity, unitPrice: li.unitPrice, taxAmount: 0,
    })),
  });
  assert('Sale created from the quote', saleRes.status === 200 || saleRes.status === 201, `status=${saleRes.status} ${JSON.stringify(saleRes.data).slice(0, 200)}`);
  if (saleRes.data?.id) createdSales.push(saleRes.data.id);
  assert('Sale total matches the quote', close(saleRes.data?.totalAmount, quote.totalAmount), `sale=${saleRes.data?.totalAmount} quote=${quote.totalAmount}`);

  const after = await get(`/quotations/${quote.id}`);
  assert('Quote marked converted', !!after.data?.convertedSaleId, JSON.stringify(after.data).slice(0, 120));
  assert('Salesperson survives conversion untouched', after.data?.salesperson === hoEmployee.name && Number(after.data?.salespersonEmployeeId) === Number(hoEmployee.id), `salesperson=${after.data?.salesperson}`);
  assert('Payment terms survive conversion untouched', after.data?.paymentTerms === '30 Days', `paymentTerms=${after.data?.paymentTerms}`);
}

// ── Cleanup & summary ────────────────────────────────────────────────────────
await cleanup();
console.log(`\n${passed} passed, ${failed} failed${failed ? ` — ${failures.join('; ')}` : ''}`);
process.exit(failed ? 1 : 0);
