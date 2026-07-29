/**
 * PostgreSQL dump / restore plumbing.
 *
 * Everything here shells out to the real `pg_dump`, `pg_restore` and `psql`
 * binaries rather than reconstructing SQL by hand. That is deliberate: the spec
 * asks for indexes, sequences, constraints, triggers, views and functions, and a
 * hand-rolled exporter would silently miss whichever of those the schema grows
 * next. The client tools are version-matched to the server (both 16.x), so the
 * dump is exactly what the server can consume.
 *
 * Two dump formats are written for every backup:
 *
 *   • database.dump — custom format. This is what a restore actually consumes,
 *     because only the custom format supports `--clean --if-exists` and, most
 *     importantly, `--single-transaction`.
 *   • database.sql — plain SQL. Human-readable, greppable, and restorable with
 *     nothing but `psql`, which matters when the restore has to happen outside
 *     this application entirely (a DBA on a laptop, a different host). The spec
 *     names this file, so it is the one an administrator will look for.
 *
 * Both are checksummed. A restore prefers the custom dump and falls back to the
 * plain SQL, so a backup remains usable even if one member is lost.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

import { pool } from "@workspace/db";

const run = promisify(execFile);

/** pg_dump on a 13 MB database takes ~0.2s; the ceiling is for pathological growth. */
const DUMP_TIMEOUT_MS = 10 * 60 * 1000;
/** Big enough for pg_restore's chatter on a failure, which is what we want to surface. */
const MAX_TOOL_OUTPUT = 4 * 1024 * 1024;

function connectionUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — cannot back up or restore the database.");
  return url;
}

/**
 * The module's own bookkeeping, deliberately kept OUT of every dump.
 *
 * The backup catalogue describes the archives available on THIS host. It is not
 * company data, and including it makes restores actively dangerous:
 *
 *   • Restoring last week's archive would roll the catalogue back to last week,
 *     erasing every row describing a NEWER archive. The administrator loses the
 *     list of the very backups that could undo the restore.
 *   • That includes the safety backup this module takes moments earlier, whose
 *     catalogue row would be wiped by the restore it exists to protect against —
 *     leaving the archive orphaned in storage with nothing pointing at it.
 *   • The restore history would erase the record of the restore currently in
 *     progress, so the audit trail would be missing exactly the event that
 *     matters most.
 *
 * Hence a whole schema rather than a list of table names. `--exclude-table` omits
 * the table but still dumps the sequence its serial column owns, so `--clean`
 * emits a DROP SEQUENCE that fails against the surviving table's default and
 * aborts the entire restore. One `--exclude-schema` covers tables, sequences and
 * indexes together, and covers anything added to the schema later without having
 * to remember to extend a list.
 *
 * Everything in `public` is company data and is backed up.
 */
export const BACKUP_META_SCHEMA = "backup_meta";

const excludeArgs = (): string[] => [`--exclude-schema=${BACKUP_META_SCHEMA}`];

/**
 * The same server, a different database name.
 *
 * Used only for verification restores. Rebuilding the URL by string surgery
 * would break on passwords containing '/', so the path is replaced through the
 * URL parser.
 */
function urlForDatabase(name: string): string {
  const u = new URL(connectionUrl());
  u.pathname = `/${name}`;
  return u.toString();
}

export function currentDatabaseName(): string {
  return new URL(connectionUrl()).pathname.replace(/^\//, "");
}

/**
 * Restores hold ACCESS EXCLUSIVE locks on every table they replace, so a single
 * in-flight report could otherwise stall the whole operation indefinitely.
 * Failing fast is the safer outcome: the restore runs in one transaction, so an
 * abort leaves the live database exactly as it was.
 */
function toolEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PGOPTIONS: "-c lock_timeout=15000 -c statement_timeout=600000",
    ...extra,
  };
}

