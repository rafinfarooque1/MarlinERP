---
name: Retiring a module behind a feature flag
description: How a live ERP module is retired without deleting data or touching the frozen sidebar — flag storage, enforcement point, and the affordance-withdrawal rule.
---

# Retiring a module behind a feature flag

The rule: **the backend is the enforcement point; the frontend only withdraws
affordances.** Every retired-module write path returns 409 with a machine-readable
code, and the UI separately stops offering the action. Neither layer trusts the
other.

**Why:** a UI-only retirement leaves the API open to anything that still knows the
route (old tabs, cached bundles, direct calls, the mobile app). A backend-only
retirement leaves dead buttons that fail confusingly. Both are required, and the
frontend flag read must never be described or relied on as the security boundary.

**How to apply:**

- Flags live in `company_settings.general_settings` (JSON), read through a small
  server helper with a hardcoded default. **Default to the safe/retired state on
  any read error** — a failed settings fetch must never silently re-open the
  retired module. The frontend hook does the same with its own default.
- Guards go *after* schema validation and other input checks in the route, so a
  malformed payload still gets its 400 and tests exercising the guard need a
  fully valid body to reach it.
- Check *both* endpoints of a relational operation (a transfer's source **and**
  destination), not just one side.

## Retiring a nav entry while the sidebar is frozen

Filter the entry **by href inside the layout component**, and attach the badge
there too. Never edit the module registry's nav entries.

**Why:** the registry is the single source of truth for both the sidebar and the
permission matrix, and it is under a hard no-change constraint. Editing it to add
a `legacy` field or drop an entry breaks the freeze and can silently unhook a
permission key. Filtering downstream leaves `git diff` on the registry empty,
which is the proof the freeze held.

**How to apply:** keep the href in a named constant next to the filter. Restrict
visibility to the narrowest audience that still needs it (Head Office admins run
the historical reports; location staff never should), and badge it so nobody
mistakes an archive for a live feature.

## Where to draw the enforcement line

Block the creation of **new** activity at the retired location; let **already-open
documents reach a terminal state**.

**Why:** a naive "block every route that touches an outlet" reading traps stock,
money and documents in limbo permanently. Refusing to approve or reject a transfer
that was already dispatched leaves the goods deducted at source and never received
anywhere — worse than the thing the guard was protecting. Same for collecting on
an unpaid historical bill, or reconciling a deposit already banked.

**How to apply:** guard creates/edits/deletes (new bill, edit of a historical bill,
new price, new expense, new deposit, new return, **stock count/adjustment** — a
count is a stock write and is the easiest side door to miss, and **delete of
historical vouchers**, which would rewrite an audited period). Leave the
settle/approve/reject/reconcile transitions of pre-existing documents open. When a
review flags those transitions as holes, check whether anything is actually
in-flight before adding a guard that could strand it.

## Read-only means readable

Retiring must not hide history. List/GET endpoints stay open, the page keeps its
table, search and CSV export, and only Add/Edit/Delete disappear. Operational
filters default to the surviving location types with an explicit
"include legacy" opt-in for audits — put that opt-in **inside the shared filter
component** so every report inherits it instead of each page reimplementing it.

Watch for the render-time side effect when the opt-in flips off while a legacy
value is still selected: reset the selection in an effect, never during render.
