---
name: Custom API client hooks
description: How to add new hooks to lib/api-client-react that aren't auto-generated
---

## Pattern
1. Create `lib/api-client-react/src/<topic>.ts` (see bom.ts, production.ts as examples)
2. Add `export * from "./<topic>";` to `lib/api-client-react/src/index.ts`
3. Run `cd lib/api-client-react && pnpm tsc` to generate `.d.ts` files for TypeScript to find
4. Import query keys from `./generated/api` to use with invalidateQueries

## Important
- The package uses compiled TypeScript Project References (`composite: true`)
- Without running `pnpm tsc` in the lib, TypeScript won't see the new exports in consuming packages (even though Vite/HMR works fine at runtime)
- File: `lib/api-client-react/tsconfig.json` — emitDeclarationOnly, outDir=dist

**Why:** The api-client-react package declares `composite: true` in tsconfig. Consuming packages resolve types from dist/*.d.ts, not source. Vite bypasses this at runtime via module resolution but tsc --noEmit in the app fails without a rebuild.
