import { pool } from "@workspace/db";

/** Anything with a .query(text, params) method — pg Pool or a transaction PoolClient. */
export type Queryable = { query: (text: string, params?: any[]) => Promise<any> };

export const DEFAULT_VOUCHER_PREFIXES: Record<string, string> = {
  payment: "PAY",
  receipt: "REC",
  journal: "JV",
  contra: "CTR",
  credit_note: "CN",
  debit_note: "DN",
  sales_return: "SR",
  purchase_return: "PR",
  expense: "EXP",
};

/**
 * GST document series that print the SHORT number format — PREFIX/26-27/4
 * (short FY label, no zero padding) — matching the sales invoice format the
 * business standardised on in Aug 2026. Internal vouchers (payments,
 * receipts, journal, contra, expense) deliberately keep the long padded
 * format: the owner chose to convert customer/GST documents only.
 *
 * IMPORTANT: this changes only the PRINTED shape. The voucher_sequences row
 * stays keyed on the canonical long FY label ("2026-27"), so the running
 * serial continues exactly where it was — a format change must never reset
 * or fork a statutory sequence mid-year.
 */
export const SHORT_FORMAT_VOUCHER_TYPES: ReadonlySet<string> = new Set([
  "sales_return",
  "purchase_return",
  "credit_note",
  "debit_note",
]);

export const VOUCHER_TYPE_LABELS: Record<string, string> = {
  payment: "Payment",
  receipt: "Receipt",
  journal: "Journal",
  contra: "Contra",
  credit_note: "Credit Note",
  debit_note: "Debit Note",
  sales_return: "Sales Return",
  purchase_return: "Purchase Return",
};

/**
 * Compute the financial-year label for a voucher date.
 * fyStartMonth = 4 (April, Indian FY) → 2026-07-25 falls in "2026-27".
 * fyStartMonth = 1 (calendar year)    → 2026-07-25 falls in "2026".
 */
export function financialYearLabel(dateStr: string | undefined, fyStartMonth: number): string {
  const parsed = dateStr ? new Date(`${dateStr}T00:00:00`) : new Date();
  const d = isNaN(parsed.getTime()) ? new Date() : parsed;
  const month = d.getMonth() + 1;
  const year = d.getFullYear();
  const startYear = month >= fyStartMonth ? year : year - 1;
  if (fyStartMonth === 1) return String(startYear);
  const endYY = String((startYear + 1) % 100).padStart(2, "0");
  return `${startYear}-${endYY}`;
}

/**
 * Allocate the next voucher number for a type, scoped to the financial year of
 * the voucher date. Uses an atomic upsert on voucher_sequences so concurrent
 * requests can never produce duplicate numbers (unlike COUNT(*)-based schemes,
 * which also break after deletions).
 *
 * Pass the transaction client when calling inside a transaction so the
 * sequence bump commits/rolls back atomically with the voucher itself.
 *
 * Format: PREFIX/FY-LABEL/NNNN e.g. "JV/2026-27/0001".
 */
export async function nextVoucherNumber(
  q: Queryable | null,
  voucherType: string,
  voucherDate?: string,
): Promise<string> {
  const db = q ?? pool;

  let fyStartMonth = 4;
  let prefixes: Record<string, string> = {};
  try {
    const { rows } = await db.query(
      `SELECT fy_start_month, voucher_prefixes FROM company_settings LIMIT 1`
    );
    if (rows[0]) {
      fyStartMonth = Number(rows[0].fy_start_month ?? 4) || 4;
      if (rows[0].voucher_prefixes && typeof rows[0].voucher_prefixes === "object") {
        prefixes = rows[0].voucher_prefixes as Record<string, string>;
      }
    }
  } catch {
    /* company_settings not migrated yet — fall back to defaults */
  }

  const prefix = String(
    prefixes[voucherType] || DEFAULT_VOUCHER_PREFIXES[voucherType] || voucherType.toUpperCase()
  ).trim() || DEFAULT_VOUCHER_PREFIXES[voucherType] || "VCH";
  const fyLabel = financialYearLabel(voucherDate, fyStartMonth);

  const { rows: [seq] } = await db.query(
    `INSERT INTO voucher_sequences (voucher_type, fy_label, last_number)
     VALUES ($1, $2, 1)
     ON CONFLICT (voucher_type, fy_label)
     DO UPDATE SET last_number = voucher_sequences.last_number + 1
     RETURNING last_number`,
    [voucherType, fyLabel]
  );

  // GST document series print short — SR/26-27/5 — but the sequence row above
  // is ALWAYS keyed on the long label, so the serial never resets on a format
  // change. Internal vouchers keep the long padded shape.
  if (SHORT_FORMAT_VOUCHER_TYPES.has(voucherType)) {
    return `${prefix}/${shortFyLabel(fyLabel)}/${String(seq.last_number)}`;
  }
  return `${prefix}/${fyLabel}/${String(seq.last_number).padStart(4, "0")}`;
}

