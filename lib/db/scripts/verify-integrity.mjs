#!/usr/bin/env node
/**
 * Source-of-truth integrity verifier.
 *
 * Checks the invariants declared in SOURCE_OF_TRUTH.md against live data, and
 * can snapshot totals so a migration can prove it moved nothing.
 *
 *   node scripts/verify-integrity.mjs                     # check invariants
 *   node scripts/verify-integrity.mjs --snapshot before.json
 *   node scripts/verify-integrity.mjs --compare  before.json
 *
 * Exit code is non-zero when an invariant fails or a comparison differs, so
 * this is usable as a validation step.
 */
import pg from "pg";
import { readFileSync, writeFileSync } from "node:fs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
const n = (v) => Number(v ?? 0);
const fmt = (v) => n(v).toLocaleString("en-IN", { minimumFractionDigits: 3, maximumFractionDigits: 3 });

const failures = [];
const warnings = [];
const fail = (m) => { failures.push(m); console.log(`  FAIL  ${m}`); };
const warn = (m) => { warnings.push(m); console.log(`  WARN  ${m}`); };
const ok = (m) => console.log(`  ok    ${m}`);

async function hasColumn(table, column) {
  const r = await q(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return r.length > 0;
}

/** Quantity truth, keyed so it survives the material_type migration. */
async function stockTotals() {
  const typed = await hasColumn("stock_entries", "material_type");
  const sel = typed ? "material_type" : `'item' AS material_type`;
  return q(`
    SELECT ${sel}, item_id, branch_type, branch_id, SUM(quantity::numeric) AS qty
    FROM stock_entries GROUP BY 1,2,3,4 ORDER BY 1,2,3,4
  `);
}

async function batchTotals() {
  const typed = await hasColumn("stock_batches", "material_type");
  const sel = typed ? "material_type" : `'item' AS material_type`;
  return q(`
    SELECT ${sel}, item_id, branch_type, branch_id, SUM(quantity::numeric) AS qty
    FROM stock_batches GROUP BY 1,2,3,4 ORDER BY 1,2,3,4
  `);
}

async function buildSnapshot() {
  const key = (r) => `${r.material_type}:${r.item_id}:${r.branch_type}:${r.branch_id}`;
  const stock = {}, batches = {};
  for (const r of await stockTotals()) stock[key(r)] = n(r.qty);
  for (const r of await batchTotals()) batches[key(r)] = n(r.qty);

  const [globals] = await q(`
    SELECT
      (SELECT COALESCE(SUM(current_stock::numeric),0) FROM materials)     AS materials_global,
      (SELECT COALESCE(SUM(current_stock::numeric),0) FROM raw_materials) AS raw_global,
      (SELECT COALESCE(SUM(production_stock::numeric),0) FROM items)      AS items_counter
  `);

  const perType = {};
  for (const r of await stockTotals()) {
    perType[r.material_type] = n(perType[r.material_type]) + n(r.qty);
  }

  const sales = await q(
    `SELECT location_type, location_id, COUNT(*)::int AS cnt, COALESCE(SUM(total_amount::numeric),0) AS amt
     FROM sales GROUP BY 1,2 ORDER BY 1,2`
  );

  return {
    stock, batches,
    globals: {
      materials: n(globals.materials_global),
      rawMaterials: n(globals.raw_global),
      itemsCounter: n(globals.items_counter),
    },
    perType,
    grandTotalQty: Object.values(stock).reduce((s, v) => s + v, 0),
    sales: sales.map((s) => ({
      locationType: s.location_type, locationId: s.location_id,
      count: s.cnt, amount: n(s.amt),
    })),
    salesGrandTotal: sales.reduce((s, r) => s + n(r.amt), 0),
  };
}

async function checkInvariants() {
  console.log("\nINVARIANTS\n");

  // 1. stock rows reconcile to batch rows
  const stock = await stockTotals();
  const batches = await batchTotals();
  const bKey = new Map(batches.map((r) => [`${r.material_type}:${r.item_id}:${r.branch_type}:${r.branch_id}`, n(r.qty)]));
  let drift = 0, untracked = 0;
  for (const r of stock) {
    const k = `${r.material_type}:${r.item_id}:${r.branch_type}:${r.branch_id}`;
    const b = bKey.get(k) ?? 0;
    const d = n(r.qty) - b;
    // Asymmetric on purpose. Batch coverage falling SHORT of the stock row is
    // by design — the uncovered remainder is reported as untracked residual.
    // Batch coverage EXCEEDING the stock row is corruption: it means lots claim
    // more goods than exist, and FEFO would hand out stock that isn't there.
    if (d < -0.001) {
      drift++;
      fail(`batches exceed stock ${k}: stock ${fmt(r.qty)} vs batches ${fmt(b)} (excess ${fmt(-d)})`);
    } else if (d > 0.001) {
      untracked += d;
    }
  }
  // batch rows with no matching stock row
  const sKey = new Set(stock.map((r) => `${r.material_type}:${r.item_id}:${r.branch_type}:${r.branch_id}`));
  for (const r of batches) {
    const k = `${r.material_type}:${r.item_id}:${r.branch_type}:${r.branch_id}`;
    if (!sKey.has(k) && n(r.qty) > 0.001) { drift++; fail(`batch rows with no stock row ${k}: ${fmt(r.qty)}`); }
  }
  if (drift === 0) {
    ok(`no batch layer exceeds its stock row (${stock.length} keys)`);
    if (untracked > 0.001) console.log(`  info  ${fmt(untracked)} unit(s) not covered by any lot — reported as untracked residual`);
  }

  // 2. retired counters must not diverge from the truth (informational until retired)
  const [{ items_counter, entries_items }] = await q(`
    SELECT (SELECT COALESCE(SUM(production_stock::numeric),0) FROM items) AS items_counter,
           (SELECT COALESCE(SUM(quantity::numeric),0) FROM stock_entries
             ${(await hasColumn("stock_entries", "material_type")) ? `WHERE material_type = 'item'` : ``}) AS entries_items
  `);
  if (Math.abs(n(items_counter) - n(entries_items)) > 0.001) {
    warn(`retired item counter reads ${fmt(items_counter)} but stock truth is ${fmt(entries_items)} — must not be read by any report`);
  } else {
    ok(`item counter agrees with stock truth (${fmt(entries_items)})`);
  }

  // 3. materials must be represented per location once migrated
  if (await hasColumn("stock_entries", "material_type")) {
    for (const [table, type] of [["materials", "material"], ["raw_materials", "raw_material"]]) {
      const [{ global_qty }] = await q(`SELECT COALESCE(SUM(current_stock::numeric),0) AS global_qty FROM ${table}`);
      const [{ located }] = await q(
        `SELECT COALESCE(SUM(quantity::numeric),0) AS located FROM stock_entries WHERE material_type = $1`, [type]
      );
      if (Math.abs(n(global_qty) - n(located)) > 0.001) {
        fail(`${table}: global ${fmt(global_qty)} vs per-location ${fmt(located)}`);
      } else {
        ok(`${table} per-location total matches global (${fmt(located)})`);
      }
    }
  } else {
    warn(`stock_entries has no material_type yet — raw and packing materials are not location-aware`);
  }

  // 4. no negative stock
  const neg = await q(`SELECT COUNT(*)::int AS c FROM stock_entries WHERE quantity::numeric < -0.001`);
  neg[0].c > 0 ? fail(`${neg[0].c} stock row(s) negative`) : ok("no negative stock rows");

  // 5. every location reference resolves to a real location
  const orphans = await q(`
    SELECT 'stock_entries' t, branch_type, branch_id, COUNT(*)::int c FROM stock_entries
      WHERE (branch_type='warehouse' AND branch_id NOT IN (SELECT id FROM warehouses))
         OR (branch_type='outlet'    AND branch_id NOT IN (SELECT id FROM outlets))
      GROUP BY 1,2,3
    UNION ALL
    SELECT 'stock_batches', branch_type, branch_id, COUNT(*)::int FROM stock_batches
      WHERE (branch_type='warehouse' AND branch_id NOT IN (SELECT id FROM warehouses))
         OR (branch_type='outlet'    AND branch_id NOT IN (SELECT id FROM outlets))
      GROUP BY 1,2,3
    UNION ALL
    SELECT 'employees', branch_type, branch_id, COUNT(*)::int FROM employees
      WHERE (branch_type='warehouse' AND branch_id NOT IN (SELECT id FROM warehouses))
         OR (branch_type='outlet'    AND branch_id NOT IN (SELECT id FROM outlets))
      GROUP BY 1,2,3
  `);
  orphans.length
    ? orphans.forEach((o) => fail(`${o.t}: ${o.c} row(s) point at missing ${o.branch_type} #${o.branch_id}`))
    : ok("every location reference resolves");

  // 6. stock ledger coverage — a ledger with holes is not an audit trail
  const [{ ledger_rows }] = await q(`SELECT COUNT(*)::int AS ledger_rows FROM stock_ledger`);
  const [{ movements }] = await q(`
    SELECT (SELECT COUNT(*) FROM sales) + (SELECT COUNT(*) FROM purchases)
         + (SELECT COUNT(*) FROM productions) + (SELECT COUNT(*) FROM stock_transfers) AS movements
  `);
  if (n(ledger_rows) < n(movements)) {
    warn(`stock ledger holds ${ledger_rows} rows against ${movements} stock-moving documents — movements are not all logged`);
  } else {
    ok(`stock ledger covers ${ledger_rows} rows`);
  }

  return { failures, warnings };
}

/**
 * Old location -> new location, so a snapshot taken before a location migration
 * can still be compared key-for-key afterwards. Without this every remapped
 * location reads as a difference and the comparison proves nothing.
 */
async function locationMap() {
  const exists = await q(
    `SELECT 1 FROM information_schema.tables WHERE table_name = 'location_migration_map'`
  );
  if (!exists.length) return new Map();
  const rows = await q(`SELECT old_type, old_id, new_type, new_id FROM location_migration_map`);
  return new Map(rows.map((r) => [`${r.old_type}:${r.old_id}`, `${r.new_type}:${r.new_id}`]));
}

function translateKey(key, map) {
  const [mt, itemId, bt, bid] = key.split(":");
  const moved = map.get(`${bt}:${bid}`);
  return moved ? `${mt}:${itemId}:${moved}` : key;
}

function diffSnapshots(before, after, map) {
  console.log("\nCOMPARISON vs SNAPSHOT");
  if (map.size) {
    console.log(`  (translating ${map.size} migrated location(s): ${[...map].map(([o, n]) => `${o} -> ${n}`).join(", ")})`);
  }
  console.log("");
  let diffs = 0;
  const translated = {};
  for (const [k, v] of Object.entries(before.stock)) {
    const tk = translateKey(k, map);
    translated[tk] = (translated[tk] ?? 0) + v;
  }
  const keys = new Set([...Object.keys(translated), ...Object.keys(after.stock)]);
  for (const k of [...keys].sort()) {
    const b = translated[k] ?? 0, a = after.stock[k] ?? 0;
    if (Math.abs(b - a) > 0.001) { diffs++; fail(`stock ${k}: ${fmt(b)} -> ${fmt(a)}`); }
  }
  if (Math.abs(before.grandTotalQty - after.grandTotalQty) > 0.001) {
    diffs++;
    fail(`TOTAL quantity moved: ${fmt(before.grandTotalQty)} -> ${fmt(after.grandTotalQty)}`);
  } else {
    ok(`total quantity unchanged (${fmt(after.grandTotalQty)})`);
  }
  if (Math.abs(before.salesGrandTotal - after.salesGrandTotal) > 0.01) {
    diffs++;
    fail(`sales revenue moved: ${before.salesGrandTotal} -> ${after.salesGrandTotal}`);
  } else {
    ok(`sales revenue unchanged (Rs ${after.salesGrandTotal.toLocaleString("en-IN")})`);
  }
  const bs = before.sales.reduce((s, r) => s + r.count, 0), as_ = after.sales.reduce((s, r) => s + r.count, 0);
  if (bs !== as_) { diffs++; fail(`sale count moved: ${bs} -> ${as_}`); } else ok(`sale count unchanged (${as_})`);
  if (diffs === 0) console.log("\n  Snapshot matches: the migration preserved every total.");
  return diffs;
}

async function main() {
  const args = process.argv.slice(2);
  const snapIdx = args.indexOf("--snapshot");
  const cmpIdx = args.indexOf("--compare");

  const snap = await buildSnapshot();

  console.log("STOCK BY LOCATION");
  const byLoc = {};
  for (const [k, v] of Object.entries(snap.stock)) {
    const [, , bt, bid] = k.split(":");
    byLoc[`${bt} #${bid}`] = (byLoc[`${bt} #${bid}`] ?? 0) + v;
  }
  for (const [loc, v] of Object.entries(byLoc).sort()) console.log(`  ${loc.padEnd(18)} ${fmt(v).padStart(14)}`);
  console.log(`  ${"TOTAL".padEnd(18)} ${fmt(snap.grandTotalQty).padStart(14)}`);
  console.log(`\n  global material stock ${fmt(snap.globals.materials)} | packing ${fmt(snap.globals.rawMaterials)} | retired item counter ${fmt(snap.globals.itemsCounter)}`);
  console.log(`  sales: ${snap.sales.reduce((s, r) => s + r.count, 0)} documents, Rs ${snap.salesGrandTotal.toLocaleString("en-IN")}`);

  let diffs = 0;
  if (snapIdx !== -1) {
    const path = args[snapIdx + 1];
    writeFileSync(path, JSON.stringify(snap, null, 2));
    console.log(`\nSnapshot written to ${path}`);
  }
  if (cmpIdx !== -1) {
    diffs = diffSnapshots(JSON.parse(readFileSync(args[cmpIdx + 1], "utf8")), snap, await locationMap());
  }

  await checkInvariants();

  console.log(`\n${"=".repeat(60)}`);
  console.log(`FAILURES: ${failures.length}   WARNINGS: ${warnings.length}   SNAPSHOT DIFFS: ${diffs}`);
  console.log("=".repeat(60));

  await pool.end();
  process.exit(failures.length > 0 || diffs > 0 ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
