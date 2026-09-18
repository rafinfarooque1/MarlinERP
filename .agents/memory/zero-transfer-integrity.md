---
name: Zero-transfer periods and historical integrity
description: A period without transfer movements must not inherit unrelated historical stock checkpoint warnings through transfer-neutrality calculations.
---

For a statement period with no stock-ledger transfer movements, the transfer-opening adjustment is exactly zero and reliable; it must not run historical on-hand valuation solely to calculate a nonexistent adjustment.

**Why:** historical valuation can correctly surface stale or mismatched checkpoints on unrelated stock lines, but propagating those warnings into a no-transfer period falsely marks an otherwise supported opening stock as unreliable.

**How to apply:** short-circuit the transfer adjustment after its period-scoped transfer query returns no rows. If transfers exist, retain the historical boundary valuation and its evidence checks.

For a same-day statement ending today, if the scoped stock ledger has no movement
on that date, use the live closing valuation for both stock boundaries. This is
stronger than rewinding the prior-day checkpoint: late-recorded backdated
documents can leave that checkpoint stale, and sender-owned in-transit stock is
part of the live closing position.

**Why:** otherwise a stale prior-day checkpoint plus unchanged in-transit stock
appears as gross profit even though the physical position did not change during
the selected day.

**How to apply:** limit this boundary substitution to today's same-day,
no-stock-ledger-movement path; do not use it to make arbitrary historical
periods appear reliable.