---
name: Global location context transport
description: How the sidebar location selector reaches every endpoint (headers), and the invariants that keep it a view filter, not authority
---

# Global location context — transport semantics

The sidebar "Current Location" selector rides on every API **read** as
`x-location-type` / `x-location-id` headers, injected centrally by the shared
API client's fetch wrapper (`setLocationContextGetter`). Server routes read the
merged filter through `getLocationFilter` / `getPostingLocationFilter`
(api-server `lib/requestLocation.ts`).

Invariants — breaking any of these reintroduces a past bug class:

- **View, never authority.** Routes apply their LBAC scope UNCONDITIONALLY and
  AND the header context on top. The header can only narrow what the caller may
  already see. Two-gate pattern everywhere: `scope*Where(scope)` +
  `pushLocationFilter(viewLoc)`.
- **Reads only.** The client injects headers on GET/HEAD only, and no write
  handler may read them — a document's location comes from the session or the
  validated body, never from what the user is looking at on screen.
- **Query params beat headers**, keyed on the PRESENCE of the `locationType`
  query key: a present-but-malformed query value degrades to "no narrowing",
  it does NOT fall back to the header.
- **Malformed/absent/'all' degrades to no narrowing** — never a 4xx. The
  selector must not be able to break a page.
- **HO matches on type alone** (id placeholders differ per table).
- **Ledger-anchored reports must switch basis under a located view.**
  Vendor/customer ledger balances have no location; receivables/payables flip
  to a document basis (`basis: "invoices"` / `"bills"`) and EXCLUDE unbilled
  ledger-only balances from located slices. For payables the FIFO settlement
  walk still runs company-wide (settlement is per vendor); only the located
  bills are then displayed/counted — filtering bills BEFORE the walk
  mis-settles them.
- **Un-narrowable data (no location column, e.g. activity log) is HO-only**:
  branch logins get an empty list, not the company feed.
- Headers ride OUTSIDE react-query keys, so changing the selection must call
  `queryClient.invalidateQueries()` — a stale screen after switching looks
  exactly like a backend bug.
- Persistence: `employees.ui_location_pref` (JSON string via
  PUT /auth/location-pref, so "picked All" ≠ "never set"); the client hydrates
  it only when localStorage has no value — local wins.
