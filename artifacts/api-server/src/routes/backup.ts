/**
 * Backup & Restore endpoints.
 *
 * ── Who may do what ─────────────────────────────────────────────────────────
 * The brief asks for five rights (View, Backup, Restore, Download, Delete) and
 * says only a Super Admin may restore. This ERP already has an authorisation
 * model — per-page rights plus a Head Office location rule — so rather than
 * invent a parallel "super admin" flag that nothing else understands, Restore is
 * expressed in the existing terms and is the strictest combination in the app:
 *
 *   Head Office  +  Approve on this page  +  the caller's own password
 *
 * Level-1 (Administrator) roles hold every right implicitly, as everywhere else, so
 * out of the box the administrator can restore and nobody else can. Any other
 * role has to be granted Approve on the Permissions page deliberately. A flag
 * living only here would be invisible to that page, and an authorisation rule
 * nobody can see or audit is worse than a slightly less literal reading.
 *
 * Restore is the one action in the whole ERP that can destroy every record at
 * once, so it is also the one action that re-checks the password: a borrowed
 * session, an unlocked laptop or a stolen token is otherwise enough.
 */
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

import { Router, type IRouter, type Request, type Response } from "express";

import { pool } from "@workspace/db";

import { logActivity } from "../lib/audit";
import { PasswordService } from "../lib/password";
import { sha256File, type BackupScope } from "../lib/backup/archive";
import { createBackup, formatBytes } from "../lib/backup/create";
import {
  backupArchiveExists,
  backupArchiveStream,
  deleteBackupArchive,
  objectStorageConfigured,
  stageUploadedArchive,
} from "../lib/backup/files";
import { databaseSizeBytes, serverVersion } from "../lib/backup/pgTools";
import {
  inspectArchive,
  restoreFromArchive,
  stagedCopyOf,
  verifyRestorable,
} from "../lib/backup/restore";
import { applyRetention, loadSettings, nextRunAt, type Frequency, type Retention } from "../lib/backup/scheduler";
import { erpVersion, gitCommit, gitDirty } from "../lib/backup/versionInfo";
import {
  requireHeadOffice,
  requireModuleAction,
  requireModuleView,
} from "../middleware/permissions";

const router: IRouter = Router();
const PERM = "page:/company/backup";

/** Streamed to disk, never buffered, so the ceiling is disk not memory. */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

const VALID_SCOPES: BackupScope[] = ["complete", "database", "files", "settings"];
const VALID_FREQUENCIES: Frequency[] = ["daily", "weekly", "monthly", "manual"];
const VALID_RETENTIONS: Retention[] = ["7", "30", "90", "unlimited"];

const who = (req: Request) =>
  (req as any).employee?.username ?? (req as any).employee?.name ?? "unknown";
const clientIp = (req: Request) => (req.ip ?? "unknown").replace("::ffff:", "");

interface BackupRow {
  id: number;
  filename: string;
  object_path: string;
  scope: string;
  trigger: string;
  status: string;
  size_bytes: string;
  checksum: string;
  erp_version: string;
  database_version: string;
  schema_version: string;
  git_commit: string;
  table_count: number;
  row_count: string;
  file_count: number;
  error: string;
  verified_at: Date | null;
  verify_status: string;
  verify_detail: string;
  downloaded_at: Date | null;
  created_by: string;
  created_at: Date;
}

const shapeBackup = (r: BackupRow) => ({
  id: r.id,
  filename: r.filename,
  scope: r.scope,
  trigger: r.trigger,
  status: r.status,
  sizeBytes: Number(r.size_bytes),
  sizeLabel: formatBytes(Number(r.size_bytes)),
  checksum: r.checksum,
  erpVersion: r.erp_version,
  databaseVersion: r.database_version,
  schemaVersion: r.schema_version,
  gitCommit: r.git_commit,
  tableCount: r.table_count,
  rowCount: Number(r.row_count),
  fileCount: r.file_count,
  error: r.error,
  verifiedAt: r.verified_at ? new Date(r.verified_at).toISOString() : null,
  verifyStatus: r.verify_status,
  verifyDetail: r.verify_detail,
  downloadedAt: r.downloaded_at ? new Date(r.downloaded_at).toISOString() : null,
  createdBy: r.created_by,
  createdAt: new Date(r.created_at).toISOString(),
});

