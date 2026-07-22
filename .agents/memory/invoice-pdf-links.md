---
name: Invoice PDFs & public share links
description: Canonical server-side invoice rendering + HMAC public links + popup/download rules
---

## Architecture (keep it this way)

ONE canonical renderer: `api-server/src/services/invoicePdf.ts` (jsPDF + qrcode in Node). Preview, download, and WhatsApp all consume the same HTTP endpoint. Payslips & purchase orders still render client-side in `marlin-erp/src/lib/pdfUtils.ts`.

**Why:** Client-side jsPDF blob downloads triggered McAfee/AV false positives (blob URLs have no HTTP provenance) and duplicated renderers drift apart. Real HTTP responses with `Content-Type: application/pdf` + `Content-Disposition` + sanitized ASCII filename (`TST/2025-26/0004` → `Invoice-TST-2025-26-0004.pdf`) fixed it.

## Public links

- Stateless HMAC-SHA256 tokens (`{saleId}-{expMs}-{hexSig}`, 30-day TTL) signed with SESSION_SECRET — no DB storage. `shareToken.ts` throws at startup if SESSION_SECRET missing (never add a fallback secret).
- `GET /api/public/invoices/:token.pdf` (exempt from auth guard; `?download=1` → attachment). Minting: authed `POST /sales/:id/share-token`.
- Links built with `window.location.origin` — dev links die when the dev domain rotates; stable customer links require publishing.

## Popup & download rules (browser)

**Why:** popup blockers kill `window.open` outside a user gesture; the old WhatsApp flow opened wa.me inside `setTimeout(500)` and silently did nothing.

**How to apply:**
- Open `window.open("")` SYNCHRONOUSLY in the click handler, then `tab.location.replace(url)` after the async token fetch. Never open after an await without a pre-opened tab.
- Plain downloads need no popup: `window.location.assign(attachmentUrl)` keeps the page and fires exactly one download.
- WhatsApp share = `wa.me/91<phone>?text=` with the public PDF link in the message (no Business API).

## Invoice data fidelity

- Sales `lineItems` JSONB snapshots `itemName`/`hsnCode`/`unit` at creation (units matter — items are sold in "pkt", not KG).
- Renderer backfills each field INDEPENDENTLY from the items table for old rows (never gate hsn/unit backfill on name being missing).
- Standard PDF fonts lack the ₹ glyph — use "Rs.".
