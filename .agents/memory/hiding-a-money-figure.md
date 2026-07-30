---
name: Hiding a money figure from a role
description: Why "hide the cost column" is never one column, and the write-echo trap that makes stripping a GET corrupt valuation
---

# Hiding a money figure from a role

## The figure has siblings, and the weakest guard wins

Hiding a cost/value column on the page that shows it is the smallest part of the
job. The same number is nearly always serialised by other endpoints reachable
with a *different, weaker* right: the equivalent report, the ledger, dashboard
tiles, and "combined" reports that pair the figure with something else (a
sales+stock handout, a transfer register). The role keeps the number as long as
any one of those is reachable.

**Why:** guards were written per-page as each surface was added, so the same
figure ends up behind several unrelated permission keys. Each round of review on
this change found another surface; none were found by reading the page itself.

**How to apply:** before claiming a figure is hidden, enumerate every endpoint
that serialises it and check the *guard on each*, not the guard on the page the
request came from. A cheap way to prove it: log in as the restricted role and
walk every candidate endpoint, recursively scanning the JSON for the money keys
rather than eyeballing the UI.

## Gate on an existing right that already implies the figure

Prefer reusing the page right of the report that already shows the number over
inventing a new permission. Anyone who can open that report can read the same
figures anyway, so it adds no new authority, needs no migration, and inherits
the level-1 bypass. A new permission row means every existing role silently
defaults to one answer or the other.

## Omit the field; never null or zero it

A `0.00` in a valuation column is a false statement about the business — it
reads as "this stock is worthless", not "you may not see this". Omit the key
entirely, make the client type optional so later code cannot assume it, and
return an explicit `canViewX` flag so the UI hides the column instead of
formatting an absent value. Where a whole screen exists only to show the figure,
drop it from the navigation rather than rendering it full of zeros.

## The write-echo trap: stripping a GET can corrupt the data you were protecting

Before removing a cost field from a response, find out whether any client reads
it from that response and posts it back. Approve/receive flows commonly do
exactly this — they map the fetched line items into the mutation body, cost
included. Strip the field and the echo becomes `cost ?? 0`, so every subsequent
receipt credits stock at zero cost and permanently damages the average cost.

**Why:** the requirement to hide a number and the requirement not to alter
valuation collide precisely here, and the damage is silent and cumulative.

**How to apply:** trusting a client-supplied cost is a bug in its own right —
anyone who can approve could post any cost. Make the server re-read the cost
from the stored document first; only then is removing it from the read response
safe. Until that is done, leave the field and say so, rather than shipping a
half-fix that trades a disclosure for data corruption.

**But confirm it before believing it.** A UI that echoes the field back is not
evidence that the server trusts it — the handler may already rebuild the value
from the stored row and ignore the payload entirely, which makes the strip
free. Read the write path to the point where the number is persisted before
concluding either way; the echo is the loudest clue and the least reliable one.

## The figure hides one level down

Line-level money is routinely repeated inside a nested breakdown — per-lot,
per-batch, per-instalment. Deleting the parent key alone leaves the child copy
in the payload, and a probe that only inspects top-level keys will call it
clean. Scan responses *recursively* for the money key names, and strip
recursively too.
