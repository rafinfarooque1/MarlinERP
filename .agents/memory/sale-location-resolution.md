---
name: Resolving which place a sale (or its payment) belongs to
description: Why sale_payments.outlet_id must never be joined to outlets, and how to resolve a sale's location correctly.
---

# Resolving which place a sale belongs to

A sale's location is `sales.location_type` + `sales.location_id`. `location_type`
is NOT NULL and is one of `outlet`, `warehouse`, `headoffice`.

Two traps sit on top of this.

## 1. `outlet_id` is legacy and lies by omission

`sales.outlet_id` predates the location columns and is still written, but:

- it is **NULL for warehouse sales**, because a warehouse has no outlet row; and
- on sales that do have it, it points at the *outlets* row for the same place,
  which is a **different id** from `location_id`.

`sale_payments.outlet_id` is copied straight from `sales.outlet_id`, so it
inherits both problems. Any `JOIN outlets o ON o.id = <x>.outlet_id` is an inner
join on a mostly-null column: it **silently deletes every warehouse row from the
result set**. That is not a display bug — a payment missing from a worklist can
never be actioned, so receipts stay outside reconciliation and match controls
permanently, with nothing on screen to suggest anything is missing.

Resolve the location from the sale instead, with both joins LEFT so a row is
never dropped for want of a master record:

```sql
LEFT JOIN outlets    o ON s.location_type = 'outlet'    AND o.id = s.location_id
LEFT JOIN warehouses w ON s.location_type = 'warehouse' AND w.id = s.location_id
-- label: COALESCE(o.name, w.name)
```

Scope by location the same way (`s.location_type = $1 AND s.location_id = $2`).
Scoping on `outlet_id` doesn't just hide rows from warehouse staff, it hides
them from *everyone*, because the join runs before the scope does.

## 2. `warehouses` also contains the outlets

The `warehouses` table holds a row for every stock-holding place, including ones
named "… Outlet" that also exist in `outlets` under a **different id**. So the
same physical shop is `warehouses.id = 3` and `outlets.id = 1`, and
`location_type` is what decides which table to read.

Consequences:
- Never assume `location_id` indexes `outlets` just because the name says Outlet.
- A location dropdown built from both tables shows duplicate names and colliding
  ids; label the two groups and key options by `` `${type}:${id}` ``.

**Why:** the location model was retrofitted over an outlet-only design, and the
old columns were left in place rather than backfilled, so the intuitive join is
the wrong one and fails silently instead of erroring.

**How to apply:** whenever you touch a query that reads a sale or a sale payment
per-location — worklists, scoping, labels, filters, reports — resolve through
`location_type`/`location_id`. Treat any surviving `outlet_id` join as a bug.
When testing, use a sale at a true warehouse (one with no outlet counterpart);
a sale at an outlet-backed warehouse passes even when the join is wrong.
