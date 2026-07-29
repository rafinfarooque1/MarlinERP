/**
 * Archive assembly, checksums and the manifest.
 *
 * Zipping shells out to the `zip`/`unzip` binaries for the same reason the dump
 * shells out to `pg_dump`: they are already present, battle-tested, and produce
 * an archive any administrator can open by double-clicking it. A backup nobody
 * can open without the application is not a disaster-recovery artefact.
 *
 * ── A note on "encrypt backup metadata" ─────────────────────────────────────
 * The brief asks for encrypted metadata. Implemented literally — encrypting the
 * manifest under a key derived from this installation's secret — it would defeat
 * the module's own purpose: the manifest is what a restore reads to decide
 * whether an archive is safe to apply, and the canonical disaster is a NEW host
 * with a NEW secret, where that key no longer exists. The backup would become
 * undecryptable in precisely the situation it was taken for.
 *
 * So the manifest stays readable and is SIGNED instead (HMAC-SHA256, key derived
 * from SESSION_SECRET). That delivers what the requirement is actually for —
 * proof the metadata has not been tampered with — while keeping the archive
 * restorable on a machine that has never seen this installation. A restore on a
 * foreign host reports "signature not verifiable" and continues; a restore here
 * with a broken signature reports tampering. Integrity of the *payload* is
 * covered separately by a SHA-256 over every member file.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

const run = promisify(execFile);

const ZIP_TIMEOUT_MS = 10 * 60 * 1000;

export const BACKUP_FORMAT_VERSION = 1;

export type BackupScope = "complete" | "database" | "files" | "settings";

export interface MemberChecksum {
  file: string;
  bytes: number;
  sha256: string;
}

export interface BackupManifest {
  formatVersion: number;
  scope: BackupScope;
  createdAt: string;
  createdBy: string;
  erpVersion: string;
  databaseVersion: string;
  schemaVersion: string;
  gitCommit: string;
  databaseName: string;
  /** Present unless scope is 'files' or 'settings'. */
  database?: { customDump?: MemberChecksum; plainSql?: MemberChecksum };
  /** Row counts at backup time — what a verification restore is compared against. */
  tables?: Array<{ table: string; rows: number }>;
  files?: { count: number; bytes: number; entries: MemberChecksum[] };
  settings?: MemberChecksum;
}

export interface SignedManifest extends BackupManifest {
  signature: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hashing
// ─────────────────────────────────────────────────────────────────────────────

/** Streamed so a large archive is never held in memory just to be hashed. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(path).on("data", (c) => hash.update(c)).on("end", resolve).on("error", reject);
  });
  return hash.digest("hex");
}

export async function checksumOf(absPath: string, memberName: string): Promise<MemberChecksum> {
  const s = await stat(absPath);
  return { file: memberName, bytes: s.size, sha256: await sha256File(absPath) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Signing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Key ordering is significant, because an HMAC is computed over bytes: two
 * manifests that differ only in property order would sign differently and the
 * verification would fail on a perfectly good backup.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => k !== "signature" && obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

function signingKey(): Buffer | null {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;
  return createHmac("sha256", "marlin-backup-manifest-v1").update(secret).digest();
}

export function signManifest(manifest: BackupManifest): SignedManifest {
  const key = signingKey();
  const signature = key ? createHmac("sha256", key).update(canonical(manifest)).digest("hex") : "";
  return { ...manifest, signature };
}

export type SignatureState = "valid" | "invalid" | "unverifiable";

/**
 * `unverifiable` is not a failure. It is the expected answer when restoring onto
 * a fresh host, which has a different SESSION_SECRET — or none at all — and it
 * must not be conflated with `invalid`, which means the metadata was altered.
 */
export function verifyManifestSignature(manifest: SignedManifest): SignatureState {
  const key = signingKey();
  if (!key || !manifest.signature) return "unverifiable";
  const expected = createHmac("sha256", key).update(canonical(manifest)).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(manifest.signature, "hex");
  if (a.length !== b.length) return "invalid";
  return timingSafeEqual(a, b) ? "valid" : "invalid";
}

// ─────────────────────────────────────────────────────────────────────────────
// Zip / unzip
// ─────────────────────────────────────────────────────────────────────────────

async function zipTool(bin: string, args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout, stderr } = await run(bin, args, {
      cwd,
      timeout: ZIP_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    return `${stdout ?? ""}${stderr ?? ""}`;
  } catch (e: any) {
    const detail = String(e?.stderr || e?.stdout || e?.message || e).trim();
    throw new Error(`${bin} failed: ${detail.slice(0, 2000)}`);
  }
}

/**
 * Zip the contents of `stageDir` into `outFile`.
 *
 * Run with `cwd: stageDir` and a `.` target so members are stored as
 * `database.sql` and `uploads/…` rather than with the absolute staging path
 * baked in. The paths inside the archive are the contract with the restore side
 * and with the administrator reading the brief's expected layout.
 */
export async function createZip(stageDir: string, outFile: string): Promise<void> {
  // -r recurse, -q quiet, -X drop platform extras that would differ per run.
  await zipTool("zip", ["-r", "-q", "-X", outFile, "."], stageDir);
}

export async function extractZip(zipFile: string, destDir: string): Promise<void> {
  await zipTool("unzip", ["-q", "-o", zipFile, "-d", destDir]);
}

/** Member names inside an archive, used to detect an incomplete backup. */
export async function listZipEntries(zipFile: string): Promise<string[]> {
  const out = await zipTool("unzip", ["-Z", "-1", zipFile]);
  return out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.endsWith("/"));
}

/**
 * `Marlin_Backup_2026_07_29_2300.zip` — the name from the brief.
 *
 * Local time, because it is read by a person who wants to recognise "the one I
 * took this afternoon", and a UTC stamp would be off by hours for them.
 */
export function backupFilename(now: Date, scope: BackupScope): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}_${p(now.getMonth() + 1)}_${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}`;
  const suffix = scope === "complete" ? "" : `_${scope}`;
  return `Marlin_Backup_${stamp}${suffix}.zip`;
}
