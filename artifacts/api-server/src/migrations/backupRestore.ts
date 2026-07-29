import { pool as _pool } from "@workspace/db";

/** The shared pg pool, typed structurally so these helpers stay injectable. */
type Pool = typeof _pool;

/**
 * Backup & Restore schema.
 *
 * Three tables: a catalogue of archives, one row of schedule settings, and a
 * restore history.
 *
 * Note on `CREATE TABLE IF NOT EXISTS`: constraints written inside the CREATE
 * only ever apply the first time, so every uniqueness rule below is a separate
 * `CREATE UNIQUE INDEX IF NOT EXISTS` and every later column is an
 * `ADD COLUMN IF NOT EXISTS`. That keeps this migration correct on a database
 * where an earlier version of the table already exists.
 *
 * ── Why this lives in its own schema ───────────────────────────────────────
 * This catalogue is operational metadata about THIS host, not company data. If it
 * travelled inside the dump, restoring last week's archive would also roll the
 * catalogue back to last week — erasing the record of every newer backup,
 * including the safety backup taken moments earlier by the very same restore. The
 * administrator would be left unable to find the way back.
 *
 * So the dumps exclude it. The exclusion is done with `--exclude-schema` on this
 * schema rather than a list of `--exclude-table` flags, and that choice is load
 * bearing in two ways:
 *
 *  1. `--exclude-table` omits a table but STILL dumps the sequence its serial
 *     column owns. `--clean` then emits `DROP SEQUENCE restore_events_id_seq`,
 *     which fails outright because the surviving table's default depends on it —
 *     so every restore aborts. A schema exclusion covers tables, sequences,
 *     indexes and constraints together.
 *  2. A list has to be kept in step with reality. Adding a fourth bookkeeping
 *     table and forgetting the list would put it inside the dumps, and the silent
 *     rollback described above would be back. Anything created in this schema is
 *     excluded automatically, with nothing to remember.
 */
const SCHEMA = "backup_meta";

export async function addBackupRestore(pool: Pool): Promise<void> {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);

  // These tables shipped in `public` before the schema existed. Move them rather
  // than recreating, so an installation that already took backups keeps its
  // catalogue instead of appearing to have never backed anything up. SET SCHEMA
  // carries the owned sequences and indexes across with the table.
  for (const t of ["backups", "backup_settings", "restore_events"]) {
    const { rows } = await pool.query<{ moved: boolean }>(
      `SELECT to_regclass('public.' || $1) IS NOT NULL
          AND to_regclass('${SCHEMA}.' || $1) IS NULL AS moved`,
      [t],
    );
    if (rows[0]?.moved) {
      await pool.query(`ALTER TABLE public.${t} SET SCHEMA ${SCHEMA}`);
      console.log(`[migration] backup_restore: moved ${t} into the ${SCHEMA} schema`);
    }
  }

  // ── 1. Catalogue of archives ───────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.backups (
      id               SERIAL PRIMARY KEY,
      filename         TEXT        NOT NULL,
      object_path      TEXT        NOT NULL DEFAULT '',
      scope            TEXT        NOT NULL DEFAULT 'complete',
      trigger          TEXT        NOT NULL DEFAULT 'manual',
      status           TEXT        NOT NULL DEFAULT 'creating',
      size_bytes       BIGINT      NOT NULL DEFAULT 0,
      checksum         TEXT        NOT NULL DEFAULT '',
      erp_version      TEXT        NOT NULL DEFAULT '',
      database_version TEXT        NOT NULL DEFAULT '',
      schema_version   TEXT        NOT NULL DEFAULT '',
      git_commit       TEXT        NOT NULL DEFAULT '',
      table_count      INTEGER     NOT NULL DEFAULT 0,
      row_count        BIGINT      NOT NULL DEFAULT 0,
      file_count       INTEGER     NOT NULL DEFAULT 0,
      manifest         JSONB,
      error            TEXT        NOT NULL DEFAULT '',
      verified_at      TIMESTAMPTZ,
      verify_status    TEXT        NOT NULL DEFAULT '',
      verify_detail    TEXT        NOT NULL DEFAULT '',
      downloaded_at    TIMESTAMPTZ,
      created_by       TEXT        NOT NULL DEFAULT 'system',
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_backups_created ON ${SCHEMA}.backups (created_at DESC)`,
  );
  // Retention prunes by trigger, and the dashboard counts by status.
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_backups_trigger_status ON ${SCHEMA}.backups (trigger, status)`,
  );

  // ── 2. Schedule + retention (single row, id = 1) ────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.backup_settings (
      id              INTEGER     PRIMARY KEY,
      frequency       TEXT        NOT NULL DEFAULT 'manual',
      retention       TEXT        NOT NULL DEFAULT '30',
      include_files   BOOLEAN     NOT NULL DEFAULT TRUE,
      last_run_at     TIMESTAMPTZ,
      last_run_status TEXT        NOT NULL DEFAULT '',
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Manual-only by default. An installation must not start writing archives on a
  // schedule nobody chose — that is the administrator's decision, and defaulting
  // it on would consume their storage quota silently.
  await pool.query(
    `INSERT INTO ${SCHEMA}.backup_settings (id, frequency, retention)
     VALUES (1, 'manual', '30')
     ON CONFLICT (id) DO NOTHING`,
  );

  // ── 3. Restore history ─────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.restore_events (
      id               SERIAL PRIMARY KEY,
      backup_id        INTEGER,
      source           TEXT        NOT NULL DEFAULT 'stored',
      filename         TEXT        NOT NULL DEFAULT '',
      scope            TEXT        NOT NULL DEFAULT 'complete',
      status           TEXT        NOT NULL DEFAULT 'started',
      steps            JSONB,
      error            TEXT        NOT NULL DEFAULT '',
      safety_backup_id INTEGER,
      performed_by     TEXT        NOT NULL DEFAULT '',
      ip               TEXT        NOT NULL DEFAULT '',
      started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at      TIMESTAMPTZ
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_restore_events_started ON ${SCHEMA}.restore_events (started_at DESC)`,
  );

  // ── 4. Recover rows stranded by a crash ────────────────────────────────────
  // A process killed while writing an archive leaves a 'creating' row that would
  // otherwise sit in the list forever, and a 'started' restore that would make
  // the module look permanently busy.
  const { rowCount: staleBackups } = await pool.query(
    `UPDATE ${SCHEMA}.backups
        SET status = 'failed',
            error  = 'The server restarted while this backup was being created.'
      WHERE status = 'creating'`,
  );
  if (staleBackups) {
    console.log(`[migration] backup_restore: marked ${staleBackups} interrupted backup(s) failed`);
  }

  const { rowCount: staleRestores } = await pool.query(
    `UPDATE ${SCHEMA}.restore_events
        SET status      = 'failed',
            error       = 'The server restarted while this restore was running.',
            finished_at = NOW()
      WHERE status = 'started'`,
  );
  if (staleRestores) {
    console.log(`[migration] backup_restore: marked ${staleRestores} interrupted restore(s) failed`);
  }
}
