import type { QueryClient } from '@tanstack/react-query';

/**
 * Invalidate every dashboard query so the home dashboard (KPI cards, BI
 * figures, trends, stock alerts, recent activity) refreshes after any write
 * that changes sales, purchases, production batches or transfers.
 *
 * All dashboard queries use a query key whose first element is the endpoint
 * path (`/api/dashboard/...`), so we match on that prefix with a predicate
 * rather than listing every key at each call site.
 */
export function invalidateDashboard(queryClient: QueryClient): void {
  queryClient.invalidateQueries({
    predicate: (query) => {
      const first = query.queryKey?.[0];
      return typeof first === 'string' && first.startsWith('/api/dashboard');
    },
  });
}
