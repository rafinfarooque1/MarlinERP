import { useMutation, useQuery } from '@tanstack/react-query';
import { customFetch } from './custom-fetch';

// ── Admin-only system receipt deletion ───────────────────────────────────────
// Sale-generated receipts are locked in the normal voucher workflow; a level-1
// Administrator may delete one with a full accounting unwind. The impact
// endpoint feeds the warning dialog; the system-delete endpoint performs the
// reversal and records the required reason in the audit log.

export interface SystemReceiptImpactSale {
  saleId: number;
  invoiceNumber: string;
  customerName: string;
  totalAmount: number;
  currentPaid: number;
  currentStatus: string;
  reversal: number;
  newPaid: number;
  newStatus: string;
}

export interface SystemReceiptDeleteImpact {
  receiptId: number;
  voucherNumber: string;
  receiptDate: string;
  amount: number;
  narration: string | null;
  receivedFromName: string | null;
  receivedInName: string | null;
  locationLabel: string;
  kind: 'collection' | 'invoice' | 'orphan';
  sales: SystemReceiptImpactSale[];
  blockers: string[];
}

export function useReceiptDeleteImpact(receiptId: number | null | undefined) {
  return useQuery({
    queryKey: ['/api/accounts/receipts', receiptId, 'delete-impact'] as const,
    queryFn: ({ signal }) =>
      customFetch<SystemReceiptDeleteImpact>(`/api/accounts/receipts/${receiptId}/delete-impact`, { signal }),
    enabled: receiptId != null,
    staleTime: 0,
    gcTime: 0,
  });
}

export interface SystemDeleteReceiptResult {
  deleted: boolean;
  kind: 'collection' | 'invoice' | 'orphan';
  sales: SystemReceiptImpactSale[];
}

export function useSystemDeleteReceipt() {
  return useMutation({
    mutationFn: ({ receiptId, reason }: { receiptId: number; reason: string }) =>
      customFetch<SystemDeleteReceiptResult>(`/api/accounts/receipts/${receiptId}/system-delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      }),
  });
}
