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

**How to apply:** keep the href in a named constant next to the filter, drop the
entry for *everyone*, and drop the containing group too once filtering leaves it
empty — a retired module leaves no badge, no "disabled" placeholder and no blank
gap. Pair the filter with a route guard: hiding nav does nothing about a
bookmarked URL, so the route itself must render an "access disabled" screen (and
render `null`, not the screen, while the flag is still loading).

**Superseded:** an earlier pass kept the entry visible to Head Office admins
badged "Legacy · Disabled". The owner rejected that outright — a retired module
must look retired. Do not reintroduce the badged-for-admins variant.

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

Retiring hides **affordances**, never **data**. The list endpoint keeps returning
retired locations even while the module is off.

**Why:** those names are what historical documents render with. Make `GET /outlets`
return empty while the flag is off and every past outlet sale in every report
degrades to "Outlet #3". Preserving the audit trail was the entire reason the
records were kept rather than deleted.

So: selection controls disappear; lookups, joins and historical columns stay. A
historical "Outlet" *column* in a payments table is aggregation, not an
affordance — leave it.

## One service, two hooks: selectable vs historical

Put the "which location types are on" decision in **one module** that pages import,
and give it **two** separate readers: one returning what may be *selected* (empty
when the module is off) and one returning *everything* for labelling and
aggregation. Page-by-page `if (flagOn)` conditions do not survive the next page
that gets added.

**Why:** the two needs look identical at the call site and are opposite in effect.
Feed a dropdown from the "everything" reader and the retired module is still
offered; feed a historical grouping or a rolled-up total from the "selectable" one
and rows lose their names or fall out of a sum. The split has to be visible in the
*name of the hook*, because reviewing this later means judging one call at a time.

**How to apply:** at each call site ask "is a human choosing from this list, or is
it explaining/aggregating rows that already exist?" Choosing → selectable.
Explaining → everything. Money-bearing aggregation always stays on everything: a
child location's sales must keep rolling into its parent's totals while the module
is off, or a visible figure drops with no explanation. Hide the retired *labels*
and chrome instead. State this boundary explicitly when reporting the work — an
owner may want the totals hidden too, and that is their call, not a detail to bury.

## Page-level retirement: one shared set, keys stay registered

For retiring whole pages (as opposed to flag-gating a module), there is now ONE
shared constant — `RETIRED_PAGE_HREFS` in the frontend module registry — that
three consumers read: the sidebar filter (AppLayout), the route table (App.tsx
comments mark where routes were removed; the trailing catch-all renders the
standard 404), and the Permissions matrix (rows filtered out, save loop writes
only active keys).

**Why:** the earlier ad-hoc approach (a local set inside AppLayout) retired only
the nav; typed URLs still reached the page, and the permission matrix kept dead
rows. One set makes the three surfaces impossible to desynchronise.

**How to apply:**
- Do NOT touch the registry's `navEntries` or delete `page:` keys — backend
  `requireModuleView` any-of guards and the permissions checker
  (`scripts/src/check-permissions.ts`) reference the keys; deleting them breaks
  guard validation, seeding determinism, and existing DB permission rows.
- Remove the wouter `<Route>` blocks instead of adding guard screens: the
  catch-all already renders the standard 404, which satisfies "no blank screen
  from stale bookmarks".
- Matrix save must write only the non-retired keys, so retired DB rows are left
  untouched (nothing deleted, nothing re-seeded).
- Keep the retired page component files in-tree; they are unreferenced but
  their permission keys stay valid, so typecheck and the checker stay green.
- Grep for `navigate('/<retired-href>')` deep-links (dashboards' panel-header
  onNavigate props are the usual offenders) and the mobile app.

## The stale-selection trap

Removing an option from a filter does not remove it from that filter's *state*.

**Why:** a page still holding the retired value keeps scoping its queries to it
while the control to clear it has just vanished. Every total on screen
understates, and there is nothing left in the UI to explain or undo it. Hiding an
option must never change what a number means.

**How to apply:** reset the selection to its neutral value in an effect keyed on
the flag — never during render. Do it in *every* page holding local filter state,
not just the shared component; a small shared hook is the only way this stays
true as pages get added.
