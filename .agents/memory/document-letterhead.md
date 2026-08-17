---
name: Shared document letterhead & server-rendered PDFs
description: The one-letterhead standard for every business PDF and the server-anchored rendering contract
---

**Rule:** Every business document PDF (invoices, money/journal/expense vouchers, return notes, challans, purchase bills, advance prints) renders SERVER-SIDE from the stored row, wearing the shared letterhead (`lib/pdf-kit/src/letterhead.ts` — `drawLetterhead`/`drawSignatureRow`/`drawGeneratedNote`). The masthead is the ISSUING LOCATION's identity via `resolveLocationIssuer` (per-location logo, company profile only as fallback). Clients send `{id}` only — never composed figures or a `cs` header.

**Why:** Client-composed PDF bodies let a caller print figures the books never held, and each module's hand-rolled header made the paperwork look like it came from different companies. One legacy route rendered a client-supplied body verbatim.

**How to apply:**
- New printable document ⇒ new `services/<doc>Pdf.ts` renderer + a `POST /pdf/<doc>` route in pdfGen.ts that fetches the row, applies the module's OWN LBAC convention (mirror its list/detail route — 404 outside scope), resolves the issuer from the document's location stamp, and passes `logoDataUrl: issuer.logoUrl`.
- Accent colors are semantic: receipts green [22,101,52], money-out navy [23,42,92], goods-movement teal [14,85,105], debit-note umber [141,63,21].
- Guards follow the OWNING page key; when a doc is printed from a second page (e.g. advances printing their linked voucher), add a dedicated endpoint guarded on that page which resolves the link server-side and fails closed on NULL links — do not widen the generic voucher endpoints.
- Advance prints = the linked book entry (payment voucher, or the legacy migration JV), never a bespoke sheet.
- Transfer/purchase line items store only ids — resolve names/HSN/unit from masters at print time, scoped by materialType (`item`→items, `material`→materials, `raw_material`→raw_materials).
- ₹ needs pdf-kit's embedded font (`FONT`), never Helvetica. Restart api-server after edits (pdf-kit is bundled at workflow start).
