---
name: Expo pnpm type resolution
description: Expo SDK packages can import undeclared peer modules that pnpm does not expose during TypeScript resolution.
---

When an Expo package's TypeScript source imports a peer such as `expo-modules-core`, add the matching Expo module as a direct app dependency and map it in the app tsconfig if the import still resolves from pnpm's virtual package directory. Cast only React 19-incompatible native component declarations at the JSX boundary.

Before applying `expo install --fix` to React type-version warnings in a multi-artifact pnpm workspace, check all TypeScript consumers. A mobile-only downgrade can create duplicate React type identities in shared web components.

**Why:** pnpm's strict virtual-store layout can make a package's undeclared type import invisible even though Expo resolves the module at runtime; React 19 declarations can also reject otherwise valid native class components. Expo's SDK preference may conflict with the React types required by sibling artifacts.

**How to apply:** Keep runtime imports and native behavior unchanged, use the Expo SDK-matched module version, and verify the employee app and every affected workspace typecheck before retaining dependency changes.