// ── Sales bill series (SB2B / SB2C) ──────────────────────────────────────────
//
// Sales bills run on TWO independent FY-scoped series, decided by the
// customer's GST registration at billing time:
//   SB2B/2026-27/000001 — customer holds a GST number (business-to-business)
//   SB2C/2026-27/000001 — walk-in / retail / unregistered (business-to-consumer)
//
// The counters live in voucher_sequences under the names below, scoped to the
// financial year, so each FY restarts both series at 000001. Only SALES bills
// use these — every other voucher type keeps its own numbering untouched.
export const SALES_SERIES = {
  b2b: { counter: "sales_invoice_counter_b2b", prefix: "SB2B" },
  b2c: { counter: "sales_invoice_counter_b2c", prefix: "SB2C" },
} as const;

export type SalesSeries = keyof typeof SALES_SERIES;

export function salesInvoiceNumber(series: SalesSeries, fyLabel: string, seq: number): string {
  return `${SALES_SERIES[series].prefix}/${fyLabel}/${String(seq).padStart(6, "0")}`;
}

// ── Per-location number FORMAT overrides ────────────────────────────────────
//
// The default printed shape is SB2C/2026-27/000001 (full FY label, 6-digit
// zero padding, serials restart every FY). A location migrated onto its old
// physical bill-book numbering (admin renumber operation) instead prints
// SB2C/26-27/7490 — short FY label, no padding, and ONE serial sequence that
// keeps counting across financial years ("continuous": the physical book
// never restarted in April, so neither does the migrated sequence).
//
// The override lives in sales_number_formats keyed on the folded counter
// scope. Every producer that prints or allocates a sales number must go
// through these helpers so the format can never fork between producers.
export type SalesNumberFormat = {
  /** Print the FY segment short — "26-27" instead of "2026-27". */
  fyShort: boolean;
  /** Zero-pad width for the serial segment; 0 = no padding. */
  pad: number;
  /** ONE running serial across financial years (never resets in April). */
  continuous: boolean;
};

export const DEFAULT_SALES_NUMBER_FORMAT: SalesNumberFormat = {
  fyShort: false,
  pad: 6,
  continuous: false,
};

/**
 * Per-scope allocation locks. Every producer that draws or rewrites sales
 * numbers for a scope participates: allocators and the B2C→B2B reclass take
 * the SHARED side (concurrent with each other), the admin renumber migration
 * takes the EXCLUSIVE side (blocks all of them for the scope, and only that
 * scope). Acquire this BEFORE any counter or sale row lock so the migration
 * can never end up in a lock cycle with a producer.
 */
export async function acquireSalesScopeLockShared(q: Queryable, scope: string): Promise<void> {
  await q.query(`SELECT pg_advisory_xact_lock_shared(hashtext('sales_scope:' || $1))`, [scope]);
}

export async function acquireSalesScopeLockExclusive(q: Queryable, scope: string): Promise<void> {
  await q.query(`SELECT pg_advisory_xact_lock(hashtext('sales_scope:' || $1))`, [scope]);
}

/** "2026-27" → "26-27". Idempotent — an already-short label passes through. */
export function shortFyLabel(fyLabel: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(fyLabel);
  return m ? `${m[1].slice(2)}-${m[2]}` : fyLabel;
}

/**
 * The fy_label the COUNTER row is keyed on. A continuous sequence uses one
 * fixed key ('ALL') so the same voucher_sequences row keeps counting across
 * FY rollovers; the printed FY segment still follows the sale date.
 */
export function salesCounterFyLabel(fmt: SalesNumberFormat, fyLabel: string): string {
  return fmt.continuous ? "ALL" : fyLabel;
}

export function formatSalesInvoiceNumber(
  series: SalesSeries,
  fyLabel: string,
  seq: number,
  fmt: SalesNumberFormat = DEFAULT_SALES_NUMBER_FORMAT,
): string {
  const fy = fmt.fyShort ? shortFyLabel(fyLabel) : fyLabel;
  const serial = fmt.pad > 0 ? String(seq).padStart(fmt.pad, "0") : String(seq);
  return `${SALES_SERIES[series].prefix}/${fy}/${serial}`;
}

