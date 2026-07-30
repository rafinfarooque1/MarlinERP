/**
 * settings.json — the configuration slice of a backup.
 *
 * Everything here is also inside database.sql, so this file is not what makes a
 * restore possible. It exists for two things the full dump cannot do:
 *
 *   1. Let an administrator READ their configuration — open the archive, look at
 *      settings.json, confirm the GST numbers and permissions are the ones they
 *      expect — without a PostgreSQL client.
 *   2. Support the brief's "Settings Only" export and restore, for moving
 *      configuration between installations without dragging along the ledgers.
 *
 * ── Why "Settings Only" restores less than it exports ───────────────────────
 * The brief lists Location Structure among the settings. It is exported, because
 * an administrator inspecting an archive expects to find it. It is deliberately
 * NOT re-applied by a settings-only restore: warehouses and outlets are
 * referenced by sales, stock, transfers, payroll and rent, and overwriting them
 * against a live ledger would repoint or orphan real financial rows. Restoring
 * locations is a whole-database operation, where the referencing rows travel with
 * them and stay consistent.
 *
 * So the export is a superset of what settings-only restore touches, and the API
 * says which is which rather than quietly dropping half of it.
 */
import { pool, type PgPoolClient as PoolClient } from "@workspace/db";

/** Exported for inspection AND re-applied by a settings-only restore. */
export const RESTORABLE_SETTINGS_TABLES = [
  "company_settings",
  "hierarchies",
  "permissions",
  "voucher_sequences",
] as const;

/**
 * Exported for inspection ONLY — see the note above.
 *
 * `assets` (fixed-asset master) and `asset_purchases` (acquisitions that carry
 * capitalised value and a linked journal voucher) are reference-only for the
 * same reason `warehouses`/`outlets` are: they are referenced by real financial
 * rows (the Fixed Asset ledger postings), so a settings-only restore must not
 * rewrite them against a live ledger. They travel with the full-database dump,
 * which restores them consistently alongside the postings that reference them.
 */
export const REFERENCE_ONLY_TABLES = ["warehouses", "outlets", "pay_components", "assets", "asset_purchases"] as const;

export interface SettingsExport {
  exportedAt: string;
  /** Which of the sections below a settings-only restore will actually write. */
  restorable: string[];
  referenceOnly: string[];
  sections: Record<string, unknown[]>;
}

const ALL_TABLES = [...RESTORABLE_SETTINGS_TABLES, ...REFERENCE_ONLY_TABLES];

/**
 * Read every settings table.
 *
 * Ordered by primary key so two exports of unchanged configuration produce
 * byte-identical JSON; without it the checksums would differ run to run and
 * "has my configuration changed?" would be unanswerable.
 */
export async function buildSettingsExport(): Promise<SettingsExport> {
  const sections: Record<string, unknown[]> = {};

  for (const table of ALL_TABLES) {
    // Not every settings table is keyed on `id` — voucher_sequences is keyed on
    // (voucher_type, fy_label) — so order by the real key columns.
    const { rows: keyCols } = await pool.query<{ column_name: string }>(
      `SELECT a.attname AS column_name
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = $1::regclass AND i.indisprimary
        ORDER BY a.attnum`,
      [table],
    );
    const orderBy = keyCols.length
      ? keyCols.map((c) => `"${c.column_name}"`).join(", ")
      : "1";
    const { rows } = await pool.query(`SELECT * FROM "${table}" ORDER BY ${orderBy}`);
    sections[table] = rows;
  }

  return {
    exportedAt: new Date().toISOString(),
    restorable: [...RESTORABLE_SETTINGS_TABLES],
    referenceOnly: [...REFERENCE_ONLY_TABLES],
    sections,
  };
}

export interface SettingsRestoreResult {
  applied: Array<{ table: string; rows: number }>;
  skipped: string[];
}

/**
 * Replace the restorable settings tables with the archive's contents.
 *
 * Runs inside the caller's transaction so a malformed section cannot leave the
 * installation with half its permissions — a partial write here would be an
 * authorisation failure, not just a data one.
 *
 * Columns are intersected with what the live schema has, so a settings file from
 * an older or newer ERP still applies for the columns both versions share
 * instead of failing wholesale on one renamed field.
 */
export async function applySettingsExport(
  client: PoolClient,
  data: SettingsExport,
): Promise<SettingsRestoreResult> {
  const applied: Array<{ table: string; rows: number }> = [];
  const skipped: string[] = [];

  for (const table of RESTORABLE_SETTINGS_TABLES) {
    const rows = data.sections?.[table];
    if (!Array.isArray(rows)) {
      skipped.push(`${table} (absent from backup)`);
      continue;
    }

    const { rows: liveCols } = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1`,
      [table],
    );
    const live = new Set(liveCols.map((c: { column_name: string }) => c.column_name));

    await client.query(`DELETE FROM "${table}"`);

    let written = 0;
    for (const row of rows as Array<Record<string, unknown>>) {
      const cols = Object.keys(row).filter((c) => live.has(c));
      if (cols.length === 0) continue;
      const params = cols.map((c) => row[c]);
      await client.query(
        `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")})
         VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
        params,
      );
      written++;
    }

    // Serial columns do not advance on an explicit-id insert, so the next natural
    // insert would collide with a restored row. Resync before leaving the table.
    await resyncSerial(client, table);
    applied.push({ table, rows: written });
  }

  for (const t of REFERENCE_ONLY_TABLES) {
    skipped.push(`${t} (exported for reference; restore the full database to move locations)`);
  }

  return { applied, skipped };
}

/**
 * Point a table's identity sequence past the highest restored id.
 *
 * Without this a settings-only restore looks perfect and then the very next
 * insert fails on a duplicate key, minutes or days later, with nothing obviously
 * connecting it to the restore.
 */
async function resyncSerial(client: PoolClient, table: string): Promise<void> {
  const { rows } = await client.query<{ col: string; seq: string }>(
    `SELECT a.attname AS col, pg_get_serial_sequence($1, a.attname) AS seq
       FROM pg_attribute a
      WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
        AND pg_get_serial_sequence($1, a.attname) IS NOT NULL`,
    [table],
  );
  for (const r of rows) {
    await client.query(
      `SELECT setval($1, COALESCE((SELECT MAX("${r.col}") FROM "${table}"), 0) + 1, false)`,
      [r.seq],
    );
  }
}

/** Used by the dashboard to show what a settings-only restore would touch. */
export async function settingsRowCounts(): Promise<Array<{ table: string; rows: number }>> {
  const out: Array<{ table: string; rows: number }> = [];
  for (const table of ALL_TABLES) {
    const { rows } = await pool.query<{ c: string }>(`SELECT count(*)::bigint AS c FROM "${table}"`);
    out.push({ table, rows: Number(rows[0].c) });
  }
  return out;
}
