import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { customFetch } from './custom-fetch';

// ── Types ────────────────────────────────────────────────────────────────────

export type BatchExpiryStatus = 'ok' | 'near_expiry' | 'expired' | 'no_expiry';

export interface StockBatch {
  id: number;
  itemId: number;
  itemName: string;
  unit: string;
  branchType: string;
  branchId: number;
  branchName: string;
  batchNumber: string;
  mfgDate: string | null;
  expiryDate: string | null;
  quantity: number;
  unitCost: number;
  source: string;
  daysToExpiry: number | null;
  status: BatchExpiryStatus;
}

export interface BatchPlanEntry {
  batchId?: number;
  batchNumber: string;
  mfgDate?: string | null;
  expiryDate?: string | null;
  quantity: number;
  unitCost?: number;
}

export interface BatchSuggestResponse {
  plan: BatchPlanEntry[];
  shortfall: number;
}

export interface ExpiryReportRow {
  id: number;
  itemId: number;
  itemName: string;
  unit: string;
  branchType: string;
  branchId: number;
  branchName: string;
  batchNumber: string;
  mfgDate: string | null;
  expiryDate: string;
  quantity: number;
  unitCost: number;
  value: number;
  daysToExpiry: number;
  status: 'near_expiry' | 'expired';
}

export interface ExpiryReportSummary {
  expiredBatches: number;
  expiredQuantity: number;
  expiredValue: number;
  nearExpiryBatches: number;
  nearExpiryQuantity: number;
  nearExpiryValue: number;
}

export interface ExpiryReport {
  days: number;
  rows: ExpiryReportRow[];
  summary: ExpiryReportSummary;
}

export interface ValuationRow {
  itemId: number;
  itemName: string;
  unit: string;
  branchType: string;
  branchId: number;
  branchName: string;
  quantity: number;
  avgCost: number;
  value: number;
}

export interface ValuationLocation {
  branchType: string;
  branchId: number;
  branchName: string;
  totalValue: number;
  itemCount: number;
  totalQuantity: number;
}

export interface StockValuation {
  rows: ValuationRow[];
  locations: ValuationLocation[];
  grandTotal: number;
}

export interface ReorderRow {
  itemId: number;
  itemName: string;
  unit: string;
  branchType: string;
  branchId: number;
  branchName: string;
  quantity: number;
  reorderLevel: number;
  shortfall: number;
}

export type VerificationReason = 'damage' | 'wastage' | 'count_correction' | 'expired';

export interface VerificationLine {
  itemId: number;
  itemName: string;
  unit: string;
  systemQty: number;
  countedQty: number;
  variance: number;
  reason: VerificationReason | null;
}

export interface StockVerification {
  id: number;
  branchType: string;
  branchId: number;
  branchName: string;
  verifyDate: string;
  notes: string | null;
  createdBy: string;
  lineCount?: number;
  adjustedCount?: number;
  lines: VerificationLine[];
  createdAt: string;
}

export interface CreateVerificationBody {
  branchType: string;
  branchId: number;
  verifyDate: string;
  notes?: string;
  createdBy?: string;
  lines: Array<{ itemId: number; countedQty: number; reason?: VerificationReason }>;
}

// ── Query keys ────────────────────────────────────────────────────────────────

export const getStockBatchesQueryKey = (params?: Record<string, unknown>) =>
  params ? (['/api/stock/batches', params] as const) : (['/api/stock/batches'] as const);
export const getStockValuationQueryKey = () => ['/api/stock/valuation'] as const;
export const getReorderReportQueryKey = () => ['/api/stock/reorder-report'] as const;
export const getExpiryReportQueryKey = (days?: number) =>
  days != null ? (['/api/stock/expiry-report', days] as const) : (['/api/stock/expiry-report'] as const);
export const getStockVerificationsQueryKey = () => ['/api/stock/verifications'] as const;

const qs = (params: Record<string, unknown>) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
};

// ── Hooks ─────────────────────────────────────────────────────────────────────

export function useListStockBatches(
  params?: { branchType?: string; branchId?: number; itemId?: number; nearDays?: number },
  options?: { enabled?: boolean },
) {
  const p = params ?? {};
  return useQuery({
    queryKey: ['/api/stock/batches', p] as const,
    queryFn: ({ signal }) => customFetch<StockBatch[]>(`/api/stock/batches${qs(p)}`, { signal }),
    enabled: options?.enabled ?? true,
  });
}

/** FEFO pick suggestion for a planned outbound movement. */
export function useSuggestBatches(params: {
  itemId?: number;
  branchType?: string;
  branchId?: number;
  quantity?: number;
}) {
  const ready =
    !!params.itemId && !!params.branchType && params.branchId != null && (params.quantity ?? 0) > 0;
  return useQuery({
    queryKey: ['/api/stock/batches/suggest', params] as const,
    queryFn: ({ signal }) =>
      customFetch<BatchSuggestResponse>(`/api/stock/batches/suggest${qs(params)}`, { signal }),
    enabled: ready,
  });
}

export function useGetExpiryReport(days = 30) {
  return useQuery({
    queryKey: getExpiryReportQueryKey(days),
    queryFn: ({ signal }) => customFetch<ExpiryReport>(`/api/stock/expiry-report?days=${days}`, { signal }),
  });
}

export function useGetStockValuation() {
  return useQuery({
    queryKey: getStockValuationQueryKey(),
    queryFn: ({ signal }) => customFetch<StockValuation>('/api/stock/valuation', { signal }),
  });
}

export function useGetReorderReport() {
  return useQuery({
    queryKey: getReorderReportQueryKey(),
    queryFn: ({ signal }) => customFetch<ReorderRow[]>('/api/stock/reorder-report', { signal }),
  });
}

export function useListStockVerifications(params?: { branchType?: string; branchId?: number }) {
  const p = params ?? {};
  return useQuery({
    queryKey: ['/api/stock/verifications', p] as const,
    queryFn: ({ signal }) => customFetch<StockVerification[]>(`/api/stock/verifications${qs(p)}`, { signal }),
  });
}

export function useGetStockVerification(id: number | null | undefined) {
  return useQuery({
    queryKey: ['/api/stock/verifications', id] as const,
    queryFn: ({ signal }) => customFetch<StockVerification>(`/api/stock/verifications/${id}`, { signal }),
    enabled: id != null,
  });
}

export function useCreateStockVerification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateVerificationBody) =>
      customFetch<StockVerification>('/api/stock/verifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      // A verification moves stock, batches and every derived report.
      for (const key of [
        ['/api/stock'],
        ['/api/stock/batches'],
        ['/api/stock/valuation'],
        ['/api/stock/reorder-report'],
        ['/api/stock/expiry-report'],
        ['/api/stock/verifications'],
        ['/api/items'],
        ['/api/dashboard/stock-alerts'],
      ]) {
        qc.invalidateQueries({ queryKey: key });
      }
    },
  });
}
