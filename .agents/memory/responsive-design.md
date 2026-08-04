---
name: Responsive design conventions
description: How the ERP stays desktop-identical while adapting to tablet/mobile — the invariants any future UI change must keep.
---

# Responsive design conventions (Aug 2026 pass)

The whole ERP was made responsive under a hard constraint: **desktop must stay pixel-identical**. Every responsive change is therefore a no-op at its restore breakpoint. Future UI work must keep these invariants:

- **Touch sizing lives in the ui/ primitives, not pages.** button/input/select/checkbox carry `max-md:` bumps (e.g. `max-md:min-h-11`). Explicit `h-8`/`h-9` classNames from call sites still win via tailwind-merge, so dense entry grids stay dense. Don't re-add per-page touch tweaks.
- **DialogContent handles phones globally** (inset width, `90dvh` cap, `p-4`, rounded), restoring the exact old values at `sm:`. Pages must NOT add their own mobile dialog sizing.
- **List tables → mobile cards pattern:** table wrapped in `hidden md:block`, sibling `md:hidden` card list mapping the SAME data array with the SAME handlers/conditionals. Applied to Sales, Purchases, Customers, Vendors lists. New list pages of similar weight should follow it; report/financial tables stay tables (shared Table primitive already scroll-wraps).
- **Line-item entry grids (grid-cols-8/11/12) are never restructured** — wrap in `overflow-x-auto` + inner `min-w-[NNNpx]` so phones scroll horizontally.
- **Form grids:** `grid-cols-N` → `grid-cols-1 sm:grid-cols-N` (identical at sm+).
- **Sidebar:** mobile drawer starts closed and auto-closes on route change (a `useEffect` on wouter location in AppLayout); tablet (768–1199px) initializes `collapsed` from `window.innerWidth` at first render — viewport must be set BEFORE load in tests.

**Why:** the owner uses desktop workflows daily (incl. the Purchase keyboard flow); any md+ visual drift is a regression. **How to apply:** when adding UI, use mobile-first classes whose md+/sm+ value equals the desktop design; verify at 390px, 1024px, and 1920px.
