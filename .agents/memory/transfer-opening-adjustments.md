---
name: Transfer opening-stock adjustments
description: How periodic books keep stock transfers neutral without double-counting closing inventory
---

Periodic statements treat transfer movements as opening-stock adjustments, not as separate closing-stock corrections:

- dispatch from a location reduces adjusted opening by the transfer-ledger value;
- receipt increases adjusted opening by the transfer-ledger value;
- rejected transfers net through their return movement;
- active in-transit quantities are removed from the dispatch adjustment because they remain sender-owned in closing valuation;
- active shipments from before the requested period are carried into the sender's opening position.
- legacy transfer rows with a non-null zero unit cost use the authoritative product weighted-average/manual cost fallback; zero is missing data, not free stock.

**Why:** The statement formula is opening stock + purchases − closing stock. Changing both opening and closing for the same transfer, or using reservation valuation instead of the movement's traceable cost, creates artificial P&L changes and breaks dispatch/receipt neutrality.

**How to apply:** Derive the adjustment from dated transfer rows in `stock_ledger`, scope it with the same location identities as stock valuation, use positive movement cost when present and the product valuation fallback when it is zero, and keep closing stock owned by the shared valuation layer.