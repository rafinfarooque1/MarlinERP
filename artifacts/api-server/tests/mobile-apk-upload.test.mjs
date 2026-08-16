/**
 * Mobile APK direct-upload distribution — end-to-end regression suite.
 *
 * What this proves:
 *   [1] Admin can request a presigned upload URL, PUT a real APK-shaped file
 *       to object storage, and COMMIT it — the server validates the stored
 *       bytes (ZIP magic + EOCD + AndroidManifest.xml in the central
 *       directory) before the download pointer flips.
 *   [2] The public download endpoint streams the uploaded file byte-exact,
 *       with the professional filename and APK MIME type, to a phone that is
 *       NOT logged in.
 *   [3] Replace: uploading a second APK atomically flips the pointer — the
 *       download serves the new bytes.
 *   [4] Rejection wall: wrong extensions, empty files, oversize claims,
 *       non-ZIP bytes, ZIPs without AndroidManifest.xml, forged/unknown
 *       object paths — every probe is refused with a 400 and the published
 *       APK is untouched.
 *   [5] The four pointer keys are SERVER-MANAGED: a normal Settings PATCH
 *       carrying forged pointer values cannot alter them.
 *   [6] Authz: unauthenticated writes are 401; a level-4 employee gets 403 on
 *       upload/commit/remove (default-deny permissions) but CAN download.
 *   [7] Remove: DELETE clears the pointer, the public endpoint returns an
 *       honest 404, and the landing page says Android is unavailable.
 *
 * Fixtures: SQL bootstrap admin + one L4 user (zztestapk-*), removed at the
 * end. The dev DB holds REAL business data — the general_settings blob is
 * only ever round-tripped (GET → PATCH of the same object), never replaced
 * with a synthetic one, and the suite ends with the APK pointer removed
 * (the pre-existing state: no APK was published before this feature).
 *
 * KEEP_APK=1 leaves the last uploaded APK published and writes its sha256 to
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
const TAG = 'zztestapk';
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

// ── [0] Fixtures ────────────────────────────────────────────────────────────
console.log('\n[0] Fixtures');
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
  [`ZZAPK adm (${adminH.name})`, `${TAG}-adm`, HASH, adminH.id,
   `ZZAPK low (${lowH.name})`, `${TAG}-low`, lowH.id]);

const admLogin = await apiReq('POST', '/auth/login', { username: `${TAG}-adm`, password: PASSWORD });
const adm = admLogin.data?.token ?? '';
assert('Bootstrap admin login', !!adm, `status=${admLogin.status}`);
const lowLogin = await apiReq('POST', '/auth/login', { username: `${TAG}-low`, password: PASSWORD });
const low = lowLogin.data?.token ?? '';
assert('Low-level user login', !!low, `status=${lowLogin.status}`);
if (!adm) { await cleanupUsers(); process.exit(1); }

// Company name drives the download filename — derive, never hardcode.
const companyName = (await sql(`SELECT company_name FROM company_settings ORDER BY id LIMIT 1`)).rows[0]?.company_name || 'Marlin Frozen Fruits';
const safe = (s) => s.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
const expectedBase = safe(companyName) || 'ERP';

// ── Build test archives ─────────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'apk-test-'));
function buildZip(name, files) {
  const dir = join(tmp, name.replace(/\W+/g, '_'));
  execSync(`mkdir -p ${dir}`);
  for (const [fname, content] of Object.entries(files)) {
    if (content === 'RANDOM64K') execSync(`dd if=/dev/urandom of="${join(dir, fname)}" bs=1k count=64 2>/dev/null`);
    else writeFileSync(join(dir, fname), content);
  }
  const out = join(tmp, name);
  execSync(`cd ${dir} && zip -q "${out}" ${Object.keys(files).map((f) => `"${f}"`).join(' ')}`);
  return readFileSync(out);
}
const apk1 = buildZip('test1.apk', {
  'AndroidManifest.xml': '<manifest package="com.marlin.erp.test" versionName="1.0.0"/>',
  'classes.dex': 'RANDOM64K',
});
const apk2 = buildZip('test2.apk', {
  'AndroidManifest.xml': '<manifest package="com.marlin.erp.test" versionName="1.0.1"/>',
  'classes.dex': 'RANDOM64K',
  'resources.arsc': 'RANDOM64K',
});
const plainZip = buildZip('plain.apk', { 'readme.txt': 'not an app '.repeat(200) });
const textBytes = Buffer.from('This is just text pretending to be an APK. '.repeat(100));

async function uploadAndCommit(token, fileName, bytes, { claimSize, putBytes } = {}) {
  const urlRes = await apiReq('POST', '/company/mobile-app/apk/upload-url',
    { name: fileName, size: claimSize ?? bytes.length }, token);
  if (urlRes.status !== 200) return { step: 'upload-url', ...urlRes };
  const put = await fetch(urlRes.data.uploadURL, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/vnd.android.package-archive' },
    body: putBytes ?? bytes,
  });
  if (!put.ok) return { step: 'put', status: put.status };
  const commit = await apiReq('POST', '/company/mobile-app/apk',
    { objectPath: urlRes.data.objectPath, fileName }, token);
  return { step: 'commit', objectPath: urlRes.data.objectPath, uploadURL: urlRes.data.uploadURL, ...commit };
}

async function downloadApk() {
  const r = await fetch(`${BASE}/public/app/apk`);
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, buf, type: r.headers.get('content-type'), disp: r.headers.get('content-disposition') };
}

// ── [1] Upload + commit ─────────────────────────────────────────────────────
console.log('\n[1] Upload and publish a valid APK');
const up1 = await uploadAndCommit(adm, 'marlin-employee-v1.0.0.apk', apk1);
assert('Valid APK commits (200)', up1.step === 'commit' && up1.status === 200, JSON.stringify(up1.data ?? up1));
// The pointer must reference the immutable PUBLISHED COPY, never the upload
// object (whose presigned PUT URL stays alive for an hour after commit).
assert('Pointer is a published copy, not the writable upload object',
  typeof up1.data?.androidApkObjectPath === 'string'
  && up1.data.androidApkObjectPath.startsWith('/objects/uploads/mobile-apk/published-')
  && up1.data.androidApkObjectPath !== up1.objectPath
  && up1.data?.androidApkSize === apk1.length, JSON.stringify(up1.data));

// ── [2] Public download, byte-exact, no auth ────────────────────────────────
console.log('\n[2] Public download');
const dl1 = await downloadApk();
assert('Unauthenticated download is 200', dl1.status === 200);
assert('Bytes are exactly what was uploaded', sha256(dl1.buf) === sha256(apk1), `${dl1.buf.length} vs ${apk1.length}`);
assert('MIME is the APK type', dl1.type === 'application/vnd.android.package-archive', String(dl1.type));
assert('Filename is professional and stable', !!dl1.disp && dl1.disp.includes(`${expectedBase}-Mobile`) && /\.apk"/.test(dl1.disp), String(dl1.disp));
const landing1 = await fetch(`${BASE}/public/app`, { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)' } });
const landingHtml1 = await landing1.text();
assert('Landing page shows the Download APK button', landing1.status === 200 && landingHtml1.includes('Download APK'));

// ── [3] Replace ─────────────────────────────────────────────────────────────
console.log('\n[3] Replace with a new version');
const up2 = await uploadAndCommit(adm, 'marlin-employee-v1.0.1.apk', apk2);
assert('Replacement APK commits (200)', up2.step === 'commit' && up2.status === 200, JSON.stringify(up2.data ?? up2));
const dl2 = await downloadApk();
assert('Download now serves the NEW bytes', dl2.status === 200 && sha256(dl2.buf) === sha256(apk2));
assert('New bytes differ from old (test is real)', sha256(apk1) !== sha256(apk2));

// ── [4] Rejection wall ──────────────────────────────────────────────────────
console.log('\n[4] Rejection wall (published APK must survive every probe)');
{
  const r = await apiReq('POST', '/company/mobile-app/apk/upload-url', { name: 'app.zip', size: 1000 }, adm);
  assert('.zip name refused at upload-url', r.status === 400, `status=${r.status}`);
}
{
  const r = await apiReq('POST', '/company/mobile-app/apk/upload-url', { name: 'setup.exe', size: 1000 }, adm);
  assert('.exe name refused', r.status === 400);
}
{
  const r = await apiReq('POST', '/company/mobile-app/apk/upload-url', { name: 'app.apk', size: 0 }, adm);
  assert('Zero-size claim refused', r.status === 400);
}
{
  const r = await apiReq('POST', '/company/mobile-app/apk/upload-url', { name: 'app.apk', size: 301 * 1024 * 1024 }, adm);
  assert('Oversize claim refused', r.status === 400);
}
{
  // The presigned PUT cannot bind size — claim a good size, upload EMPTY.
  const r = await uploadAndCommit(adm, 'empty.apk', Buffer.alloc(0), { claimSize: 5000, putBytes: Buffer.alloc(0) });
  assert('Empty stored object refused at commit', r.step === 'commit' && r.status === 400, JSON.stringify(r.data ?? r));
}
{
  const r = await uploadAndCommit(adm, 'nota.apk', textBytes);
  assert('Non-ZIP bytes refused at commit (bad magic)', r.step === 'commit' && r.status === 400, JSON.stringify(r.data ?? r));
}
{
  const r = await uploadAndCommit(adm, 'renamed.apk', plainZip);
  assert('ZIP without AndroidManifest.xml refused', r.step === 'commit' && r.status === 400, JSON.stringify(r.data ?? r));
}
{
  // A ZIP whose file CONTENT mentions "AndroidManifest.xml" but that has no
  // entry of that name — must fail the central-directory ENTRY parse.
  const crafted = buildZip('crafted.apk', { 'evil.txt': 'AndroidManifest.xml is mentioned here but never present. '.repeat(60) });
  const r = await uploadAndCommit(adm, 'crafted.apk', crafted);
  assert('Content merely MENTIONING the manifest name refused', r.step === 'commit' && r.status === 400, JSON.stringify(r.data ?? r));
}
{
  // Post-commit overwrite: the signed upload URL for the CURRENT published
  // APK is still valid — writing junk through it must not change what the
  // public download serves (it serves the published copy).
  const put = await fetch(up2.uploadURL, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/vnd.android.package-archive' },
    body: textBytes,
  });
  assert('Signed URL still accepts writes (the threat is real)', put.ok, `status=${put.status}`);
  const dl = await downloadApk();
  assert('Download is IMMUNE to post-commit overwrite of the upload object',
    dl.status === 200 && sha256(dl.buf) === sha256(apk2), `status=${dl.status}`);
}
{
  const r = await apiReq('POST', '/company/mobile-app/apk', { objectPath: '/objects/uploads/1/some-other-file', fileName: 'x.apk' }, adm);
  assert('Foreign object path refused (cannot point at attachments)', r.status === 400);
}
{
  const r = await apiReq('POST', '/company/mobile-app/apk', { objectPath: '/objects/uploads/mobile-apk/never-uploaded-uuid-0000', fileName: 'x.apk' }, adm);
  assert('Unknown upload reference refused', r.status === 400, `status=${r.status}`);
}
const dlAfterProbes = await downloadApk();
assert('Published APK untouched by every probe', dlAfterProbes.status === 200 && sha256(dlAfterProbes.buf) === sha256(apk2));

// ── [5] Pointer keys are server-managed ─────────────────────────────────────
console.log('\n[5] Settings PATCH cannot forge the pointer');
{
  const cur = await apiReq('GET', '/company/settings', undefined, adm);
  const blob = { ...(cur.data?.generalSettings ?? {}) };
  const before = blob.androidApkObjectPath;
  assert('Blob currently carries the real pointer', typeof before === 'string' && before.startsWith('/objects/uploads/mobile-apk/'));
  // Round-trip the REAL blob with a forged pointer — exactly what a
  // malicious/buggy Settings save would send.
  const forged = { ...blob, androidApkObjectPath: '/objects/uploads/1/steal-this', androidApkSize: 1 };
  const patch = await apiReq('PATCH', '/company/settings', { generalSettings: forged }, adm);
  assert('PATCH itself succeeds', patch.status === 200, `status=${patch.status}`);
  const after = await apiReq('GET', '/company/settings', undefined, adm);
  const gsAfter = after.data?.generalSettings ?? {};
  assert('Forged pointer was discarded, stored one preserved', gsAfter.androidApkObjectPath === before, String(gsAfter.androidApkObjectPath));
  assert('Stored size preserved too', Number(gsAfter.androidApkSize) === apk2.length, String(gsAfter.androidApkSize));
  const dl = await downloadApk();
  assert('Download still serves the real APK', dl.status === 200 && sha256(dl.buf) === sha256(apk2));
}

// ── [6] Authorization ───────────────────────────────────────────────────────
console.log('\n[6] Authorization');
{
  const r = await apiReq('POST', '/company/mobile-app/apk/upload-url', { name: 'a.apk', size: 100 });
  assert('Unauthenticated upload-url is 401', r.status === 401, `status=${r.status}`);
}
if (low) {
  const r1 = await apiReq('POST', '/company/mobile-app/apk/upload-url', { name: 'a.apk', size: 100 }, low);
  assert('Low-level user upload-url is 403', r1.status === 403, `status=${r1.status}`);
  const r2 = await apiReq('POST', '/company/mobile-app/apk', { objectPath: '/objects/uploads/mobile-apk/x-x-x-x-x', fileName: 'a.apk' }, low);
  assert('Low-level user commit is 403', r2.status === 403, `status=${r2.status}`);
  const r3 = await apiReq('DELETE', '/company/mobile-app/apk', undefined, low);
  assert('Low-level user remove is 403', r3.status === 403, `status=${r3.status}`);
}

// ── [7] Remove / end state ──────────────────────────────────────────────────
if (KEEP_APK) {
  console.log('\n[7] KEEP_APK=1 — leaving the APK published for the restart-persistence check');
  writeFileSync('/tmp/apk-test-state.json', JSON.stringify({ sha256: sha256(apk2), size: apk2.length }));
} else {
  console.log('\n[7] Remove restores the honest empty state');
  const del = await apiReq('DELETE', '/company/mobile-app/apk', undefined, adm);
  assert('Admin remove succeeds', del.status === 200, `status=${del.status}`);
  const dl = await downloadApk();
  assert('Download is an honest 404 after removal', dl.status === 404, `status=${dl.status}`);
  const landing = await fetch(`${BASE}/public/app`, { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)' } });
  const html = await landing.text();
  assert('Landing page says Android is not available', html.includes('not currently available'));
  const gs = (await apiReq('GET', '/company/settings', undefined, adm)).data?.generalSettings ?? {};
  assert('Pointer keys fully cleared from the blob', gs.androidApkObjectPath === undefined && gs.androidApkFileName === undefined && gs.androidApkSize === undefined && gs.androidApkUploadedAt === undefined);
}

// ── Cleanup ─────────────────────────────────────────────────────────────────
await cleanupUsers();
execSync(`rm -rf ${tmp}`);
await pool.end();

console.log(`\n${'─'.repeat(60)}\n${passed} passed, ${failed} failed${failures.length ? `\nFailed: ${failures.join('; ')}` : ''}`);
process.exit(failed > 0 ? 1 : 0);
