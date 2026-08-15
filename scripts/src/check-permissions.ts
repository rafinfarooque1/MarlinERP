/**
 * Permission integrity check — runs in CI / `pnpm typecheck`.
 *
 * The sidebar registry (marlin-erp src/lib/moduleRegistry.ts) is the single
 * source of truth for permission keys. Three things can silently drift from it,
 * and each one is a security hole rather than a cosmetic bug:
 *
 *   1. A guard naming a module that does not exist. `requireModuleView("Bokos")`
 *      never matches a row, so it is either permanently denied or — worse, in a
 *      default-allow world — permanently open. Either way no admin can find the
 *      switch, because the Permissions page only lists registered keys.
 *
 *   2. The backend's copy of the key list going stale. The seeding migration
 *      needs the same list the UI renders; if they disagree, new roles get rows
 *      for pages that no longer exist and none for pages that do.
 *
 *   3. The sidebar changing shape. Per-link permissions are derived from the
 *      nav, so a nav edit silently rewrites who can see what. The snapshot makes
 *      that impossible to do by accident.
 *
 * Usage:
 *   tsx src/check-permissions.ts           # verify (exit 1 on drift)
 *   tsx src/check-permissions.ts --write   # regenerate the artefacts
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PAGE_PERM_KEYS,
  PAGE_PERM_KEY_SET,
  LEGACY_MODULE_TO_PAGES,
  getPagePermRows,
  getNavGroups,
  MODULE_REGISTRY,
  permKeyForRoute,
} from '../../artifacts/marlin-erp/src/lib/moduleRegistry';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WRITE = process.argv.includes('--write');

const GENERATED_BACKEND = join(ROOT, 'artifacts/api-server/src/lib/pagePermissions.ts');
const SIDEBAR_SNAPSHOT = join(ROOT, 'scripts/sidebar-snapshot.json');

const errors: string[] = [];
const notes: string[] = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, exts));
    else if (exts.some(e => name.endsWith(e))) out.push(p);
  }
  return out;
}

/** Pull every quoted string out of a captured call argument. */
function literals(arg: string): string[] {
  return [...arg.matchAll(/['"]([^'"]*)['"]/g)].map(m => m[1]);
}

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split('\n').length;
}

// ── 1. Backend guard names must be registered ─────────────────────────────────

const GUARD_RE = /require(?:ModuleView|ModuleAction)\(\s*(\[[^\]]*\]|'[^']*'|"[^"]*")/g;

for (const file of walk(join(ROOT, 'artifacts/api-server/src'), ['.ts'])) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(GUARD_RE)) {
    for (const name of literals(m[1])) {
      if (PAGE_PERM_KEY_SET.has(name)) continue;
      errors.push(
        `${relative(ROOT, file)}:${lineOf(src, m.index!)} guards on "${name}", which is not a sidebar page. ` +
        `Nobody can grant or revoke it. Use one of the keys in PAGE_PERM_KEYS.`,
      );
    }
  }
}

// ── 2. Frontend permission checks must be registered ──────────────────────────

const FE_RE = /(?:usePermission|resolvePermissions)\(\s*(\[[^\]]*\]|'[^']*'|"[^"]*")|permissionModule=(?:\{)?\s*("[^"]*"|'[^']*')/g;

for (const file of walk(join(ROOT, 'artifacts/marlin-erp/src'), ['.ts', '.tsx'])) {
  if (file.endsWith('usePermission.ts')) continue; // the definition itself
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(FE_RE)) {
    for (const name of literals(m[1] ?? m[2] ?? '')) {
      if (PAGE_PERM_KEY_SET.has(name)) continue;
      errors.push(
        `${relative(ROOT, file)}:${lineOf(src, m.index!)} checks permission "${name}", which is not a sidebar page. ` +
        `Use one of the keys in PAGE_PERM_KEYS.`,
      );
    }
  }
}

// ── 3. Backend key list must mirror the registry ──────────────────────────────

