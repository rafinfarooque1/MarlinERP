---
name: Five-action permissions & role tree
description: Post-consolidation permission model (View/Add/Edit/Delete/Download) and the single-root reports-to role hierarchy — invariants that every future permission or role change must uphold.
---

# Five-action permission model

- Actions are exactly View/Add/Edit/Delete/Download. **Download covers every output channel** — print, share, export, WhatsApp, on-screen PDF preview alike. Approve folded into Edit.
- The legacy DB columns `can_print` / `can_approve` / `can_share` still exist but are **write-mirrors only** (print/share := download, approve := edit), maintained by the permission upsert and the one-time fold migration. **No guard may ever read them.**
- **Why:** dropping the columns risked breaking the prod publish diff; mirroring keeps old rows meaningful while guaranteeing the 5-flag model is the single source of truth.
- **How to apply:** any new output-producing route gets a `download` guard; any new approval-style route gets `edit`. If you add a permission write path, mirror the legacy columns in the same statement or the whole-table mirror invariant (asserted by the regression suite) breaks.

# Role hierarchy (reports-to tree)

- Single root, levels **derived** from the chain (root=1, child=parent+1) and never client-writable. `level === 1` still means unrestricted access in middleware and `isAdmin` on the client, so tree integrity IS the authorization model.
- Root protections: no second root can be created (create requires an existing parent), root cannot be reparented or deleted; delete refuses roles with children or assigned employees.
- **Structure edits (reparent) serialize on one transaction-scoped advisory lock**, and the cycle check is repeated inside that transaction against the stable tree. A pre-transaction check alone lets two concurrent reparents (A→B, B→A) commit a loop that the level-1 override then walks. Recursive CTEs over the tree carry a depth bound as defense in depth.
- The reports-to backfill migration refuses to guess when no level-1 root exists (skips WITHOUT marking done → retries next boot) and folds extra level-1 rows under the oldest one (narrowing their access — deliberate).
- **How to apply:** any future route that mutates `reports_to_id` (bulk import, org restructure) must take the same advisory lock and re-validate inside the transaction; never trust a check made outside it.

## Seeder drift trap (fixed Aug 2026)
Any INSERT INTO permissions that omits can_approve/can_share leaves them FALSE and breaks the mirror invariant (can_print=can_share=can_download, can_approve=can_edit) for newly seeded hierarchies. All 5 seed sites now set them; when adding a new seed site, include both columns explicitly.
