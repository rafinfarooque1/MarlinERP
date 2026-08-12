---
name: Workspace reset & rollback semantics
description: What a platform task-merge/cancel reset and a checkpoint rollback actually restore, and how to verify/recover afterwards.
---

**Rule:** a platform task-merge/cancel event can revert ALL TRACKED files to git HEAD mid-session while leaving untracked files (new components, routes, tests, docs) intact. A checkpoint rollback afterwards may land on an even older state and also restores `.agents/memory/` — it is not guaranteed to recover the lost work.

**Why:** happened Aug 12 2026 during the UI modernization: tracked wiring (router mounts, boot-migration blocks, api-client index exports, App routes, page restyles) silently reverted to the Aug 10 publish; the untracked feature files all survived, so the app looked half-built. A subsequent user rollback restored a pre-Aug-11 memory index without recovering the tracked edits.

**How to apply:**
- After ANY merge/cancel/rollback event, re-verify tracked wiring from scratch with a marker grep battery (mounts in routes/index.ts, exports in lib/api-client-react/src/index.ts, migration calls in api-server src/index.ts, App.tsx routes) — do not trust prior file-state assumptions.
- Recovery is usually cheap: the untracked survivors (tests, route files, migration modules) are the behavioral contract; live dev DB DDL (`pg_dump -s`) is the truth for lost inline migrations. Rebuild wiring, then run the surviving test suites.
- Grep gotcha that faked a missing marker here: patterns starting with `--` (CSS custom properties) are read by grep as options — use `grep -- "--radius"` or `grep -e`.
