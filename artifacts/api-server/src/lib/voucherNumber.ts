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
  const serial = await nextScopedSerial(q, SALES_SERIES[series].counter, scope, fyLabel);
  return {
    invoiceNumber: salesInvoiceNumber(series, fyLabel, serial),
    numberScope: scope,
    seriesPrefix: SALES_SERIES[series].prefix,
    fyLabel,
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
