/**
 * Invoice sharing — message composition and delivery channels.
 *
 * Deliberately separate from the invoice itself. The PDF has exactly ONE
 * renderer (api-server/src/services/invoicePdf.ts) reached through a signed
 * public link; this module only decides what to SAY when handing that link to a
 * customer, and which channel carries it.
 *
 * Keeping composition here means a future WhatsApp Business API path — which
 * uploads the PDF and sends it as a document attachment instead of a link —
 * only has to implement `InvoiceShareChannel` below. Neither the renderer nor
 * the Sales page needs to change.
 */

import { paymentModeLabel } from './paymentModes';

// ── Phone numbers ─────────────────────────────────────────────────────────────

/**
 * Normalise an Indian phone number to WhatsApp's format: country code, no
 * plus, no separators (91XXXXXXXXXX). Returns null when there aren't enough
 * digits to dial — callers must tell the user rather than open a broken chat.
 */
export function normaliseWhatsAppNumber(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('91') && digits.length === 12) return digits;   // 91XXXXXXXXXX
  if (digits.startsWith('0') && digits.length === 11) return `91${digits.slice(1)}`;
  if (digits.length === 10) return `91${digits}`;
  // Already carries some other country code — pass it through untouched.
  if (digits.length > 12) return digits;
  return null;
}

// ── Message composition ───────────────────────────────────────────────────────

export interface InvoiceShareLine {
  itemId: number;
  itemName?: string;
  quantity: number | string;
  unitPrice: number | string;
  /** TOTAL pre-tax ₹ off this line (item discount + bill-discount share). */
  discount?: number | string;
  /** ₹ off every unit's MRP — present on lines from the per-unit system. */
  unitDiscount?: number | string | null;
  /** This line's slice of the invoice-level bill discount. */
  billDiscountShare?: number | string | null;
}

export interface InvoiceShareSale {
  id: number;
  invoiceNumber?: string | null;
  saleDate: string;
  customerName?: string | null;
  customerPhone?: string | null;
  outletName?: string | null;
  lineItems?: InvoiceShareLine[] | null;
  subtotal?: number | string | null;
  taxTotal?: number | string | null;
  discountTotal?: number | string | null;
  /** Pre-tax invoice-level discount, already allocated into the line figures. */
  billDiscount?: number | string | null;
  couponCode?: string | null;
  totalAmount: number | string;
  amountPaid?: number | string | null;
  paymentMode?: string | null;
  /** Server-derived: 'unpaid' | 'partially_paid' | 'paid' | 'cancelled'. */
  paymentStatus?: string | null;
  /** Server-derived position — receipts, credits and what is left to pay. Never
   *  recomputed here; the invoice, its QR and this message must agree. */
  amountReceived?: number | string | null;
  creditAdjustments?: number | string | null;
  balanceDue?: number | string | null;
}

export interface ComposeOptions {
  sale: InvoiceShareSale;
  /** Public, signed link to the invoice PDF. */
  pdfUrl: string;
  /** Falls back to the company name when the sale has no location name. */
  companyName: string;
  /** Resolves an item name when the line item doesn't carry one. */
  resolveItemName?: (itemId: number) => string | undefined;
  /**
   * How long the link works, in days. Stated in the message so the customer knows
   * to save the PDF now rather than coming back to a dead URL in a month — and so
   * the expiry is not a surprise they have to ring the office about.
   */
  linkValidDays?: number;
}

