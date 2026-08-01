import { useQuery } from '@tanstack/react-query';
import { customFetch } from './custom-fetch';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface QuickSearchEntry {
  id: number;
  title: string;
  subtitle: string;
}

export interface QuickSearchResponse {
  items: QuickSearchEntry[];
  customers: QuickSearchEntry[];
  vendors: QuickSearchEntry[];
  sales: QuickSearchEntry[];
  quotations: QuickSearchEntry[];
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

/**
 * Global quick search (Cmd+K palette). Only fires for queries of 2+ chars;
 * results are permission-filtered server-side.
 */
export function useQuickSearch(q: string) {
  const trimmed = q.trim();
  return useQuery({
    queryKey: ['/api/search', trimmed] as const,
    queryFn: ({ signal }) =>
      customFetch<QuickSearchResponse>(`/api/search?q=${encodeURIComponent(trimmed)}`, { signal }),
    enabled: trimmed.length >= 2,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}
