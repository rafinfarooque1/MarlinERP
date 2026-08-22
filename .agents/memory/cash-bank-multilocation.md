---
name: Shared Cash/Bank availability
description: Rules for accounts that are available at more than one business location.
---

Cash/Bank account availability is a many-to-many selection rule, while every
posted business document retains one immutable effective location. Head Office
is an explicit `headoffice:0` availability membership, not the absence of a
branch membership.

**Why:** A shared account otherwise gets treated as branch-owned by legacy
location resolvers, causing either a branch user to stamp a transaction to a
different location or Head Office to be unable to use an explicitly shared
account. Removing one location can also accidentally erase the shared
account's backing ledger and opening balance.

**How to apply:** Any account picker, automatic payment routing, voucher guard,
or location cleanup must query the availability relation. Branch callers may
only see/use their own membership. An ambiguous Head Office write needs an
explicit location. Availability changes never update historic document stamps,
and location deletion must retain the account, ledger, and opening balance if
another membership remains.