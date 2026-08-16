---
name: Mobile app distribution (direct APK + iOS link)
description: How the ERP distributes the employee app without app stores — public endpoints, config keys, hardening rules, and how to retest them.
---

# Mobile app distribution

The employee app is deliberately NOT on Google Play / the App Store. Distribution model (owner-approved):

- **Android** — direct APK download. Admin configures `generalSettings.androidApkUrl` (+ `androidAppVersion`) under Settings → Mobile App. Public `GET /api/public/app/apk` server-fetches that ONE URL and streams it with a clean versioned filename (`<company>-Mobile-v<ver>.apk`, APK MIME). Unconfigured → honest 404 JSON.
- **iOS** — `generalSettings.iosInstallUrl` (+ `iosAppVersion`) must be an Apple-supported install destination (TestFlight https / `itms-services://` OTA manifest / store listing later). **A raw `.ipa` URL is rejected at PATCH, at read time, and in the client** — iPhones cannot install one from a browser, so offering it would be a fake download.
- `GET /api/public/app` is the stable URL printed QRs carry: Android UA → 302 to `/api/public/app/apk` (never the raw hosting URL), iOS UA → 302 to the install link, else honest HTML. Both endpoints auth-exempt by exact path match in app.ts.

**Why the hardening:** the download endpoint is public, so the server-side fetch was hardened after an architect FAIL: redirects followed manually (max 3 hops, each hop re-validated), non-localhost hostnames DNS-resolved and refused if private/loopback/link-local/reserved, `http://localhost` upstream allowed ONLY when `NODE_ENV !== 'production'` (in prod it would be SSRF against our own services), 300 MB stream cap + overall timeout. Read-time cleaning mirrors PATCH validation exactly (values can enter the blob via restores/SQL).

**How to apply / retest:**
- Legacy `mobileApp*Url` keys still validate on PATCH but are gone from the UI; absent = unconfigured everywhere.
- The dialog (DownloadAppDialog.tsx) clears QR state at effect start so a config change while open can never show a stale QR destination.
- Settings UI save PATCHes the whole `generalSettings` blob — probe scripts must GET-merge-PATCH, never send partial blobs.
- Test hosting gotcha: background processes (`nohup`, even `setsid`) do NOT survive between agent shell sessions — run file host + curl checks inside ONE shell command. Serving a test file from marlin-erp/public/ does NOT work either: curl through the proxy gets the SPA index.html fallback for every path.
- No real APK exists yet (Expo app; building one needs EAS). The honest unconfigured state is the correct production state until then.

## Direct APK upload (Aug 2026 — supersedes URL-first config)

Admin now uploads the `.apk` itself from Settings → Mobile App (`MobileApkManager` in Settings.tsx); `androidApkUrl` is demoted to an "Advanced: External APK Link" fallback. Flow: `POST /company/mobile-app/apk/upload-url` (presigned PUT under the dedicated `uploads/mobile-apk/` prefix — separate from per-employee attachment uploads so the attachment ACL can never match it) → browser PUTs the file → `POST /company/mobile-app/apk` commits → `DELETE` removes. Pointer lives in four `generalSettings` keys (`androidApkObjectPath/FileName/Size/UploadedAt`). Public download prefers the object over the URL; dangling pointer = honest 502, never a silent fallback.

**Hardening lessons (architect-driven, all pinned by tests/mobile-apk-upload.test.mjs — 39 checks):**
- **Server-managed jsonb keys must be preserved INSIDE the UPDATE.** The Settings save is a GET→merge→PATCH of the whole blob, so pointer keys are stripped from client input and carried forward via `($1::jsonb - keys) || (SELECT jsonb_object_agg(k,v) FROM jsonb_each(general_settings) WHERE k = ANY(keys))` in ONE statement. Copying them forward from an earlier SELECT races a concurrent publish/remove.
- **Presigned PUT = TOCTOU.** The signed URL stays writable for its whole TTL, so commit COPIES the upload to a fresh `published-<uuid>` object (no signed URL ever existed for it), validates THE COPY, and publishes the copy's path. Suite proves the old URL still accepts writes but the download is immune.
- **Validate archive structure by parsing, not string search.** ZIP magic + EOCD + walk central-directory records for an exact `AndroidManifest.xml` ENTRY name; a file whose content merely mentions the name must fail. Min-size (1 KB) check fires BEFORE the magic check — tiny junk files get "too small", not "not a ZIP" (matters for test expectations).
- iOS remains link-only by design — there is deliberately NO IPA upload path.
