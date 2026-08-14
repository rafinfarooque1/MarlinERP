/**
 * Phase-1 money flows — partial collection, overpayment-as-credit,
 * idempotency keys, and sale other-charge ledger typing.
 *
 * Contracts under test:
 *   1. Sale create with clientRequestId: an exact replay (double-click /
 *      network retry) returns the ORIGINAL invoice (idempotentReplay) —
 *      never a second invoice.
 *   2. Collection with clientRequestId: a replay returns the original
 *      collection; the sale's paid figure is not doubled.
 *   3. Partial collection on a credit sale leaves the remainder due
 *      (partially_paid), all through the one payment engine.
 *   4. Overpayment: refused with code EXCEEDS_OUTSTANDING unless
 *      allowOverpayment is sent; accepted only for a registered customer,
 *      whose excess lands as usable advance (credit on CUST-); the invoice
 *      itself reads paid with zero balance.
 *   5. Sale other charges post to a Direct Income (SYS-DIRINC) ledger — the
 *      Sales (SYS-SAL) subtree stays barred; purchase charges stay
 *      expense-only.
 *   6. The trial balance ends exactly where it started (self-cleaning:
 *      system-deletes its receipts, cancels its sales, removes fixtures).
 *
 * Disposable fixtures only — creates its own level-1 probe user directly in
 * the DB (never touches 'admin'), its own customer, and cleans up at exit.
 */
import pg from "pg";
import bcrypt from "bcryptjs";

const BASE = "http://localhost:8080/api";
const sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (text, params = []) => (await sql.query(text, params)).rows;

const USER = "p1_moneyflow_probe";
const PASS = "Probe#Money1";
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

async function snapshotTB() {
  const res = await get("/accounts/trial-balance");
  const rows = res.data?.rows ?? [];
  return {
    totalDr: round2(rows.reduce((s, r) => s + Number(r.debit ?? 0), 0)),
    totalCr: round2(rows.reduce((s, r) => s + Number(r.credit ?? 0), 0)),
  };
}

// Unwind every collection recorded against a sale (system-delete its clearing
// receipts, level-1 path), then cancel the bill. Leaves zero trace in books.
async function unwindSale(saleId) {
  if (!saleId) return;
  const receipts = await q(
    `SELECT DISTINCT clearing_receipt_id AS id FROM sale_payments
      WHERE sale_id = $1 AND clearing_receipt_id IS NOT NULL`, [saleId]);
  for (const r of receipts) {
    const dr = await post(`/accounts/receipts/${r.id}/system-delete`, { reason: "Automated test cleanup — Phase 1 money-flow suite fixture unwind" });
    if (dr.status !== 200) console.error(`  (cleanup) receipt ${r.id} system-delete → ${dr.status} ${JSON.stringify(dr.data).slice(0, 150)}`);
  }
  const c = await post(`/sales/${saleId}/cancel`, {});
  if (c.status !== 200) console.error(`  (cleanup) sale ${saleId} cancel → ${c.status} ${JSON.stringify(c.data).slice(0, 150)}`);
}

