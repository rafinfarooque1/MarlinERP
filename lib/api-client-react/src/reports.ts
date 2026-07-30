/**
 * Reports Center hooks — Phase 6.
 *
 * Wraps the /api/reports/* aggregation endpoints. All accept an optional
 * inclusive date range (YYYY-MM-DD).
 */
import { useQuery } from '@tanstack/react-query';
import { customFetch } from './custom-fetch';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DateRangeParams {
  from?: string;
  to?: string;
}

export interface SalesRegisterRow {
  id: number;
  invoiceNumber: string;
  date: string;
  locationType: string;
  locationId: number;
  locationName: string;
  customerName: string;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  paid: number;
  balance: number;
  paymentMode: string;
  paymentStatus: string;
}

export interface SalesRegisterResponse {
  rows: SalesRegisterRow[];
  totals: { invoices: number; subtotal: number; discount: number; tax: number; total: number; paid: number; balance: number };
}

export interface SalesByItemRow {
  itemId: number;
  itemName: string;
  unit: string;
  invoices: number;
  qty: number;
  taxable: number;
  tax: number;
  total: number;
}

export interface SalesByItemResponse {
  rows: SalesByItemRow[];
  totals: { items: number; qty: number; taxable: number; tax: number; total: number };
}

export interface SalesByLocationRow {
  locationType: string;
  locationId: number;
  locationName: string;
  invoices: number;
  taxable: number;
  tax: number;
  total: number;
  paid: number;
  outstanding: number;
}

export interface SalesByLocationResponse {
  rows: SalesByLocationRow[];
  totals: { invoices: number; taxable: number; tax: number; total: number; paid: number; outstanding: number };
}

export interface DiscountReportRow {
  id: number;
  invoiceNumber: string;
  date: string;
  locationType: string;
  locationId: number;
  locationName: string;
  customerName: string;
  couponCode: string;
  paymentMode: string;
  /** Pre-discount value (subtotal + tax + item discounts). */
  gross: number;
  /** Σ per-line ₹ discounts (netted into taxable at sale time). */
  itemDiscount: number;
  /** Bill-level (coupon) discount subtracted after tax. */
  billDiscount: number;
  totalDiscount: number;
  /** Final invoice total. */
  net: number;
  discountPct: number;
}

export interface DiscountReportResponse {
  rows: DiscountReportRow[];
  totals: {
    invoices: number;
    allInvoices: number;
    gross: number;
    itemDiscount: number;
    billDiscount: number;
    totalDiscount: number;
    net: number;
    discountPct: number;
  };
}

export interface PurchaseRegisterRow {
  id: number;
  billNumber: string;
  date: string;
  vendorId: number | null;
  vendorName: string;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
}

export interface PurchaseRegisterResponse {
  rows: PurchaseRegisterRow[];
  totals: { bills: number; subtotal: number; discount: number; tax: number; total: number };
}

export interface PurchasesByVendorRow {
  vendorId: number | null;
  vendorName: string;
  bills: number;
  taxable: number;
  tax: number;
  total: number;
}

export interface PurchasesByVendorResponse {
  rows: PurchasesByVendorRow[];
  totals: { vendors: number; bills: number; taxable: number; tax: number; total: number };
}

export interface PurchasesByMaterialRow {
  materialType: string;
  materialTypeLabel: string;
  materialId: number;
  materialName: string;
  unit: string;
  bills: number;
  qty: number;
  taxable: number;
  tax: number;
  total: number;
}

export interface PurchasesByMaterialResponse {
  rows: PurchasesByMaterialRow[];
  totals: { materials: number; taxable: number; tax: number; total: number };
}

export interface ProfitabilityRow {
  label: string;
  unit: string;
  qty: number;
  revenue: number;
  cogs: number;
  grossProfit: number;
  marginPct: number;
  /** Quantity that had no batch cost and was costed at the item average. */
  estimatedCostQty: number;
}

