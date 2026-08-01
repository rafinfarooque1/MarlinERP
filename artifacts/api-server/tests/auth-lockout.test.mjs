/**
 * Login brute-force lockout — durable, race-safe, clearly communicated.
 *
 * The contract under test: lockout state lives in the login_lockouts TABLE,
 * not process memory. Five failures inside a 15-minute window lock the
 * account for 15 minutes; the lock self-expires; a successful login wipes
 * the counter; a genuine lock answers 429 with the remaining time — never a
 * generic "invalid credentials".
 *
 * Restart-equivalence: a real process restart cannot run inside this suite,
 * so it is proven the way it matters — state injected into the DB from
 * OUTSIDE the server process (direct SQL) is enforced by the API, and state
 * created via the API is visible in the DB. Nothing consulted lives in
 * memory, so a fresh process necessarily sees the same lock.
 *
 * Disposable fixture only — creates its own employee, cleans up at the end.
 * NEVER uses 'admin': locking the real admin account would break the dev
 * environment for everyone.
 */
import pg from "pg";
import bcrypt from "bcryptjs";
import { spawn } from "node:child_process";

const BASE = "http://localhost:8080/api";
const sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (text, params = []) => (await sql.query(text, params)).rows;

const USER = "lockout_probe_user";
const PASS = "Lockout#Probe1";
const WRONG = "definitely-wrong";

