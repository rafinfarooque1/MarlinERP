import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { customFetch } from './custom-fetch';

// ── Query keys ────────────────────────────────────────────────────────────────
export const getPaymentsQueryKey = () => ['/api/accounts/payments'] as const;
export const getReceiptsQueryKey = () => ['/api/accounts/receipts'] as const;
export const getAccountsFlatQueryKey = () => ['/api/accounts/chart/flat'] as const;
export const getCashBankLedgersQueryKey = () => ['/api/accounts/cash-bank-ledgers'] as const;

// ── Types ─────────────────────────────────────────────────────────────────────
export interface Payment {
  id: number;
  voucherNumber?: string;
  paymentDate: string;
  paidFromLedgerId: number;
  paidFromName?: string;
  paidToLedgerId: number;
  paidToName?: string;
  amount: number;
  narration?: string;
}

export interface Receipt {
  id: number;
  voucherNumber?: string;
  receiptDate: string;
  receivedFromLedgerId: number;
  receivedFromName?: string;
  receivedInLedgerId: number;
  receivedInName?: string;
  amount: number;
  narration?: string;
}

export interface BankDetails {
  bankName?: string;
  accountNumber?: string;
  ifscCode?: string;
  branch?: string;
  accountHolder?: string;
}

export interface AccountFlat {
  id: number;
  name: string;
  type: string;
  code?: string | null;
  parentId?: number | null;
  description?: string | null;
  isSystemGroup?: boolean;
  bankDetails?: BankDetails | null;
}

// ── Payments ──────────────────────────────────────────────────────────────────
export function useListPayments() {
  return useQuery({
    queryKey: getPaymentsQueryKey(),
    queryFn: ({ signal }) => customFetch<Payment[]>('/api/accounts/payments', { signal }),
  });
}

export function useCreatePayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Omit<Payment, 'id' | 'voucherNumber'>) =>
      customFetch<Payment>('/api/accounts/payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: getPaymentsQueryKey() }),
  });
}

export function useDeletePayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => customFetch<void>(`/api/accounts/payments/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: getPaymentsQueryKey() }),
  });
}

// ── Receipts ──────────────────────────────────────────────────────────────────
export function useListReceipts() {
  return useQuery({
    queryKey: getReceiptsQueryKey(),
    queryFn: ({ signal }) => customFetch<Receipt[]>('/api/accounts/receipts', { signal }),
  });
}

export function useCreateReceipt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Omit<Receipt, 'id' | 'voucherNumber'>) =>
      customFetch<Receipt>('/api/accounts/receipts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: getReceiptsQueryKey() }),
  });
}

export function useDeleteReceipt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => customFetch<void>(`/api/accounts/receipts/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: getReceiptsQueryKey() }),
  });
}

// ── Flat account list (for dropdowns) ────────────────────────────────────────
export function useListAccountsFlat() {
  return useQuery({
    queryKey: getAccountsFlatQueryKey(),
    queryFn: ({ signal }) => customFetch<AccountFlat[]>('/api/accounts/chart/flat', { signal }),
  });
}

// ── Cash/Bank ledgers only (for Received In / Paid From dropdowns) ────────────
export function useCashBankLedgersFlat() {
  return useQuery({
    queryKey: getCashBankLedgersQueryKey(),
    queryFn: ({ signal }) => customFetch<AccountFlat[]>('/api/accounts/cash-bank-ledgers', { signal }),
  });
}
