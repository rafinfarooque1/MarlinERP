/**
 * THE authoritative payment position of a sales invoice.
 *
 * One definition, used by every surface that shows money owed on an invoice:
 * the sales list, the invoice detail, the PDF/print/share renderer, the UPI QR,
 * customer outstanding, the receivables ageing report and the payment-cap guard.
 *
 *     Invoice Total
 *   − Amount Received        (sale_payments, aggregated on sales.amount_paid)
 *   − Credit Adjustments     (credit notes raised by sales returns)
 *   = Outstanding
 *
 * Why a shared module rather than the expression repeated per route: the
 * expression WAS repeated in a dozen places, and they disagreed. A credit note
 * reduced the customer's ledger balance (it posts its own voucher) but not the
 * invoice's own "balance due", so the same debt read two different ways
 * depending on which screen you opened. Anything that needs this number must
 * call in here — for SQL, use the expression builders so the rule stays in one
 * file even inside a join.
 *
 * Two rules that are easy to get wrong:
 *
 *  1. Only CREDIT-NOTE returns reduce what is owed. A walk-in cash refund hands
 *     the money back, so it lowers the receipt and the receivable together and
 *     nets to zero against the invoice. Subtracting it as well would show a
 *     settled counter sale as over-collected.
 *  2. A cancelled invoice owes nothing. It is not "unpaid" — its stock, revenue
 *     and receivable were all reversed, so it must never carry a balance or a
 *     payment request.
 */

// ── Money helpers ─────────────────────────────────────────────────────────────

/** Currency precision used across the ERP: 2 dp, half-up. */
export const r2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Comparison tolerance. Paise-level float residue must not make a fully settled
 * invoice look like it still owes 0.004, which would keep a QR on a paid bill.
 */
export const MONEY_EPSILON = 0.005;

export type PaymentStatus = "unpaid" | "partially_paid" | "paid" | "cancelled";

export interface PaymentPosition {
  /** The invoice's own grand total, unchanged by payments or credits. */
  invoiceTotal: number;
  /** Confirmed money received against this invoice. */
  amountReceived: number;
  /** Credit notes (from sales returns) that reduce what is owed. */
  creditAdjustments: number;
  /** Invoice total less credit adjustments — the amount actually payable. */
  amountDue: number;
  /** What is still owed right now. Never negative. */
  outstanding: number;
  /** Received in excess of what was payable (customer credit), never negative. */
  overpaid: number;
  status: PaymentStatus;
  isCancelled: boolean;
}

export interface PositionInput {
  totalAmount: number | string | null | undefined;
  amountReceived: number | string | null | undefined;
  creditAdjustments?: number | string | null | undefined;
  cancelledAt?: Date | string | null | undefined;
}

/**
 * Derive the position from figures already in hand.
 *
 * Status comes from the money, never from the invoice's payment mode: "credit"
 * is a payment arrangement, not a payment state, and a credit invoice that has
 * been collected in full is PAID like any other.
 */
export function computePaymentPosition(input: PositionInput): PaymentPosition {
  const invoiceTotal = r2(Number(input.totalAmount ?? 0));
  const amountReceived = r2(Number(input.amountReceived ?? 0));
  const creditAdjustments = r2(Number(input.creditAdjustments ?? 0));
  const isCancelled = Boolean(input.cancelledAt);

  const amountDue = r2(invoiceTotal - creditAdjustments);
  const rawOutstanding = r2(amountDue - amountReceived);

  if (isCancelled) {
    return {
      invoiceTotal, amountReceived, creditAdjustments, amountDue,
      outstanding: 0,
      overpaid: 0,
      status: "cancelled",
      isCancelled: true,
    };
  }

  const outstanding = rawOutstanding > MONEY_EPSILON ? rawOutstanding : 0;
  const overpaid = rawOutstanding < -MONEY_EPSILON ? r2(-rawOutstanding) : 0;

  let status: PaymentStatus;
  if (outstanding <= 0) status = "paid";
  else if (outstanding >= invoiceTotal - MONEY_EPSILON) status = "unpaid";
  else status = "partially_paid";

  return { invoiceTotal, amountReceived, creditAdjustments, amountDue, outstanding, overpaid, status, isCancelled: false };
}

