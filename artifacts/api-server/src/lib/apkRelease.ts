/**
 * Android APK release management — single source of truth for "what APK does
 * the Download Mobile App button serve?".
 *
 * Architecture (automated build pipeline, no manual upload):
 *   Expo source (artifacts/employee-app)
 *     → EAS cloud build (scripts/release-android-apk.ts, needs EXPO_TOKEN)
 *     → artifact downloaded + validated server-side
 *     → published object in object storage  (uploads/mobile-apk/published-<uuid>)
 *     → manifest written LAST               (uploads/mobile-apk/current.json)
 *
 * The manifest lives in OBJECT STORAGE, not the database, on purpose: the
 * release script runs in the dev workspace, but the storage bucket is shared
 * between dev and production while the databases are NOT. A DB pointer would
 * update dev only; the manifest updates every environment at once.
 *
 * Write order is an atomic swap: the new APK object is fully uploaded and
 * validated BEFORE the manifest flips, so a failed build/publish can never
 * break the currently served release. Readers treat a missing or malformed
 * manifest as "no release" — an honest 404, never a stale file.
 */
import { createHash, randomUUID } from "node:crypto";
import { objectStorageClient, parseObjectPath } from "./objectStorage";

export const APK_MAX_BYTES = 300 * 1024 * 1024;
const APK_MIN_BYTES = 1024;
const PUBLISHED_PATH_RE = /^\/objects\/uploads\/mobile-apk\/published-[A-Za-z0-9-]{8,64}$/;
const VERSION_RE = /^[\w. +()-]{1,50}$/;

export interface ApkManifest {
  /** `/objects/uploads/mobile-apk/published-<uuid>` — the served object. */
  publishedPath: string;
  /** Original artifact filename (display only; download name is derived). */
  fileName: string;
  /** App version, recorded at build time from employee-app/app.json. */
  version: string;
  size: number;
  sha256: string;
  /** ISO timestamp when this release was published. */
  builtAt: string;
  /** "eas-build" for the pipeline; "local-file" for the internal/test seam. */
  source: string;
  easBuildId?: string;
}

function privateDir(): string {
  const dir = process.env.PRIVATE_OBJECT_DIR || "";
  if (!dir) throw new Error("PRIVATE_OBJECT_DIR not set — object storage is not configured.");
  return dir.replace(/\/+$/, "");
}

function fileFor(fullPath: string) {
  const { bucketName, objectName } = parseObjectPath(fullPath);
  return objectStorageClient.bucket(bucketName).file(objectName);
}

/** Storage object behind an `/objects/uploads/mobile-apk/...` pointer. */
function fileForObjectPath(objectPath: string) {
  // `/objects/<entityId>` → `<privateDir>/<entityId>`
  const entityId = objectPath.replace(/^\/objects\//, "");
  return fileFor(`${privateDir()}/${entityId}`);
}

const manifestObjectFile = () => fileFor(`${privateDir()}/uploads/mobile-apk/current.json`);

/** Every `published-*` object currently under the release prefix. */
async function listPublishedObjects() {
  const { bucketName, objectName } = parseObjectPath(`${privateDir()}/uploads/mobile-apk`);
  const [files] = await objectStorageClient.bucket(bucketName).getFiles({ prefix: `${objectName}/published-` });
  return files;
}

/**
 * Validate that a buffer is structurally an Android APK:
 * ZIP local-header magic, an End-Of-Central-Directory record, and an
 * AndroidManifest.xml ENTRY in a properly parsed central directory. A plain
 * ZIP renamed to .apk, or a file whose content merely mentions the string,
 * both fail here.
 */
export function validateApkBuffer(buf: Buffer): { ok: true } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  const size = buf.length;
  if (size < APK_MIN_BYTES) return bad("The file is too small to be a real APK.");
  if (size > APK_MAX_BYTES) return bad("The file is larger than the 300 MB limit.");
  if (buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04) {
    return bad("The file is not a valid APK — it is not a ZIP-format archive.");
  }
  // EOCD in the trailing 64 KB.
  const tailStart = Math.max(0, size - 66_000);
  let eocd = -1;
  for (let i = size - 22; i >= tailStart; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) return bad("The file is not a valid APK — its archive index is missing or corrupted.");
  const entryCount = buf.readUInt16LE(eocd + 10);
  if (entryCount === 0) return bad("The file is an empty archive — not a valid APK.");
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const badIndex = () => bad("The file is not a valid APK — its archive index is missing or corrupted.");
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff || cdOffset + cdSize > size) return badIndex();
  const cdEnd = cdOffset + Math.min(cdSize, 8 * 1_048_576);
  const MANIFEST = "AndroidManifest.xml";
  let pos = cdOffset;
  for (let entry = 0; entry < entryCount; entry++) {
    if (pos + 46 > cdEnd) break;
    if (buf[pos] !== 0x50 || buf[pos + 1] !== 0x4b || buf[pos + 2] !== 0x01 || buf[pos + 3] !== 0x02) return badIndex();
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    if (pos + 46 + nameLen > cdEnd) break;
    if (buf.toString("latin1", pos + 46, pos + 46 + nameLen) === MANIFEST) return { ok: true };
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return bad("The file does not look like an Android app — AndroidManifest.xml was not found inside it.");
}

