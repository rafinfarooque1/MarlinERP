import { useQuery } from '@tanstack/react-query';
import { customFetch } from './custom-fetch';

/** One product's complete lifecycle — see api-server routes/itemTracking.ts. */
export interface ItemTrackingSummary {
  purchasedQty: number;
  soldQty: number;
  salesReturnQty: number;
  purchaseReturnQty: number;
  transferQty: number;
  producedQty: number;
  consumedQty: number;
  adjustmentQty: number;
  currentStock: number;
  truncated: boolean;
  /** Present only for callers with the inventory-valuation right. */
  avgCost?: number;
  currentValue?: number;
}

export interface ItemTrackingPurchaseRow {
  purchaseId: number;
  invoiceNumber: string;
  vendorName: string;
  purchaseDate: string;
  vendorInvoiceDate: string | null;
  batchNumber: string;
  quantity: number;
  location: string;
  cancelled: boolean;
  isBranchTransfer: boolean;
  /** Omitted without the valuation right. */
  rate?: number | null;
}

export interface ItemTrackingSaleRow {
  saleId: number;
  invoiceNumber: string;
  customerName: string;
  saleDate: string;
  quantity: number;
  /** GROSS (incl. GST) — label accordingly. */
  unitPrice: number;
  discount: number;
  gst: number;
  location: string;
  cancelled: boolean;
  isBranchTransfer: boolean;
}

export interface ItemTrackingSalesReturnRow {
  returnId: number;
  returnNumber: string;
  againstInvoice: string;
  customerName: string;
  returnDate: string;
  quantity: number;
  amount: number;
  location: string;
}

export interface ItemTrackingPurchaseReturnRow {
  returnId: number;
  returnNumber: string;
  againstInvoice: string;
  vendorName: string;
  returnDate: string;
  quantity: number;
  location: string;
}

export interface ItemTrackingTransferRow {
  transferId: number;
  challanNumber: string;
  transferDate: string;
  status: string;
  from: string;
  to: string;
  quantity: number;
}

export interface ItemTrackingProductionRow {
  productionId: number;
  batchNumber: string;
  productionDate: string;
  quantity: number;
  role: 'produced' | 'consumed';
  location: string;
  costPerUnit?: number | null;
}

export interface ItemTrackingAdjustmentRow {
  verificationId: number;
  verifyDate: string;
  location: string;
  countedQty: number | null;
  variance: number;
  reason: string | null;
  createdBy: string | null;
}

export interface ItemTrackingResponse {
  item: {
    id: number;
    materialType: 'item' | 'material' | 'raw_material';
    name: string;
    unit: string;
    hsnCode: string;
    mrp?: number | null;
    itemCode?: string | null;
  };
  summary: ItemTrackingSummary;
  stockByLocation: Array<{ branchType: string; branchId: number; branchName: string; quantity: number }>;
  purchaseHistory: ItemTrackingPurchaseRow[];
  salesHistory: ItemTrackingSaleRow[];
  salesReturns: ItemTrackingSalesReturnRow[];
  purchaseReturns: ItemTrackingPurchaseReturnRow[];
  transfers: ItemTrackingTransferRow[];
  production: ItemTrackingProductionRow[];
  adjustments: ItemTrackingAdjustmentRow[];
  canViewValuation: boolean;
}

export function useItemTracking(params: { materialType: string; itemId: number } | null) {
  return useQuery({
    queryKey: ['/api/item-tracking', params?.materialType ?? '', params?.itemId ?? 0] as const,
    queryFn: ({ signal }) =>
      customFetch<ItemTrackingResponse>(
        `/api/item-tracking?materialType=${encodeURIComponent(params!.materialType)}&itemId=${params!.itemId}`,
        { signal },
      ),
    enabled: params != null,
    placeholderData: (prev) => prev,
  });
}
