import { useMutation, useQueryClient } from '@tanstack/react-query';
import { customFetch } from './custom-fetch';
import { getListProductionsQueryKey, getListPurchasesQueryKey } from './generated/api';

// ── Production ────────────────────────────────────────────────────────────────

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
