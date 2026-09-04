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

**Why:** The statement formula is opening stock + purchases − closing stock. Changing both opening and closing for the same transfer, or using reservation valuation instead of the movement's traceable cost, creates artificial P&L changes and breaks dispatch/receipt neutrality.

**How to apply:** Derive the adjustment from dated transfer rows in `stock_ledger`, scope it with the same location identities as stock valuation, and keep closing stock owned by the shared valuation layer.