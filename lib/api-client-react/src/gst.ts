import { useQuery } from '@tanstack/react-query';
import { customFetch } from './custom-fetch';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HsnSummaryRow {
  hsnCode: string;
  taxRate: number;
  unit: string;
  quantity: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  taxAmount: number;
}

export interface HsnSummaryResponse {
  outward: HsnSummaryRow[];
  inward: HsnSummaryRow[];
  totals: {
    outward: { taxableValue: number; taxAmount: number };
    inward: { taxableValue: number; taxAmount: number };
  };
}

export interface Gstr1B2bRow {
  invoiceNumber: string;
  saleDate: string;
  customerName: string;
  gstin: string;
  placeOfSupply: string;
  invoiceValue: number;
  taxRate: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  taxAmount: number;
  isBranchTransfer?: boolean;
  warehouseName?: string;
  paymentStatus?: string;
  paymentModes?: string;
}

/** Invoice-wise B2C row — B2B shape minus GSTIN (unregistered buyers). */
export interface Gstr1B2cRow {
  invoiceNumber: string;
  saleDate: string;
  customerName: string;
  placeOfSupply: string;
  invoiceValue: number;
  taxRate: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  taxAmount: number;
  isBranchTransfer?: boolean;
  warehouseName?: string;
  paymentStatus?: string;
  paymentModes?: string;
}

export interface Gstr1B2csRow {
  placeOfSupply: string;
  taxRate: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  taxAmount: number;
}

export interface Gstr1Response {
  b2b: Gstr1B2bRow[];
  /** Invoice-wise B2C detail behind the aggregated b2cs table. */
  b2c: Gstr1B2cRow[];
  b2cs: Gstr1B2csRow[];
  totals: {
    invoiceCount: number;
    b2bInvoices: number;
    b2cInvoices: number;
    taxableValue: number;
    cgst: number;
    sgst: number;
    igst: number;
    taxAmount: number;
    invoiceValue: number;
  };
}

export interface GstHeads {
  cgst: number;
  sgst: number;
  igst: number;
}

export interface Gstr3bResponse {
  month: string;
  fromDate: string;
  toDate: string;
  outwardSupplies: GstHeads & { taxableValue: number; totalTax: number };
  nilRatedSupplies: { taxableValue: number };
  itc: GstHeads & { totalItc: number };
  netPayable: GstHeads & { total: number };
  itcCarriedForward: GstHeads & { total: number };
  counts: { sales: number; purchases: number };
}

export interface GstReconRow {
  head: string;
  ledgerCode: string;
  ledgerAmount: number;
  registerAmount: number;
  difference: number;
}

export interface GstReconHeads {
  cgst: number;
  sgst: number;
  igst: number;
}

/** A document whose ledger postings differ from its register tax heads. */
export interface GstReconMismatchDoc {
  docType: 'sale' | 'purchase';
  id: number;
  documentNumber: string;
  date: string;
  partyName: string;
  cancelled: boolean;
  isBranchTransfer: boolean;
  ledger: GstReconHeads;
  register: GstReconHeads;
  difference: GstReconHeads;
  differenceTotal: number;
  dtxAmount: number;
  reason: string;
}

/** A non-document posting (journal voucher…) on a GST head ledger. */
export interface GstReconOtherEntry {
  entryId: string;
  source: string;
  voucherNumber: string | null;
  date: string;
  description: string;
  head: string;
  ledgerCode: string;
  amount: number;
}

export interface GstReconResponse {
  rows: GstReconRow[];
  dtxDirect: number;
  salesTaxTotal: number;
  salesLumpResidual: number;
  matched: boolean;
  note: string;
  mismatchDocs: { outward: GstReconMismatchDoc[]; inward: GstReconMismatchDoc[] };
  otherEntries: GstReconOtherEntry[];
  checked: {
    sales: number;
    purchases: number;
    salesMismatched: number;
    purchasesMismatched: number;
  };
}

export interface GstScopeParams {
  fromDate?: string;
  toDate?: string;
  /** Filter to documents under one GST registration. */
  gstin?: string;
  /** Narrow further to one warehouse (and its outlets) under that GSTIN. */
  warehouseId?: number;
}

export interface GstinGroup {
  gstin: string;
  warehouses: Array<{ id: number; name: string }>;
  includesHeadOffice: boolean;
}

export interface GstFiltersResponse {
  gstins: GstinGroup[];
}

export interface GstDocumentRow {
  docType: 'sale' | 'purchase';
  documentNumber: string;
  date: string;
  partyName: string;
  partyGstin: string;
  warehouseName: string;
  isBranchTransfer: boolean;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  taxAmount: number;
  invoiceValue: number;
  paymentStatus: string;
  paymentModes: string;
}

export interface GstDocumentsResponse {
  outward: GstDocumentRow[];
  inward: GstDocumentRow[];
  totals: {
    outward: { count: number; taxableValue: number; taxAmount: number; invoiceValue: number };
    inward: { count: number; taxableValue: number; taxAmount: number; invoiceValue: number };
  };
}

