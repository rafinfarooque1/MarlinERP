// Org hierarchy restructure migration — scenario tests on a scratch schema.
//
// Runs the REAL migration code against a throwaway Postgres schema in the
// same database, so no dev data is touched. Covers the fail-closed contract
// the migration promises: ambiguous or clashing role names must roll back
// EVERYTHING and write no migration_log marker, so the attempt repeats after
// manual repair.
//
// The migration source is TypeScript with extensionless imports, so run it
// through the workspace's tsx (plain `node --test` cannot resolve them):
//   node ../../node_modules/.pnpm/tsx@4.23.0/node_modules/tsx/dist/cli.mjs \
//     --test tests/org-restructure-migration.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const SCHEMA = "org_mig_test";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL required");

// Admin pool (public schema) only to create/drop the scratch schema.
const admin = new pg.Pool({ connectionString: url, max: 1 });
// Test pool: every connection sees ONLY the scratch schema.
const pool = new pg.Pool({ connectionString: url, max: 1, options: `-c search_path=${SCHEMA}` });

let runOrgHierarchyRestructure, ensureStandardOrgTree;

async function resetSchema() {
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  await pool.query(`
    CREATE TABLE hierarchies (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      level INTEGER NOT NULL,
      reports_to_id INTEGER,
      description TEXT
    );
    CREATE TABLE permissions (
      id SERIAL PRIMARY KEY,
      hierarchy_id INTEGER NOT NULL,
      module TEXT NOT NULL,
      can_view BOOLEAN NOT NULL DEFAULT false,
      can_add BOOLEAN NOT NULL DEFAULT false,
      can_edit BOOLEAN NOT NULL DEFAULT false,
      can_delete BOOLEAN NOT NULL DEFAULT false,
      can_download BOOLEAN NOT NULL DEFAULT false,
      can_print BOOLEAN NOT NULL DEFAULT false,
      can_share BOOLEAN NOT NULL DEFAULT false,
      can_approve BOOLEAN NOT NULL DEFAULT false,
      UNIQUE (hierarchy_id, module)
    );
    CREATE TABLE migration_log (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

const q = async (text, params) => (await pool.query(text, params)).rows;
const markerCount = async () =>
  Number((await q(`SELECT COUNT(*)::int AS n FROM migration_log WHERE name = 'org_hierarchy_restructure_v1'`))[0].n);

before(async () => {
  ({ runOrgHierarchyRestructure, ensureStandardOrgTree } =
    await import("../src/migrations/orgHierarchyRestructure.ts"));
});

after(async () => {
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.end();
  await admin.end();
});

test("legacy tree: root renamed, Management created view-only, old children reparented, idempotent", async () => {
  await resetSchema();
  await pool.query(`INSERT INTO hierarchies (name, level, description) VALUES ('Management', 1, 'Top-level management')`);
  await pool.query(`INSERT INTO hierarchies (name, level, reports_to_id) VALUES ('Sales Team', 2, 1)`);

  await runOrgHierarchyRestructure(pool);

  const [root] = await q(`SELECT name, level FROM hierarchies WHERE reports_to_id IS NULL`);
  assert.equal(root.name, "Administrator");
  const [mgmt] = await q(`SELECT id, level, reports_to_id FROM hierarchies WHERE name = 'Management'`);
  assert.equal(mgmt.level, 2);
  const [team] = await q(`SELECT level, reports_to_id FROM hierarchies WHERE name = 'Sales Team'`);
  assert.equal(team.reports_to_id, mgmt.id, "pre-existing root child moves under new Management");
  assert.equal(team.level, 3);
  const managers = await q(`SELECT name FROM hierarchies WHERE reports_to_id = $1 ORDER BY name`, [mgmt.id]);
  assert.equal(managers.length, 8, "Owner + 6 managers + reparented Sales Team");
  const [lvl1] = await q(`SELECT COUNT(*)::int AS n FROM hierarchies WHERE level = 1`);
  assert.equal(lvl1.n, 1);

  const perms = await q(`SELECT * FROM permissions WHERE hierarchy_id = $1`, [mgmt.id]);
  assert.ok(perms.length >= 40, `seeded rows present (got ${perms.length})`);
  for (const p of perms) {
    assert.equal(p.can_add, false);
    assert.equal(p.can_edit, false);
    assert.equal(p.can_delete, false);
    assert.equal(p.can_approve, false);
    assert.equal(p.can_view, true);
    assert.equal(p.can_print, p.can_download, "legacy print mirrors download");
    assert.equal(p.can_share, p.can_download, "legacy share mirrors download");
  }
  assert.ok(perms.some((p) => p.module === "page:/accounts/trial-balance" && p.can_download));
  assert.ok(perms.some((p) => p.module === "page:/sales/pos" && !p.can_download));
  for (const denied of ["page:/company/settings", "page:/company/permissions", "page:/company/backup", "page:/hr/hierarchy", "page:/company/login-history", "page:/company/profile"]) {
    assert.ok(!perms.some((p) => p.module === denied), `${denied} must have NO row (default-deny)`);
  }
  assert.equal(await markerCount(), 1);

  // Second run: marker short-circuits, nothing changes.
  const snapBefore = await q(`SELECT id, name, level, reports_to_id FROM hierarchies ORDER BY id`);
  await runOrgHierarchyRestructure(pool);
  assert.deepEqual(await q(`SELECT id, name, level, reports_to_id FROM hierarchies ORDER BY id`), snapBefore);
});

test("fail closed: another role already named Administrator — nothing changes, no marker", async () => {
  await resetSchema();
  await pool.query(`INSERT INTO hierarchies (name, level) VALUES ('Management', 1)`);
  await pool.query(`INSERT INTO hierarchies (name, level, reports_to_id) VALUES ('administrator', 2, 1)`);

  await runOrgHierarchyRestructure(pool); // logs + skips, must not throw boot down

  const rows = await q(`SELECT name FROM hierarchies ORDER BY id`);
  assert.deepEqual(rows.map((r) => r.name), ["Management", "administrator"], "tree untouched");
  assert.equal(await markerCount(), 0, "no marker — retries next boot");
});

test("fail closed: pre-existing non-root 'Management' role keeps its rows, no adoption, no marker", async () => {
  await resetSchema();
  await pool.query(`INSERT INTO hierarchies (name, level) VALUES ('Management', 1)`);
  await pool.query(`INSERT INTO hierarchies (name, level, reports_to_id) VALUES (' management ', 2, 1)`);
  await pool.query(`INSERT INTO permissions (hierarchy_id, module, can_view, can_add, can_edit, can_delete) VALUES (2, 'page:/company/settings', true, true, true, true)`);

  await assert.rejects(() => runOrgHierarchyRestructure(pool), /already exists|duplicate role names/);

  assert.equal((await q(`SELECT COUNT(*)::int AS n FROM hierarchies`))[0].n, 2, "no roles created");
  const [wide] = await q(`SELECT can_add, can_edit, can_delete FROM permissions WHERE hierarchy_id = 2`);
  assert.deepEqual(wide, { can_add: true, can_edit: true, can_delete: true }, "existing rows untouched — never silently narrowed or adopted");
  assert.equal(await markerCount(), 0);
});

test("fail closed: multiple parentless roots — nothing changes, no marker", async () => {
  await resetSchema();
  await pool.query(`INSERT INTO hierarchies (name, level) VALUES ('Management', 1), ('Shadow Root', 1)`);

  await runOrgHierarchyRestructure(pool);

  assert.equal((await q(`SELECT COUNT(*)::int AS n FROM hierarchies`))[0].n, 2);
  assert.equal((await q(`SELECT name FROM hierarchies WHERE id = 1`))[0].name, "Management", "no rename");
  assert.equal(await markerCount(), 0);
});

test("fail closed: duplicate standard manager names — rolls back rename too, no marker", async () => {
  await resetSchema();
  await pool.query(`INSERT INTO hierarchies (name, level) VALUES ('Management', 1)`);
  await pool.query(`INSERT INTO hierarchies (name, level, reports_to_id) VALUES ('Sales Manager', 2, 1), ('sales manager', 2, 1)`);

  await assert.rejects(() => runOrgHierarchyRestructure(pool), /roles are named 'Sales Manager'|duplicate role names/);

  assert.equal((await q(`SELECT name FROM hierarchies WHERE reports_to_id IS NULL`))[0].name, "Management", "rename rolled back with everything else");
  assert.equal((await q(`SELECT COUNT(*)::int AS n FROM hierarchies`))[0].n, 3);
  assert.equal(await markerCount(), 0);
});

test("fail closed: duplicate NON-standard role names — rolls back everything, no marker", async () => {
  await resetSchema();
  await pool.query(`INSERT INTO hierarchies (name, level) VALUES ('Management', 1)`);
  await pool.query(`INSERT INTO hierarchies (name, level, reports_to_id) VALUES ('Team A', 2, 1), ('  team a ', 2, 1)`);

  await assert.rejects(() => runOrgHierarchyRestructure(pool), /duplicate role names/);

  assert.equal((await q(`SELECT name FROM hierarchies WHERE reports_to_id IS NULL`))[0].name, "Management", "root rename rolled back — nothing mutated");
  assert.equal((await q(`SELECT COUNT(*)::int AS n FROM hierarchies`))[0].n, 3, "no roles created");
  assert.equal(await markerCount(), 0, "no marker — retries next boot after manual repair");
});

test("factory-reset helper: rebuilds tree under an Administrator-only table", async () => {
  await resetSchema();
  await pool.query(`INSERT INTO hierarchies (name, level, description) VALUES ('Administrator', 1, 'seeded by reset')`);

  await ensureStandardOrgTree(pool);

  const [mgmt] = await q(`SELECT id, level FROM hierarchies WHERE name = 'Management'`);
  assert.equal(mgmt.level, 2);
  assert.equal((await q(`SELECT COUNT(*)::int AS n FROM hierarchies WHERE reports_to_id = $1`, [mgmt.id]))[0].n, 7);
  assert.ok((await q(`SELECT COUNT(*)::int AS n FROM permissions WHERE hierarchy_id = $1`, [mgmt.id]))[0].n >= 40);
  assert.equal(await markerCount(), 0, "reset helper never writes the one-time marker");
});
