import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { customFetch } from './custom-fetch';

// ── Types ────────────────────────────────────────────────────────────────────

export type BatchExpiryStatus = 'ok' | 'near_expiry' | 'expired' | 'no_expiry';

/** Kinds of product that share the stock tables. */
export type StockProductKind = 'item' | 'material' | 'raw_material';

/** Expiry tier a lot falls into. Narrowest tier wins, so each lot appears once. */
export type ExpiryBucket = 'expired' | 'd7' | 'd15' | 'd30' | 'd60' | 'd90' | 'ok' | 'no_expiry';

/** Colour hint from the server, so every surface tones a tier the same way. */
export type ExpiryTone = 'critical' | 'warn' | 'caution' | 'ok' | 'none';

export interface StockBatch {
  id: number;
  itemId: number;
  materialType: StockProductKind;
  itemName: string;
  itemCode?: string;
  barcode?: string;
  mrp?: number | null;
  unit: string;
  branchType: string;
  branchId: number;
  branchName: string;
  batchNumber: string;
  mfgDate: string | null;
  expiryDate: string | null;
  quantity: number;
  /** Committed to a transfer or an unfulfilled order; not free to consume. */
  reserved: number;
  /** quantity − reserved, floored at zero. */
  available: number;
  unitCost: number;
  value: number;
  source: string;
  daysToExpiry: number | null;
  status: BatchExpiryStatus;
  bucket: ExpiryBucket;
  bucketLabel: string;
  tone: ExpiryTone;
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
  materialType: StockProductKind;
  typeLabel: string;
  itemName: string;
  itemCode: string;
  unit: string;
  branchType: string;
  branchId: number;
  branchName: string;
  batchNumber: string;
  mfgDate: string | null;
  expiryDate: string;
  mrp: number | null;
  quantity: number;
  reserved: number;
  available: number;
  unitCost: number;
  value: number;
  daysToExpiry: number;
  status: 'near_expiry' | 'expired';
  bucket: ExpiryBucket;
  bucketLabel: string;
  tone: ExpiryTone;
}

export interface ExpiryBucketSummary {
  bucket: ExpiryBucket;
  label: string;
  batches: number;
  quantity: number;
  value: number;
}

export interface ExpiryReportSummary {
  expiredBatches: number;
  expiredQuantity: number;
  expiredValue: number;
  nearExpiryBatches: number;
  nearExpiryQuantity: number;
  nearExpiryValue: number;
}

export type ExpiryReportStatus = 'all' | 'near_expiry' | 'expired';

export interface ExpiryReport {
  days: number;
  status: ExpiryReportStatus;
  /** Tier boundaries in days, narrowest first. */
  tiers: number[];
  rows: ExpiryReportRow[];
  /** One entry per tier, always present — a zero reads as zero, not as absent. */
  buckets: ExpiryBucketSummary[];
  bucketOrder: ExpiryBucket[];
  summary: ExpiryReportSummary;
}

export interface ExpiryReportParams {
  days?: number;
  status?: ExpiryReportStatus;
  branchType?: string;
  branchId?: number;
  itemId?: number;
  materialType?: StockProductKind;
  /** Expiring on or after this date (YYYY-MM-DD). */
  from?: string;
  /** Expiring on or before this date (YYYY-MM-DD). */
  to?: string;
}

export interface ValuationRow {
  itemId: number;
  refId: number;
  materialType: StockProductKind;
  typeLabel: string;
  itemName: string;
  unit: string;
  branchType: string;
  branchId: number;
  branchName: string;
  quantity: number;
  reserved: number;
  available: number;
  avgCost: number;
  unitCost: number;
  value: number;
  /** Dispatched, not yet received — still owned by this location. */
  inTransit: boolean;
}

export interface ValuationLocation {
  branchType: string;
  branchId: number;
  branchName: string;
  totalValue: number;
  onHandValue: number;
  inTransitValue: number;
  itemCount: number;
  totalQuantity: number;
}

export interface ValuationTypeTotal {
  materialType: StockProductKind;
  label: string;
  lines: number;
  quantity: number;
  value: number;
}

