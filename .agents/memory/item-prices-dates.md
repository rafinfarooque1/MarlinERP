---
name: Item prices date range
description: The valid_from / valid_to date range feature for item prices
---

## DB schema
`valid_from` and `valid_to` are `text` columns (YYYY-MM-DD format) added to `item_prices` table.

## Migration approach
Startup migration in `artifacts/api-server/src/index.ts` runs before the server starts:
```sql
ALTER TABLE item_prices ADD COLUMN IF NOT EXISTS valid_from text;
ALTER TABLE item_prices ADD COLUMN IF NOT EXISTS valid_to text;
```

## Type cast needed
The auto-generated `ItemPrice` type from api-client-react does NOT include validFrom/validTo.
Use `(ip as any).validFrom` and `(ip as any).validTo` when accessing these fields.

## API
The `POST /api/item-prices` endpoint (in sales.ts) reads `req.body.validFrom` and `req.body.validTo` as extra fields outside the Zod-validated body and passes them to the upsert.

**Why:** The Zod schema `SetItemPriceBody` is auto-generated and can't be easily extended without touching the code generator. The extra fields are passed through safely alongside the validated payload.
