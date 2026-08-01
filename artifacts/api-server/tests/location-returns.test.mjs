/**
 * Returns in location-dimensioned books + backdated as-of receivables (Task #179)
 * Run: node artifacts/api-server/tests/location-returns.test.mjs
 *
 * Proves the three return-flow rules the location dimension depends on:
 *
 *  1. A sales-return CREDIT NOTE is a system journal voucher raised from a
 *     location-bearing document, so its postings belong to the sale's
 *     location slice — NOT the company-level bucket.
 *  2. A walk-in CASH REFUND is a payments row stamped with the return's
 *     location, so the cash outflow stays in that location's books instead of
 *     misfiling under Head Office.
 *  3. As-of receivables cap credit notes by their BUSINESS date
 *     (return_date), so a backdated return recorded later still reduces the
 *     position on every date from its effective date onward.
 *
 * Creates ZZLOCRET-tagged fixtures. Returns are not deletable by design, so
 * the fixture sale+return pairs stay in the dev DB (each nets to ~zero:
 * stock out then back in, revenue reversed by the return).
 */
import pg from 'pg';

const BASE = process.env.API_URL || 'http://localhost:8080/api';
const TAG = 'ZZLOCRET';
const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };
const TODAY = daysAgo(0), D10 = daysAgo(10), D7 = daysAgo(7), D5 = daysAgo(5), D3 = daysAgo(3), D2 = daysAgo(2);