export interface ValuationProductTotal {
  materialType: StockProductKind;
  refId: number;
  itemName: string;
  unit: string;
  quantity: number;
  unitCost: number;
  value: number;
}

export interface StockValuation {
  rows: ValuationRow[];
  locations: ValuationLocation[];
  byType: ValuationTypeTotal[];
  byProduct: ValuationProductTotal[];
  onHandValue: number;
  inTransitValue: number;
  reservedQuantity: number;
  grandTotal: number;
}

export interface StockValuationParams {
  branchType?: string;
  branchId?: number;
  materialType?: StockProductKind;
}

// ── Movement analysis (dead / slow-moving stock) ──────────────────────────────

export type MovementClass = 'fast' | 'slow' | 'dormant' | 'dead';

export interface MovementRow {
  refId: number;
  itemId: number;
  materialType: StockProductKind;
  typeLabel: string;
  itemName: string;
  itemCode: string;
  unit: string;
  branchType: string;
  branchId: number;
  branchName: string;
  quantity: number;
  reserved: number;
  available: number;
  unitCost: number;
  value: number;
  lastMovementAt: string | null;
  lastOutboundAt: string | null;
  daysSinceMovement: number | null;
  daysSinceOutbound: number | null;
  class: MovementClass;
  classLabel: string;
  /** No ledger entry at all — may simply predate the ledger. */
  noHistory: boolean;
}

export interface MovementClassSummary {
  class: MovementClass;
  label: string;
  lines: number;
  quantity: number;
  value: number;
}

export interface MovementAnalysis {
  basis: 'last_outbound_movement';
  /** When the stock ledger began; movement before it was never recorded. */
  ledgerStart: string | null;
  thresholds: Record<string, number>;
  classOrder: MovementClass[];
  rows: MovementRow[];
  summary: MovementClassSummary[];
  totalValue: number;
}

export interface MovementAnalysisParams {
  branchType?: string;
  branchId?: number;
  itemId?: number;
  materialType?: StockProductKind;
  class?: MovementClass | 'all';
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
export const getStockValuationQueryKey = (params?: StockValuationParams) =>
  params ? (['/api/stock/valuation', params] as const) : (['/api/stock/valuation'] as const);
export const getReorderReportQueryKey = () => ['/api/stock/reorder-report'] as const;
export const getExpiryReportQueryKey = (params?: number | ExpiryReportParams) =>
  params != null ? (['/api/stock/expiry-report', params] as const) : (['/api/stock/expiry-report'] as const);
export const getMovementAnalysisQueryKey = (params?: MovementAnalysisParams) =>
  params ? (['/api/stock/movement-analysis', params] as const) : (['/api/stock/movement-analysis'] as const);
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
  params?: { branchType?: string; branchId?: number; itemId?: number; materialType?: StockProductKind; nearDays?: number },
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

/**
 * Expiry report. Accepts a bare `days` number (the original signature) or the
 * full filter set — warehouse, item, kind, expiry-date range and which side of
 * today to look at.
 */
export function useGetExpiryReport(params: number | ExpiryReportParams = 90) {
  const p: ExpiryReportParams = typeof params === 'number' ? { days: params } : params;
  return useQuery({
    queryKey: getExpiryReportQueryKey(p),
    queryFn: ({ signal }) => customFetch<ExpiryReport>(`/api/stock/expiry-report${qs(p as Record<string, unknown>)}`, { signal }),
  });
}

export function useGetStockValuation(params?: StockValuationParams) {
  const p = params ?? {};
  return useQuery({
    queryKey: getStockValuationQueryKey(p),
    queryFn: ({ signal }) => customFetch<StockValuation>(`/api/stock/valuation${qs(p as Record<string, unknown>)}`, { signal }),
  });
}

/** Dead and slow-moving stock, classified by time since the last outbound move. */
export function useGetMovementAnalysis(params?: MovementAnalysisParams) {
  const p = params ?? {};
  return useQuery({
    queryKey: getMovementAnalysisQueryKey(p),
    queryFn: ({ signal }) => customFetch<MovementAnalysis>(`/api/stock/movement-analysis${qs(p as Record<string, unknown>)}`, { signal }),
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
