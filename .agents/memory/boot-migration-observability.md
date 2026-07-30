---
name: Boot migration observability
description: Why a failed one-time migration can be completely invisible in production, and the boot structure that prevents it
---

# A one-time conversion must be its own top-level boot step

**Rule:** a one-time schema conversion never lives as a block buried inside a long
general migration function whose failure is swallowed by a single catch. It runs at
top level, after that function, in its own try/catch, and its outcome is persisted to
a table.

**Why:** production captures stdout only *after* the port opens, and the app logger
(pino) writes to stdout — so everything logged during boot is discarded. A migration
function that throws at statement N silently skips every statement after it while the
boot still reports perfectly healthy (healthz 200, server listening). A schema change
can therefore simply not happen, for days, with no trace in any log, and the only
visible symptom is "the column is still the old type".

**How to apply:**

- Boot-critical outcomes go to `console.error` (stderr), not the app logger.
- Persist each boot to a `boot_status` row: migrations ok?, the error + stack, and the
  conversion summary. Logs are ephemeral and unreachable after the fact; a table is
  queryable read-only in production later.
- Expose a tiny unauthenticated census endpoint returning column names and live types
  only — never business data, and a generic 500 body (an unauthenticated caller gets no
  database detail). It answers "did it actually apply?" without a redeploy.
- Make the pass **type-driven** (decide per column from its current type, not from a
  migration_log row). It is then idempotent and self-healing if something reverses it.
- Any env escape hatch that suppresses the conversion must be **refused in production**.
  Honouring it there recreates the exact invisible-skip failure it was meant to avoid.
- Prove it with fault injection: deliberately break the earlier migration function and
  confirm the conversion still runs, still records, and leaves data byte-identical.

**Corollary:** never date a running production build from git commit timestamps. The
"Published your App" commit is written *after* the build, so it cannot tell you which
code is live. Use the deployment build list/status instead.
