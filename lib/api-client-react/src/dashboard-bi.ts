import { useQuery } from '@tanstack/react-query';
import { customFetch } from './custom-fetch';

// ── Types for GET /api/dashboard/bi ────────────────────────────────────────────

export interface DashboardBiFilters {
  fromDate?: string;
  toDate?: string;
  locationType?: 'warehouse' | 'outlet' | 'headoffice';
  locationId?: number;
}

export interface BiDayPoint { date: string; total: number; count: number }
export interface BiLocationPoint {
  locationType: string;
  locationId: number;
  name: string;
  total: number;
  count: number;
}
export interface BiPaymentPoint { mode: string; total: number; count: number }
export interface BiProductionDay { date: string; qty: number }
export interface BiPurchaseDay { date: string; total: number }
export interface BiTopItem { itemId: number; name: string; qty: number; revenue: number }
export interface BiTopCustomer { customerId: number; name: string; revenue: number; count: number }

export interface DashboardBi {
  period: { fromDate: string | null; toDate: string | null };
  scope: { locationType: string | null; locationId: number | null; label: string; isHeadOffice: boolean };
  sales: {
    total: number;
    count: number;
    avgTicket: number;
    byDay: BiDayPoint[];
    byLocation: BiLocationPoint[];
    byPaymentMode: BiPaymentPoint[];
  };
  purchases: { total: number; count: number; byDay: BiPurchaseDay[] };
  production: { batches: number; outputQty: number; wastageQty: number; wastagePct: number; byDay: BiProductionDay[] };
  inventory: { valuation: number; itemCount: number; lowStockCount: number; expiringSoonCount: number };
  receivables: { total: number; overdue: number; count: number };
  payables: { total: number; count: number };
  cash: { inflow: number; outflow: number; net: number };
  topItems: BiTopItem[];
  topCustomers: BiTopCustomer[];
}

function biQS(params?: DashboardBiFilters): string {
  const qs = new URLSearchParams();
  if (params?.fromDate) qs.set('fromDate', params.fromDate);
  if (params?.toDate) qs.set('toDate', params.toDate);
  if (params?.locationType && params?.locationId) {
    qs.set('locationType', params.locationType);
    qs.set('locationId', String(params.locationId));
  }
  return qs.toString();
}

export function useGetDashboardBi(params?: DashboardBiFilters) {
  const qs = biQS(params);
  return useQuery({
    queryKey: ['/api/dashboard/bi', qs] as const,
    queryFn: ({ signal }) => customFetch<DashboardBi>(`/api/dashboard/bi?${qs}`, { signal }),
  });
}