let authToken = '';
let passed = 0, failed = 0;
const failures = [];
function assert(label, condition, detail = '') {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; failures.push(`${label}${detail ? ' — ' + detail : ''}`); }
}
async function apiReq(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json', ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(`${BASE}${path}`, opts);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}
const post = (p, b) => apiReq('POST', p, b);
const get = (p) => apiReq('GET', p);
const r2 = (n) => Math.round(Number(n ?? 0) * 100) / 100;
const near = (a, b, tol = 0.02) => Math.abs(r2(a) - r2(b)) <= tol;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

/** Day-book entries in a slice, keyed on voucher number. */
async function dayBookVouchers(from, to, locQ) {
  const res = await get(`/reports/fin/day-book?from=${from}&to=${to}${locQ ? `&${locQ}` : ''}`);
  return new Set((res.data.entries ?? []).map((e) => e.voucherNumber).filter(Boolean));
}

(async () => {
  authToken = (await post('/auth/login', { username: 'admin', password: 'marlin1458' })).data?.token ?? '';
  if (!authToken) throw new Error('login failed');

  const WH = Number((await pool.query(`SELECT id FROM warehouses ORDER BY id LIMIT 1`)).rows[0].id);
  const locQ = `locationType=warehouse&locationId=${WH}`;

  // An item with enough stock at the warehouse to sell 2 units.
  const { rows: [stocked] } = await pool.query(
    `SELECT se.item_id AS id, SUM(se.quantity) AS qty
       FROM stock_entries se
      WHERE se.material_type = 'item' AND se.branch_type = 'warehouse' AND se.branch_id = $1
      GROUP BY se.item_id HAVING SUM(se.quantity) >= 2
      ORDER BY SUM(se.quantity) DESC LIMIT 1`, [WH]);
  if (!stocked) throw new Error(`no item with >=2 stock at warehouse ${WH} — seed stock first`);
  const ITEM = Number(stocked.id);
  const PRICE = 100; // explicit unit price in the sale payload; no lookup needed

  // ══ 1+3. Credit sale (backdated) + credit-note return (backdated, recorded now)
  console.log('\n— Credit-note return: location attribution + as-of business date —');
  const cres = await post('/customers', { name: `${TAG} Buyer`, phone: '9111111111', state: 'Karnataka' });
  assert('fixture customer created', cres.status === 201, `status ${cres.status}`);
  const CUST = cres.data?.id;

  const sres = await post('/sales', {
    outletId: WH, locationType: 'warehouse', locationId: WH, saleDate: D10,
    paymentMode: 'credit', customerId: CUST,
    lineItems: [{ itemId: ITEM, quantity: 1, unitPrice: PRICE, discount: 0, taxAmount: 0 }],
  });
  assert('backdated credit sale created', sres.status === 201, `status ${sres.status} ${JSON.stringify(sres.data).slice(0, 200)}`);
  const SALE = sres.data?.id, TOTAL = r2(sres.data?.totalAmount);

  const rres = await post('/sales-returns', {
    saleId: SALE, returnDate: D5, reason: `${TAG} backdated return`,
    lines: [{ lineIndex: 0, quantity: 1 }],
  });
  assert('backdated credit-note return created', rres.status === 201, `status ${rres.status} ${JSON.stringify(rres.data).slice(0, 300)}`);
  assert('return refunds as a credit note', rres.data?.refundMode === 'credit_note', `got ${rres.data?.refundMode}`);
  const CN_NUMBER = rres.data?.creditNoteNumber, CN_TOTAL = r2(rres.data?.totalAmount);

  // 1 — the credit note's postings live in the warehouse slice, not company.
  const [whSet, coSet] = await Promise.all([
    dayBookVouchers(D5, D5, locQ),
    dayBookVouchers(D5, D5, 'locationType=company'),
  ]);
  assert('credit note appears in the warehouse day-book slice', whSet.has(CN_NUMBER), `voucher ${CN_NUMBER} not in [${[...whSet].join(', ')}]`);
  assert('credit note absent from the company-level slice', !coSet.has(CN_NUMBER));

  // The warehouse TB slice stays internally balanced with the return in it.
  const whTb = await get(`/reports/fin/trial-balance?from=2000-01-01&to=${TODAY}&${locQ}`);
  assert('warehouse TB slice balanced with return postings', whTb.data?.balanced === true, `diff=${whTb.data?.difference}`);

  // 3 — as-of receivables: return_date (D5) governs, not created_at (today).
  const custRow = async (asOf) => {
    const res = await get(`/outstanding/receivables${asOf ? `?asOf=${asOf}` : ''}`);
    return (res.data?.customers ?? []).find((c) => Number(c.customerId) === Number(CUST)) ?? null;
  };
  const atD7 = await custRow(D7);
  assert('asOf BEFORE return date: full invoice outstanding', near(atD7?.netDue, TOTAL), `got ${atD7?.netDue} want ${TOTAL}`);
  const atD5 = await custRow(D5);
  const afterCN = r2(TOTAL - CN_TOTAL);
  if (afterCN > 0.009) {
    assert('asOf ON return date: credit note already effective (was the created_at bug)', near(atD5?.netDue, afterCN), `got ${atD5?.netDue} want ${afterCN}`);
  } else {
    assert('asOf ON return date: fully credited customer drops off (was the created_at bug)', atD5 === null, `still shows ${JSON.stringify(atD5)}`);
  }
  const now = await custRow(null);
  const nowDue = now === null ? 0 : r2(now.netDue);
  assert('undated position agrees with asOf=return-date-or-later', near(nowDue, afterCN), `got ${nowDue} want ${afterCN}`);

  // ══ 2. Walk-in cash sale + cash refund: payment stamped with the location
  console.log('\n— Cash-refund return: payment location stamp —');
  const s2 = await post('/sales', {
    outletId: WH, locationType: 'warehouse', locationId: WH, saleDate: D3,
    paymentMode: 'cash',
    lineItems: [{ itemId: ITEM, quantity: 1, unitPrice: PRICE, discount: 0, taxAmount: 0 }],
  });
  assert('walk-in cash sale created', s2.status === 201, `status ${s2.status} ${JSON.stringify(s2.data).slice(0, 200)}`);
  const r2res = await post('/sales-returns', {
    saleId: s2.data?.id, returnDate: D2, reason: `${TAG} cash refund`,
    lines: [{ lineIndex: 0, quantity: 1 }],
  });
  assert('cash return created', r2res.status === 201, `status ${r2res.status} ${JSON.stringify(r2res.data).slice(0, 300)}`);
  assert('return refunds as cash', r2res.data?.refundMode === 'cash', `got ${r2res.data?.refundMode}`);
  const PAY_ID = r2res.data?.refundPaymentId;

  const { rows: [payRow] } = await pool.query(`SELECT voucher_number, location_type, location_id FROM payments WHERE id = $1`, [PAY_ID]);
  assert('refund payment row stamped with the return location',
    payRow?.location_type === 'warehouse' && Number(payRow?.location_id) === WH,
    `got ${payRow?.location_type}:${payRow?.location_id}`);

  const [whSet2, hoSet2] = await Promise.all([
    dayBookVouchers(D2, D2, locQ),
    dayBookVouchers(D2, D2, 'locationType=headoffice'),
  ]);
  assert('refund payment appears in the warehouse day-book slice', whSet2.has(payRow?.voucher_number), `voucher ${payRow?.voucher_number} not in [${[...whSet2].join(', ')}]`);
  assert('refund payment absent from the Head Office slice (old fallback bug)', !hoSet2.has(payRow?.voucher_number));

  // ══ Consolidated books still reconcile with the new fixtures in place
  const cons = await get(`/reports/fin/trial-balance?from=2000-01-01&to=${TODAY}`);
  assert('consolidated TB still balanced', cons.data?.balanced === true, `diff=${cons.data?.difference}`);

  await pool.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) { console.error('Failures:'); for (const f of failures) console.error(' - ' + f); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
