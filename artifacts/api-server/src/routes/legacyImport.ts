/**
 * Legacy ERP Import (Company → Data Migration).
 *
 * Upload an old ERP backup (ZIP of DBF tables, or bare DBF files), have it
 * extracted and analyzed server-side, and see what's inside before importing.
 *
 * This router covers the UPLOAD + ANALYSIS stage. The import stage reuses the
 * existing import-batch machinery (routes/imports.ts) so imported documents
 * run through the exact business logic manual entry uses — batches, history
 * and rollback included. Mapping from the legacy schema onto import rows is
 * added per legacy-ERP format; the analysis this router produces is what that
 * mapping is confirmed against.
 *
 * Sessions are transient (/tmp): a restart discards extracted files and the
 * client is told to upload again (410). Nothing under /tmp is business data —
 * the uploaded archive is re-uploadable by definition.
 *
 * Security posture:
 *  - :id is validated as the exact generated hex shape BEFORE any filesystem
 *    call (a traversal value must never reach path.join or the recursive rm).
 *  - Sessions are PERSONAL: every route verifies the owning employee id — a
 *    leaked session id gives another user nothing (404, not 403).
 *  - Mutating routes for one session serialize on a per-session lock.
 *  - Archive extraction enforces entry/size caps (ZIP-bomb defence) and a
 *    per-session on-disk quota; abandoned sessions are TTL-swept on upload.
 *
 * Access: Management and Admin only — the page permission is seeded to
 * level-2 hierarchies alone (level 1 bypasses permission checks).
 */
import express, { type Request, type Response, Router } from "express";

import { requireModuleAction, requireModuleView } from "../middleware/permissions";
import {
  analyzeSessionDir, clearExtracted, discardSession, extractBackupToDir, isValidDirId,
  loadMeta, MAX_SESSION_BYTES, newSessionDirId, PasswordRequiredError, readTableRows,
  saveMeta, sessionDir, sessionExists, sessionSizeBytes, sweepExpiredSessions,
  withSessionLock, WrongPasswordError, type LegacySessionMeta,
} from "../lib/legacyBackup";
import { readFile } from "node:fs/promises";
import path from "node:path";

const router = Router();
const PERM = "page:/company/legacy-import";

const employeeOf = (req: Request) => (req as any).employee as { id: number; username: string } | undefined;

/** The public shape of a session — meta minus anything internal. */
function sessionJson(meta: LegacySessionMeta) {
  return {
    uploadId: meta.dirId,
    fileName: meta.originalFileName,
    createdBy: meta.createdBy,
    createdAt: meta.createdAt,
    status: meta.status,
    analysis: meta.analysis ?? null,
    error: meta.error ?? null,
  };
}

const GONE_MSG = "This upload session has expired (the server was restarted). Upload the backup again.";
const NOT_FOUND_MSG = "No such upload.";

/**
 * Resolve a session the CALLER owns, or answer the request and return null.
 * Malformed id / someone else's session → 404 (don't confirm existence);
 * a well-formed id whose files are gone → 410 (upload again).
 */
async function loadOwnedMeta(req: Request, res: Response): Promise<LegacySessionMeta | null> {
  const dirId = String(req.params.id);
  if (!isValidDirId(dirId)) { res.status(404).json({ error: NOT_FOUND_MSG }); return null; }
  const meta = sessionExists(dirId) ? await loadMeta(dirId) : null;
  if (!meta) { res.status(410).json({ error: GONE_MSG }); return null; }
  if (meta.createdById !== employeeOf(req)?.id) { res.status(404).json({ error: NOT_FOUND_MSG }); return null; }
  return meta;
}

// ── Upload ───────────────────────────────────────────────────────────────────
// Raw body, same pattern as the Excel import and backup restore uploads: the
// file is parsed server-side immediately, so multipart buys nothing. Legacy
// backups are compressed DBF sets — 200 MB covers decades of vouchers.
router.post(
  "/legacy-import/uploads",
  requireModuleAction(PERM, "add"),
  express.raw({ type: () => true, limit: "200mb" }),
  async (req: Request, res: Response): Promise<void> => {
    void sweepExpiredSessions().catch(() => {}); // opportunistic TTL cleanup

    const filename = String(req.query.filename ?? "backup.zip").replace(/[^A-Za-z0-9 ._()-]/g, "_").slice(-120);
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: "The uploaded file was empty." });
      return;
    }

    const dirId = newSessionDirId();
    const meta: LegacySessionMeta = {
      dirId,
      originalFileName: filename,
      createdBy: employeeOf(req)?.username ?? "system",
      createdById: employeeOf(req)?.id ?? -1,
      createdAt: new Date().toISOString(),
      status: "ready",
    };

    try {
      // Keep the original so an unlock (password retry) can re-extract without
      // a second upload — phones on hotel Wi-Fi should not re-send 100 MB.
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(sessionDir(dirId), { recursive: true });
      await writeFile(path.join(sessionDir(dirId), "__original__"), body);

      await extractBackupToDir(body, filename, sessionDir(dirId));
      meta.analysis = await analyzeSessionDir(sessionDir(dirId));
    } catch (e) {
      if (e instanceof PasswordRequiredError) {
        meta.status = "password_required";
      } else {
        await discardSession(dirId);
        res.status(400).json({ error: (e as Error).message });
        return;
      }
    }

    await saveMeta(dirId, meta);
    res.status(201).json(sessionJson(meta));
  },
);

