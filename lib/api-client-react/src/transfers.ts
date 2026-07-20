import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { customFetch } from './custom-fetch';

export const getTransfersQueryKey = () => ['/api/stock/transfers'] as const;

export interface ReceivedLineItem {
  itemId: number;
  quantity: number;
  costPrice?: number;
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
    onSuccess: () => qc.invalidateQueries({ queryKey: getTransfersQueryKey() }),
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
    onSuccess: () => qc.invalidateQueries({ queryKey: getTransfersQueryKey() }),
  });
}
