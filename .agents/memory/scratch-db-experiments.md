---
name: Scratch-DB experiments vs the dev database
description: How a "safe" experiment on a cloned scratch database ended up writing to dev — shell backgrounding and empty psql connstrings.
---

# Scratch-DB experiments can silently hit the dev database

**What happened:** an inverse-rename experiment meant for a scratch clone ran
against the dev DB and reverted a completed data migration. Two traps combined:

1. **`A && B && C &` backgrounds the ENTIRE chain**, not just the last command.
   Variables exported inside (`SCRATCH=...`) never reach the foreground shell;
   later foreground commands see them as empty.
2. **`psql ""` does not fail** — with an empty connstring it falls back to the
   environment (PG* / default), i.e. the DEV database, and executes happily.

**How to apply:**
- Set connection variables in the FOREGROUND shell; background only the
  long-running server process itself (`... node dist/index.mjs > log 2>&1 &`
  as its own statement, after the assignments).
- Before any write in a scratch experiment, print `SELECT current_database()`
  through the SAME variable the writes will use, and eyeball it.
- Prefer passing the full connstring literally to each psql call over relying
  on a shell variable that might be unset.
- Recovery is easiest when the migration is marker-guarded: clear the
  `migration_log` row + reseed state, restart, and let the idempotent boot
  migration redo the work — never hand-replay the transformation.
