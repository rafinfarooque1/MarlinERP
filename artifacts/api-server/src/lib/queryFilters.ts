/**
 * Shared request-filter helpers: date range + location narrowing.
 *
 * Every list endpoint takes the same optional query params:
 *   from, to                — YYYY-MM-DD, inclusive
 *   locationType, locationId — a single location to narrow to
 *
 * The location filter is a VIEW request, never authority. Routes must keep
 * applying their LBAC scope condition (scope*Where from dataScope.ts /
 * moneyScope.ts) unconditionally — these conds are ANDed on top, so a
 * client-supplied filter can only narrow what the caller may already see,
 * never widen it.
 */
import { isIsoDate } from "./dateInput";

// ── Date range ────────────────────────────────────────────────────────────────

export type ParsedDateRange =
  | { ok: true; from: string; to: string }
  | { ok: false; error: string };

/** Parse and validate optional `from`/`to` (YYYY-MM-DD). '' = unbounded. */
export function parseDateRange(query: Record<string, unknown>): ParsedDateRange {
  const from = typeof query.from === "string" ? query.from : "";
  const to = typeof query.to === "string" ? query.to : "";
  if ((from && !isIsoDate(from)) || (to && !isIsoDate(to))) {
    return { ok: false, error: "from/to must be YYYY-MM-DD dates" };
  }
  return { ok: true, from, to };
}

/**
 * Push inclusive date-range conditions for `colExpr` (a DATE-typed column or
 * expression, e.g. `p.purchase_date`).
 */
export function pushDateRange(
  conds: string[],
  params: unknown[],
  colExpr: string,
  from: string,
  to: string,
): void {
  if (from) { params.push(from); conds.push(`${colExpr} >= $${params.length}::date`); }
  if (to)   { params.push(to);   conds.push(`${colExpr} <= $${params.length}::date`); }
}

// ── Location filter ───────────────────────────────────────────────────────────

export type LocationTypeParam = "warehouse" | "outlet" | "headoffice";

export interface ParsedLocationFilter {
  locationType: LocationTypeParam;
  locationId: number;
}

/**
 * Parse optional `locationType`/`locationId`. Returns null when absent or
 * malformed — an unusable filter falls back to "no narrowing" (the LBAC scope
 * still applies), it never errors a list the user could otherwise see.
 *
 * Head Office is singular, so `headoffice` needs no id (and any supplied id
 * is ignored — tables disagree on the HO placeholder id: some use 1, some 0).
 */
export function parseLocationFilter(query: Record<string, unknown>): ParsedLocationFilter | null {
  const lt = query.locationType;
  if (lt === "headoffice") return { locationType: lt, locationId: 0 };
  const lid = Number(query.locationId);
  if ((lt === "warehouse" || lt === "outlet") && Number.isFinite(lid) && lid > 0) {
    return { locationType: lt, locationId: lid };
  }
  return null;
}

/**
 * Push equality conditions for a parsed location filter.
 *
 * `typeExpr`/`idExpr` are SQL expressions for the row's location identity —
 * callers pass the COALESCE form their table needs (legacy rows predate the
 * location columns), e.g. `COALESCE(s.location_type,'outlet')`.
 *
 * Head Office matches on type alone: it is a single place, and the id
 * placeholder its rows carry varies by table (1 in some, 0 in others), so an
 * id equality would silently drop valid HO rows.
 */
export function pushLocationFilter(
  conds: string[],
  params: unknown[],
  filter: ParsedLocationFilter | null,
  typeExpr: string,
  idExpr: string,
): void {
  if (!filter) return;
  params.push(filter.locationType);
  conds.push(`${typeExpr} = $${params.length}`);
  if (filter.locationType === "headoffice") return;
  params.push(filter.locationId);
  conds.push(`${idExpr} = $${params.length}`);
}
