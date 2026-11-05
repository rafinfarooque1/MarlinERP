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

# Shape-valid is not calendar-valid: the second wave of 22007s

Blank strings are only half the problem. The other half is `'2026-02-30'` —
thirty days in February, or `'2026-13-01'`. A text column stored those happily;
a real `date` column rejects them with the same `22007`.

**The rule:** every date that reaches a `date` column or is compared against one
must be validated against the **calendar**, not just the `^\d{4}-\d{2}-\d{2}$`
shape. Do it once in a shared helper (build the date and read the fields back
out) and route every check through it.

**Why:** a codebase that grew up on text columns is full of hand-rolled
`const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s)` helpers — one per route
file, all subtly the same. While the columns were text they were adequate: the
value was only ever string-compared. The moment the column becomes `date`, every
one of them is a 500 waiting for a fat-fingered filter.

**How to apply:**
- Grep for `\d{4}-\d{2}-\d{2}` across the server, not just for write paths.
  Expect to find it in a `const dateRe`/`DATE_RE`/`isDateStr`/`isMonth` per file.
- **Read filters matter as much as writes.** `?from=2026-02-30` on a list or
  report endpoint is a 500 once the parameter is inferred as a date. This is the
  larger surface by far — one weak helper guards a dozen report routes.
- A month parameter (`YYYY-MM`) needs the same treatment; validate it by
  expanding to `${month}-01` and calendar-checking that.
- Normalisers are not validators. A `ymd()` helper that reshapes a `Date` into
  `YYYY-MM-DD` and otherwise does `String(v).slice(0, 10)` passes an impossible
  date straight through. Validate *after* normalising.
- Verify by replaying every date-carrying URL with an impossible date and
  asserting no 5xx. Type-checking cannot see any of this.

# Repair migrations: one bad legacy value must not block every good one

A set-based `UPDATE ... SET col = value::date` repair migration aborts
WHOLESALE on the first calendar-invalid legacy value (`'2026-02-30'` passes a
shape regex, then throws at the cast). With the deferred-migration pattern (no
migration_log row on failure) it retries and fails on every boot, repairing
nothing, until someone hand-fixes the one bad row.

**How to apply:** SELECT the candidates, validate each value in JS with a
calendar-true helper (build the UTC date, read the fields back), and UPDATE
row-by-row with parameterised, pre-validated strings. A bad value then skips
only its own field/row. Verify with adversarial fixtures: one valid mismatch,
one calendar-invalid value, one ambiguous duplicate — assert the valid one is
repaired and the migration still completes and logs.
