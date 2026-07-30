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
  /**
   * False when this employee lacks the inventory-valuation right, in which
   * case `inventory.valuation` is ABSENT rather than zero.
   */
  canViewValuation: boolean;
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
  inventory: { valuation?: number; itemCount: number; lowStockCount: number; expiringSoonCount: number };
  /**
   * `total` is Sundry Debtors from the accounting postings — the Balance Sheet
   * figure, so a receipt, a journal or a credit note all move it. It is `null`
   * for a location-scoped caller, because a posting carries no location.
   * `invoiceExposure` is the document-level figure for the selected period and
   * location, and `overdue` can only come from invoice dates.
   */
  receivables: {
    total: number | null;
    basis: 'ledger' | null;
    companyWide: boolean;
    invoiceExposure: number;
    overdue: number;
    count: number;
  };
  /** Sundry Creditors, same construction and same caveats as receivables. */
  payables: {
    total: number | null;
    basis: 'ledger' | null;
    companyWide: boolean;
    purchaseExposure: number;
    count: number;
  };
  /**
   * `inflow`/`outflow`/`net` are period voucher FLOWS. `balance` is the cash
   * position from the postings — the Cash Book figure — and is `null` for a
   * location-scoped caller.
   */
  cash: {
    inflow: number;
    outflow: number;
    net: number;
    balance: number | null;
    companyWide: boolean;
  };
  /**
   * Direct + indirect expenses for the period, from the accounting postings.
   * `null` when the caller is scoped to a single location — derived postings
   * carry no location, so there is no honest per-branch figure to show.
   */
  expenses: { total: number | null; direct: number | null; indirect: number | null; companyWide: boolean };
  /** Aggregate bank ledger balance (excludes physical cash). `null` as above. */
  bank: { balance: number | null; companyWide: boolean };
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
