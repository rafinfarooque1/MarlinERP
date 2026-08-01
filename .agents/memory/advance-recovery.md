---
name: Advance recovery vs payroll claims
description: cash recovery and payroll deduction of employee advances serialize on row locks; whole-amount only
---

Model: an employee advance settles by exactly ONE of two paths — payroll deduction (claimed at generate via deducted_payroll_id, closed at approval) or cash recovery (POST /hr/advances/:id/recover: JV Dr till / Cr ADV-EMP-<id>, sets is_deducted=TRUE with deducted_payroll_id NULL). "is_deducted TRUE + deducted_payroll_id NULL" MEANS recovered in cash. Whole remaining amount only — partial recovery would leave a remainder no other flow can see (payroll also takes advances whole).

**Why:** the two paths raced — payroll generate used unlocked pool statements, so an advance could be cash-recovered between its selection and its claim, then approval re-marked it payroll-recovered: settled twice, books wrong.

**How to apply:** payroll generate runs release→SELECT FOR UPDATE→payroll write→claim as ONE transaction per employee, asserting the claim rowCount; recovery locks the same row (FOR UPDATE) and refuses claimed rows; approval closes claims with `AND deducted_payroll_id = <run id>` and asserts the count, throwing "regenerate the draft" on mismatch. Never weaken any of the three — each guards a different interleaving. Any new settlement path for advances must take the row lock first and preserve the one-path invariant.
