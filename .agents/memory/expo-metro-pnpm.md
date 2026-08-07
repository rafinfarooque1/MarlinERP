---
name: Expo Metro in the pnpm monorepo
description: Metro watchFolders must include the workspace-root node_modules or every import fails with a blank app
---

**Rule:** `metro.config.js` `watchFolders` must always contain `path.join(workspaceRoot, 'node_modules')`. Never narrow it away.

**Why:** pnpm stores every real package under root `node_modules/.pnpm`, and Metro can only resolve files it has indexed. Narrowing `watchFolders` (done once to dodge Vite temp-dir churn) made the expo-router entry bundle 500 with `UnableToResolveError` → blank white page on every platform. Clearing `/tmp/metro-*` caches does NOT fix it — it is config, not cache.

**How to apply:** if the employee app goes blank and the bundle URL returns JSON instead of JS, check `watchFolders` first, then restart the expo workflow (config changes need a restart; app code hot-reloads).