const results = [];
function check(id, desc, pass, detail) {
  results.push({ id, desc, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}  ${desc}${detail ? `\n        ${detail}` : ""}`);
}

async function login(username, password) {
  const r = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  let body;
  try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body, retryAfter: r.headers.get("retry-after") };
}

async function lockRow() {
  const [row] = await q(`SELECT * FROM login_lockouts WHERE username = $1`, [USER]);
  return row ?? null;
}
async function resetLockState() {
  await q(`DELETE FROM login_lockouts WHERE username = $1`, [USER]);
}

// ── Fixture ──────────────────────────────────────────────────────────────────
async function setup() {
  await teardown(); // idempotent
  const hash = bcrypt.hashSync(PASS, 10);
  await q(
    `INSERT INTO employees (name, username, password_hash, hierarchy_id, branch_type, branch_id, salary, join_date, is_active, must_change_password)
     SELECT 'Lockout Probe', $1, $2, (SELECT MIN(id) FROM hierarchies), 'headoffice', 1, 1, CURRENT_DATE, true, false`,
    [USER, hash],
  );
}
async function teardown() {
  await q(`DELETE FROM login_lockouts WHERE username = $1`, [USER]);
  await q(`DELETE FROM login_attempts WHERE username IN ($1, ' ' || $1 || ' ', UPPER($1))`, [USER]);
  await q(`DELETE FROM employees WHERE username = $1`, [USER]);
}

// ── Tests ────────────────────────────────────────────────────────────────────
await setup();
try {
  // 1. Correct credentials, first try.
  {
    const r = await login(USER, PASS);
    check("T1", "correct credentials log in on the first attempt", r.status === 200 && !!r.body?.token, `status=${r.status}`);
  }

  // 2. Wrong password → generic 401, never a lockout message.
  {
    const r = await login(USER, WRONG);
    check("T2", "wrong password → 401 with the generic message",
      r.status === 401 && r.body?.error === "Invalid username or password", `status=${r.status} body=${JSON.stringify(r.body)}`);
  }

  // 3. Lockout after 5 failures within the window (1 already recorded above).
  {
    for (let i = 0; i < 4; i++) await login(USER, WRONG);
    const row = await lockRow();
    const locked = row && row.locked_until && new Date(row.locked_until) > new Date();
    check("T3", "5th failure locks the account in the durable store",
      !!locked && row.failure_count === 5, `row=${JSON.stringify(row)}`);
  }

  // 4. While locked, even CORRECT credentials answer 429 with remaining time.
  {
    const r = await login(USER, PASS);
    const msgOk = /Too many failed attempts\. Please try again in \d+ minutes?\./.test(r.body?.error ?? "");
    check("T4", "locked + correct password → 429 lockout message with minutes (not invalid-credentials)",
      r.status === 429 && msgOk && !!r.retryAfter, `status=${r.status} error=${JSON.stringify(r.body?.error)} retryAfter=${r.retryAfter}`);
  }

  // 5. Restart-equivalence: a lock injected from OUTSIDE the server process is
  //    enforced (nothing in memory is consulted), and clearing it outside the
  //    process is honored immediately.
  {
    await resetLockState();
    await q(
      `INSERT INTO login_lockouts (username, failure_count, window_started_at, locked_until)
       VALUES ($1, 5, now(), now() + interval '10 minutes')`, [USER],
    );
    const r = await login(USER, PASS);
    check("T5", "lock written directly to the DB (simulated pre-restart state) is enforced",
      r.status === 429, `status=${r.status}`);
  }

  // 6. Lock expiry: an expired lock lets the correct password in, and success
  //    clears the row entirely.
  {
    await q(`UPDATE login_lockouts SET locked_until = now() - interval '1 second' WHERE username = $1`, [USER]);
    const r = await login(USER, PASS);
    const row = await lockRow();
    check("T6", "expired lock → correct password logs in and the counter is wiped",
      r.status === 200 && row === null, `status=${r.status} row=${JSON.stringify(row)}`);
  }

  // 7. Success clears the counter: 4 failures, then success, then 4 more
  //    failures must NOT lock (the window restarted from zero).
  {
    for (let i = 0; i < 4; i++) await login(USER, WRONG);
    const mid = await login(USER, PASS);
    for (let i = 0; i < 4; i++) await login(USER, WRONG);
    const row = await lockRow();
    const locked = row && row.locked_until && new Date(row.locked_until) > new Date();
    check("T7", "a successful login resets the failure counter",
      mid.status === 200 && !locked && row?.failure_count === 4, `mid=${mid.status} row=${JSON.stringify(row)}`);
    await resetLockState();
  }

  // 8. Stale window: failures older than the window do not accumulate.
  {
    await q(
      `INSERT INTO login_lockouts (username, failure_count, window_started_at, locked_until)
       VALUES ($1, 4, now() - interval '20 minutes', NULL)`, [USER],
    );
    await login(USER, WRONG); // would be the 5th — but the window is stale
    const row = await lockRow();
    const locked = row && row.locked_until && new Date(row.locked_until) > new Date();
    check("T8", "failures outside the 15-minute window reset instead of accumulating",
      !locked && row?.failure_count === 1, `row=${JSON.stringify(row)}`);
    await resetLockState();
  }

  // 9. Whitespace and case variants reach the same account AND the same lock counter.
  {
    const r1 = await login(`  ${USER}  `, PASS);
    const r2 = await login(USER.toUpperCase(), PASS);
    await login(` ${USER} `, WRONG);
    await login(USER.toUpperCase(), WRONG);
    const row = await lockRow(); // key is normalized → one row
    check("T9", "whitespace/case variants log in fine and share one lock counter",
      r1.status === 200 && r2.status === 200 && row?.failure_count === 2, `r1=${r1.status} r2=${r2.status} row=${JSON.stringify(row)}`);
    await resetLockState();
  }

  // 10. Inactive user → 403 deactivated (not lockout, not generic 401).
  {
    await q(`UPDATE employees SET is_active = false WHERE username = $1`, [USER]);
    const r = await login(USER, PASS);
    check("T10", "deactivated account → 403 with the deactivation message",
      r.status === 403 && /deactivated/i.test(r.body?.error ?? ""), `status=${r.status} body=${JSON.stringify(r.body)}`);
    await q(`UPDATE employees SET is_active = true WHERE username = $1`, [USER]);
    await resetLockState();
  }

  // 11. Concurrency: 6 simultaneous wrong-password attempts must not corrupt
  //     the counter — every failure counted exactly once, row locked.
  {
    const rs = await Promise.all(Array.from({ length: 6 }, () => login(USER, WRONG)));
    const failures401 = rs.filter((r) => r.status === 401).length;
    const rejected429 = rs.filter((r) => r.status === 429).length;
    const row = await lockRow();
    const locked = row && row.locked_until && new Date(row.locked_until) > new Date();
    // Every 401 incremented the counter exactly once; 429s never reached the
    // counter. Total responses must be exactly 6 (none dropped or doubled).
    check("T11", "6 concurrent failures → counter equals the 401 count, account locked, nothing lost",
      failures401 + rejected429 === 6 && row?.failure_count === failures401 && failures401 >= 5 && !!locked,
      `401s=${failures401} 429s=${rejected429} row=${JSON.stringify(row)}`);
    await resetLockState();
  }

  // 12b placeholder — see T13 below for the DB-level identity invariant.
  // 13. DB invariant matches login normalization: a whitespace/case variant of
  //     an existing username cannot be inserted even by raw SQL.
  {
    let blocked = false;
    try {
      await q(
        `INSERT INTO employees (name, username, password_hash, hierarchy_id, branch_type, branch_id, salary, join_date, is_active)
         SELECT 'Dupe Probe', '  ' || UPPER($1) || ' ', 'x', (SELECT MIN(id) FROM hierarchies), 'headoffice', 1, 1, CURRENT_DATE, true`,
        [USER],
      );
    } catch (e) {
      blocked = /employees_username_norm_unique|duplicate key/.test(String(e.message));
    }
    check("T13", "whitespace/case-variant duplicate username is blocked at the DB level", blocked);
    await q(`DELETE FROM employees WHERE name = 'Dupe Probe'`); // in case it slipped in
  }

  // 14. A STORED username carrying whitespace (inserted by raw SQL — the app
  //     always trims) can still authenticate: lookup normalizes both sides.
  {
    const padded = "  lockspace_probe  ";
    await q(`DELETE FROM employees WHERE TRIM(username) = 'lockspace_probe'`);
    await q(
      `INSERT INTO employees (name, username, password_hash, hierarchy_id, branch_type, branch_id, salary, join_date, is_active, must_change_password)
       SELECT 'Whitespace Probe', $1, $2, (SELECT MIN(id) FROM hierarchies), 'headoffice', 1, 1, CURRENT_DATE, true, false`,
      [padded, bcrypt.hashSync(PASS, 10)],
    );
    const r = await login("lockspace_probe", PASS);
    check("T14", "stored username with surrounding whitespace still logs in via the normalized lookup",
      r.status === 200, `status=${r.status}`);
    await q(`DELETE FROM login_lockouts WHERE username = 'lockspace_probe'`);
    await q(`DELETE FROM login_attempts WHERE TRIM(username) = 'lockspace_probe'`);
    await q(`DELETE FROM employees WHERE TRIM(username) = 'lockspace_probe'`);
  }

  // 15. Migration regression: username_normalization_v1 must reconcile
  //     whitespace/case-COLLIDING usernames deterministically instead of
  //     failing (a failed boot step here once risked leaving login_lockouts
  //     uncreated). Re-runs the REAL boot migration by seeding a collision,
  //     removing the migration_log guard + index, and spawning the built
  //     server once on a scratch port.
  {
    const A = "collide_probe";
    await q(`DELETE FROM employees WHERE TRIM(username) ILIKE 'collide_probe%'`);
    await q(`DELETE FROM migration_log WHERE name = 'username_normalization_v1'`);
    await q(`DROP INDEX IF EXISTS employees_username_norm_unique`);
    const hash = bcrypt.hashSync(PASS, 10);
    const [{ id: idA }] = await q(
      `INSERT INTO employees (name, username, password_hash, hierarchy_id, branch_type, branch_id, salary, join_date, is_active, must_change_password)
       SELECT 'Collide A', $1, $2, (SELECT MIN(id) FROM hierarchies), 'headoffice', 1, 1, CURRENT_DATE, true, false RETURNING id`,
      [`${A} `, hash], // trailing space
    );
    const [{ id: idB }] = await q(
      `INSERT INTO employees (name, username, password_hash, hierarchy_id, branch_type, branch_id, salary, join_date, is_active, must_change_password)
       SELECT 'Collide B', $1, $2, (SELECT MIN(id) FROM hierarchies), 'headoffice', 1, 1, CURRENT_DATE, true, false RETURNING id`,
      [` ${A.toUpperCase()}`, hash], // leading space + case variant → same LOWER(TRIM()) identity
    );

    // Boot the real server once (all boot migrations are idempotent and run on
    // every start anyway); wait for the migration_log row, then stop it.
    const child = spawn("node", ["--enable-source-maps", "./dist/index.mjs"], {
      env: { ...process.env, PORT: "8099", NODE_ENV: "development" },
      stdio: "ignore",
      cwd: new URL("..", import.meta.url).pathname,
    });
    let migrated = false;
    for (let i = 0; i < 60 && !migrated; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      migrated = (await q(`SELECT 1 FROM migration_log WHERE name = 'username_normalization_v1'`)).length > 0;
    }
    child.kill("SIGTERM");

    const [rowA] = await q(`SELECT username FROM employees WHERE id = $1`, [idA]);
    const [rowB] = await q(`SELECT username FROM employees WHERE id = $1`, [idB]);
    const [idx] = await q(`SELECT 1 AS ok FROM pg_indexes WHERE indexname = 'employees_username_norm_unique'`);
    const loginA = await login(A, PASS); // oldest row keeps the (trimmed) name
    check("T15", "colliding usernames: oldest keeps the trimmed name, newer is renamed '<name>_<id>', index restored, kept account logs in",
      migrated && !!idx && rowA?.username === A && rowB?.username === `${A.toUpperCase()}_${idB}` && loginA.status === 200,
      `migrated=${migrated} idx=${!!idx} A=${JSON.stringify(rowA?.username)} B=${JSON.stringify(rowB?.username)} loginA=${loginA.status}`);

    await q(`DELETE FROM login_lockouts WHERE username LIKE 'collide_probe%'`);
    await q(`DELETE FROM login_attempts WHERE username = $1`, [A]);
    await q(`DELETE FROM employees WHERE id IN ($1, $2)`, [idA, idB]);
  }

  // 12. Unknown username failures are also throttled (no enumeration via
  //     unlimited guessing), with the same generic 401 until the lock.
  {
    const ghost = "no_such_user_lockout_probe";
    await q(`DELETE FROM login_lockouts WHERE username = $1`, [ghost]);
    let last;
    for (let i = 0; i < 5; i++) last = await login(ghost, WRONG);
    const after = await login(ghost, WRONG);
    check("T12", "unknown usernames throttle identically (generic 401s, then 429)",
      last.status === 401 && after.status === 429, `last=${last.status} after=${after.status}`);
    await q(`DELETE FROM login_lockouts WHERE username = $1`, [ghost]);
    await q(`DELETE FROM login_attempts WHERE username = $1`, [ghost]);
  }
} finally {
  await teardown();
  await sql.end();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