// ── Unlock (password retry) ──────────────────────────────────────────────────
router.post(
  "/legacy-import/uploads/:id/unlock",
  requireModuleAction(PERM, "add"),
  express.json(),
  async (req: Request, res: Response): Promise<void> => {
    const meta = await loadOwnedMeta(req, res);
    if (!meta) return;
    if (meta.status === "ready") { res.json(sessionJson(meta)); return; }

    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!password) { res.status(400).json({ error: "Enter the backup's password." }); return; }

    await withSessionLock(meta.dirId, async () => {
      let original: Buffer;
      try {
        original = await readFile(path.join(sessionDir(meta.dirId), "__original__"));
      } catch {
        res.status(410).json({ error: GONE_MSG });
        return;
      }

      try {
        // A failed earlier attempt can leave partial files (e.g. memo files
        // extracted before the wrong password was detected) — start clean.
        await clearExtracted(meta.dirId);
        await extractBackupToDir(original, meta.originalFileName, sessionDir(meta.dirId), password);
        meta.analysis = await analyzeSessionDir(sessionDir(meta.dirId));
        meta.status = "ready";
        meta.error = undefined;
      } catch (e) {
        if (e instanceof WrongPasswordError || e instanceof PasswordRequiredError) {
          res.status(400).json({ error: "That password did not open the backup. Check it and try again." });
          return;
        }
        res.status(400).json({ error: (e as Error).message });
        return;
      }

      await saveMeta(meta.dirId, meta);
      res.json(sessionJson(meta));
    });
  },
);

// ── Add more DBF files to a session (multi-file legacy backups) ─────────────
router.post(
  "/legacy-import/uploads/:id/files",
  requireModuleAction(PERM, "add"),
  express.raw({ type: () => true, limit: "200mb" }),
  async (req: Request, res: Response): Promise<void> => {
    const meta = await loadOwnedMeta(req, res);
    if (!meta) return;
    if (meta.status !== "ready") {
      res.status(400).json({ error: "Unlock the backup before adding more files." });
      return;
    }
    const filename = String(req.query.filename ?? "table.dbf").replace(/[^A-Za-z0-9 ._()-]/g, "_").slice(-120);
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: "The uploaded file was empty." });
      return;
    }

    await withSessionLock(meta.dirId, async () => {
      if ((await sessionSizeBytes(meta.dirId)) + body.length > MAX_SESSION_BYTES) {
        res.status(400).json({ error: `This session has reached its ${Math.round(MAX_SESSION_BYTES / 1048576)} MB storage limit. Start a new upload for the remaining files.` });
        return;
      }
      try {
        await extractBackupToDir(body, filename, sessionDir(meta.dirId));
        meta.analysis = await analyzeSessionDir(sessionDir(meta.dirId));
      } catch (e) {
        if (e instanceof PasswordRequiredError) {
          res.status(400).json({ error: "That ZIP is password-protected. Upload it as its own backup instead." });
          return;
        }
        res.status(400).json({ error: (e as Error).message });
        return;
      }
      await saveMeta(meta.dirId, meta);
      res.json(sessionJson(meta));
    });
  },
);

// ── Read a session ───────────────────────────────────────────────────────────
router.get(
  "/legacy-import/uploads/:id",
  requireModuleView(PERM),
  async (req: Request, res: Response): Promise<void> => {
    const meta = await loadOwnedMeta(req, res);
    if (!meta) return;
    res.json(sessionJson(meta));
  },
);

// ── Sample rows from one extracted table ─────────────────────────────────────
// Lets the user (and the mapping work) eyeball real values before any import.
router.get(
  "/legacy-import/uploads/:id/tables/:file/rows",
  requireModuleView(PERM),
  async (req: Request, res: Response): Promise<void> => {
    const meta = await loadOwnedMeta(req, res);
    if (!meta) return;
    if (meta.status !== "ready") { res.status(400).json({ error: "Unlock the backup first." }); return; }

    const fileParam = path.basename(String(req.params.file)); // no traversal
    const table = meta.analysis?.tables.find((t) => t.fileName === fileParam);
    if (!table) { res.status(404).json({ error: "No such table in this backup." }); return; }
    if (table.parseError) { res.status(400).json({ error: `This table could not be read: ${table.parseError}` }); return; }

    const limit = Number(req.query.limit ?? 20);
    try {
      const rows = await readTableRows(meta.dirId, table.fileName, Number.isFinite(limit) ? limit : 20);
      res.json({ table: table.name, fields: table.fields, rows });
    } catch (e) {
      res.status(400).json({ error: `Could not read rows from ${table.name}: ${(e as Error).message}` });
    }
  },
);

// ── Discard a session ────────────────────────────────────────────────────────
router.delete(
  "/legacy-import/uploads/:id",
  requireModuleAction(PERM, "add"),
  async (req: Request, res: Response): Promise<void> => {
    const dirId = String(req.params.id);
    if (!isValidDirId(dirId)) { res.status(404).json({ error: NOT_FOUND_MSG }); return; }
    const meta = sessionExists(dirId) ? await loadMeta(dirId) : null;
    if (!meta) { res.json({ ok: true }); return; } // already gone — discard is idempotent
    if (meta.createdById !== employeeOf(req)?.id) { res.status(404).json({ error: NOT_FOUND_MSG }); return; }
    await withSessionLock(dirId, () => discardSession(dirId));
    res.json({ ok: true });
  },
);

export default router;
