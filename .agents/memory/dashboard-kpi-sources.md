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
