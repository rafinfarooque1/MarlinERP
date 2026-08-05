/**
 * DEV REHEARSAL for migrations/allocationReceiptCleanup.ts — runs the exact
 * parameterised core (runAllocationReceiptCleanup) that production will run,
 * against fixtures created through the app's own business logic.
 *
 * Proves: (1) all-or-nothing refusal when a fingerprint mismatches — nothing
 * deleted; (2) the full unwind — receipt + legs gone, invoice back to unpaid,
 * TB balanced and back to its pre-receipt figure, audit rows written, no
 * orphans; (3) marker written in the same transaction.
 *
 * Run: cd artifacts/api-server && pnpm exec tsx tests/allocation-cleanup-rehearsal.ts
 * Cleans up every fixture it creates.
 */
import pg from "pg";
import { runAllocationReceiptCleanup } from "../src/migrations/allocationReceiptCleanup";

const BASE = process.env.API_URL || "http://localhost:8080/api";
const TAG = "ZZARC";
const WH = 2;

let authToken = "";
let passed = 0, failed = 0;
const assert = (label: string, cond: boolean, detail = "") => {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? " — " + detail : ""}`); failed++; }
};
const near = (a: unknown, b: number, eps = 0.011) => Math.abs(Number(a) - b) < eps;
const r2 = (n: unknown) => Math.round(Number(n ?? 0) * 100) / 100;

async function api(method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data: any; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sql = (t: string, p?: unknown[]) => pool.query(t, p);

async function snapshotTB() {
  const res = await api("GET", "/accounts/trial-balance");
  const rows = res.data?.rows ?? [];
  return {
    totalDr: r2(rows.reduce((s: number, r: any) => s + Number(r.debit ?? 0), 0)),
    totalCr: r2(rows.reduce((s: number, r: any) => s + Number(r.credit ?? 0), 0)),
    balanced: !!res.data?.balanced,
  };
}

const fx = { custId: 0, custLedger: 0, custCode: "", vendId: 0, itemId: 0 };
const made = { sales: [] as number[], purchases: [] as number[], receipts: [] as number[] };

async function cleanup() {
  for (const id of made.receipts) await api("DELETE", `/accounts/receipts/${id}`).catch(() => {});
  for (const id of made.sales.slice().reverse()) {
    const { rows: [row] } = await sql(`SELECT invoice_number FROM sales WHERE id = $1`, [id]);
    await api("POST", `/sales/${id}/cancel`, {}).catch(() => {});
    if (row) await sql(`DELETE FROM receipts WHERE voucher_number = $1`, [row.invoice_number]);
    await sql(`DELETE FROM sale_payments WHERE sale_id = $1`, [id]);
    await sql(`DELETE FROM sales WHERE id = $1`, [id]);
  }
  made.sales.length = 0;
  for (const id of made.purchases) await api("DELETE", `/purchases/${id}`).catch(() => {});
  made.purchases.length = 0;
  await sql(`DELETE FROM sale_payments WHERE clearing_receipt_id IN (SELECT id FROM receipts WHERE received_from_ledger_id IN (SELECT id FROM account_ledgers WHERE name LIKE $1))`, [`${TAG}%`]);
  await sql(`DELETE FROM receipts WHERE received_from_ledger_id IN (SELECT id FROM account_ledgers WHERE name LIKE $1)`, [`${TAG}%`]);
  await sql(`DELETE FROM stock_ledger WHERE item_name LIKE $1`, [`${TAG}%`]);
  if (fx.itemId) {
    await sql(`DELETE FROM stock_batches WHERE item_id = $1 AND material_type = 'item'`, [fx.itemId]);
    await sql(`DELETE FROM stock_entries WHERE item_id = $1 AND material_type = 'item'`, [fx.itemId]);
  }
  await sql(`DELETE FROM items WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM account_ledgers WHERE name LIKE $1 AND code LIKE 'CADV-%'`, [`%${TAG}%`]);
  await sql(`DELETE FROM account_ledgers WHERE name LIKE $1 AND (code LIKE 'CUST-%' OR code LIKE 'VEND-%')`, [`${TAG}%`]);
  await sql(`DELETE FROM customers WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM vendors WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM migration_log WHERE name LIKE 'zzarc_rehearsal_%'`);
  await sql(`DELETE FROM activity_log WHERE metadata->>'guard' LIKE 'zzarc_rehearsal_%'`);
}

// ── Fixtures ────────────────────────────────────────────────────────────────
console.log("\n[0] Auth + fixtures");
authToken = (await api("POST", "/auth/login", { username: "admin", password: "marlin1458" })).data?.token ?? "";
assert("Admin login", !!authToken);
if (!authToken) process.exit(1);
await cleanup();

const c = await api("POST", "/customers", { name: `${TAG} Cleanup Customer`, phone: "9111100031", state: "Karnataka" });
fx.custId = c.data?.id; fx.custCode = `CUST-${fx.custId}`;
assert("Customer created", c.status === 201 && !!fx.custId, `status ${c.status}`);
fx.custLedger = Number((await sql(`SELECT id FROM account_ledgers WHERE code = $1`, [fx.custCode])).rows[0]?.id);
assert("Customer ledger provisioned", fx.custLedger > 0);
const v = await api("POST", "/vendors", { name: `${TAG} Stock Vendor`, phone: "9111100032", state: "Karnataka" });
fx.vendId = v.data?.id;
fx.itemId = (await sql(
  `INSERT INTO items (name, unit, hsn_code, tax_rate, mrp, item_code, barcode, status)
   VALUES ($1,'KG','08119010',0,100,'FG-ZZARC-A','2900000000328','active') RETURNING id`,
  [`${TAG} Cleanup Item`])).rows[0].id;
const pur = await api("POST", "/purchases", {
  vendorId: fx.vendId, purchaseDate: "2026-07-01", locationType: "warehouse", locationId: WH,
  lineItems: [{ materialType: "item", materialId: fx.itemId, quantity: 50, unitCost: 40, mfgDate: "2026-06-01", expiryDate: "2027-06-01" }],
});
if (pur.status === 201) made.purchases.push(pur.data.id);
assert("Stock purchase lands", pur.status === 201, JSON.stringify(pur.data).slice(0, 150));

const mkSale = async (qty: number, saleDate: string) => {
  const res = await api("POST", "/sales", {
    outletId: WH, locationType: "warehouse", locationId: WH,
    saleDate, paymentMode: "credit", customerId: fx.custId,
    lineItems: [{ itemId: fx.itemId, quantity: qty, unitPrice: 100 }],
  });
  if (res.status === 201 && res.data?.id) made.sales.push(res.data.id);
  return res.data;
};
const S1 = await mkSale(5, "2026-07-20"); // ₹500
const S2 = await mkSale(3, "2026-07-25"); // ₹300
assert("Two credit sales created", !!S1?.id && !!S2?.id);

const tbPreReceipts = await snapshotTB();

const cashLeaf = Number((await sql(`SELECT id FROM account_ledgers WHERE code = 'STD-CASH'`)).rows[0].id);
const mkAllocReceipt = async (amount: number, saleId: number) => {
  const res = await api("POST", "/accounts/receipts", {
    receiptDate: "2026-08-01", receivedInLedgerId: cashLeaf, receivedFromLedgerId: fx.custLedger,
    amount, allocations: [{ saleId, amount }],
  });
  if (res.status === 201) made.receipts.push(res.data.id);
  return res.data;
};
const R1 = await mkAllocReceipt(500, S1.id);
const R2 = await mkAllocReceipt(300, S2.id);
assert("Two allocation receipts created", !!R1?.id && !!R2?.id,
  JSON.stringify({ R1, R2 }).slice(0, 200));
assert("Both sales settled", near((await sql(`SELECT amount_paid FROM sales WHERE id=$1`, [S1.id])).rows[0].amount_paid, 500));

// ── [A] Fail-closed: one wrong fingerprint → nothing deleted ────────────────
console.log("\n[A] Partial fingerprint mismatch refuses everything");
{
  let threw = "";
  const guardA = `zzarc_rehearsal_${Date.now()}_a`;
  try {
    await runAllocationReceiptCleanup(pool as any,
      [{ id: R1.id, voucherNumber: R1.voucherNumber, amount: 500 },
       { id: R2.id, voucherNumber: R2.voucherNumber, amount: 999 }],
      guardA, "rehearsal — must refuse", fx.custCode);
  } catch (e) { threw = (e as Error).message; }
  assert("Throws on partial match", threw.includes("refusing to delete anything"), threw);
  const { rows: [n] } = await sql(`SELECT COUNT(*)::int AS n FROM receipts WHERE id = ANY($1::int[])`, [[R1.id, R2.id]]);
  assert("Both receipts still present", n.n === 2);
  const { rows: [s1] } = await sql(`SELECT amount_paid::numeric AS p, payment_status FROM sales WHERE id=$1`, [S1.id]);
  assert("S1 still fully paid", near(s1.p, 500) && s1.payment_status === "paid");

  // Zero matches must also throw — never silently mark a corrective guard done.
  let threw0 = "";
  try {
    await runAllocationReceiptCleanup(pool as any,
      [{ id: 99999991, voucherNumber: "REC/9999-00/0001", amount: 1 }],
      guardA, "rehearsal — zero matches", fx.custCode);
  } catch (e) { threw0 = (e as Error).message; }
  assert("Throws on zero matches", threw0.includes("refusing to delete anything"), threw0);
  const { rows: [mk0] } = await sql(`SELECT COUNT(*)::int AS n FROM migration_log WHERE name = $1`, [guardA]);
  assert("No marker written on refusal", mk0.n === 0);
}

// ── [B] Correct fingerprints → full unwind in one transaction ───────────────
console.log("\n[B] Full cleanup unwinds both vouchers");
const guardB = `zzarc_rehearsal_${Date.now()}_b`;
{
  const summary = await runAllocationReceiptCleanup(pool as any,
    [{ id: R1.id, voucherNumber: R1.voucherNumber, amount: 500 },
     { id: R2.id, voucherNumber: R2.voucherNumber, amount: 300 }],
    guardB, "rehearsal — full unwind", fx.custCode);
  console.log(`  → ${summary}`);
  assert("Summary reports 2 receipts / ₹800", summary.includes("2 settlement receipt(s)") && summary.includes("800.00"), summary);

  const { rows: [gone] } = await sql(`SELECT COUNT(*)::int AS n FROM receipts WHERE id = ANY($1::int[])`, [[R1.id, R2.id]]);
  assert("Receipts deleted", gone.n === 0);
  const { rows: [legs] } = await sql(`SELECT COUNT(*)::int AS n FROM sale_payments WHERE clearing_receipt_id = ANY($1::int[])`, [[R1.id, R2.id]]);
  assert("No orphan sale_payments legs", legs.n === 0);
  const { rows: [s1] } = await sql(`SELECT amount_paid::numeric AS p, payment_status FROM sales WHERE id=$1`, [S1.id]);
  const { rows: [s2] } = await sql(`SELECT amount_paid::numeric AS p, payment_status FROM sales WHERE id=$1`, [S2.id]);
  assert("S1 back to unpaid", near(s1.p, 0) && s1.payment_status === "unpaid", JSON.stringify(s1));
  assert("S2 back to unpaid", near(s2.p, 0) && s2.payment_status === "unpaid", JSON.stringify(s2));

  const tbAfter = await snapshotTB();
  assert("TB balanced after cleanup", tbAfter.balanced);
  assert("TB back to pre-receipt figure",
    near(tbAfter.totalDr, tbPreReceipts.totalDr) && near(tbAfter.totalCr, tbPreReceipts.totalCr),
    `pre Dr ${tbPreReceipts.totalDr} vs after Dr ${tbAfter.totalDr}`);

  const { rows: audits } = await sql(
    `SELECT description, "user", metadata FROM activity_log WHERE metadata->>'guard' = $1 ORDER BY id`, [guardB]);
  assert("Two audit rows written with reason", audits.length === 2
    && audits.every((a: any) => a.metadata?.reason?.includes("rehearsal") && a.user.includes("cleanup")),
    JSON.stringify(audits).slice(0, 200));
  const { rows: [mk] } = await sql(`SELECT COUNT(*)::int AS n FROM migration_log WHERE name = $1`, [guardB]);
  assert("Marker written", mk.n === 1);

  const rerun = await runAllocationReceiptCleanup(pool as any,
    [{ id: R1.id, voucherNumber: R1.voucherNumber, amount: 500 }], guardB, "rehearsal", fx.custCode);
  assert("Re-run is a no-op (already applied)", rerun.includes("already applied"), rerun);

  // Customer outstanding restored: both invoices owed again.
  const recv = await api("GET", "/reports/receivables").catch(() => null);
  const { rows: [due] } = await sql(
    `SELECT COALESCE(SUM(total_amount::numeric - amount_paid::numeric),0) AS due FROM sales WHERE customer_id = $1 AND cancelled_at IS NULL`, [fx.custId]);
  assert("Customer owes ₹800 again", near(due.due, 800), `due=${due.due}${recv ? "" : ""}`);
}

made.receipts.length = 0; // already deleted by the cleanup under test

// ── Teardown ────────────────────────────────────────────────────────────────
console.log("\n[Z] Teardown");
await cleanup();
const tbEnd = await snapshotTB();
assert("TB balanced after teardown", tbEnd.balanced);

console.log(`\n${passed} passed, ${failed} failed`);
await pool.end();
process.exit(failed ? 1 : 0);
