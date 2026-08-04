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
- **Sidebar:** mobile drawer starts closed and auto-closes on route change (a `useEffect` on wouter location in AppLayout); tablet (768–1199px) initializes `collapsed` from `window.innerWidth` at first render — viewport must be set BEFORE load in tests. Drawer is `max-md:w-[80vw] max-md:max-w-sm`; overlay is `z-[45]` (must beat the sticky header's z-40, stay under the aside's z-50). Expanded nav groups persist in localStorage keyed `marlin_nav_open:<username>:<group>`; a persisted "collapsed" is overridden (not re-persisted) by an effect whenever the group becomes active, so deep links never hide their page.

## Aug 2026 mobile pass additions (same invariants)

- **Mobile root font bump:** `html { font-size: 106.25% }` under `@media (max-width: 767px)` in index.css scales all rem-based type/spacing ~6% on phones only. Tailwind breakpoints are unaffected (media queries use the initial font size), so there is no breakpoint drift.
- **Sticky first table column (mobile only):** the shared Table primitive's wrapper carries `erp-table-scroll`; index.css pins `th/td:first-child` (opaque `bg-card`, z-5/6, right hairline) under max-md. Tables whose first column is a control (checkbox/action) opt out with `className="no-sticky-col"` on `<Table>` — currently finance/Reconciliation and company/ImportData. Known cosmetic limit: rows with their own bg tint (e.g. RTable's bg-muted/20 footer) show a bg-card first cell on phones; use the opt-out if a table makes this ugly.
- **Thin mobile scrollbars + momentum** are global on `.overflow-x-auto`/`.overflow-auto` via the same media block — never re-add per-page scrollbar styling.
- **Sticky dialog footers:** entry dialogs (Sales, Purchases, Quotations, all vouchers) pin their DialogFooter on phones with `max-md:sticky max-md:bottom-0 max-md:z-20 bg-background/95 backdrop-blur` + negative-margin bleed matching DialogContent's mobile p-4. Cap z at 20 so Radix popovers stay above.
- **SummaryCards** get `max-md:` typography bumps (label text-sm, value text-xl, hint text-xs) and `max-md:h-full` — any new size tweak there must stay max-md-scoped; an unscoped `h-full`/`shrink-0` on shared report components is a desktop regression (architect caught exactly this).
- **Dashboard KPI grid** is `grid-cols-2 md:grid-cols-6` (pairs on phones per owner's spec); NP is `col-span-2 md:col-span-6`.

**Why:** the owner uses desktop workflows daily (incl. the Purchase keyboard flow); any md+ visual drift is a regression. **How to apply:** when adding UI, use mobile-first classes whose md+/sm+ value equals the desktop design; verify at 390px, 1024px, and 1920px.
