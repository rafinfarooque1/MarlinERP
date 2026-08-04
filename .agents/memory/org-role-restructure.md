---
name: Org role restructure (Administrator / Management)
description: Root role semantics after the rename, the fail-closed hierarchy migration pattern, and why the factory reset needs a shared tree builder.
---

# Org role restructure

The level-1 root role is **Administrator** (renamed from the old "Management" root — same row, so mapped employees kept the level-1 full-access bypass). **Management** is an ordinary level-2 role: seeded view+download on report/book/dashboard/audit pages, view-only on operational pages, and NO rows (default-deny) on admin surfaces. Owner + the six standard manager roles sit under Management.

**Rules that must hold:**
- Exactly ONE level-1 role, ever — the RBAC bypass makes every extra one a super-admin. Any migration touching the hierarchy table must assert a single level-1 row inside its txn before committing its marker.
- Hierarchy structure changes serialize on the shared hierarchies-structure advisory lock (same one the HR routes take).
- Role names are unique case-insensitively but only route-enforced — no DB constraint. A migration that renames/creates roles must check clashes itself and **fail closed without writing its completion marker** (roll back, log, retry next boot). Never adopt a pre-existing role for a privileged-or-restricted purpose: it either retains wider permission rows behind a name people now read as restricted, or gets silently narrowed. Create fresh or refuse.

**Why:** review caught a fail-open path where a name clash silently skipped the root rename but still recorded completion — leaving a privileged root and a duplicate-named view-only role, permanently.

**Factory reset trap:** the full company reset truncates roles+permissions but deliberately keeps the migration log, so one-time tree/seed migrations never re-run after a reset. Any structure a reset must restore has to live in a shared helper the reset endpoint calls directly. Seed a role's permission rows only when that role is created fresh.

**How to apply:** future role-seeding/tree work follows the same pattern: advisory lock + one txn, case-insensitive clash checks up front, level recompute via recursive CTE from the single parentless root, single-level-1 assertion, marker only on full success, and a reset-callable helper if the reset must rebuild it. Migration behavior is testable against a scratch schema (see the org-restructure migration test for the pattern).
