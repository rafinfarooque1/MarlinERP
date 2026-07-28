---
name: Polymorphic stock_entries
description: stock_entries holds items AND materials with overlapping ID spaces — every query must scope material_type, and boot-time dedupe blocks are a data-destroying hazard
---

# `stock_entries` is polymorphic

`stock_entries` is the single quantity truth for **items, raw materials and
packing materials**. A `material_type` discriminator (`'item' | 'material' |
'raw_material'`) distinguishes them; the identity key is
`(item_id, material_type, branch_type, branch_id)`. The FK to `items` was
dropped because `item_id` is now polymorphic.

**Why:** materials previously had only a single global `current_stock` counter
with no location at all, so there was no way to answer "how much is at this
warehouse". The alternative — a separate `material_stock_entries` table — would
have created a second source of truth for stock-by-location, which was
explicitly forbidden.

## The trap that follows from it

The three master tables' ID spaces **overlap from 1**: item #1, `materials` #1
and `raw_materials` #1 all exist simultaneously. So **every pre-existing query
is wrong-by-default** until it filters `material_type`. Symptoms of a missed
filter are not crashes — they are invented stock and invented value, e.g. a sale
of item #1 reading and deducting the row belonging to material #1 at the same
location, or a dashboard stock total that silently includes raw materials.

**How to apply:** when touching anything that reads or writes `stock_entries`,
grep for *all* access first — including Drizzle (`stockEntriesTable`), which is
the easy one to miss because `material_type` is a startup-migration column and
therefore invisible to Drizzle's schema. Express it as raw SQL in the `where`.

## Boot-time "dedupe then enforce unique index" blocks are a live hazard

An unguarded startup block that groups by the identity key, merges duplicates
and then recreates a unique index becomes **data-destroying the moment that key
widens**. Grouping by the old, narrower key sees item #1 and material #1 as
duplicates of each other and merges them — destroying stock on an ordinary
restart, with no error.

**Why:** such blocks are written to be permanent no-ops ("once the unique index
exists this matches nothing"), so they look inert and get ignored during schema
changes. They are not inert; they re-evaluate against whatever the schema has
become.

**How to apply:** resolve the identity key from `information_schema` at run time
rather than hardcoding it, and gate re-creation of a superseded index on the
absence of the newer discriminator column. Never assume a boot-time migration
that was safe at write time is still safe after the key changes.

## Mirrors, not truth

`materials.current_stock` and `raw_materials.current_stock` are retained as
**non-authoritative company-wide mirrors** — the same arrangement
`items.production_stock` already had. Truth is the sum of located rows.

**How to apply:** move stock only through the material-stock helpers, and keep
the `mirror` flag consistent per operation class — a transfer relocates goods so
must NOT touch the mirror, while a purchase or production consumption must.
Reversal paths clamp at zero; **forward** consumption must never clamp, because
flooring a real shortfall manufactures stock. Verify mirror == located sum after
any change to a write path.
