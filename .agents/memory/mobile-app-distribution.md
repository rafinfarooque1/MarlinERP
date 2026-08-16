---
name: Mobile app distribution (automated EAS pipeline + iOS link)
description: How the ERP distributes the employee app without app stores — the automated Android build pipeline, storage manifest, public endpoints, and hardening rules.
---

# Mobile app distribution

The employee app is deliberately NOT on Google Play / the App Store. Distribution model (owner-approved):

- **Android** — produced ONLY by the automated pipeline (`pnpm run build:android` → api-server/scripts/release-android-apk.ts): EAS cloud build (needs the `EXPO_TOKEN` secret; not set yet as of Aug 2026 — the honest blocked message is baked into the script), artifact auto-downloaded (streamed with a 300 MB cap), validated, published via lib/apkRelease.ts. **The admin upload UI, upload endpoints, `androidApkUrl` proxy and manual version field were all REMOVED (Aug 2026)** — user mandate: no upload button, no URL field, no manual version. The version comes from employee-app/app.json at build time.
- **iOS** — `generalSettings.iosInstallUrl` (+ `iosAppVersion`) must be an Apple-supported install destination (TestFlight https / `itms-services://` / store listing). Raw `.ipa` URLs rejected at PATCH, read time, and client — iPhones can't install one from a browser. There is deliberately NO IPA path.

## Release manifest architecture (why storage, not DB)

Source of truth = `uploads/mobile-apk/current.json` in object storage, NOT `generalSettings`: the bucket is shared dev↔prod while the DBs are not, so one publish updates every environment at once. Rules pinned by tests/mobile-apk-pipeline.test.mjs (37 checks):

- **Manifest written LAST = atomic swap.** APK object (`published-<uuid>`) fully uploaded + validated first; a failed publish can never break the served release.
- **Grace window on replace:** the immediately-previous object is KEPT (a reader holding the old manifest can finish its download); older debris swept. `remove` sweeps everything.
- **Manifest is shape-validated on every read** (path regex, version regex, sha256 hex, size bounds); malformed/missing = honest 404 "no release", never stale.
- **Serve-time integrity gate:** the download route compares object size to the manifest's recorded size and 502s on mismatch — never serve bytes that changed after publication.
- The six retired `generalSettings` keys (`androidApkObjectPath/FileName/Size/UploadedAt`, `androidApkUrl`, `androidAppVersion`) are stripped from BOTH the PATCH payload and the stored blob (`jsonb - text[]`) — forged round-trips can't resurrect them.
- Public surface: `/public/app` (QR landing), `/public/app/apk` (download, `<Company>-Mobile-v<ver>.apk`), `/public/app/info` (JSON availability the web client reads) — all exact-path auth-exempt in app.ts. Settings shows a READ-ONLY release card; DownloadAppDialog reads /public/app/info so it can never claim a version the button doesn't serve.
- Internal seam: scripts/apk-release-tool.ts (show/publish/remove) IS the pipeline's storage step — used by the suite (synthetic zip-CLI APKs) and emergencies only. The suite refuses to run if a real `source: "eas-build"` release is live (shared bucket!).

## Durable hardening lessons (survive the upload feature's removal)

- **Validate archive structure by parsing, not string search:** ZIP magic + EOCD + walk central-directory records for an exact `AndroidManifest.xml` ENTRY; content merely mentioning the name must fail. Min-size check fires before the magic check.
- **Presigned PUT = TOCTOU** (historical but general): a signed URL stays writable its whole TTL — validate and serve only a fresh copy no signed URL ever existed for.
- **Enforce byte caps while streaming**, never after `arrayBuffer()` — a chunked body can exhaust memory before a post-hoc length check runs.
- EAS CLI is run here (`npx --yes eas-cli`, CI=1, cwd employee-app) despite the expo skill's "never run EAS CLI" rule — explicit user mandate; that rule's Expo-Launch rationale doesn't apply to APK sideloading. First build may need one interactive keystore run.
- Test-client gotcha: undici reuses pooled keep-alive sockets; after multi-second gaps the server has idle-closed them → `UND_ERR_SOCKET`/"other side closed". Retry raw fetches once on a fresh connection in suites.
