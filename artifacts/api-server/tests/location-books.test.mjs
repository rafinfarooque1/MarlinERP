/**
 * Location-dimensioned books & as-of positions — regression tests (Task #179)
 * Run: node artifacts/api-server/tests/location-books.test.mjs
 *
 * READ-ONLY: creates nothing, deletes nothing. Proves the two structural
 * guarantees of the location dimension over the posting stream:
 *
 *  1. ZERO DRIFT — an unfiltered response carries no location keys and its
 *     figures are the consolidated books.
 *  2. EXACT PARTITION — every posting is in precisely one location slice
 *     (warehouse/outlet by type+id, headoffice by type alone) or in the
 *     company bucket, so slices + company reconcile to the consolidated
 *     figures per ledger, and every slice is internally balanced because
 *     both legs of an entry share one stamp.
 *
 * Plus the as-of contract on receivables/payables: ?asOf=today ≡ undated,
 * and an as-of before the first transaction is an empty position.
 */
const BASE = process.env.API_URL || 'http://localhost:8080/api';
const TODAY = new Date().toISOString().slice(0, 10);
const FROM = '2000-01-01';

let authToken = '';
let passed = 0, failed = 0;
const failures = [];

function assert(label, condition, detail = '') {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; failures.push(`${label}${detail ? ' — ' + detail : ''}`); }
}

