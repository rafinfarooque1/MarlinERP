/**
 * Opt-in paging for list endpoints.
 *
 * These endpoints return a bare JSON array and the frontend consumes them
 * wholesale — an attendance month view, a payroll run, a customer dropdown.
 * So paging must never apply unless the caller explicitly asks for it: a
 * default page size would silently drop rows off the end of screens that
 * currently work, which is worse than no paging at all.
 *
 * Paging metadata travels in headers so the response shape stays an array.
 */
export const PAGE_MAX = 500;

export interface Paging {
  /** Number of rows to return. Infinity when the caller did not ask to page. */
  limit: number;
  offset: number;
  /** True only when the caller passed ?limit= or ?offset=. */
  requested: boolean;
}

export function parsePaging(query: Record<string, unknown>): Paging {
  const hasLimit = query.limit !== undefined && query.limit !== "";
  const hasOffset = query.offset !== undefined && query.offset !== "";
  if (!hasLimit && !hasOffset) return { limit: Infinity, offset: 0, requested: false };

  const rawLimit = Number(query.limit);
  const rawOffset = Number(query.offset);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), PAGE_MAX)
    : PAGE_MAX;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
  return { limit, offset, requested: true };
}

export function setPagingHeaders(
  res: { setHeader: (k: string, v: string) => void },
  total: number,
  paging: Paging,
): void {
  res.setHeader("X-Total-Count", String(total));
  res.setHeader("X-Limit", String(Number.isFinite(paging.limit) ? paging.limit : total));
  res.setHeader("X-Offset", String(paging.offset));
}

/** Applies the window, and is a no-op when the caller did not ask to page. */
export function applyPaging<T>(rows: T[], paging: Paging): T[] {
  if (!paging.requested) return rows;
  return rows.slice(paging.offset, paging.offset + paging.limit);
}
