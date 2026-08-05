/**
 * Legacy ERP backup handling — ZIP/DBF extraction and analysis.
 *
 * Old FoxPro/dBase-era ERPs back up as a ZIP of .DBF tables (sometimes with
 * .FPT/.DBT memo companions). This module extracts such an archive IN-PROCESS
 * (unzipper — the deployed runtime has no zip/unzip CLIs), parses each DBF's
 * header for structure and counts, and classifies tables by name/field
 * heuristics so the UI can show "what's inside" before anything is imported.
 *
 * Extraction sessions live under /tmp/legacy-imports/<id>/ — transient by
 * design. A server restart or redeploy discards them; the user re-uploads.
 * Nothing here writes to business tables: the import itself (a later step)
 * goes through the existing import-batch machinery so history, rollback and
 * manual-entry business logic are shared.
 *
 * ZIP passwords: legacy backups use ZipCrypto, which unzipper decrypts. The
 * password is used once, for extraction, and never persisted — the decrypted
 * DBF files on disk are what later steps read. AES-encrypted ZIPs (rare for
 * these old tools) fail with a clear message.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { Open as unzipOpen } from "unzipper";
import { DBFFile } from "dbffile";

export const LEGACY_IMPORT_ROOT = "/tmp/legacy-imports";

// Archive/session hard limits. The HTTP body cap (200 MB) constrains only the
// COMPRESSED upload — a ZIP bomb can declare and inflate far more, and entries
// are materialized in memory one at a time. Cap entry count, per-entry bytes
// and the whole session's on-disk footprint.
export const MAX_ARCHIVE_ENTRIES = 500;
export const MAX_ENTRY_BYTES = 256 * 1024 * 1024; // 256 MB per DBF/memo
export const MAX_SESSION_BYTES = 1024 * 1024 * 1024; // 1 GB per session on disk
/** Sessions are transient; anything older than this is swept opportunistically. */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** What a table most likely holds, guessed from its name and fields. */
export type TableGuess =
  | "company" | "customers" | "vendors" | "items" | "ledgers" | "stock"
  | "sales" | "purchases" | "sales_returns" | "purchase_returns"
  | "receipts" | "payments" | "journal" | "opening_balances" | "unknown";

export interface DbfFieldInfo { name: string; type: string; size: number; decimals: number }

export interface LegacyTableInfo {
  /** Table name as shown to the user (file name without extension, uppercased). */
  name: string;
  /** File name on disk inside the session dir. */
  fileName: string;
  recordCount: number;
  /** DBF header's last-update date (YYYY-MM-DD) — a good proxy for backup date. */
  lastUpdate: string | null;
  fields: DbfFieldInfo[];
  guess: TableGuess;
  /** Set when the file could not be parsed as a DBF. */
  parseError?: string;
}

export interface LegacyAnalysis {
  companyName: string | null;
  backupDate: string | null;
  tables: LegacyTableInfo[];
  /** Record totals per classified bucket (tables with parse errors excluded). */
  summary: Partial<Record<Exclude<TableGuess, "unknown" | "company">, number>>;
  unknownTables: number;
}

