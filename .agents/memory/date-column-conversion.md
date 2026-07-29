---
name: Converting text date columns to real DATE
description: Why a text-to-date migration leaves latent 22007 errors behind, and what to grep for afterwards.
---

# A text→date conversion turns every empty-string guard into a time bomb

Several date columns here started life as `text` and were later converted to
real `date` columns by a migration (the pool registers a type parser for OID
1082, so reads still come back as `'YYYY-MM-DD'` strings and the API contract
is unchanged).

**The rule:** after converting a text column to `date`, grep for every
comparison of that column against a string literal — `col <> ''`, `col = ''`,
`COALESCE(col, '')` — and remove it. `IS NOT NULL` is then the only valid
"missing date" test.

**Why:** while the column was text, `expiry_date <> ''` was the natural way to
skip blank dates. Once the column is a real `date`, Postgres has to coerce the
`''` literal to a date to make the comparison, and raises
`22007 invalid input syntax for type date: ""`. The whole endpoint 500s.

This is nastier than it sounds for three reasons:
- The migration itself succeeds and reports success. Nothing links the failure
  back to it.
- The error only fires when the query actually runs, so it hides in any
  endpoint that is not on the common path.
- A read-only reconciliation audit will not find it. Trial balance, balance
  sheet and the sales reports can all be perfectly green while a dashboard
  panel is dead.

**How to apply:**
- Grep pattern: `date[a-zA-Z_]*\s*(<>|!=|=)\s*''` across the server routes.
- Distinguish the *column* case from the *parameter* case. `($1 = '' OR
  sale_date >= $1::date)` is safe and common here — that tests a text
  parameter for "no filter supplied", not the column. Do not "fix" those.
- `col::date` on a column that is already `date` is a harmless no-op, so those
  casts can stay; only the string comparisons are fatal.
- Verify by actually calling each affected endpoint. Type-checking cannot see
  inside a SQL string.
