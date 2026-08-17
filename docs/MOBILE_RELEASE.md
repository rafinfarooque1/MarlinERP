# Mobile App Release Pipeline (Android)

The employee app is **not** on Google Play or the App Store. Android phones
install it directly from the ERP's own "Download Mobile App" window (Profile
menu → Download Mobile App), which serves the APK produced by the automated
build pipeline. There is **no manual upload** — no upload button, no URL
field, no hand-typed version.

## How a release ships

```
pnpm run build:android        # from the workspace root
```

That one command runs `artifacts/api-server/scripts/release-android-apk.ts`:

1. Reads the app version from `artifacts/employee-app/app.json` (the version
   shown to users always matches the APK that was actually built).
2. Starts an **EAS cloud build** on Expo's servers (`eas.json` → `apk`
   profile, a real installable `.apk`). This workspace cannot run the Android
   SDK/Gradle itself — the build happens on Expo's infrastructure.
3. Polls until the build finishes (typically 10–20 minutes), then downloads
   the artifact automatically.
4. Validates the bytes are structurally a real APK (ZIP + AndroidManifest.xml).
5. Publishes to object storage and flips the release manifest
   (`uploads/mobile-apk/current.json`) **last** — an atomic swap. A failed
   build can never break the currently served release.
6. The Download APK button, QR code and `/api/public/app` landing page serve
   the new build immediately, in **both development and production** (the
   storage bucket is shared; no redeploy needed).

## Requirements

- **`EXPO_TOKEN` secret** — an Expo access token
  (expo.dev → Account settings → Access tokens). Without it the script stops
  with: *"EXPO_TOKEN / EAS credentials are required to enable automatic APK
  builds."*
- **First build only**: EAS generates the Android signing keystore. If the
  non-interactive run asks for it, run once from `artifacts/employee-app`:
  `npx eas-cli build --platform android --profile apk` and accept the managed
  keystore; every later release is fully non-interactive.

## Serving architecture

- `GET /api/public/app` — QR landing page (device-aware).
- `GET /api/public/app/apk` — streams the current release, professional
  filename `<Company>-Mobile-v<version>.apk`.
- `GET /api/public/app/info` — JSON availability/version for the web client.
- Source of truth: the storage manifest, validated on every read
  (`api-server/src/lib/apkRelease.ts`). No release → honest 404, never stale.

## Maintenance

`artifacts/api-server/scripts/apk-release-tool.ts` (`show` / `publish` /
`remove`) is an **internal** seam used by the test suite
(`tests/mobile-apk-pipeline.test.mjs`) and for emergency operations. It is not
a user-facing upload feature.

## iOS

iPhones cannot install an app file from a browser — Apple only allows
TestFlight, enterprise OTA links, or the App Store. The Settings → Mobile App
page therefore keeps a configurable **iOS Installation Link** (e.g. a
TestFlight invite) and shows an honest "not currently configured" note until
one exists. Shipping iOS this way requires an Apple Developer account.
