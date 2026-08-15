---
name: Route-guard audit CI
description: Permanent permission/guard coverage checks — how they enforce, where the exemption tables live, and the comment-vs-code migration-guard lesson.
---

# Route-guard audit CI

Two static checks run in `pnpm --filter @workspace/scripts run typecheck`:

1. **`scripts/src/audit-route-guards.ts`** (`audit:guards`, `audit:guards:write` regenerates
   `docs/PERMISSIONS_AUDIT.md`) — scans every `router.<method>()` in api-server routes,
   resolving const guard args (incl. arrays composed of other consts). Fails CI when:
   - a WRITE lacks a `requireModuleAction` middleware guard AND isn't in the in-file
     `EXEMPTIONS` table (self-service auth, level-1 in-handler gates, kind-derived dynamic
     guards, uploader-bound presigned PUT);
   - an exemption goes stale (route gained a guard or vanished) — both directions checked;
   - a resolved guard key isn't a registered sidebar page key (the literal-only regex in
     check-permissions.ts can't see const-passed keys).
2. **`scripts/src/check-permissions.ts` check 6** — App.tsx wrong-page-key sweep: every
   `<Route>`'s PermGuard href must resolve (via `permKeyForRoute`) to the SAME key as the
   route's own path when that path resolves to a registered key; alias paths must resolve
   to a registered key or the RoutePermissionGuard falls through unrestricted; guardless
   routes must be on the explicit `NO_PERM_ROUTES` list.

**Why:** wrong-page keys and unguarded writes are invisible in key-registration checks —
both keys/routes "exist", the gate just protects the wrong thing or nothing.

**How to apply:** new write route → add the guard or an EXEMPTIONS entry with reason.
New App.tsx route → PermGuard with href == its own path (satellites may name the owner —
compare RESOLVED keys, not raw hrefs). Runtime proof lives in
`artifacts/api-server/tests/permission-location-audit.test.mjs` (default-deny, 403-before-404
gate order, per-page isolation, immediate revocation, LBAC 404s, selector-never-grants).

## Comment ≠ code

The `permission_seed_existing_v1` boot seed carried a comment saying its guard "MUST check
the name this block records" and describing the copy-paste bug as past tense — yet the code
still checked `assets_page_perms_v1`. On any DB missing that entry the all-true seed would
re-run and hand every post-cutover role full rights. **Lesson:** a comment describing a fix
is not evidence the fix exists; verify the executable line, especially in one-time
migration guards (they only misfire on restored/older DBs, never in daily dev).
