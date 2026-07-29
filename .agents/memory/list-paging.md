---
name: Opt-in paging for list endpoints
description: Why list endpoints here page only on request, and why in-memory slicing after a full fetch is never a performance fix.
---

# List paging is opt-in, and slicing after a full fetch is not optimisation

List endpoints return a bare JSON array and the frontend consumes many of them
wholesale — an attendance month view, a payroll run, a customer dropdown, a
location picker.

**The rule:** paging applies only when the caller passes `?limit=` or
`?offset=`. No paging parameters means the full list. Metadata goes in
`X-Total-Count` / `X-Limit` / `X-Offset` so the response stays an array.

**Why:** a default page size silently truncates screens that currently work.
The damage scales with the customer's data, so it passes every test on a small
dev dataset and fails in production — a 30-employee month view quietly loses
two thirds of its rows with no error anywhere.

**Also:** the first implementation fetched every row and then `.slice()`d it in
memory. That is strictly worse than no paging: identical database load and
identical memory, but rows go missing. If paging is being added *for
performance*, the `LIMIT`/`OFFSET` has to reach the query; an in-memory slice
only ever buys a smaller response body, never a cheaper query.

**How to apply:**
- Use the shared helper rather than re-deriving the semantics per route — this
  logic was duplicated per file at first, and the duplicates drifted.
- Aggregate endpoints that return an object rather than a list are not paged.
- When adding paging to an existing endpoint, verify the default (no params)
  response length is unchanged before and after.