const inr = (n: number | string | null | undefined): string =>
  `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

const formatDate = (d: string): string =>
  new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

/**
 * The customer-facing bill summary: itemised lines, totals, how it was paid and
 * a link to the full tax invoice. WhatsApp markup (*bold*) is used sparingly so
 * the message still reads cleanly in any channel that ignores it.
 */
export function composeInvoiceMessage({
  sale, pdfUrl, companyName, resolveItemName, linkValidDays,
}: ComposeOptions): string {
  const seller = sale.outletName || companyName;
  const lineItems = sale.lineItems ?? [];

  // Each line shows only its ITEM discount — the bill discount is one
  // invoice-level figure and reads as such in the totals, not smeared across
  // lines the customer never asked about.
  const lineItemDisc = (li: InvoiceShareLine): number => {
    if (li.unitDiscount != null) {
      return Math.round(Number(li.unitDiscount) * Number(li.quantity) * 100) / 100;
    }
    // Historical lines: `discount` is the recorded line total (share is 0 on
    // pre-bill-discount invoices, so the subtraction is a no-op there).
    return Math.max(0, Number(li.discount ?? 0) - Number(li.billDiscountShare ?? 0));
  };

  const itemLines = lineItems.map((li, i) => {
    const name = li.itemName || resolveItemName?.(li.itemId) || `Item #${li.itemId}`;
    const qty = Number(li.quantity);
    const rate = Number(li.unitPrice);
    const disc = lineItemDisc(li);
    const lineAmt = qty * rate - disc;
    const discPart = disc > 0 ? ` - ${inr(disc)} disc` : '';
    return `  ${i + 1}. ${name}\n     ${qty} × ${inr(rate)}${discPart} = *${inr(lineAmt)}*`;
  });

  const itemDiscAmt = lineItems.reduce((s, li) => s + lineItemDisc(li), 0);
  const billDiscount = Number(sale.billDiscount ?? 0);
  const taxTotal = Number(sale.taxTotal ?? 0);
  const discTotal = Number(sale.discountTotal ?? 0);

  const totalsLines: string[] = [];
  if (itemDiscAmt > 0) totalsLines.push(`  Item discounts: -${inr(itemDiscAmt)}`);
  if (billDiscount > 0) totalsLines.push(`  Bill discount: -${inr(billDiscount)}`);
  totalsLines.push(`  Subtotal: ${inr(sale.subtotal ?? 0)}`);
  if (taxTotal > 0) totalsLines.push(`  GST: ${inr(taxTotal)}`);
  if (discTotal > 0) {
    totalsLines.push(`  ${sale.couponCode ? `Coupon (${sale.couponCode})` : 'Discount'}: -${inr(discTotal)}`);
  }
  totalsLines.push(`  *Total: ${inr(sale.totalAmount)}*`);

  // Payment block. The server sends the authoritative position on the sale, so
  // the message never recomputes what is owed — it states what was received,
  // what was credited back, and what is left. A settled or cancelled bill drops
  // the payment-request wording entirely: asking a customer who has already paid
  // to pay again is the fastest way to lose their trust.
  const modeLabel = paymentModeLabel(sale.paymentMode);
  const received = Number(sale.amountReceived ?? sale.amountPaid ?? 0);
  const credited = Number(sale.creditAdjustments ?? 0);
  const due = Number(
    sale.balanceDue ?? Math.max(0, Number(sale.totalAmount || 0) - received - credited),
  );
  const cancelled = sale.paymentStatus === 'cancelled';
  const payLines: string[] = [];
  if (cancelled) {
    payLines.push(`  *This invoice has been cancelled — nothing is payable.*`);
  } else {
    if (modeLabel) payLines.push(`  Payment: ${modeLabel}`);
    if (received > 0.004) payLines.push(`  Amount received: ${inr(received)}`);
    if (credited > 0.004) payLines.push(`  Credit notes: -${inr(credited)}`);
    payLines.push(due > 0.004
      ? `  *Balance due: ${inr(due)}*`
      : `  *Paid in full — thank you!*`);
  }

  return [
    `Dear ${sale.customerName || 'Customer'},`,
    ``,
    `Thank you for your purchase from *${seller}*! 🙏`,
    ``,
    `*Invoice No:* ${sale.invoiceNumber ?? `#${sale.id}`}`,
    `*Date:* ${formatDate(sale.saleDate)}`,
    ``,
    `*Bill Details:*`,
    ...itemLines,
    ``,
    ...totalsLines,
    ...payLines,
    ``,
    `📄 View / download invoice PDF:`,
    pdfUrl,
    ...(linkValidDays
      ? [``, `_This link is private to you and valid for ${linkValidDays} days._`]
      : []),
    ``,
    `— ${seller}`,
  ].join('\n');
}

// ── Delivery channels ─────────────────────────────────────────────────────────

export interface InvoiceSharePayload {
  /** Destination in WhatsApp format (91XXXXXXXXXX). */
  phone: string;
  /** Composed customer-facing message. */
  message: string;
  /** Signed public link to the invoice PDF, for channels that attach the file. */
  pdfUrl: string;
  /** Sale id, so an API channel can fetch or re-render the document itself. */
  saleId: number;
}

/**
 * A way of getting an invoice to a customer.
 *
 * `wa.me` is the only channel today: it hands the message to whatever WhatsApp
 * client the user has, and the customer taps the link. A WhatsApp Business API
 * channel would instead POST the message plus the PDF as a document attachment
 * — same payload, no change to composition or to the renderer.
 */
export interface InvoiceShareChannel {
  id: string;
  /** True when this channel can run in the current environment. */
  available(): boolean;
  /**
   * Deliver the invoice. Link-based channels return a URL for the caller to
   * navigate to (which must happen inside the original click gesture, or
   * popup blockers swallow it). API-based channels send it themselves and
   * return null.
   */
  deliver(payload: InvoiceSharePayload): Promise<string | null> | string | null;
}

/** Opens the user's WhatsApp with the message pre-filled. */
export const waLinkChannel: InvoiceShareChannel = {
  id: 'wa-link',
  available: () => true,
  deliver: ({ phone, message }) =>
    `https://wa.me/${phone}?text=${encodeURIComponent(message)}`,
};

const channels: InvoiceShareChannel[] = [waLinkChannel];

/** The channel to use for a share right now — first available one wins. */
export function activeInvoiceShareChannel(): InvoiceShareChannel {
  return channels.find(c => c.available()) ?? waLinkChannel;
}

/** Register an additional channel (e.g. WhatsApp Business API) ahead of wa.me. */
export function registerInvoiceShareChannel(channel: InvoiceShareChannel): void {
  channels.unshift(channel);
}
