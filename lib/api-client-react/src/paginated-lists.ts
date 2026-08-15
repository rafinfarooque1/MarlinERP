import { useQuery, useInfiniteQuery } from '@tanstack/react-query';
import { customFetch } from './custom-fetch';
import type { Sale } from './generated/api.schemas';

/** Sale row as returned by GET /sales — the generated `Sale` type plus the
 * raw-column fields the endpoint enriches (location, payment status, dues). */
export type PaginatedSaleRow = Sale & {
  locationType?: 'warehouse' | 'outlet' | 'headoffice';
  locationId?: number;
  paymentStatus?: string;
  amountPaid?: number;
  balanceDue?: number;
  outletUpiId?: string;
  customerPhone?: string | null;
};

// ── Types ─────────────────────────────────────────────────────────────────────

/** Server pagination envelope returned when page/limit params are present. */
export interface Paginated<T> {
  total: number;
  page: number;
  limit: number;
  rows: T[];
}

export interface PaginatedSalesParams {
  page?: number;
  limit?: number;
  q?: string;
  from?: string;
  to?: string;
  /** 'headoffice' needs no locationId — the server matches on type alone. */
  locationType?: 'warehouse' | 'outlet' | 'headoffice';
  locationId?: number;
  /** Warehouse id — includes the warehouse itself plus its child outlets. */
  warehouseScope?: number;
  outletId?: number;
}

export interface PaginatedPurchaseRow {
  id: number;
  vendorId: number;
  purchaseDate: string;
  invoiceNumber: string | null;
  /** Date on the vendor's own invoice — null on bills recorded before the
   *  field existed (never backfilled). */
  vendorInvoiceDate: string | null;
  notes: string | null;
  createdAt: string;
  vendorName: string;
  totalAmount: number;
  taxTotal: number;
  discountTotal: number;
  roundOff: number;
  lineItems: any[];
}

export interface PaginatedStockRow {
  id: number;
  itemId: number;
  itemName: string;
  hsnCode: string;
  branchType: string;
  branchId: number;
  branchName: string;
  quantity: number;
  unit: string;
  reorderLevel: number;
  /**
   * Cost-derived fields are ABSENT — not zero — for callers without the
   * inventory-valuation right, so they are optional by design. Never render
   * one without checking `canViewValuation` on the envelope first.
   */
  costPrice?: number;
  avgCost?: number;
  stockValue?: number;
  /** Committed elsewhere (transfer in flight, unfulfilled order) — not sellable. */
  reserved: number;
  /** quantity − reserved: what can actually be promised to someone. */
  available: number;
  /** Judged on `available`, not `quantity`. */
  lowStock: boolean;
}

/**
 * The stock envelope carries the server's verdict on whether this caller may
 * see valuation, so the UI never has to guess from missing fields.
 */
export type PaginatedStock = Paginated<PaginatedStockRow> & { canViewValuation: boolean };

export interface PaginatedListParams {
  page?: number;
  limit?: number;
  q?: string;
}

/**
 * The global date + location filter every transactional list accepts.
 * Server-side the location filter only NARROWS the caller's LBAC scope —
 * it can never widen it.
 */
export interface DateLocationParams {
  /** Inclusive YYYY-MM-DD bounds; omit for unbounded. */
  from?: string;
  to?: string;
  /** 'headoffice' needs no locationId — the server matches on type alone. */
  locationType?: 'warehouse' | 'outlet' | 'headoffice';
  locationId?: number;
}

export interface PaginatedPurchasesParams extends PaginatedListParams, DateLocationParams {}

/** Serialize the shared date+location params onto a query string. Partial
 * dates (a date input mid-edit, including a year still being typed like
 * '0002-…') are dropped rather than shipped — the server would 400 the whole
 * list over a transient keystroke. */
