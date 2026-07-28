/**
 * GST Transfers report — cross-GSTIN stock movements that are taxable supplies.
 *
 * Kept deliberately separate from the sales report hooks: everywhere else in the
 * app branch-transfer invoices are excluded from sales figures, and this is the
 * one place the two are meant to be shown side by side.
 */
import { useQuery } from '@tanstack/react-query';
import { customFetch } from './custom-fetch';

export interface GstTransferRow {
  id: number;
  challanNumber: string;
  invoiceNumber: string | null;
  date: string;
  status: string;
  fromName: string;
  toName: string;
  fromGstin: string;
  toGstin: string;
  supplyType: string;
  taxType: string;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  tax: number;
  total: number;
  /** Invoice was reversed by a credit note (transfer rejected after dispatch). */
  creditNoted: boolean;
  /** Receiver's inward invoice exists — i.e. the transfer was received. */
  inwardBooked: boolean;
  /**
   * A tax invoice was raised. False for transfers moved under the older
   * voucher-only treatment — taxable supplies with no invoice behind them,
   * which is why they are kept out of the GST figures.
   */
  invoiced: boolean;
}

export interface GstTransfersResponse {
  from: string;
  to: string;
  /** Real customer sales — what the business actually earned. */
  customerSales: { invoices: number; taxable: number; tax: number; total: number };
  /** Own-stock movements between the company's own GSTINs. */
  branchTransfer: {
    invoices: number; taxable: number;
    cgst: number; sgst: number; igst: number;
    tax: number; total: number;
  };
  /** The two together — reconciles to outward supplies in the GST return. */
  combined: { taxable: number; tax: number; total: number };
  creditNoted: { invoices: number; total: number };
  /**
   * Cross-GSTIN transfers with no tax invoice behind them — historical ones and
   * any moved while invoicing was switched off. Kept out of every figure above,
   * surfaced here so the compliance gap is visible rather than silent.
   */
  notInvoiced: { transfers: number; taxable: number; tax: number; total: number };
  rows: GstTransferRow[];
}

export function useGstTransfersReport(params: { from?: string; to?: string } = {}) {
  const qs = new URLSearchParams();
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  const suffix = qs.size ? `?${qs}` : '';
  return useQuery({
    queryKey: ['/api/reports/gst-transfers', params.from ?? '', params.to ?? ''],
    queryFn: () => customFetch<GstTransfersResponse>(`/api/reports/gst-transfers${suffix}`),
  });
}