function renderBackendFile(): string {
  const rows = getPagePermRows();
  const keyLines = rows
    .map(r => `  ${JSON.stringify(r.key)},${' '.repeat(Math.max(1, 34 - r.key.length))}// ${r.section || 'General'} › ${r.name}`)
    .join('\n');
  const legacyLines = Object.entries(LEGACY_MODULE_TO_PAGES)
    .map(([k, v]) => `  ${JSON.stringify(k)}: [${v.map(x => JSON.stringify(x)).join(', ')}],`)
    .join('\n');
  return `/**
 * GENERATED FILE — do not edit by hand.
 * Source: artifacts/marlin-erp/src/lib/moduleRegistry.ts
 * Regenerate: pnpm --filter @workspace/scripts run permissions:write
 *
 * One permission key per sidebar link. The href is the identifier because link
 * names collide across sections ("Reports" appears three times).
 */

/** Every sidebar link, in sidebar order. */
export const PAGE_PERM_KEYS: readonly string[] = [
${keyLines}
];

/**
 * Old grouped module names -> the per-link keys that replace them.
 * Used once, by the migration that expands legacy rows into per-link rows.
 */
export const LEGACY_MODULE_TO_PAGES: Readonly<Record<string, readonly string[]>> = {
${legacyLines}
};
`;
}

const backendWanted = renderBackendFile();
if (WRITE) {
  writeFileSync(GENERATED_BACKEND, backendWanted);
  notes.push(`wrote ${relative(ROOT, GENERATED_BACKEND)} (${PAGE_PERM_KEYS.length} keys)`);
} else {
  let current = '';
  try { current = readFileSync(GENERATED_BACKEND, 'utf8'); } catch { /* missing */ }
  if (current !== backendWanted) {
    errors.push(
      `${relative(ROOT, GENERATED_BACKEND)} is out of date with the module registry. ` +
      `Run: pnpm --filter @workspace/scripts run permissions:write`,
    );
  }
}

// ── 4. The rendered sidebar must not change ───────────────────────────────────
// Per-link permissions are derived from the nav, so any nav edit silently
// redraws the permission table. Snapshot exactly what the user sees: section
// names, link names, hrefs and their order. Permission keys are deliberately
// NOT part of the snapshot — those are allowed to change.

function sidebarShape() {
  const standalone = MODULE_REGISTRY
    .filter(m => m.navGroup === '__standalone__')
    .flatMap(m => m.navEntries.map(e => ({ name: e.name, href: e.href })));
  return {
    standalone,
    groups: getNavGroups().map(g => ({
      name: g.name,
      children: (g.children ?? []).map(c => ({ name: c.name, href: c.href })),
    })),
  };
}

const shapeWanted = JSON.stringify(sidebarShape(), null, 2) + '\n';
if (WRITE) {
  writeFileSync(SIDEBAR_SNAPSHOT, shapeWanted);
  notes.push(`wrote ${relative(ROOT, SIDEBAR_SNAPSHOT)}`);
} else {
  let current = '';
  try { current = readFileSync(SIDEBAR_SNAPSHOT, 'utf8'); } catch { /* missing */ }
  if (current !== shapeWanted) {
    const a = JSON.parse(current || '{"standalone":[],"groups":[]}');
    const flat = (s: any) => [
      ...s.standalone.map((x: any) => `· ${x.name} (${x.href})`),
      ...s.groups.flatMap((g: any) => g.children.map((c: any) => `${g.name} › ${c.name} (${c.href})`)),
    ];
    const before = flat(a);
    const after = flat(sidebarShape());
    const removed = before.filter(x => !after.includes(x));
    const added = after.filter(x => !before.includes(x));
    const reordered = removed.length === 0 && added.length === 0;
    errors.push(
      `The rendered sidebar changed.\n` +
      (removed.length ? `      removed: ${removed.join(', ')}\n` : '') +
      (added.length ? `      added:   ${added.join(', ')}\n` : '') +
      (reordered ? `      links reordered or regrouped\n` : '') +
      `      Permissions are derived per link, so this rewrites who can see what. ` +
      `If the change is intended, run: pnpm --filter @workspace/scripts run permissions:write`,
    );
  }
}

// ── 5. Every sidebar link must be reachable from a legacy key ─────────────────
// Guards the migration: a link nothing maps to would start life denied.

