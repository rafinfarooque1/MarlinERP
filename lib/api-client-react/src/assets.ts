/**
 * Manual hooks for the Asset Management module.
 *
 * The asset endpoints live outside the generated OpenAPI client (their columns
 * were added by a startup migration the spec never saw), so everything here is
 * hand-written against customFetch. Invoice uploads reuse uploadAttachment /
 * attachmentViewUrl from ./expenses.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { customFetch } from './custom-fetch';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AssetCategory {
  id: number;
  name: string;
  status: 'active' | 'inactive';
  assetCount?: number;
  createdAt?: string;
}

export type AssetStatus = 'active' | 'sold' | 'scrapped' | 'written_off' | 'transferred_outside';
export type AssetPaymentMode = 'cash' | 'bank' | 'upi' | 'credit';
export type AssetPaymentStatus = 'paid' | 'unpaid' | 'partial';
export type AssetDisposalType = Exclude<AssetStatus, 'active'>;

export interface AssetPurchase {
  id: number;
  assetCode: string;
  assetId: number;
  assetName: string;
  assetUnit?: string;
  categoryId: number | null;
  categoryName: string;
  quantity: number;
  acquisitionCost: number;
  gstRate: number;
  gstAmount: number;
  totalCost: number;
  vendorId: number | null;
  vendorName: string;
  purchaseDate: string;
  invoiceNumber: string | null;
  paymentMode: AssetPaymentMode;
  paymentStatus: AssetPaymentStatus;
  warrantyStart: string | null;
  warrantyEnd: string | null;
  serialNumber: string | null;
  assetTag: string | null;
  usefulLifeMonths: number | null;
  notes: string | null;
  attachmentPath: string | null;
  status: AssetStatus;
  locationType: string;
  locationId: number;
  locationName: string;
  currentLocationType: string;
  currentLocationId: number;
  currentLocationName: string;
  journalVoucherId?: number | null;
  voucherNumber: string | null;
  createdBy?: string | null;
  createdAt?: string;
}

export interface AssetPurchaseFilters {
  q?: string;
  fromDate?: string;
  toDate?: string;
  locationType?: string;
  locationId?: number | string;
  categoryId?: number | string;
  vendorId?: number | string;
  status?: string;
  /** 'current' (register, default) or 'purchase' (purchase report). */
  locationBasis?: 'current' | 'purchase';
}

export interface CreateAssetPurchaseBody {
  assetId?: number;
  assetName?: string;
  assetUnit?: string;
  categoryId: number;
  purchaseDate: string;
  invoiceNumber?: string;
  vendorId?: number | null;
  locationType?: string;
  locationId?: number;
  quantity: number;
  acquisitionCost: number;
  gstRate?: number;
  gstAmount?: number;
  paymentMode: AssetPaymentMode;
  paymentStatus?: AssetPaymentStatus;
  warrantyStart?: string | null;
  warrantyEnd?: string | null;
  serialNumber?: string | null;
  assetTag?: string | null;
  usefulLifeMonths?: number | null;
  notes?: string | null;
  attachmentPath?: string | null;
}

export type UpdateAssetPurchaseBody = Partial<Pick<CreateAssetPurchaseBody,
  'categoryId' | 'invoiceNumber' | 'serialNumber' | 'assetTag' | 'notes' |
  'warrantyStart' | 'warrantyEnd' | 'usefulLifeMonths' | 'paymentStatus' | 'attachmentPath'>>;

