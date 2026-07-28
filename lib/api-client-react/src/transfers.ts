import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { customFetch } from './custom-fetch';

export const getTransfersQueryKey = () => ['/api/stock/transfers'] as const;

export interface ReceivedLineItem {
  itemId: number;
  quantity: number;
  costPrice?: number;
  materialType?: string;
}

export function useApproveTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, receivedLineItems, approvedBy }: { id: number; receivedLineItems: ReceivedLineItem[]; approvedBy?: string }) =>
      customFetch<{ success: boolean; status: string }>(`/api/stock/transfers/${id}/approve`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ receivedLineItems, approvedBy }),
      }),
    onSuccess: () => {
      // Transfers list
      qc.invalidateQueries({ queryKey: getTransfersQueryKey() });
      // Live Stock page (paginated) + useListStock (non-paginated)
      qc.invalidateQueries({ queryKey: ['/api/stock'] });
      // Batch quantity displays
      qc.invalidateQueries({ queryKey: ['/api/stock/batches'] });
      // Stock ledger — new transfer_in entries
      qc.invalidateQueries({ queryKey: ['/api/stock/ledger'] });
      // Materials and raw-materials current_stock
      qc.invalidateQueries({ queryKey: ['/api/materials'] });
      qc.invalidateQueries({ queryKey: ['/api/raw-materials'] });
      // Dashboard stock totals
      qc.invalidateQueries({ queryKey: ['/api/dashboard'] });
    },
  });
}

export function useRejectTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, rejectionReason }: { id: number; rejectionReason?: string }) =>
      customFetch<{ success: boolean; status: string }>(`/api/stock/transfers/${id}/reject`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rejectionReason }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getTransfersQueryKey() });
      // Reject restores source stock — refresh every stock-related view
      qc.invalidateQueries({ queryKey: ['/api/stock'] });
      qc.invalidateQueries({ queryKey: ['/api/stock/batches'] });
      qc.invalidateQueries({ queryKey: ['/api/stock/ledger'] });
      qc.invalidateQueries({ queryKey: ['/api/materials'] });
      qc.invalidateQueries({ queryKey: ['/api/raw-materials'] });
      qc.invalidateQueries({ queryKey: ['/api/dashboard'] });
    },
  });
}
