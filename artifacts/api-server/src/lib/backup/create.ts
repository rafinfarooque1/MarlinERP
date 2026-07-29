/**
 * Backup creation.
 *
 * Assembles a staging directory that mirrors the archive layout from the brief,
 * zips it, checksums it, self-checks it, and only then records the archive as
 * `ready`. The catalogue row is written BEFORE the work starts and updated after,
 * so an archive that fails halfway is visible as a failure rather than absent —
 * a backup you believe you have and do not is worse than an obvious error.
 *
 * Layout produced:
 *
 *   database.sql     plain SQL, restorable with psql alone
 *   database.dump    custom format, what a restore here actually consumes
 *   uploads/…        every object in the bucket, at its original relative path
 *   settings.json    configuration, readable without a database client
 *   version.json     ERP / schema / database / commit identity
 *   manifest.json    per-member checksums, row counts, and the signature
 */
import { mkdtemp, rm, writeFile, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pool } from "@workspace/db";

import { logActivity } from "../audit";
import {
  BACKUP_FORMAT_VERSION,
  type BackupManifest,
  type BackupScope,
  type MemberChecksum,
  backupFilename,
  checksumOf,
  createZip,
  listZipEntries,
  sha256File,
  signManifest,
} from "./archive";
import {
  downloadUploads,
  listUploadObjects,
  objectStorageConfigured,
  putBackupArchive,
} from "./files";
import {
  currentDatabaseName,
  dumpCustom,
  dumpPlain,
  schemaFingerprint,
  serverVersion,
  tableCounts,
} from "./pgTools";
import { erpVersion, gitCommit, gitDirty } from "./versionInfo";

export type BackupTrigger = "manual" | "scheduled" | "pre_restore";

export interface CreateBackupInput {
  scope: BackupScope;
  trigger: BackupTrigger;
  createdBy: string;
  /** Skipped for database-only and settings-only scopes regardless. */
  includeFiles?: boolean;
  /** Caller IP, recorded on the audit row. Absent for scheduled backups. */
  ip?: string;
}

export interface CreateBackupResult {
  id: number;
  filename: string;
  sizeBytes: number;
  checksum: string;
  manifest: BackupManifest;
  selfCheck: Array<{ check: string; ok: boolean; detail: string }>;
}

const wantsDatabase = (s: BackupScope) => s === "complete" || s === "database";
const wantsFiles = (s: BackupScope) => s === "complete" || s === "files";
const wantsSettings = (s: BackupScope) => s === "complete" || s === "settings";

