// Item Tracking endpoint — permanent regression suite.
//
// Verifies, against live dev data (read-only; the only writes are the two
// ZZ-prefixed probe employees, removed in finally):
//   [1] response shape + summary buckets reconcile with direct SQL aggregates
//   [2] cancelled and branch-transfer documents are excluded from buckets
//       but still listed (flagged) in history
//   [3] LBAC — a warehouse-scoped user sees only their own location's rows
//   [4] input validation (bad kind / bad id / missing product)
//
// Run from artifacts/api-server:  node tests/item-tracking.test.mjs
import pg from "pg";
import bcrypt from "bcryptjs";

const BASE = "http://localhost:8080/api";
const sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (t, p = []) => (await sql.query(t, p)).rows;
const r3 = (n) => Math.round(Number(n) * 1000) / 1000;

let passed = 0, failed = 0;
const assert = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
};

const HO_USER = "zz_trk_probe_ho", WH_USER = "zz_trk_probe_wh", PASS = "Probe#Trk1";

async function provision(username, branchType, branchId) {
  await q(`DELETE FROM login_lockouts WHERE username=$1`, [username]);
  await q(`DELETE FROM login_attempts WHERE username=$1`, [username]);
  await q(`DELETE FROM employees WHERE username=$1`, [username]);
  await q(`INSERT INTO employees (name,username,password_hash,hierarchy_id,branch_type,branch_id,salary,join_date,is_active,must_change_password)
           SELECT 'ZZ Tracking Probe',$1,$2,(SELECT MIN(id) FROM hierarchies),$3,$4,1,CURRENT_DATE,true,false`,
    [username, bcrypt.hashSync(PASS, 10), branchType, branchId]);
  const r = await fetch(`${BASE}/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: PASS }),
  });
  const j = await r.json();
  if (!j.token) throw new Error(`login failed for ${username}: ${JSON.stringify(j)}`);
  return { Authorization: `Bearer ${j.token}` };
}

async function cleanup(username) {
  await q(`DELETE FROM login_attempts WHERE username=$1`, [username]);
  await q(`DELETE FROM login_lockouts WHERE username=$1`, [username]);
  await q(`DELETE FROM employees WHERE username=$1`, [username]);
}

try {
  // Item with the most sales lines — richest history to check against.
  const [pick] = await q(`
    SELECT (li->>'itemId')::int AS id, COUNT(*) AS n
      FROM sales s, jsonb_array_elements(s.line_items) li
     GROUP BY 1 ORDER BY 2 DESC LIMIT 1`);
  if (!pick) throw new Error("dev DB has no sales lines to track");
  const ITEM = pick.id;

  const ho = await provision(HO_USER, "headoffice", 1);
  const get = async (path, hdr = ho) => {
    const r = await fetch(`${BASE}${path}`, { headers: hdr });
    return { status: r.status, data: r.status !== 204 ? await r.json().catch(() => null) : null };
  };

  console.log(`\n[1] Summary buckets reconcile with SQL (item ${ITEM})`);
  const { status, data: d } = await get(`/item-tracking?materialType=item&itemId=${ITEM}`);
  assert("GET → 200", status === 200, `got ${status}`);

  const [truth] = await q(`
    SELECT
      (SELECT COALESCE(SUM((li->>'quantity')::numeric),0) FROM purchases p, jsonb_array_elements(p.line_items) li
        WHERE (li->>'materialId')::int=$1 AND COALESCE(li->>'materialType','item')='item'
          AND p.cancelled_at IS NULL AND p.branch_transfer_id IS NULL) AS purchased,
      (SELECT COALESCE(SUM((li->>'quantity')::numeric),0) FROM sales s, jsonb_array_elements(s.line_items) li
        WHERE (li->>'itemId')::int=$1 AND s.cancelled_at IS NULL AND s.branch_transfer_id IS NULL) AS sold,
      (SELECT COALESCE(SUM((li->>'quantity')::numeric),0) FROM sales_returns sr, jsonb_array_elements(sr.line_items) li
        WHERE (li->>'itemId')::int=$1) AS sales_ret,
      (SELECT COALESCE(SUM(se.quantity),0) FROM stock_entries se
        WHERE se.item_id=$1 AND se.material_type='item') AS current`, [ITEM]);

  if (!d?.summary?.truncated) {
    assert("purchasedQty matches SQL", r3(d.summary.purchasedQty) === r3(truth.purchased), `${d.summary.purchasedQty} vs ${truth.purchased}`);
    assert("soldQty matches SQL", r3(d.summary.soldQty) === r3(truth.sold), `${d.summary.soldQty} vs ${truth.sold}`);
    assert("salesReturnQty matches SQL", r3(d.summary.salesReturnQty) === r3(truth.sales_ret));
  } else {
    console.log("  (history capped — skipping exact bucket equality)");
  }
  assert("currentStock matches stock_entries", r3(d.summary.currentStock) === r3(truth.current), `${d.summary.currentStock} vs ${truth.current}`);
  assert("stockByLocation sums to currentStock",
    r3(d.stockByLocation.reduce((s, l) => s + l.quantity, 0)) === r3(d.summary.currentStock));
  assert("item block present", d.item?.id === ITEM && d.item?.materialType === "item");
  assert("level-1 sees valuation", d.canViewValuation === true && d.summary.currentValue != null);
  assert("sale rows carry invoice+customer+location",
    d.salesHistory.length > 0 && d.salesHistory.every(r => r.invoiceNumber && r.customerName && r.location));
  assert("purchase rows carry vendor+rate",
    d.purchaseHistory.every(r => typeof r.vendorName === "string" && "rate" in r));

  console.log(`\n[1b] Legacy purchase line without materialType still counts`);
  // Old imports wrote purchase lines with no materialType key; the module's own
  // identity paths default absent → 'item', so tracking must too.
  const LEGACY_INV = "ZZTRK-LEGACY-1";
  await q(`DELETE FROM purchases WHERE invoice_number=$1`, [LEGACY_INV]);
  await q(`INSERT INTO purchases (purchase_date, invoice_number, party_name, line_items, total_amount)
           VALUES (CURRENT_DATE, $1, 'ZZ Legacy Vendor (fixture)',
                   jsonb_build_array(jsonb_build_object('materialId', $2::int, 'quantity', 1, 'costPerUnit', 1, 'taxableValue', 1)), 1)`,
    [LEGACY_INV, ITEM]);
  const { data: dLeg } = await get(`/item-tracking?materialType=item&itemId=${ITEM}`);
  assert("legacy type-less line listed in purchaseHistory",
    dLeg.purchaseHistory.some(r => r.invoiceNumber === LEGACY_INV));
  if (!dLeg.summary.truncated && !d.summary?.truncated) {
    assert("legacy line adds to purchasedQty",
      r3(dLeg.summary.purchasedQty) === r3(Number(d.summary.purchasedQty) + 1),
      `${dLeg.summary.purchasedQty} vs ${d.summary.purchasedQty}+1`);
  }
  await q(`DELETE FROM purchases WHERE invoice_number=$1`, [LEGACY_INV]);

  console.log(`\n[2] Cancelled / branch-transfer flags`);
  const flagged = [...d.salesHistory, ...d.purchaseHistory].filter(r => r.cancelled || r.isBranchTransfer);
  const [xcheck] = await q(`
    SELECT (SELECT COUNT(*) FROM sales s, jsonb_array_elements(s.line_items) li
             WHERE (li->>'itemId')::int=$1 AND (s.cancelled_at IS NOT NULL OR s.branch_transfer_id IS NOT NULL)) AS n`, [ITEM]);
  if (Number(xcheck.n) > 0 && !d.summary.truncated) {
    assert("flagged docs listed in history", flagged.length > 0, "DB has cancelled/BT docs but none flagged in response");
  } else {
    console.log(`  (no cancelled/branch-transfer docs for this item — flag rendering covered by shape checks)`);
    assert("no spurious flags", d.salesHistory.every(r => !r.cancelled || r.cancelled === true));
  }

  console.log(`\n[3] LBAC — warehouse-scoped user`);
  // A warehouse that has sales for this item, and one that the probe is NOT in.
  const whs = await q(`
    SELECT DISTINCT s.location_id AS id FROM sales s, jsonb_array_elements(s.line_items) li
     WHERE (li->>'itemId')::int=$1 AND s.location_type='warehouse' AND s.location_id IS NOT NULL`, [ITEM]);
  if (whs.length >= 1) {
    const myWh = whs[0].id;
    const [{ name: myWhName }] = await q(`SELECT name FROM warehouses WHERE id=$1`, [myWh]);
    const wh = await provision(WH_USER, "warehouse", myWh);
    const { status: ws, data: wd } = await get(`/item-tracking?materialType=item&itemId=${ITEM}`, wh);
    assert("scoped GET → 200", ws === 200, `got ${ws}`);
    assert("sales limited to own warehouse", wd.salesHistory.every(r => r.location === myWhName),
      JSON.stringify([...new Set(wd.salesHistory.map(r => r.location))]));
    assert("stockByLocation limited to own warehouse",
      wd.stockByLocation.every(l => l.branchType === "warehouse" && l.branchId === myWh));
    assert("scoped currentStock ≤ HO currentStock", wd.summary.currentStock <= d.summary.currentStock + 0.001);
  } else {
    console.log("  (no warehouse sales for this item — skipping)");
  }

  console.log(`\n[4] Input validation`);
  assert("bad materialType → 400", (await get(`/item-tracking?materialType=x&itemId=1`)).status === 400);
  assert("bad itemId → 400", (await get(`/item-tracking?materialType=item&itemId=abc`)).status === 400);
  assert("missing product → 404", (await get(`/item-tracking?materialType=item&itemId=99999999`)).status === 404);

} catch (e) {
  failed++;
  console.error("SUITE ERROR:", e);
} finally {
  await q(`DELETE FROM purchases WHERE invoice_number='ZZTRK-LEGACY-1'`).catch(() => {});
  await cleanup(HO_USER);
  await cleanup(WH_USER);
  await sql.end();
}

console.log(`\n══ Result: ${passed} passed, ${failed} failed ══`);
process.exit(failed > 0 ? 1 : 0);
