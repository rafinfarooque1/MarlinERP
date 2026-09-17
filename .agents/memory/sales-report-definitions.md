---
name: Sales report definitions
description: Meaning of Sales Register and By Item totals when invoices contain non-item charges
---

Sales Register is the complete invoice-value report and includes invoice-level other charges. By Item is a merchandise-line report: it sums stored line taxable values and tax, and excludes invoice-level charges because they cannot be attributed to an item without inventing an allocation.

**Why:** A warehouse reconciliation exposed a ₹150 charge on one invoice that was correctly absent from By Item. Making the UI label the two meanings prevents a legitimate dimensional difference from being treated as a data error.

**How to apply:** Keep complete-invoice dimensions (register, salesperson, location, combined sales) on `sales.total_amount`; label item totals explicitly and do not force them to equal the register.