/**
 * INTERNAL release-maintenance tool — NOT a user-facing upload feature.
 *
 * The one supported way to ship an Android release is the automated EAS
 * pipeline (release-android-apk.ts). This tool exists for:
 *   - the automated test suite (publishes a synthetic APK so the public
 *     endpoints can be exercised without a 15-minute cloud build), and
 *   - emergency operations (inspect or clear the current release).
 *
 * Usage (from artifacts/api-server):
 *   tsx scripts/apk-release-tool.ts show
 *   tsx scripts/apk-release-tool.ts publish <file.apk> --version <v> [--source local-file]
 *   tsx scripts/apk-release-tool.ts remove
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { publishApkBuffer, readApkManifest, removeApkRelease } from "../src/lib/apkRelease";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === "show") {
    const m = await readApkManifest();
    console.log(m ? JSON.stringify(m, null, 2) : "No APK release is currently published.");
    return;
  }
  if (cmd === "remove") {
    const { removed } = await removeApkRelease();
    console.log(removed ? "Release removed — downloads now return an honest 404." : "No release was published.");
    return;
  }
  if (cmd === "publish") {
    const file = process.argv[3];
    const version = argValue("--version");
    if (!file || !version) fail("Usage: publish <file.apk> --version <v> [--source local-file]");
    const buf = readFileSync(path.resolve(file));
    const manifest = await publishApkBuffer(buf, {
      version,
      fileName: path.basename(file),
      source: argValue("--source") ?? "local-file",
    });
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }
  fail("Unknown command. Use: show | publish <file.apk> --version <v> | remove");
}

main().catch((err) => fail(err?.message ?? String(err)));
