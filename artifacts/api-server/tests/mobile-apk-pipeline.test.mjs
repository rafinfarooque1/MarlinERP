/**
 * Mobile APK automated-release pipeline — end-to-end regression suite.
 *
 * The Android release is produced by the EAS build pipeline
 * (scripts/release-android-apk.ts) and published through lib/apkRelease.ts:
 * a validated APK object + a manifest (uploads/mobile-apk/current.json) in
 * object storage. There is NO manual upload path any more — no upload
 * endpoints, no URL field, no manual version.
 *
 * What this proves:
 *   [1] Publishing through the pipeline's storage step (the internal
 *       apk-release-tool seam — identical code path to a real EAS release,
 *       minus the cloud build) makes the public download serve the bytes
 *       byte-exact, with the professional versioned filename and APK MIME,
 *       to a phone that is NOT logged in.
 *   [2] /public/app/info reports availability + version from the SAME
 *       manifest the download reads; the landing page shows the button.
 *   [3] Replace: a second publish atomically flips the manifest — the
 *       download serves the new bytes and info reports the new version.
 *   [4] Rejection wall: non-ZIP bytes, ZIPs without AndroidManifest.xml,
 *       content merely mentioning the manifest name, empty files, bad
 *       versions — every probe exits non-zero and the CURRENT release keeps
 *       serving untouched (failed publishes never reach the manifest).
 *   [5] The retired mobile-APK settings keys are stripped by the Settings
 *       PATCH — a forged pointer/URL/version can neither come back nor
 *       affect the download.
 *   [6] The old admin upload/commit/remove endpoints are GONE (404 even for
 *       an admin; 401 unauthenticated — auth still runs first).
 *   [7] Remove restores the honest empty state: download 404, landing page
 *       says unavailable, info says unavailable.
 *
 * Fixtures: SQL bootstrap admin + one L4 user (zztestapkp-*), removed at the
 * end. The dev DB holds REAL business data — general_settings is only ever
 * round-tripped. The storage bucket is SHARED with production, so the suite
 * refuses to run if a real (eas-build) release is currently published.
 *
 * KEEP_APK=1 leaves the last published APK live and writes its sha256 to
 * /tmp/apk-test-state.json so a workflow restart + re-download can prove
 * persistence across server restarts.
 */

import pg from 'pg';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.API_URL || 'http://localhost:8080/api';
const TAG = 'zztestapkp';
const PASSWORD = 'ZzTest!12345';
const HASH = '$2b$10$IuHNFJwf3V9qR9dujVlZA.Uk1CupNfxuIcDuQfpMDtwVekihk.0/C';
const KEEP_APK = process.env.KEEP_APK === '1';

let passed = 0, failed = 0;
const failures = [];
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; failures.push(label); }
}

