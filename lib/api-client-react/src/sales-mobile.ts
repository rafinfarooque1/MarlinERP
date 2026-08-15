/**
 * Mobile POS support: sale detail, price history, invoice-PDF token mint and
 * a raw-body sale create.
 *
 * Why a raw-body create instead of the generated `useCreateSale`: the server's
 * zod schema strips unknown keys but the handler deliberately reads several
 * fields from the RAW body (clientRequestId, receivedInLedgerId,
 * amountReceived, referenceNumber, creditOverride, allowOverpayment,
 * useAdvance). The generated `SaleInput` type predates them, so a typed
 * passthrough here keeps callers honest without casting.
 */
import { useQuery } from '@tanstack/react-query';
import { customFetch } from './custom-fetch';

// ── Sale detail (GET /sales/:id) ─────────────────────────────────────────────

/** Stored invoice line as returned inside `SaleDetail.lineItems`. Older rows
 * may miss the enrichment fields — treat everything but ids/qty as optional. */
export interface SaleDetailLine {
  itemId: number;
  itemName?: string;
  unit?: string;
  quantity: number;
  unitPrice: number;
  /** Per-unit ₹ discount (newer rows). */
  unitDiscount?: number | null;
  /** Legacy line-total ₹ discount (older rows) — never both meanings at once. */
  discount?: number | null;
  taxRate?: number;
  taxAmount?: number;
  priceMode?: 'inclusive' | 'exclusive';
  /** Stored final line value where present — display it, never recompute. */
  lineTotal?: number;
}

export interface SaleOtherCharge {
  ledgerId: number;
  amount: number;
  ledgerName?: string;
}

export interface SaleDetail {
  id: number;
  invoiceNumber: string;
  outletId: number | null;
  locationType: 'warehouse' | 'outlet' | 'headoffice';
  locationId: number;
  customerId: number | null;
  customerName: string | null;
  saleDate: string;
  lineItems: SaleDetailLine[];
  subtotal: number;
  taxTotal: number;
  discountTotal: number;
  billDiscount: number;
  totalAmount: number;
  paymentMode: string;
  couponCode: string | null;
  otherCharges: SaleOtherCharge[];
  otherChargesTotal: number;
  createdAt: string;
  paymentStatus: 'paid' | 'partially_paid' | 'unpaid' | 'cancelled';
  amountPaid: number;
  amountReceived: number;
  creditAdjustments: number;
  amountDue: number;
  balanceDue: number;
  cancelledAt: string | null;
  isCancelled: boolean;
  outletName?: string | null;
  quotationId?: number | null;
  quotationNumber?: string | null;
}

/** Typed sale detail. Key stays in the '/api/sales' family so the existing
 * predicate invalidations (create/edit/cancel) refetch it too. */
export function useSaleDetail(id: number | null | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['/api/sales', 'detail', id] as const,
    queryFn: ({ signal }) => customFetch<SaleDetail>(`/api/sales/${id}`, { signal }),
    enabled: (options?.enabled ?? true) && !!id,
  });
}

// ── Price history (GET /sales/price-history) ─────────────────────────────────

/** One past price this customer actually paid for the item (their invoices). */
export interface SalePriceHistoryRow {
  saleId: number;
  invoiceNumber: string;
  saleDate: string;
  quantity: number;
  unitPrice: number;
  unitDiscount: number | null;
  lineDiscount: number | null;
}

/** Last few prices THIS customer paid for an item — informational only.
 * Server caps `limit` at 10 (default 5). Requires POS view. */
export function useSalePriceHistory(
  customerId: number | null | undefined,
  itemId: number | null | undefined,
  limit = 10,
) {
  const enabled = !!customerId && !!itemId;
  return useQuery({
    queryKey: ['/api/sales/price-history', customerId, itemId, limit] as const,
    queryFn: ({ signal }) =>
      customFetch<SalePriceHistoryRow[]>(
        `/api/sales/price-history?customerId=${customerId}&itemId=${itemId}&limit=${limit}`,
        { signal },
      ),
    enabled,
    staleTime: 60_000,
  });
}

// ── Invoice PDF (short-lived document token) ─────────────────────────────────

/** Mint a short-lived (≈30 min) signed token for viewing ONE invoice PDF.
 * Plain caller: runs from a tap handler; a hook would lose the user gesture
 * popup blockers need on web. Requires the sales `download` right. */
export const mintInvoicePdfToken = (
  saleId: number,
): Promise<{ token: string; expiresAt: string }> =>
  customFetch<{ token: string; expiresAt: string }>(
    `/api/sales/${saleId}/share-token`,
    { method: 'POST' },
  );

/** Relative path of the tokenized PDF — caller makes it absolute against its
 * own origin (web) or the API origin (native). */
export const invoicePdfPath = (token: string, download = false): string =>
  `/api/public/invoices/${token}.pdf${download ? '?download=1' : ''}`;

// ── Raw-body sale create (POST /sales) ───────────────────────────────────────

export interface CreateSaleLine {
  itemId: number;
  quantity: number;
  unitPrice: number;
  /** Per-unit ₹ off the price — the server derives the line total. */
  unitDiscount: number;
  /** 'inclusive' = price is the final GST-inclusive figure (default POS);
   *  'exclusive' = price is the taxable base, GST added on top. */
  priceMode: 'inclusive' | 'exclusive';
  /** Always 0 — the backend recomputes tax authoritatively. */
  taxAmount: 0;
}

export interface CreateSalePayload {
  locationType: 'warehouse' | 'outlet' | 'headoffice';
  locationId: number;
  /** Back-compat: the outlet id for outlet sales, 1 otherwise. */
  outletId: number;
  customerId?: number;
  saleDate: string;
  /** Create accepts only 'cash' (money now / partial) or 'credit'. The STORED
   * mode (Cash/Bank/UPI) is derived server-side from the receiving ledger. */
  paymentMode: 'cash' | 'credit';
  lineItems: CreateSaleLine[];
  /** ONE pre-tax ₹ discount on the whole invoice, allocated across lines. */
  billDiscount?: number;
  /** Post-tax coupon deduction (₹) — 0/absent when no coupon. */
  discountTotal?: number;
  couponCode?: string;
  otherCharges?: { ledgerId: number; amount: number }[];
  /** Cash & Bank ledger the money went into (non-credit sales). */
  receivedInLedgerId?: number;
  /** Money received at billing; absent = full amount. Max 2 decimals. */
  amountReceived?: number;
  referenceNumber?: string;
  useAdvance?: boolean;
  /** Consent flags for the confirmation retries — resend the SAME payload. */
  creditOverride?: boolean;
  allowOverpayment?: boolean;
  /** Idempotency key — stable across confirmation retries. */
  clientRequestId: string;
}

/** Create response: the full stored invoice plus payment position. */
export type CreatedSale = SaleDetail & {
  advanceApplied?: number;
  /** True when the server replayed a previous submit with the same
   * clientRequestId instead of creating a second invoice. */
  idempotentReplay?: boolean;
};

/** Plain caller (not a hook): the New Sale flow drives its own submit lock,
 * confirmation retries and cache invalidation. */
export const createSaleFull = (payload: CreateSalePayload): Promise<CreatedSale> =>
  customFetch<CreatedSale>('/api/sales', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
