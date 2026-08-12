---
name: UI modernization sweep
description: The Aug 2026 web-app-wide visual modernization — the binding contract, the page kit, and the satellite-page/breadcrumb pattern.
---

# UI modernization sweep (Aug 2026)

**The rule:** any new or restyled marlin-erp page must follow `artifacts/marlin-erp/docs/UI_CONVENTIONS.md` — it is the binding contract (page anatomy, token classes, pagination/EntityCombobox rules, zero-behavior-change requirements). Do not invent a different style.

**Why:** the whole app was swept page-by-page against that document with parallel subagents; a page styled any other way sticks out and re-opens the churn. Accounting figures were verified byte-identical before/after — the contract's "zero behavior change" rules are what made that possible.

**How to apply:**
- Page kit lives in `src/components/app/` (PageHeader, SummaryCard, StatusBadge, EmptyState, skeletons, FilterPanel) + `src/components/ui/table-pager.tsx` and `entity-combobox.tsx`.
- Satellite pages (own routes that live under another sidebar entry, e.g. Stock's storage/tracking tabs) register in `moduleRegistry.ts` via `SATELLITE_PAGE_OWNER` and are permission-gated by `permOwner(path)` — they inherit the OWNER page's permission and never appear in the sidebar. Breadcrumbs come from `breadcrumbFor(path)` in AppLayout.
- "Sidebar frozen" (erp-enterprise-decisions) was superseded by this owner-approved modernization: the grouped sidebar via `getNavGroups()` is now the settled shape.
- Sweeping with subagents: give each a disjoint file list, mark shared files with ONE owner, pass the contract doc + kit files as relevantFiles.
