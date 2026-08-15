/**
 * Route-guard coverage audit — runs in CI / `pnpm typecheck` alongside
 * check-permissions.ts (Task: permission & location access health check).
 *
 * What it enforces, and why each rule is a security property:
 *
 *   1. Every WRITE endpoint (POST/PUT/PATCH/DELETE) must carry a
 *      requireModuleAction middleware guard — default-deny, five-action model —
 *      or appear in the EXEMPTIONS table below with a documented reason.
 *      A write without either is an endpoint any authenticated user can hit.
 *
 *   2. Every permission key a guard resolves to must be a registered sidebar
 *      page key. check-permissions.ts already verifies string-literal guard
 *      args; this scanner ALSO resolves const identifiers (the common pattern
 *      `const PERM = "page:/hr/rent"; requireModuleAction(PERM, "edit")`),
 *      which the literal-only regex there cannot see. A typo'd key in a const
 *      would deny everyone except level-1 forever, with no switch on the
 *      Permissions page to fix it.
 *
 *   3. The EXEMPTIONS table must stay exact: an entry whose route gained a
 *      guard, or whose route no longer exists, fails the check. Stale
 *      exemptions are how allowlists rot into blanket holes.
 *
 * GET endpoints are deliberately NOT required to carry guards: list/detail
 * reads are governed per-page where the data is sensitive, several lookup GETs
 * feed dropdowns on many pages, and the hierarchy/permission GETs must stay
 * unguarded so the client can resolve its own rights (see
 * artifacts/api-server/src/middleware/permissions.ts). LBAC (location scoping)
 * applies to reads inside handlers via dataScope and is exercised by the
 * API test suites, not by this static scan.
 *
 * Usage:
 *   tsx src/audit-route-guards.ts            # verify (exit 1 on violations)
 *   tsx src/audit-route-guards.ts --write    # also regenerate docs/PERMISSIONS_AUDIT.md
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGE_PERM_KEY_SET } from '../../artifacts/marlin-erp/src/lib/moduleRegistry';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROUTES_DIR = join(ROOT, 'artifacts/api-server/src/routes');
const DOC_PATH = join(ROOT, 'docs/PERMISSIONS_AUDIT.md');
const WRITE = process.argv.includes('--write');

// ── Exemptions — every write endpoint WITHOUT a requireModuleAction middleware
// guard must be listed here with the reason it is safe. Keyed "METHOD path".
// The verify step fails on (a) an unguarded write missing from this table and
// (b) a table entry whose route gained a guard or disappeared — both mean the
// table no longer describes reality.
const EXEMPTIONS: Record<string, string> = {
  // Authentication & self-service — the caller acts on their own account only.
  'POST /auth/login': 'Public credential entry point; rate-limited + lockout table.',
  'POST /auth/logout': 'Self-service; audit-log write only.',
  'POST /auth/change-password': 'Self-service; re-verifies the current password in-handler.',
  'PUT /auth/location-pref': 'Self display preference; never authority (LBAC unconditional).',
  'PATCH /auth/profile': 'Self-service; writes only the caller\'s own employee row.',

  // Level-1 administrator gates — stronger than any page right by design.
  'POST /admin/sales-renumber/preview': 'requireLevelOne() in-handler; level-1-only admin tool.',
  'POST /admin/sales-renumber/apply': 'requireLevelOne() in-handler; level-1-only admin tool.',
  'POST /admin/sales-renumber/reset-lock': 'requireLevelOne() in-handler; level-1-only admin tool.',
  'POST /accounting-periods/:year/:month/lock': 'requireModuleView + isAdmin() in-handler: month locking is level-1-only, deliberately above the five-action model.',
  'POST /accounting-periods/:year/:month/unlock': 'requireModuleView + isAdmin() in-handler + mandatory reason; level-1-only.',

  // Self-service business action — requester-only by construction.
  'POST /hr/leaves/:id/cancel': 'View-gated; handler enforces caller.id === leave.employee_id (only the requester may cancel a PENDING request; approvers reject instead, which records who/why).',

  // Dynamic guards — the page key depends on the request body, so the check
  // runs in-handler through the SAME requireModuleAction/hasModuleAction code.
  'POST /pdf/money-voucher': 'requireModuleAction(kindKey, "download") invoked in-handler — the receipt/payment page key is derived from the voucher kind in the body (any-of bound to request kind).',
  'POST /sales/:id/share-token': 'hasModuleAction(download on POS/Outstanding) + LBAC sale-scope check in-handler; token is minutes-lived.',

  // Uploads — write nothing readable by others.
  'POST /storage/uploads/request-url': 'Authenticated presigned-PUT only; object path embeds the uploader\'s employee id and reads are ACLed by mayReadObject (uploader or record-visibility).',
};

// ── Scanner ───────────────────────────────────────────────────────────────────

interface RouteInfo {
  file: string;
  line: number;
  method: string;
  path: string;
  /** middleware-position guards, e.g. "edit:page:/transfers|page:/sales/pos" */
  guards: string[];
  /** in-handler protections (dynamic guards, level gates, LBAC markers) */
  inBody: string[];
  /** resolved page keys referenced by any guard on this route */
  keys: string[];
}

