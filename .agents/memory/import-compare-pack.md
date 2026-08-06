---
name: Located import compare pack
description: Durable decisions on location-scoping the import demo/compare reports and the wizard's location-at-trial contract
---

# Located import compare pack

**Scope through the owning filter types, never hand-rolled WHERE clauses.** The compare
pack must produce figures identical to the live report screens under the same location
filter — any separately-derived math will drift.
**Why:** users approve migrations by matching these numbers against their old ERP; a
divergent slice makes the comparison useless.

**Mirror places match via opt-in identity sets.** A physical place mirrored as both
warehouse and outlet (shared cash ledger) is handled by optional identity-set fields on
the owning filter/scope types, not duplicated OR-clauses at call sites.
**Why:** request parsers never populate those fields, so every live route keeps exact
type+id matching; only callers that deliberately resolve mirrors get the expanded match.
**How to apply:** a new read that must see a mirrored place under both stamps sets the
identity fields; never populate them from request input.

**Wizard location is chosen at TRIAL time, and approval refuses any other.** The trial
re-stamps and re-validates every file at the chosen location, records the rehearsal
there, and scopes the compare pack to it; approve rejects a different location with a
"re-run the trial there" error. Trials that predate this (or divergent per-file stamps)
must re-run once at the chosen location before approving.
**Why:** approval's guarantee is "imports exactly what the demo showed" — including
WHERE. Approving at a location the trial never ran at imports figures nobody compared
(a completion review rejected the label-only variant for exactly this).

**Old stored packs are unlabeled, never regenerated.** Packs computed before scoping
lack the location key; the UI hides the location banner for them. Re-running the demo
regenerates a scoped pack.
