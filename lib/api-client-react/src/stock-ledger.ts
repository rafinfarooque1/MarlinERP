import { useQuery } from '@tanstack/react-query';
import { customFetch } from './custom-fetch';
import type { Paginated } from './paginated-lists';

export interface StockLedgerRow {
  id: number;
  txnType: string;
  materialType: string;
  refId: number;
  itemName: string;
  unit: string;
  branchType: string;
  branchId: number;
  branchName: string;
  qtyChange: number;
  runningBalance: number;
  /**
   * ABSENT — not zero — for callers without the inventory-valuation right.
   * Check `canViewValuation` on the envelope before rendering it.
   */
  unitCost?: number;
  docType: string;
  docId: number | null;
  notes: string | null;
  createdAt: string;
}

/** Envelope carries the server's verdict on whether this caller may see cost. */
export type PaginatedStockLedger = Paginated<StockLedgerRow> & { canViewValuation: boolean };

export interface StockLedgerParams {
  page?: number;
  limit?: number;
  q?: string;
  from?: string;
  to?: string;
  materialType?: string;
  txnType?: string;
  branchType?: string;
}

export function usePaginatedStockLedger(params?: StockLedgerParams) {
  const qs = new URLSearchParams();
  qs.set('page', String(params?.page ?? 1));
  qs.set('limit', String(params?.limit ?? 50));
  if (params?.q)            qs.set('q',            params.q);
  if (params?.from)         qs.set('from',         params.from);
  if (params?.to)           qs.set('to',           params.to);
  if (params?.materialType) qs.set('materialType', params.materialType);
  if (params?.txnType)      qs.set('txnType',      params.txnType);
  if (params?.branchType)   qs.set('branchType',   params.branchType);
  const key = qs.toString();
  return useQuery({
    queryKey: ['/api/stock/ledger', 'paginated', key] as const,
    queryFn: ({ signal }) =>
      customFetch<PaginatedStockLedger>(`/api/stock/ledger?${key}`, { signal }),
    placeholderData: (prev) => prev,
  });
}
