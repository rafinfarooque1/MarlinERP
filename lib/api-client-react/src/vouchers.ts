import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { customFetch } from './custom-fetch';

// ── Query keys ────────────────────────────────────────────────────────────────
export const getPaymentsQueryKey = () => ['/api/accounts/payments'] as const;
export const getReceiptsQueryKey = () => ['/api/accounts/receipts'] as const;
export const getAccountsFlatQueryKey = () => ['/api/accounts/chart/flat'] as const;
export const getCashBankLedgersQueryKey = () => ['/api/accounts/cash-bank-ledgers'] as const;
export const getSettlementContextQueryKey = (ledgerId: number) =>
  ['/api/accounts/settlement-context', ledgerId] as const;
export const getPartyAdvanceQueryKey = (kind: 'customer' | 'vendor', partyId: number) =>
  ['/api/accounts/party-advance', kind, partyId] as const;

// ── Types ─────────────────────────────────────────────────────────────────────
/** Instrument modes a manual voucher may record (metadata only). */
export type VoucherPaymentMode = 'cash' | 'upi' | 'bank' | 'card' | 'cheque' | 'neft' | 'rtgs';

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
  paymentMode?: VoucherPaymentMode | null;
  referenceNumber?: string | null;
  attachmentUrl?: string | null;
  createdBy?: string | null;
  /** 'system' rows are owned by another module (expenses, sale refunds) and locked. */
  origin?: 'manual' | 'system';
  editable?: boolean;
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
  paymentMode?: VoucherPaymentMode | null;
  referenceNumber?: string | null;
  attachmentUrl?: string | null;
  createdBy?: string | null;
  /** 'system' rows are raised by sales and locked. */
  origin?: 'manual' | 'system';
  editable?: boolean;
}

// ── Bill-wise settlement ──────────────────────────────────────────────────────
/** One bill-targeted slice of a receipt voucher (customer side). */
export interface SaleAllocationInput {
  saleId: number;
  amount: number;
}

/** One bill-targeted slice of a payment voucher (vendor side). */
export interface PurchaseAllocationInput {
  purchaseId: number;
  amount: number;
}

export interface SettlementBill {
  saleId?: number;
  purchaseId?: number;
  invoiceNumber: string | null;
  billDate: string;
  total: number;
  due: number;
}

export interface SettlementContext {
  kind: 'customer' | 'vendor' | null;
  partyId: number | null;
  partyName?: string;
  bills: SettlementBill[];
  advance: { available: number };
}

export interface PartyAdvance {
  kind: 'customer' | 'vendor';
  partyId: number;
  available: number;
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
  /** cash / bank / upi when the ledger is backed by a Cash & Bank account row. */
  accountType?: string | null;
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
    mutationFn: (
      data: Omit<Payment, 'id' | 'voucherNumber'> & {
        allocations?: PurchaseAllocationInput[];
        advanceAmount?: number;
      },
    ) =>
      customFetch<Payment & { allocations?: PurchaseAllocationInput[]; advanceAmount?: number }>(
        '/api/accounts/payments',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getPaymentsQueryKey() });
      qc.invalidateQueries({ queryKey: ['/api/accounts/settlement-context'] });
      qc.invalidateQueries({ queryKey: ['/api/accounts/party-advance'] });
    },
  });
}

export function useUpdatePayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: number } & Partial<Omit<Payment, 'id' | 'voucherNumber'>>) =>
      customFetch<Payment>(`/api/accounts/payments/${id}`, {
        method: 'PATCH',
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getPaymentsQueryKey() });
      // Deleting an allocation voucher reopens bills and can restore an
      // advance — the settlement caches must not drive the next form stale.
      qc.invalidateQueries({ queryKey: ['/api/accounts/settlement-context'] });
      qc.invalidateQueries({ queryKey: ['/api/accounts/party-advance'] });
    },
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
    mutationFn: (
      data: Omit<Receipt, 'id' | 'voucherNumber'> & {
        allocations?: SaleAllocationInput[];
        advanceAmount?: number;
      },
    ) =>
      customFetch<Receipt & { allocations?: SaleAllocationInput[]; advanceAmount?: number }>(
        '/api/accounts/receipts',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getReceiptsQueryKey() });
      qc.invalidateQueries({ queryKey: ['/api/accounts/settlement-context'] });
      qc.invalidateQueries({ queryKey: ['/api/accounts/party-advance'] });
    },
  });
}

export function useUpdateReceipt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: number } & Partial<Omit<Receipt, 'id' | 'voucherNumber'>>) =>
      customFetch<Receipt>(`/api/accounts/receipts/${id}`, {
        method: 'PATCH',
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getReceiptsQueryKey() });
      // Same reason as useDeletePayment: an unwound allocation changes bill
      // dues and advance availability.
      qc.invalidateQueries({ queryKey: ['/api/accounts/settlement-context'] });
      qc.invalidateQueries({ queryKey: ['/api/accounts/party-advance'] });
    },
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

// ── Bill-wise settlement context (voucher forms) ─────────────────────────────
/** Open bills + advance position for a party ledger; empty context for non-party ledgers. */
export function useSettlementContext(ledgerId: number | null | undefined) {
  return useQuery({
    queryKey: getSettlementContextQueryKey(ledgerId ?? 0),
    queryFn: ({ signal }) =>
      customFetch<SettlementContext>(
        `/api/accounts/settlement-context?ledgerId=${ledgerId}`,
        { signal },
      ),
    enabled: !!ledgerId && ledgerId > 0,
  });
}

/** The party's adjustable advance balance (sale / purchase forms). */
export function usePartyAdvance(
  kind: 'customer' | 'vendor',
  partyId: number | null | undefined,
) {
  return useQuery({
    queryKey: getPartyAdvanceQueryKey(kind, partyId ?? 0),
    queryFn: ({ signal }) =>
      customFetch<PartyAdvance>(
        `/api/accounts/party-advance?kind=${kind}&partyId=${partyId}`,
        { signal },
      ),
    enabled: !!partyId && partyId > 0,
  });
}
