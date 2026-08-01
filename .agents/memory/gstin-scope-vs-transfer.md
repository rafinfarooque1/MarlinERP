---
name: GSTIN scope vs transfer resolver
description: Two GSTIN resolvers exist on purpose — filing scope falls back to company GSTIN, transfer classification must not.
---

## The rule
There are deliberately TWO "what is this location's GSTIN" answers:

- **Transfer/invoice classification** (`resolveLocationGst`, lib/gstTransfer.ts): reads ONLY the location's own column. Blank = unregistered = internal transfer, no tax invoice. Adding fallbacks here would change which transfers get taxed.
- **Return filing scope** (`gstinScope.ts`, GST pages filter): warehouse falls back to company GSTIN; outlet → parent warehouse → company. A location without its own registration files under its parent's/company's registration.

**Why:** They answer different questions. "Can this transfer carry a tax invoice?" needs strict own-column reading; "under which registration does this document get reported?" needs filing reality. An architect review flagged the divergence as inconsistency — it is not; do not "unify" them.

**How to apply:** Any new GSTIN-dimensioned feature must pick the right resolver for its question, and comment which one and why.

## Related conventions from the same task
- Purchase bills have NO per-bill payment records; per-bill status/modes derive from the payables-ageing FIFO (`vendorBillSettlement.ts`). The FIFO walk is per-vendor, so it can be bounded to a vendor-id set loss-free — but each included vendor needs its FULL bill history.
- Sale payment mode summary convention: paid → modes joined " + " (generic "Paid" if the money arrived via receipt vouchers with no sale_payments rows); partial → "<modes> + Credit"; unpaid → "Credit"; branch-transfer invoices → status 'na', "Branch Transfer".
- Filter endpoints must leave the unfiltered path byte-identical: build scope SQL only when a param is present; never restructure the base query.
