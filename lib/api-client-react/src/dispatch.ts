import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { customFetch } from './custom-fetch';

// ── Types ─────────────────────────────────────────────────────────────────────

export type DispatchStatus = 'PENDING' | 'READY' | 'DISPATCHED';

export interface DispatchLine {
  name: string;
  quantity: number;
  unit: string;
}

export interface DispatchQueueEntry {
  saleId: number;
  invoiceNumber: string;
  saleDate: string; // YYYY-MM-DD
  createdAt: string; // ISO timestamp — "time since billing" derives from this
  customerName: string | null;
  locationType: 'outlet' | 'warehouse' | 'headoffice';
  locationId: number | null;
  locationName: string;
  paymentMode: string;
  totalAmount: number;
  itemCount: number;
  totalQty: number;
  itemsSummary: string;
  /** Full picking list — one entry per invoice line. */
  lines: DispatchLine[];
  status: DispatchStatus;
  readyAt: string | null;
  readyBy: string | null;
  dispatchedAt: string | null;
  dispatchedBy: string | null;
}

export interface DispatchQueueFilters {
  status?: DispatchStatus;
  q?: string;
  from?: string;
  to?: string;
}

export interface DispatchTransitionResult {
  saleId: number;
  invoiceNumber: string;
  status: DispatchStatus;
  readyAt: string | null;
  readyBy: string | null;
  dispatchedAt: string | null;
  dispatchedBy: string | null;
}

// ── Query keys ────────────────────────────────────────────────────────────────

export const getDispatchQueueQueryKey = (filters?: DispatchQueueFilters) =>
  ['/api/dispatch/queue', filters ?? {}] as const;

// ── Hooks ─────────────────────────────────────────────────────────────────────

export function useDispatchQueue(filters?: DispatchQueueFilters) {
  const qs = new URLSearchParams();
  if (filters?.status) qs.set('status', filters.status);
  if (filters?.q) qs.set('q', filters.q);
  if (filters?.from) qs.set('from', filters.from);
  if (filters?.to) qs.set('to', filters.to);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return useQuery({
    queryKey: getDispatchQueueQueryKey(filters),
    queryFn: ({ signal }) =>
      customFetch<DispatchQueueEntry[]>(`/api/dispatch/queue${suffix}`, { signal }),
  });
}

export function useSetDispatchStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ saleId, status }: { saleId: number; status: 'READY' | 'DISPATCHED' }) =>
      customFetch<DispatchTransitionResult>(`/api/dispatch/${saleId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({
        predicate: (query) => String(query.queryKey[0] ?? '').startsWith('/api/dispatch'),
      });
    },
  });
}
