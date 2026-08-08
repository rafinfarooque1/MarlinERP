import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { customFetch } from './custom-fetch';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PeriodLock {
  year: number;
  month: number;
  lockedBy: string;
  lockedAt: string;
}

export interface PeriodLockEvent {
  id: number;
  year: number;
  month: number;
  monthLabel: string;
  action: 'lock' | 'unlock';
  username: string;
  reason: string | null;
  createdAt: string;
}

export interface PeriodSummary {
  year: number;
  month: number;
  monthLabel: string;
  fromDate: string;
  toDate: string;
  locked: boolean;
  totals: {
    sales: number;
    salesCount: number;
    purchases: number;
    purchasesCount: number;
    receipts: number;
    receiptsCount: number;
    payments: number;
    paymentsCount: number;
    expenses: number;
    gstOnSales: number;
  };
  asOfMonthEnd: {
    receivables: number;
    payables: number;
    cash: number;
    bank: number;
  };
  inventoryCurrentValue: number;
  invoiceCounts: { b2b: number; b2c: number; other: number };
}

// ── Query keys ────────────────────────────────────────────────────────────────

export const getPeriodLocksQueryKey = () =>
  ['/api/accounting-periods/locks'] as const;

export const getPeriodEventsQueryKey = () =>
  ['/api/accounting-periods/events'] as const;

export const getPeriodSummaryQueryKey = (year: number, month: number) =>
  ['/api/accounting-periods/summary', year, month] as const;

// ── Hooks ─────────────────────────────────────────────────────────────────────

export function usePeriodLocks() {
  return useQuery({
    queryKey: getPeriodLocksQueryKey(),
    queryFn: ({ signal }) =>
      customFetch<PeriodLock[]>('/api/accounting-periods/locks', { signal }),
  });
}

export function usePeriodLockEvents(limit = 100) {
  return useQuery({
    queryKey: [...getPeriodEventsQueryKey(), limit],
    queryFn: ({ signal }) =>
      customFetch<PeriodLockEvent[]>(`/api/accounting-periods/events?limit=${limit}`, { signal }),
  });
}

export function usePeriodSummary(year: number, month: number, opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: getPeriodSummaryQueryKey(year, month),
    queryFn: ({ signal }) =>
      customFetch<PeriodSummary>(`/api/accounting-periods/${year}/${month}/summary`, { signal }),
    enabled: opts?.enabled ?? true,
  });
}

function useInvalidatePeriods() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: getPeriodLocksQueryKey() });
    qc.invalidateQueries({ queryKey: getPeriodEventsQueryKey() });
    qc.invalidateQueries({ queryKey: ['/api/accounting-periods/summary'] });
  };
}

export function useLockPeriod() {
  const invalidate = useInvalidatePeriods();
  return useMutation({
    mutationFn: ({ year, month }: { year: number; month: number }) =>
      customFetch<{ ok: boolean }>(`/api/accounting-periods/${year}/${month}/lock`, {
        method: 'POST',
        body: JSON.stringify({ confirm: true }),
      }),
    onSuccess: invalidate,
  });
}

export function useUnlockPeriod() {
  const invalidate = useInvalidatePeriods();
  return useMutation({
    mutationFn: ({ year, month, reason }: { year: number; month: number; reason: string }) =>
      customFetch<{ ok: boolean }>(`/api/accounting-periods/${year}/${month}/unlock`, {
        method: 'POST',
        body: JSON.stringify({ confirm: true, reason }),
      }),
    onSuccess: invalidate,
  });
}
