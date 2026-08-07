---
name: Purchase edit per-line diff
description: Bill edits pair old/new lines and touch only changed stock; settlement floor replaced the blanket payments block.
---

# Purchase bill edit — per-line diff, not whole-bill reversal

**Rule:** PATCH /purchases/:id pairs old and new lines by `materialType:materialId:batchNumber` (lowercased; unique per bill via lineIdentityError). Untouched lines get NO stock writes; qty-only changes apply a validated delta; cost/date changes, removed lines → full reverse of THAT line only; moves and duplicate legacy keys fall back to full reverse+reapply of everything.

**Why:** the old edit reversed every line, and floored reversals cannot express "8 of these are gone" — so one consumed line blocked the whole bill, and skipping the check would invent stock.

**How to apply:**
- Validation must AGGREGATE required debits per lot and per (kind,id,location) before comparing — two lines of one product judged independently would each pass against the same unreserved stock.
- Emptied-lot cleanup after a reversal needs FULL lot identity (material_type + item_id + batch_number): a batch number alone is only unique per product, and an untouched line's fully-consumed zero-qty lot must keep its row and dates.
- Payments no longer block edits. The floor is: new grand total (goods + other charges) ≥ allocations + advances applied (409 BILL_BELOW_SETTLED_AMOUNT); vendor change with any settlement is 409 BILL_HAS_SETTLEMENTS. Outstanding re-derives automatically (books derive from the purchase row).
- The floor must be re-checked INSIDE the transaction after the purchase row FOR UPDATE — the allocation path locks the same row, so that re-read is what actually serialises money against the edit (pre-txn check is only fast-fail UX).
- A date change alongside a line edit re-dates ALL of the doc's stock_ledger rows (untouched lines' rows are no longer rewritten), same semantics as the metadata-only path.