// ── SQL expression builders ───────────────────────────────────────────────────
// For queries that must compute the position across many rows (lists, ageing,
// dashboards). Keeping the SQL here means the credit-note rule cannot drift out
// of step with the TypeScript path above.

/**
 * Credit notes raised against a sale by sales returns.
 * Cash refunds are excluded on purpose — see the note at the top of this file.
 */
export function creditAdjustmentsExpr(saleAlias = "s"): string {
  return `COALESCE((
    SELECT SUM(sr.total_amount::numeric)
      FROM sales_returns sr
     WHERE sr.sale_id = ${saleAlias}.id
       AND sr.refund_mode = 'credit_note'
  ), 0)`;
}

/** Invoice total less credit notes — what the customer is actually billed. */
export function amountDueExpr(saleAlias = "s"): string {
  return `(${saleAlias}.total_amount::numeric - ${creditAdjustmentsExpr(saleAlias)})`;
}

/**
 * What is still owed. Clamped at zero and forced to zero for cancelled
 * invoices, so a caller can SUM() this without re-stating either rule.
 */
export function outstandingExpr(saleAlias = "s"): string {
  return `(CASE WHEN ${saleAlias}.cancelled_at IS NOT NULL THEN 0 ELSE GREATEST(
    0,
    ${amountDueExpr(saleAlias)} - COALESCE(${saleAlias}.amount_paid, 0)::numeric
  ) END)`;
}

// ── Loading ───────────────────────────────────────────────────────────────────

/** Anything that can run a query: the pool, or a client inside a transaction. */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

/**
 * Load one invoice's position.
 *
 * Pass the transaction client when the caller is about to write (recording a
 * payment), so the figure it validates against is the one it locked — not a
 * value another connection may already have moved.
 */
export async function loadPaymentPosition(q: Queryable, saleId: number): Promise<PaymentPosition | null> {
  const { rows: [row] } = await q.query(
    `SELECT s.total_amount::numeric        AS total_amount,
            COALESCE(s.amount_paid, 0)::numeric AS amount_paid,
            ${creditAdjustmentsExpr("s")}  AS credit_adjustments,
            s.cancelled_at
       FROM sales s
      WHERE s.id = $1`,
    [saleId],
  );
  if (!row) return null;
  return computePaymentPosition({
    totalAmount: row.total_amount,
    amountReceived: row.amount_paid,
    creditAdjustments: row.credit_adjustments,
    cancelledAt: row.cancelled_at,
  });
}

/** Load many positions at once, for list endpoints. */
export async function loadPaymentPositions(q: Queryable, saleIds: number[]): Promise<Map<number, PaymentPosition>> {
  const out = new Map<number, PaymentPosition>();
  if (saleIds.length === 0) return out;
  const { rows } = await q.query(
    `SELECT s.id,
            s.total_amount::numeric        AS total_amount,
            COALESCE(s.amount_paid, 0)::numeric AS amount_paid,
            ${creditAdjustmentsExpr("s")}  AS credit_adjustments,
            s.cancelled_at
       FROM sales s
      WHERE s.id = ANY($1::int[])`,
    [saleIds],
  );
  for (const row of rows) {
    out.set(Number(row.id), computePaymentPosition({
      totalAmount: row.total_amount,
      amountReceived: row.amount_paid,
      creditAdjustments: row.credit_adjustments,
      cancelledAt: row.cancelled_at,
    }));
  }
  return out;
}

// ── Receipt detail (for the PAID panel on an invoice) ─────────────────────────

export interface RecordedPayment {
  method: string | null;
  paymentDate: string | null;
  referenceNumber: string | null;
  amount: number;
  /** 'collection' = a recorded receipt row; 'counter' = settled as the sale was rung up. */
  source: "collection" | "counter";
}

/**
 * How an invoice was paid, for the "PAID" block.
 *
 * Counter sales (cash/UPI/bank at the till) are settled on the sale row itself
 * and have no collection rows, so the sale's own mode and date are reported
 * instead of leaving the panel blank. That is a faithful record of what the ERP
 * knows, flagged with `source` so callers can label it honestly.
 */
