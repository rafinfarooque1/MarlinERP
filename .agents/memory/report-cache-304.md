---
name: Report cache 304 handling
description: Report screens must not interpret a validated HTTP 304 as an empty report payload.
---

Report queries that render authoritative financial or operational datasets must bypass browser revalidation when the fetch layer cannot restore the cached 200 body from a 304 response.

**Why:** The server legitimately returned 304 for a report request, but the client fetch helper returned no body for 304; the screen then fell back to zero rows while a direct fresh API request showed the real entries.

**How to apply:** Use a no-store request for report/aging queries or make the fetch layer explicitly recover the cached response before adding a zero-value fallback.