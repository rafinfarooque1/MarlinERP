---
name: Global date & location filter plumbing
description: Durable rules for the shared list-filter layer (from/to + location params) and the traps found building it — HO id mismatch, locked-user stale context, partial-date 400s.
---

# Global date & location filter plumbing

**Location params are a view request, never authority.** Client filter conditions are ANDed ON TOP of the unconditional LBAC scope conditions — never merged into or substituted for them. Malformed location params degrade to "no narrowing" (never an error); malformed dates 400.
**Why:** a branch user passing a foreign location must get zero rows, not an error, and never foreign data. Verified against a real branch login.

**Head Office matches on TYPE alone — never on an id.** Different tables coalesce their legacy NULL-location rows to different HO placeholder ids, so `headoffice` + id equality silently drops valid HO rows in whichever table uses the other convention. A read-only audit can't catch this; only cross-table probing did.
**How to apply:** the shared push-filter helper special-cases it; any hand-written HO condition must match on type only.

**Persisted location context outlives the login.** A location-locked employee on a shared browser inherits the previous user's selection from localStorage — every filtered page then sends a foreign location and correctly renders zero rows (a denial-of-view, not a leak) under a wrong location name. The header selector force-syncs a locked user's context to their own branch.
**How to apply:** any consumer of the shared location context must tolerate it being rewritten on auth change; never trust the persisted value for a locked user.

**Guard partial dates client-side, including date-SHAPED ones.** A date input mid-edit emits values like `0002-07-01` while the year is being typed — full `YYYY-MM-DD` shape, yet rejected server-side because `Date.UTC` maps years <100 to 19xx, failing round-trip calendar validation. A shape regex alone still ships transient 400s; also require a plausible year (≥1000). Server validation stays — the client guard only suppresses keystroke noise.

**Filtered-view query keys must extend the base list key** so existing prefix invalidations from mutations refresh filtered views for free; an exact-key invalidation silently misses them and looks like a backend staleness bug.