const ROUTE_RE = /router\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2/g;
const GUARD_RE =
  /require(ModuleView|ModuleAction)\(\s*(\[[\s\S]*?\]|'[^']*'|"[^"]*"|[A-Za-z_$][\w.$]*)\s*(?:,\s*(['"](?:add|edit|delete|download)['"]|[A-Za-z_$][\w.$]*)\s*)?\)/g;
const CONST_RE = /const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(\[[\s\S]*?\]|['"]page:[^'"]*['"])/g;

const errors: string[] = [];

/** const NAME -> page keys, collected per file (names like PERM repeat across files). */
function collectConsts(src: string): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  const pending: Array<[string, string]> = [];
  for (const m of src.matchAll(CONST_RE)) {
    const lits = [...m[2].matchAll(/['"]([^'"]+)['"]/g)].map(x => x[1]);
    if (lits.length && lits.every(l => l.startsWith('page:'))) map[m[1]] = lits;
    else pending.push([m[1], m[2]]);
  }
  // Second pass: arrays composed of other consts, e.g.
  // const ANY_ASSET_VIEW = [PG_PURCHASES, PG_REGISTER, ...]
  for (const [name, expr] of pending) {
    const keys: string[] = [...expr.matchAll(/['"](page:[^'"]+)['"]/g)].map(x => x[1]);
    let ok = true;
    const bare = expr.replace(/(['"])(?:(?!\1).)*\1/g, '');
    for (const id of bare.match(/[A-Za-z_$][\w$]*/g) ?? []) {
      if (map[id]) keys.push(...map[id]);
      else ok = false;
    }
    if (ok && keys.length) map[name] = keys;
  }
  return map;
}

// Constants exported by the middleware itself (e.g. INVENTORY_VALUATION_PAGE).
const sharedConsts = collectConsts(
  readFileSync(join(ROOT, 'artifacts/api-server/src/middleware/permissions.ts'), 'utf8'),
);

function resolveKeys(
  arg: string,
  consts: Record<string, string[]>,
  where: string,
  strict: boolean,
): string[] {
  const keys: string[] = [...arg.matchAll(/['"]([^'"]+)['"]/g)].map(m => m[1]);
  // Strip string literals, then whatever identifiers remain must resolve.
  const withoutLits = arg.replace(/(['"])(?:(?!\1).)*\1/g, '');
  for (const id of withoutLits.match(/[A-Za-z_$][\w$]*/g) ?? []) {
    if (consts[id]) keys.push(...consts[id]);
    else if (sharedConsts[id]) keys.push(...sharedConsts[id]);
    else if (!['ModuleView', 'ModuleAction'].includes(id)) {
      if (strict) {
        errors.push(`${where}: guard argument "${id}" could not be resolved to page keys — use a string literal, an array of literals, or a const of page: literals in the same file.`);
      }
      // In-handler guards may derive the key from the request (bound to the
      // request kind); recorded as dynamic in the matrix, not an error.
    }
  }
  return keys;
}

function scan(): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const files = readdirSync(ROUTES_DIR).filter(f => f.endsWith('.ts') && f !== 'index.ts');
  for (const file of files) {
    const src = readFileSync(join(ROUTES_DIR, file), 'utf8');
    const consts = collectConsts(src);
    const matches = [...src.matchAll(ROUTE_RE)];
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const start = m.index!;
      const seg = src.slice(start, i + 1 < matches.length ? matches[i + 1].index! : src.length);
      const handlerIdx = seg.search(/(?:async\s*)?\(\s*req\b/);
      const head = handlerIdx > 0 ? seg.slice(0, handlerIdx) : seg;
      const body = handlerIdx > 0 ? seg.slice(handlerIdx) : seg;
      const line = src.slice(0, start).split('\n').length;
      const where = `artifacts/api-server/src/routes/${file}:${line}`;

      const guards: string[] = [];
      const inBody: string[] = [];
      const keys: string[] = [];

      for (const g of head.matchAll(GUARD_RE)) {
        const ks = resolveKeys(g[2], consts, where, true);
        keys.push(...ks);
        const action = g[1] === 'ModuleView' ? 'view' : (g[3] ?? '?').replace(/['"]/g, '');
        guards.push(`${action}: ${ks.join(', ')}`);
      }
      if (/requireHeadOffice\s*\(/.test(head)) guards.push('HO-only location gate');

      for (const g of body.matchAll(GUARD_RE)) {
        const ks = resolveKeys(g[2], consts, where, false);
        keys.push(...ks);
        const action = g[1] === 'ModuleView' ? 'view' : (g[3] ?? 'dynamic').replace(/['"]/g, '');
        inBody.push(`dynamic ${action}: ${ks.join(', ') || '(kind-derived)'}`);
      }
      for (const h of body.matchAll(/hasModuleAction\(\s*[^,]+,\s*(\[[\s\S]*?\]|'[^']*'|"[^"]*"|[A-Za-z_$][\w.$]*)\s*,\s*(['"]\w+['"]|[A-Za-z_$][\w.$]*)/g)) {
        const ks = resolveKeys(h[1], consts, where, false);
        keys.push(...ks);
        inBody.push(`hasModuleAction ${h[2].replace(/['"]/g, '')}: ${ks.join(', ')}`);
      }
      if (/requireLevelOne\s*\(|isLevelOneAdmin|\bisAdmin\s*\(/.test(body)) inBody.push('level-1 admin gate');
      if (/getUserDataScope|scopeSalesWhere|isLocationInScope|dataScope/.test(body)) inBody.push('LBAC');

      routes.push({ file, line, method: m[1].toUpperCase(), path: m[3], guards, inBody, keys });
    }
  }
  return routes;
}

// ── Policy checks ─────────────────────────────────────────────────────────────

const routes = scan();

// 2. Every resolved key must be a registered sidebar page.
for (const r of routes) {
  for (const k of r.keys) {
    if (!PAGE_PERM_KEY_SET.has(k)) {
      errors.push(
        `${r.file}:${r.line} ${r.method} ${r.path} guards on "${k}", which is not a registered sidebar page — nobody can grant or revoke it.`,
      );
    }
  }
}

// 1 + 3. Unguarded writes vs the exemption table, in both directions.
const seenExemptKeys = new Set<string>();
for (const r of routes) {
  if (r.method === 'GET') continue;
  const hasAction = r.guards.some(g => /^(add|edit|delete|download):/.test(g));
  const exKey = `${r.method} ${r.path}`;
  if (hasAction) {
    if (EXEMPTIONS[exKey]) {
      errors.push(`Stale exemption: "${exKey}" now carries a requireModuleAction guard — remove it from EXEMPTIONS in scripts/src/audit-route-guards.ts.`);
    }
    continue;
  }
  if (EXEMPTIONS[exKey]) {
    seenExemptKeys.add(exKey);
    continue;
  }
  errors.push(
    `${r.file}:${r.line} ${r.method} ${r.path} is a WRITE with no requireModuleAction middleware guard and no documented exemption. ` +
    `Add a guard (default-deny) or, if it is genuinely self-service/level-1-gated, add an EXEMPTIONS entry with the reason.`,
  );
}
for (const exKey of Object.keys(EXEMPTIONS)) {
  if (!seenExemptKeys.has(exKey)) {
    errors.push(`Stale exemption: "${exKey}" matches no route — remove it from EXEMPTIONS in scripts/src/audit-route-guards.ts.`);
  }
}

// ── Matrix document ───────────────────────────────────────────────────────────

function renderDoc(): string {
  const byFile = new Map<string, RouteInfo[]>();
  for (const r of routes) {
    if (!byFile.has(r.file)) byFile.set(r.file, []);
    byFile.get(r.file)!.push(r);
  }
  const writeCount = routes.filter(r => r.method !== 'GET').length;
  const guardedWrites = routes.filter(r => r.method !== 'GET' && r.guards.some(g => /^(add|edit|delete|download):/.test(g))).length;

  let out = `# Permission & Route-Guard Audit Matrix

**GENERATED FILE — do not edit by hand.**
Regenerate: \`pnpm --filter @workspace/scripts run audit:guards:write\`
Source of truth: \`scripts/src/audit-route-guards.ts\` (policy + exemptions) scanning \`artifacts/api-server/src/routes/*.ts\`.
This check runs in \`pnpm --filter @workspace/scripts run typecheck\`; an unguarded write endpoint fails CI.

## Model (unchanged by this audit)

- **Default-deny five-action RBAC** — \`requireModuleView\` / \`requireModuleAction(page-key, add|edit|delete|download)\`
  (\`artifacts/api-server/src/middleware/permissions.ts\`). Level-1 bypasses; a missing permission row denies.
- **Page keys** = \`page:\` + sidebar href, generated from \`artifacts/marlin-erp/src/lib/moduleRegistry.ts\`
  into \`artifacts/api-server/src/lib/pagePermissions.ts\` (checked by \`scripts/src/check-permissions.ts\`).
- **LBAC** (location scoping) is orthogonal and unconditional: page right runs first (403), location scope second
  (404 for foreign scoped resources). The sidebar location selector only narrows reads, never grants.
- **GET endpoints** are guarded per-page where sensitive; shared lookup GETs use any-of view guards. The
  hierarchy/permission GETs stay unguarded by design so clients can resolve their own rights.

## Client-side enforcement (verified by the health-check audit)

- **Route guard** — every App.tsx route wraps its page in \`PermGuard\` (AuthGuard + RoutePermissionGuard);
  \`scripts/src/check-permissions.ts\` check 6 fails CI when a route is missing its guard, guards with the
  wrong page's key, or resolves to an unregistered key (which would fall through unrestricted).
- **Selector lockdown** — non-HO users get read-only location labels, never dropdowns
  (\`useActingLocation.canChoose\`, \`LocationSelectField\`, \`LocationFilter\`); a single-option user sees
  text, not a picker. The server never trusts any of it: LBAC is unconditional
  (proved by \`artifacts/api-server/tests/permission-location-audit.test.mjs\` sections E/F).
- **No stale grants** — the Permissions page refetches after save (staleTime 0) and the server reads
  permission rows per-request, so a revocation applies to the very next call on the same token
  (proved by the same suite, section D).

## Summary

- Routes scanned: **${routes.length}** across ${byFile.size} route files
- Write endpoints: **${writeCount}**, of which **${guardedWrites}** carry \`requireModuleAction\` middleware
- Documented exemptions (self-service / level-1 / dynamic in-handler guards): **${Object.keys(EXEMPTIONS).length}**

## Documented write exemptions

| Endpoint | Why it is safe without \`requireModuleAction\` middleware |
| --- | --- |
${Object.entries(EXEMPTIONS).map(([k, v]) => `| \`${k}\` | ${v} |`).join('\n')}

## Full route matrix

Legend: **Guards** = middleware position (action: page keys). **In-handler** = dynamic permission checks,
level-1 admin gates, and LBAC markers detected inside the handler body.

`;
  for (const [file, rs] of [...byFile.entries()].sort()) {
    out += `### ${file}\n\n| Method | Path | Guards | In-handler |\n| --- | --- | --- | --- |\n`;
    for (const r of rs) {
      const guards = r.guards.length ? r.guards.map(g => `\`${g}\``).join('<br>') : (r.method === 'GET' ? '—' : (EXEMPTIONS[`${r.method} ${r.path}`] ? '*exempt (see table above)*' : '**MISSING**'));
      const inBody = r.inBody.length ? [...new Set(r.inBody)].map(g => `\`${g}\``).join('<br>') : '—';
      out += `| ${r.method} | \`${r.path}\` | ${guards} | ${inBody} |\n`;
    }
    out += '\n';
  }
  return out;
}

if (WRITE) {
  writeFileSync(DOC_PATH, renderDoc());
  console.log(`  wrote docs/PERMISSIONS_AUDIT.md (${routes.length} routes)`);
}

if (errors.length) {
  console.error(`\n✗ Route-guard audit failed (${errors.length}):\n`);
  for (const e of errors) console.error(`  • ${e}`);
  console.error('');
  process.exit(1);
}
console.log(`✓ Route guards OK — ${routes.length} routes, every write guarded or exempt with reason.`);
