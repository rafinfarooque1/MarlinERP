---
name: Product identity (codes, barcodes, status)
description: How item codes, barcodes and active/inactive status are issued and enforced across the three product master tables, and why each choice was made
---

# Product identity

Three separate master tables (finished SKUs, raw materials, packing materials)
each carry `item_code`, `barcode` and `status`. They were deliberately **not**
merged; only identity columns were added.

## Code prefixes follow the USER-FACING type, not the table name

The table named `materials` is displayed as **"Raw Material"** and the table named
`raw_materials` is displayed as **"Packing Material"** — the names are inverted
relative to intuition. Codes therefore read `FG-####` (finished goods), `RM-####`
(the `materials` table) and `PM-####` (the `raw_materials` table).

**Why:** a code is a human-facing label; matching it to the table name would put
`RM-` on the packing materials the warehouse calls packing materials.

**How to apply:** whenever you write a prefix, label or filter for these tables,
check the display label in the UI rather than the table name.

## Barcodes are real EAN-13s in the in-store range

Leading digit `2`, then a kind digit, then a 10-digit sequence, then a mod-10
check digit. The `2` prefix is reserved worldwide for restricted circulation.

**Why:** a barcode that is merely "13 digits" fails on real scanners, and a
made-up prefix can collide with a bought-in GTIN printed on supplier packaging.
The `2` range can never collide by definition.

**How to apply:** issue numbers from one Postgres sequence per kind (`nextval`
never reuses a number under concurrency or rollback) — never from `COUNT(*)`,
`MAX(id)+1`, or a name hash. Unique indexes are **partial**
(`WHERE col IS NOT NULL AND col <> ''`) so blank identities never collide, and a
23505 on manual entry is translated to a friendly 409.

## Batch identity is a snapshot; historical MRP is never fabricated

A lot copies the parent's barcode and the MRP in force when the lot was created.
Pre-existing lots were backfilled with a barcode but **not** an MRP.

**Why:** a barcode is stable identity derived from the parent, so backfilling it
is a statement of fact. Stamping today's MRP onto a lot made months ago invents a
price that never applied. Same precedent as legacy batches keeping NULL costs.

**How to apply:** reads may fall back to the parent's current MRP for display,
clearly as a fallback; never write that fallback back to the row. A zero MRP means
"not priced yet" and must surface as null, never as ₹0.00.

## Inactive means "no new activity", never "frozen"

The inactive check runs on **CREATE routes only** — new sales, purchases,
production runs and transfers. Never on edit, approve, dispatch, receive, reject
or payment paths.

**Why:** the same principle as retiring a module: block new activity, but let
documents already in flight reach a terminal state and keep history editable and
refundable. Blocking an approval would strand goods that are physically in transit.

**How to apply:** frontend pickers mirror the create guard, but **edit forms must
keep an already-selected product visible even once it goes inactive** — otherwise
opening an old document silently blanks the line. Returns are raised against
historical sales, so their pickers stay unfiltered.

## Head-Office-only is a LOCATION rule, not a hierarchy rule

Item-master writes gate on the employee's branch type being head office, not on a
permission level or role name. Read routes are deliberately untouched.

**Why:** item masters are company-wide data; a warehouse editing them changes what
every other location sees. But warehouses must keep full visibility of what they
hold, so restricting reads would break their day-to-day work.

**How to apply:** the frontend only withdraws the affordance — the server is what
enforces it. Do not hide a control whose route lacks the server-side gate; that is
cosmetic security.
