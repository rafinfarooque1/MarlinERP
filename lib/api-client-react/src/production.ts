import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { customFetch } from './custom-fetch';
import { getListProductionsQueryKey, getListPurchasesQueryKey } from './generated/api';
import { appendDateLocationParams, type DateLocationParams } from './paginated-lists';

// ── Production ────────────────────────────────────────────────────────────────

/**
 * Productions list with the global date + location filter. Same row shape as
 * the generated useListProductions (which the OpenAPI spec under-declares —
 * the endpoint enriches rows with batch/costing/location fields), so callers
 * type rows themselves. Keyed under the generated list key so create/delete
 * invalidations refresh filtered views too.
 */
export function useFilteredProductions(params?: DateLocationParams) {
  const qs = new URLSearchParams();
  appendDateLocationParams(qs, params);
  const key = qs.toString();
  return useQuery({
    queryKey: [...getListProductionsQueryKey(), 'filtered', key] as const,
    queryFn: ({ signal }) =>
      customFetch<any[]>(`/api/productions${key ? `?${key}` : ''}`, { signal }),
    placeholderData: (prev) => prev,
  });
}

export interface ProductionUpdate {
  productionDate?: string;
  notes?: string;
}

export function useUpdateProduction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: ProductionUpdate }) =>
      customFetch<any>(`/api/productions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getListProductionsQueryKey() });
    },
  });
}

export function useDeleteProduction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      customFetch<void>(`/api/productions/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getListProductionsQueryKey() });
    },
  });
}

// ── Purchases ─────────────────────────────────────────────────────────────────

export interface PurchaseUpdate {
  purchaseDate?: string;
  invoiceNumber?: string;
  notes?: string;
}

export function useUpdatePurchase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: PurchaseUpdate }) =>
      customFetch<any>(`/api/purchases/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getListPurchasesQueryKey() });
    },
  });
}

export function useDeletePurchase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      customFetch<void>(`/api/purchases/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getListPurchasesQueryKey() });
    },
  });
}
