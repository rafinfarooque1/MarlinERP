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
 * Allocate the next sales bill number for a series, scoped to the financial
 * year of the sale date AND the billing location — every location keeps an
 * independent running serial (Head Office numbering never advances a
 * warehouse's, and a new location starts at 000001 automatically because its
 * counter row simply doesn't exist yet). The printed format stays clean
 * (SB2C/2026-27/000001, no location code); the location is identity the ERP
 * tracks internally via the sale row's location columns.
 *
 * The atomic upsert row-locks the (series@scope, FY) counter row for the rest
 * of the transaction, so two tills billing concurrently at the same location
 * can never draw the same number — and a rolled-back sale rolls its number
 * back with it.
 *
 * MUST be called with the sale-creation transaction client so the counter
 * bump commits/rolls back atomically with the sale row itself.
 */
export async function nextSalesInvoiceNumber(
  q: Queryable,
  series: SalesSeries,
  saleDate: string | undefined,
  location: SaleLocation,
): Promise<string> {
  let fyStartMonth = 4;
  try {
    const { rows } = await q.query(`SELECT fy_start_month FROM company_settings LIMIT 1`);
    if (rows[0]) fyStartMonth = Number(rows[0].fy_start_month ?? 4) || 4;
  } catch {
    /* company_settings not migrated yet — Indian FY default */
  }
  const fyLabel = financialYearLabel(saleDate, fyStartMonth);
  const scope = await salesCounterScope(q, location);
  const { rows: [seq] } = await q.query(
    `INSERT INTO voucher_sequences (voucher_type, fy_label, last_number)
     VALUES ($1, $2, 1)
     ON CONFLICT (voucher_type, fy_label)
     DO UPDATE SET last_number = voucher_sequences.last_number + 1
     RETURNING last_number`,
    [`${SALES_SERIES[series].counter}@${scope}`, fyLabel]
  );
  return salesInvoiceNumber(series, fyLabel, Number(seq.last_number));
}
