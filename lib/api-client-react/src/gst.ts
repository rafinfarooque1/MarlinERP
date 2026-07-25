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

export interface GstReconResponse {
  rows: GstReconRow[];
  dtxDirect: number;
  salesTaxTotal: number;
  salesLumpResidual: number;
  matched: boolean;
  note: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const rangeQs = (fromDate?: string, toDate?: string): string => {
  const p = new URLSearchParams();
  if (fromDate) p.set('fromDate', fromDate);
  if (toDate) p.set('toDate', toDate);
  const s = p.toString();
  return s ? `?${s}` : '';
};

// ── Query keys ────────────────────────────────────────────────────────────────

export const getHsnSummaryQueryKey = (fromDate?: string, toDate?: string) =>
  ['/api/gst/hsn-summary', fromDate ?? '', toDate ?? ''] as const;
export const getGstr1QueryKey = (fromDate?: string, toDate?: string) =>
  ['/api/gst/gstr1', fromDate ?? '', toDate ?? ''] as const;
export const getGstr3bQueryKey = (month: string) => ['/api/gst/gstr3b', month] as const;
export const getGstReconciliationQueryKey = (fromDate?: string, toDate?: string) =>
  ['/api/gst/reconciliation', fromDate ?? '', toDate ?? ''] as const;

// ── Hooks ─────────────────────────────────────────────────────────────────────

export function useGetHsnSummary(params: { fromDate?: string; toDate?: string } = {}) {
  return useQuery({
    queryKey: getHsnSummaryQueryKey(params.fromDate, params.toDate),
    queryFn: ({ signal }) =>
      customFetch<HsnSummaryResponse>(`/api/gst/hsn-summary${rangeQs(params.fromDate, params.toDate)}`, { signal }),
  });
}

export function useGetGstr1(params: { fromDate?: string; toDate?: string } = {}) {
  return useQuery({
    queryKey: getGstr1QueryKey(params.fromDate, params.toDate),
    queryFn: ({ signal }) =>
      customFetch<Gstr1Response>(`/api/gst/gstr1${rangeQs(params.fromDate, params.toDate)}`, { signal }),
  });
}

export function useGetGstr3b(month: string) {
  return useQuery({
    queryKey: getGstr3bQueryKey(month),
    queryFn: ({ signal }) =>
      customFetch<Gstr3bResponse>(`/api/gst/gstr3b?month=${encodeURIComponent(month)}`, { signal }),
    enabled: /^\d{4}-\d{2}$/.test(month),
  });
}

export function useGetGstReconciliation(params: { fromDate?: string; toDate?: string } = {}) {
  return useQuery({
    queryKey: getGstReconciliationQueryKey(params.fromDate, params.toDate),
    queryFn: ({ signal }) =>
      customFetch<GstReconResponse>(`/api/gst/reconciliation${rangeQs(params.fromDate, params.toDate)}`, { signal }),
  });
}