export interface AssetTransfer {
  id: number;
  assetPurchaseId: number;
  assetCode: string;
  assetName: string;
  fromType: string;
  fromId: number;
  fromName: string;
  toType: string;
  toId: number;
  toName: string;
  transferDate: string;
  approvedBy: string | null;
  reason: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface AssetDisposal {
  id: number;
  assetPurchaseId: number;
  assetCode: string;
  assetName: string;
  disposalType: AssetDisposalType;
  disposalDate: string;
  reason: string | null;
  amount?: number | null;
  totalCost?: number;
  locationType?: string;
  locationId?: number;
  locationName?: string;
  createdBy: string | null;
  createdAt: string;
}

export interface AssetSummary {
  totalAssets: number;
  activeAssets: number;
  disposedAssets: number;
  assetValue: number;
  purchasedThisMonth: { count: number; value: number };
  byLocation: { locationType: string; locationId: number; name: string; count: number; value: number }[];
  warrantyExpiringSoon: {
    withinDays: number;
    count: number;
    items: { id: number; assetCode: string; assetName: string; warrantyEnd: string }[];
  };
}

// ── Query keys ────────────────────────────────────────────────────────────────

const BASE = ['/api/assets'] as const;
export const assetCategoriesKey = () => [...BASE, 'categories'] as const;
export const assetPurchasesKey = (filters?: AssetPurchaseFilters) =>
  [...BASE, 'purchases', filters ?? {}] as const;
export const assetTransfersKey = (params?: Record<string, unknown>) =>
  [...BASE, 'transfers', params ?? {}] as const;
export const assetDisposalsKey = (params?: Record<string, unknown>) =>
  [...BASE, 'disposals', params ?? {}] as const;
export const assetSummaryKey = () => [...BASE, 'summary'] as const;

/** Hook-level names → wire query params. The server's shared parseDateRange
 * convention is `from`/`to`, while the hooks expose `fromDate`/`toDate`. */
const WIRE_PARAM: Record<string, string> = { fromDate: 'from', toDate: 'to' };

function qs(params: Record<string, unknown> | undefined): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v == null || v === '') continue;
    sp.set(WIRE_PARAM[k] ?? k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

// ── Categories ────────────────────────────────────────────────────────────────

export function useAssetCategories() {
  return useQuery({
    queryKey: assetCategoriesKey(),
    queryFn: ({ signal }) => customFetch<AssetCategory[]>('/api/assets/categories', { signal }),
  });
}

export function useCreateAssetCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string }) =>
      customFetch<AssetCategory>('/api/assets/categories', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: BASE }),
  });
}

export function useUpdateAssetCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: number; name?: string; status?: string }) =>
      customFetch<AssetCategory>(`/api/assets/categories/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: BASE }),
  });
}

// ── Purchases / register ──────────────────────────────────────────────────────

export function useAssetPurchases(filters?: AssetPurchaseFilters) {
  return useQuery({
    queryKey: assetPurchasesKey(filters),
    queryFn: ({ signal }) =>
      customFetch<AssetPurchase[]>(`/api/assets/purchases${qs(filters as Record<string, unknown>)}`, { signal }),
    placeholderData: (prev) => prev,
  });
}

export function useCreateAssetPurchase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAssetPurchaseBody) =>
      customFetch<AssetPurchase>('/api/assets/purchases', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: BASE }),
  });
}

export function useUpdateAssetPurchase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateAssetPurchaseBody & { id: number }) =>
      customFetch<AssetPurchase>(`/api/assets/purchases/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: BASE }),
  });
}

export function useDeleteAssetPurchase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      customFetch<void>(`/api/assets/purchases/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: BASE }),
  });
}

// ── Transfers ─────────────────────────────────────────────────────────────────

export function useAssetTransfers(params?: { fromDate?: string; toDate?: string; assetPurchaseId?: number }) {
  return useQuery({
    queryKey: assetTransfersKey(params),
    queryFn: ({ signal }) =>
      customFetch<AssetTransfer[]>(`/api/assets/transfers${qs(params)}`, { signal }),
    placeholderData: (prev) => prev,
  });
}

export function useCreateAssetTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      assetPurchaseId: number; toType: string; toId: number;
      transferDate: string; approvedBy?: string; reason?: string;
    }) =>
      customFetch<AssetTransfer>('/api/assets/transfers', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: BASE }),
  });
}

// ── Disposals ─────────────────────────────────────────────────────────────────

export function useAssetDisposals(params?: { fromDate?: string; toDate?: string; assetPurchaseId?: number }) {
  return useQuery({
    queryKey: assetDisposalsKey(params),
    queryFn: ({ signal }) =>
      customFetch<AssetDisposal[]>(`/api/assets/disposals${qs(params)}`, { signal }),
    placeholderData: (prev) => prev,
  });
}

export function useCreateAssetDisposal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      assetPurchaseId: number; disposalType: AssetDisposalType;
      disposalDate: string; reason?: string;
    }) =>
      customFetch<AssetDisposal>('/api/assets/disposals', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: BASE }),
  });
}

// ── Summary (dashboard cards) ─────────────────────────────────────────────────

export function useAssetSummary(enabled = true) {
  return useQuery({
    queryKey: assetSummaryKey(),
    queryFn: ({ signal }) => customFetch<AssetSummary>('/api/assets/summary', { signal }),
    enabled,
  });
}
