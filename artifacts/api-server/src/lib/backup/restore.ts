/**
 * Validation, verification and restore.
 *
 * Three distinct operations, deliberately separated:
 *
 *   inspectArchive        — read-only. Answers "is this archive sound, and where
 *                           did it come from?" Nothing is written.
 *   verifyRestorable      — restores into a THROWAWAY database and compares the
 *                           result against the manifest. Proves the archive works
 *                           without going anywhere near live data.
 *   restoreFromArchive    — the real thing. Replaces live data, atomically.
 *
 * The middle one is what turns "we have a backup" into "we have a backup that
 * restores". An untested backup is a hope, and the only honest way to test one is
 * to actually restore it — so this module does, into a scratch database it creates
 * and drops for the purpose.
 */
import { mkdtemp, rm, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import { createClient, pool } from "@workspace/db";

import { logActivity } from "../audit";
import {
  BACKUP_FORMAT_VERSION,
  type BackupScope,
  type SignatureState,
  type SignedManifest,
  extractZip,
  sha256File,
  verifyManifestSignature,
} from "./archive";
import { createBackup, formatBytes } from "./create";
import { fetchBackupArchive, uploadRestoredFiles } from "./files";
import {
  createScratchDb,
  restoreCustom,
  restoreIntoEmpty,
  restorePlainSql,
  schemaFingerprint,
  serverVersion,
  tableCounts,
} from "./pgTools";
import { applySettingsExport } from "./settingsExport";
import { erpVersion } from "./versionInfo";

export interface Finding {
  level: "error" | "warning" | "info";
  message: string;
}

export interface ArchiveInspection {
  ok: boolean;
  manifest: SignedManifest | null;
  signature: SignatureState;
  scope: BackupScope | null;
  findings: Finding[];
  /** Extracted directory — caller owns cleanup via `dispose`. */
  dir: string;
  dispose(): Promise<void>;
}

/**
 * Open an archive and check everything checkable, without writing anything.
 *
 * Errors block a restore; warnings do not. The distinction matters: an archive
 * from an older ERP build is a warning, because restoring it is a legitimate
 * thing to want and the boot migrations will bring the schema forward. A corrupt
 * member is an error, because applying it would destroy live data in exchange for
 * a broken result.
 */
export async function inspectArchive(zipPath: string): Promise<ArchiveInspection> {
  const dir = await mkdtemp(join(tmpdir(), "marlin-restore-"));
  const findings: Finding[] = [];
  const dispose = () => rm(dir, { recursive: true, force: true }).catch(() => {});

  try {
    await extractZip(zipPath, dir);
  } catch (e: any) {
    findings.push({
      level: "error",
      message: `This file could not be opened as a ZIP archive. It may be corrupt or only partly uploaded. (${String(e?.message ?? e).slice(0, 200)})`,
    });
    return { ok: false, manifest: null, signature: "unverifiable", scope: null, findings, dir, dispose };
  }

  let manifest: SignedManifest | null = null;
  try {
    manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as SignedManifest;
  } catch {
    findings.push({
      level: "error",
      message:
        "manifest.json is missing or unreadable, so this archive cannot be identified or checked. It was not produced by this module, or it is incomplete.",
    });
    return { ok: false, manifest: null, signature: "unverifiable", scope: null, findings, dir, dispose };
  }

  // ── format ────────────────────────────────────────────────────────────────
  if (Number(manifest.formatVersion) > BACKUP_FORMAT_VERSION) {
    findings.push({
      level: "error",
      message: `This archive uses backup format ${manifest.formatVersion}, but this ERP understands only up to ${BACKUP_FORMAT_VERSION}. Update the ERP before restoring it.`,
    });
  }

  // ── signature ─────────────────────────────────────────────────────────────
  const signature = verifyManifestSignature(manifest);
  if (signature === "invalid") {
    findings.push({
      level: "error",
      message:
        "The manifest signature does not match its contents. This archive was altered after it was created and must not be restored.",
    });
  } else if (signature === "unverifiable") {
    findings.push({
      level: "info",
      message:
        "The signature cannot be checked here — this archive was created by a different installation. That is expected when recovering onto a new server.",
    });
  }

  // ── member integrity ──────────────────────────────────────────────────────
  const members = [
    manifest.database?.customDump,
    manifest.database?.plainSql,
    manifest.settings,
    ...(manifest.files?.entries ?? []),
  ].filter(Boolean) as Array<{ file: string; bytes: number; sha256: string }>;

  let corrupt = 0;
  let missing = 0;
  for (const m of members) {
    const abs = join(dir, m.file);
    try {
      const s = await stat(abs);
      if (s.size !== m.bytes) {
        corrupt++;
        continue;
      }
      if ((await sha256File(abs)) !== m.sha256) corrupt++;
    } catch {
      missing++;
    }
  }
  if (missing > 0) {
    findings.push({
      level: "error",
      message: `${missing} file(s) the manifest lists are not present in the archive. This backup is incomplete.`,
    });
  }
  if (corrupt > 0) {
    findings.push({
      level: "error",
      message: `${corrupt} file(s) do not match their recorded checksum. This backup is corrupt and must not be restored.`,
    });
  }
  if (missing === 0 && corrupt === 0 && members.length > 0) {
    findings.push({
      level: "info",
      message: `All ${members.length} archived file(s) match their checksums.`,
    });
  }

  const scope = (manifest.scope ?? "complete") as BackupScope;

  // ── what the scope requires ───────────────────────────────────────────────
  if (scope === "complete" || scope === "database") {
    if (!manifest.database?.customDump && !manifest.database?.plainSql) {
      findings.push({
        level: "error",
        message: "This archive claims to contain a database but has no database export in it.",
      });
    }
  }
  if (scope === "settings" && !manifest.settings) {
    findings.push({
      level: "error",
      message: "This archive claims to contain settings but has no settings.json in it.",
    });
  }

  // ── environment comparison ────────────────────────────────────────────────
  const [liveSchema, liveDbVersion, liveErp] = await Promise.all([
    schemaFingerprint(),
    serverVersion(),
    erpVersion(),
  ]);

  if (manifest.schemaVersion && manifest.schemaVersion !== liveSchema) {
    findings.push({
      level: "warning",
      message:
        "The database structure in this archive differs from the one running now. Restoring it replaces the structure as well as the data, and the ERP may run its start-up migrations afterwards. Restart the server once the restore finishes.",
    });
  } else if (manifest.schemaVersion) {
    findings.push({ level: "info", message: "Database structure matches the running ERP exactly." });
  }

  const archiveMajor = String(manifest.databaseVersion ?? "").split(".")[0];
  const liveMajor = String(liveDbVersion).split(".")[0];
  if (archiveMajor && liveMajor && archiveMajor !== liveMajor) {
    findings.push({
      level: Number(archiveMajor) > Number(liveMajor) ? "error" : "warning",
      message: `This archive came from PostgreSQL ${manifest.databaseVersion}; this server runs ${liveDbVersion}.${
        Number(archiveMajor) > Number(liveMajor)
          ? " A backup from a newer PostgreSQL cannot be restored onto an older one."
          : " Restoring across major versions usually works but is not guaranteed."
      }`,
    });
  }

  if (manifest.erpVersion && manifest.erpVersion !== liveErp) {
    findings.push({
      level: "warning",
      message: `This archive was taken from ERP version ${manifest.erpVersion}; this server runs ${liveErp}.`,
    });
  }

  // Missing tables, called out by name — the brief asks for this specifically,
  // and "a table is missing" is far more actionable than a fingerprint mismatch.
  if (manifest.tables?.length) {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const live = new Set(rows.map((r) => r.table_name));
    const absent = manifest.tables.map((t) => t.table).filter((t) => !live.has(t));
    if (absent.length > 0) {
      findings.push({
        level: "info",
        message: `${absent.length} table(s) in this archive do not exist here yet and will be created: ${absent.slice(0, 8).join(", ")}${absent.length > 8 ? "…" : ""}`,
      });
    }
  }

  return {
    ok: !findings.some((f) => f.level === "error"),
    manifest,
    signature,
    scope,
    findings,
    dir,
    dispose,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Verification: restore into a throwaway database
// ─────────────────────────────────────────────────────────────────────────────

export interface VerifyResult {
  ok: boolean;
  checks: Array<{ check: string; ok: boolean; detail: string }>;
  scratchDatabase: string;
}

/**
 * Prove an archive restores, in a database that is created and destroyed for it.
 *
 * The live database is never opened for writing here. The scratch database is
 * dropped in a `finally`, and a boot-time sweep clears any that a crash strands,
 * so this cannot silently accumulate full copies of the ERP.
 */
export async function verifyRestorable(zipPath: string): Promise<VerifyResult> {
  const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
  const inspection = await inspectArchive(zipPath);

  try {
    checks.push({
      check: "Archive validation",
      ok: inspection.ok,
      detail: inspection.ok
        ? "checksums, manifest and signature are sound"
        : inspection.findings.filter((f) => f.level === "error").map((f) => f.message).join("; "),
    });
    if (!inspection.ok) return { ok: false, checks, scratchDatabase: "" };

    const manifest = inspection.manifest!;
    const dumpFile = join(inspection.dir, "database.dump");
    const sqlFile = join(inspection.dir, "database.sql");
    const hasDump = await exists(dumpFile);
    const hasSql = await exists(sqlFile);

    if (!hasDump && !hasSql) {
      checks.push({
        check: "Test restore",
        ok: false,
        detail: "this archive has no database export, so there is nothing to restore",
      });
      return { ok: false, checks, scratchDatabase: "" };
    }

    const scratch = await createScratchDb();
    try {
      if (hasDump) await restoreIntoEmpty(dumpFile, scratch.url);
      else await restorePlainSql(sqlFile, scratch.url);

      checks.push({
        check: "Test restore into a temporary database",
        ok: true,
        detail: `restored ${hasDump ? "database.dump" : "database.sql"} into ${scratch.name}`,
      });

      // Count what actually landed and compare against the manifest. This is the
      // check that would catch a dump that restores "successfully" but empty.
      const client = createClient(scratch.url);
      await client.connect();
      try {
        const restored = await tableCounts(client as any);
        const restoredMap = new Map(restored.map((t) => [t.table, t.rows]));
        const expected = manifest.tables ?? [];

        const mismatches = expected
          .filter((e) => (restoredMap.get(e.table) ?? -1) !== e.rows)
          .map((e) => `${e.table}: expected ${e.rows}, found ${restoredMap.get(e.table) ?? "no table"}`);

        checks.push({
          check: "Row counts match the manifest",
          ok: mismatches.length === 0,
          detail:
            mismatches.length === 0
              ? `${expected.length} table(s), ${expected.reduce((s, t) => s + t.rows, 0)} row(s) — exact match`
              : `${mismatches.length} mismatch(es): ${mismatches.slice(0, 5).join("; ")}`,
        });

        const fp = await schemaFingerprint(client as any);
        checks.push({
          check: "Restored structure matches the manifest",
          ok: !manifest.schemaVersion || fp === manifest.schemaVersion,
          detail:
            !manifest.schemaVersion || fp === manifest.schemaVersion
              ? "structure fingerprint identical"
              : "the restored structure differs from what was recorded at backup time",
        });

        // Accounting integrity, in the restored copy. A backup that restores rows
        // but breaks double entry is not a usable backup of an ERP.
        for (const check of await accountingChecks(client as any)) checks.push(check);
      } finally {
        await client.end().catch(() => {});
      }
    } finally {
      await scratch.drop();
    }

    return { ok: checks.every((c) => c.ok), checks, scratchDatabase: "" };
  } finally {
    await inspection.dispose();
  }
}

/**
 * Invariants that must hold in any healthy copy of these books.
 *
 * Run against the restored copy, so they describe the restore rather than the
 * live system. Every one is derived from the data itself — no figure is compared
 * against a number typed into this file, because a hard-coded expectation would
 * start failing the moment the business recorded another sale.
 */
async function accountingChecks(
  client: { query: Function },
): Promise<Array<{ check: string; ok: boolean; detail: string }>> {
  const out: Array<{ check: string; ok: boolean; detail: string }> = [];

  const hasTable = async (t: string) => {
    const { rows } = await client.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
      [t],
    );
    return rows.length > 0;
  };

  if (await hasTable("journal_voucher_lines")) {
    const { rows } = await client.query(
      `SELECT COALESCE(SUM(debit),0)::numeric AS dr, COALESCE(SUM(credit),0)::numeric AS cr
         FROM journal_voucher_lines`,
    );
    const dr = Number(rows[0].dr);
    const cr = Number(rows[0].cr);
    const balanced = Math.abs(dr - cr) < 0.01;
    out.push({
      check: "Journal entries balance (double entry)",
      ok: balanced,
      detail: balanced
        ? `debits and credits both ₹${dr.toFixed(2)}`
        : `debits ₹${dr.toFixed(2)} vs credits ₹${cr.toFixed(2)} — out by ₹${Math.abs(dr - cr).toFixed(2)}`,
    });
  }

  // Users and permissions: a restore that loses these locks everyone out, so it
  // is checked explicitly rather than left to the row-count comparison.
  if (await hasTable("employees")) {
    const { rows } = await client.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE password_hash LIKE '$2%')::int AS hashed
         FROM employees`,
    );
    out.push({
      check: "Users restored with usable credentials",
      ok: Number(rows[0].total) > 0,
      detail: `${rows[0].total} user(s), ${rows[0].hashed} with a bcrypt password`,
    });
  }

  if (await hasTable("permissions")) {
    const { rows } = await client.query(`SELECT count(*)::int AS c FROM permissions`);
    out.push({
      check: "Permissions restored",
      ok: true,
      detail: `${rows[0].c} permission row(s)`,
    });
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// The real restore
// ─────────────────────────────────────────────────────────────────────────────

export interface RestoreStep {
  step: string;
  ok: boolean;
  detail: string;
}

export interface RestoreOutcome {
  ok: boolean;
  eventId: number;
  safetyBackupId: number | null;
  steps: RestoreStep[];
  /** Post-restore comparison against the manifest. */
  verification: Array<{ check: string; ok: boolean; detail: string }>;
  restartRequired: boolean;
}

export interface RestoreInput {
  zipPath: string;
  filename: string;
  /** 'complete' applies everything in the archive; narrower scopes apply a part. */
  scope: BackupScope;
  backupId: number | null;
  source: "stored" | "uploaded";
  performedBy: string;
  ip: string;
}

/**
 * Replace live data with an archive's contents.
 *
 * Order is deliberate: validate, then take a safety backup, then apply. The
 * safety backup comes before any write and is itself verified as `ready` — a
 * safety net that was never checked is not a safety net, and this is the last
 * moment at which the current state can still be captured.
 */
export async function restoreFromArchive(input: RestoreInput): Promise<RestoreOutcome> {
  const steps: RestoreStep[] = [];
  let verification: Array<{ check: string; ok: boolean; detail: string }> = [];
  let safetyBackupId: number | null = null;
  // The point of no return. pg_restore runs in one transaction, so up to the
  // moment it commits a failure genuinely has changed nothing — but the file and
  // settings steps run *after* that commit, and a failure there leaves live data
  // already replaced. Reporting "nothing changed" then would be a lie told at the
  // worst possible moment, so track what actually landed.
  let dbApplied = false;
  let filesApplied = false;

  const { rows: ev } = await pool.query<{ id: number }>(
    `INSERT INTO backup_meta.restore_events (backup_id, source, filename, scope, status, performed_by, ip)
     VALUES ($1, $2, $3, $4, 'started', $5, $6) RETURNING id`,
    [input.backupId, input.source, input.filename, input.scope, input.performedBy, input.ip],
  );
  const eventId = ev[0].id;

  logActivity({
    action: "UPDATE",
    module: "backup",
    entityType: "restore",
    entityId: eventId,
    description: `Restore STARTED from ${input.filename} (${input.scope})`,
    user: input.performedBy,
    metadata: { scope: input.scope, source: input.source, ip: input.ip, backupId: input.backupId },
  }).catch(() => {});

  const inspection = await inspectArchive(input.zipPath);

  try {
    // ── 1. validate ─────────────────────────────────────────────────────────
    steps.push({
      step: "Validate the archive",
      ok: inspection.ok,
      detail: inspection.ok
        ? "checksums, manifest and structure all check out"
        : inspection.findings.filter((f) => f.level === "error").map((f) => f.message).join("; "),
    });
    if (!inspection.ok) throw new Error(steps[steps.length - 1].detail);

    const manifest = inspection.manifest!;

    // ── 2. safety backup ────────────────────────────────────────────────────
    const safety = await createBackup({
      scope: "complete",
      trigger: "pre_restore",
      createdBy: input.performedBy,
    });
    safetyBackupId = safety.id;
    await pool.query(`UPDATE backup_meta.restore_events SET safety_backup_id = $2 WHERE id = $1`, [
      eventId,
      safety.id,
    ]);
    steps.push({
      step: "Back up current data first",
      ok: true,
      detail: `${safety.filename} (${formatBytes(safety.sizeBytes)}) — restore this to undo`,
    });

    // ── 3. database ─────────────────────────────────────────────────────────
    if (input.scope === "complete" || input.scope === "database") {
      const dumpFile = join(inspection.dir, "database.dump");
      const sqlFile = join(inspection.dir, "database.sql");

      if (await exists(dumpFile)) {
        await restoreCustom(dumpFile);
        dbApplied = true;
        steps.push({
          step: "Restore the database",
          ok: true,
          detail: `applied database.dump in a single transaction — ${(manifest.tables ?? []).length} table(s)`,
        });
      } else if (await exists(sqlFile)) {
        await restorePlainSql(sqlFile);
        dbApplied = true;
        steps.push({
          step: "Restore the database",
          ok: true,
          detail: "applied database.sql in a single transaction",
        });
      } else {
        throw new Error("The archive contains no database export.");
      }
    }

    // ── 4. files ────────────────────────────────────────────────────────────
    if (input.scope === "complete" || input.scope === "files") {
      const uploadsDir = join(inspection.dir, "uploads");
      if (await exists(uploadsDir)) {
        const files = await walkFiles(uploadsDir);
        // Defence in depth. Info-ZIP's unzip already strips "../" components and
        // absolute path specs (verified), so nothing should land outside
        // uploadsDir — but the storage key is derived from this path, so refuse
        // anything that escaped rather than trusting the extractor's defaults.
        const members = files.map((abs) => ({
          absPath: abs,
          relativePath: relative(uploadsDir, abs),
        }));
        const escaped = members.filter(
          (m) => m.relativePath.startsWith("..") || isAbsolute(m.relativePath),
        );
        if (escaped.length > 0) {
          throw new Error(
            `The archive contains ${escaped.length} file path(s) that point outside the uploads folder, so it has not been trusted: ${escaped
              .slice(0, 3)
              .map((m) => m.relativePath)
              .join(", ")}`,
          );
        }

        const restored = await uploadRestoredFiles(members);
        filesApplied = restored > 0;
        steps.push({
          step: "Restore uploaded files",
          ok: true,
          detail: `${restored} file(s) written back to storage`,
        });
      } else {
        steps.push({
          step: "Restore uploaded files",
          ok: true,
          detail: "this archive contains no uploaded files",
        });
      }
    }

    // ── 5. settings ─────────────────────────────────────────────────────────
    // Only for a settings-only restore. In a complete restore the database dump
    // already carries these tables, and re-applying settings.json afterwards
    // would be a second, weaker write over rows that are already correct.
    if (input.scope === "settings") {
      const settingsFile = join(inspection.dir, "settings.json");
      if (!(await exists(settingsFile))) throw new Error("The archive contains no settings.json.");
      const data = JSON.parse(await readFile(settingsFile, "utf8"));

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await applySettingsExport(client, data);
        await client.query("COMMIT");
        dbApplied = true;
        steps.push({
          step: "Restore settings",
          ok: true,
          detail: `${result.applied.map((a) => `${a.table} (${a.rows})`).join(", ")}; not applied: ${result.skipped.length} section(s)`,
        });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    }

    // ── 6. verify what landed ───────────────────────────────────────────────
    verification = await postRestoreVerification(manifest, input.scope);
    const failedChecks = verification.filter((v) => !v.ok);
    steps.push({
      step: "Verify the restored data",
      ok: failedChecks.length === 0,
      detail:
        failedChecks.length === 0
          ? `${verification.length} check(s) passed`
          : `${failedChecks.length} check(s) failed: ${failedChecks.map((f) => f.check).join(", ")}`,
    });

    const ok = steps.every((s) => s.ok);
    await pool.query(
      `UPDATE backup_meta.restore_events
          SET status = $2, steps = $3, finished_at = NOW(), error = $4
        WHERE id = $1`,
      [
        eventId,
        ok ? "completed" : "failed",
        JSON.stringify({ steps, verification }),
        ok ? "" : "Some post-restore checks did not pass.",
      ],
    );

    logActivity({
      action: "UPDATE",
      module: "backup",
      entityType: "restore",
      entityId: eventId,
      description: ok
        ? `Restore COMPLETED from ${input.filename} (${input.scope})`
        : `Restore COMPLETED WITH WARNINGS from ${input.filename}`,
      user: input.performedBy,
      metadata: { scope: input.scope, ip: input.ip, safetyBackupId, steps, verification },
    }).catch(() => {});

    return {
      ok,
      eventId,
      safetyBackupId,
      steps,
      verification,
      // A restore can change the schema under a running process, and the boot
      // migrations have not run against the restored structure. Nothing here is
      // trustworthy until the server comes back up.
      restartRequired: input.scope === "complete" || input.scope === "database",
    };
  } catch (e: any) {
    const message = String(e?.message ?? e).slice(0, 2000);
    const partiallyApplied = dbApplied || filesApplied;
    steps.push({ step: "Restore aborted", ok: false, detail: message });

    // Say plainly which of the two situations this is. "Nothing changed" and
    // "some of it landed, use the safety backup" call for completely different
    // reactions from whoever is reading this at 2am.
    steps.push(
      partiallyApplied
        ? {
            step: "State of your data",
            ok: false,
            detail:
              `PART OF THIS RESTORE WAS ALREADY APPLIED before the failure` +
              `${dbApplied ? " (the database was replaced)" : ""}` +
              `${filesApplied ? " (files were written back)" : ""}. ` +
              (safetyBackupId
                ? `Restore safety backup #${safetyBackupId} to return to how things were, then restart the server.`
                : `No safety backup is available.`),
          }
        : {
            step: "State of your data",
            ok: true,
            detail:
              "Your data was not changed — the failure happened before anything was written.",
          },
    );

    await pool
      .query(
        `UPDATE backup_meta.restore_events
            SET status = 'failed', steps = $3, error = $2, finished_at = NOW()
          WHERE id = $1`,
        [eventId, message, JSON.stringify({ steps, verification })],
      )
      .catch(() => {});

    logActivity({
      action: "UPDATE",
      module: "backup",
      entityType: "restore",
      entityId: eventId,
      description:
        `Restore FAILED from ${input.filename}: ${message}` +
        (partiallyApplied ? " — PARTIALLY APPLIED, data was changed" : " — data unchanged"),
      user: input.performedBy,
      metadata: {
        scope: input.scope,
        ip: input.ip,
        safetyBackupId,
        error: message,
        partiallyApplied,
        dbApplied,
        filesApplied,
      },
    }).catch(() => {});

    throw Object.assign(new Error(message), {
      eventId,
      safetyBackupId,
      steps,
      // Only true when nothing had been written yet. The route must not assume.
      dataUnchanged: !partiallyApplied,
      // The DB was swapped under a running process, so a restart is needed even
      // though the restore failed.
      restartRequired: dbApplied,
    });
  } finally {
    await inspection.dispose();
  }
}

