import { useQuery } from '@tanstack/react-query';
import { customFetch } from './custom-fetch';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SalesTrendPoint {
  date: string;
  revenue: number;
  invoices: number;
}

export interface TopItemPoint {
  item_id: number;
  item_name: string;
  revenue: number;
  quantity: number;
}

export interface ProductionTrendPoint {
  date: string;
  quantity: number;
  batches: number;
}

export interface SalesByLocationPoint {
  locationType: 'warehouse' | 'outlet';
  locationId: number;
  locationName: string;
  invoices: number;
  revenue: number;
}

/** Optional sales analytics filters (Phase 7). from/to override days. */
export interface SalesAnalyticsFilters {
  days?: number;
  from?: string;
  to?: string;
  locationType?: 'warehouse' | 'outlet';
  locationId?: number;
  warehouseScope?: number;
}

function salesFilterQS(params?: SalesAnalyticsFilters): string {
  const qs = new URLSearchParams();
  if (params?.from) qs.set('from', params.from);
  if (params?.to) qs.set('to', params.to);
  if (!params?.from && !params?.to) qs.set('days', String(params?.days ?? 30));
  if (params?.locationType && params?.locationId) {
    qs.set('locationType', params.locationType);
    qs.set('locationId', String(params.locationId));
  }
  if (params?.warehouseScope) qs.set('warehouseScope', String(params.warehouseScope));
  return qs.toString();
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

export function useGetSalesTrend(params?: SalesAnalyticsFilters) {
  const qs = salesFilterQS(params);
  return useQuery({
    queryKey: ['/api/dashboard/sales-trend', qs] as const,
    queryFn: ({ signal }) =>
      customFetch<SalesTrendPoint[]>(`/api/dashboard/sales-trend?${qs}`, { signal }),
  });
}

export function useGetTopItems(params?: SalesAnalyticsFilters) {
  const qs = salesFilterQS(params);
  return useQuery({
    queryKey: ['/api/dashboard/top-items', qs] as const,
    queryFn: ({ signal }) =>
      customFetch<TopItemPoint[]>(`/api/dashboard/top-items?${qs}`, { signal }),
  });
}

export function useGetSalesByLocation(params?: SalesAnalyticsFilters) {
  const qs = salesFilterQS(params);
  return useQuery({
    queryKey: ['/api/dashboard/sales-by-location', qs] as const,
    queryFn: ({ signal }) =>
      customFetch<SalesByLocationPoint[]>(`/api/dashboard/sales-by-location?${qs}`, { signal }),
  });
}

export function useGetProductionTrend(params?: { days?: number }) {
  const days = params?.days ?? 30;
  return useQuery({
    queryKey: ['/api/dashboard/production-trend', days] as const,
    queryFn: ({ signal }) =>
      customFetch<ProductionTrendPoint[]>(`/api/dashboard/production-trend?days=${days}`, { signal }),
  });
}
