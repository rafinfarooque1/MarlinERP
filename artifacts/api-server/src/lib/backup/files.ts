/**
 * The file half of a backup: uploaded documents, and the archives themselves.
 *
 * ── What is actually here, versus what the brief lists ──────────────────────
 * The brief asks for uploaded PDFs, invoices, payslips, the company logo,
 * product images and attachments. In this ERP only some of those are stored
 * files at all:
 *
 *   • Expense and payment attachments — real objects in the bucket. Backed up.
 *   • Company logo — a URL on company_settings. If it points into the bucket it
 *     is under the same prefix and is therefore already included.
 *   • Invoices and payslips — NOT stored. Both are rendered on demand from the
 *     data by the server-side PDF renderer. Backing them up as files would
 *     freeze a stale copy of a document that is regenerated correctly from the
 *     restored rows anyway, so restoring the database restores them exactly.
 *   • Product images — items carry no image column, so there is nothing to back
 *     up today. Anything added later lands under the same prefix and is picked
 *     up with no change here, because this enumerates the bucket rather than
 *     walking a hard-coded list of tables.
 *
 * That last property is the reason this module reads the bucket instead of the
 * database: a file backup driven by a list of known columns silently stops
 * covering whatever gets added next.
 */
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";

import { objectStorageClient, parseObjectPath, signObjectPutURL } from "../objectStorage";

/** Archives live beside the uploads but must never be swept into one. */
const BACKUP_PREFIX = "backups/";

export interface UploadObject {
  /** Full object name inside the bucket. */
  objectName: string;
  /** Path relative to the private dir — what gets stored in the archive. */
  relativePath: string;
  bytes: number;
}

function privateDirParts(): { bucketName: string; prefix: string } {
  const dir = process.env.PRIVATE_OBJECT_DIR;
  if (!dir) {
    throw new Error(
      "PRIVATE_OBJECT_DIR is not set — file backup needs an object storage bucket.",
    );
  }
  const { bucketName, objectName } = parseObjectPath(dir);
  return { bucketName, prefix: objectName.endsWith("/") ? objectName : `${objectName}/` };
}

export function objectStorageConfigured(): boolean {
  return Boolean(process.env.PRIVATE_OBJECT_DIR);
}

/**
 * Every uploaded object, excluding the backup archives.
 *
 * The exclusion is not cosmetic: without it each backup would contain every
 * previous backup, so archive number five would hold four copies of the database
 * and the tenth would be unusable.
 */
export async function listUploadObjects(): Promise<UploadObject[]> {
  const { bucketName, prefix } = privateDirParts();
  const [files] = await objectStorageClient.bucket(bucketName).getFiles({ prefix });

  const out: UploadObject[] = [];
  for (const f of files) {
    const relativePath = f.name.slice(prefix.length);
    if (!relativePath || relativePath.endsWith("/")) continue; // directory placeholder
    if (relativePath.startsWith(BACKUP_PREFIX)) continue;
    out.push({
      objectName: f.name,
      relativePath,
      bytes: Number(f.metadata?.size ?? 0),
    });
  }
  return out;
}

/**
 * Download every upload into `<stageDir>/uploads/<relative path>`.
 *
 * Relative paths are preserved rather than flattened because the database stores
 * `/objects/uploads/<uploaderId>/<uuid>` and resolves it against whatever
 * PRIVATE_OBJECT_DIR is current. Keeping the path below the private dir intact is
 * what lets a restore onto a different host — with a different bucket — still
 * resolve every attachment reference already recorded in the rows.
 */
export async function downloadUploads(
  stageDir: string,
  objects: UploadObject[],
): Promise<void> {
  const { bucketName } = privateDirParts();
  const bucket = objectStorageClient.bucket(bucketName);

  for (const obj of objects) {
    const dest = join(stageDir, "uploads", obj.relativePath);
    await mkdir(dirname(dest), { recursive: true });
    await pipeline(bucket.file(obj.objectName).createReadStream(), createWriteStream(dest));
  }
}

/**
 * Push extracted files back into the bucket under the CURRENT private dir.
 *
 * Existing objects are overwritten, which is the intent: a restore is meant to
 * return storage to the state the archive describes.
 */
export async function uploadRestoredFiles(
  files: Array<{ absPath: string; relativePath: string }>,
): Promise<number> {
  const { bucketName, prefix } = privateDirParts();
  const bucket = objectStorageClient.bucket(bucketName);

  let restored = 0;
  for (const f of files) {
    await bucket.upload(f.absPath, { destination: `${prefix}${f.relativePath}` });
    restored++;
  }
  return restored;
}