export interface ProfitabilityResponse {
  groupBy: 'item' | 'location';
  rows: ProfitabilityRow[];
  totals: { revenue: number; cogs: number; grossProfit: number; marginPct: number };
}

export interface SalesStockCombinedResponse {
  period: { from: string | null; to: string | null };
  sales: { invoices: number; revenue: number; tax: number; collected: number; outstanding: number };
  salesByLocation: { locationType: string; locationName: string; invoices: number; revenue: number }[];
  topItems: { itemName: string; unit: string; qty: number; revenue: number }[];
  /** `stockValue` is omitted server-side for roles without the valuation right. */
  stockByLocation: { locationType: string; locationName: string; skus: number; totalQty: number; stockValue?: number }[];
  stockValueTotal?: number;
  /** False when the server withheld the money fields above. */
  canViewValuation: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildQs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '' && v !== 0) p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

export function useSalesRegister(params: DateRangeParams & { locationType?: string; locationId?: number } = {}) {
  const qs = buildQs({ ...params });
  return useQuery({
    queryKey: ['/api/reports/sales-register', qs],
    queryFn: () => customFetch<SalesRegisterResponse>(`/api/reports/sales-register${qs}`),
  });
}

export function useSalesByItem(params: DateRangeParams = {}) {
  const qs = buildQs({ ...params });
  return useQuery({
    queryKey: ['/api/reports/sales-by-item', qs],
    queryFn: () => customFetch<SalesByItemResponse>(`/api/reports/sales-by-item${qs}`),
  });
}

export function useSalesByLocation(params: DateRangeParams = {}) {
  const qs = buildQs({ ...params });
  return useQuery({
    queryKey: ['/api/reports/sales-by-location', qs],
    queryFn: () => customFetch<SalesByLocationResponse>(`/api/reports/sales-by-location${qs}`),
  });
}

export function useDiscountReport(params: DateRangeParams & { locationType?: string; locationId?: number } = {}) {
  const qs = buildQs({ ...params });
  return useQuery({
    queryKey: ['/api/reports/discounts', qs],
    queryFn: () => customFetch<DiscountReportResponse>(`/api/reports/discounts${qs}`),
  });
}

export function usePurchaseRegister(params: DateRangeParams & { vendorId?: number } = {}) {
  const qs = buildQs({ ...params });
  return useQuery({
    queryKey: ['/api/reports/purchase-register', qs],
    queryFn: () => customFetch<PurchaseRegisterResponse>(`/api/reports/purchase-register${qs}`),
  });
}

export function usePurchasesByVendor(params: DateRangeParams = {}) {
  const qs = buildQs({ ...params });
  return useQuery({
    queryKey: ['/api/reports/purchases-by-vendor', qs],
    queryFn: () => customFetch<PurchasesByVendorResponse>(`/api/reports/purchases-by-vendor${qs}`),
  });
}

export function usePurchasesByMaterial(params: DateRangeParams = {}) {
  const qs = buildQs({ ...params });
  return useQuery({
    queryKey: ['/api/reports/purchases-by-material', qs],
    queryFn: () => customFetch<PurchasesByMaterialResponse>(`/api/reports/purchases-by-material${qs}`),
  });
}

export function useProfitability(params: DateRangeParams & { groupBy: 'item' | 'location' }) {
  const qs = buildQs({ ...params });
  return useQuery({
    queryKey: ['/api/reports/profitability', qs],
    queryFn: () => customFetch<ProfitabilityResponse>(`/api/reports/profitability${qs}`),
  });
}

export function useSalesStockCombined(params: DateRangeParams = {}) {
  const qs = buildQs({ ...params });
  return useQuery({
    queryKey: ['/api/reports/sales-stock-combined', qs],
    queryFn: () => customFetch<SalesStockCombinedResponse>(`/api/reports/sales-stock-combined${qs}`),
  });
}
