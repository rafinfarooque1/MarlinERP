import { useQuery } from '@tanstack/react-query';
import { customFetch } from './custom-fetch';
import type { Sale } from './generated/api.schemas';

/** Sale row as returned by GET /sales — the generated `Sale` type plus the
 * raw-column fields the endpoint enriches (location, payment status, dues). */
export type PaginatedSaleRow = Sale & {
  locationType?: 'warehouse' | 'outlet';
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
  locationType?: 'warehouse' | 'outlet';
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
  if (params?.locationType && params?.locationId) {
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
export function usePaginatedPurchases(params?: PaginatedListParams) {
  const qs = new URLSearchParams();
  qs.set('page', String(params?.page ?? 1));
  qs.set('limit', String(params?.limit ?? 25));
  if (params?.q) qs.set('q', params.q);
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