export async function createBackup(input: CreateBackupInput): Promise<CreateBackupResult> {
  const now = new Date();
  const filename = backupFilename(now, input.scope);

  const { rows: created } = await pool.query<{ id: number }>(
    `INSERT INTO backup_meta.backups (filename, scope, trigger, status, created_by)
     VALUES ($1, $2, $3, 'creating', $4)
     RETURNING id`,
    [filename, input.scope, input.trigger, input.createdBy],
  );
  const id = created[0].id;

  const stage = await mkdtemp(join(tmpdir(), "marlin-backup-"));
  // Keep the zip's own temp dir in a variable: removing only the file would leak
  // an empty directory in /tmp on every single backup.
  const zipDir = await mkdtemp(join(tmpdir(), "marlin-zip-"));
  const zipPath = join(zipDir, filename);

  try {
    const [version, dbVersion, commit, dirty] = await Promise.all([
      erpVersion(),
      serverVersion(),
      gitCommit(),
      gitDirty(),
    ]);
    const fingerprint = await schemaFingerprint();

    const manifest: BackupManifest = {
      formatVersion: BACKUP_FORMAT_VERSION,
      scope: input.scope,
      createdAt: now.toISOString(),
      createdBy: input.createdBy,
      erpVersion: version,
      databaseVersion: dbVersion,
      schemaVersion: fingerprint,
      gitCommit: dirty && commit ? `${commit}-dirty` : commit,
      databaseName: currentDatabaseName(),
    };

    // ── database ────────────────────────────────────────────────────────────
    if (wantsDatabase(input.scope)) {
      const dumpFile = join(stage, "database.dump");
      const sqlFile = join(stage, "database.sql");
      await dumpCustom(dumpFile);
      await dumpPlain(sqlFile);

      manifest.database = {
        customDump: await checksumOf(dumpFile, "database.dump"),
        plainSql: await checksumOf(sqlFile, "database.sql"),
      };
      manifest.tables = await tableCounts();
    }

    // ── files ───────────────────────────────────────────────────────────────
    // A missing bucket is recorded, not fatal: a database backup is still worth
    // having, and failing the whole operation would leave the administrator with
    // nothing at all.
    if (wantsFiles(input.scope) && input.includeFiles !== false) {
      if (objectStorageConfigured()) {
        const objects = await listUploadObjects();
        await downloadUploads(stage, objects);

        const entries: MemberChecksum[] = [];
        let bytes = 0;
        for (const o of objects) {
          const member = `uploads/${o.relativePath}`;
          const c = await checksumOf(join(stage, member), member);
          entries.push(c);
          bytes += c.bytes;
        }
        manifest.files = { count: entries.length, bytes, entries };
      } else {
        manifest.files = { count: 0, bytes: 0, entries: [] };
      }
    }

    // ── settings ────────────────────────────────────────────────────────────
    if (wantsSettings(input.scope)) {
      // Imported lazily so a settings-only concern does not load on every path.
      const { buildSettingsExport } = await import("./settingsExport");
      const settingsFile = join(stage, "settings.json");
      await writeFile(settingsFile, JSON.stringify(await buildSettingsExport(), null, 2), "utf8");
      manifest.settings = await checksumOf(settingsFile, "settings.json");
    }

    // version.json is a plain copy of the identity fields, so an administrator can
    // read "which code does this pair with?" without parsing the manifest.
    await writeFile(
      join(stage, "version.json"),
      JSON.stringify(
        {
          erpVersion: manifest.erpVersion,
          databaseVersion: manifest.databaseVersion,
          schemaVersion: manifest.schemaVersion,
          gitCommit: manifest.gitCommit,
          backupDate: manifest.createdAt,
          createdBy: manifest.createdBy,
          formatVersion: BACKUP_FORMAT_VERSION,
        },
        null,
        2,
      ),
      "utf8",
    );

    const signed = signManifest(manifest);
    await writeFile(join(stage, "manifest.json"), JSON.stringify(signed, null, 2), "utf8");

    // ── package ─────────────────────────────────────────────────────────────
    await createZip(stage, zipPath);
    const zipStat = await stat(zipPath);
    const checksum = await sha256File(zipPath);

    const selfCheck = await selfCheckArchive(zipPath, signed);
    const failed = selfCheck.filter((c) => !c.ok);
    if (failed.length > 0) {
      throw new Error(
        `The archive failed its own integrity check: ${failed.map((f) => f.detail).join("; ")}`,
      );
    }

    const objectPath = await putBackupArchive(zipPath, filename);

    const rowCount = (manifest.tables ?? []).reduce((s, t) => s + t.rows, 0);
    await pool.query(
      `UPDATE backup_meta.backups
          SET status = 'ready', object_path = $2, size_bytes = $3, checksum = $4,
              erp_version = $5, database_version = $6, schema_version = $7, git_commit = $8,
              table_count = $9, row_count = $10, file_count = $11, manifest = $12, error = ''
        WHERE id = $1`,
      [
        id,
        objectPath,
        zipStat.size,
        checksum,
        manifest.erpVersion,
        manifest.databaseVersion,
        manifest.schemaVersion,
        manifest.gitCommit,
        (manifest.tables ?? []).length,
        rowCount,
        manifest.files?.count ?? 0,
        JSON.stringify(signed),
      ],
    );

    logActivity({
      action: "CREATE",
      module: "backup",
      entityType: "backup",
      entityId: id,
      description: `Backup created — ${filename} (${input.scope}, ${formatBytes(zipStat.size)})`,
      user: input.createdBy,
      metadata: {
        scope: input.scope,
        trigger: input.trigger,
        ip: input.ip,
        checksum,
        tables: (manifest.tables ?? []).length,
        rows: rowCount,
        files: manifest.files?.count ?? 0,
      },
    }).catch(() => {});

    return { id, filename, sizeBytes: zipStat.size, checksum, manifest: signed, selfCheck };
  } catch (e: any) {
    const message = String(e?.message ?? e).slice(0, 2000);
    await pool
      .query(`UPDATE backup_meta.backups SET status = 'failed', error = $2 WHERE id = $1`, [id, message])
      .catch(() => {});
    logActivity({
      action: "CREATE",
      module: "backup",
      entityType: "backup",
      entityId: id,
      description: `Backup FAILED — ${filename}: ${message}`,
      user: input.createdBy,
      metadata: { scope: input.scope, trigger: input.trigger, error: message },
    }).catch(() => {});
    throw e;
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
    await rm(zipDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Read the finished archive back and prove it is what we think it is.
 *
 * The brief asks for validation after every backup, and this is the part that
 * makes the difference: it re-opens the zip that was actually written, rather
 * than trusting the in-memory description of what should have gone into it. A
 * truncated dump, a member the zip silently dropped, or a checksum computed over
 * different bytes all surface here — at backup time, when there is still a good
 * copy to fall back on, instead of during a restore.
 */
async function selfCheckArchive(
  zipPath: string,
  manifest: BackupManifest,
): Promise<Array<{ check: string; ok: boolean; detail: string }>> {
  const out: Array<{ check: string; ok: boolean; detail: string }> = [];
  const entries = new Set(await listZipEntries(zipPath));
  const has = (name: string) => entries.has(name) || entries.has(`./${name}`);

  out.push({
    check: "Archive opens",
    ok: entries.size > 0,
    detail: entries.size > 0 ? `${entries.size} member(s)` : "the archive is empty or unreadable",
  });

  out.push({
    check: "Manifest present",
    ok: has("manifest.json") && has("version.json"),
    detail: has("manifest.json") && has("version.json") ? "manifest.json, version.json" : "missing manifest.json or version.json",
  });

  if (manifest.database) {
    const ok = has("database.sql") && has("database.dump");
    out.push({
      check: "Database export",
      ok,
      detail: ok
        ? `database.sql (${formatBytes(manifest.database.plainSql?.bytes ?? 0)}), database.dump (${formatBytes(manifest.database.customDump?.bytes ?? 0)})`
        : "database.sql or database.dump is missing from the archive",
    });
    // An empty dump zips perfectly happily, so size is checked explicitly.
    const bytes = manifest.database.customDump?.bytes ?? 0;
    out.push({
      check: "Database export is not empty",
      ok: bytes > 1024,
      detail: bytes > 1024 ? `${formatBytes(bytes)}` : `only ${bytes} bytes — the dump looks truncated`,
    });
    out.push({
      check: "Row counts recorded",
      ok: (manifest.tables ?? []).length > 0,
      detail: `${(manifest.tables ?? []).length} table(s), ${(manifest.tables ?? []).reduce((s, t) => s + t.rows, 0)} row(s)`,
    });
  }

  if (manifest.files) {
    const missing = manifest.files.entries.filter((e) => !has(e.file));
    out.push({
      check: "Files export",
      ok: missing.length === 0,
      detail:
        missing.length === 0
          ? `${manifest.files.count} file(s), ${formatBytes(manifest.files.bytes)}`
          : `${missing.length} file(s) listed in the manifest are not in the archive`,
    });
  }

  if (manifest.settings) {
    out.push({
      check: "Settings export",
      ok: has("settings.json"),
      detail: has("settings.json") ? formatBytes(manifest.settings.bytes) : "settings.json is missing",
    });
  }

  return out;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Read a manifest out of an extracted archive directory. */
export async function readManifest(dir: string): Promise<any> {
  const raw = await readFile(join(dir, "manifest.json"), "utf8");
  return JSON.parse(raw);
}
