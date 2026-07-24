import { useQuery } from '@tanstack/react-query';
import { customFetch } from './custom-fetch';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LocationExpenseSummary {
  locationType: 'warehouse' | 'outlet';
  locationId: number;
  locationName: string;
  cashLedgerId: number;
  count: number;
  total: number;
}

export interface LocationExpenseEntry {
  id: number;
  voucherNumber: string;
  expenseDate: string;
  expenseLedgerId: number;
  expenseLedgerName: string;
  cashLedgerId: number;
  cashLedgerName: string;
  amount: number;
  description: string | null;
  createdAt: string;
}

export interface LocationExpensesResponse {
  cashLedgerId: number;
  cashLedgerName: string;
  expenses: LocationExpenseEntry[];
}

// ── Query keys ────────────────────────────────────────────────────────────────

export const getLocationExpensesSummaryQueryKey = () =>
  ['/api/accounts/location-expenses/summary'] as const;

export const getLocationExpensesQueryKey = (locationType: string, locationId: number) =>
  ['/api/accounts/location-expenses', locationType, locationId] as const;

// ── Hooks ─────────────────────────────────────────────────────────────────────

export function useLocationExpensesSummary() {
  return useQuery({
    queryKey: getLocationExpensesSummaryQueryKey(),
    queryFn: ({ signal }) =>
      customFetch<LocationExpenseSummary[]>('/api/accounts/location-expenses/summary', { signal }),
  });
}

export function useLocationExpenses(
  locationType: string,
  locationId: number,
  opts?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: getLocationExpensesQueryKey(locationType, locationId),
    queryFn: ({ signal }) =>
      customFetch<LocationExpensesResponse>(
        `/api/accounts/location-expenses?locationType=${encodeURIComponent(locationType)}&locationId=${locationId}`,
        { signal }
      ),
    enabled: opts?.enabled !== undefined ? opts.enabled : !!(locationType && locationId > 0),
  });
}