export interface GstSummaryRateRow {
  taxRate: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  taxAmount: number;
  estimated?: boolean;
}

export interface GstSummaryResponse {
  totalSales: number;
  totalTaxCollected: number;
  totalPurchases: number;
  totalTaxPaid: number;
  netGstLiability: number;
  monthWise: Array<{ month: string; outputTaxable: number; outputTax: number; inputTaxable: number; inputTax: number; netGst: number }>;
  salesByRate: GstSummaryRateRow[];
  purchasesByRate: GstSummaryRateRow[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const scopeQs = (p: GstScopeParams): string => {
  const q = new URLSearchParams();
  if (p.fromDate) q.set('fromDate', p.fromDate);
  if (p.toDate) q.set('toDate', p.toDate);
  if (p.gstin) q.set('gstin', p.gstin);
  if (p.warehouseId) q.set('warehouseId', String(p.warehouseId));
  const s = q.toString();
  return s ? `?${s}` : '';
};

const scopeKey = (p: GstScopeParams) =>
  [p.fromDate ?? '', p.toDate ?? '', p.gstin ?? '', p.warehouseId ?? 0] as const;

// ── Query keys ────────────────────────────────────────────────────────────────

export const getHsnSummaryQueryKey = (p: GstScopeParams = {}) =>
  ['/api/gst/hsn-summary', ...scopeKey(p)] as const;
export const getGstr1QueryKey = (p: GstScopeParams = {}) =>
  ['/api/gst/gstr1', ...scopeKey(p)] as const;
export const getGstr3bQueryKey = (month: string, p: GstScopeParams = {}) =>
  ['/api/gst/gstr3b', month, p.gstin ?? '', p.warehouseId ?? 0] as const;
export const getGstReconciliationQueryKey = (fromDate?: string, toDate?: string) =>
  ['/api/gst/reconciliation', fromDate ?? '', toDate ?? ''] as const;
export const getGstFiltersQueryKey = () => ['/api/gst/filters'] as const;
export const getGstDocumentsQueryKey = (p: GstScopeParams = {}) =>
  ['/api/gst/documents', ...scopeKey(p)] as const;
export const getGstSummaryScopedQueryKey = (p: GstScopeParams = {}) =>
  ['/api/gst/summary', ...scopeKey(p)] as const;

// ── Hooks ─────────────────────────────────────────────────────────────────────

export function useGetHsnSummary(params: GstScopeParams = {}) {
  return useQuery({
    queryKey: getHsnSummaryQueryKey(params),
    queryFn: ({ signal }) =>
      customFetch<HsnSummaryResponse>(`/api/gst/hsn-summary${scopeQs(params)}`, { signal }),
  });
}

export function useGetGstr1(params: GstScopeParams = {}) {
  return useQuery({
    queryKey: getGstr1QueryKey(params),
    queryFn: ({ signal }) =>
      customFetch<Gstr1Response>(`/api/gst/gstr1${scopeQs(params)}`, { signal }),
  });
}

export function useGetGstr3b(month: string, params: GstScopeParams = {}) {
  const q = new URLSearchParams({ month });
  if (params.gstin) q.set('gstin', params.gstin);
  if (params.warehouseId) q.set('warehouseId', String(params.warehouseId));
  return useQuery({
    queryKey: getGstr3bQueryKey(month, params),
    queryFn: ({ signal }) =>
      customFetch<Gstr3bResponse>(`/api/gst/gstr3b?${q.toString()}`, { signal }),
    enabled: /^\d{4}-\d{2}$/.test(month),
  });
}

export function useGetGstFilters() {
  return useQuery({
    queryKey: getGstFiltersQueryKey(),
    queryFn: ({ signal }) => customFetch<GstFiltersResponse>('/api/gst/filters', { signal }),
  });
}

export function useGetGstDocuments(params: GstScopeParams = {}) {
  return useQuery({
    queryKey: getGstDocumentsQueryKey(params),
    queryFn: ({ signal }) =>
      customFetch<GstDocumentsResponse>(`/api/gst/documents${scopeQs(params)}`, { signal }),
  });
}

/** GST Summary with GSTIN/warehouse scoping (supersedes the generated hook). */
export function useGetGstSummaryScoped(params: GstScopeParams = {}) {
  return useQuery({
    queryKey: getGstSummaryScopedQueryKey(params),
    queryFn: ({ signal }) =>
      customFetch<GstSummaryResponse>(`/api/gst/summary${scopeQs(params)}`, { signal }),
  });
}

export function useGetGstReconciliation(params: { fromDate?: string; toDate?: string } = {}) {
  return useQuery({
    queryKey: getGstReconciliationQueryKey(params.fromDate, params.toDate),
    queryFn: ({ signal }) =>
      customFetch<GstReconResponse>(`/api/gst/reconciliation${scopeQs({ fromDate: params.fromDate, toDate: params.toDate })}`, { signal }),
  });
}
