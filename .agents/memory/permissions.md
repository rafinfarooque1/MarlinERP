---
name: Permission system
description: Per-sidebar-link permission model — key format, the endpoints that must stay unguarded, migration lockout rules, and what a build check can and cannot catch
---

## One permission row per sidebar link, keyed by href

Permission keys are `page:<href>` — `page:/accounts/cash-book`, `page:/hr/payroll`. Six flags each: view / add / edit / delete / download / print.

**Why href and not the link name:** link *names* collide across sections ("Reports" appears three times, "Expenses" twice). The href is the only stable unique identifier for a sidebar link.

**Why per-link and not grouped:** grouped modules silently over-granted — one "Books" row handed out Day Book, Cash Book, Bank Book *and* Trial Balance together, so a cashier who needed the Cash Book also got the Trial Balance.

`artifacts/marlin-erp/src/lib/moduleRegistry.ts` remains the single source of truth: the same registry renders the sidebar and derives the permission rows, so the two cannot drift. The backend gets a generated mirror; a build check (`scripts/src/check-permissions.ts`, also wired into `typecheck`) fails when a guard or a frontend literal names a key that is not registered, or when the sidebar changes against its golden snapshot.

**How to apply:** add the sidebar link first, regenerate the backend mirror and the snapshot, then write guards. Keys must be raw string literals in guards — the check greps for them, so a computed key is invisible to it.

## Endpoints that must never be guarded

`GET /hr/hierarchies` and `GET /company/permissions` are how the app *resolves* permissions, and the shell reads them on every page for every user.

**Why:** guarding them makes permission resolution itself require a permission. That 403s every page for every non-top-level user — the failure looks like a total outage, not a permission problem. This was shipped once and caught only in E2E.

**How to apply:** before adding a guard to a GET, ask whether the app shell or `usePermission` calls it on every route. If yes, leave it open.

## A registered key can still be the wrong key

The build check proves a guard name *exists*; it cannot prove it is the *right* name for that endpoint. Real instances found in review: the Chart of Accounts tree guarded on the Expenses page key, and the shared cash/bank ledger dropdown missing the Vouchers and Vendors pages that also open it.

**Why:** shared read endpoints feed dropdowns on pages far from where they live. Over-guarding blanks a page for a legitimate user, which is worse than a slightly wide any-of list.

**How to apply:** for any shared GET, grep the frontend for the URL, collect *every* page that calls it, and list them all as an any-of. Verifying this needs an endpoint→consumer test; static registration checks will not catch it.

## Migration rules that prevent lockouts

- **Fallback direction is GRANT, not deny.** When expanding legacy grouped rows into per-link rows, a link no old row covered is granted. Getting this backwards locks administrators out of the Permissions page itself, and the only way back in is hand-written SQL.
- **Flags are OR-ed** across every legacy row that covered the link; print seeds from download.
- **Delete the legacy rows in the same transaction.** The dynamic gap-fill pass reads `SELECT DISTINCT module FROM permissions`, so any survivor is re-created for every hierarchy forever.
- Migrating destroys the old rows, so **a role's pre-migration permissions cannot be recovered** — there is no audit table for permission changes.
- **Backfill seeding must be one-time (migration-log guarded), never per-boot.** A boot-time "give every role a row for every page" pass treats *no row* as *needs an all-true row*, so a role configured with three pages comes back from the next restart holding all of them. Under default-deny, a missing row is the answer, not a gap to fill.

## A data reset must not clear the migration log

One-time all-true permission seeds are guarded by rows in `migration_log`. If a "reset company data" path truncates that table, the seeds re-run on the next boot and silently re-widen every non-level-1 role to full access — the role you just restricted comes back unrestricted after a restart, with no user action in between.

**How to apply:** keep `migration_log` out of any reset/truncate list, and treat "which one-time migrations have run" as configuration, not data.

## Bootstrap endpoints should return the caller's own rows, not everyone's

`GET /company/permissions` must stay reachable by every authenticated user (the shell resolves rights from it), but "reachable" does not mean it should hand back the whole matrix. Returning every hierarchy's rows to any logged-in user leaks the entire authorization model to an API caller even though the Permissions *page* is guarded.

**How to apply:** return only the caller's own hierarchy rows; widen to all hierarchies only for level 1. Derive level from the hierarchies table — the session/token does not carry it.

## Uniqueness is an authorization requirement

`permissions (hierarchy_id, module)` carries a unique index. Guards fold rows with `json_object_agg(module, ...)`, so a duplicate row makes effective rights depend on which row the planner emits last — authorization stops being deterministic. All seeding and the save endpoint use `ON CONFLICT`, not check-then-insert, because two instances booting at once both pass a `WHERE NOT EXISTS` check.

## Defaults

- Level-1 hierarchy → always full access, everywhere, not overridable in the UI.
- **Missing row → denied**, both server-side and on the Permissions page. (Earlier the UI showed missing rows as view-allowed while the server denied them; that misrepresentation is gone.)
- While permissions load → full-access values with `isLoading=true`, to avoid a flash of "denied".

## Testing lessons

- API auth is bearer-token (`Authorization: Bearer v2....` from `POST /api/auth/login`), NOT cookies — a cookie jar silently yields 401 on every call.
- Test against a throwaway hierarchy + employee, never a real role: the migration deleted the old rows, so overwriting a real role's permissions during a test is unrecoverable.
- FK blocks deleting a hierarchy while its permission rows exist (500); delete the rows by SQL first — there is no DELETE endpoint.
