---
name: Raw-migration columns invisible to drizzle
description: Columns added via startup SQL migrations are absent from the drizzle schema and generated types — both reads and writes must use raw SQL
---

Rule: any column added by an idempotent startup migration (i.e. not declared in `lib/db/src/schema/*`) is invisible to drizzle. `db.select()` silently omits it — the field reads as `undefined`, and `Number(x.cost ?? 0)` quietly becomes 0. Generated API types lack the field too.

**Why:** Production costing read material `cost` via `db.select().from(materialsTable)`; every computed cost came out 0 and it cost a full test round to trace, because name/unit (declared columns) looked fine. Same family as the item_prices valid_from/valid_to lesson (see item-prices-dates.md), but this is the sneakier *read* side.

**How to apply:**
- Before trusting `db.select()` for a column, grep `lib/db/src/schema/` for it; if absent, read AND write it with `pool.query` raw SQL.
- Frontend: cast `(row as any).field` for fields the generated types lack.
- Symptom to recognize: some fields of a row populated, migration-added ones zero/undefined.