/**
 * Load the number format for a counter scope. Missing row (or the table not
 * yet migrated) means the default format — overrides are strictly opt-in,
 * created only by the admin renumber operation.
 */
export async function getSalesNumberFormat(
  q: Queryable,
  scope: string,
): Promise<SalesNumberFormat> {
  try {
    const { rows: [row] } = await q.query(
      `SELECT fy_short, pad, continuous FROM sales_number_formats WHERE number_scope = $1`,
      [scope]
    );
    if (!row) return DEFAULT_SALES_NUMBER_FORMAT;
    return {
      fyShort: Boolean(row.fy_short),
      pad: Number(row.pad ?? 6),
      continuous: Boolean(row.continuous),
    };
  } catch {
    /* sales_number_formats not migrated yet — default format */
    return DEFAULT_SALES_NUMBER_FORMAT;
  }
}

/** The location a sale is billed from, as stamped on the sales row. */
export type SaleLocation = { type: string; id: number | null | undefined };

/**
 * Resolve the counter SCOPE for a sale location. Every location runs its own
 * independent numbering, so the counter row is keyed on this scope string.
 *
 * Rules (each guards a known trap):
 *  - Head office is ONE scope regardless of its placeholder id — HO's id
 *    convention differs per table (0 in vouchers, 1 in sales), so keying on
 *    the id would silently split HO into two sequences.
 *  - A mirror pair (an outlet row and a warehouse row for the SAME physical
 *    place, recognisable only by the shared cash_ledger_id) must draw from
 *    ONE counter, keyed on the warehouse identity. Otherwise the same shop
 *    would print two invoices carrying the same number, one entered under
 *    each identity, and the printed location name could not tell them apart.
 */
export async function salesCounterScope(
  q: Queryable,
  location: SaleLocation,
): Promise<string> {
  if (location.type === "headoffice") return "headoffice";
  const id = Number(location.id ?? 0);
  if (location.type === "outlet") {
    try {
      const { rows: [twin] } = await q.query(
        `SELECT w.id
           FROM outlets o
           JOIN warehouses w ON w.cash_ledger_id = o.cash_ledger_id
          WHERE o.id = $1 AND o.cash_ledger_id IS NOT NULL
          ORDER BY w.id LIMIT 1`,
        [id]
      );
      if (twin) return `warehouse:${Number(twin.id)}`;
    } catch {
      /* cash_ledger_id not migrated yet — fall through to the plain identity */
    }
  }
  return `${location.type}:${id}`;
}

/**
 * The generic per-location numbering primitive (the "sequence framework").
 *
 * Counter rows live in voucher_sequences with the location scope encoded in
 * the TEXT key — `<counterName>@<scope>` — because widening the table's
 * natural PK would strand every older ON CONFLICT target (see
 * migration-ddl-drift). The atomic upsert row-locks the (counter@scope, FY)
 * row for the rest of the transaction, so two users drawing concurrently at
 * the same location can never get the same serial — and a rolled-back
 * document rolls its serial back with it. A scope's FIRST draw starts at 1
 * (no counter row until first use), which is also how new locations
 * auto-initialise.
 *
 * Any future document type (purchase bills, receipts, payments, notes,
 * challans, quotations …) gets independent per-location numbering by calling
 * this with its own counter name and the location scope from
 * salesCounterScope() — no redesign needed.
 *
 * MUST be called with the document-creation transaction client so the counter
 * bump commits/rolls back atomically with the document row itself.
 */
export async function nextScopedSerial(
  q: Queryable,
  counterName: string,
  scope: string,
  fyLabel: string,
): Promise<number> {
  const { rows: [seq] } = await q.query(
    `INSERT INTO voucher_sequences (voucher_type, fy_label, last_number)
     VALUES ($1, $2, 1)
     ON CONFLICT (voucher_type, fy_label)
     DO UPDATE SET last_number = voucher_sequences.last_number + 1
     RETURNING last_number`,
    [`${counterName}@${scope}`, fyLabel]
  );
  return Number(seq.last_number);
}

/**
 * The internal identity of a numbered sale, stored on the row alongside the
 * printed number: (number_scope, invoice_series, invoice_fy, invoice_serial).
 * The DB enforces uniqueness on these PLAIN columns — no CASE expressions in
 * indexes (an expression index broke the publish-time schema diff, which
 * cannot reproduce CASE SQL faithfully).
 */
