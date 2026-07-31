---
name: Invoice PDFs & public share links
description: Canonical server-side invoice rendering + HMAC public links + popup/download rules
---

## Architecture (keep it this way)

ONE canonical renderer: `api-server/src/services/invoicePdf.ts` (jsPDF + qrcode in Node). Preview, download, and WhatsApp all consume the same HTTP endpoint. Payslips & purchase orders still render client-side in `marlin-erp/src/lib/pdfUtils.ts`.

**Why:** Client-side jsPDF blob downloads triggered McAfee/AV false positives (blob URLs have no HTTP provenance) and duplicated renderers drift apart. Real HTTP responses with `Content-Type: application/pdf` + `Content-Disposition` + sanitized ASCII filename (`TST/2025-26/0004` → `Invoice-TST-2025-26-0004.pdf`) fixed it.

## Two public paths, two purposes — don't confuse them

**1. In-session token** (`POST /sales/:id/share-token` → `GET /api/public/invoices/:token.pdf`). Stateless HMAC `{saleId}-{expMs}-{hexSig}` signed with SESSION_SECRET, no DB row. It exists ONLY because `window.open` and a download navigation cannot carry an Authorization header. TTL is **minutes**.

**Why minutes:** at 30 days it was a forwardable, unrevocable public share link in all but name, mintable by anyone with `download`/`print`. The expiry is signed *inside* the token, so shortening it never breaks tokens already issued.

**2. Managed share link** (`invoice_share_links` row → `/api/share/invoice/<publicId>?token=…`). The customer-facing path: random-UUID publicId (never a sale id), 15-day TTL, one active link per invoice, revocable, replaceable, access-counted, audited. Requires the `share` right.

**3. Authenticated inline PDF** (`GET /sales/:id/invoice.pdf`, Bearer) — for the View sheet's embedded iframe, fetched via `customFetch` `responseType:'blob'` → `URL.createObjectURL`. **Why:** a passive sheet open must NOT be a token-issuance event — auto-minting in-session tokens on every View proliferates unrevocable public URLs. Tokens (path 1) are only for navigations that cannot carry an Authorization header (window.open / download).

## Share-link rules worth keeping

- **Store the link's token on the row; never derive it from SESSION_SECRET.** Deriving + storing only a hash ties every customer's link to a secret rotated for unrelated reasons — rotation kills links already in customers' hands AND makes the link the UI hands out next unopenable. The hashing bought nothing: the token opens one invoice PDF, and whoever can read the link table can read that invoice from `sales` beside it.
- **`download`/`print` is the exfiltration right; `share` is the governance right.** Anyone who may download an invoice can forward the file, so no token scheme can make `share` exclusive — don't contort the in-session path chasing that. What `share` actually controls is who may create a durable, revocable, audited customer link.
- **Expiry is derived from `expires_at` at read time**, never trusted from the status column, so no sweep job is needed. Revocation outranks expiry.
- **A wrong token answers identically to an unknown publicId (404)**, so a response can never confirm an id exists. The friendly 410 page renders only when the token IS valid.
- **Never derive an audit fact from the row count of an idempotent sweep.** "This link replaced an expired one" read the rowCount of the expire-sweep inside the mint transaction — but opening the invoice runs the same sweep first, so the common path logged a replacement as a first-time mint. Read the fact off the superseded row instead.
- **Revoke + mint must be ONE locked transaction** (per-sale `pg_advisory_xact_lock`), or a concurrent Share lands in the gap and orphans a live link the UI can never show, hence never revoke.
- The customer landing page is minimal server-rendered HTML from api-server, not a SPA route — a SPA route ships the whole ERP bundle to the customer.
- Links are built with `window.location.origin` — dev links die when the dev domain rotates; stable customer links require publishing.

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

## Auth on PDF fetches
- ALL /api routes require `Authorization: Bearer` (base64 `id:x`); `credentials: 'include'` alone → 401. `downloadPDFFromEndpoint` (marlin-erp `lib/download.ts`) attaches the token from localStorage `marlin_auth_token` — any new direct `fetch` to the API must do the same rather than relying on cookies.
- **How to apply:** when a PDF/download flow 401s with "Authentication required", check the Bearer header first, not the server.