const covered = new Set(Object.values(LEGACY_MODULE_TO_PAGES).flat());
for (const key of PAGE_PERM_KEYS) {
  if (!covered.has(key)) {
    errors.push(`No legacy module maps to "${key}" — existing roles would lose access to it on migration.`);
  }
}

// ── 6. Every route must be guarded by ITS OWN page's permission ───────────────
// The wrong-page failure mode: `<Route path="/accounts/chart"><PermGuard
// href="/accounts/vouchers">` would gate the chart page behind the Vouchers
// permission — access granted/denied by the wrong switch, invisible in any
// key-registration check because both keys exist. Rules enforced on App.tsx:
//
//   a. When the route's own path resolves to a registered permission key
//      (directly or as a satellite), the PermGuard href MUST equal the path.
//   b. Alias paths (path itself resolves to no key — /dashboard,
//      /production/purchase/new, /reports/:cat) must pass an href that DOES
//      resolve, otherwise RoutePermissionGuard silently falls through open.
//   c. Routes with no PermGuard at all must be on the explicit no-permission
//      list below (login, redirects, the location picker, self-profile).

const APP_TSX = join(ROOT, 'artifacts/marlin-erp/src/App.tsx');
{
  // Routes that intentionally render without a permission row. Additions here
  // are a security decision — every one is reachable by ANY authenticated user.
  const NO_PERM_ROUTES = new Set([
    '/login',      // public credential entry
    '/sales',      // location picker — no data of its own
    '/profile/me', // self-service profile
  ]);

  const src = readFileSync(APP_TSX, 'utf8');
  for (const m of src.matchAll(/<Route path="([^"]+)"([^>]*)>/g)) {
    const path = m[1];
    if (m[2].includes('/>')) {
      // Self-closing (e.g. the login route rendering a bare component).
      if (!NO_PERM_ROUTES.has(path)) {
        errors.push(`App.tsx:${lineOf(src, m.index!)} route "${path}" renders without a PermGuard and is not on the no-permission list.`);
      }
      continue;
    }
    const end = src.indexOf('</Route>', m.index!);
    const block = src.slice(m.index!, end === -1 ? undefined : end);
    if (block.includes('<Redirect')) continue;

    const guard = block.match(/<(?:Perm|RoutePermission)Guard\s[^>]*href="([^"]+)"([^>]*)>/s);
    if (!guard) {
      if (!NO_PERM_ROUTES.has(path)) {
        errors.push(`App.tsx:${lineOf(src, m.index!)} route "${path}" renders without a PermGuard and is not on the no-permission list.`);
      }
      continue;
    }
    const href = guard[1];
    const unrestricted = /\bunrestricted\b/.test(guard[2]);
    if (unrestricted) continue; // explicit opt-out (change-password)

    const ownKey = permKeyForRoute(path);
    const guardKey = permKeyForRoute(href);
    if (PAGE_PERM_KEY_SET.has(ownKey)) {
      // The route's own path resolves to a permission key (directly or as a
      // satellite): the guard must resolve to that SAME key. Comparing resolved
      // keys (not raw hrefs) allows satellite tabs to name their owner page.
      if (guardKey !== ownKey) {
        errors.push(
          `App.tsx:${lineOf(src, m.index!)} route "${path}" is guarded with href="${href}" (→ "${guardKey}") — the wrong page's ` +
          `permission. The route's own path resolves to "${ownKey}".`,
        );
      }
    } else if (!PAGE_PERM_KEY_SET.has(guardKey)) {
      errors.push(
        `App.tsx:${lineOf(src, m.index!)} route "${path}" guard href="${href}" resolves to "${guardKey}", which is not a registered ` +
        `permission key — RoutePermissionGuard falls through UNRESTRICTED. Point href at a registered page or add the satellite mapping.`,
      );
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────

for (const n of notes) console.log(`  ${n}`);
if (errors.length) {
  console.error(`\n✗ Permission check failed (${errors.length}):\n`);
  for (const e of errors) console.error(`  • ${e}`);
  console.error('');
  process.exit(1);
}
console.log(`✓ Permissions OK — ${PAGE_PERM_KEYS.length} sidebar pages, all guard names registered.`);