export type SalesNumberAllocation = {
  invoiceNumber: string;
  /** Folded location scope — 'headoffice' | 'warehouse:2' | 'outlet:5' … */
  numberScope: string;
  /** Printed series prefix — 'SB2B' | 'SB2C'. */
  seriesPrefix: string;
  fyLabel: string;
  serial: number;
};

/**
 * Allocate the next sales bill number for a series, scoped to the financial
 * year of the sale date AND the billing location — every location keeps an
 * independent running serial (Head Office numbering never advances a
 * warehouse's, and a new location starts at 000001 automatically because its
 * counter row simply doesn't exist yet). The printed format stays clean
 * (SB2C/2026-27/000001, no location code); the location identity is what the
 * ERP tracks internally via the columns stamped from this allocation.
 */
export async function allocateSalesInvoiceNumber(
  q: Queryable,
  series: SalesSeries,
  saleDate: string | undefined,
  location: SaleLocation,
): Promise<SalesNumberAllocation> {
  let fyStartMonth = 4;
  try {
    const { rows } = await q.query(`SELECT fy_start_month FROM company_settings LIMIT 1`);
    if (rows[0]) fyStartMonth = Number(rows[0].fy_start_month ?? 4) || 4;
  } catch {
    /* company_settings not migrated yet — Indian FY default */
  }
  const fyLabel = financialYearLabel(saleDate, fyStartMonth);
  const scope = await salesCounterScope(q, location);
  // SHARED scope lock: normal allocations never block each other (shared vs
  // shared is free), but the admin renumber migration takes the EXCLUSIVE
  // side of this same lock, so while a location's history is being rebuilt
  // no sale — whatever its FY — can draw a number at that scope and slip
  // past the migration in the old format. Held to end of transaction; a
  // non-transactional caller acquires and releases it within the statement.
  await acquireSalesScopeLockShared(q, scope);
  // Format override (admin renumber migration): decides the printed shape AND
  // which counter row issues the serial (continuous scopes never reset in
  // April — their counter is keyed 'ALL' instead of the FY label).
  const fmt = await getSalesNumberFormat(q, scope);
  const serial = await nextScopedSerial(
    q, SALES_SERIES[series].counter, scope, salesCounterFyLabel(fmt, fyLabel)
  );
  const printedFy = fmt.fyShort ? shortFyLabel(fyLabel) : fyLabel;
  return {
    invoiceNumber: formatSalesInvoiceNumber(series, fyLabel, serial, fmt),
    numberScope: scope,
    seriesPrefix: SALES_SERIES[series].prefix,
    // Stamped identity mirrors the PRINTED segments — invoice_fy must equal
    // what split_part(invoice_number,'/',2) yields, or the shape-driven boot
    // backfill and the identity unique index would disagree with the number.
    fyLabel: printedFy,
    serial,
  };
}

/** Back-compat wrapper — prefer allocateSalesInvoiceNumber + stampSaleNumberIdentity. */
export async function nextSalesInvoiceNumber(
  q: Queryable,
  series: SalesSeries,
  saleDate: string | undefined,
  location: SaleLocation,
): Promise<string> {
  return (await allocateSalesInvoiceNumber(q, series, saleDate, location)).invoiceNumber;
}

/**
 * Parse "PREFIX/FY/SERIAL" (e.g. SB2C/2026-27/000013, BTR/2026-27/0004) into
 * its identity parts. Returns null for anything that doesn't match — legacy
 * hand-shaped numbers keep NULL identity columns, they are never renumbered.
 */
export function parseDocNumberIdentity(
  invoiceNumber: string | null | undefined,
): { series: string; fyLabel: string; serial: number } | null {
  const m = /^([A-Z0-9]+)\/([^/]+)\/(\d+)$/.exec(String(invoiceNumber ?? "").trim());
  if (!m) return null;
  return { series: m[1], fyLabel: m[2], serial: Number(m[3]) };
}

/**
 * Stamp a sale row's internal number identity. Raw SQL on purpose: these are
 * raw-migration columns invisible to the drizzle schema, so they must be
 * written (and read) outside it. Same transaction as the INSERT, always.
 */
export async function stampSaleNumberIdentity(
  q: Queryable,
  saleId: number,
  ident: { numberScope: string; seriesPrefix?: string | null; fyLabel?: string | null; serial?: number | null },
): Promise<void> {
  await q.query(
    `UPDATE sales
        SET number_scope = $2, invoice_series = $3, invoice_fy = $4, invoice_serial = $5
      WHERE id = $1`,
    [saleId, ident.numberScope, ident.seriesPrefix ?? null, ident.fyLabel ?? null, ident.serial ?? null]
  );
}