async function get(path) {
  const r = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${authToken}` } });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}

const r2 = (n) => Math.round(Number(n ?? 0) * 100) / 100;
const near = (a, b, tol = 0.05) => Math.abs(r2(a) - r2(b)) <= tol;

async function login() {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'marlin1458' }),
  });
  const d = await r.json();
  authToken = d.token;
  if (!authToken) throw new Error('login failed');
}

/** Every location slice the filter recognises, discovered from the live data. */
async function allSlices() {
  const [wh, ou] = await Promise.all([get('/warehouses'), get('/outlets')]);
  const slices = [];
  for (const w of (Array.isArray(wh.data) ? wh.data : [])) slices.push({ q: `locationType=warehouse&locationId=${w.id}`, name: `warehouse:${w.id}` });
  for (const o of (Array.isArray(ou.data) ? ou.data : [])) slices.push({ q: `locationType=outlet&locationId=${o.id}`, name: `outlet:${o.id}` });
  slices.push({ q: 'locationType=headoffice', name: 'headoffice' });
  slices.push({ q: 'locationType=company', name: 'company' });
  return slices;
}

// ── 1. Trial balance: zero drift + exact partition ───────────────────────────
async function testTrialBalance(slices) {
  console.log('\n— Trial balance (/reports/fin/trial-balance) —');
  const range = `from=${FROM}&to=${TODAY}`;
  const cons = await get(`/reports/fin/trial-balance?${range}`);
  assert('unfiltered TB responds 200', cons.status === 200);
  assert('unfiltered TB has NO location key (zero drift)', !('location' in cons.data));
  assert('unfiltered TB has NO companyLevel key (zero drift)', !('companyLevel' in cons.data));
  assert('unfiltered TB is balanced', cons.data.balanced === true, `diff=${cons.data.difference}`);

  // Net (Dr−Cr) per ledger, summed across every slice, must equal consolidated.
  const consNet = new Map(cons.data.rows.map((r) => [Number(r.ledgerId), r2(r.debit - r.credit)]));
  const sliceNet = new Map();
  let allSlicesBalanced = true;
  for (const s of slices) {
    const res = await get(`/reports/fin/trial-balance?${range}&${s.q}`);
    assert(`slice ${s.name} responds 200 and echoes location`, res.status === 200 && !!res.data.location);
    if (!res.data.balanced) { allSlicesBalanced = false; console.error(`    slice ${s.name} unbalanced by ${res.data.difference}`); }
    for (const r of res.data.rows ?? []) {
      const id = Number(r.ledgerId);
      sliceNet.set(id, r2((sliceNet.get(id) ?? 0) + r.debit - r.credit));
    }
  }
  assert('every slice is internally balanced (both legs share one stamp)', allSlicesBalanced);

  let drift = 0;
  for (const [id, net] of consNet) if (!near(net, sliceNet.get(id) ?? 0)) { drift++; console.error(`    ledger ${id}: consolidated ${net} vs Σslices ${r2(sliceNet.get(id) ?? 0)}`); }
  for (const [id, net] of sliceNet) if (!consNet.has(id) && Math.abs(net) > 0.05) { drift++; console.error(`    ledger ${id} appears only in slices with net ${net}`); }
  assert('slices + company bucket reconcile to consolidated per ledger', drift === 0, `${drift} ledgers drift`);

  // companyLevel echo: the same unattributable postings whichever slice asked.
  const ho = await get(`/reports/fin/trial-balance?${range}&locationType=headoffice`);
  assert('filtered TB echoes companyLevel {entries, debit, credit}',
    ho.data.companyLevel && ['entries', 'debit', 'credit'].every((k) => k in ho.data.companyLevel));
}

// ── 2. Day book: slice totals partition the consolidated totals ─────────────
async function testDayBook(slices) {
  console.log('\n— Day book (/reports/fin/day-book) —');
  const range = `from=${FROM}&to=${TODAY}`;
  const cons = await get(`/reports/fin/day-book?${range}`);
  assert('unfiltered day book has NO location key', cons.status === 200 && !('location' in cons.data));
  let debit = 0, credit = 0, count = 0;
  for (const s of slices) {
    const res = await get(`/reports/fin/day-book?${range}&${s.q}`);
    debit += Number(res.data.totals?.debit ?? 0);
    credit += Number(res.data.totals?.credit ?? 0);
    count += Number(res.data.totals?.count ?? 0);
  }
  assert('Σ slice debits = consolidated debit', near(debit, cons.data.totals?.debit), `${r2(debit)} vs ${cons.data.totals?.debit}`);
  assert('Σ slice credits = consolidated credit', near(credit, cons.data.totals?.credit), `${r2(credit)} vs ${cons.data.totals?.credit}`);
  assert('Σ slice entry counts = consolidated count', count === Number(cons.data.totals?.count ?? 0), `${count} vs ${cons.data.totals?.count}`);
}

// ── 3. Financial statements: location scoping + company-slice stock rule ────
async function testFinancialStatements() {
  console.log('\n— Financial statements (/accounts/financial-statements) —');
  const range = `fromDate=${FROM}&toDate=${TODAY}`;
  const cons = await get(`/accounts/financial-statements?${range}`);
  assert('unfiltered statements respond 200', cons.status === 200);
  assert('unfiltered statements are NOT locationScoped', cons.data.locationScoped === false || cons.data.locationScoped === undefined);
  assert('unfiltered statements carry no location echo', !('location' in cons.data));

  const wh = await get('/warehouses');
  const w = Array.isArray(wh.data) ? wh.data[0] : null;
  if (w) {
    const slice = await get(`/accounts/financial-statements?${range}&locationType=warehouse&locationId=${w.id}`);
    assert('warehouse slice responds 200 and is locationScoped', slice.status === 200 && slice.data.locationScoped === true);
    assert('warehouse slice closing stock is branch-scoped (≤ consolidated)',
      r2(slice.data.profitAndLoss.incomes.closingStock) <= r2(cons.data.profitAndLoss.incomes.closingStock) + 0.05,
      `${slice.data.profitAndLoss.incomes.closingStock} vs ${cons.data.profitAndLoss.incomes.closingStock}`);
  }

  const comp = await get(`/accounts/financial-statements?${range}&locationType=company`);
  assert('company slice responds 200', comp.status === 200);
  assert("company slice closing stock = 0 (stock always belongs to a place)",
    r2(comp.data.profitAndLoss.incomes.closingStock) === 0, `got ${comp.data.profitAndLoss.incomes.closingStock}`);
  assert("company slice opening stock = 0", r2(comp.data.profitAndLoss.expenses.openingStock) === 0);
}

// ── 4. Cash/bank book: unfiltered zero-drift, slice echoes ──────────────────
async function testBooks() {
  console.log('\n— Cash & bank books (/reports/fin/cash|bank) —');
  const range = `from=${FROM}&to=${TODAY}`;
  for (const kind of ['cash', 'bank']) {
    const cons = await get(`/reports/fin/${kind}?${range}`);
    assert(`unfiltered ${kind} book has NO location key`, cons.status === 200 && !('location' in cons.data));
    const ho = await get(`/reports/fin/${kind}?${range}&locationType=headoffice`);
    assert(`${kind} book headoffice slice echoes location`, ho.status === 200 && ho.data.location?.type === 'headoffice');
    const consFlow = r2(cons.data.totalReceipts) - r2(cons.data.totalPayments);
    const hoFlow = r2(ho.data.totalReceipts) - r2(ho.data.totalPayments);
    // A slice is a subset of the money movements, so its gross flows can never
    // exceed the consolidated ones.
    assert(`${kind} slice receipts ≤ consolidated`, r2(ho.data.totalReceipts) <= r2(cons.data.totalReceipts) + 0.05, `${hoFlow} vs ${consFlow}`);
  }
}

// ── 5. As-of receivables / payables ──────────────────────────────────────────
async function testAsOfPositions() {
  console.log('\n— As-of receivables & payables (/outstanding/*) —');
  for (const side of ['receivables', 'payables']) {
    const key = side === 'receivables' ? 'customers' : 'vendors';
    const now = await get(`/outstanding/${side}`);
    const today = await get(`/outstanding/${side}?asOf=${TODAY}`);
    assert(`${side}: asOf=today equals the undated position (net due)`,
      near(now.data.totals?.netDue, today.data.totals?.netDue), `${now.data.totals?.netDue} vs ${today.data.totals?.netDue}`);
    assert(`${side}: asOf=today equals undated row count`,
      (now.data[key] ?? []).length === (today.data[key] ?? []).length);

    const ancient = await get(`/outstanding/${side}?asOf=1999-12-31`);
    assert(`${side}: asOf before first transaction is an empty position`,
      r2(ancient.data.totals?.totalDue ?? 0) === 0 && (ancient.data[key] ?? []).length === 0,
      `totalDue=${ancient.data.totals?.totalDue} rows=${(ancient.data[key] ?? []).length}`);
    assert(`${side}: response echoes the asOf date`, String(ancient.data.asOf).slice(0, 10) === '1999-12-31', `got ${ancient.data.asOf}`);
  }
}

(async () => {
  await login();
  const slices = await allSlices();
  console.log(`Slices under test: ${slices.map((s) => s.name).join(', ')}`);
  await testTrialBalance(slices);
  await testDayBook(slices);
  await testFinancialStatements();
  await testBooks();
  await testAsOfPositions();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) { console.error('Failures:'); for (const f of failures) console.error(' - ' + f); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
