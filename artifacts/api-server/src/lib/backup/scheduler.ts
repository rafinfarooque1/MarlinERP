/**
 * Automatic backups and retention.
 *
 * Modelled on the rent accrual scheduler: an idempotent hourly catch-up rather
 * than a midnight tick. A process that is asleep, redeploying or crashed at
 * 00:00 must not silently skip a day's backup — the sweep asks "is one due?" and
 * that question answers itself correctly however long the gap was.
 *
 * Due-ness is derived from `last_run_at`, so restarts cannot double-run and a
 * long outage produces one catch-up backup rather than one per missed hour.
 */
import { pool } from "@workspace/db";

import { logActivity } from "../audit";
import { createBackup } from "./create";
import { deleteBackupArchive } from "./files";
import { dropStaleScratchDbs } from "./pgTools";

export type Frequency = "daily" | "weekly" | "monthly" | "manual";
export type Retention = "7" | "30" | "90" | "unlimited";

export interface BackupSettings {
  frequency: Frequency;
  retention: Retention;
  includeFiles: boolean;
  lastRunAt: string | null;
  lastRunStatus: string;
}

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export async function loadSettings(): Promise<BackupSettings> {
  const { rows } = await pool.query(
    `SELECT frequency, retention, include_files, last_run_at, last_run_status
       FROM backup_meta.backup_settings WHERE id = 1`,
  );
  const r = rows[0] ?? {};
  return {
    frequency: (r.frequency ?? "manual") as Frequency,
    retention: (r.retention ?? "30") as Retention,
    includeFiles: r.include_files ?? true,
    lastRunAt: r.last_run_at ? new Date(r.last_run_at).toISOString() : null,
    lastRunStatus: r.last_run_status ?? "",
  };
}

/** Interval in hours for each frequency; `manual` never becomes due. */
const INTERVAL_HOURS: Record<Frequency, number | null> = {
  daily: 24,
  weekly: 24 * 7,
  monthly: 24 * 30,
  manual: null,
};

export function nextRunAt(settings: BackupSettings, now = new Date()): string | null {
  const hours = INTERVAL_HOURS[settings.frequency];
  if (hours === null) return null;
  if (!settings.lastRunAt) return now.toISOString();
  return new Date(new Date(settings.lastRunAt).getTime() + hours * 3600_000).toISOString();
}

function isDue(settings: BackupSettings, now: Date): boolean {
  const next = nextRunAt(settings, now);
  return next !== null && new Date(next).getTime() <= now.getTime();
}

/**
 * Delete archives beyond the retention limit.
 *
 * Only automatic archives are pruned. A backup someone created by hand is one
 * they chose to keep, and deleting it because a counter rolled over would be the
 * module destroying the very thing it exists to preserve. Pre-restore safety
 * copies are pruned too, but never the newest one — that is the undo button for
 * the most recent restore.
 *
 * The storage object is deleted before its row, so a failure leaves a row
 * pointing at nothing (visible, recoverable) rather than an orphaned archive
 * silently consuming the quota with nothing referencing it.
 */
export async function applyRetention(retention: Retention): Promise<number> {
  if (retention === "unlimited") return 0;
  const keep = Number(retention);
  if (!Number.isFinite(keep) || keep <= 0) return 0;

  const { rows: prunable } = await pool.query<{ id: number; object_path: string; trigger: string }>(
    `SELECT id, object_path, trigger FROM backup_meta.backups
      WHERE trigger IN ('scheduled', 'pre_restore') AND status = 'ready'
      ORDER BY created_at DESC`,
  );

  const newestSafety = prunable.find((b) => b.trigger === "pre_restore")?.id;
  const doomed = prunable.slice(keep).filter((b) => b.id !== newestSafety);

  let deleted = 0;
  for (const b of doomed) {
    try {
      if (b.object_path) await deleteBackupArchive(b.object_path);
      await pool.query(`DELETE FROM backup_meta.backups WHERE id = $1`, [b.id]);
      deleted++;
    } catch (e) {
      console.error(`[backup] retention: could not delete backup ${b.id}:`, e);
    }
  }

  if (deleted > 0) {
    logActivity({
      action: "DELETE",
      module: "backup",
      entityType: "backup",
      description: `Retention policy removed ${deleted} automatic backup(s), keeping the newest ${keep}`,
      user: "system",
      metadata: { retention, deleted },
    }).catch(() => {});
  }
  return deleted;
}

export interface SweepResult {
  ran: boolean;
  backupId: number | null;
  pruned: number;
  error: string;
}

export async function runScheduledBackupSweep(now = new Date()): Promise<SweepResult> {
  const settings = await loadSettings();
  const result: SweepResult = { ran: false, backupId: null, pruned: 0, error: "" };

  if (isDue(settings, now)) {
    // Stamp the attempt BEFORE doing the work. A backup that throws must not
    // leave the schedule due, or a persistent failure becomes a hot loop that
    // retries every hour and fills the audit log.
    await pool.query(
      `UPDATE backup_meta.backup_settings SET last_run_at = NOW(), last_run_status = 'running' WHERE id = 1`,
    );
    try {
      const backup = await createBackup({
        scope: "complete",
        trigger: "scheduled",
        createdBy: "system (scheduled)",
        includeFiles: settings.includeFiles,
      });
      result.ran = true;
      result.backupId = backup.id;
      await pool.query(`UPDATE backup_meta.backup_settings SET last_run_status = 'ok' WHERE id = 1`);
      console.log(`[backup] scheduled ${settings.frequency} backup created — ${backup.filename}`);
    } catch (e: any) {
      result.error = String(e?.message ?? e).slice(0, 500);
      await pool.query(`UPDATE backup_meta.backup_settings SET last_run_status = $1 WHERE id = 1`, [
        `failed: ${result.error}`.slice(0, 200),
      ]);
      console.error("[backup] scheduled backup FAILED:", result.error);
    }
  }

  result.pruned = await applyRetention(settings.retention);
  return result;
}

/**
 * Start the hourly sweep.
 *
 * `unref()` so a pending timer never holds the process open during shutdown, and
 * the first sweep is delayed a minute so boot migrations finish first — a backup
 * taken mid-migration would capture a half-upgraded schema.
 */
export function startBackupScheduler(): void {
  const sweep = () => {
    runScheduledBackupSweep().catch((e) => console.error("[backup] sweep failed:", e));
    dropStaleScratchDbs()
      .then((n) => {
        if (n > 0) console.log(`[backup] dropped ${n} stranded verification database(s)`);
      })
      .catch(() => {});
  };

  setTimeout(sweep, 60_000).unref?.();
  setInterval(sweep, SWEEP_INTERVAL_MS).unref?.();
}
