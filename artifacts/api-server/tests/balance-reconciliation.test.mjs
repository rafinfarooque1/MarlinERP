/**
 * Balance architecture — reconciliation tests
 * Run: node artifacts/api-server/tests/balance-reconciliation.test.mjs
 *
 * Proves the one rule the balance rework is built on: for a posted transaction
 * the ledger is authoritative, and every screen that shows a "current balance"
 * must agree with it. Each test moves money one way and then checks EVERY
 * surface that claims to know the resulting balance — the party list, the party
 * ledger, the ageing report, the dashboard tile, and the Trial Balance.
 *
 * Runs against the DEVELOPMENT database the dev API server is using. It creates
 * clearly-marked ZZRECON fixtures and deletes every one of them at the end,
 * then asserts the Trial Balance is back to the totals it started with, so the
 * dev database is left exactly as it was found.
 */
import pg from 'pg';

const BASE = process.env.API_URL || 'http://localhost:8080/api';
const TAG = 'ZZRECON';
const TODAY = new Date().toISOString().slice(0, 10);

let authToken = '';
let passed = 0, failed = 0;
const failures = [];

function assert(label, condition, detail = '') {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; failures.push(`${label}${detail ? ' — ' + detail : ''}`); }
}

async function apiReq(method, path, body, token = authToken) {
  const opts = { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(`${BASE}${path}`, opts);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}
const post = (p, b, t) => apiReq('POST', p, b, t);
const get = (p, t) => apiReq('GET', p, undefined, t);
const del = (p, t) => apiReq('DELETE', p, undefined, t);

const r2 = (n) => Math.round(Number(n ?? 0) * 100) / 100;
const near = (a, b, tol = 0.02) => Math.abs(r2(a) - r2(b)) <= tol;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sql = (text, params) => pool.query(text, params);

// ── Ledger-tree helpers ──────────────────────────────────────────────────────
/**
 * Every ledger id under a root code, inclusive.
 *
 * Always re-read, never cached: creating a vendor or a customer provisions a new
 * party ledger under the control account, so a subtree snapshot taken before the
 * fixtures exist would silently omit exactly the ledger under test.
 */
async function subtreeIds(rootCode) {
  const { rows } = await sql(
    `WITH RECURSIVE t AS (
       SELECT id FROM account_ledgers WHERE code = $1
       UNION ALL SELECT a.id FROM account_ledgers a JOIN t ON a.parent_id = t.id
     ) SELECT id FROM t`, [rootCode]);
  return rows.map(r => Number(r.id));
}
const CREDITORS = () => subtreeIds('SYS-CREDITORS');
const DEBTORS = () => subtreeIds('SYS-DEBTORS');

/** The Trial Balance, plus helpers to read a subtree out of it. */
async function trialBalance() {
  const res = await get('/accounts/trial-balance');
  const rows = res.data?.rows ?? [];
  const byId = new Map(rows.map(r => [Number(r.ledgerId), r]));
  return {
    rows,
    totalDebit: r2(res.data?.totalDebit),
    totalCredit: r2(res.data?.totalCredit),
    balanced: !!res.data?.balanced,
    /** Net Dr−Cr across a set of ledger ids. */
    netOf: (ids) => r2(ids.reduce((s, id) => {
      const r = byId.get(Number(id));
      return s + (r ? Number(r.debit) - Number(r.credit) : 0);
    }, 0)),
  };
}

/** Sum of the income + expense ledgers — the P&L footprint. */
async function plFootprint() {
  const tb = await trialBalance();
  const { rows } = await sql(`SELECT id FROM account_ledgers WHERE type IN ('income','expense')`);
  return tb.netOf(rows.map(r => Number(r.id)));
}

// ── Balance surfaces ─────────────────────────────────────────────────────────
async function vendorSurfaces(vendorId) {
  const [list, ledger, payables, bi, tb, creditorIds] = await Promise.all([
    get('/vendors'), get(`/vendors/${vendorId}/ledger`), get('/outstanding/payables'), get('/dashboard/bi'), trialBalance(), CREDITORS(),
  ]);
  const row = (list.data ?? []).find(v => v.id === vendorId);
  const pay = (payables.data?.vendors ?? []).find(v => v.vendorId === vendorId);
  return {
    list: row ? r2(row.outstandingBalance) : null,
    ledger: r2(ledger.data?.balance),
    ageing: pay ? r2(pay.netDue) : 0,
    ageingControl: r2(payables.data?.totals?.netDue),
    dashboard: bi.data?.payables?.total == null ? null : r2(bi.data.payables.total),
    tbCreditors: r2(-tb.netOf(creditorIds)), // creditors sit on the credit side
  };
}

async function customerSurfaces(customerId) {
  const [list, ledger, recv, bi, tb, debtorIds] = await Promise.all([
    get('/customers'), get(`/customers/${customerId}/ledger`), get('/outstanding/receivables'), get('/dashboard/bi'), trialBalance(), DEBTORS(),
  ]);
  const row = (list.data ?? []).find(c => c.id === customerId);
  const rc = (recv.data?.customers ?? []).find(c => c.customerId === customerId);
  return {
    list: row ? r2(row.outstandingBalance) : null,
    ledger: r2(ledger.data?.balance),
    ageing: rc ? r2(rc.netDue) : 0,
    ageingControl: r2(recv.data?.totals?.netDue),
    dashboard: bi.data?.receivables?.total == null ? null : r2(bi.data.receivables.total),
    tbDebtors: r2(tb.netOf(debtorIds)),
  };
}

/** Every surface that reports cash or bank. */
async function moneySurfaces(cashIds, bankIds) {
  const [cio, bi, tb] = await Promise.all([get('/cash-in-outlet'), get('/dashboard/bi'), trialBalance()]);
  return {
    tills: r2((cio.data ?? []).reduce((s, l) => s + Number(l.cashBalance ?? 0), 0)),
    dashCash: bi.data?.cash?.balance == null ? null : r2(bi.data.cash.balance),
    dashBank: bi.data?.bank?.balance == null ? null : r2(bi.data.bank.balance),
    tbCash: tb.netOf(cashIds),
    tbBank: tb.netOf(bankIds),
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
const made = { purchases: [], jvs: [], receipts: [], payments: [] };
let fx = {};

async function cleanup() {
  for (const id of made.jvs) await del(`/accounts/journal-vouchers/${id}`).catch(() => {});
  for (const id of made.receipts) await del(`/accounts/receipts/${id}`).catch(() => {});
  for (const id of made.payments) await del(`/accounts/payments/${id}`).catch(() => {});
  for (const id of made.purchases) await del(`/purchases/${id}`).catch(() => {});
  made.jvs = []; made.receipts = []; made.payments = []; made.purchases = [];

  await sql(`DELETE FROM purchases WHERE vendor_id IN (SELECT id FROM vendors WHERE name LIKE $1)`, [`${TAG}%`]);
  const { rows: mats } = await sql(`SELECT id FROM materials WHERE name LIKE $1`, [`${TAG}%`]);
  const matIds = mats.map(m => m.id);
  if (matIds.length) {
    await sql(`DELETE FROM stock_batches WHERE item_id = ANY($1::int[]) AND material_type = 'material'`, [matIds]);
    await sql(`DELETE FROM stock_entries WHERE item_id = ANY($1::int[]) AND material_type = 'material'`, [matIds]);
    await sql(`DELETE FROM stock_ledger WHERE item_id = ANY($1::int[]) AND material_type = 'material'`, [matIds]).catch(() => {});
  }
  await sql(`DELETE FROM materials WHERE name LIKE $1`, [`${TAG}%`]);
  // Ledgers last, so no posting is ever left pointing at a ledger that is gone.
  await sql(`DELETE FROM account_ledgers WHERE name LIKE $1 AND code LIKE 'VEND-%'`, [`${TAG}%`]);
  await sql(`DELETE FROM vendors WHERE name LIKE $1`, [`${TAG}%`]);
}

// ── Run ──────────────────────────────────────────────────────────────────────
try {
  authToken = (await post('/auth/login', { username: 'admin', password: 'marlin1458' })).data?.token ?? '';
  if (!authToken) throw new Error('admin login failed');

  await cleanup(); // in case a previous run died mid-way

  const creditorIds = await subtreeIds('SYS-CREDITORS');
  const debtorIds = await subtreeIds('SYS-DEBTORS');
  const cashIds = await subtreeIds('STD-CASH');
  const bankIds = await subtreeIds('STD-BANK');
  assert('Chart roots resolve', creditorIds.length > 0 && debtorIds.length > 0 && cashIds.length > 0 && bankIds.length > 0,
    `creditors=${creditorIds.length} debtors=${debtorIds.length} cash=${cashIds.length} bank=${bankIds.length}`);

  // A non-cash, non-party ledger for the far side of the adjusting journals.
  // It must be a LEAF: the API refuses a posting to a group ledger.
  const { rows: [adjRow] } = await sql(
    `SELECT l.id, l.name FROM account_ledgers l
      WHERE l.type = 'expense'
        AND NOT EXISTS (SELECT 1 FROM account_ledgers ch WHERE ch.parent_id = l.id)
        AND l.id <> ALL($1::int[]) AND l.id <> ALL($2::int[])
      ORDER BY l.id LIMIT 1`, [cashIds.concat(bankIds), creditorIds.concat(debtorIds)]);
  fx.adjLedger = Number(adjRow.id);
  assert('Adjusting ledger is a postable leaf', !!fx.adjLedger, `picked ${adjRow?.name}`);
  // A real bank leaf and a real cash till to move money through.
  fx.bankLeaf = Number((await sql(`SELECT id FROM account_ledgers WHERE code = 'STD-BANK'`)).rows[0].id);
  fx.cashLeaf = Number((await sql(`SELECT id FROM account_ledgers WHERE code = 'STD-CASH'`)).rows[0].id);

  const tb0 = await trialBalance();
  console.log(`\nBaseline trial balance: Dr ${tb0.totalDebit} / Cr ${tb0.totalCredit} (balanced=${tb0.balanced})`);

  // Fixtures: a vendor (API-created so its ledger is provisioned) and a zero-GST
  // material, so a bill's total is exactly its taxable value and the payable is
  // an exact round number.
  const vres = await post('/vendors', { name: `${TAG} Frozen Hub`, phone: '9000000001', state: 'Karnataka' });
  fx.vendorId = vres.data?.id;
  assert('Fixture vendor created with a ledger', !!fx.vendorId && vres.status === 201, `status ${vres.status}`);
  fx.materialId = (await sql(
    `INSERT INTO materials (name, unit, hsn_code, tax_rate, item_code, barcode, status, current_stock)
     VALUES ($1,'KG','08119090',0,'RM-ZZRECON-01','2900000000916','active',0) RETURNING id`, [`${TAG} Berry`])).rows[0].id;
  fx.warehouseId = Number((await sql(`SELECT id FROM warehouses ORDER BY id LIMIT 1`)).rows[0].id);

  // ══ TEST A — a purchase raises the payable on every surface ═══════════════
  console.log('\n── A. Vendor: purchase ──');
  const AMT = 633194;
  const pres = await post('/purchases', {
    vendorId: fx.vendorId, purchaseDate: TODAY, locationType: 'warehouse', locationId: fx.warehouseId,
    lineItems: [{ materialType: 'material', materialId: fx.materialId, quantity: 1, unitCost: AMT, mfgDate: '2026-01-01', expiryDate: '2027-01-01' }],
  });
  assert('Purchase bill created', pres.status === 201, `status ${pres.status} ${JSON.stringify(pres.data).slice(0, 200)}`);
  made.purchases.push(pres.data?.id);

  const apA = await vendorSurfaces(fx.vendorId);
  const tbA = await trialBalance();
  assert('A — vendor list shows the payable', near(apA.list, AMT), `got ${apA.list}`);
  assert('A — vendor ledger shows the payable', near(apA.ledger, AMT), `got ${apA.ledger}`);
  assert('A — payables ageing shows the payable', near(apA.ageing, AMT), `got ${apA.ageing}`);
  assert('A — Sundry Creditors rose by the payable', near(apA.tbCreditors - -tb0.netOf(creditorIds), AMT),
    `delta ${r2(apA.tbCreditors - -tb0.netOf(creditorIds))}`);
  assert('A — trial balance still balances', tbA.balanced, `Dr ${tbA.totalDebit} Cr ${tbA.totalCredit}`);

  // ══ TEST B — a payment reduces it ═════════════════════════════════════════
  console.log('\n── B. Vendor: purchase + payment ──');
  const PAY = 133194;
  const vendLedgerId = Number((await sql(`SELECT id FROM account_ledgers WHERE code = $1`, [`VEND-${fx.vendorId}`])).rows[0].id);
  const payRes = await post('/accounts/payments', {
    paymentDate: TODAY, paidFromLedgerId: fx.bankLeaf, paidToLedgerId: vendLedgerId, amount: PAY, narration: `${TAG} part payment`,
  });
  assert('Payment voucher created', payRes.status === 201, `status ${payRes.status} ${JSON.stringify(payRes.data).slice(0, 200)}`);
  made.payments.push(payRes.data?.id);

  const apB = await vendorSurfaces(fx.vendorId);
  assert('B — vendor list net of the payment', near(apB.list, AMT - PAY), `got ${apB.list}`);
  assert('B — vendor ledger net of the payment', near(apB.ledger, AMT - PAY), `got ${apB.ledger}`);
  assert('B — payables ageing net of the payment', near(apB.ageing, AMT - PAY), `got ${apB.ageing}`);
  assert('B — every vendor surface agrees', near(apB.list, apB.ledger) && near(apB.ledger, apB.ageing),
    `list ${apB.list} ledger ${apB.ledger} ageing ${apB.ageing}`);

  // ══ TEST C / §13 — a journal clears the rest (the Frozen Hub regression) ══
  console.log('\n── C. Vendor: purchase + payment + journal (§13 Frozen Hub) ──');
  const jvRes = await post('/accounts/journal-vouchers', {
    voucherType: 'journal', voucherDate: TODAY, narration: `${TAG} settle payable by journal`,
    lines: [
      { ledgerId: vendLedgerId, debit: AMT - PAY, credit: 0 },
      { ledgerId: fx.adjLedger, debit: 0, credit: AMT - PAY },
    ],
  });
  assert('Journal voucher created', jvRes.status === 201, `status ${jvRes.status} ${JSON.stringify(jvRes.data).slice(0, 200)}`);
  made.jvs.push(jvRes.data?.id);

  const apC = await vendorSurfaces(fx.vendorId);
  assert('C/§13 — vendor LIST shows ₹0 (was the bug)', near(apC.list, 0), `got ${apC.list}`);
  assert('C/§13 — vendor ledger shows ₹0', near(apC.ledger, 0), `got ${apC.ledger}`);
  assert('C/§13 — payables ageing shows ₹0', near(apC.ageing, 0), `got ${apC.ageing}`);
  assert('C/§13 — Sundry Creditors back to baseline', near(apC.tbCreditors, -tb0.netOf(creditorIds)),
    `got ${apC.tbCreditors} baseline ${r2(-tb0.netOf(creditorIds))}`);
  const jvStillThere = await get(`/accounts/journal-vouchers`);
  assert('C/§13 — the journal and the bill are both untouched',
    (jvStillThere.data ?? []).some(v => v.id === jvRes.data?.id) && (await get(`/purchases/${pres.data?.id}`)).status === 200);

  // ══ TESTS D–F — customer: sale / +receipt / +journal ══════════════════════
  console.log('\n── D–F. Customer: sale, receipt, journal ──');
  const { rows: [custRow] } = await sql(
    `SELECT c.id FROM customers c JOIN sales s ON s.customer_id = c.id
      WHERE s.branch_transfer_id IS NULL GROUP BY c.id ORDER BY c.id LIMIT 1`);
  fx.customerId = Number(custRow.id);
  const custLedgerId = Number((await sql(`SELECT id FROM account_ledgers WHERE code = $1`, [`CUST-${fx.customerId}`])).rows[0].id);

  const arD = await customerSurfaces(fx.customerId);
  assert('D — sale: customer list = ledger', near(arD.list, arD.ledger), `list ${arD.list} ledger ${arD.ledger}`);
  assert('D — sale: ageing control = Sundry Debtors', near(arD.ageingControl, arD.tbDebtors),
    `ageing ${arD.ageingControl} TB ${arD.tbDebtors}`);
  assert('D — sale: dashboard AR = Sundry Debtors', near(arD.dashboard, arD.tbDebtors),
    `dash ${arD.dashboard} TB ${arD.tbDebtors}`);

  const RCPT = 700;
  const rcptRes = await post('/accounts/receipts', {
    receiptDate: TODAY, receivedFromLedgerId: custLedgerId, receivedInLedgerId: fx.bankLeaf, amount: RCPT, narration: `${TAG} collection`,
  });
  assert('Receipt voucher created', rcptRes.status === 201, `status ${rcptRes.status} ${JSON.stringify(rcptRes.data).slice(0, 200)}`);
  made.receipts.push(rcptRes.data?.id);

  const arE = await customerSurfaces(fx.customerId);
  assert('E — receipt reduced the customer list balance', near(arE.list, arD.list - RCPT), `got ${arE.list} expected ${r2(arD.list - RCPT)}`);
  assert('E — receipt reduced the ledger', near(arE.ledger, arD.ledger - RCPT), `got ${arE.ledger}`);
  assert('E — receipt reduced the ageing control', near(arE.ageingControl, arD.ageingControl - RCPT), `got ${arE.ageingControl}`);
  assert('E — receipt reduced Sundry Debtors', near(arE.tbDebtors, arD.tbDebtors - RCPT), `got ${arE.tbDebtors}`);
  assert('E — list still equals ledger', near(arE.list, arE.ledger), `list ${arE.list} ledger ${arE.ledger}`);

  const CJV = 300;
  const cjvRes = await post('/accounts/journal-vouchers', {
    voucherType: 'journal', voucherDate: TODAY, narration: `${TAG} customer adjustment`,
    lines: [{ ledgerId: fx.adjLedger, debit: CJV, credit: 0 }, { ledgerId: custLedgerId, debit: 0, credit: CJV }],
  });
  assert('Customer journal created', cjvRes.status === 201, `status ${cjvRes.status}`);
  made.jvs.push(cjvRes.data?.id);

  const arF = await customerSurfaces(fx.customerId);
  assert('F — journal reduced the customer LIST balance', near(arF.list, arE.list - CJV), `got ${arF.list} expected ${r2(arE.list - CJV)}`);
  assert('F — journal reduced the ageing control', near(arF.ageingControl, arE.ageingControl - CJV), `got ${arF.ageingControl}`);
  assert('F — journal reduced Sundry Debtors', near(arF.tbDebtors, arE.tbDebtors - CJV), `got ${arF.tbDebtors}`);
  assert('F — every customer surface agrees', near(arF.list, arF.ledger) && near(arF.ageingControl, arF.tbDebtors),
    `list ${arF.list} ledger ${arF.ledger} ageing ${arF.ageingControl} TB ${arF.tbDebtors}`);

  // ══ TESTS G–I — cash receipt / cash payment / bank ════════════════════════
  console.log('\n── G–I. Cash and bank vouchers ──');
  const m0 = await moneySurfaces(cashIds, bankIds);
  assert('G0 — dashboard cash balance = Trial Balance cash', near(m0.dashCash, m0.tbCash), `dash ${m0.dashCash} TB ${m0.tbCash}`);
  assert('G0 — dashboard bank balance = Trial Balance bank', near(m0.dashBank, m0.tbBank), `dash ${m0.dashBank} TB ${m0.tbBank}`);

  const CASH_IN = 2500;
  const cin = await post('/accounts/receipts', {
    receiptDate: TODAY, receivedFromLedgerId: fx.adjLedger, receivedInLedgerId: fx.cashLeaf, amount: CASH_IN, narration: `${TAG} cash receipt`,
  });
  assert('Cash receipt created', cin.status === 201, `status ${cin.status} ${JSON.stringify(cin.data).slice(0, 200)}`);
  made.receipts.push(cin.data?.id);
  const mG = await moneySurfaces(cashIds, bankIds);
  assert('G — cash receipt raised Trial Balance cash', near(mG.tbCash, m0.tbCash + CASH_IN), `got ${mG.tbCash}`);
  assert('G — cash receipt raised the dashboard cash balance', near(mG.dashCash, m0.dashCash + CASH_IN), `got ${mG.dashCash}`);
  assert('G — dashboard cash still equals the Trial Balance', near(mG.dashCash, mG.tbCash), `dash ${mG.dashCash} TB ${mG.tbCash}`);

  const CASH_OUT = 900;
  const cout = await post('/accounts/payments', {
    paymentDate: TODAY, paidFromLedgerId: fx.cashLeaf, paidToLedgerId: fx.adjLedger, amount: CASH_OUT, narration: `${TAG} cash payment`,
  });
  assert('Cash payment created', cout.status === 201, `status ${cout.status}`);
  made.payments.push(cout.data?.id);
  const mH = await moneySurfaces(cashIds, bankIds);
  assert('H — cash payment lowered Trial Balance cash', near(mH.tbCash, mG.tbCash - CASH_OUT), `got ${mH.tbCash}`);
  assert('H — cash payment lowered the dashboard cash balance', near(mH.dashCash, mG.dashCash - CASH_OUT), `got ${mH.dashCash}`);

  const BANK_IN = 4000;
  const bin = await post('/accounts/receipts', {
    receiptDate: TODAY, receivedFromLedgerId: fx.adjLedger, receivedInLedgerId: fx.bankLeaf, amount: BANK_IN, narration: `${TAG} bank receipt`,
  });
  assert('Bank receipt created', bin.status === 201, `status ${bin.status}`);
  made.receipts.push(bin.data?.id);
  const mI = await moneySurfaces(cashIds, bankIds);
  assert('I — bank receipt raised Trial Balance bank', near(mI.tbBank, mH.tbBank + BANK_IN), `got ${mI.tbBank}`);
  assert('I — bank receipt raised the dashboard bank balance', near(mI.dashBank, mH.dashBank + BANK_IN), `got ${mI.dashBank}`);
  assert('I — the bank receipt left cash alone', near(mI.tbCash, mH.tbCash), `cash ${mI.tbCash} was ${mH.tbCash}`);

  // ══ TEST J — contra Dr Bank / Cr Cash ═════════════════════════════════════
  console.log('\n── J. Contra: Dr Bank / Cr Cash ──');
  const pl0 = await plFootprint();
  const CONTRA = 1200;
  const contra = await post('/accounts/journal-vouchers', {
    voucherType: 'contra', voucherDate: TODAY, fromLedgerId: fx.cashLeaf, toLedgerId: fx.bankLeaf,
    amount: CONTRA, narration: `${TAG} cash deposited to bank`,
  });
  assert('Contra voucher created', contra.status === 201, `status ${contra.status} ${JSON.stringify(contra.data).slice(0, 200)}`);
  made.jvs.push(contra.data?.id);
  const mJ = await moneySurfaces(cashIds, bankIds);
  const plJ = await plFootprint();
  assert('J — contra lowered cash', near(mJ.tbCash, mI.tbCash - CONTRA), `got ${mJ.tbCash} expected ${r2(mI.tbCash - CONTRA)}`);
  assert('J — contra raised bank by the same amount', near(mJ.tbBank, mI.tbBank + CONTRA), `got ${mJ.tbBank}`);
  assert('J — the dashboard cash card moved with it', near(mJ.dashCash, mJ.tbCash), `dash ${mJ.dashCash} TB ${mJ.tbCash}`);
  assert('J — the dashboard bank card moved with it', near(mJ.dashBank, mJ.tbBank), `dash ${mJ.dashBank} TB ${mJ.tbBank}`);
  assert('J — contra touched NO income or expense account', near(plJ, pl0), `P&L ${plJ} was ${pl0}`);

  // ══ TEST K — a journal that moves cash and bank ═══════════════════════════
  console.log('\n── K. Journal affecting cash and bank ──');
  const KAMT = 550;
  const kjv = await post('/accounts/journal-vouchers', {
    voucherType: 'journal', voucherDate: TODAY, narration: `${TAG} journal into cash`,
    lines: [{ ledgerId: fx.cashLeaf, debit: KAMT, credit: 0 }, { ledgerId: fx.bankLeaf, debit: 0, credit: KAMT }],
  });
  assert('Cash/bank journal created', kjv.status === 201, `status ${kjv.status}`);
  made.jvs.push(kjv.data?.id);
  const mK = await moneySurfaces(cashIds, bankIds);
  assert('K — journal raised cash', near(mK.tbCash, mJ.tbCash + KAMT), `got ${mK.tbCash}`);
  assert('K — journal lowered bank', near(mK.tbBank, mJ.tbBank - KAMT), `got ${mK.tbBank}`);
  assert('K — the dashboard cash card saw the journal', near(mK.dashCash, mK.tbCash), `dash ${mK.dashCash} TB ${mK.tbCash}`);
  assert('K — the dashboard bank card saw the journal', near(mK.dashBank, mK.tbBank), `dash ${mK.dashBank} TB ${mK.tbBank}`);

  // ══ §14 — whole-system reconciliation ═════════════════════════════════════
  console.log('\n── §14. Whole-system reconciliation ──');
  const [vlist, clist, pay, recv, bi, tbF] = await Promise.all([
    get('/vendors'), get('/customers'), get('/outstanding/payables'), get('/outstanding/receivables'), get('/dashboard/bi'), trialBalance(),
  ]);
  const vSum = r2((vlist.data ?? []).reduce((s, v) => s + Number(v.outstandingBalance ?? 0), 0));
  const cSum = r2((clist.data ?? []).reduce((s, c) => s + Number(c.outstandingBalance ?? 0), 0));
  const tbCreditors = r2(-tbF.netOf(await CREDITORS()));
  const tbDebtors = r2(tbF.netOf(await DEBTORS()));
  assert('§14 — Σ vendor list balances = payables control', near(vSum, pay.data?.totals?.netDue), `Σ ${vSum} control ${r2(pay.data?.totals?.netDue)}`);
  assert('§14 — payables control = Sundry Creditors', near(pay.data?.totals?.netDue, tbCreditors), `control ${r2(pay.data?.totals?.netDue)} TB ${tbCreditors}`);
  assert('§14 — dashboard AP = Sundry Creditors', near(bi.data?.payables?.total, tbCreditors), `dash ${r2(bi.data?.payables?.total)} TB ${tbCreditors}`);
  assert('§14 — Σ customer list balances = receivables control', near(cSum, recv.data?.totals?.netDue), `Σ ${cSum} control ${r2(recv.data?.totals?.netDue)}`);
  assert('§14 — receivables control = Sundry Debtors', near(recv.data?.totals?.netDue, tbDebtors), `control ${r2(recv.data?.totals?.netDue)} TB ${tbDebtors}`);
  assert('§14 — dashboard AR = Sundry Debtors', near(bi.data?.receivables?.total, tbDebtors), `dash ${r2(bi.data?.receivables?.total)} TB ${tbDebtors}`);
  const mF = await moneySurfaces(cashIds, bankIds);
  assert('§14 — dashboard cash = Trial Balance cash', near(mF.dashCash, mF.tbCash), `dash ${mF.dashCash} TB ${mF.tbCash}`);
  assert('§14 — dashboard bank = Trial Balance bank', near(mF.dashBank, mF.tbBank), `dash ${mF.dashBank} TB ${mF.tbBank}`);
  assert('§14 — trial balance balances', tbF.balanced, `Dr ${tbF.totalDebit} Cr ${tbF.totalCredit}`);

  // ══ Cleanup and prove the database was left as found ══════════════════════
  console.log('\n── Cleanup ──');
  await cleanup();
  const tbEnd = await trialBalance();
  assert('Cleanup — trial balance back to baseline Dr', near(tbEnd.totalDebit, tb0.totalDebit), `${tbEnd.totalDebit} vs ${tb0.totalDebit}`);
  assert('Cleanup — trial balance back to baseline Cr', near(tbEnd.totalCredit, tb0.totalCredit), `${tbEnd.totalCredit} vs ${tb0.totalCredit}`);
  assert('Cleanup — no ZZRECON vendor left', (await sql(`SELECT count(*)::int n FROM vendors WHERE name LIKE $1`, [`${TAG}%`])).rows[0].n === 0);
  assert('Cleanup — no ZZRECON ledger left', (await sql(`SELECT count(*)::int n FROM account_ledgers WHERE name LIKE $1`, [`${TAG}%`])).rows[0].n === 0);
} catch (err) {
  console.error('\nFATAL:', err?.stack || err);
  failed++; failures.push(`FATAL ${err?.message || err}`);
  await cleanup().catch(() => {});
} finally {
  console.log(`\n${'='.repeat(72)}\n${passed} passed, ${failed} failed`);
  if (failures.length) { console.log('Failures:'); failures.forEach(f => console.log(`  ✗ ${f}`)); }
  await pool.end();
  process.exit(failed ? 1 : 0);
}
