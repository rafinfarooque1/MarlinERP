---
name: Excluding tables from pg_dump (and keeping structural checks honest)
description: Why --exclude-table breaks --clean restores, why a dedicated schema is the fix, and the rule that structural fingerprints must cover the same objects the dump does.
---

# Excluding your own metadata from a dump

A backup module has to exclude its own catalogue tables from the dumps it takes.
Otherwise restoring an old archive rolls the catalogue back to that date and
erases the record of every newer backup — **including the safety copy the restore
just took**, which is left orphaned in storage with nothing pointing at it.

## `--exclude-table` is a trap when combined with `--clean`

`--exclude-table` omits the table but **still dumps the sequence its serial
column owns**. With `--clean`, the dump then emits a `DROP SEQUENCE` for a
sequence the surviving (never-dropped) table's default still depends on, and
every restore aborts.

**Fix: put the excluded tables in a dedicated schema and use one
`--exclude-schema`.** That covers tables, sequences, indexes and constraints
together, and there is no list to keep in sync as tables are added.

`ALTER TABLE ... SET SCHEMA` carries owned sequences and indexes across, so
existing rows survive the move — safe to do in a startup migration.

**Why:** discovered empirically; both failures were silent until a real restore
was attempted, and neither showed up in unit-level testing.

**How to apply:** any time you exclude objects from a dump that also uses
`--clean`. Reach for `--exclude-schema` over `--exclude-table` by default.

## A structural fingerprint must describe the same objects the dump does

If the fingerprint is computed over the live schema *including* the excluded
tables while the dump omits them, the structure check can **never** match — it
fails on every archive while nothing is actually wrong.

Once exclusion is schema-based, both sides collapse to a plain
`table_schema = 'public'` filter and stay in agreement for free.

**How to apply:** whenever a check compares "what we dumped" against "what's
here", make the exclusion set a single shared definition, not two filters that
happen to agree today.

## `--single-transaction` is the entire safety story

PostgreSQL applies DDL transactionally, so a failed restore leaves the database
**exactly** as it was. Say so plainly in the failure message ("data unchanged") —
that sentence is the difference between a calm retry and a panicked one.

## Signing, not encrypting, a backup manifest

A request to "encrypt the backup metadata" should be reinterpreted as
**HMAC-signing** it. Encrypting under a key derived from a host secret
(`SESSION_SECRET` and friends) makes the manifest unreadable on the new host that
is the entire point of having a backup.

Signature status must therefore be three-valued: `valid` / `invalid` /
**`unverifiable`**. On a recovered host `unverifiable` is the *expected* result,
not evidence of tampering, and the UI has to say so or it reads as a security
alarm during a disaster. Real integrity comes from a per-file SHA-256 recorded in
the manifest, which is checkable anywhere.
