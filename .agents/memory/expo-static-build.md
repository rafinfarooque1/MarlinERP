---
name: Expo static build routing
description: Metro URL routing and port selection for the pnpm monorepo's employee-app static build
---

Metro may start from the employee-app directory but resolve HTTP bundle and asset request paths from the pnpm workspace root. Static-build requests must therefore include the artifact's workspace-relative directory, including for asset endpoints whose URLs are embedded in bundles.

**Why:** Requesting the same entry or asset path relative to the artifact directory returns HTTP 404 even though Metro is healthy; the failure looks like a missing entry or symlink problem.

**How to apply:** Build scripts should derive the workspace root and artifact-relative path rather than hardcode it. They should default to port 8081 when available but select a free local port when another workspace workflow already owns it.