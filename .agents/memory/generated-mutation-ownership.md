---
name: Generated mutation ownership
description: How to avoid duplicate React Query mutation hooks after adding an endpoint to the OpenAPI contract
---

Once an endpoint is represented in `lib/api-spec/openapi.yaml`, its Orval-generated React Query mutation owns the public hook name and the `{ data: ... }` mutation input shape. Hand-written hooks with the same name must be removed from the client barrel; place cache invalidation in the caller or a differently named wrapper.

**Why:** Orval exports the generated hook and schema from the same shared barrel. A custom `export *` for the old hook creates TypeScript and Vite conflicting-star-export failures, and existing callers may silently still expect the pre-codegen direct-body shape.

**How to apply:** After adding or changing an operation, run `pnpm --filter @workspace/api-spec run codegen`, search all callers of the generated hook, migrate them to `{ data: body }`, and then add any success invalidation explicitly where the old custom hook provided it.