export interface LegacySessionMeta {
  dirId: string;
  originalFileName: string;
  createdBy: string;
  /** Owning employee id — every session route must verify this (sessions are personal). */
  createdById: number;
  createdAt: string;
  status: "password_required" | "ready" | "failed";
  analysis?: LegacyAnalysis;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// DBF header parsing (analysis only — row reads go through dbffile)
// ─────────────────────────────────────────────────────────────────────────────

/** Known DBF version bytes: dBase III/IV/V, FoxBASE, FoxPro, Visual FoxPro. */
const DBF_VERSIONS = new Set([0x02, 0x03, 0x04, 0x05, 0x30, 0x31, 0x43, 0x63, 0x7b, 0x83, 0x8b, 0x8e, 0xcb, 0xf5, 0xfb]);

export function looksLikeDbf(buf: Buffer): boolean {
  if (buf.length < 68) return false;
  if (!DBF_VERSIONS.has(buf[0])) return false;
  const headerLen = buf.readUInt16LE(8);
  const recordLen = buf.readUInt16LE(10);
  return headerLen >= 65 && headerLen <= buf.length && recordLen > 0;
}

export function parseDbfHeader(buf: Buffer): { recordCount: number; lastUpdate: string | null; fields: DbfFieldInfo[] } {
  if (!looksLikeDbf(buf)) throw new Error("Not a valid DBF file");
  const recordCount = buf.readUInt32LE(4);
  const headerLen = buf.readUInt16LE(8);

  // Bytes 1-3: last update as YY MM DD. Per the DBF spec YY is ALWAYS years
  // since 1900 (FoxPro writes 125 for 2025) — never reinterpret small values
  // as 2000s. Implausible results (garbage headers) are reported as unknown.
  let lastUpdate: string | null = null;
  const yy = buf[1], mm = buf[2], dd = buf[3];
  if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
    const year = 1900 + yy;
    if (year >= 1980 && year <= 2100) {
      lastUpdate = `${year}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    }
  }

  const fields: DbfFieldInfo[] = [];
  for (let off = 32; off + 32 <= headerLen && off + 32 <= buf.length; off += 32) {
    if (buf[off] === 0x0d) break; // field descriptor terminator
    const rawName = buf.subarray(off, off + 11);
    const zero = rawName.indexOf(0);
    const name = rawName.subarray(0, zero === -1 ? 11 : zero).toString("latin1").trim();
    if (!name) break;
    fields.push({
      name,
      type: String.fromCharCode(buf[off + 11]),
      size: buf[off + 16],
      decimals: buf[off + 17],
    });
  }
  return { recordCount, lastUpdate, fields };
}

// ─────────────────────────────────────────────────────────────────────────────
// Classification heuristics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Guess what a legacy table holds. Name patterns first (most reliable across
 * FoxPro-era Indian ERPs), then field-shape hints. Order matters: returns
 * before sales/purchases ("SALERET" contains "SALE"), specific before generic.
 */
export function classifyTable(name: string, fields: DbfFieldInfo[]): TableGuess {
  const n = name.toUpperCase().replace(/\.[A-Z0-9]+$/, "");
  const F = new Set(fields.map((f) => f.name.toUpperCase()));
  const hasAny = (...names: string[]) => names.some((x) => F.has(x));

  if (/COMPANY|COMPINFO|FIRM|PROFILE|CMPMAST|COMP$|^SETUP|^CONFIG/.test(n)) return "company";
  if (/OPBAL|OPENBAL|OPENING|^OB[_A-Z0-9]*$/.test(n)) return "opening_balances";
  if (/SRET|SALERET|SALESRET|CRNOTE|CREDITN|CRDNOTE/.test(n)) return "sales_returns";
  if (/PRET|PURRET|PURCRET|DRNOTE|DEBITN|DBTNOTE/.test(n)) return "purchase_returns";
  if (/RCPT|RECEIPT|RECPT/.test(n)) return "receipts";
  if (/PAYMENT|PYMT|PAYMNT|^PAY[_A-Z0-9]*$/.test(n)) return "payments";
  if (/JOURNAL|JRNL|^JV|VOUCHER|VCHR|CONTRA/.test(n)) return "journal";
  if (/CUST|DEBTOR|BUYER/.test(n)) return "customers";
  if (/VEND|SUPP|CREDITOR/.test(n)) return "vendors";
  if (/LEDGER|LEDG|ACCMAST|ACCTMAST|ACMAST|^COA|ACCOUNT/.test(n)) return "ledgers";
  if (/ITEMMAST|ITMMAST|STKMAST|PRODMAST|^ITEM|^ITM|PRODUCT|^SKU/.test(n)) return "items";
  if (/^STOCK|^STK|INVENT|GODOWN/.test(n)) return "stock";
  if (/SALE|SINV|^INV[_A-Z0-9]*$|BILLING|^BILL/.test(n)) return "sales";
  if (/PURCH|^PUR|PINV|^GRN/.test(n)) return "purchases";
  if (/^TRAN|^TRN|DAYBOOK/.test(n)) return "journal";

  // Field-shape fallbacks — weaker, only when the name says nothing.
  if (hasAny("GSTIN", "GST_NO", "GSTNO", "TINNO") && hasAny("NAME", "PNAME", "PARTYNAME")) return "customers";
  if (hasAny("DEBIT", "CREDIT") || (hasAny("DRAMT", "CRAMT"))) return "journal";
  if (hasAny("QTY", "QUANTITY") && hasAny("RATE", "PRICE") && hasAny("ITEM", "ITEMCODE", "ICODE", "ITEMNAME")) return "sales";
  return "unknown";
}

// ─────────────────────────────────────────────────────────────────────────────
// Extraction
// ─────────────────────────────────────────────────────────────────────────────

const isDbfName = (p: string) => /\.dbf$/i.test(p);
const isMemoName = (p: string) => /\.(fpt|dbt)$/i.test(p);

/** Errors unzipper raises for encrypted entries. */
const isMissingPassword = (e: unknown) => /MISSING_PASSWORD/i.test(String((e as Error)?.message ?? e));
const isBadPassword = (e: unknown) => /BAD_PASSWORD|invalid signature|MISSING_PASSWORD/i.test(String((e as Error)?.message ?? e));

export class PasswordRequiredError extends Error { constructor() { super("password_required"); } }
export class WrongPasswordError extends Error { constructor() { super("wrong_password"); } }

/** A safe on-disk file name from an archive entry path. */
function safeMemberName(entryPath: string): string {
  const base = path.basename(entryPath).replace(/[^A-Za-z0-9._-]/g, "_");
  return base || "table.dbf";
}

/**
 * Extract every DBF (and memo companion) from an uploaded backup into dir.
 * Accepts a ZIP or a bare DBF. Throws PasswordRequiredError /
 * WrongPasswordError for encrypted archives.
 */
export async function extractBackupToDir(
  upload: Buffer, originalName: string, dir: string, password?: string,
): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const written: string[] = [];
  // Seed name-collision tracking from what's already on disk so a second
  // upload can never silently overwrite a same-named table from the first.
  const seen = new Set<string>((await readdir(dir).catch(() => [] as string[])).map((n) => n.toLowerCase()));

  if (looksLikeDbf(upload)) {
    const name = safeMemberName(isDbfName(originalName) ? originalName : `${originalName}.dbf`);
    await writeFile(path.join(dir, name), upload);
    return [name];
  }

  let dirIndex;
  try {
    dirIndex = await unzipOpen.buffer(upload);
  } catch {
    throw new Error("That file is neither a ZIP archive nor a DBF table. Upload the legacy ERP backup ZIP.");
  }

  const wanted = dirIndex.files.filter(
    (f: any) => f.type !== "Directory" && (isDbfName(f.path) || isMemoName(f.path)),
  );
  if (wanted.length === 0) {
    throw new Error("The ZIP was read, but no DBF tables were found inside it.");
  }
  if (wanted.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error(`The ZIP contains ${wanted.length} tables — more than the ${MAX_ARCHIVE_ENTRIES} this import supports in one backup.`);
  }
  // Bomb check on DECLARED sizes first (cheap), re-checked on actual bytes
  // below — a lying central directory doesn't get to inflate past the caps.
  let declaredTotal = 0;
  for (const f of wanted) {
    const sz = Number((f as any).uncompressedSize ?? 0);
    if (sz > MAX_ENTRY_BYTES) throw new Error(`"${f.path}" is larger than the ${Math.round(MAX_ENTRY_BYTES / 1048576)} MB per-table limit.`);
    declaredTotal += sz;
  }
  if (declaredTotal > MAX_SESSION_BYTES) {
    throw new Error(`This backup unpacks to more than the ${Math.round(MAX_SESSION_BYTES / 1048576)} MB limit.`);
  }

  let actualTotal = 0;
  for (const f of wanted) {
    let buf: Buffer;
    try {
      buf = password ? await f.buffer(password) : await f.buffer();
    } catch (e) {
      if (!password && isMissingPassword(e)) throw new PasswordRequiredError();
      if (password && isBadPassword(e)) throw new WrongPasswordError();
      throw new Error(`Could not extract "${f.path}" from the ZIP${password ? " (is the archive AES-encrypted? Only standard ZIP passwords are supported)" : ""}.`);
    }
    actualTotal += buf.length;
    if (buf.length > MAX_ENTRY_BYTES || actualTotal > MAX_SESSION_BYTES) {
      throw new Error("This backup unpacks to more than this import supports in one session.");
    }
    // ZipCrypto has only a 1-byte checksum — a wrong password often "succeeds"
    // and yields garbage. A DBF member that doesn't parse as DBF is the tell.
    if (password && isDbfName(f.path) && !looksLikeDbf(buf)) throw new WrongPasswordError();
    let name = safeMemberName(f.path);
    while (seen.has(name.toLowerCase())) name = `_${name}`;
    seen.add(name.toLowerCase());
    await writeFile(path.join(dir, name), buf);
    written.push(name);
  }
  return written;
}

// ─────────────────────────────────────────────────────────────────────────────
// Analysis
// ─────────────────────────────────────────────────────────────────────────────

/** Field names that most likely hold a company/party display name. */
const NAME_FIELD = /^(C?NAME|COMPANY|COMPNAME|CO_NAME|FIRMNAME|FIRM|CMPNAME|NAME1?)$/i;

async function detectCompanyName(dir: string, table: LegacyTableInfo): Promise<string | null> {
  try {
    const dbf = await DBFFile.open(path.join(dir, table.fileName), { readMode: "loose" } as any);
    const rows = await dbf.readRecords(1);
    if (rows.length === 0) return null;
    const row = rows[0] as Record<string, unknown>;
    const fields = Object.keys(row);
    const named = fields.find((f) => NAME_FIELD.test(f));
    const val = (f: string) => String(row[f] ?? "").trim();
    if (named && val(named).length > 2) return val(named);
    // Longest text value in the first row — company tables are single-row.
    let best = "";
    for (const f of fields) {
      const v = val(f);
      if (v.length > best.length && /[A-Za-z]/.test(v)) best = v;
    }
    return best.length > 2 ? best : null;
  } catch {
    return null;
  }
}

/** Parse + classify every extracted DBF in a session dir. */
export async function analyzeSessionDir(dir: string): Promise<LegacyAnalysis> {
  const names = (await readdir(dir)).filter(isDbfName).sort();
  const tables: LegacyTableInfo[] = [];

  for (const fileName of names) {
    const display = fileName.replace(/\.dbf$/i, "").toUpperCase();
    try {
      const buf = await readFile(path.join(dir, fileName));
      const { recordCount, lastUpdate, fields } = parseDbfHeader(buf);
      tables.push({
        name: display, fileName, recordCount, lastUpdate, fields,
        guess: classifyTable(display, fields),
      });
    } catch (e) {
      tables.push({
        name: display, fileName, recordCount: 0, lastUpdate: null, fields: [],
        guess: "unknown", parseError: (e as Error).message,
      });
    }
  }

  const summary: LegacyAnalysis["summary"] = {};
  for (const t of tables) {
    if (t.parseError || t.guess === "unknown" || t.guess === "company") continue;
    summary[t.guess] = (summary[t.guess] ?? 0) + t.recordCount;
  }

  let backupDate: string | null = null;
  for (const t of tables) {
    if (t.lastUpdate && (!backupDate || t.lastUpdate > backupDate)) backupDate = t.lastUpdate;
  }

  const companyTable = tables.find((t) => t.guess === "company" && !t.parseError);
  const companyName = companyTable ? await detectCompanyName(dir, companyTable) : null;

  return {
    companyName, backupDate, tables, summary,
    unknownTables: tables.filter((t) => t.guess === "unknown").length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Session storage
// ─────────────────────────────────────────────────────────────────────────────

export function newSessionDirId(): string {
  return randomBytes(12).toString("hex");
}

/**
 * Session ids are exactly 24 lowercase hex chars. EVERY route must check this
 * BEFORE any filesystem call — a traversal value in :id would otherwise reach
 * path.join (and, worst of all, the recursive rm in discard).
 */
export const isValidDirId = (dirId: string): boolean => /^[0-9a-f]{24}$/.test(dirId);

export const sessionDir = (dirId: string) => {
  if (!isValidDirId(dirId)) throw new Error("Invalid session id");
  return path.join(LEGACY_IMPORT_ROOT, dirId);
};

// Per-session serialization: unlock/add-file mutate the same directory and
// meta.json; concurrent requests must queue, not interleave.
const sessionChains = new Map<string, Promise<unknown>>();
export async function withSessionLock<T>(dirId: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionChains.get(dirId) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  sessionChains.set(dirId, tail);
  try {
    return await run;
  } finally {
    // Drop the map entry once this chain is the tail (bounded memory).
    if (sessionChains.get(dirId) === tail) sessionChains.delete(dirId);
  }
}

/** Total bytes currently stored for a session (extracted files + original). */
export async function sessionSizeBytes(dirId: string): Promise<number> {
  const dir = sessionDir(dirId);
  let total = 0;
  for (const n of await readdir(dir).catch(() => [] as string[])) {
    try { total += (await stat(path.join(dir, n))).size; } catch { /* raced delete */ }
  }
  return total;
}

/** Remove extracted files (keep __original__ + meta.json) before a re-extract. */
export async function clearExtracted(dirId: string): Promise<void> {
  const dir = sessionDir(dirId);
  for (const n of await readdir(dir).catch(() => [] as string[])) {
    if (n === "__original__" || n === "meta.json") continue;
    await rm(path.join(dir, n), { force: true });
  }
}

/**
 * Opportunistic TTL sweep — called on each new upload, so abandoned sessions
 * can't accumulate in /tmp. No timer: uploads are the only thing that grows
 * the footprint, so they're the right moment to shrink it.
 */
export async function sweepExpiredSessions(maxAgeMs: number = SESSION_TTL_MS): Promise<void> {
  const now = Date.now();
  for (const n of await readdir(LEGACY_IMPORT_ROOT).catch(() => [] as string[])) {
    if (!isValidDirId(n)) continue;
    try {
      const st = await stat(path.join(LEGACY_IMPORT_ROOT, n, "meta.json"));
      if (now - st.mtimeMs > maxAgeMs) await rm(path.join(LEGACY_IMPORT_ROOT, n), { recursive: true, force: true });
    } catch {
      // No meta.json — a half-created dir. Judge age by the dir itself.
      try {
        const st = await stat(path.join(LEGACY_IMPORT_ROOT, n));
        if (now - st.mtimeMs > maxAgeMs) await rm(path.join(LEGACY_IMPORT_ROOT, n), { recursive: true, force: true });
      } catch { /* raced delete */ }
    }
  }
}

export async function saveMeta(dirId: string, meta: LegacySessionMeta): Promise<void> {
  await mkdir(sessionDir(dirId), { recursive: true });
  await writeFile(path.join(sessionDir(dirId), "meta.json"), JSON.stringify(meta, null, 2));
}

export async function loadMeta(dirId: string): Promise<LegacySessionMeta | null> {
  try {
    return JSON.parse(await readFile(path.join(sessionDir(dirId), "meta.json"), "utf8"));
  } catch {
    return null;
  }
}

export function sessionExists(dirId: string): boolean {
  return existsSync(path.join(sessionDir(dirId), "meta.json"));
}

export async function discardSession(dirId: string): Promise<void> {
  await rm(sessionDir(dirId), { recursive: true, force: true });
}

/** Read sample rows from an extracted table (deleted rows are skipped by dbffile). */
export async function readTableRows(
  dirId: string, fileName: string, limit: number,
): Promise<Array<Record<string, unknown>>> {
  const dbf = await DBFFile.open(path.join(sessionDir(dirId), fileName), { readMode: "loose" } as any);
  const rows = await dbf.readRecords(Math.max(1, Math.min(limit, 200)));
  return rows as Array<Record<string, unknown>>;
}