/**
 * Current release, or null when none is published (or the manifest is
 * malformed — treated as "no release" rather than served blindly).
 * No caching: these are low-traffic endpoints and the manifest must flip
 * everywhere the moment a release lands.
 */
export async function readApkManifest(): Promise<ApkManifest | null> {
  let raw: string;
  try {
    const [exists] = await manifestObjectFile().exists();
    if (!exists) return null;
    const [buf] = await manifestObjectFile().download();
    raw = buf.toString("utf8");
  } catch (err) {
    console.error("[apkRelease] manifest read failed:", err);
    return null;
  }
  try {
    const m = JSON.parse(raw) as Partial<ApkManifest>;
    if (
      typeof m.publishedPath !== "string" || !PUBLISHED_PATH_RE.test(m.publishedPath) ||
      typeof m.version !== "string" || !VERSION_RE.test(m.version) ||
      typeof m.fileName !== "string" || m.fileName.length === 0 || m.fileName.length > 200 ||
      typeof m.size !== "number" || !Number.isInteger(m.size) || m.size <= 0 || m.size > APK_MAX_BYTES ||
      typeof m.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(m.sha256) ||
      typeof m.builtAt !== "string" || Number.isNaN(Date.parse(m.builtAt)) ||
      typeof m.source !== "string"
    ) {
      console.error("[apkRelease] manifest is malformed — treating as no release");
      return null;
    }
    return m as ApkManifest;
  } catch {
    console.error("[apkRelease] manifest is not valid JSON — treating as no release");
    return null;
  }
}

export interface PublishApkOptions {
  version: string;
  fileName?: string;
  source: string;
  easBuildId?: string;
}

/**
 * Publish a built APK: validate the bytes, upload the object, then flip the
 * manifest. The previously published object is deleted best-effort AFTER the
 * swap so a reader mid-download is never cut off by a failed publish.
 */
export async function publishApkBuffer(buf: Buffer, opts: PublishApkOptions): Promise<ApkManifest> {
  const version = (opts.version || "").trim();
  if (!VERSION_RE.test(version)) {
    throw new Error(`Invalid version "${opts.version}" — letters, numbers, dots, dashes and spaces only (max 50 chars).`);
  }
  const verdict = validateApkBuffer(buf);
  if (!verdict.ok) throw new Error(verdict.error);

  const previous = await readApkManifest();

  const publishedId = `published-${randomUUID()}`;
  const publishedPath = `/objects/uploads/mobile-apk/${publishedId}`;
  const objectFile = fileFor(`${privateDir()}/uploads/mobile-apk/${publishedId}`);
  await objectFile.save(buf, {
    resumable: false,
    metadata: { contentType: "application/vnd.android.package-archive" },
  });

  const manifest: ApkManifest = {
    publishedPath,
    fileName: (opts.fileName || `app-v${version}.apk`).replace(/[^\w. ()+-]+/g, "-").slice(0, 200),
    version,
    size: buf.length,
    sha256: createHash("sha256").update(buf).digest("hex"),
    builtAt: new Date().toISOString(),
    source: opts.source,
    ...(opts.easBuildId ? { easBuildId: opts.easBuildId } : {}),
  };
  // Manifest write LAST = the atomic swap. Everything above can fail without
  // touching the current release.
  await manifestObjectFile().save(JSON.stringify(manifest, null, 2), {
    resumable: false,
    metadata: { contentType: "application/json", cacheControl: "no-store" },
  });

  // Clean-up with a GRACE WINDOW: the object the manifest pointed at until a
  // moment ago is KEPT, so a reader that fetched the old manifest right
  // before the swap can still finish its download instead of hitting a 502.
  // Anything older than that (grace copies from earlier replaces, debris
  // from crashed publishes) is deleted best-effort.
  try {
    const keep = new Set(
      [publishedPath, previous?.publishedPath]
        .filter((p): p is string => !!p)
        .map((p) => p.split("/").pop() as string),
    );
    for (const f of await listPublishedObjects()) {
      const base = f.name.split("/").pop() ?? "";
      if (!keep.has(base)) await f.delete().catch(() => {});
    }
  } catch (err: any) {
    console.warn("[apkRelease] release clean-up sweep failed (harmless):", err?.message ?? err);
  }
  return manifest;
}

/**
 * Remove the current release: manifest first (downloads stop immediately),
 * then EVERY published object — including the grace-window copy a replace
 * left behind. Removal is an explicit operator action; nothing should remain
 * downloadable afterwards.
 */
export async function removeApkRelease(): Promise<{ removed: boolean }> {
  const [manifestExists] = await manifestObjectFile().exists();
  if (manifestExists) await manifestObjectFile().delete();
  try {
    for (const f of await listPublishedObjects()) await f.delete().catch(() => {});
  } catch (err: any) {
    console.warn("[apkRelease] object sweep failed:", err?.message ?? err);
  }
  return { removed: manifestExists };
}