export function appendDateLocationParams(qs: URLSearchParams, params?: DateLocationParams): void {
  const fullDate = (v?: string) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number(v.slice(0, 4)) >= 1000;
  if (fullDate(params?.from)) qs.set('from', params!.from!);
  if (fullDate(params?.to)) qs.set('to', params!.to!);
  if (params?.locationType === 'headoffice') {
    // Head Office is singular — its id is a per-table placeholder, so only
    // the type is sent and the server matches on it alone.
    qs.set('locationType', 'headoffice');
  } else if (params?.locationType && params?.locationId) {
    qs.set('locationType', params.locationType);
    qs.set('locationId', String(params.locationId));
  }
}

export interface PaginatedStockParams extends PaginatedListParams {
  branchType?: 'warehouse' | 'outlet';
  branchId?: number;
  materialType?: 'item' | 'material' | 'raw_material';
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

/** Server-paginated sales list (same row shape as useListSales). */
export function usePaginatedSales(params?: PaginatedSalesParams) {
  const qs = new URLSearchParams();
  qs.set('page', String(params?.page ?? 1));
  qs.set('limit', String(params?.limit ?? 25));
  if (params?.q) qs.set('q', params.q);
  if (params?.from) qs.set('from', params.from);
  if (params?.to) qs.set('to', params.to);
  if (params?.locationType === 'headoffice') {
    // Head Office is singular — the server matches on type alone.
    qs.set('locationType', 'headoffice');
  } else if (params?.locationType && params?.locationId) {
    qs.set('locationType', params.locationType);
    qs.set('locationId', String(params.locationId));
  }
  if (params?.warehouseScope) qs.set('warehouseScope', String(params.warehouseScope));
  if (params?.outletId) qs.set('outletId', String(params.outletId));
  const key = qs.toString();
  return useQuery({
    queryKey: ['/api/sales', 'paginated', key] as const,
    queryFn: ({ signal }) =>
      customFetch<Paginated<PaginatedSaleRow>>(`/api/sales?${key}`, { signal }),
    placeholderData: (prev) => prev,
  });
}

/** Serialize the sales-list filters (everything except `page`). Shared by the
 * one-page and infinite variants so the two can never drift. */
function salesFilterQuery(params?: Omit<PaginatedSalesParams, 'page'>): URLSearchParams {
  const qs = new URLSearchParams();
  qs.set('limit', String(params?.limit ?? 25));
  if (params?.q) qs.set('q', params.q);
  if (params?.from) qs.set('from', params.from);
  if (params?.to) qs.set('to', params.to);
  if (params?.locationType === 'headoffice') {
    // Head Office is singular — the server matches on type alone.
    qs.set('locationType', 'headoffice');
  } else if (params?.locationType && params?.locationId) {
    qs.set('locationType', params.locationType);
    qs.set('locationId', String(params.locationId));
  }
  if (params?.warehouseScope) qs.set('warehouseScope', String(params.warehouseScope));
  if (params?.outletId) qs.set('outletId', String(params.outletId));
  return qs;
}

/**
 * Infinite (load-more) sales list: same rows and filters as usePaginatedSales,
 * fetched in server-side batches of `limit` and accumulated across pages.
 * Changing any filter changes the query key, which resets the accumulation to
 * page 1 automatically. The key starts with '/api/sales' so the existing
 * predicate-based invalidations (create/edit/delete sale) refetch it too.
 */
export function useInfiniteSales(params?: Omit<PaginatedSalesParams, 'page'>) {
  const key = salesFilterQuery(params).toString();
  return useInfiniteQuery({
    queryKey: ['/api/sales', 'infinite', key] as const,
    queryFn: ({ pageParam, signal }) =>
      customFetch<Paginated<PaginatedSaleRow>>(`/api/sales?page=${pageParam}&${key}`, { signal }),
    initialPageParam: 1,
    getNextPageParam: (last) =>
      last.page * last.limit < last.total ? last.page + 1 : undefined,
    placeholderData: (prev) => prev,
  });
}

/** Full filtered sales list (no page/limit → the server returns everything
 * matching the filters). For CSV export parity: the screen pages, the file
 * must not. Plain caller — runs from a click handler, not a render. Rows come
 * back oldest-first on the unpaginated path, so sort to match the screen. */
export function fetchAllSales(params?: Omit<PaginatedSalesParams, 'page' | 'limit'>): Promise<PaginatedSaleRow[]> {
  const qs = salesFilterQuery(params);
  qs.delete('limit'); // presence of `limit` alone flips the server into paged mode
  const key = qs.toString();
  return customFetch<PaginatedSaleRow[]>(`/api/sales${key ? `?${key}` : ''}`)
    .then(rows => [...rows].sort((a: any, b: any) => Number(b.id) - Number(a.id)));
}

/** Full filtered purchases list (no page/limit) — CSV export parity. */
export function fetchAllPurchases(params?: Omit<PaginatedPurchasesParams, 'page' | 'limit'>): Promise<PaginatedPurchaseRow[]> {
  const qs = new URLSearchParams();
  if (params?.q) qs.set('q', params.q);
  appendDateLocationParams(qs, params);
  const key = qs.toString();
  return customFetch<PaginatedPurchaseRow[]>(`/api/purchases${key ? `?${key}` : ''}`);
}

/** Server-paginated purchases list. */
export function usePaginatedPurchases(params?: PaginatedPurchasesParams) {
  const qs = new URLSearchParams();
  qs.set('page', String(params?.page ?? 1));
  qs.set('limit', String(params?.limit ?? 25));
  if (params?.q) qs.set('q', params.q);
  appendDateLocationParams(qs, params);
  const key = qs.toString();
  return useQuery({
    queryKey: ['/api/purchases', 'paginated', key] as const,
    queryFn: ({ signal }) =>
      customFetch<Paginated<PaginatedPurchaseRow>>(`/api/purchases?${key}`, { signal }),
    placeholderData: (prev) => prev,
  });
}

/**
 * Infinite (load-more) stock list: same rows/envelope as usePaginatedStock,
 * fetched in server-side batches and accumulated across pages. The key starts
 * with '/api/stock' so existing stock invalidations refetch it too.
 * `canViewValuation` rides on every page; read it from any page (they agree).
 */
export function useInfiniteStock(
  params?: Omit<PaginatedStockParams, 'page'>,
  options?: { enabled?: boolean },
) {
  const qs = new URLSearchParams();
  qs.set('limit', String(params?.limit ?? 50));
  if (params?.q) qs.set('q', params.q);
  if (params?.branchType) qs.set('branchType', params.branchType);
  if (params?.branchId) qs.set('branchId', String(params.branchId));
  if (params?.materialType) qs.set('materialType', params.materialType);
  const key = qs.toString();
  return useInfiniteQuery({
    queryKey: ['/api/stock', 'infinite', key] as const,
    queryFn: ({ pageParam, signal }) =>
      customFetch<PaginatedStock>(`/api/stock?page=${pageParam}&${key}`, { signal }),
    initialPageParam: 1,
    getNextPageParam: (last) =>
      last.page * last.limit < last.total ? last.page + 1 : undefined,
    placeholderData: (prev) => prev,
    enabled: options?.enabled ?? true,
  });
}

/** Server-paginated stock list. */
export function usePaginatedStock(params?: PaginatedStockParams, options?: { enabled?: boolean }) {
  const qs = new URLSearchParams();
  qs.set('page', String(params?.page ?? 1));
  qs.set('limit', String(params?.limit ?? 25));
  if (params?.q) qs.set('q', params.q);
  if (params?.branchType) qs.set('branchType', params.branchType);
  if (params?.branchId) qs.set('branchId', String(params.branchId));
  if (params?.materialType) qs.set('materialType', params.materialType);
  const key = qs.toString();
  return useQuery({
    queryKey: ['/api/stock', 'paginated', key] as const,
    queryFn: ({ signal }) =>
      customFetch<PaginatedStock>(`/api/stock?${key}`, { signal }),
    placeholderData: (prev) => prev,
    enabled: options?.enabled ?? true,
  });
}
