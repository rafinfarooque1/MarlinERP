/**
 * Storage locations (freezers) — placement layer over stock_entries.
 *
 * Contracts under test:
 *   1. CRUD: create (dup name → 409), rename (dup → 409), disable/enable,
 *      delete only when empty (400 while holding stock, 204 after emptied).
 *   2. Moves: Unassigned → freezer, freezer → freezer, freezer → Unassigned;
 *      caps enforced (never more than the source holds); disabled location
 *      refuses incoming stock but can still be emptied out.
 *   3. Reconciliation invariant: warehouse total (stock_entries truth) =
 *      Σ storage-location placements + Unassigned, before, during and after.
 *   4. Zero side effects: stock_entries quantities and the trial balance are
 *      byte-identical before and after — placements never touch quantity
 *      truth or the books.
 *
 * Disposable fixtures only — own level-1 probe user (never 'admin'),
 * ZZ-prefixed location names, full cleanup at exit.
 */
import pg from "pg";
import bcrypt from "bcryptjs";

const BASE = "http://localhost:8080/api";
const sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (text, params = []) => (await sql.query(text, params)).rows;

const USER = "storage_locations_probe";
const PASS = "Probe#Storage1";
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
const patch = (p, b) => apiReq("PATCH", p, b);
const del = (p) => apiReq("DELETE", p);
const r3 = (n) => Math.round(n * 1000) / 1000;
const round2 = (n) => Math.round(n * 100) / 100;

async function snapshotTB() {
  const res = await get("/accounts/trial-balance");
  const rows = res.data?.rows ?? [];
  return {
    totalDr: round2(rows.reduce((s, r) => s + Number(r.debit ?? 0), 0)),
    totalCr: round2(rows.reduce((s, r) => s + Number(r.credit ?? 0), 0)),
  };
}

async function setupUser() {
  await teardownUser();
  const hash = bcrypt.hashSync(PASS, 10);
  await q(
    `INSERT INTO employees (name, username, password_hash, hierarchy_id, branch_type, branch_id, salary, join_date, is_active, must_change_password)
     SELECT 'Storage Locations Probe', $1, $2, (SELECT MIN(id) FROM hierarchies), 'headoffice', 1, 1, CURRENT_DATE, true, false`,
    [USER, hash]);
}
async function teardownUser() {
  await q(`DELETE FROM login_lockouts WHERE username = $1`, [USER]);
  await q(`DELETE FROM login_attempts WHERE username = $1`, [USER]);
  await q(`DELETE FROM employees WHERE username = $1`, [USER]);
}

const NAME_A = "ZZ Test Freezer A (fixture)";
const NAME_B = "ZZ Test Freezer B (fixture)";
const NAME_P = "ZZ Test Parent Freezer (fixture)";
const NAME_R = "ZZ Test Rack (fixture)";

// Remove any leftovers from a previous crashed run (children before parents).
async function sweepFixtures() {
  const rows = await q(
    `SELECT id FROM storage_locations WHERE name IN ($1, $2, $3, $4)
      ORDER BY (parent_id IS NULL)`, [NAME_A, NAME_B, NAME_P, NAME_R]);
  for (const r of rows) {
    await q(`DELETE FROM storage_placements WHERE storage_location_id = $1`, [r.id]);
    await q(`DELETE FROM storage_locations WHERE id = $1`, [r.id]);
  }
}