// ─────────────────────────────────────────────────────────────────────────────
// The archives themselves
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Archives are kept in the bucket, not on local disk.
 *
 * The container's filesystem is ephemeral — a redeploy or a restart can take the
 * whole thing with it, so a backup written there would routinely be gone by the
 * time it was needed. The bucket outlives the database and the code.
 *
 * It does NOT outlive the account, which is why the UI presses the administrator
 * to download archives off-platform: a copy that shares a blast radius with the
 * thing it protects is a convenience copy, not disaster recovery.
 */
export async function putBackupArchive(localPath: string, filename: string): Promise<string> {
  const { bucketName, prefix } = privateDirParts();
  const destination = `${prefix}${BACKUP_PREFIX}${filename}`;
  await objectStorageClient.bucket(bucketName).upload(localPath, {
    destination,
    metadata: { contentType: "application/zip" },
  });
  return destination;
}

export async function fetchBackupArchive(objectName: string, localPath: string): Promise<void> {
  const { bucketName } = privateDirParts();
  await mkdir(dirname(localPath), { recursive: true });
  await pipeline(
    objectStorageClient.bucket(bucketName).file(objectName).createReadStream(),
    createWriteStream(localPath),
  );
}

/** A read stream for the download endpoint, so the archive never buffers in memory. */
export function backupArchiveStream(objectName: string): NodeJS.ReadableStream {
  const { bucketName } = privateDirParts();
  return objectStorageClient.bucket(bucketName).file(objectName).createReadStream();
}

export async function backupArchiveExists(objectName: string): Promise<boolean> {
  const { bucketName } = privateDirParts();
  const [exists] = await objectStorageClient.bucket(bucketName).file(objectName).exists();
  return exists;
}

export async function deleteBackupArchive(objectName: string): Promise<void> {
  const { bucketName } = privateDirParts();
  await objectStorageClient
    .bucket(bucketName)
    .file(objectName)
    .delete({ ignoreNotFound: true });
}

/** Uploads a caller-supplied archive for restore, keyed so two admins cannot collide. */
export async function stageUploadedArchive(localPath: string, filename: string): Promise<string> {
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(-120);
  return putBackupArchive(localPath, `incoming/${Date.now()}_${safe}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Direct-to-bucket upload staging
//
// The published app runs behind a front-end that rejects any request body over
// 32 MB with its own bare 413 before the app sees a byte — the same limit that
// broke large downloads, on the request side. A real backup archive is
// routinely bigger than that, so the browser PUTs the bytes straight to the
// bucket with a presigned URL and the server then pulls, inspects and
// catalogues the object. The client only ever holds an opaque uuid; the object
// name is reconstructed server-side, so no request can name a bucket path.
//
// Staging lives under BACKUP_PREFIX so listUploadObjects() never sweeps a
// half-finished upload into a file backup.
// ─────────────────────────────────────────────────────────────────────────────

const UPLOAD_STAGING_PREFIX = `${BACKUP_PREFIX}staging/`;

export function stagedUploadObjectName(key: string): string {
  const { prefix } = privateDirParts();
  return `${prefix}${UPLOAD_STAGING_PREFIX}${key}`;
}

/** One hour: signature validity gates the START of the PUT, and a large archive
 *  on a slow link needs headroom to begin retries. */
export async function signStagedUploadURL(key: string): Promise<string> {
  const { bucketName } = privateDirParts();
  return signObjectPutURL(bucketName, stagedUploadObjectName(key), 3600);
}

export async function stagedUploadSize(objectName: string): Promise<number | null> {
  const { bucketName } = privateDirParts();
  const file = objectStorageClient.bucket(bucketName).file(objectName);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [metadata] = await file.getMetadata();
  return Number(metadata?.size ?? 0);
}

/**
 * Abandoned uploads (PUT succeeded, finalize never called) would otherwise sit
 * in the bucket forever at archive sizes. Swept opportunistically on each
 * finalize; anything older than a day cannot still be an in-flight upload.
 */
export async function sweepStaleStagedUploads(): Promise<void> {
  const { bucketName, prefix } = privateDirParts();
  const [files] = await objectStorageClient
    .bucket(bucketName)
    .getFiles({ prefix: `${prefix}${UPLOAD_STAGING_PREFIX}` });
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const f of files) {
    const created = new Date(String(f.metadata?.timeCreated ?? "")).getTime();
    if (Number.isFinite(created) && created < cutoff) {
      await f.delete({ ignoreNotFound: true }).catch(() => {});
    }
  }
}
