/** Input normalisation for the columns that are real Postgres DATE columns.
 *
 *  Reads need nothing: lib/db registers a type parser for DATE (oid 1082) that
 *  hands back a plain 'YYYY-MM-DD' string, so every response body and every
 *  `String(row.some_date).slice(0, 10)` behaves exactly as it did when these
 *  columns were text.
 *
 *  Writes DO need care. Postgres rejects '' for a DATE parameter with 22007
 *  ("invalid input syntax for type date"), where a text column accepted it
 *  silently. A blank therefore has to become either NULL (nullable column) or
 *  a 400 (NOT NULL column) — never a 500 from the driver. It also rejects
 *  impossible dates such as '2026-02-30', which a text column stored happily.
 */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True only for a real calendar date in YYYY-MM-DD form ('2026-02-30' is not). */
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !ISO_DATE_RE.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
  );
}

/** Blank/absent -> null, otherwise the trimmed value. Use for nullable DATE
 *  columns so an empty form field stores NULL instead of raising 22007. */
export function dateOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** For a nullable DATE column fed from a request body: blank -> null, a real
 *  date -> itself, anything else -> `ok: false` so the caller can answer 400
 *  instead of letting the driver raise 22007 mid-transaction. */
export function optionalIsoDate(
  v: unknown,
): { ok: true; value: string | null } | { ok: false } {
  const s = dateOrNull(v);
  if (s === null) return { ok: true, value: null };
  return isIsoDate(s) ? { ok: true, value: s } : { ok: false };
}
