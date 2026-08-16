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
