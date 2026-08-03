import { useQuery } from '@tanstack/react-query';
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

/** Server-paginated stock list. */
export function usePaginatedStock(params?: PaginatedStockParams) {
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
  });
}