export async function loadRecordedPayments(q: Queryable, saleId: number): Promise<RecordedPayment[]> {
  const { rows } = await q.query(
    `SELECT method, payment_date, reference_number, amount::numeric AS amount
       FROM sale_payments
      WHERE sale_id = $1
      ORDER BY payment_date ASC, id ASC`,
    [saleId],
  );
  if (rows.length > 0) {
    return rows.map((r: any) => ({
      method: r.method ?? null,
      paymentDate: r.payment_date ? String(r.payment_date).slice(0, 10) : null,
      referenceNumber: r.reference_number ?? null,
      amount: r2(Number(r.amount)),
      source: "collection" as const,
    }));
  }

  const { rows: [sale] } = await q.query(
    `SELECT payment_mode, sale_date, COALESCE(amount_paid, 0)::numeric AS amount_paid
       FROM sales WHERE id = $1`,
    [saleId],
  );
  if (!sale || Number(sale.amount_paid) <= MONEY_EPSILON) return [];
  return [{
    method: sale.payment_mode ?? null,
    paymentDate: sale.sale_date ? String(sale.sale_date).slice(0, 10) : null,
    referenceNumber: null,
    amount: r2(Number(sale.amount_paid)),
    source: "counter",
  }];
}

// ── UPI payment request ───────────────────────────────────────────────────────

export interface InvoicePaymentSettings {
  upiEnabled: boolean;
  /** Company-level UPI ID; a location's own ID takes precedence over this. */
  upiId: string;
  upiPayeeName: string;
  showUpiQrOnInvoice: boolean;
  showBankDetailsOnInvoice: boolean;
}

/**
 * Invoice payment presentation settings.
 *
 * Defaults keep the pre-existing behaviour: UPI on, QR shown, bank details
 * shown. The switches exist so a company can turn a payment request off, not to
 * make anyone re-enable what already worked.
 */
export async function loadInvoicePaymentSettings(q: Queryable): Promise<InvoicePaymentSettings> {
  const { rows: [row] } = await q.query(
    `SELECT upi_enabled, upi_id, upi_payee_name,
            show_upi_qr_on_invoice, show_bank_details_on_invoice
       FROM company_settings ORDER BY id LIMIT 1`,
  );
  return {
    upiEnabled: row?.upi_enabled !== false,
    upiId: (row?.upi_id ?? "").trim(),
    upiPayeeName: (row?.upi_payee_name ?? "").trim(),
    showUpiQrOnInvoice: row?.show_upi_qr_on_invoice !== false,
    showBankDetailsOnInvoice: row?.show_bank_details_on_invoice !== false,
  };
}

/**
 * A UPI collect request for an invoice, or null when no payment should be asked
 * for. THE gate for every QR in the system.
 *
 * Returns null when the invoice is cancelled, when nothing is outstanding, when
 * UPI is switched off, or when no UPI ID resolves — a QR that requests ₹0, or
 * one built on a missing ID, is worse than no QR at all.
 */
export function buildUpiRequest(args: {
  position: PaymentPosition;
  upiId: string;
  payeeName: string;
  reference: string;
  enabled?: boolean;
}): { uri: string; amount: number; upiId: string; payeeName: string } | null {
  const upiId = (args.upiId ?? "").trim();
  const amount = args.position.outstanding;
  if (args.enabled === false) return null;
  if (args.position.isCancelled) return null;
  if (!upiId) return null;
  if (!(amount > MONEY_EPSILON)) return null;

  const payeeName = (args.payeeName ?? "").trim() || upiId;
  const params = new URLSearchParams({
    pa: upiId,
    pn: payeeName,
    am: amount.toFixed(2),
    cu: "INR",
    tn: args.reference ? `Payment for Invoice ${args.reference}` : "Invoice payment",
  });
  if (args.reference) params.set("tr", args.reference.replace(/[^A-Za-z0-9]/g, ""));
  return { uri: `upi://pay?${params.toString()}`, amount, upiId, payeeName };
}
