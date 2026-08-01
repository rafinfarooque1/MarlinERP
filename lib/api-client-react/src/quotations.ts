/**
 * Quotations — custom hooks that the generated client does not cover.
 *
 * The generated hooks (useListQuotations, useCreateQuotation, useGetQuotation,
 * useUpdateQuotation, useDeleteQuotation, useSetQuotationStatus) come from the
 * OpenAPI spec. This file adds:
 *   - the paginated list envelope (the spec models the plain array shape),
 *   - share links (same server-owned model as invoice share links),
 *   - the in-session PDF token,
 *   - the soft stock check that precedes Convert to Sale,
 *   - the expired-quotations feed for the notification bell.
 */
import { useMutation, useQuery, UseQueryOptions } from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";
import type {
  InvoiceShareLink, ShareIntent,
} from "./invoice-share-links";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface QuotationListRow {
  id: number;
  quotationNumber: string;
  locationType: "warehouse" | "outlet";
  locationId: number;
  locationName: string;
  customerId: number | null;
  customerName: string | null;
  customerPhone: string | null;
  customerGstin: string | null;
  quoteDate: string;
  validTill: string | null;
  status: "draft" | "sent" | "accepted" | "rejected" | "expired" | "converted";
  lineItems: any[];
  subtotal: number;
  taxTotal: number;
  discountTotal: number;
  billDiscount: number;
  totalAmount: number;
  couponCode: string | null;
  billingAddress: string | null;
  shippingAddress: string | null;
  paymentTerms: string | null;
  placeOfSupply: string | null;
  salesperson: string | null;
  notes: string | null;
  termsConditions: string | null;
  convertedSaleId: number | null;
  convertedInvoiceNumber: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface PaginatedQuotations {
  total: number;
  page: number;
  limit: number;
  rows: QuotationListRow[];
}

export interface QuotationListFilters {
  q?: string;
  from?: string;
  to?: string;
  status?: string;
  locationType?: "warehouse" | "outlet";
  locationId?: number;
  customerId?: number;
  salesperson?: string;
}

// ── Paginated list ────────────────────────────────────────────────────────────

const buildQuery = (page: number, limit: number, f: QuotationListFilters): string => {
  const p = new URLSearchParams();
  p.set("page", String(page));
  p.set("limit", String(limit));
  if (f.q) p.set("q", f.q);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.status) p.set("status", f.status);
  if (f.locationType && f.locationId) {
    p.set("locationType", f.locationType);
    p.set("locationId", String(f.locationId));
  }
  if (f.customerId) p.set("customerId", String(f.customerId));
  if (f.salesperson) p.set("salesperson", f.salesperson);
  return p.toString();
};

export function usePaginatedQuotations(
  page: number, limit: number, filters: QuotationListFilters = {},
  options?: { query?: Omit<UseQueryOptions<PaginatedQuotations, Error>, "queryKey"> },
) {
  const qs = buildQuery(page, limit, filters);
  return useQuery<PaginatedQuotations, Error>({
    queryKey: ["/api/quotations", "paginated", qs] as const,
    queryFn: () => customFetch<PaginatedQuotations>(`/api/quotations?${qs}`),
    placeholderData: (prev) => prev,
    ...options?.query,
  });
}

/** All quotation queries (list + paginated + detail) share this root key. */
export const quotationsQueryRoot = ["/api/quotations"] as const;

// ── Stock check before Convert to Sale ────────────────────────────────────────

export interface QuotationStockShortfall {
  itemId: number;
  itemName: string;
  requested: number;
  available: number;
}

export interface QuotationStockCheck {
  ok: boolean;
  shortfalls: QuotationStockShortfall[];
}

/** Plain caller: conversion runs from a click handler, not a render. */
export const checkQuotationStock = (quotationId: number): Promise<QuotationStockCheck> =>
  customFetch<QuotationStockCheck>(`/api/quotations/${quotationId}/stock-check`);

