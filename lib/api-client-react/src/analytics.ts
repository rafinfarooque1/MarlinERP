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

// ── Hooks ─────────────────────────────────────────────────────────────────────

export function useGetSalesTrend(params?: { days?: number }) {
  const days = params?.days ?? 30;
  return useQuery({
    queryKey: ['/api/dashboard/sales-trend', days] as const,
    queryFn: ({ signal }) =>
      customFetch<SalesTrendPoint[]>(`/api/dashboard/sales-trend?days=${days}`, { signal }),
  });
}

export function useGetTopItems(params?: { days?: number }) {
  const days = params?.days ?? 30;
  return useQuery({
    queryKey: ['/api/dashboard/top-items', days] as const,
    queryFn: ({ signal }) =>
      customFetch<TopItemPoint[]>(`/api/dashboard/top-items?days=${days}`, { signal }),
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
