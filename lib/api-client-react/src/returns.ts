import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { customFetch } from './custom-fetch';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ReturnLineInput {
  lineIndex: number;
  quantity: number;
}

export interface CreateSalesReturnBody {
  saleId: number;
  returnDate: string; // YYYY-MM-DD
  reason?: string;
  lines: ReturnLineInput[];
}

export interface SalesReturnLine {
  lineIndex: number;
  itemId: number;
  itemName?: string;
  quantity: number;
  unitPrice: number;
  lineSubtotal: number;
  cgst: number;
  sgst: number;
  igst: number;
  taxAmount: number;
  lineTotal: number;
  batchRestore?: { batchId: number; batchNumber: string; quantity: number }[];
}

export interface SalesReturn {
  id: number;
  returnNumber: string;
  saleId: number;
  invoiceNumber: string | null;
  customerId: number | null;
  customerName: string | null;
  locationType: string;
  locationId: number;
  returnDate: string;
  lineItems: SalesReturnLine[];
  subtotal: number;
  taxTotal: number;
  totalAmount: number;
  refundMode: 'credit_note' | 'cash';
  creditNoteId: number | null;
  creditNoteNumber: string | null;
  refundPaymentId: number | null;
  reason: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface CreatePurchaseReturnBody {
  purchaseId: number;
  returnDate: string;
  reason?: string;
  lines: ReturnLineInput[];
}

export interface PurchaseReturnLine {
  lineIndex: number;
  materialType: string;
  materialId: number;
  materialName?: string;
  quantity: number;
  unitPrice: number;
  lineSubtotal: number;
  cgst: number;
  sgst: number;
  igst: number;
  taxAmount: number;
  lineTotal: number;
}

export interface PurchaseReturn {
  id: number;
  returnNumber: string;
  purchaseId: number;
  invoiceNumber: string | null;
  vendorId: number | null;
  vendorName: string | null;
  returnDate: string;
  lineItems: PurchaseReturnLine[];
  subtotal: number;
  taxTotal: number;
  totalAmount: number;
  debitNoteId: number | null;
  debitNoteNumber: string | null;
  reason: string | null;
  createdBy: string | null;
  createdAt: string;
}

export type AgingBuckets = { b0_30: number; b31_60: number; b61_90: number; b90p: number };

export interface ReceivableInvoice {
  saleId: number;
  invoiceNumber: string | null;
  saleDate: string;
  dueDate: string;
  daysOverdue: number;
  bucket: keyof AgingBuckets;
  total: number;
  paid: number;
  balance: number;
}

export interface ReceivableCustomer extends AgingBuckets {
  customerId: number;
  name: string;
  phone: string | null;
  creditLimit: number;
  creditDays: number;
  totalDue: number;
  creditNotes: number;
  netDue: number;
  invoices: ReceivableInvoice[];
}

export interface ReceivablesAging {
  asOf: string;
  totals: AgingBuckets & { totalDue: number; creditNotes: number; netDue: number };
  customers: ReceivableCustomer[];
}

export interface PayableBill {
  purchaseId: number;
  invoiceNumber: string | null;
  purchaseDate: string;
  total: number;
  allocated: number;
  balance: number;
  daysOld: number;
  bucket: keyof AgingBuckets;
}

export interface PayableVendor extends AgingBuckets {
  vendorId: number;
  name: string;
  phone: string | null;
  totalBilled: number;
  totalPaid: number;
  debitNotes: number;
  netDue: number;
  unallocatedCredit: number;
  bills: PayableBill[];
}

export interface PayablesAging {
  asOf: string;
  totals: AgingBuckets & { totalDue: number };
  vendors: PayableVendor[];
}

export interface CollectionItem {
  saleId: number;
  invoiceNumber: string | null;
  saleDate: string;
  dueDate: string;
  daysOverdue: number;
  customerId: number | null;
  customerName: string | null;
  customerPhone: string | null;
  locationType: string;
  locationId: number;
  totalAmount: number;
  amountPaid: number;
  balanceDue: number;
  paymentStatus: string;
}

export interface CollectionsResponse {
  asOf: string;
  items: CollectionItem[];
}

// ── Query keys ────────────────────────────────────────────────────────────────

export const getSalesReturnsQueryKey = () => ['/api/sales-returns'] as const;
export const getPurchaseReturnsQueryKey = () => ['/api/purchase-returns'] as const;
export const getReceivablesAgingQueryKey = () => ['/api/outstanding/receivables'] as const;
export const getPayablesAgingQueryKey = () => ['/api/outstanding/payables'] as const;
export const getCollectionsQueryKey = () => ['/api/outstanding/collections'] as const;

// ── Hooks ─────────────────────────────────────────────────────────────────────

export function useListSalesReturns(saleId?: number) {
  return useQuery({
    queryKey: saleId ? ([...getSalesReturnsQueryKey(), saleId] as const) : getSalesReturnsQueryKey(),
    queryFn: () => customFetch<SalesReturn[]>(`/api/sales-returns${saleId ? `?saleId=${saleId}` : ''}`),
  });
}

export function useCreateSalesReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateSalesReturnBody) =>
      customFetch<SalesReturn>('/api/sales-returns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getSalesReturnsQueryKey() });
      qc.invalidateQueries({ queryKey: getReceivablesAgingQueryKey() });
      qc.invalidateQueries({ queryKey: getCollectionsQueryKey() });
      qc.invalidateQueries({ queryKey: ['/api/sales'] });
      qc.invalidateQueries({ queryKey: ['/api/customers'] });
    },
  });
}

export function useListPurchaseReturns(purchaseId?: number) {
  return useQuery({
    queryKey: purchaseId ? ([...getPurchaseReturnsQueryKey(), purchaseId] as const) : getPurchaseReturnsQueryKey(),
    queryFn: () => customFetch<PurchaseReturn[]>(`/api/purchase-returns${purchaseId ? `?purchaseId=${purchaseId}` : ''}`),
  });
}

export function useCreatePurchaseReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreatePurchaseReturnBody) =>
      customFetch<PurchaseReturn>('/api/purchase-returns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getPurchaseReturnsQueryKey() });
      qc.invalidateQueries({ queryKey: getPayablesAgingQueryKey() });
      qc.invalidateQueries({ queryKey: ['/api/purchases'] });
    },
  });
}

export function useReceivablesAging() {
  return useQuery({
    queryKey: getReceivablesAgingQueryKey(),
    queryFn: () => customFetch<ReceivablesAging>('/api/outstanding/receivables'),
  });
}

export function usePayablesAging() {
  return useQuery({
    queryKey: getPayablesAgingQueryKey(),
    queryFn: () => customFetch<PayablesAging>('/api/outstanding/payables'),
  });
}

export function useCollections() {
  return useQuery({
    queryKey: getCollectionsQueryKey(),
    queryFn: () => customFetch<CollectionsResponse>('/api/outstanding/collections'),
  });
}