await setupUser();
await sweepFixtures();
let locA = null, locB = null, locP = null, locR = null;
let tb0 = null;
try {
  console.log("\n[0] Authentication (probe user)");
  const loginRes = await post("/auth/login", { username: USER, password: PASS });
  authToken = loginRes.data?.token ?? "";
  assert("Probe user logs in", !!authToken, `status=${loginRes.status}`);
  if (!authToken) process.exit(1);

  tb0 = await snapshotTB();

  // Derive a warehouse that actually holds finished-goods stock.
  const cand = await q(`
    SELECT se.branch_id AS warehouse_id, se.item_id, SUM(se.quantity)::numeric AS qty
      FROM stock_entries se JOIN warehouses w ON w.id = se.branch_id AND w.disabled_at IS NULL
     WHERE se.branch_type = 'warehouse' AND se.material_type = 'item'
     GROUP BY se.branch_id, se.item_id
    HAVING SUM(se.quantity) >= 2
     ORDER BY SUM(se.quantity) DESC LIMIT 1`);
  if (!cand[0]) { console.error("FATAL: no warehouse item with qty >= 2 in dev DB."); process.exit(1); }
  const WH = Number(cand[0].warehouse_id);
  const ITEM = Number(cand[0].item_id);
  const stockBefore = await q(
    `SELECT SUM(quantity)::numeric AS qty FROM stock_entries
      WHERE branch_type = 'warehouse' AND branch_id = $1 AND material_type = 'item' AND item_id = $2`, [WH, ITEM]);
  const truthQty = r3(Number(stockBefore[0].qty));

  // ── [1] Location CRUD ──────────────────────────────────────────────────────
  console.log("\n[1] Storage location CRUD");
  const cA = await post("/storage-locations", { warehouseId: WH, name: NAME_A });
  assert("Create location A → 201", cA.status === 201, `status=${cA.status} ${JSON.stringify(cA.data).slice(0, 120)}`);
  locA = cA.data?.id;
  const dup = await post("/storage-locations", { warehouseId: WH, name: NAME_A.toLowerCase() });
  assert("Duplicate name (case-insensitive) → 409", dup.status === 409, `status=${dup.status}`);
  const cB = await post("/storage-locations", { warehouseId: WH, name: "ZZ Temp Name (fixture)" });
  locB = cB.data?.id;
  const ren = await patch(`/storage-locations/${locB}`, { name: NAME_B });
  assert("Rename location B → 200", ren.status === 200, `status=${ren.status}`);
  const renDup = await patch(`/storage-locations/${locB}`, { name: NAME_A });
  assert("Rename onto existing name → 409", renDup.status === 409, `status=${renDup.status}`);
  const list = await get(`/storage-locations?warehouseId=${WH}`);
  const names = (list.data ?? []).map(l => l.name);
  assert("List shows both locations", names.includes(NAME_A) && names.includes(NAME_B), JSON.stringify(names).slice(0, 200));
  const badWh = await post("/storage-locations", { warehouseId: 999999, name: "ZZ Nowhere" });
  assert("Unknown warehouse → 404", badWh.status === 404, `status=${badWh.status}`);

  // ── [2] Matrix baseline ────────────────────────────────────────────────────
  console.log("\n[2] Placement matrix baseline");
  const m0 = await get(`/storage-stock?warehouseId=${WH}`);
  assert("Matrix loads", m0.status === 200, `status=${m0.status}`);
  const row0 = (m0.data?.rows ?? []).find(r => r.materialType === "item" && r.itemId === ITEM);
  assert("Fixture item appears in matrix", !!row0);
  assert("Warehouse total matches stock_entries truth", row0 && r3(row0.totalQty) === truthQty, `matrix=${row0?.totalQty} truth=${truthQty}`);
  const initialUnassigned = row0 ? r3(row0.unassignedQty) : 0;
  const initialPlaced = row0 ? r3(row0.placedQty) : 0;
  assert("Reconciliation holds at baseline", row0 && r3(initialPlaced + initialUnassigned) >= truthQty - 0.001);
  if (initialUnassigned < 2) { console.error("FATAL: fixture item has < 2 unassigned."); process.exit(1); }

  // ── [3] Moves ──────────────────────────────────────────────────────────────
  console.log("\n[3] Assign & move stock");
  const mv1 = await post("/storage-placements/move", {
    warehouseId: WH, materialType: "item", itemId: ITEM,
    fromStorageLocationId: null, toStorageLocationId: locA, quantity: 2,
  });
  assert("Unassigned → A (2) → 200", mv1.status === 200, `status=${mv1.status} ${JSON.stringify(mv1.data).slice(0, 150)}`);

  const over = await post("/storage-placements/move", {
    warehouseId: WH, materialType: "item", itemId: ITEM,
    fromStorageLocationId: null, toStorageLocationId: locA, quantity: initialUnassigned + 100,
  });
  assert("Over-cap from Unassigned → 400", over.status === 400, `status=${over.status}`);

  const mv2 = await post("/storage-placements/move", {
    warehouseId: WH, materialType: "item", itemId: ITEM,
    fromStorageLocationId: locA, toStorageLocationId: locB, quantity: 0.5,
  });
  assert("A → B (0.5) → 200", mv2.status === 200, `status=${mv2.status} ${JSON.stringify(mv2.data).slice(0, 150)}`);

  const overA = await post("/storage-placements/move", {
    warehouseId: WH, materialType: "item", itemId: ITEM,
    fromStorageLocationId: locA, toStorageLocationId: locB, quantity: 5,
  });
  assert("Move more than A holds → 400", overA.status === 400, `status=${overA.status}`);

  const m1 = await get(`/storage-stock?warehouseId=${WH}`);
  const row1 = (m1.data?.rows ?? []).find(r => r.materialType === "item" && r.itemId === ITEM);
  const pA = row1?.placements.find(p => p.storageLocationId === locA);
  const pB = row1?.placements.find(p => p.storageLocationId === locB);
  assert("A holds 1.5", r3(Number(pA?.quantity ?? 0)) === 1.5, `A=${pA?.quantity}`);
  assert("B holds 0.5", r3(Number(pB?.quantity ?? 0)) === 0.5, `B=${pB?.quantity}`);
  assert("Unassigned shrank by exactly 2", r3(row1.unassignedQty) === r3(initialUnassigned - 2), `unassigned=${row1?.unassignedQty}`);
  assert("Reconciliation: total = placed + unassigned", r3(row1.placedQty + row1.unassignedQty) === r3(row1.totalQty),
    `placed=${row1?.placedQty} unassigned=${row1?.unassignedQty} total=${row1?.totalQty}`);
  assert("Warehouse total UNCHANGED by moves", r3(row1.totalQty) === truthQty);

  // Live Stock report (§30): the /stock rows must carry the placements so the
  // Storage Location column and CSV export can show them.
  const stockList = await get(`/stock?branchType=warehouse&branchId=${WH}`);
  const stockRow = (Array.isArray(stockList.data) ? stockList.data : stockList.data?.rows ?? [])
    .find(r => r.materialType === "item" && r.itemId === ITEM && Number(r.branchId) === WH);
  const slA = stockRow?.storageLocations?.find(p => p.name === NAME_A);
  const slB = stockRow?.storageLocations?.find(p => p.name === NAME_B);
  assert("Live Stock row lists Freezer A placement (1.5)", r3(Number(slA?.quantity ?? 0)) === 1.5, JSON.stringify(stockRow?.storageLocations ?? null).slice(0, 200));
  assert("Live Stock row lists Freezer B placement (0.5)", r3(Number(slB?.quantity ?? 0)) === 0.5);

  // ── [4] Disabled destination ───────────────────────────────────────────────
  console.log("\n[4] Disabled location rules");
  const dis = await patch(`/storage-locations/${locB}`, { isDisabled: true });
  assert("Disable B → 200", dis.status === 200, `status=${dis.status}`);
  const intoDisabled = await post("/storage-placements/move", {
    warehouseId: WH, materialType: "item", itemId: ITEM,
    fromStorageLocationId: locA, toStorageLocationId: locB, quantity: 0.5,
  });
  assert("Move INTO disabled B → 400", intoDisabled.status === 400, `status=${intoDisabled.status}`);
  const outOfDisabled = await post("/storage-placements/move", {
    warehouseId: WH, materialType: "item", itemId: ITEM,
    fromStorageLocationId: locB, toStorageLocationId: null, quantity: 0.5,
  });
  assert("Move OUT of disabled B (empty it) → 200", outOfDisabled.status === 200, `status=${outOfDisabled.status} ${JSON.stringify(outOfDisabled.data).slice(0, 150)}`);

  // ── [5] Delete rules ───────────────────────────────────────────────────────
  console.log("\n[5] Delete rules");
  const delFull = await del(`/storage-locations/${locA}`);
  assert("Delete A while holding stock → 400", delFull.status === 400, `status=${delFull.status}`);
  const emptyA = await post("/storage-placements/move", {
    warehouseId: WH, materialType: "item", itemId: ITEM,
    fromStorageLocationId: locA, toStorageLocationId: null, quantity: 1.5,
  });
  assert("Empty A back to Unassigned → 200", emptyA.status === 200, `status=${emptyA.status}`);
  const delA = await del(`/storage-locations/${locA}`);
  assert("Delete empty A → 204", delA.status === 204, `status=${delA.status}`);
  const delB = await del(`/storage-locations/${locB}`);
  assert("Delete empty (disabled) B → 204", delB.status === 204, `status=${delB.status}`);
  if (delA.status === 204) locA = null;
  if (delB.status === 204) locB = null;

  // ── [6] Input validation ───────────────────────────────────────────────────
  console.log("\n[6] Input validation");
  const bothNull = await post("/storage-placements/move", { warehouseId: WH, materialType: "item", itemId: ITEM, fromStorageLocationId: null, toStorageLocationId: null, quantity: 1 });
  assert("from=to=null → 400", bothNull.status === 400, `status=${bothNull.status}`);
  const badKind = await post("/storage-placements/move", { warehouseId: WH, materialType: "gadget", itemId: ITEM, fromStorageLocationId: null, toStorageLocationId: 1, quantity: 1 });
  assert("Bad materialType → 400", badKind.status === 400, `status=${badKind.status}`);
  const zeroQty = await post("/storage-placements/move", { warehouseId: WH, materialType: "item", itemId: ITEM, fromStorageLocationId: null, toStorageLocationId: 1, quantity: 0 });
  assert("Zero quantity → 400", zeroQty.status === 400, `status=${zeroQty.status}`);

  // ── [S] Sub-locations (racks inside a storage location) ───────────────────
  console.log("\n[S] Sub-location hierarchy");
  const cP = await post("/storage-locations", { warehouseId: WH, name: NAME_P });
  locP = cP.data?.id;
  assert("Create parent → 201", cP.status === 201, `status=${cP.status}`);
  const cR = await post("/storage-locations", { warehouseId: WH, name: NAME_R, parentId: locP });
  locR = cR.data?.id;
  assert("Create sub-location → 201 with pathLabel", cR.status === 201 && cR.data?.pathLabel === `${NAME_P} › ${NAME_R}`,
    `status=${cR.status} path=${cR.data?.pathLabel}`);
  const gc = await post("/storage-locations", { warehouseId: WH, name: "ZZ Too Deep", parentId: locR });
  assert("Grandchild (2 levels deep) → 400", gc.status === 400, `status=${gc.status}`);
  const dupR = await post("/storage-locations", { warehouseId: WH, name: NAME_R.toUpperCase(), parentId: locP });
  assert("Duplicate name under same parent → 409", dupR.status === 409, `status=${dupR.status}`);
  const rootSameName = await post("/storage-locations", { warehouseId: WH, name: NAME_R });
  assert("Same name allowed at ROOT level → 201", rootSameName.status === 201, `status=${rootSameName.status}`);
  if (rootSameName.status === 201) {
    const delRoot = await del(`/storage-locations/${rootSameName.data.id}`);
    assert("(cleanup twin root) → 204", delRoot.status === 204, `status=${delRoot.status}`);
  }
  const badParent = await post("/storage-locations", { warehouseId: WH, name: "ZZ Orphan", parentId: 999999 });
  assert("Unknown parent → 404", badParent.status === 404, `status=${badParent.status}`);

  // Move stock into the rack, verify list rollup, then hierarchy guards.
  const mvR = await post("/storage-placements/move", {
    warehouseId: WH, materialType: "item", itemId: ITEM,
    fromStorageLocationId: null, toStorageLocationId: locR, quantity: 1,
  });
  assert("Unassigned → rack (1) → 200", mvR.status === 200, `status=${mvR.status} ${JSON.stringify(mvR.data).slice(0, 120)}`);
  const listS = await get(`/storage-locations?warehouseId=${WH}`);
  const rowP = (listS.data ?? []).find(l => l.id === locP);
  const rowR = (listS.data ?? []).find(l => l.id === locR);
  assert("Parent rolls up child qty (childPlacedQty=1)", r3(Number(rowP?.childPlacedQty ?? 0)) === 1, `got=${rowP?.childPlacedQty}`);
  assert("Parent childCount = 1", Number(rowP?.childCount) === 1, `got=${rowP?.childCount}`);
  assert("Child carries parentId + pathLabel", rowR?.parentId === locP && rowR?.pathLabel === `${NAME_P} › ${NAME_R}`,
    `parentId=${rowR?.parentId} path=${rowR?.pathLabel}`);

  // Matrix placement name uses the path label
  const mS = await get(`/storage-stock?warehouseId=${WH}`);
  const rowSM = (mS.data?.rows ?? []).find(r => r.materialType === "item" && r.itemId === ITEM);
  const pR = rowSM?.placements.find(p => p.storageLocationId === locR);
  assert("Matrix placement shows 'Parent > Rack' label", typeof pR?.name === "string" && pR.name.includes(NAME_P) && pR.name.includes(NAME_R),
    `name=${pR?.name}`);

  const delParentWithChild = await del(`/storage-locations/${locP}`);
  assert("Delete parent with sub-location → 400", delParentWithChild.status === 400, `status=${delParentWithChild.status}`);

  // Disable the PARENT: rack refuses incoming stock (effective disabled) but empties out.
  await patch(`/storage-locations/${locP}`, { isDisabled: true });
  const intoChildOfDisabled = await post("/storage-placements/move", {
    warehouseId: WH, materialType: "item", itemId: ITEM,
    fromStorageLocationId: null, toStorageLocationId: locR, quantity: 0.5,
  });
  assert("Move INTO rack of disabled parent → 400", intoChildOfDisabled.status === 400, `status=${intoChildOfDisabled.status}`);
  const outOfChild = await post("/storage-placements/move", {
    warehouseId: WH, materialType: "item", itemId: ITEM,
    fromStorageLocationId: locR, toStorageLocationId: null, quantity: 1,
  });
  assert("Empty rack while parent disabled → 200", outOfChild.status === 200, `status=${outOfChild.status}`);
  await patch(`/storage-locations/${locP}`, { isDisabled: false });

  // Delete child first, then parent.
  const delR = await del(`/storage-locations/${locR}`);
  assert("Delete empty rack → 204", delR.status === 204, `status=${delR.status}`);
  if (delR.status === 204) locR = null;
  const delP = await del(`/storage-locations/${locP}`);
  assert("Delete parent after rack gone → 204", delP.status === 204, `status=${delP.status}`);
  if (delP.status === 204) locP = null;

  // ── [7] Zero side effects ──────────────────────────────────────────────────
  console.log("\n[7] Zero side effects");
  const stockAfter = await q(
    `SELECT SUM(quantity)::numeric AS qty FROM stock_entries
      WHERE branch_type = 'warehouse' AND branch_id = $1 AND material_type = 'item' AND item_id = $2`, [WH, ITEM]);
  assert("stock_entries truth untouched", r3(Number(stockAfter[0].qty)) === truthQty, `before=${truthQty} after=${stockAfter[0].qty}`);
  const m2 = await get(`/storage-stock?warehouseId=${WH}`);
  const row2 = (m2.data?.rows ?? []).find(r => r.materialType === "item" && r.itemId === ITEM);
  assert("Unassigned restored to baseline", r3(row2.unassignedQty) === initialUnassigned, `now=${row2?.unassignedQty} was=${initialUnassigned}`);
  const tb1 = await snapshotTB();
  assert("Trial balance identical (Dr)", tb1.totalDr === tb0.totalDr, `before=${tb0.totalDr} after=${tb1.totalDr}`);
  assert("Trial balance identical (Cr)", tb1.totalCr === tb0.totalCr, `before=${tb0.totalCr} after=${tb1.totalCr}`);
} finally {
  // Cleanup — placements first (FK), then locations (children before parents),
  // then the probe user.
  for (const id of [locA, locB, locR, locP].filter(Boolean)) {
    await q(`DELETE FROM storage_placements WHERE storage_location_id = $1`, [id]);
    await q(`DELETE FROM storage_locations WHERE id = $1`, [id]);
  }
  await sweepFixtures();
  await teardownUser();
  await sql.end();
}

console.log(`\n══ Result: ${passed} passed, ${failed} failed ══`);
process.exit(failed > 0 ? 1 : 0);
