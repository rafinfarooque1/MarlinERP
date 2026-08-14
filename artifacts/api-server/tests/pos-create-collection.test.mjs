/**
 * POS creation-time collection — payment methods from the location's Cash &
 * Bank set, partial/overpayment at billing, create idempotency, and the
 * customer price-history endpoint.
 *
 * Contracts under test:
 *   1. POST /sales with receivedInLedgerId (an account ASSIGNED to the selling
 *      location) records the money through the ONE receipt/settlement engine:
 *      a clearing receipt for the collected amount + a receipt-backed
 *      sale_payments row; the stored payment mode is DERIVED from the account
 *      (cash till → cash, bank account → bank/upi), never from the client.
 *   2. An account NOT assigned to the location is refused; credit +
 *      receivedInLedgerId is contradictory and refused.
 *   3. amountReceived < total needs a registered customer: the sale lands as
 *      partially_paid with the remainder due, and the EXISTING collect path
 *      settles it. A walk-in partial is refused (PARTIAL_REQUIRES_CUSTOMER).
 *   4. amountReceived > total is refused with EXCEEDS_OUTSTANDING unless
 *      allowOverpayment is sent; the excess lands as the customer's advance
 *      (negative-Sundry-Debtor model). Walk-ins are refused even WITH consent.
 *   5. Create replay (same clientRequestId) returns the ORIGINAL invoice and
 *      never doubles the collected money.
 *   6. GET /sales/price-history returns the customer's recent unit prices for
 *      an item (newest first, limit capped, cancelled sales excluded) and
 *      validates its params.
 *   7. The trial balance ends exactly where it started (self-cleaning).
 *
 * Disposable fixtures only — level-1 probe user created directly in the DB
 * (never 'admin'), fixed probe customer, all sales unwound at exit.
 */
import pg from "pg";
import bcrypt from "bcryptjs";

const BASE = "http://localhost:8080/api";
const sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (text, params = []) => (await sql.query(text, params)).rows;

const USER = "pos_createcollect_probe";
const PASS = "Probe#Create1";
let authToken = "";
let passed = 0, failed = 0;