// ── In-session PDF token (preview / print / download) ─────────────────────────

/**
 * Mint a short-lived token and return the public PDF URL. Requires the
 * module's download permission server-side. Plain function so the caller can
 * open the window inside the user's click gesture.
 */
export async function requestQuotationPdfUrl(
  quotationId: number, opts: { download?: boolean } = {},
): Promise<string> {
  const { token } = await customFetch<{ token: string; expiresAt: string }>(
    `/api/quotations/${quotationId}/share-token`, { method: "POST" },
  );
  return `/api/public/quotations/${encodeURIComponent(token)}.pdf${opts.download ? "?download=1" : ""}`;
}

// ── Share links ───────────────────────────────────────────────────────────────

export interface QuotationShareLinkState {
  quotationId: number;
  customerPhone: string | null;
  link: InvoiceShareLink | null;
}

export interface QuotationShareLinkResult {
  quotationId: number;
  reused: boolean;
  link: InvoiceShareLink;
}

// Plain callers first — sharing is triggered from click handlers, and a
// handler that waits on a mutation's onSuccess loses the popup gesture.

export const ensureQuotationShareLink = (
  quotationId: number, intent: ShareIntent = "link",
): Promise<QuotationShareLinkResult> =>
  customFetch<QuotationShareLinkResult>(`/api/quotations/${quotationId}/share-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ intent }),
  });

export const regenerateQuotationShareLink = (quotationId: number): Promise<QuotationShareLinkResult> =>
  customFetch<QuotationShareLinkResult>(`/api/quotations/${quotationId}/share-link/regenerate`, { method: "POST" });

export const revokeQuotationShareLink = (
  quotationId: number,
): Promise<{ quotationId: number; link: InvoiceShareLink }> =>
  customFetch<{ quotationId: number; link: InvoiceShareLink }>(
    `/api/quotations/${quotationId}/share-link/revoke`, { method: "POST" },
  );

export const getQuotationShareLinkQueryKey = (quotationId: number | null | undefined) =>
  ["/api/quotations/share-link", quotationId] as const;

export const useQuotationShareLink = (
  quotationId: number | null | undefined,
  options?: { query?: Omit<UseQueryOptions<QuotationShareLinkState, Error>, "queryKey"> },
) =>
  useQuery<QuotationShareLinkState, Error>({
    queryKey: getQuotationShareLinkQueryKey(quotationId),
    queryFn: () => customFetch<QuotationShareLinkState>(`/api/quotations/${quotationId}/share-link`),
    enabled: quotationId != null,
    ...options?.query,
  });

export const useEnsureQuotationShareLink = () =>
  useMutation<QuotationShareLinkResult, Error, { quotationId: number; intent?: ShareIntent }>({
    mutationFn: ({ quotationId, intent = "link" }) => ensureQuotationShareLink(quotationId, intent),
  });

export const useRegenerateQuotationShareLink = () =>
  useMutation<QuotationShareLinkResult, Error, { quotationId: number }>({
    mutationFn: ({ quotationId }) => regenerateQuotationShareLink(quotationId),
  });

export const useRevokeQuotationShareLink = () =>
  useMutation<{ quotationId: number; link: InvoiceShareLink }, Error, { quotationId: number }>({
    mutationFn: ({ quotationId }) => revokeQuotationShareLink(quotationId),
  });

// ── Expired-quotations feed (notification bell) ───────────────────────────────

export interface ExpiredQuotationNotification {
  id: number;
  quotationNumber: string;
  customerName: string | null;
  totalAmount: number;
  validTill: string;
}

export function useExpiredQuotationNotifications(options?: { enabled?: boolean }) {
  return useQuery<ExpiredQuotationNotification[], Error>({
    queryKey: ["/api/quotations/notifications/expired"] as const,
    queryFn: () => customFetch<ExpiredQuotationNotification[]>("/api/quotations/notifications/expired"),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    enabled: options?.enabled ?? true,
  });
}