async function tool(bin: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await run(bin, args, {
      env: toolEnv(),
      timeout: DUMP_TIMEOUT_MS,
      maxBuffer: MAX_TOOL_OUTPUT,
    });
    return `${stdout ?? ""}${stderr ?? ""}`;
  } catch (e: any) {
    // pg_* tools put the actionable message on stderr, not in `err.message`.
    const detail = String(e?.stderr || e?.stdout || e?.message || e).trim();
    throw new Error(`${bin} failed: ${detail.slice(0, 4000)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dump
// ─────────────────────────────────────────────────────────────────────────────

/** Write the custom-format dump — the authoritative artefact for restores. */
export async function dumpCustom(outFile: string): Promise<void> {
  await tool("pg_dump", [
    "--format=custom",
    // Ownership and grants belong to the host, not the backup: a restore onto a
    // fresh Replit has a different role name, and preserving the old one turns
    // every statement into a permission error.
    "--no-owner",
    "--no-privileges",
    ...excludeArgs(),
    "--file", outFile,
    connectionUrl(),
  ]);
}

/** Write the plain-SQL dump — readable, and restorable with psql alone. */
export async function dumpPlain(outFile: string): Promise<void> {
  await tool("pg_dump", [
    "--format=plain",
    "--no-owner",
    "--no-privileges",
    ...excludeArgs(),
    "--file", outFile,
    connectionUrl(),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Restore
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Replace the live database with a custom-format dump, atomically.
 *
 * `--single-transaction` is the whole safety story of this module. PostgreSQL
 * makes DDL transactional, so the drops and the recreates commit together or not
 * at all. A restore that dies halfway — bad archive, lost connection, lock
 * timeout — leaves the ERP running on untouched data instead of on a half-built
 * schema. Without it, a failed restore would be an outage.
 */
export async function restoreCustom(dumpFile: string, targetUrl = connectionUrl()): Promise<string> {
  return tool("pg_restore", [
    "--clean",
    "--if-exists",
    "--single-transaction",
    "--no-owner",
    "--no-privileges",
    "--dbname", targetUrl,
    dumpFile,
  ]);
}

/**
 * Restore a plain-SQL dump. Used only as a fallback when a backup has lost its
 * custom-format member. `ON_ERROR_STOP` plus an explicit transaction gives the
 * same all-or-nothing guarantee as `pg_restore --single-transaction`.
 */
export async function restorePlainSql(sqlFile: string, targetUrl = connectionUrl()): Promise<string> {
  return tool("psql", [
    "--quiet",
    "--no-psqlrc",
    "--set", "ON_ERROR_STOP=1",
    "--single-transaction",
    "--dbname", targetUrl,
    "--file", sqlFile,
  ]);
}

/** Load a dump into an empty database. No `--clean`: there is nothing to drop. */
export async function restoreIntoEmpty(dumpFile: string, targetUrl: string): Promise<string> {
  return tool("pg_restore", [
    "--single-transaction",
    "--no-owner",
    "--no-privileges",
    "--dbname", targetUrl,
    dumpFile,
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Scratch database — how a backup is proven restorable
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A throwaway database used to prove a backup actually restores.
 *
 * This is the difference between "we produced a file" and "we produced a file
 * that works". The archive is restored into a brand-new database, its contents
 * are counted, and the counts are compared against what the manifest claimed at
 * backup time. The live database is never touched, so verification is safe to
 * run at any time — including on a schedule.
 */
export interface ScratchDb {
  name: string;
  url: string;
  drop(): Promise<void>;
}

export async function createScratchDb(): Promise<ScratchDb> {
  // Suffix, not caller-supplied name: this string is interpolated into DDL,
  // where identifiers cannot be parameterised.
  const name = `marlin_verify_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  if (!/^[a-z0-9_]{1,63}$/.test(name)) throw new Error("Generated an unsafe database name.");

  await pool.query(`CREATE DATABASE ${name}`);

  return {
    name,
    url: urlForDatabase(name),
    async drop() {
      // Sessions opened by pg_restore may linger a moment; terminate them so the
      // drop cannot fail and leak a database.
      await pool
        .query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [name],
        )
        .catch(() => {});
      await pool.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    },
  };
}

/**
 * Remove verification databases stranded by a crash.
 *
 * Without this, a process killed mid-verify would leave a full copy of the ERP
 * behind on the server, permanently.
 */
export async function dropStaleScratchDbs(): Promise<number> {
  const { rows } = await pool.query<{ datname: string }>(
    `SELECT datname FROM pg_database
      WHERE datname LIKE 'marlin_verify_%'
        AND NOT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = pg_database.datname)`,
  );
  let dropped = 0;
  for (const r of rows) {
    if (!/^marlin_verify_[a-z0-9_]+$/.test(r.datname)) continue;
    try {
      await pool.query(`DROP DATABASE IF EXISTS ${r.datname}`);
      dropped++;
    } catch {
      /* still in use — the next sweep gets it */
    }
  }
  return dropped;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fingerprints and counts
// ─────────────────────────────────────────────────────────────────────────────

/** `pg_dump --version` style string for the dashboard's Database Version tile. */
export async function serverVersion(): Promise<string> {
  const { rows } = await pool.query<{ v: string }>(`SELECT current_setting('server_version') AS v`);
  return rows[0]?.v ?? "unknown";
}

/**
 * A stable hash of the schema's shape.
 *
 * Compared before a restore so an administrator is told when an archive was
 * taken from a materially different version of the ERP. It intentionally covers
 * only names and types — not row data and not physical layout — so a routine
 * backup/restore round trip fingerprints identically.
 */
export async function schemaFingerprint(client: { query: Function } = pool): Promise<string> {
  const { rows } = await client.query(
    // Scoped to `public`, which is exactly what the dumps contain now that the
    // catalogue lives in its own schema. The fingerprint has to describe the same
    // set of objects the dump carries, or it could never match the copy a restore
    // produces and the structure check would fail on every archive while nothing
    // was actually wrong.
    `SELECT table_name, column_name, data_type, is_nullable, coalesce(column_default,'') AS d
       FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, column_name`,
  );
  const canonical = rows
    .map((r: any) => `${r.table_name}.${r.column_name}:${r.data_type}:${r.is_nullable}:${r.d}`)
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

export interface TableCount {
  table: string;
  rows: number;
}

/**
 * Exact row counts for every public table.
 *
 * `COUNT(*)` per table rather than `pg_class.reltuples`: the estimate drifts
 * between vacuums, and a verification that compares estimates would report
 * false mismatches on a healthy backup.
 */
export async function tableCounts(client: { query: Function } = pool): Promise<TableCount[]> {
  const { rows: tables } = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  );
  const out: TableCount[] = [];
  for (const t of tables as Array<{ table_name: string }>) {
    if (!/^[a-z0-9_]+$/i.test(t.table_name)) continue; // identifiers cannot be bound
    const { rows } = await client.query(`SELECT count(*)::bigint AS c FROM public."${t.table_name}"`);
    out.push({ table: t.table_name, rows: Number(rows[0].c) });
  }
  return out;
}

export async function databaseSizeBytes(): Promise<number> {
  const { rows } = await pool.query<{ s: string }>(
    `SELECT pg_database_size(current_database())::bigint AS s`,
  );
  return Number(rows[0]?.s ?? 0);
}
