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
