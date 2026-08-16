/**
 * Automated Android release pipeline:
 *
 *   Expo source (artifacts/employee-app)
 *     → EAS cloud build on Expo's servers (this workspace cannot run
 *       Gradle/Android SDK — the build happens on Expo's infrastructure,
 *       authenticated by the EXPO_TOKEN secret)
 *     → the finished .apk artifact is downloaded automatically
 *     → validated (real ZIP + AndroidManifest.xml)
 *     → published to object storage + manifest flip (lib/apkRelease.ts)
 *     → the existing Download Mobile App button / QR serve it immediately.
 *
 * Run from the repo root:  pnpm run build:android
 * (or: pnpm --filter @workspace/api-server run release:android)
 *
 * No file ever passes through a human: no upload button, no URL field, no
 * manual version entry. The version is read from employee-app/app.json at
 * build time, so it always matches the APK that was actually built.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publishApkBuffer, APK_MAX_BYTES } from "../src/lib/apkRelease";

const __dirnameLocal = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirnameLocal, "../../employee-app");

const POLL_INTERVAL_MS = 30_000;
const BUILD_TIMEOUT_MS = 40 * 60_000;

function fail(msg: string): never {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

function readAppJson(): { version: string; projectId: string | null } {
  const raw = JSON.parse(readFileSync(path.join(APP_DIR, "app.json"), "utf8"));
  const version = raw?.expo?.version;
  if (typeof version !== "string" || !version.trim()) {
    fail("employee-app/app.json has no expo.version — set a version like 1.0.0 there.");
  }
  const projectId = raw?.expo?.extra?.eas?.projectId;
  return { version: version.trim(), projectId: typeof projectId === "string" ? projectId : null };
}

/**
 * The APK runs on phones OUTSIDE Replit's proxies, so the API address must be
 * baked into the bundle at build time via eas.json → build.apk.env
 * EXPO_PUBLIC_DOMAIN. EAS cloud builds do NOT inherit this workspace's shell
 * environment: without the eas.json entry the app ships with no server
 * address at all and every login fails (relative requests fall through to
 * expo-router's placeholder origin — the v1.0.0 "Expected X-Requested-With
 * header" incident). Fail the release up front instead.
 */
function assertBakedApiDomain(): string {
  const raw = JSON.parse(readFileSync(path.join(APP_DIR, "eas.json"), "utf8"));
  const domain = raw?.build?.apk?.env?.EXPO_PUBLIC_DOMAIN;
  if (typeof domain !== "string" || !domain.trim()) {
    fail(
      "employee-app/eas.json must bake the production API address into the APK:\n" +
      '  build.apk.env.EXPO_PUBLIC_DOMAIN = "<the published domain, e.g. erpmarlin.replit.app>"\n' +
      "Without it the built app has no server address and every login fails.",
    );
  }
  const d = domain.trim();
  if (/\.replit\.dev$/i.test(d)) {
    fail(
      `employee-app/eas.json bakes EXPO_PUBLIC_DOMAIN=${d} — that is a temporary development ` +
      "domain that phones outside Replit cannot use. Point it at the published domain " +
      "(e.g. erpmarlin.replit.app).",
    );
  }
  return d;
}

/** Run eas-cli inside the employee-app dir. Never prints the token. */
function eas(args: string[], opts: { allowFail?: boolean } = {}) {
  const r = spawnSync("npx", ["--yes", "eas-cli", ...args], {
    cwd: APP_DIR,
    env: { ...process.env, CI: "1" },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 10 * 60_000,
  });
  if (r.error) fail(`Could not run eas-cli: ${r.error.message}`);
  if (r.status !== 0 && !opts.allowFail) {
    console.error(r.stdout || "");
    console.error(r.stderr || "");
    fail(`eas ${args[0]} failed (exit ${r.status}). The EAS output above explains why.`);
  }
  return r;
}

/** Last JSON value in a CLI's stdout (eas prints logs around the JSON). */
function lastJson(stdout: string): any {
  const text = stdout.trim();
  for (let i = text.indexOf("["), j = text.indexOf("{");
       ;) {
    const start = Math.min(i === -1 ? Infinity : i, j === -1 ? Infinity : j);
    if (!Number.isFinite(start)) return null;
    try { return JSON.parse(text.slice(start)); } catch { /* fallthrough */ }
    i = text.indexOf("[", start + 1);
    j = text.indexOf("{", start + 1);
  }
}

