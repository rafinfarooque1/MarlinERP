---
name: OpenAPI codegen and Vite refresh
description: Resolves transient missing generated-client errors when Orval runs against a live Vite server.
---

Orval cleans its output folder before regenerating. If the ERP Vite workflow is live, it may log module-not-found errors during that interval and retain failed module requests after generation finishes.

**Why:** This was observed during OpenAPI client regeneration; generated files and library typechecks were valid, and a single Vite restart cleared the transient errors.

**How to apply:** Wait for codegen to complete, then restart the affected frontend workflow once before preview verification.