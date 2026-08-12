---
name: Orphan sales & Sundry Debtors control fallback
description: Why the receivables ageing and the Trial Balance can disagree by exactly the balance sitting on the Sundry Debtors PARENT ledger.
---

**Rule:** when a sale's customer no longer exists (row deleted, CUST- ledger gone), its receivable leg derives onto the SYS-DEBTORS control ledger itself. The TB (children + parent-direct) then exceeds the ageing/control report (built from customer masters) by exactly the parent's own balance.

**Why:** an ₹3,000 ageing↔TB gap traced to four orphaned sales whose probe customers AND items had been deleted by an earlier test run — the classic "deleted customers leave invisible balances" failure. No table posts to ledger 37 directly, so a nonzero parent-direct balance is almost always derived fallback, not a manual JV.

**How to apply:**
- Diagnose with: children sum vs ageing total (should agree), then the parent row's OWN balance = the gap; then `SELECT * FROM sales s WHERE s.customer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM customers c WHERE c.id=s.customer_id)`.
- Fixture debris signature: created seconds apart, backdated sale_dates, round amounts, deleted items too. Unpaid + no receipts + no stock remnants ⇒ safe to delete the rows directly.
- Real business orphans (user-deleted customers) need reposting/restore instead — never blind-delete.
- Test suites that delete probe customers MUST delete their sales first (and vice versa).