async function main() {
  if (!process.env.EXPO_TOKEN) {
    fail(
      "EXPO_TOKEN / EAS credentials are required to enable automatic APK builds.\n\n" +
      "  1. Create a free Expo account at https://expo.dev\n" +
      "  2. Go to expo.dev → Account settings → Access tokens → Create token\n" +
      "  3. Save it in this project as the EXPO_TOKEN secret\n" +
      "  4. Run this command again — everything else is already wired up.",
    );
  }

  const { version, projectId } = readAppJson();
  const apiDomain = assertBakedApiDomain();
  console.log(`▸ Building Marlin Employee App v${version} (Android APK) via EAS`);
  console.log(`▸ App will talk to: https://${apiDomain}`);

  if (!projectId) {
    console.log("▸ No EAS project linked yet — running eas init (one-time)…");
    eas(["init", "--non-interactive", "--force"]);
    const after = readAppJson();
    if (!after.projectId) {
      fail(
        "eas init did not link a project. Run it once manually from artifacts/employee-app:\n" +
        "  npx eas-cli init\n" +
        "then re-run this command.",
      );
    }
  }

  console.log("▸ Starting cloud build (this runs on Expo's servers)…");
  const start = eas([
    "build", "--platform", "android", "--profile", "apk",
    "--non-interactive", "--json", "--no-wait",
  ], { allowFail: true });
  if (start.status !== 0) {
    console.error(start.stdout || "");
    console.error(start.stderr || "");
    if (/credentials|keystore/i.test(`${start.stdout}${start.stderr}`)) {
      fail(
        "EAS needs to generate an Android signing keystore the first time, which can " +
        "require one interactive run. From artifacts/employee-app run:\n" +
        "  npx eas-cli build --platform android --profile apk\n" +
        "answer 'yes' to letting EAS manage the keystore, then re-run this command " +
        "for all future releases.",
      );
    }
    fail(`eas build failed to start (exit ${start.status}). The EAS output above explains why.`);
  }
  const started = lastJson(start.stdout || "");
  const build = Array.isArray(started) ? started[0] : started;
  const buildId: string | undefined = build?.id;
  if (!buildId) fail("Could not read the build id from EAS output.");
  console.log(`▸ Build queued: ${buildId}`);
  console.log(`  Watch it at: https://expo.dev (Projects → builds)`);

  const deadline = Date.now() + BUILD_TIMEOUT_MS;
  let artifactUrl: string | null = null;
  for (;;) {
    if (Date.now() > deadline) fail("Build did not finish within 40 minutes — check expo.dev for its status, then re-run.");
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const view = eas(["build:view", buildId, "--json"], { allowFail: true });
    const info = lastJson(view.stdout || "");
    const status: string = info?.status ?? "UNKNOWN";
    process.stdout.write(`  … status: ${status}\n`);
    if (status === "FINISHED") {
      artifactUrl = info?.artifacts?.applicationArchiveUrl ?? info?.artifacts?.buildUrl ?? null;
      if (!artifactUrl) fail("Build finished but EAS reported no artifact URL — check the build page on expo.dev.");
      break;
    }
    if (status === "ERRORED" || status === "CANCELED") {
      fail(`Build ${status.toLowerCase()} — open the build's logs on expo.dev to see the failure.`);
    }
  }

  console.log("▸ Downloading the built APK…");
  const resp = await fetch(artifactUrl, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!resp.ok || !resp.body) fail(`Artifact download failed (HTTP ${resp.status}).`);
  const declared = Number(resp.headers.get("content-length") ?? 0);
  if (declared > APK_MAX_BYTES) fail("The built APK exceeds the 300 MB serving limit.");
  // Stream with a hard byte cap — never buffer an unbounded body on trust.
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of resp.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > APK_MAX_BYTES) fail("The built APK exceeds the 300 MB serving limit.");
    chunks.push(Buffer.from(chunk));
  }
  const buf = Buffer.concat(chunks);
  console.log(`  ${(buf.length / (1024 * 1024)).toFixed(1)} MB downloaded`);

  console.log("▸ Validating and publishing to object storage…");
  const manifest = await publishApkBuffer(buf, {
    version,
    fileName: `employee-app-v${version}.apk`,
    source: "eas-build",
    easBuildId: buildId,
  });

  console.log("\n✓ Release published.");
  console.log(`  Version:  ${manifest.version}`);
  console.log(`  Size:     ${(manifest.size / (1024 * 1024)).toFixed(1)} MB`);
  console.log(`  SHA-256:  ${manifest.sha256}`);
  console.log("  The Download Mobile App button and QR code now serve this build");
  console.log("  in BOTH development and production (shared storage bucket).");
}

main().catch((err) => fail(err?.message ?? String(err)));
