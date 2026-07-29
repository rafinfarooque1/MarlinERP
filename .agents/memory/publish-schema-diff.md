---
name: Publish-time schema diff vs boot migrations
description: Why publishing fails on text→date columns, and the only sequence that gets past it without touching production data
---

# Publishing diffs the two live databases, not the schema source

The Publish flow introspects the development and production databases, diffs
them, and applies the difference to production. It does **not** read
`schema.ts`, and it does **not** run the app's boot migrations first. So the
publish diff is a mechanical `ALTER`/`ADD`/`CREATE` list derived from column
metadata only.

**Why:** this project evolves its schema mostly through raw startup migrations
in the api-server boot path (guarded by a `migration_log` table). Those run in
whichever database the process is attached to, so development moves ahead of
production the moment a migration is written, and production only catches up
when a new build is published *and boots*. The publish diff therefore sees a
schema gap it tries to close by itself — using SQL it generates, not the SQL the
migration would have used.

## The statement that can never succeed

A bare `ALTER TABLE t ALTER COLUMN c SET DATA TYPE date` on a text column fails
with `42804 cannot be cast automatically to type date` — **always**, including
on an empty table. PostgreSQL has no automatic text→date cast; only an explicit
`USING` clause converts it. Consequences:

- Cleaning or nulling the data does **not** help. If a publish fails this way,
  do not go looking for bad values — the values are irrelevant.
- The reverse direction, `date → text`, **applies silently** with no `USING`.
  That asymmetry is the trap in the fix below: once production is `date` and
  development is `text`, the next publish will quietly convert production back.

## The sequence that works (production data untouched)

1. Align the **development** column types back to what production has, with an
   explicit `USING col::text`, in one transaction, verifying values are
   byte-identical before/after (`md5(string_agg(col::text, ',' ORDER BY id))`).
2. Hold development at the production type with a **development-only env var**
   the boot migration checks, so a restart does not re-convert and re-break the
   diff. It must be an env var, never a file or a code flag: a repo file would
   be deployed to production too and hold *it* back as well.
3. Publish. The diff now carries only additive/appliable DDL (new tables, new
   columns, widening casts such as integer→numeric, dropped NOT NULL).
4. The newly deployed build boots and runs the *real* migration with
   `USING NULLIF(col,'')::date`.
5. Remove the development hold and restart, so development converges to the same
   type. Both sides equal ⇒ later diffs clean.

## Gate the migration on the live column type, never on a log row

A `migration_log`-gated migration is **wrong for a type change**, and this was
proven the hard way: the conversion ran and succeeded in production, then two
later publishes each diffed development (`text`) against production (`date`) and
silently applied `date → text`, undoing it. The log row survived, so every
later boot skipped the migration — production was stuck as `text` with a row
claiming it had been converted.

**The rule:** a migration that changes a column *type* must inspect
`information_schema.columns` on every boot and convert whatever is still the old
type, ignoring any log row. Then an accidental reversal self-heals on the next
boot instead of becoming permanent.

**Do not publish twice inside step 3–5.** In that window production is `date`
and development is `text`, and the reverse cast applies without complaint. With
a type-driven migration the damage is temporary; with a log-gated one it is not.

## Make queries type-agnostic

Any query comparing such a column to a date expression must cast the column
(`col::date >= CURRENT_DATE`), never rely on the column already being a date. The
cast is a no-op when the column is `date` and is the difference between working
and a 500 when it is `text`. A bare `textcol >= CURRENT_DATE` has no operator and
takes down the whole endpoint.

**How to apply:** whenever a publish fails on a type change, check the direction
of the cast first. Narrowing conversions (text→date, text→numeric,
text→timestamp) belong in a boot migration with `USING`, and development must be
held at the production type until the build that carries the migration is live.