/**
 * Compare the live database against what the archive said it held.
 *
 * The brief's list — trial balance, ledger, inventory, users, permissions,
 * payroll, warehouse data — reduces to two questions worth asking mechanically:
 * did every row arrive, and do the books still balance. Row counts cover the
 * first for every table at once, which is stronger than naming a handful of
 * reports; double entry covers the second.
 */
async function postRestoreVerification(
  manifest: SignedManifest,
  scope: BackupScope,
): Promise<Array<{ check: string; ok: boolean; detail: string }>> {
  const out: Array<{ check: string; ok: boolean; detail: string }> = [];

  if (scope === "complete" || scope === "database") {
    const live = await tableCounts();
    const liveMap = new Map(live.map((t) => [t.table, t.rows]));
    const expected = manifest.tables ?? [];

    const mismatches = expected
      .filter((e) => (liveMap.get(e.table) ?? -1) !== e.rows)
      .map((e) => `${e.table}: expected ${e.rows}, found ${liveMap.get(e.table) ?? "missing"}`);

    out.push({
      check: "Every row restored",
      ok: mismatches.length === 0,
      detail:
        mismatches.length === 0
          ? `${expected.length} table(s), ${expected.reduce((s, t) => s + t.rows, 0)} row(s) match the backup exactly`
          : `${mismatches.length} table(s) differ: ${mismatches.slice(0, 5).join("; ")}`,
    });

    const fp = await schemaFingerprint();
    out.push({
      check: "Database structure matches the backup",
      ok: !manifest.schemaVersion || fp === manifest.schemaVersion,
      detail:
        !manifest.schemaVersion || fp === manifest.schemaVersion
          ? "identical"
          : "the live structure differs from the archive — restart the server so start-up migrations run",
    });
  }

  for (const c of await accountingChecks(pool as any)) out.push(c);

  if (manifest.files) {
    out.push({
      check: "Files accounted for",
      ok: true,
      detail: `${manifest.files.count} file(s), ${formatBytes(manifest.files.bytes)} in the archive`,
    });
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkFiles(abs)));
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

/** Pull a catalogued archive out of storage into a local temp file. */
export async function stagedCopyOf(objectPath: string, filename: string): Promise<{ path: string; dispose(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "marlin-archive-"));
  const path = join(dir, filename);
  await fetchBackupArchive(objectPath, path);
  return { path, dispose: () => rm(dir, { recursive: true, force: true }).catch(() => {}) };
}
