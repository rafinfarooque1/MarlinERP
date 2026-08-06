/**
 * Warehouse lifecycle — disable / re-enable / permanent delete.
 *
 * Disable is the recommended, reversible action: the warehouse stays in every
 * historical report but takes no new transactions. Permanent delete is the
 * nuclear option, guarded server-side by an administrator-only check, a typed
 * confirmation phrase and post-delete integrity validation.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";

export interface WarehouseLifecycleState {
  id: number;
  name: string;
  disabledAt: string | null;
  disabledBy: string | null;
}

export interface WarehouseDeleteCounts {
  sales: number;
  purchases: number;
  quotations: number;
  productions: number;
  receipts: number;
  payments: number;
  journalVouchers: number;
  expenses: number;
  salesReturns: number;
  purchaseReturns: number;
  customers: number;
  vendors: number;
  ledgerEntries: number;
  inventoryItems: number;
  stockValue: number;
  cashAccounts: number;
  bankAccounts: number;
  rentRecords: number;
}

export interface WarehouseDeleteSummary {
  warehouse: { id: number; name: string; disabledAt: string | null };
  /** The exact phrase the administrator must type to confirm. */
  confirmationPhrase: string;
  counts: WarehouseDeleteCounts;
  /** Non-empty = permanent deletion refused; disable instead. */
  blockers: string[];
  hasTransactions: boolean;
}

export interface WarehousePermanentDeleteResult {
  ok: boolean;
  deleted: Record<string, number>;
}

export function useDisableWarehouse() {
  return useMutation({
    mutationFn: ({ id }: { id: number }) =>
      customFetch<WarehouseLifecycleState>(`/api/warehouses/${id}/disable`, { method: "POST" }),
  });
}

export function useEnableWarehouse() {
  return useMutation({
    mutationFn: ({ id }: { id: number }) =>
      customFetch<WarehouseLifecycleState>(`/api/warehouses/${id}/enable`, { method: "POST" }),
  });
}

export const getWarehouseDeleteSummaryQueryKey = (id: number) =>
  [`/api/warehouses/${id}/delete-summary`] as const;

/** Pre-deletion summary: counts, blockers and the confirmation phrase. */
export function useWarehouseDeleteSummary(id: number | null) {
  return useQuery({
    queryKey: getWarehouseDeleteSummaryQueryKey(id ?? 0),
    queryFn: () => customFetch<WarehouseDeleteSummary>(`/api/warehouses/${id}/delete-summary`),
    enabled: id != null,
    // Always re-fetched when the dialog opens — the numbers back a destructive
    // decision and must never be a stale cache hit.
    staleTime: 0,
    gcTime: 0,
  });
}

export function usePermanentDeleteWarehouse() {
  return useMutation({
    mutationFn: ({ id, confirmation }: { id: number; confirmation: string }) =>
      customFetch<WarehousePermanentDeleteResult>(`/api/warehouses/${id}/permanent`, {
        method: "DELETE",
        body: JSON.stringify({ confirmation }),
        headers: { "Content-Type": "application/json" },
      }),
  });
}
