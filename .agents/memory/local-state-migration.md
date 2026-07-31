---
name: Client→server state migration
description: Rules for migrating localStorage-persisted assets/state up to the server (company logo case)
---

The company logo originally lived ONLY in browser localStorage (`marlin_company_logo`), so the server-rendered invoice PDF could never print it. The fix stores it in `company_settings.logo_url` as a PNG data URI (client normalises uploads to ≤512px PNG via canvas; jsPDF cannot fetch URLs or draw SVG).

**Rule:** a migration that pushes localStorage state up to the server must be one-shot **per browser** (flag key, e.g. `marlin_logo_synced_v1`), and after the first sync, server absence means "deleted on purpose" — clear the stale local copy instead of re-uploading it.

**Why:** without the flag, any browser holding an old local copy resurrects a logo an admin deliberately removed on another device, and a slow migration PATCH can overwrite a newer upload.

**How to apply:** on mount — server value present → mirror down + set flag; server empty + flag unset + local present → migrate up once, set flag; server empty + flag set → delete local copy. Set the flag on every explicit upload/remove too.

Related hardening: data-URI images accepted by the API get header-only dimension checks (PNG IHDR / JPEG SOF) to reject image bombs before the PDF renderer pays the decode cost; clearing uses `logoUrl: ''` because the generated zod body schema is `string().optional()` and rejects null.
