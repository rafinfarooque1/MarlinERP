---
name: Dev rows are load-bearing test fixtures
description: Why editing seemingly-scratch dev records (warehouses, vendors, items) can break the regression suites, and how to check before changing them.
---

# Dev rows are load-bearing test fixtures

Some rows in the development database are pinned **by id** inside the regression
suites in `artifacts/api-server/tests/`, together with an assumption about their
*attributes* — not just their existence.

The clearest case: a warehouse id is used as "the intra-state warehouse", and
the suite asserts that a Karnataka vendor billing into it produces CGST+SGST and
no IGST. Give that warehouse a GSTIN from another state and the assertion flips
to IGST — the suite fails somewhere far away from the row that was edited, and
nothing in the warehouse UI hints that the row is special.

**Why this bites:** dev rows are named like scratch data ("QA Test WH",
"REGR-TEST-WH"), so they look disposable. The coupling lives in a test file's
constant and its comment, not in the database.

**How to apply:** before changing the state, GSTIN, location or status of any
dev record you are about to use for a demo or a manual check, grep the test
directory for its id and its name. If it is pinned, either pick a different row
or keep the pinned attributes intact and vary only the fields your work needs.
Re-run the suite that pins it before you finish.

## The dev DB now holds REAL business data (since Aug 2026)

The reverse trap also exists: suites can no longer assume QA fixture rows.
The live import replaced warehouse billing profiles, set a company logo, and
turned POS coupons off — every suite that asserted the old QA identities broke.

**Rules for suites against this DB:**
- Never hardcode warehouse ids or their attributes. Resolve the first enabled
  warehouses after login, and PIN any billing-profile/company-settings state a
  suite asserts on (billing name, GSTIN, FSSAI, bank, UPI, signatory, logo,
  POS flags in `company_settings.general_settings`) — snapshot → set → restore
  in cleanup(), with cleanup also run at start for crash recovery.
- Fixture prices must respect the MRP floor of real items; backdated stock
  reads must stay within the real stock-ledger baseline (history-reach guard:
  use today, not a hardcoded past date).
- Always export ALL FOUR of `TEST_USERNAME`, `TEST_PASSWORD`,
  `TEST_ADMIN_USER`, `TEST_ADMIN_PASSWORD` — suites differ in which pair they
  read, and the fallback is 'admin', which collects lockout strikes in
  `login_lockouts` (that's the lockout table; `login_attempts` is just the
  audit log).
- Cleanup matchers on `line_items::text` (jsonb) must account for jsonb's
  canonical rendering: `"itemId": 206` has a space after the colon, so
  `LIKE '%"itemId":206%'` matches NOTHING and the suite silently leaks its
  cancelled fixture sales into the live DB forever (assertions still pass —
  they check the items table, not sales). Match by the fixture item-NAME tag
  or jsonb containment (`@>`), and make cleanup sweep by TAG so it also heals
  prior runs' leaks. After ANY suite run against this DB, verify zero
  tag-matching sales remain.
- Never use arbitrary live rows as MUTABLE fixtures, and never "reset" a
  workflow/status table to prepare a fixture — those rows are real operational
  history. Select a document that provably starts in the default state (e.g.
  `NOT EXISTS` its status row) so cleanup = delete-your-own-stamped-writes and
  survives a mid-run crash; for rows a test only *attempts* to mutate, snapshot
  before and assert bitwise-identical after.
