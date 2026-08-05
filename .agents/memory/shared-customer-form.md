---
name: Shared customer form & infinite sales list
description: The single CustomerFormDialog every customer-creation entry point must reuse, and the infinite-scroll convention for the POS sales list.
---

# One customer form, everywhere

**Rule:** `components/customers/CustomerFormDialog.tsx` is THE customer create/edit form. Customers module, POS quick-create and Quotations quick-create all render it. Never add a second (reduced) customer form to any new surface — pass props instead (`editItem`, `defaultLocationValue`, `prefillName`, `onSaved`).

**Why:** The old per-page quick-create forms drifted: they dropped credit limit/days and the location field, and POS force-stamped `locationType/locationId` into every payload — which trips the server's "only Head Office may assign a location" guard for branch users. Duplicated forms guarantee this class of bug returns.

**How to apply:**
- Callers with a location context (POS selling at a branch) pass `defaultLocationValue` = `locationValueOf(type, id)` so the new customer lands in that screen's scoped dropdown.
- The dialog itself invalidates `getListCustomersQueryKey()` AND the plain `['customers']` prefix (POS/Quotations location-scoped lists live under it). Callers only auto-select via `onSaved`.
- Payload rule stays: only HO sends location; branch payloads carry none (server stamps session).
- Keep the schema un-exported — exporting non-components from the dialog file breaks Vite fast-refresh for every importer.

# Infinite sales list convention

- `useInfiniteSales` (paginated-lists.ts) shares one `salesFilterQuery()` serializer with `usePaginatedSales` so filters can't drift; its key is `['/api/sales','infinite',<filters>]` — the app-wide invalidation predicates match on `key[0].startsWith('/api/sales')`, so any new infinite key must keep `/api/sales` as element 0.
- Filter changes reset accumulation via the key alone — no manual `setPage(1)` effects.
- The POS list auto-loads via an IntersectionObserver on the footer (Load More button as fallback). Status pills and column sort stay CLIENT-side over loaded rows on purpose (status is derived settlement math — don't push into SQL).