async function apiReq(method, path, body, token, headers = {}) {
  const opts = { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(`${BASE}${path}`, opts);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, headers: r.headers };
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sql = (t, p) => pool.query(t, p);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function cleanupUsers() {
  await sql(`DELETE FROM login_attempts WHERE username LIKE $1`, [`${TAG}%`]).catch(() => {});
  await sql(`DELETE FROM login_lockouts WHERE username LIKE $1`, [`${TAG}%`]).catch(() => {});
  await sql(`DELETE FROM pay_components WHERE employee_id IN (SELECT id FROM employees WHERE username LIKE $1)`, [`${TAG}%`]).catch(() => {});
  await sql(`DELETE FROM employees WHERE username LIKE $1`, [`${TAG}%`]);
}

process.on('unhandledRejection', async (err) => {
  console.error('FATAL (unhandled):', err);
  try { await cleanupUsers(); } catch { /* best effort */ }
  process.exit(1);
});

// ── Release-tool driver (the pipeline's storage step) ───────────────────────
// Runs from the api-server dir so PRIVATE_OBJECT_DIR etc. are inherited.
function tool(args) {
  try {
    const out = execSync(`pnpm exec tsx scripts/apk-release-tool.ts ${args}`, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

// Node's undici pools keep-alive sockets; after a multi-second gap (the CLI
// probes) the server may have idle-closed one, and reusing it throws
// UND_ERR_SOCKET. Retry once on a fresh connection — a network-layer
// artefact of the test client, not server behaviour under test.
async function fetchRetry(url, opts) {
  try { return await fetch(url, opts); }
  catch { return await fetch(url, opts); }
}

async function downloadApk() {
  const r = await fetchRetry(`${BASE}/public/app/apk`);
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, buf, type: r.headers.get('content-type'), disp: r.headers.get('content-disposition') };
}

// ── [0] Fixtures + safety gate ──────────────────────────────────────────────
console.log('\n[0] Fixtures');
{
  // The bucket is shared with production: never clobber a REAL release.
  const cur = tool('show');
  const isReal = cur.out.includes('"source": "eas-build"');
  if (isReal) {
    console.error('A real (eas-build) release is currently published — refusing to run the destructive suite.');
    process.exit(2);
  }
}
await cleanupUsers(); // heal a crashed previous run

const hier = (await sql(`SELECT id, name, level FROM hierarchies ORDER BY level, id`)).rows;
const adminH = hier.find((h) => Number(h.level) === 1);
const lowH = [...hier].reverse().find((h) => Number(h.level) >= 3);
assert('Hierarchy tree yields an L1 admin and a low-level role', !!adminH && !!lowH, JSON.stringify(hier));
if (!adminH || !lowH) { await cleanupUsers(); process.exit(1); }

await sql(
  `INSERT INTO employees (name, username, password_hash, hierarchy_id, branch_type, branch_id, salary, is_active, join_date)
   VALUES ($1, $2, $3, $4, 'headoffice', 1, 0, true, '2026-08-01'),
          ($5, $6, $3, $7, 'warehouse', 1, 0, true, '2026-08-01')`,
  [`ZZAPKP adm (${adminH.name})`, `${TAG}-adm`, HASH, adminH.id,
   `ZZAPKP low (${lowH.name})`, `${TAG}-low`, lowH.id]);

const admLogin = await apiReq('POST', '/auth/login', { username: `${TAG}-adm`, password: PASSWORD });
const adm = admLogin.data?.token ?? '';
assert('Bootstrap admin login', !!adm, `status=${admLogin.status}`);
if (!adm) { await cleanupUsers(); process.exit(1); }

// Company name drives the download filename — derive, never hardcode.
const companyName = (await sql(`SELECT company_name FROM company_settings ORDER BY id LIMIT 1`)).rows[0]?.company_name || 'Marlin Frozen Fruits';
const safe = (s) => s.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
const expectedBase = safe(companyName) || 'ERP';

// ── Build test archives ─────────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'apk-pipe-test-'));
function buildZip(name, files) {
  const dir = join(tmp, name.replace(/\W+/g, '_'));
  execSync(`mkdir -p ${dir}`);
  for (const [fname, content] of Object.entries(files)) {
    if (content === 'RANDOM64K') execSync(`dd if=/dev/urandom of="${join(dir, fname)}" bs=1k count=64 2>/dev/null`);
    else writeFileSync(join(dir, fname), content);
  }
  const out = join(tmp, name);
  execSync(`cd ${dir} && zip -q "${out}" ${Object.keys(files).map((f) => `"${f}"`).join(' ')}`);
  return out;
}
const apk1Path = buildZip('test1.apk', {
  'AndroidManifest.xml': '<manifest package="com.marlin.employeeapp" versionName="9.9.1"/>',
  'classes.dex': 'RANDOM64K',
});
const apk2Path = buildZip('test2.apk', {
  'AndroidManifest.xml': '<manifest package="com.marlin.employeeapp" versionName="9.9.2"/>',
  'classes.dex': 'RANDOM64K',
  'resources.arsc': 'RANDOM64K',
});
const plainZipPath = buildZip('plain.apk', { 'readme.txt': 'not an app '.repeat(200) });
const craftedPath = buildZip('crafted.apk', { 'evil.txt': 'AndroidManifest.xml is mentioned here but never present. '.repeat(60) });
const textPath = join(tmp, 'text.apk');
writeFileSync(textPath, 'This is just text pretending to be an APK. '.repeat(100));
const emptyPath = join(tmp, 'empty.apk');
writeFileSync(emptyPath, '');
const apk1 = readFileSync(apk1Path);
const apk2 = readFileSync(apk2Path);

// ── [1] Publish through the pipeline's storage step ─────────────────────────
console.log('\n[1] Publish a valid APK through the pipeline seam');
{
  const r = tool(`publish "${apk1Path}" --version 9.9.1 --source local-file`);
  assert('Publish succeeds (exit 0)', r.code === 0, r.out.slice(0, 400));
  assert('Manifest points at an immutable published object',
    r.out.includes('"publishedPath": "/objects/uploads/mobile-apk/published-'), r.out.slice(0, 400));
  assert('Manifest records the version', r.out.includes('"version": "9.9.1"'));
  assert('Manifest records the sha256', r.out.includes(`"sha256": "${sha256(apk1)}"`));
}

// ── [2] Public download + info, byte-exact, no auth ─────────────────────────
console.log('\n[2] Public download and info');
const dl1 = await downloadApk();
assert('Unauthenticated download is 200', dl1.status === 200);
assert('Bytes are exactly what the pipeline published', sha256(dl1.buf) === sha256(apk1), `${dl1.buf.length} vs ${apk1.length}`);
assert('MIME is the APK type', dl1.type === 'application/vnd.android.package-archive', String(dl1.type));
assert('Filename is professional, versioned from the manifest',
  !!dl1.disp && dl1.disp.includes(`${expectedBase}-Mobile-v9.9.1.apk`), String(dl1.disp));
{
  const info = await apiReq('GET', '/public/app/info');
  assert('info is public (200, no auth)', info.status === 200, `status=${info.status}`);
  assert('info reports Android available with the manifest version',
    info.data?.android?.available === true && info.data?.android?.version === '9.9.1', JSON.stringify(info.data));
  assert('info reports the size', Number(info.data?.android?.size) === apk1.length, JSON.stringify(info.data?.android));
}
{
  const landing = await fetchRetry(`${BASE}/public/app`, { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)' } });
  const html = await landing.text();
  assert('Landing page shows the Download APK button + version',
    landing.status === 200 && html.includes('Download APK') && html.includes('Version 9.9.1'));
}

// ── [3] Replace ─────────────────────────────────────────────────────────────
console.log('\n[3] Replace with a new build');
{
  const r = tool(`publish "${apk2Path}" --version 9.9.2 --source local-file`);
  assert('Replacement publish succeeds', r.code === 0, r.out.slice(0, 400));
  const dl = await downloadApk();
  assert('Download now serves the NEW bytes', dl.status === 200 && sha256(dl.buf) === sha256(apk2));
  assert('New bytes differ from old (test is real)', sha256(apk1) !== sha256(apk2));
  const info = await apiReq('GET', '/public/app/info');
  assert('info reports the new version', info.data?.android?.version === '9.9.2', JSON.stringify(info.data?.android));
}

// ── [4] Rejection wall ──────────────────────────────────────────────────────
console.log('\n[4] Rejection wall (current release must survive every probe)');
{
  const r = tool(`publish "${textPath}" --version 9.9.3`);
  assert('Non-ZIP bytes refused (exit non-zero)', r.code !== 0, r.out.slice(0, 200));
}
{
  const r = tool(`publish "${emptyPath}" --version 9.9.3`);
  assert('Empty file refused', r.code !== 0);
}
{
  const r = tool(`publish "${plainZipPath}" --version 9.9.3`);
  assert('ZIP without AndroidManifest.xml refused', r.code !== 0, r.out.slice(0, 200));
}
{
  const r = tool(`publish "${craftedPath}" --version 9.9.3`);
  assert('Content merely MENTIONING the manifest name refused', r.code !== 0, r.out.slice(0, 200));
}
{
  const r = tool(`publish "${apk1Path}" --version "9.9.3; rm -rf /"`);
  assert('Malformed version refused', r.code !== 0, r.out.slice(0, 200));
}
{
  const dl = await downloadApk();
  assert('Current release untouched by every probe', dl.status === 200 && sha256(dl.buf) === sha256(apk2));
  const info = await apiReq('GET', '/public/app/info');
  assert('info still reports the surviving version', info.data?.android?.version === '9.9.2');
}

// ── [5] Retired settings keys are stripped ──────────────────────────────────
console.log('\n[5] Settings PATCH strips the retired mobile-APK keys');
{
  const cur = await apiReq('GET', '/company/settings', undefined, adm);
  assert('Settings GET works', cur.status === 200, `status=${cur.status}`);
  const blob = { ...(cur.data?.generalSettings ?? {}) };
  // Forge every retired key — exactly what an old client or an attacker
  // round-tripping the blob would send.
  const forged = {
    ...blob,
    androidApkObjectPath: '/objects/uploads/1/steal-this',
    androidApkFileName: 'evil.apk',
    androidApkSize: 1,
    androidApkUploadedAt: '2020-01-01T00:00:00Z',
    androidApkUrl: 'https://evil.example/app.apk',
    androidAppVersion: '666',
  };
  const patch = await apiReq('PATCH', '/company/settings', { generalSettings: forged }, adm);
  assert('PATCH itself succeeds', patch.status === 200, `status=${patch.status} ${JSON.stringify(patch.data).slice(0, 200)}`);
  const after = await apiReq('GET', '/company/settings', undefined, adm);
  const gs = after.data?.generalSettings ?? {};
  assert('Every retired key is absent after the save',
    gs.androidApkObjectPath === undefined && gs.androidApkFileName === undefined
    && gs.androidApkSize === undefined && gs.androidApkUploadedAt === undefined
    && gs.androidApkUrl === undefined && gs.androidAppVersion === undefined,
    JSON.stringify({ p: gs.androidApkObjectPath, u: gs.androidApkUrl, v: gs.androidAppVersion }));
  const dl = await downloadApk();
  assert('Download still serves the pipeline release (settings cannot steer it)',
    dl.status === 200 && sha256(dl.buf) === sha256(apk2));
}

// ── [6] The manual upload endpoints are GONE ────────────────────────────────
console.log('\n[6] Removed admin upload endpoints');
{
  const r = await apiReq('POST', '/company/mobile-app/apk/upload-url', { name: 'a.apk', size: 100 }, adm);
  assert('upload-url is 404 even for an admin', r.status === 404, `status=${r.status}`);
}
{
  const r = await apiReq('POST', '/company/mobile-app/apk', { objectPath: '/objects/uploads/mobile-apk/x', fileName: 'a.apk' }, adm);
  assert('commit is 404 even for an admin', r.status === 404, `status=${r.status}`);
}
{
  const r = await apiReq('DELETE', '/company/mobile-app/apk', undefined, adm);
  assert('remove is 404 even for an admin', r.status === 404, `status=${r.status}`);
}
{
  const r = await apiReq('POST', '/company/mobile-app/apk/upload-url', { name: 'a.apk', size: 100 });
  assert('Unauthenticated write still hits auth first (401)', r.status === 401, `status=${r.status}`);
}

// ── [7] Remove / end state ──────────────────────────────────────────────────
if (KEEP_APK) {
  console.log('\n[7] KEEP_APK=1 — leaving the release published for the restart-persistence check');
  writeFileSync('/tmp/apk-test-state.json', JSON.stringify({ sha256: sha256(apk2), size: apk2.length }));
} else {
  console.log('\n[7] Remove restores the honest empty state');
  const r = tool('remove');
  assert('Remove succeeds', r.code === 0, r.out.slice(0, 200));
  const dl = await downloadApk();
  assert('Download is an honest 404 after removal', dl.status === 404, `status=${dl.status}`);
  const info = await apiReq('GET', '/public/app/info');
  assert('info reports Android unavailable', info.data?.android?.available === false, JSON.stringify(info.data));
  const landing = await fetchRetry(`${BASE}/public/app`, { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)' } });
  const html = await landing.text();
  assert('Landing page says Android is not available', html.includes('not currently available'));
}

// ── Cleanup ─────────────────────────────────────────────────────────────────
await cleanupUsers();
execSync(`rm -rf ${tmp}`);
await pool.end();

console.log(`\n${'─'.repeat(60)}\n${passed} passed, ${failed} failed${failures.length ? `\nFailed: ${failures.join('; ')}` : ''}`);
process.exit(failed > 0 ? 1 : 0);