function assert(label, cond, detail = "") {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? " — " + detail : ""}`); failed++; }
}

async function apiReq(method, path, body) {
  const opts = { method, headers: { "Content-Type": "application/json", ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(`${BASE}${path}`, opts);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}
const post = (p, b) => apiReq("POST", p, b);
const get = (p) => apiReq("GET", p);
const del = (p) => apiReq("DELETE", p);
const round2 = (n) => Math.round(n * 100) / 100;
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) < eps;

async function snapshotTB() {
  const res = await get("/accounts/trial-balance");
  const rows = res.data?.rows ?? [];
  return {
    totalDr: round2(rows.reduce((s, r) => s + Number(r.debit ?? 0), 0)),
    totalCr: round2(rows.reduce((s, r) => s + Number(r.credit ?? 0), 0)),
  };
}
async function saleDbRow(id) {
  const rows = await q(
    `SELECT invoice_number, payment_mode, payment_status,
            amount_paid::numeric AS amount_paid, total_amount::numeric AS total
       FROM sales WHERE id = $1`, [id]);
  return rows[0];
}
async function salePaymentsOf(id) {
  return q(
    `SELECT id, amount::numeric AS amount, clearing_receipt_id, source
       FROM sale_payments WHERE sale_id = $1 ORDER BY id`, [id]);
}

// Unwind every collection recorded against a sale (system-delete its clearing
// receipts, level-1 path), then cancel the bill. Leaves zero trace in books.
async function unwindSale(saleId) {
  if (!saleId) return;
  const receipts = await q(
    `SELECT DISTINCT clearing_receipt_id AS id FROM sale_payments
      WHERE sale_id = $1 AND clearing_receipt_id IS NOT NULL`, [saleId]);
  for (const r of receipts) {
    const dr = await post(`/accounts/receipts/${r.id}/system-delete`, { reason: "Automated test cleanup — POS create-collection suite fixture unwind" });
    if (dr.status !== 200) console.error(`  (cleanup) receipt ${r.id} system-delete → ${dr.status} ${JSON.stringify(dr.data).slice(0, 150)}`);
  }
  const c = await post(`/sales/${saleId}/cancel`, {});
  if (c.status !== 200) console.error(`  (cleanup) sale ${saleId} cancel → ${c.status} ${JSON.stringify(c.data).slice(0, 150)}`);
}

async function setupUser() {
  await teardownUser();
  const hash = bcrypt.hashSync(PASS, 10);
  await q(
    `INSERT INTO employees (name, username, password_hash, hierarchy_id, branch_type, branch_id, salary, join_date, is_active, must_change_password)
     SELECT 'POS CreateCollect Probe', $1, $2, (SELECT MIN(id) FROM hierarchies), 'headoffice', 1, 1, CURRENT_DATE, true, false`,
    [USER, hash]);
}
async function teardownUser() {
  await q(`DELETE FROM login_lockouts WHERE username = $1`, [USER]);
  await q(`DELETE FROM login_attempts WHERE username = $1`, [USER]);
  await q(`DELETE FROM employees WHERE username = $1`, [USER]);
}

const uuid = () => crypto.randomUUID();

await setupUser();
let tempCustomerId = null;
const saleIds = [];
let tb0 = null;
try {
  // ── [0] Auth + derived fixtures ───────────────────────────────────────────
  console.log("\n[0] Authentication and derived fixtures");
  const loginRes = await post("/auth/login", { username: USER, password: PASS });
  authToken = loginRes.data?.token ?? "";
  assert("Probe user logs in", !!authToken, `status=${loginRes.status}`);
  if (!authToken) process.exit(1);

  const [itemsRes, warehousesRes, vlocsRes, cbRes] = await Promise.all([
    get("/items"), get("/warehouses"), get("/accounts/voucher-locations"), get("/accounts/cash-bank-ledgers"),
  ]);
  const items = itemsRes.data ?? [];
  const taxableItem = items.find(i => Number(i.taxRate) > 0);
  const cbLedgers = cbRes.data ?? [];
  const cbById = new Map(cbLedgers.map(l => [Number(l.id), l]));

  // Pick a warehouse that HAS assigned Cash & Bank accounts (the new payment
  // method source) — the location-config-driven contract under test.
  let warehouse = null, locAccounts = [];
  for (const w of warehousesRes.data ?? []) {
    const loc = (vlocsRes.data?.locations ?? []).find(l => l.locationType === "warehouse" && Number(l.locationId) === Number(w.id));
    const ids = (loc?.cashBankLedgerIds ?? []).map(Number).filter(id => cbById.has(id));
    if (ids.length) { warehouse = w; locAccounts = ids.map(id => cbById.get(id)); break; }
  }
  if (!taxableItem || !warehouse) { console.error("FATAL: need a taxable item and a warehouse with assigned Cash & Bank accounts."); process.exit(1); }
  const cashAcct = locAccounts.find(a => (a.accountType ?? "") === "cash" || String(a.code ?? "").toUpperCase().includes("CASH"));
  const bankAcct = locAccounts.find(a => a !== cashAcct);
  assert("Warehouse has a cash account assigned", !!cashAcct, JSON.stringify(locAccounts).slice(0, 200));
  console.log(`  (warehouse ${warehouse.id}, cash=${cashAcct?.id}, bank/upi=${bankAcct?.id ?? "none"})`);

  // An account assigned to some OTHER location (or plainly unassigned) — must
  // be refused for this warehouse.
  const foreignAcct = cbLedgers.find(l => !locAccounts.some(a => Number(a.id) === Number(l.id)));

  const unitPrice = Math.max(100, Number(taxableItem.mrp ?? 0));
  const today = new Date().toISOString().slice(0, 10);
  const saleBody = (mode, customerId, extra = {}) => ({
    outletId: warehouse.id, locationType: "warehouse", locationId: warehouse.id,
    saleDate: today, paymentMode: mode,
    ...(customerId ? { customerId } : {}),
    lineItems: [{ itemId: taxableItem.id, quantity: 1, unitPrice, discount: 0, taxAmount: 0 }],
    ...extra,
  });

  const PROBE_CUSTOMER = "ZZ CreateCollect Probe (fixture)";
  const existing = await q(`SELECT id FROM customers WHERE name = $1`, [PROBE_CUSTOMER]);
  if (existing[0]?.id) tempCustomerId = existing[0].id;
  else {
    const cr = await post("/customers", { name: PROBE_CUSTOMER, creditLimit: 1000000 });
    tempCustomerId = cr.data?.id ?? null;
  }
  assert("Probe customer ready", !!tempCustomerId);

  tb0 = await snapshotTB();

  // ── [1] Walk-in full payment into the location's cash till ───────────────
  console.log("\n[1] Walk-in full payment through the location's cash account");
  const k1 = uuid();
  const r1 = await post("/sales", saleBody("cash", null, { receivedInLedgerId: cashAcct.id, clientRequestId: k1 }));
  assert("Sale accepted (201)", r1.status === 201 && r1.data?.id, `status=${r1.status} ${JSON.stringify(r1.data).slice(0, 200)}`);
  if (r1.data?.id) saleIds.push(r1.data.id);
  const row1 = await saleDbRow(r1.data.id);
  assert("Stored mode derived from the CASH account", row1.payment_mode === "cash", `mode=${row1.payment_mode}`);
  assert("Sale reads paid in full", row1.payment_status === "paid" && near(row1.amount_paid, row1.total), `status=${row1.payment_status} paid=${row1.amount_paid}/${row1.total}`);
  const pays1 = await salePaymentsOf(r1.data.id);
  assert("ONE receipt-backed sale_payments row", pays1.length === 1 && !!pays1[0].clearing_receipt_id, JSON.stringify(pays1));
  const rec1 = await q(`SELECT amount::numeric AS amount, location_type, location_id FROM receipts WHERE id = $1`, [pays1[0]?.clearing_receipt_id]);
  assert("Clearing receipt carries the FULL total", rec1[0] && near(rec1[0].amount, row1.total), `amount=${rec1[0]?.amount}`);
  assert("Receipt stamped to the selling warehouse", rec1[0] && rec1[0].location_type === "warehouse" && Number(rec1[0].location_id) === Number(warehouse.id), JSON.stringify(rec1[0]));
  assert("amount_paid = Σ sale_payments (books invariant)", near(row1.amount_paid, pays1.reduce((s, p) => s + Number(p.amount), 0)));

  // ── [2] Create replay never doubles the money ─────────────────────────────
  console.log("\n[2] Create replay (same clientRequestId)");
  const r1b = await post("/sales", saleBody("cash", null, { receivedInLedgerId: cashAcct.id, clientRequestId: k1 }));
  assert("Replay answers 200, not 201", r1b.status === 200, `status=${r1b.status}`);
  assert("Replay returns the SAME invoice", r1b.data?.id === r1.data?.id, `first=${r1.data?.id} replay=${r1b.data?.id}`);
  const pays1b = await salePaymentsOf(r1.data.id);
  const row1b = await saleDbRow(r1.data.id);
  assert("Collected money NOT doubled", pays1b.length === 1 && near(row1b.amount_paid, row1.amount_paid), `rows=${pays1b.length} paid=${row1b.amount_paid}`);

  // ── [3] Bank/UPI account → derived non-cash mode ─────────────────────────
  console.log("\n[3] Bank/UPI account: mode derived from the account");
  if (bankAcct) {
    const r3 = await post("/sales", saleBody("cash", null, { receivedInLedgerId: bankAcct.id, referenceNumber: "UTR-ZZTEST-1", clientRequestId: uuid() }));
    assert("Sale via bank/UPI account accepted", r3.status === 201, `status=${r3.status} ${JSON.stringify(r3.data).slice(0, 200)}`);
    if (r3.data?.id) {
      saleIds.push(r3.data.id);
      const row3 = await saleDbRow(r3.data.id);
      assert("Stored mode is bank/upi (from the account), not the client's word", ["bank", "upi"].includes(row3.payment_mode), `mode=${row3.payment_mode}`);
      assert("Paid in full through the receipt engine", row3.payment_status === "paid", `status=${row3.payment_status}`);
    }
  } else console.log("  (location has no non-cash account assigned — skipped)");

  // ── [4] Foreign account + credit-with-ledger refused ─────────────────────
  console.log("\n[4] Account validation");
  if (foreignAcct) {
    const rf = await post("/sales", saleBody("cash", null, { receivedInLedgerId: foreignAcct.id, clientRequestId: uuid() }));
    assert("Account not assigned to the location refused (400)", rf.status === 400, `status=${rf.status} ${JSON.stringify(rf.data).slice(0, 150)}`);
    if (rf.status === 201 && rf.data?.id) saleIds.push(rf.data.id);
  } else console.log("  (every cash/bank ledger is assigned to this location — foreign-account check skipped)");
  const rc = await post("/sales", saleBody("credit", tempCustomerId, { receivedInLedgerId: cashAcct.id, clientRequestId: uuid() }));
  assert("Credit + receivedInLedgerId refused (400)", rc.status === 400, `status=${rc.status} ${JSON.stringify(rc.data).slice(0, 150)}`);
  if (rc.status === 201 && rc.data?.id) saleIds.push(rc.data.id);

  // ── [5] Partial at billing: customer OK, walk-in refused ─────────────────
  console.log("\n[5] Partial payment at billing");
  const probeTotalRes = await post("/sales", saleBody("credit", tempCustomerId, { clientRequestId: uuid() }));
  assert("Reference credit sale for total lands", probeTotalRes.status === 201, `status=${probeTotalRes.status}`);
  if (probeTotalRes.data?.id) saleIds.push(probeTotalRes.data.id);
  const fullTotal = Number(probeTotalRes.data?.totalAmount ?? 0);
  // 40/60 split — equal halves would trip the server's 10-second duplicate
  // heuristic (same sale + method + amount) when the collect follows at once.
  const part = round2(fullTotal * 0.4);

  const r5 = await post("/sales", saleBody("cash", tempCustomerId, { receivedInLedgerId: cashAcct.id, amountReceived: part, clientRequestId: uuid() }));
  assert("Customer partial accepted (201)", r5.status === 201, `status=${r5.status} ${JSON.stringify(r5.data).slice(0, 200)}`);
  if (r5.data?.id) saleIds.push(r5.data.id);
  const row5 = await saleDbRow(r5.data.id);
  assert("Sale reads partially_paid", row5.payment_status === "partially_paid", `status=${row5.payment_status}`);
  assert("Paid figure = the partial amount", near(row5.amount_paid, part), `paid=${row5.amount_paid} expected=${part}`);
  assert("Partial sale is credit-controlled (stored mode credit)", row5.payment_mode === "credit", `mode=${row5.payment_mode}`);
  // The EXISTING collect path settles the remainder — one payment engine.
  const settle = await post(`/sales/${r5.data.id}/payments`, { receivedInLedgerId: cashAcct.id, amount: round2(fullTotal - part), paymentDate: today, clientRequestId: uuid() });
  assert("Existing collect path settles the remainder", settle.status === 201 && settle.data?.newPaymentStatus === "paid", `status=${settle.status} ${JSON.stringify(settle.data).slice(0, 150)}`);

  const rw = await post("/sales", saleBody("cash", null, { receivedInLedgerId: cashAcct.id, amountReceived: 10, clientRequestId: uuid() }));
  assert("Walk-in partial refused (400)", rw.status === 400, `status=${rw.status}`);
  assert("Refusal carries PARTIAL_REQUIRES_CUSTOMER", rw.data?.code === "PARTIAL_REQUIRES_CUSTOMER", `code=${rw.data?.code}`);
  if (rw.status === 201 && rw.data?.id) saleIds.push(rw.data.id);

  // ── [6] Overpayment at billing ────────────────────────────────────────────
  console.log("\n[6] Overpayment at billing: gate, consent, advance");
  // The advance is NETTED against the customer's outstanding — unwind the
  // reference credit sale first so the excess is visible as available credit.
  await unwindSale(probeTotalRes.data.id);
  saleIds.splice(saleIds.indexOf(probeTotalRes.data.id), 1);
  const overBy = 50;
  const bodyOver = saleBody("cash", tempCustomerId, { receivedInLedgerId: cashAcct.id, amountReceived: round2(fullTotal + overBy), clientRequestId: uuid() });
  const o1 = await post("/sales", bodyOver);
  assert("Plain overpay refused (400)", o1.status === 400, `status=${o1.status} ${JSON.stringify(o1.data).slice(0, 150)}`);
  assert("Refusal carries EXCEEDS_OUTSTANDING", o1.data?.code === "EXCEEDS_OUTSTANDING", `code=${o1.data?.code}`);
  assert("Refusal names the excess", near(o1.data?.excess ?? 0, overBy), `excess=${o1.data?.excess}`);
  assert("Refusal says overpayment IS allowed (customer sale)", o1.data?.overpaymentAllowed === true);
  if (o1.status === 201 && o1.data?.id) saleIds.push(o1.data.id);

  const advBefore = Number((await get(`/accounts/party-advance?kind=customer&partyId=${tempCustomerId}`)).data?.available ?? 0);
  const o2 = await post("/sales", { ...bodyOver, allowOverpayment: true });
  assert("Consented overpay accepted (201)", o2.status === 201, `status=${o2.status} ${JSON.stringify(o2.data).slice(0, 200)}`);
  if (o2.data?.id) saleIds.push(o2.data.id);
  const rowO = await saleDbRow(o2.data.id);
  assert("Invoice reads paid", rowO.payment_status === "paid", `status=${rowO.payment_status}`);
  const advAfter = Number((await get(`/accounts/party-advance?kind=customer&partyId=${tempCustomerId}`)).data?.available ?? 0);
  assert("Customer credit grew by exactly the excess", near(round2(advAfter - advBefore), overBy), `before=${advBefore} after=${advAfter}`);

  const ow = await post("/sales", saleBody("cash", null, { receivedInLedgerId: cashAcct.id, amountReceived: round2(unitPrice + 100), allowOverpayment: true, clientRequestId: uuid() }));
  assert("Walk-in overpay refused even WITH consent (400)", ow.status === 400, `status=${ow.status} ${JSON.stringify(ow.data).slice(0, 150)}`);
  if (ow.status === 201 && ow.data?.id) saleIds.push(ow.data.id);

  // ── [7] Price history ─────────────────────────────────────────────────────
  console.log("\n[7] Customer price history endpoint");
  const ph = await get(`/sales/price-history?customerId=${tempCustomerId}&itemId=${taxableItem.id}`);
  assert("Endpoint answers 200 with an array", ph.status === 200 && Array.isArray(ph.data), `status=${ph.status}`);
  const rows = ph.data ?? [];
  assert("History carries this run's sales", rows.length >= 2, `rows=${rows.length}`);
  assert("Rows expose invoice, date, qty and unit price",
    rows.every(r => r.invoiceNumber && r.saleDate && Number(r.quantity) > 0 && Number(r.unitPrice) > 0),
    JSON.stringify(rows[0] ?? {}).slice(0, 200));
  assert("Unit price echoes what was billed", rows.some(r => near(r.unitPrice, unitPrice)), `first=${rows[0]?.unitPrice} expected=${unitPrice}`);
  const dates = rows.map(r => String(r.saleDate));
  assert("Newest first", dates.every((d, i) => i === 0 || d <= dates[i - 1]), dates.join(","));
  const ph1 = await get(`/sales/price-history?customerId=${tempCustomerId}&itemId=${taxableItem.id}&limit=1`);
  assert("limit=1 respected", ph1.status === 200 && (ph1.data ?? []).length === 1, `rows=${(ph1.data ?? []).length}`);
  const phCap = await get(`/sales/price-history?customerId=${tempCustomerId}&itemId=${taxableItem.id}&limit=99`);
  assert("limit hard-capped at 10", phCap.status === 200 && (phCap.data ?? []).length <= 10, `rows=${(phCap.data ?? []).length}`);
  const phBad = await get(`/sales/price-history?customerId=0&itemId=${taxableItem.id}`);
  assert("Missing/invalid params refused (400)", phBad.status === 400, `status=${phBad.status}`);

  // Cancelled sales drop out of the history.
  const before = rows.length;
  await unwindSale(saleIds[saleIds.length - 1] === o2.data.id ? o2.data.id : o2.data.id);
  saleIds.splice(saleIds.indexOf(o2.data.id), 1);
  const phAfter = await get(`/sales/price-history?customerId=${tempCustomerId}&itemId=${taxableItem.id}&limit=10`);
  assert("Cancelled sale excluded from history",
    !(phAfter.data ?? []).some(r => r.invoiceNumber === o2.data.invoiceNumber),
    `still lists ${o2.data.invoiceNumber}`);
  void before;

  // ── [8] Cleanup + TB unchanged ────────────────────────────────────────────
  console.log("\n[8] Cleanup and trial-balance restoration");
} finally {
  for (const id of saleIds) await unwindSale(id);
  if (tempCustomerId) await del(`/customers/${tempCustomerId}`); // best-effort, guard keeps it once referenced
  if (tb0) {
    const tb1 = await snapshotTB();
    assert("TB debits end where they started", Math.abs(tb1.totalDr - tb0.totalDr) < 0.005, `before=${tb0.totalDr} after=${tb1.totalDr}`);
    assert("TB credits end where they started", Math.abs(tb1.totalCr - tb0.totalCr) < 0.005, `before=${tb0.totalCr} after=${tb1.totalCr}`);
  }
  await teardownUser();
  await sql.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