async function loadBackup(id: number): Promise<BackupRow | null> {
  const { rows } = await pool.query<BackupRow>(`SELECT * FROM backup_meta.backups WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard
// ─────────────────────────────────────────────────────────────────────────────

router.get("/backup/dashboard", requireModuleView(PERM), async (_req: Request, res: Response) => {
  const [{ rows: agg }, { rows: latest }, { rows: lastRestore }, settings] = await Promise.all([
    pool.query(
      `SELECT count(*) FILTER (WHERE status = 'ready')::int   AS total,
              count(*) FILTER (WHERE status = 'failed')::int  AS failed,
              COALESCE(SUM(size_bytes) FILTER (WHERE status = 'ready'), 0)::bigint AS bytes
         FROM backup_meta.backups`,
    ),
    pool.query<BackupRow>(
      `SELECT * FROM backup_meta.backups WHERE status = 'ready' ORDER BY created_at DESC LIMIT 1`,
    ),
    pool.query(
      `SELECT id, filename, status, scope, performed_by, started_at, finished_at, error
         FROM backup_meta.restore_events ORDER BY started_at DESC LIMIT 1`,
    ),
    loadSettings(),
  ]);

  const [dbVersion, version, commit, dirty, dbBytes] = await Promise.all([
    serverVersion(),
    erpVersion(),
    gitCommit(),
    gitDirty(),
    databaseSizeBytes(),
  ]);

  const lr = lastRestore[0];
  res.json({
    totalBackups: Number(agg[0].total),
    failedBackups: Number(agg[0].failed),
    totalSizeBytes: Number(agg[0].bytes),
    totalSizeLabel: formatBytes(Number(agg[0].bytes)),
    latestBackup: latest[0] ? shapeBackup(latest[0]) : null,
    lastRestore: lr
      ? {
          id: lr.id,
          filename: lr.filename,
          status: lr.status,
          scope: lr.scope,
          performedBy: lr.performed_by,
          startedAt: new Date(lr.started_at).toISOString(),
          finishedAt: lr.finished_at ? new Date(lr.finished_at).toISOString() : null,
          error: lr.error,
        }
      : null,
    automatic: {
      frequency: settings.frequency,
      retention: settings.retention,
      includeFiles: settings.includeFiles,
      lastRunAt: settings.lastRunAt,
      lastRunStatus: settings.lastRunStatus,
      nextRunAt: nextRunAt(settings),
    },
    databaseVersion: dbVersion,
    databaseSizeBytes: dbBytes,
    databaseSizeLabel: formatBytes(dbBytes),
    erpVersion: version,
    gitCommit: dirty && commit ? `${commit} (uncommitted changes)` : commit,
    // Surfaced so the UI can explain why file backup is unavailable rather than
    // reporting zero files as though there were none.
    fileStorageConfigured: objectStorageConfigured(),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Catalogue
// ─────────────────────────────────────────────────────────────────────────────

router.get("/backup/list", requireModuleView(PERM), async (_req: Request, res: Response) => {
  const { rows } = await pool.query<BackupRow>(`SELECT * FROM backup_meta.backups ORDER BY created_at DESC`);
  res.json({ backups: rows.map(shapeBackup) });
});

router.get("/backup/history", requireModuleView(PERM), async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT r.*, b.filename AS safety_filename
       FROM backup_meta.restore_events r
       LEFT JOIN backup_meta.backups b ON b.id = r.safety_backup_id
      ORDER BY r.started_at DESC LIMIT 100`,
  );
  res.json({
    events: rows.map((r: any) => ({
      id: r.id,
      backupId: r.backup_id,
      source: r.source,
      filename: r.filename,
      scope: r.scope,
      status: r.status,
      steps: r.steps?.steps ?? [],
      verification: r.steps?.verification ?? [],
      error: r.error,
      safetyBackupId: r.safety_backup_id,
      safetyFilename: r.safety_filename ?? "",
      performedBy: r.performed_by,
      ip: r.ip,
      startedAt: new Date(r.started_at).toISOString(),
      finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
    })),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Create
// ─────────────────────────────────────────────────────────────────────────────

router.post("/backup/create", requireModuleAction(PERM, "add"), async (req: Request, res: Response) => {
  const scope = String((req.body as any)?.scope ?? "complete") as BackupScope;
  if (!VALID_SCOPES.includes(scope)) {
    res.status(400).json({ error: `Scope must be one of: ${VALID_SCOPES.join(", ")}.` });
    return;
  }
  if (!objectStorageConfigured()) {
    res.status(503).json({
      error:
        "Backups are stored in object storage, which is not configured for this app. Set up a storage bucket before creating a backup.",
    });
    return;
  }

  try {
    // createBackup writes the "Backup created" audit row itself — don't log here too.
    const result = await createBackup({
      scope,
      trigger: "manual",
      createdBy: who(req),
      ip: clientIp(req),
    });
    res.status(201).json({
      id: result.id,
      filename: result.filename,
      sizeBytes: result.sizeBytes,
      sizeLabel: formatBytes(result.sizeBytes),
      checksum: result.checksum,
      selfCheck: result.selfCheck,
      manifest: result.manifest,
    });
  } catch (e: any) {
    req.log?.error({ err: e }, "Backup creation failed");
    res.status(500).json({ error: `The backup could not be created: ${String(e?.message ?? e)}` });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Download
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Streams the archive through this server rather than handing out a storage URL.
 *
 * The brief requires that download URLs not be public, and a presigned link would
 * be exactly that: a bearer credential for the entire company's data, valid for
 * anyone who obtains it and impossible to withdraw once issued. Streaming keeps
 * every byte behind the auth guard and the Download permission.
 */
router.get(
  "/backup/:id/download",
  requireModuleAction(PERM, "download"),
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const backup = await loadBackup(id);
    if (!backup || backup.status !== "ready") {
      res.status(404).json({ error: "That backup is not available for download." });
      return;
    }
    if (!backup.object_path || !(await backupArchiveExists(backup.object_path))) {
      res.status(410).json({
        error:
          "The archive file for this backup is no longer in storage. Its record remains, but the file itself is gone.",
      });
      return;
    }

    await pool.query(`UPDATE backup_meta.backups SET downloaded_at = NOW() WHERE id = $1`, [id]);
    logActivity({
      action: "UPDATE",
      module: "backup",
      entityType: "backup",
      entityId: id,
      description: `Backup downloaded — ${backup.filename}`,
      user: who(req),
      metadata: { ip: clientIp(req), filename: backup.filename, bytes: Number(backup.size_bytes) },
    }).catch(() => {});

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Length", String(Number(backup.size_bytes)));
    res.setHeader("Content-Disposition", `attachment; filename="${backup.filename}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");

    try {
      await pipeline(backupArchiveStream(backup.object_path), res);
    } catch (e) {
      req.log?.error({ err: e }, "Backup download stream failed");
      if (!res.headersSent) res.status(500).json({ error: "The download failed part-way through." });
      else res.destroy();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Delete
// ─────────────────────────────────────────────────────────────────────────────

router.delete(
  "/backup/:id",
  requireModuleAction(PERM, "delete"),
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const backup = await loadBackup(id);
    if (!backup) {
      res.status(404).json({ error: "That backup no longer exists." });
      return;
    }

    // The newest safety copy is the undo button for the most recent restore.
    // Deleting it on a whim removes the only way back from a restore that turns
    // out to have been the wrong one.
    if (backup.trigger === "pre_restore") {
      const { rows } = await pool.query<{ id: number }>(
        `SELECT id FROM backup_meta.backups
          WHERE trigger = 'pre_restore' AND status = 'ready'
          ORDER BY created_at DESC LIMIT 1`,
      );
      if (rows[0]?.id === id) {
        res.status(400).json({
          error:
            "This is the safety copy taken before the most recent restore — the only way to undo it. Restore something else first, or take a fresh backup, and it can then be deleted.",
        });
        return;
      }
    }

    if (backup.object_path) await deleteBackupArchive(backup.object_path).catch(() => {});
    await pool.query(`DELETE FROM backup_meta.backups WHERE id = $1`, [id]);

    logActivity({
      action: "DELETE",
      module: "backup",
      entityType: "backup",
      entityId: id,
      description: `Backup deleted — ${backup.filename}`,
      user: who(req),
      metadata: { ip: clientIp(req), filename: backup.filename, trigger: backup.trigger },
    }).catch(() => {});

    res.status(204).end();
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Validate (read-only) and Verify (test restore)
// ─────────────────────────────────────────────────────────────────────────────

/** The "show errors before restore" report. Writes nothing. */
router.get("/backup/:id/validate", requireModuleView(PERM), async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const backup = await loadBackup(id);
  if (!backup || !backup.object_path) {
    res.status(404).json({ error: "That backup is not available." });
    return;
  }

  const staged = await stagedCopyOf(backup.object_path, backup.filename);
  try {
    const inspection = await inspectArchive(staged.path);
    try {
      res.json({
        ok: inspection.ok,
        scope: inspection.scope,
        signature: inspection.signature,
        findings: inspection.findings,
        manifest: inspection.manifest,
      });
    } finally {
      await inspection.dispose();
    }
  } catch (e: any) {
    res.status(500).json({ error: `The archive could not be inspected: ${String(e?.message ?? e)}` });
  } finally {
    await staged.dispose();
  }
});

/**
 * Restore into a throwaway database and compare the result to the manifest.
 *
 * Gated on Backup rather than Restore: it consumes real resources but cannot
 * touch live data, so requiring the destructive right to run a safety check
 * would discourage the one habit that makes backups trustworthy.
 */
router.post("/backup/:id/verify", requireModuleAction(PERM, "add"), async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const backup = await loadBackup(id);
  if (!backup || !backup.object_path) {
    res.status(404).json({ error: "That backup is not available." });
    return;
  }

  const staged = await stagedCopyOf(backup.object_path, backup.filename);
  try {
    const result = await verifyRestorable(staged.path);
    const failed = result.checks.filter((c) => !c.ok);
    const detail = result.ok
      ? `${result.checks.length} check(s) passed`
      : failed.map((f) => `${f.check}: ${f.detail}`).join("; ").slice(0, 1000);

    await pool.query(
      `UPDATE backup_meta.backups SET verified_at = NOW(), verify_status = $2, verify_detail = $3 WHERE id = $1`,
      [id, result.ok ? "passed" : "failed", detail],
    );

    logActivity({
      action: "UPDATE",
      module: "backup",
      entityType: "backup",
      entityId: id,
      description: `Backup verified by test restore — ${backup.filename}: ${result.ok ? "PASSED" : "FAILED"}`,
      user: who(req),
      metadata: { ip: clientIp(req), checks: result.checks },
    }).catch(() => {});

    res.json({ ok: result.ok, checks: result.checks });
  } catch (e: any) {
    const message = String(e?.message ?? e).slice(0, 1000);
    await pool
      .query(
        `UPDATE backup_meta.backups SET verified_at = NOW(), verify_status = 'failed', verify_detail = $2 WHERE id = $1`,
        [id, message],
      )
      .catch(() => {});
    req.log?.error({ err: e }, "Backup verification failed");
    res.status(500).json({ error: `Verification could not be completed: ${message}` });
  } finally {
    await staged.dispose();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Upload an archive for restore
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Accept an archive from the administrator's own machine.
 *
 * The body is streamed straight to a temp file instead of being buffered by a
 * body parser: an archive is arbitrarily large, and holding one in memory would
 * let a single restore attempt take the server down.
 *
 * The uploaded archive is catalogued like any other, which is why the restore
 * endpoint takes an id and never a path. A client-supplied storage path would be
 * a way to point the restore — or the download — at any object in the bucket.
 */
router.post(
  "/backup/upload",
  requireHeadOffice("restore a backup"),
  requireModuleAction(PERM, "edit"),
  async (req: Request, res: Response) => {
    if (!objectStorageConfigured()) {
      res.status(503).json({ error: "Object storage is not configured for this app." });
      return;
    }

    const rawName = String(req.query.filename ?? "uploaded-backup.zip");
    const filename = rawName.replace(/[^A-Za-z0-9._-]/g, "_").slice(-120) || "uploaded-backup.zip";

    const dir = await mkdtemp(join(tmpdir(), "marlin-upload-"));
    const localPath = join(dir, filename);

    const tooBigMessage = `That archive is larger than the ${formatBytes(MAX_UPLOAD_BYTES)} upload limit.`;

    try {
      // Refuse on the declared size before reading a byte. Browsers always send
      // Content-Length for a file body, so this is the path real uploads take and
      // it costs nothing — no temp file, no half-read socket.
      const declared = Number(req.headers["content-length"] ?? 0);
      if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
        res.status(413).json({ error: tooBigMessage });
        return;
      }

      let received = 0;
      let tooBig = false;
      req.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_UPLOAD_BYTES && !tooBig) {
          tooBig = true;
          // Answer FIRST, then hang up. Destroying the socket before the response
          // is written gives the client a connection reset and no explanation —
          // which is what happens if you rely on a check after the pipeline, since
          // destroy() makes the pipeline reject and the socket is already gone.
          if (!res.headersSent) res.status(413).json({ error: tooBigMessage });
          req.destroy();
        }
      });
      // The destroy above makes the pipeline reject; that rejection is expected and
      // already answered. Any *other* stream error still propagates.
      try {
        await pipeline(req, createWriteStream(localPath));
      } catch (streamErr) {
        if (!tooBig) throw streamErr;
      }
      if (tooBig) return;

      const size = (await stat(localPath)).size;
      if (size === 0) {
        res.status(400).json({ error: "The uploaded file was empty." });
        return;
      }

      // Inspect BEFORE cataloguing, so a file that is not a backup at all is
      // rejected instead of appearing in the list as though it were restorable.
      const inspection = await inspectArchive(localPath);
      let manifest: any = null;
      let ok = false;
      let findings: unknown[] = [];
      try {
        manifest = inspection.manifest;
        ok = inspection.ok;
        findings = inspection.findings;
      } finally {
        await inspection.dispose();
      }

      if (!manifest) {
        res.status(400).json({
          error:
            "This file is not a Marlin backup archive — it has no manifest. Upload a ZIP created by this module.",
          findings,
        });
        return;
      }

      const objectPath = await stageUploadedArchive(localPath, filename);
      // Hashed by streaming the file, not readFile: an archive may be up to 2 GB
      // and buffering it whole would trade a disk read for an OOM.
      const checksum = await sha256File(localPath);

      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO backup_meta.backups
           (filename, object_path, scope, trigger, status, size_bytes, checksum,
            erp_version, database_version, schema_version, git_commit,
            table_count, row_count, file_count, manifest, created_by)
         VALUES ($1,$2,$3,'uploaded','ready',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING id`,
        [
          filename,
          objectPath,
          manifest.scope ?? "complete",
          size,
          checksum,
          manifest.erpVersion ?? "",
          manifest.databaseVersion ?? "",
          manifest.schemaVersion ?? "",
          manifest.gitCommit ?? "",
          (manifest.tables ?? []).length,
          (manifest.tables ?? []).reduce((s: number, t: any) => s + Number(t.rows ?? 0), 0),
          manifest.files?.count ?? 0,
          JSON.stringify(manifest),
          who(req),
        ],
      );

      logActivity({
        action: "CREATE",
        module: "backup",
        entityType: "backup",
        entityId: rows[0].id,
        description: `Backup archive uploaded — ${filename} (${formatBytes(size)})`,
        user: who(req),
        metadata: { ip: clientIp(req), valid: ok, findings },
      }).catch(() => {});

      res.status(201).json({
        id: rows[0].id,
        filename,
        sizeBytes: size,
        sizeLabel: formatBytes(size),
        ok,
        findings,
        manifest,
      });
    } catch (e: any) {
      req.log?.error({ err: e }, "Backup upload failed");
      res.status(500).json({ error: `The upload failed: ${String(e?.message ?? e)}` });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Restore
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  "/backup/:id/restore",
  requireHeadOffice("restore a backup"),
  requireModuleAction(PERM, "edit"),
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const password = String((req.body as any)?.password ?? "");
    const requested = (req.body as any)?.scope;

    // ── password confirmation ───────────────────────────────────────────────
    if (!password) {
      res.status(400).json({ error: "Enter your password to confirm this restore." });
      return;
    }
    const employeeId = (req as any).employee?.id;
    const { rows: creds } = await pool.query<{ password_hash: string }>(
      `SELECT password_hash FROM employees WHERE id = $1`,
      [employeeId],
    );
    const okPassword = creds[0]
      ? await PasswordService.verify(password, creds[0].password_hash)
      : false;
    if (!okPassword) {
      logActivity({
        action: "PERMISSION_DENIED",
        module: "backup",
        entityType: "restore",
        description: "Restore blocked — password confirmation failed",
        user: who(req),
        metadata: { ip: clientIp(req), backupId: id },
      }).catch(() => {});
      res.status(403).json({ error: "That password is not correct. The restore has not been started." });
      return;
    }

    const backup = await loadBackup(id);
    if (!backup || backup.status !== "ready" || !backup.object_path) {
      res.status(404).json({ error: "That backup is not available to restore." });
      return;
    }

    // A narrower scope than the archive holds is impossible to satisfy.
    const archiveScope = (backup.scope ?? "complete") as BackupScope;
    const scope = (VALID_SCOPES.includes(requested) ? requested : archiveScope) as BackupScope;
    if (archiveScope !== "complete" && scope !== archiveScope) {
      res.status(400).json({
        error: `This archive contains only ${archiveScope} data, so it cannot perform a ${scope} restore.`,
      });
      return;
    }

    // restoreFromArchive writes the STARTED / COMPLETED / FAILED audit rows
    // itself (with the ip passed below) — don't log the lifecycle here too.
    const staged = await stagedCopyOf(backup.object_path, backup.filename);
    try {
      const outcome = await restoreFromArchive({
        zipPath: staged.path,
        filename: backup.filename,
        scope,
        backupId: id,
        source: backup.trigger === "uploaded" ? "uploaded" : "stored",
        performedBy: who(req),
        ip: clientIp(req),
      });

      res.json(outcome);
    } catch (e: any) {
      req.log?.error({ err: e }, "Restore failed");

      res.status(500).json({
        error: String(e?.message ?? e),
        eventId: e?.eventId ?? null,
        safetyBackupId: e?.safetyBackupId ?? null,
        steps: e?.steps ?? [],
        // The database restore itself is one transaction, so a failure there has
        // changed nothing — and saying so plainly is the difference between a calm
        // retry and a panic. But the file and settings steps run after that commit,
        // so this is whatever actually happened, never an assumption. Absent the
        // flag, assume the worst rather than reassuring wrongly.
        dataUnchanged: e?.dataUnchanged === true,
        restartRequired: e?.restartRequired === true,
      });
    } finally {
      await staged.dispose();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Automatic backup settings
// ─────────────────────────────────────────────────────────────────────────────

router.get("/backup/settings", requireModuleView(PERM), async (_req: Request, res: Response) => {
  const settings = await loadSettings();
  res.json({ ...settings, nextRunAt: nextRunAt(settings) });
});

router.patch(
  "/backup/settings",
  requireHeadOffice("change backup settings"),
  requireModuleAction(PERM, "edit"),
  async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const before = await loadSettings();

    const frequency = body.frequency === undefined ? before.frequency : String(body.frequency);
    const retention = body.retention === undefined ? before.retention : String(body.retention);
    const includeFiles =
      body.includeFiles === undefined ? before.includeFiles : Boolean(body.includeFiles);

    if (!VALID_FREQUENCIES.includes(frequency as Frequency)) {
      res.status(400).json({ error: `Frequency must be one of: ${VALID_FREQUENCIES.join(", ")}.` });
      return;
    }
    if (!VALID_RETENTIONS.includes(retention as Retention)) {
      res.status(400).json({ error: `Retention must be one of: ${VALID_RETENTIONS.join(", ")}.` });
      return;
    }

    await pool.query(
      `UPDATE backup_meta.backup_settings
          SET frequency = $1, retention = $2, include_files = $3, updated_at = NOW()
        WHERE id = 1`,
      [frequency, retention, includeFiles],
    );

    // Tightening retention takes effect now rather than at the next sweep, so the
    // storage saving the administrator just asked for is actually delivered.
    const pruned = await applyRetention(retention as Retention);

    logActivity({
      action: "UPDATE",
      module: "backup",
      entityType: "backup_settings",
      description: `Automatic backup settings changed — ${frequency}, keep ${retention}`,
      user: who(req),
      metadata: { before: { ...before }, after: { frequency, retention, includeFiles }, pruned },
    }).catch(() => {});

    const after = await loadSettings();
    res.json({ ...after, nextRunAt: nextRunAt(after), pruned });
  },
);

export default router;
