---
name: Invoice seller identity
description: Which location supplies the seller block on a tax invoice, what may fall back to the company, and why gaps must be judged on the resolved identity.
---

# Invoice seller identity

The seller printed on a sales tax invoice comes from **the location the sale was
raised at**, not from company settings.

**Why:** company settings hold one registration, but each warehouse can be its
own GST registration. Printing the company as seller puts the wrong GSTIN on a
statutory document, and reprints of old invoices from another branch would
silently re-attribute the sale.

## What may fall back, and what may not

| Field | Falls back to company? |
|---|---|
| Trade name, address, GSTIN, FSSAI, state | **No** — warehouse only |
| Bank details, UPI ID | **Yes** |
| Invoice footer | Yes |

**Why the split:** name/GSTIN/FSSAI identify *which registration issued the
document*, so a fallback would be a misstatement. Bank and UPI are collection
details for the same legal entity, and existing invoices already relied on the
company-level ones — removing that fallback would blank the payment panel on
every location that had not been filled in yet.

## Outlets

An outlet is a selling point of its parent warehouse, not a registration of its
own. It **inherits** the parent's legal identity and bank, but **overrides**
with anything it holds itself: name, address, phone, GSTIN, UPI handle. The UPI
override is deliberate — outlets have long collected into their own VPA.

## Judge completeness on the resolved identity

A "profile incomplete" warning must be computed from the identity that will
actually print, never from a single source row.

**Why:** an outlet with a fully-populated parent can still print with no address
of its own, and a fully-populated outlet under a bankless warehouse still prints
with no bank panel. Checking either row alone reports "complete" for an invoice
that visibly is not.

**How to apply:** resolve first, then run the gap check over the resolved
object. Anywhere a fallback chain exists, the check belongs after the chain.

## Historical reprints are live, not snapshotted

Seller identity is read live at render time, so editing a warehouse changes how
its *old* invoices reprint. This was accepted rather than snapshotting, because
back-filling a snapshot for historical sales means inventing the identity those
invoices were issued under. If a snapshot is ever added, it must be written
going forward only.
