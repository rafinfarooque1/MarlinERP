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

/** Edit an existing return: date, reason and line quantities (source bill fixed). */
export interface UpdateReturnBody {
  id: number;
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
  /** Aged invoice balances only — what the buckets add up to. */
  totalDue: number;
  creditNotes: number;
  /** The customer's account balance. Absent when the report is invoice-based. */
  ledgerBalance?: number;
  /** Ledger balance with no invoice behind it. */
  uninvoicedBalance?: number;
  /** Invoiced more than the ledger says is owed — an unallocated credit. */
  unallocatedCredit?: number;
  /** The control figure: the ledger balance when head office, else totalDue−creditNotes. */
  netDue: number;
  invoices: ReceivableInvoice[];
}

export interface ReceivablesAging {
  asOf: string;
  /** "ledger" when netDue is anchored to Sundry Debtors, "invoices" when location-scoped. */
  basis?: 'ledger' | 'invoices';
  totals: AgingBuckets & { totalDue: number; creditNotes: number; uninvoiced?: number; netDue: number };
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
  /** The vendor's account balance — negative when we are in advance. */
  ledgerBalance?: number;
  /** Ledger balance with no bill behind it. */
  unbilledBalance?: number;
  /** Billed more than the ledger says is owed — an unallocated credit. */
  unallocatedCredit: number;
  /** The control figure: the vendor's ledger balance. */
  netDue: number;
  bills: PayableBill[];
}

export interface PayablesAging {
  asOf: string;
  totals: AgingBuckets & { totalDue: number; debitNotes?: number; unbilled?: number; netDue: number };
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
export const getReceivablesAgingQueryKey = (asOf?: string) =>
  asOf ? (['/api/outstanding/receivables', asOf] as const) : (['/api/outstanding/receivables'] as const);
export const getPayablesAgingQueryKey = (asOf?: string) =>
  asOf ? (['/api/outstanding/payables', asOf] as const) : (['/api/outstanding/payables'] as const);
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

export function useUpdateSalesReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateReturnBody) =>
      customFetch<SalesReturn>(`/api/sales-returns/${id}`, {
        method: 'PATCH',
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

export function useUpdatePurchaseReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateReturnBody) =>
      customFetch<PurchaseReturn>(`/api/purchase-returns/${id}`, {
        method: 'PATCH',
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

/**
 * @param asOf optional YYYY-MM-DD — prices the report at that date (bills,
 * payments and credit notes capped there), matching a Balance Sheet dated the
 * same day. Omit for today.
 */
export function useReceivablesAging(asOf?: string) {
  return useQuery({
    queryKey: getReceivablesAgingQueryKey(asOf),
    queryFn: () => customFetch<ReceivablesAging>(`/api/outstanding/receivables${asOf ? `?asOf=${asOf}` : ''}`),
  });
}

/** Same `asOf` contract as {@link useReceivablesAging}. */
export function usePayablesAging(asOf?: string) {
  return useQuery({
    queryKey: getPayablesAgingQueryKey(asOf),
    queryFn: () => customFetch<PayablesAging>(`/api/outstanding/payables${asOf ? `?asOf=${asOf}` : ''}`),
  });
}

export function useCollections() {
  return useQuery({
    queryKey: getCollectionsQueryKey(),
    queryFn: () => customFetch<CollectionsResponse>('/api/outstanding/collections'),
  });
}