// ── Fixture ──────────────────────────────────────────────────────────────────
async function setupUser() {
  await teardownUser();
  const hash = bcrypt.hashSync(PASS, 10);
  await q(
    `INSERT INTO employees (name, username, password_hash, hierarchy_id, branch_type, branch_id, salary, join_date, is_active, must_change_password)
     SELECT 'P1 Moneyflow Probe', $1, $2, (SELECT MIN(id) FROM hierarchies), 'headoffice', 1, 1, CURRENT_DATE, true, false`,
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
  // ── [0] Auth ───────────────────────────────────────────────────────────────
  console.log("\n[0] Authentication (probe user)");
  const loginRes = await post("/auth/login", { username: USER, password: PASS });
  authToken = loginRes.data?.token ?? "";
  assert("Probe user logs in", !!authToken, `status=${loginRes.status}`);
  if (!authToken) process.exit(1);

  // ── Derived fixtures ─────────────────────────────────────────────────────
  const [itemsRes, warehousesRes] = await Promise.all([get("/items"), get("/warehouses")]);
  const items = itemsRes.data ?? [];
  const warehouse = (warehousesRes.data ?? [])[0];
  const taxableItem = items.find(i => Number(i.taxRate) > 0);
  if (!taxableItem || !warehouse) { console.error("FATAL: need a taxable item and a warehouse."); process.exit(1); }
  const unitPrice = Math.max(100, Number(taxableItem.mrp ?? 0));
  const today = new Date().toISOString().slice(0, 10);
  const saleBody = (mode, customerId, extra = {}) => ({
    outletId: warehouse.id, locationType: "warehouse", locationId: warehouse.id,
    saleDate: today, paymentMode: mode,
    ...(customerId ? { customerId } : {}),
    lineItems: [{ itemId: taxableItem.id, quantity: 1, unitPrice, discount: 0, taxAmount: 0 }],
    ...extra,
  });

  // Reuse ONE fixed probe customer across runs: once it has (cancelled) sale
  // history the delete guard rightly keeps the master row, so a fresh name
  // per run would accumulate ZZ rows in the live dev customer list.
  const PROBE_CUSTOMER = "ZZ P1 Money Probe (fixture)";
  const existing = await q(`SELECT id FROM customers WHERE name = $1`, [PROBE_CUSTOMER]);
  if (existing[0]?.id) tempCustomerId = existing[0].id;
  else {
    const cr = await post("/customers", { name: PROBE_CUSTOMER, creditLimit: 1000000 });
    tempCustomerId = cr.data?.id ?? null;
  }
  assert("Probe customer ready", !!tempCustomerId);

  tb0 = await snapshotTB();

  // ── [1] Sale-create idempotency ───────────────────────────────────────────
  console.log("\n[1] Sale create replay returns the ORIGINAL invoice");
  const k1 = uuid();
  const body1 = saleBody("credit", tempCustomerId, { clientRequestId: k1 });
  const r1 = await post("/sales", body1);
  assert("Credit sale created (201)", r1.status === 201 && r1.data?.id, `status=${r1.status} ${JSON.stringify(r1.data).slice(0, 150)}`);
  if (r1.data?.id) saleIds.push(r1.data.id);
  const r1b = await post("/sales", body1);
  assert("Replay answers 200, not 201", r1b.status === 200, `status=${r1b.status} ${JSON.stringify(r1b.data).slice(0, 150)}`);
  assert("Replay returns the SAME invoice", r1b.data?.id === r1.data?.id && r1b.data?.invoiceNumber === r1.data?.invoiceNumber,
    `first=${r1.data?.id}/${r1.data?.invoiceNumber} replay=${r1b.data?.id}/${r1b.data?.invoiceNumber}`);
  assert("Replay is flagged idempotentReplay", r1b.data?.idempotentReplay === true);
  const dupCount = await q(`SELECT COUNT(*)::int AS n FROM sales WHERE client_request_id = $1`, [k1]);
  assert("Exactly ONE sale row exists for the key", dupCount[0]?.n === 1, `n=${dupCount[0]?.n}`);

  const total1 = Number(r1.data?.totalAmount ?? 0);

  // ── [2] Partial collection + collection idempotency ──────────────────────
  console.log("\n[2] Partial collection, then an exact replay of it");
  const part = round2(total1 / 2);
  const k2 = uuid();
  const p1 = await post(`/sales/${r1.data.id}/payments`, { method: "cash", amount: part, paymentDate: today, clientRequestId: k2 });
  assert("Partial collection recorded (201)", p1.status === 201, `status=${p1.status} ${JSON.stringify(p1.data).slice(0, 150)}`);
  assert("Sale now partially paid", p1.data?.newPaymentStatus === "partially_paid", `status=${p1.data?.newPaymentStatus}`);
  assert("Balance = total − part", Math.abs(Number(p1.data?.newBalanceDue) - round2(total1 - part)) < 0.005,
    `balance=${p1.data?.newBalanceDue} expected=${round2(total1 - part)}`);
  const p1b = await post(`/sales/${r1.data.id}/payments`, { method: "cash", amount: part, paymentDate: today, clientRequestId: k2 });
  assert("Collection replay answers 200", p1b.status === 200, `status=${p1b.status} ${JSON.stringify(p1b.data).slice(0, 150)}`);
  assert("Replay returns the SAME collection", p1b.data?.id === p1.data?.id && p1b.data?.idempotentReplay === true,
    `first=${p1.data?.id} replay=${p1b.data?.id}`);
  const paidNow = await get(`/sales/${r1.data.id}`);
  assert("Paid figure NOT doubled by the replay", Math.abs(Number(paidNow.data?.amountPaid ?? paidNow.data?.amountReceived ?? 0) - part) < 0.005,
    `paid=${paidNow.data?.amountPaid}`);

  // ── [3] Overpayment gate ──────────────────────────────────────────────────
  console.log("\n[3] Overpayment: refused plain, accepted with consent, excess = advance");
  const remaining = round2(total1 - part);
  const overBy = 50;
  const o1 = await post(`/sales/${r1.data.id}/payments`, { method: "cash", amount: round2(remaining + overBy), paymentDate: today });
  assert("Plain overpay refused 400", o1.status === 400, `status=${o1.status}`);
  assert("Refusal carries code EXCEEDS_OUTSTANDING", o1.data?.code === "EXCEEDS_OUTSTANDING", `code=${o1.data?.code}`);
  assert("Refusal names the excess", Math.abs(Number(o1.data?.excess ?? 0) - overBy) < 0.005, `excess=${o1.data?.excess}`);
  assert("Refusal says overpayment IS allowed here (customer sale)", o1.data?.overpaymentAllowed === true);

  const advBefore = Number((await get(`/accounts/party-advance?kind=customer&partyId=${tempCustomerId}`)).data?.available ?? 0);

  const o2 = await post(`/sales/${r1.data.id}/payments`, {
    method: "cash", amount: round2(remaining + overBy), paymentDate: today,
    clientRequestId: uuid(), allowOverpayment: true,
  });
  assert("Consented overpay accepted (201)", o2.status === 201, `status=${o2.status} ${JSON.stringify(o2.data).slice(0, 200)}`);
  assert("Invoice settles at zero balance", Math.abs(Number(o2.data?.newBalanceDue ?? -1)) < 0.005, `balance=${o2.data?.newBalanceDue}`);
  assert("Invoice reads paid", o2.data?.newPaymentStatus === "paid", `status=${o2.data?.newPaymentStatus}`);

  const advAfter = Number((await get(`/accounts/party-advance?kind=customer&partyId=${tempCustomerId}`)).data?.available ?? 0);
  assert("Customer credit grew by exactly the excess", Math.abs(round2(advAfter - advBefore) - overBy) < 0.005,
    `before=${advBefore} after=${advAfter}`);

  // ── [4] Walk-in overpay is unrepresentable ────────────────────────────────
  console.log("\n[4] Walk-in sales cannot hold excess as credit");
  const w1 = await post("/sales", saleBody("cash", null, { clientRequestId: uuid() }));
  assert("Walk-in cash sale created", w1.status === 201, `status=${w1.status}`);
  if (w1.data?.id) saleIds.push(w1.data.id);
  const wo = await post(`/sales/${w1.data.id}/payments`, { method: "cash", amount: 10, paymentDate: today, allowOverpayment: true });
  assert("Walk-in overpay refused even WITH consent", wo.status === 400, `status=${wo.status} ${JSON.stringify(wo.data).slice(0, 150)}`);

  // ── [5] Sale other-charge ledger typing ───────────────────────────────────
  console.log("\n[5] Sale charges: Direct Income ledger OK, Sales subtree barred");
  // Derive a postable ledger UNDER SYS-DIRINC, or create a probe one there.
  let incomeLedgerId = null, createdProbeLedger = false;
  const chart = (await get("/accounts/chart/flat")).data ?? [];
  const byId = new Map(chart.map(a => [Number(a.id), a]));
  const underCode = (a, code) => {
    const seen = new Set();
    for (let cur = a; cur && !seen.has(Number(cur.id)); cur = cur.parentId != null ? byId.get(Number(cur.parentId)) : undefined) {
      seen.add(Number(cur.id));
      if (String(cur.code ?? "").toUpperCase() === code) return true;
    }
    return false;
  };
  const incomeOK = chart.find(a => a.type === "income" && !a.isGroup && !a.isSystemGroup
    && underCode(a, "SYS-DIRINC") && !/^(SYS|STD|CUST|VEND|CBA|SAL|ADV|CADV|VADV)-/i.test(String(a.code ?? "x")));
  if (incomeOK) incomeLedgerId = incomeOK.id;
  else {
    const grp = chart.find(a => a.isGroup && String(a.code ?? "").toUpperCase() === "SYS-DIRINC");
    if (grp) {
      const mk = await post("/accounts/chart", { name: `ZZ Probe Packing Income ${Date.now()}`, type: "income", parentId: grp.id });
      incomeLedgerId = mk.data?.id ?? null; createdProbeLedger = !!incomeLedgerId;
    }
  }
  assert("Found/created a Direct Income charge ledger", !!incomeLedgerId);
  if (incomeLedgerId) {
    const s5 = await post("/sales", saleBody("cash", null, {
      clientRequestId: uuid(),
      otherCharges: [{ ledgerId: incomeLedgerId, amount: 25 }],
    }));
    assert("Sale with INCOME charge accepted", s5.status === 201, `status=${s5.status} ${JSON.stringify(s5.data).slice(0, 200)}`);
    if (s5.data?.id) saleIds.push(s5.data.id);
  }
  const salesSubtree = chart.find(a => !a.isGroup && a.type === "income" && underCode(a, "SYS-SAL"));
  if (salesSubtree) {
    const s6 = await post("/sales", saleBody("cash", null, {
      clientRequestId: uuid(),
      otherCharges: [{ ledgerId: salesSubtree.id, amount: 25 }],
    }));
    assert("Charge into the Sales subtree refused", s6.status === 400, `status=${s6.status} ${JSON.stringify(s6.data).slice(0, 150)}`);
    if (s6.status === 201 && s6.data?.id) saleIds.push(s6.data.id);
  } else {
    console.log("  (no postable ledger under SYS-SAL — subtree bar untestable on this chart)");
  }
  // Purchase charges must still refuse income ledgers (expense-only unchanged).
  if (incomeLedgerId) {
    const vend = await q(`SELECT id FROM vendors LIMIT 1`);
    if (vend[0]?.id) {
      const pb = await post("/purchases", {
        vendorId: vend[0].id, purchaseDate: today, warehouseId: warehouse.id,
        lineItems: [{ kind: "item", itemId: taxableItem.id, quantity: 1, unitCost: 10 }],
        otherCharges: [{ ledgerId: incomeLedgerId, amount: 5 }],
      });
      assert("Purchase charge to income ledger still refused", pb.status === 400,
        `status=${pb.status} ${JSON.stringify(pb.data).slice(0, 150)}`);
      if (pb.status === 201 && pb.data?.id) await del(`/purchases/${pb.data.id}`);
    }
  }
  if (createdProbeLedger) await del(`/accounts/chart/${incomeLedgerId}`);

  // ── [6] Cleanup + TB unchanged ────────────────────────────────────────────
  console.log("\n[6] Cleanup and trial-balance restoration");
} finally {
  for (const id of saleIds) await unwindSale(id);
  if (tempCustomerId) {
    // Best-effort: succeeds only before the customer has sale history; once
    // cancelled sales reference it, the guard keeps the master (correct).
    await del(`/customers/${tempCustomerId}`);
  }
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
