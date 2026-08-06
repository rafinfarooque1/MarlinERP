---
name: Dashboard money tiles must not re-classify postings
description: Why dashboard expense/bank KPIs read buildBooks instead of summing chart subtrees, and why they are company-level only
---

# Never re-derive "what counts as an expense" for a dashboard tile

A dashboard money tile must read the figure from the module that owns it
(`buildBooks`, behind the Profit & Loss), not recompute it by summing the
expense subtrees of the chart of accounts.

**Why:** summing the `SYS-DIREXP` / `SYS-INDEXP` subtrees over
`buildDerivedPostings` looks equivalent and is not. `buildBooks` excludes the
production-costing capitalisation overlay (`STD-FG-INV` / `STD-PROD-ABS`)
because closing stock already carries the manufactured value. A hand-rolled
subtree walk includes it, and the two answers diverge immediately — the first
run of such a walk reported direct expenses of -3,351.70 against the P&L's 0,
the whole gap being the absorbed-production credit. Any second implementation
of the classification rules will drift the same way the moment someone adds
another overlay or contra ledger.

**How to apply:** for any new money tile, call `buildBooks` and read the
statement node. To avoid deriving the posting stream twice, fetch the postings
once and inject them: `buildBooks(async () => postings, { fromDate, toDate })`
— the injected function replaces the internal `buildDerivedPostings` call, and
the postings are already capped at `toDate`, which is the only argument
`buildBooks` would have passed anyway.

Balances (bank, cash) are different: they are a plain subtree net of debits
minus credits with no classification rules to get wrong, so a shared subtree
helper is fine — but it must be *one* helper shared by every endpoint, or two
dashboards will disagree with the Cash Book.

# Located posting slices (supersedes "postings have no location")

Postings now carry location attribution, and the posting stream can be sliced
per location (`filterPostingsByLocation` / the `location` option on
`companyBalances` / `companyFinancials` / `buildBooks`). Money tiles for a
located view read the LOCATED SLICE of the one derived stream — never a
per-location re-aggregation of source tables, which drifts from the books.

Rules that survive:
- Opening balances have no location attribution: excluded from every located
  slice, included only company-wide.
- A branch login is FORCED to its own location's slice (never `null`, never
  the company figure).
- Still one source of truth: the same slice feeds dashboard, reports and P&L.

# Money In/Out tiles follow the selected range (Aug 2026)

`/dashboard/bi` returns `moneyFlows` = cash/bank debits (in) and credits (out)
for the REQUESTED fromDate/toDate and location, via `rangeMoneyFlows` (both
bounds optional → all-time). `todayMoney` in that response is now only a
legacy mirror of `moneyFlows`; the old `/dashboard/summary` endpoint keeps a
genuinely today-anchored `todayMoney`.

**Why:** the owner explicitly wanted the tiles to behave like every other KPI
("yesterday shows yesterday's money"), replacing the earlier deliberate
today-anchoring.

**How to apply:** validate any change to these tiles against
`/accounts/cash-bank-book` totalDebit/totalCredit on the STD-CASH and
STD-BANK group ledgers for the same range — they must match exactly (same
derived stream, same location helper). Opening balances are not postings, so
they never count as movement. The per-toDate postings cache is shared with
`companyFinancials`; a from-only request filters the uncapped stream.

The web dashboard's Payments/Receipts tiles read `moneyFlows.totalOut` /
`totalIn` directly. Cash-book convention applies: a cash→bank contra deposit
counts on BOTH sides (a payment out of cash and a receipt into bank) — that
is deliberate, not double-counting.

# DashboardBi client type is hand-written, not generated

`lib/api-client-react/src/dashboard-bi.ts` maintains the `/dashboard/bi`
response type by hand — new response fields must be added there (then
`pnpm tsc` in lib/api-client-react), or the frontend ends up with `as any`
casts like the old `profit` read.
