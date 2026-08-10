/**
 * Canonical Sales Invoice PDF service.
 *
 * Professional A4 GST tax-invoice layout matching the Marlin brand design:
 *   • Dark-navy header — issuing warehouse (left) + TAX INVOICE badge (right)
 *   • GSTIN / FSSAI compliance bar
 *   • Navy "Billed To / Shipped To" section
 *   • Navy items table with CGST/SGST/IGST group columns
 *   • Amount-in-words (left) + tax summary (right) with navy Grand Total
 *   • Payment status strip, then amount payable + bank details + UPI QR
 *   • Navy "Thank You" footer bar with the authorised-signatory block
 *
 * ONE renderer used by every output channel:
 *   • Preview  (inline PDF in browser tab)
 *   • Download (attachment download)
 *   • WhatsApp (secure tokenized public link)
 *
 * The seller identity on this document comes from the *warehouse the sale was
 * raised at* — see lib/billingProfile.ts. The company profile only supplies the
 * logo, the payment terms and a bank/UPI fallback; it never supplies the name,
 * address, GSTIN or FSSAI licence, because those must name the registration
 * that actually issued the invoice.
 *
 * Text is drawn in the embedded Roboto face from @workspace/pdf-kit rather than
 * jsPDF's built-ins. The built-in fonts are WinAnsi-encoded and have no glyph
 * for the rupee sign, which is why this document used to print "Rs." — with a
 * real TrueType face embedded it can print ₹.
 */
import { jsPDF } from "jspdf";
import QRCode from "qrcode";
import {
  db, pool, salesTable, customersTable, itemsTable, companySettingsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { FONT, SCRIPT_FONT, registerFonts, registerScriptFont } from "@workspace/pdf-kit";
import { paymentModeLabel } from "../lib/paymentModes";
import { parseStoredOtherCharges } from "../lib/otherCharges";
import { resolveInvoiceIssuer, resolveLocationIssuer, type InvoiceIssuer } from "../lib/billingProfile";
import {
  loadPaymentPosition, loadRecordedPayments, loadInvoicePaymentSettings, buildUpiRequest,
  type PaymentPosition, type RecordedPayment,
} from "../lib/salePaymentPosition";

// ── Data assembly ─────────────────────────────────────────────────────────────

export interface InvoiceLineItem {
  itemId: number;
  itemName?: string;
  hsnCode?: string;
  unit?: string;
  quantity: number;
  unitPrice: number;
  discount?: number;
  unitDiscount?: number;
  billDiscountShare?: number;
  lineSubtotal?: number;
  taxRate?: number;
  taxType?: string;
  cgst?: number;
  sgst?: number;
  igst?: number;
  taxAmount?: number;
}

export interface InvoiceData {
  sale: {
    id: number;
    invoiceNumber: string | null;
    saleDate: string;
    paymentMode: string | null;
    subtotal: number;
    taxTotal: number;
    discountTotal: number;
    billDiscount: number;
    totalAmount: number;
    lineItems: InvoiceLineItem[];
    cancelledAt: string | null;
    /** For sales converted from a quotation: the QTN/… it came from. */
    quotationNumber?: string | null;
    /**
     * Other Charges on the invoice (Packing & Transport, freight, hamali…),
     * already folded into totalAmount and carrying no GST. Ledger names are
     * resolved at assembly; absent/empty means the document shows no charge
     * rows — the renderer never computes them.
     */
    otherCharges?: Array<{ name: string; amount: number }>;
  };
  /**
   * Which document this is. The ONE renderer draws both: 'quotation' swaps the
   * badge, drops every payment surface (status strip, amount payable, bank,
   * QR, payment mode — omitted entirely, never zeroed), adds validity and a
   * light watermark. Absent means 'invoice'.
   */
  docType?: "invoice" | "quotation";
  /** Quotation-only fields; present exactly when docType === 'quotation'. */
  quotation?: {
    validTill: string | null;
    convertedInvoiceNumber: string | null;
    paymentTerms: string | null;
    salesperson: string | null;
    notes: string | null;
    termsConditions: string | null;
    /** Light diagonal "QUOTATION" watermark on every page. */
    watermark: boolean;
  };
  /** Ship-to override (quotations); when absent both panels show billing. */
  shippingAddress?: string | null;
  /**
   * Who is selling. Resolved from the sale's stored location, so reprinting an
   * old invoice from another branch still shows the branch that raised it.
   */
  issuer: InvoiceIssuer;
  /** Kept for callers that label a download by its location. */
  outletName: string;
  outletUpiId: string;
  customer: {
    name: string;
    phone: string;
    address: string;
    state: string;
    gstNumber: string;
  } | null;
  cs: Record<string, unknown>;
  /** Company logo as a data URI, or null to fall back to the lettermark. */
  logoDataUrl: string | null;
  /**
   * What is owed right now, from the one shared helper every other surface uses.
   * Recomputed on every render — the document is never stamped with an amount
   * that could go stale between a payment and the next download.
   * Null for quotations: an offer owes nothing and asks for nothing.
   */
  position: PaymentPosition | null;
  /** How the invoice was paid, for the settled-invoice panel. */
  recordedPayments: RecordedPayment[];
  /**
   * UPI collect request for the CURRENT outstanding, or null when the invoice
   * must not ask for money (settled, cancelled, UPI off, or no UPI ID).
   */
  upiRequest: { uri: string; amount: number; upiId: string; payeeName: string } | null;
  /** Whether the bank block may be printed (company setting). */
  showBankDetails: boolean;
}

export async function assembleInvoiceData(saleId: number): Promise<InvoiceData | null> {
  const [sale] = await db.select().from(salesTable).where(eq(salesTable.id, saleId)).limit(1);
  if (!sale) return null;

  // The seller. Resolved from location_type/location_id on the sale, which are
  // the authoritative issuing-location columns.
  const issuer = await resolveInvoiceIssuer(pool, saleId);

  // cancelled_at and quotation_number are raw-migration columns: drizzle's
  // select() silently drops them, so they are read with raw SQL.
  const { rows: [locRow] } = await pool.query<{ cancelled_at: Date | null; quotation_number: string | null; other_charges: unknown }>(
    `SELECT cancelled_at, quotation_number, other_charges FROM sales WHERE id = $1`, [saleId],
  );

  // Other Charges — stored as { ledgerId, amount } rows; the document shows
  // the ledger's NAME, so resolve it here (a renamed ledger prints its current
  // name on a reprint, matching how the books present the same posting).
  const storedCharges = parseStoredOtherCharges(locRow?.other_charges);
  let otherCharges: Array<{ name: string; amount: number }> = [];
  if (storedCharges.length > 0) {
    const { rows: ocLedgers } = await pool.query<{ id: number; name: string }>(
      `SELECT id, name FROM account_ledgers WHERE id = ANY($1::int[])`,
      [[...new Set(storedCharges.map((c) => c.ledgerId))]],
    );
    const ocNames = new Map(ocLedgers.map((l) => [Number(l.id), l.name]));
    otherCharges = storedCharges.map((c) => ({
      name: ocNames.get(c.ledgerId) ?? "Other Charge",
      amount: c.amount,
    }));
  }

  const customerRow = sale.customerId
    ? (await db.select().from(customersTable).where(eq(customersTable.id, sale.customerId)).limit(1))[0] ?? null
    : null;
  const [cs] = await db.select().from(companySettingsTable).limit(1);

  // Payment terms and the logo are company-wide and live in raw columns from a
  // startup migration, which Drizzle's select() cannot see.
  let paymentTerms: string | null = null;
  let logoDataUrl: string | null = null;
  if (cs) {
    const { rows: [pdfCols] } = await pool.query<{ payment_terms: string | null; logo_url: string | null }>(
      `SELECT payment_terms, logo_url FROM company_settings WHERE id = $1`, [cs.id],
    );
    paymentTerms = pdfCols?.payment_terms ?? null;
    // Only an inline data URI is usable: jsPDF cannot fetch a remote image, and
    // a URL string would be drawn as a broken box.
    const logo = pdfCols?.logo_url ?? null;
    logoDataUrl = logo && /^data:image\//i.test(logo) ? logo : null;
  }

  // ── What this invoice must ask the customer for ────────────────────────────
  // Read on every assembly, so a document downloaded a second after a payment
  // shows the new balance. Nothing here is stored on the sale.
  const position = await loadPaymentPosition(pool, saleId);
  if (!position) return null;
  const recordedPayments = await loadRecordedPayments(pool, saleId);
  const paySettings = await loadInvoicePaymentSettings(pool);

  // A location collecting into its own UPI handle wins over the company default:
  // that is what keeps an electronic collection traceable to the location that
  // took it. The issuer already applied that precedence.
  const upiRequest = buildUpiRequest({
    position,
    upiId: issuer.upiId,
    payeeName: paySettings.upiPayeeName || issuer.tradeName || String((cs as any)?.companyName ?? ""),
    reference: sale.invoiceNumber ?? "",
    enabled: paySettings.upiEnabled && paySettings.showUpiQrOnInvoice,
  });

  const lineItems: InvoiceLineItem[] = Array.isArray(sale.lineItems) ? (sale.lineItems as InvoiceLineItem[]) : [];

  const missingIds = [...new Set(
    lineItems.filter((li) => !li.itemName || !li.hsnCode || !li.unit).map((li) => li.itemId),
  )];
  if (missingIds.length > 0) {
    const rows = await db
      .select({ id: itemsTable.id, name: itemsTable.name, hsnCode: itemsTable.hsnCode, unit: itemsTable.unit })
      .from(itemsTable).where(inArray(itemsTable.id, missingIds));
    const infoMap = new Map(rows.map((r) => [r.id, r]));
    for (const li of lineItems) {
      const info = infoMap.get(li.itemId);
      if (!li.itemName) li.itemName = info?.name ?? `Item #${li.itemId}`;
      if (!li.hsnCode) li.hsnCode = info?.hsnCode ?? "";
      if (!li.unit) li.unit = info?.unit ?? "";
    }
  }

  return {
    sale: {
      id: sale.id,
      invoiceNumber: sale.invoiceNumber,
      saleDate: sale.saleDate,
      paymentMode: sale.paymentMode,
      subtotal: Number(sale.subtotal),
      taxTotal: Number(sale.taxTotal),
      discountTotal: Number(sale.discountTotal),
      billDiscount: Number((sale as any).billDiscount ?? 0),
      totalAmount: Number(sale.totalAmount),
      lineItems,
      cancelledAt: locRow?.cancelled_at ? new Date(locRow.cancelled_at).toISOString() : null,
      quotationNumber: locRow?.quotation_number ?? null,
      otherCharges,
    },
    issuer,
    outletName: issuer.locationName,
    outletUpiId: issuer.upiId,
    customer: customerRow ? {
      name: customerRow.name,
      phone: customerRow.phone ?? "",
      address: customerRow.address ?? "",
      state: customerRow.state ?? "",
      gstNumber: customerRow.gstNumber ?? "",
    } : null,
    cs: { ...(cs ?? {}), paymentTerms } as Record<string, unknown>,
    logoDataUrl,
    position,
    recordedPayments,
    upiRequest,
    showBankDetails: paySettings.showBankDetailsOnInvoice,
  };
}

/**
 * Assemble the quotation variant of InvoiceData. Same shape, same renderer —
 * but every payment concern is absent by construction: position is null,
 * there are no recorded payments, no UPI request and no bank block.
 *
 * The quotations table is a raw-migration table, so everything here is raw SQL.
 */
export async function assembleQuotationData(quotationId: number): Promise<InvoiceData | null> {
  const { rows: [q] } = await pool.query<any>(
    `SELECT q.*,
            to_char(q.quote_date, 'YYYY-MM-DD') AS quote_date_s,
            to_char(q.valid_till, 'YYYY-MM-DD') AS valid_till_s
       FROM quotations q WHERE q.id = $1`,
    [quotationId],
  );
  if (!q) return null;

  const issuer = await resolveLocationIssuer(
    pool,
    q.location_type === "warehouse" ? "warehouse" : "outlet",
    Number(q.location_id),
  );

  const customerRow = q.customer_id
    ? (await db.select().from(customersTable).where(eq(customersTable.id, Number(q.customer_id))).limit(1))[0] ?? null
    : null;
  const [cs] = await db.select().from(companySettingsTable).limit(1);

  let logoDataUrl: string | null = null;
  if (cs) {
    const { rows: [pdfCols] } = await pool.query<{ logo_url: string | null }>(
      `SELECT logo_url FROM company_settings WHERE id = $1`, [cs.id],
    );
    const logo = pdfCols?.logo_url ?? null;
    logoDataUrl = logo && /^data:image\//i.test(logo) ? logo : null;
  }

  const lineItems: InvoiceLineItem[] = Array.isArray(q.line_items) ? (q.line_items as InvoiceLineItem[]) : [];
  const missingIds = [...new Set(
    lineItems.filter((li) => !li.itemName || !li.hsnCode || !li.unit).map((li) => li.itemId),
  )];
  if (missingIds.length > 0) {
    const rows = await db
      .select({ id: itemsTable.id, name: itemsTable.name, hsnCode: itemsTable.hsnCode, unit: itemsTable.unit })
      .from(itemsTable).where(inArray(itemsTable.id, missingIds));
    const infoMap = new Map(rows.map((r) => [r.id, r]));
    for (const li of lineItems) {
      const info = infoMap.get(li.itemId);
      if (!li.itemName) li.itemName = info?.name ?? `Item #${li.itemId}`;
      if (!li.hsnCode) li.hsnCode = info?.hsnCode ?? "";
      if (!li.unit) li.unit = info?.unit ?? "";
    }
  }

  const s = (v: unknown): string | null => {
    const t = typeof v === "string" ? v.trim() : "";
    return t.length > 0 ? t : null;
  };

  return {
    docType: "quotation",
    sale: {
      id: Number(q.id),
      invoiceNumber: q.quotation_number,           // the renderer's document number
      saleDate: q.quote_date_s,
      paymentMode: null,                            // a quotation has no payment concept
      subtotal: Number(q.subtotal),
      taxTotal: Number(q.tax_total),
      discountTotal: Number(q.discount_total),
      billDiscount: Number(q.bill_discount ?? 0),
      totalAmount: Number(q.total_amount),
      lineItems,
      cancelledAt: null,
    },
    quotation: {
      validTill: q.valid_till_s ?? null,
      convertedInvoiceNumber: s(q.converted_invoice_number),
      paymentTerms: s(q.payment_terms),
      salesperson: s(q.salesperson),
      notes: s(q.notes),
      termsConditions: s(q.terms_conditions),
      watermark: true,
    },
    shippingAddress: s(q.shipping_address),
    issuer,
    outletName: issuer.locationName,
    outletUpiId: "",
    customer: customerRow ? {
      name: customerRow.name,
      // The quotation's own billing address wins over the customer master's.
      phone: customerRow.phone ?? "",
      address: s(q.billing_address) ?? customerRow.address ?? "",
      state: s(q.place_of_supply) ?? customerRow.state ?? "",
      gstNumber: customerRow.gstNumber ?? "",
    } : null,
    cs: { ...(cs ?? {}) } as Record<string, unknown>,
    logoDataUrl,
    position: null,
    recordedPayments: [],
    upiRequest: null,
    showBankDetails: false,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function invoiceFileName(invoiceNumber: string | null, saleId: number): string {
  const base = (invoiceNumber || `INV-${saleId}`).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `Invoice-${base}.pdf`;
}

export function quotationFileName(quotationNumber: string | null, quotationId: number): string {
  const base = (quotationNumber || `QTN-${quotationId}`).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `Quotation-${base}.pdf`;
}

function esc(s: unknown): string { return String(s ?? ""); }

/** Bare grouped number for table cells, which carry their unit in the header. */
function money(n: number): string {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Money with the real rupee sign — safe because the font is embedded. */
function rs(n: number): string {
  return `${n < 0 ? "-" : ""}\u20B9${money(Math.abs(n))}`;
}

function toIndianWords(amount: number): string {
  const o = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
    "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
    "Seventeen", "Eighteen", "Nineteen"];
  const t = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  function h(n: number): string {
    if (n <= 0) return "";
    if (n < 20) return o[n] + " ";
    if (n < 100) return t[Math.floor(n / 10)] + (n % 10 ? " " + o[n % 10] : "") + " ";
    return o[Math.floor(n / 100)] + " Hundred " + h(n % 100);
  }
  // Normalise to whole paise before splitting, so 1.999 is not read as one
  // rupee and a hundred paise.
  const totalPaise = Math.round(Math.abs(amount) * 100);
  let r = Math.floor(totalPaise / 100);
  const paise = totalPaise % 100;
  if (r === 0 && paise === 0) return "Rupees Zero Only";
  let words = "Rupees ";
  if (r >= 10000000) { words += h(Math.floor(r / 10000000)) + "Crore "; r %= 10000000; }
  if (r >= 100000)   { words += h(Math.floor(r / 100000))   + "Lakh ";  r %= 100000; }
  if (r >= 1000)     { words += h(Math.floor(r / 1000))     + "Thousand "; r %= 1000; }
  if (r > 0)         { words += h(r); }
  words = words.trim();
  if (paise > 0) words += ` and ${h(paise).trim()} Paise`;
  return words + " Only";
}
// ── Colour palette — sampled from the reference design ───────────────────────
type RGB = [number, number, number];
const NAVY:   RGB = [23,  42,  92];   // primary dark navy (headers, titles)
const INK:    RGB = [32,  44,  74];   // dark blue-black body text
const MUT:    RGB = [104, 116, 140];  // muted slate labels / secondary text
const WHITE:  RGB = [255, 255, 255];
const PANEL:  RGB = [242, 245, 251];  // light blue panel/row background
const TOTBG:  RGB = [214, 227, 243];  // highlighted table TOTAL row
const BORDER: RGB = [201, 213, 229];  // thin blue-grey borders
const RED:    RGB = [198, 44,  44];   // outstanding balance emphasis
const BADGE: Record<string, RGB> = {
  unpaid: [214, 60, 48], partially_paid: [222, 140, 26], paid: [23, 128, 84], cancelled: [90, 96, 106],
};

// ── Page constants ────────────────────────────────────────────────────────────
const PW  = 210;
const PH  = 297;
const M   = 10;
const CW  = PW - M * 2;        // 190
const GAP = 4;
const HW  = (CW - GAP) / 2;    // 93 — half-width panel
const L2  = M + HW + GAP;      // right panel x
const BOT = PH - 12;           // content floor before a page break

// ── Renderer ──────────────────────────────────────────────────────────────────

export async function renderInvoicePdf(data: InvoiceData): Promise<{ buffer: Buffer; fileName: string }> {
  const {
    sale, issuer, customer, cs, logoDataUrl, position, recordedPayments, upiRequest, showBankDetails,
  } = data;
  // Quotation variant: same layout, but every payment surface is OMITTED —
  // the status strip, amount payable, bank details, QR and payment mode all
  // presuppose a receivable, and a quotation has none.
  const isQuotation = data.docType === "quotation";
  const q = data.quotation;
  const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });
  await registerFonts(doc);
  // The script face is decorative-only; the invoice must never fail over it.
  let scriptOk = true;
  try { await registerScriptFont(doc); } catch { scriptOk = false; }

  // ── UPI QR ─────────────────────────────────────────────────────────────────
  // The request — whether to ask at all, and for how much — was decided during
  // assembly from the shared payment position. This only turns it into an image,
  // so the QR cannot encode an amount the invoice does not print.
  let qrDataUrl: string | undefined;
  if (upiRequest) {
    try {
      qrDataUrl = await QRCode.toDataURL(upiRequest.uri, { width: 300, margin: 1, color: { dark: "#000000", light: "#FFFFFF" } });
    } catch { /* render without QR */ }
  }

  // ── Drawing helpers ─────────────────────────────────────────────────────────
  const fill = (x: number, y: number, w: number, h: number, rgb: RGB) => {
    doc.setFillColor(rgb[0], rgb[1], rgb[2]); doc.rect(x, y, w, h, "F");
  };
  const rfill = (x: number, y: number, w: number, h: number, rgb: RGB, r = 1.2) => {
    doc.setFillColor(rgb[0], rgb[1], rgb[2]); doc.roundedRect(x, y, w, h, r, r, "F");
  };
  const bx = (x: number, y: number, w: number, h: number, rgb: RGB = BORDER, r = 1.2, lw = 0.3) => {
    doc.setDrawColor(rgb[0], rgb[1], rgb[2]); doc.setLineWidth(lw); doc.roundedRect(x, y, w, h, r, r);
  };
  const ln = (x1: number, y1: number, x2: number, y2: number, rgb: RGB = BORDER, lw = 0.2) => {
    doc.setDrawColor(rgb[0], rgb[1], rgb[2]); doc.setLineWidth(lw); doc.line(x1, y1, x2, y2);
  };
  const txt = (s: string, x: number, y: number, opts?: {
    align?: "left" | "right" | "center"; bold?: boolean; size?: number; color?: RGB; maxWidth?: number;
  }) => {
    doc.setFont(FONT, opts?.bold ? "bold" : "normal");
    doc.setFontSize(opts?.size ?? 7.5);
    const c = opts?.color ?? INK;
    doc.setTextColor(c[0], c[1], c[2]);
    const tOpts: { align?: "left" | "right" | "center"; maxWidth?: number } = {};
    if (opts?.align) tOpts.align = opts.align;
    if (opts?.maxWidth) tOpts.maxWidth = opts.maxWidth;
    doc.text(s, x, y, tOpts);
  };
  /** Wrap to a width. The font must be set first or the metrics are wrong. */
  const wrap = (s: string, w: number, size: number, bold = false): string[] => {
    doc.setFont(FONT, bold ? "bold" : "normal");
    doc.setFontSize(size);
    return doc.splitTextToSize(s || "", w) as string[];
  };
  /**
   * Shrink a single line until it fits, then ellipsize.
   *
   * A cell that must stay on one line — a date, a code, a money figure — has no
   * wrapping to save it, so without this it silently draws over its neighbour.
   */
  const fit = (s: string, w: number, size: number, bold = false, floor = 1.8): { text: string; size: number } => {
    doc.setFont(FONT, bold ? "bold" : "normal");
    doc.setFontSize(size);
    if (doc.getTextWidth(s) <= w) return { text: s, size };
    for (let sz = size - 0.25; sz >= size - floor; sz -= 0.25) {
      doc.setFontSize(sz);
      if (doc.getTextWidth(s) <= w) return { text: s, size: sz };
    }
    const sz = Math.max(size - floor, 4);
    doc.setFontSize(sz);
    let t = s;
    while (t.length > 1 && doc.getTextWidth(`${t}\u2026`) > w) t = t.slice(0, -1);
    return { text: doc.getTextWidth(`${t}\u2026`) <= w ? `${t}\u2026` : "", size: sz };
  };
  /** Draw a one-line cell that must never overflow its column. */
  const cell = (s: string, x: number, y: number, w: number, opts: {
    align?: "left" | "right" | "center"; bold?: boolean; size?: number; color?: RGB;
  } = {}) => {
    const f = fit(s, w, opts.size ?? 7, opts.bold ?? false);
    txt(f.text, x, y, { ...opts, size: f.size });
  };

  // ── Tiny vector icons, per the reference visual language ───────────────────
  // Simple geometry only — a hand-drawn glyph that reads at 3 mm. Anything more
  // ornate turns to mud at print resolution.
  const stroke = (rgb: RGB = NAVY, lw = 0.35) => {
    doc.setDrawColor(rgb[0], rgb[1], rgb[2]); doc.setLineWidth(lw);
  };
  /** Sheet of paper with two text lines. */
  const icoDoc = (x: number, y: number, s: number, c: RGB = NAVY) => {
    stroke(c); doc.roundedRect(x + s * 0.12, y, s * 0.76, s, 0.2, 0.2);
    ln(x + s * 0.3, y + s * 0.35, x + s * 0.7, y + s * 0.35, c, 0.3);
    ln(x + s * 0.3, y + s * 0.62, x + s * 0.7, y + s * 0.62, c, 0.3);
  };
  /** Calendar: page, binder tabs, header rule. */
  const icoCal = (x: number, y: number, s: number, c: RGB = NAVY) => {
    stroke(c); doc.roundedRect(x, y + s * 0.14, s, s * 0.86, 0.2, 0.2);
    ln(x, y + s * 0.42, x + s, y + s * 0.42, c, 0.3);
    ln(x + s * 0.28, y, x + s * 0.28, y + s * 0.24, c, 0.35);
    ln(x + s * 0.72, y, x + s * 0.72, y + s * 0.24, c, 0.35);
  };
  /** Map pin: ring over a point. */
  const icoPin = (x: number, y: number, s: number, c: RGB = NAVY) => {
    stroke(c); doc.circle(x + s / 2, y + s * 0.34, s * 0.26);
    doc.setFillColor(c[0], c[1], c[2]);
    doc.triangle(x + s * 0.26, y + s * 0.5, x + s * 0.74, y + s * 0.5, x + s / 2, y + s, "F");
    doc.setFillColor(255, 255, 255);
    doc.circle(x + s / 2, y + s * 0.34, s * 0.1, "F");
  };
  /** Cycle arrows, abbreviated to a ring with one arrowhead. */
  const icoCycle = (x: number, y: number, s: number, c: RGB = NAVY) => {
    stroke(c); doc.circle(x + s / 2, y + s / 2, s * 0.36);
    doc.setFillColor(c[0], c[1], c[2]);
    doc.triangle(x + s * 0.86, y + s * 0.28, x + s * 0.98, y + s * 0.52, x + s * 0.68, y + s * 0.5, "F");
  };
  /** Person in a ring — the Billed/Shipped tab marker (drawn on navy). */
  const icoPerson = (x: number, y: number, s: number, c: RGB = WHITE) => {
    stroke(c, 0.3); doc.circle(x + s / 2, y + s / 2, s / 2);
    doc.setFillColor(c[0], c[1], c[2]);
    doc.circle(x + s / 2, y + s * 0.38, s * 0.14, "F");
    doc.ellipse(x + s / 2, y + s * 0.72, s * 0.24, s * 0.15, "F");
  };
  /** ₹ in a ring. */
  const icoRupee = (x: number, y: number, s: number, c: RGB = NAVY) => {
    stroke(c); doc.circle(x + s / 2, y + s / 2, s / 2);
    txt("\u20B9", x + s / 2, y + s * 0.68, { bold: true, size: s * 1.7, color: c, align: "center" });
  };
  /** Rosette: ring plus ribbon tails. */
  const icoMedal = (x: number, y: number, s: number, c: RGB = NAVY) => {
    stroke(c); doc.circle(x + s / 2, y + s * 0.36, s * 0.3);
    doc.setFillColor(c[0], c[1], c[2]);
    doc.triangle(x + s * 0.3, y + s * 0.58, x + s * 0.46, y + s, x + s * 0.18, y + s * 0.9, "F");
    doc.triangle(x + s * 0.7, y + s * 0.58, x + s * 0.82, y + s * 0.9, x + s * 0.54, y + s, "F");
  };
  /** Payment card. */
  const icoCard = (x: number, y: number, s: number, c: RGB = NAVY) => {
    stroke(c); doc.roundedRect(x, y + s * 0.16, s, s * 0.68, 0.3, 0.3);
    ln(x, y + s * 0.38, x + s, y + s * 0.38, c, 0.55);
    ln(x + s * 0.14, y + s * 0.68, x + s * 0.44, y + s * 0.68, c, 0.3);
  };
  /** Money bag: circle body + tied neck. */
  const icoBag = (x: number, y: number, s: number, c: RGB = NAVY) => {
    stroke(c); doc.circle(x + s / 2, y + s * 0.62, s * 0.36);
    ln(x + s * 0.36, y + s * 0.22, x + s * 0.64, y + s * 0.22, c, 0.45);
    ln(x + s * 0.4, y + s * 0.24, x + s * 0.5, y + s * 0.36, c, 0.35);
    ln(x + s * 0.6, y + s * 0.24, x + s * 0.5, y + s * 0.36, c, 0.35);
  };
  /** Bank: pediment over columns. */
  const icoBank = (x: number, y: number, s: number, c: RGB = NAVY) => {
    stroke(c);
    doc.triangle(x, y + s * 0.34, x + s, y + s * 0.34, x + s / 2, y, "S");
    for (const fx of [0.14, 0.5, 0.86]) ln(x + s * fx, y + s * 0.42, x + s * fx, y + s * 0.82, c, 0.4);
    ln(x, y + s * 0.92, x + s, y + s * 0.92, c, 0.45);
  };

  const fmtDate = new Date(sale.saleDate).toLocaleDateString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric" });
  const placeOfSupply = customer?.state || issuer.state;

  let y = M + 2;

  // ══════════════════════════════════════════════════════════════════════════
  // 1. HEADER — logo + seller identity left | TAX INVOICE + meta right
  // ══════════════════════════════════════════════════════════════════════════
  const BADGE_W = 64;
  const badgeX  = M + CW - BADGE_W;      // 136
  const nameX   = M + 23;
  const nameW   = badgeX - nameX - 9;    // never run under the divider

  // Logo: the company mark when one is uploaded, otherwise a navy lettermark
  // built from the seller's own initial.
  const LOGO_S = 19;
  const drawLettermark = () => {
    rfill(M, y, LOGO_S, LOGO_S, NAVY, 2);
    txt((issuer.tradeName[0] || "M").toUpperCase(), M + LOGO_S / 2, y + LOGO_S / 2 + 4,
        { bold: true, size: 16, color: WHITE, align: "center" });
  };
  if (logoDataUrl) {
    try {
      // Fit inside the box preserving aspect ratio — a wide or tall mark is
      // centred rather than stretched square.
      const props = doc.getImageProperties(logoDataUrl);
      const s = Math.min(LOGO_S / (props.width || 1), LOGO_S / (props.height || 1));
      const lw = (props.width || 1) * s;
      const lh = (props.height || 1) * s;
      doc.addImage(logoDataUrl, M + (LOGO_S - lw) / 2, y + (LOGO_S - lh) / 2, lw, lh, undefined, "FAST");
    } catch { drawLettermark(); }
  } else {
    drawLettermark();
  }

  // Seller name — large navy, wrapping to a second line rather than colliding
  // with the meta column.
  const nameLines = wrap(issuer.tradeName.toUpperCase() || "-", nameW, 17.5, true).slice(0, 2);
  let ly = y + 7.6;
  for (const nl of nameLines) {
    txt(nl, nameX, ly, { bold: true, size: 17.5, color: NAVY });
    ly += 7;
  }
  ly -= 1.2;

  // Address block — dark ink like the reference, not washed-out grey.
  for (const line of issuer.addressLines.slice(0, 4)) {
    cell(line, nameX, ly, nameW, { size: 7.4, color: INK });
    ly += 3.9;
  }
  // Contact row: phone and email side by side.
  if (issuer.phone || issuer.email) {
    ly += 1.6;
    let cx = nameX;
    if (issuer.phone) {
      // Handset: an arc bridging two round ends — a glyph would depend on the
      // font carrying U+260E, which the embedded face does not.
      stroke(NAVY, 0.5);
      doc.lines([[0.4, -1.7, 2.2, -1.7, 2.6, -0.2]], cx + 0.2, ly - 0.4);
      doc.setFillColor(NAVY[0], NAVY[1], NAVY[2]);
      doc.circle(cx + 0.35, ly - 0.5, 0.55, "F");
      doc.circle(cx + 2.85, ly - 0.5, 0.55, "F");
      const p = `+91 ${issuer.phone}`.replace(/^\+91 \+/, "+");
      txt(p, cx + 4, ly, { size: 7.4, color: INK });
      doc.setFont(FONT, "normal"); doc.setFontSize(7.4);
      cx += 4 + doc.getTextWidth(p) + 7;
    }
    if (issuer.email) {
      // Envelope: a slim rect with a flap.
      stroke(NAVY, 0.32); doc.rect(cx, ly - 2.2, 3.4, 2.5);
      ln(cx, ly - 2.2, cx + 1.7, ly - 0.8, NAVY, 0.32);
      ln(cx + 3.4, ly - 2.2, cx + 1.7, ly - 0.8, NAVY, 0.32);
      cell(issuer.email, cx + 5, ly, badgeX - cx - 14, { size: 7.4, color: INK });
    }
    ly += 4.6;
  }
  // Registrations — bold navy inside the identity block, per the reference.
  if (issuer.gstin) {
    ly += 1;
    txt(`GSTIN: ${issuer.gstin}`, nameX, ly + 1.6, { bold: true, size: 8.8, color: NAVY });
    ly += 5.6;
  }
  if (issuer.fssai) {
    txt(`FSSAI Lic. No.: ${issuer.fssai}`, nameX, ly + 0.8, { bold: true, size: 7.6, color: NAVY });
    ly += 4.8;
  }

  // Right: document banner + meta rows with icons. The badge names the
  // document: a quotation must never present itself as a tax invoice.
  rfill(badgeX, y, BADGE_W, 9.5, NAVY, 1);
  txt(isQuotation ? "QUOTATION" : "TAX INVOICE", badgeX + BADGE_W / 2, y + 6.4, { bold: true, size: 12, color: WHITE, align: "center" });

  const fmtIso = (iso: string): string =>
    new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric" });

  type MetaRow = [icon: (x: number, y: number, s: number) => void, label: string, value: string];
  const metaRows: MetaRow[] = [
    [icoDoc, isQuotation ? "Quotation No." : "Invoice No.", esc(sale.invoiceNumber || "-")],
    [icoCal, isQuotation ? "Quotation Date" : "Invoice Date", fmtDate],
  ];
  if (isQuotation && q?.validTill) {
    metaRows.push([icoCal, "Valid Till", fmtIso(q.validTill)]);
  }
  // Which branch raised it. Only worth a line when the location is named
  // something other than the trade name printed above.
  if (issuer.locationName && issuer.locationName !== issuer.tradeName) {
    metaRows.push([icoDoc, "Issued From", issuer.locationName]);
  }
  if (placeOfSupply) metaRows.push([icoPin, "Place of Supply", placeOfSupply]);
  if (isQuotation) {
    if (q?.salesperson) metaRows.push([(x, yy, s) => icoPerson(x, yy, s, NAVY), "Salesperson", q.salesperson]);
    // Two-way trace: a converted quotation names the invoice it became.
    if (q?.convertedInvoiceNumber) metaRows.push([icoCycle, "Converted To", q.convertedInvoiceNumber]);
  } else {
    // Two-way trace: a converted sale names the quotation it came from.
    if (sale.quotationNumber) metaRows.push([icoCycle, "Converted From", sale.quotationNumber]);
    metaRows.push([icoCycle, "Reverse Charge", "No"]);
  }

  let my = y + 14.6;
  for (const [icon, label, value] of metaRows) {
    icon(badgeX + 0.5, my - 2.9, 3.4);
    txt(label, badgeX + 6.5, my, { size: 7.4, color: INK });
    cell(`:  ${value}`, badgeX + 28.5, my, BADGE_W - 29, { size: 7.4, bold: true, color: INK });
    my += 6.2;
  }
  my -= 2.2;

  const headerBottom = Math.max(ly + 1, my);
  // Vertical divider between identity and meta, then a rule closing the header.
  ln(badgeX - 4.5, y + 1, badgeX - 4.5, headerBottom - 1, BORDER, 0.35);
  ln(M, headerBottom + 2, M + CW, headerBottom + 2, BORDER, 0.4);
  y = headerBottom + 6;

  // ══════════════════════════════════════════════════════════════════════════
  // 2. BILLED TO / SHIPPED TO — tabbed panels
  // ══════════════════════════════════════════════════════════════════════════
  const custRows: [string, string][] = [
    ["Name", customer?.name || "Walk-in Customer"],
  ];
  if (customer?.address)   custRows.push(["Address", customer.address]);
  if (customer?.state)     custRows.push(["State", customer.state]);
  if (customer?.gstNumber) custRows.push(["GSTIN", customer.gstNumber]);
  if (customer?.phone)     custRows.push(["Mobile No.", customer.phone]);

  // Ship-to may differ (quotations carry their own shipping address); when it
  // does, the second panel swaps only the Address row.
  const shipRows: [string, string][] = data.shippingAddress
    ? custRows.map(([k, v]) => (k === "Address" ? [k, data.shippingAddress!] : [k, v]) as [string, string])
    : custRows;
  if (data.shippingAddress && !custRows.some(([k]) => k === "Address")) {
    shipRows.splice(1, 0, ["Address", data.shippingAddress]);
  }

  const TAB_W = 36, TAB_H = 7;
  const BT_LH = 4.0;               // per text line
  const BT_PAD = 3.0;
  // Address may wrap; panel height follows the real line count.
  const valW = HW - 34;
  const wrapRows = (rows: [string, string][]): { rows: [string, string[]][]; lines: number } => {
    let n = 0;
    const out = rows.map(([k, v]) => {
      const lines = wrap(v, valW, 7.6);
      n += Math.max(lines.length, 1);
      return [k, lines] as [string, string[]];
    });
    return { rows: out, lines: n };
  };
  const billed = wrapRows(custRows);
  const shipped = wrapRows(shipRows);
  // Both panels share one height — the taller content decides it.
  const BT_H = TAB_H + BT_PAD
    + Math.max(billed.lines, shipped.lines) * BT_LH
    + Math.max(billed.rows.length, shipped.rows.length) * 1.2 + 1.6;

  for (const px of [M, L2]) {
    const panelRows = px === M ? billed.rows : shipped.rows;
    bx(px, y + TAB_H / 2, HW, BT_H - TAB_H / 2, BORDER, 1.2);
    rfill(px, y, TAB_W, TAB_H, NAVY, 1);
    icoPerson(px + 2.6, y + 1.55, 3.9);
    txt(px === M ? "BILLED TO" : "SHIPPED TO", px + 8.4, y + 4.8, { bold: true, size: 7.8, color: WHITE });
    let ry = y + TAB_H + BT_PAD + 1.4;
    for (const [k, lines] of panelRows) {
      txt(k, px + 4, ry, { size: 7.6, color: INK });
      txt(":", px + 26, ry, { size: 7.6, color: INK });
      lines.forEach((lv, i) => txt(lv, px + 29.5, ry + i * BT_LH, { size: 7.6, color: INK }));
      ry += Math.max(lines.length, 1) * BT_LH + 1.2;
    }
  }
  y += BT_H + 3;

  // ══════════════════════════════════════════════════════════════════════════
  // 3. GOODS TABLE
  // ══════════════════════════════════════════════════════════════════════════
  // Col widths: Sl | Desc | HSN | Qty | Unit | MRP | Disc/Unit | Taxable | C% | CAmt | S% | SAmt | I% | IAmt | Total
  const W = [8, 35.5, 13, 8, 9, 14, 12.5, 18, 7.5, 10.5, 7.5, 10.5, 7.5, 10.5, 18];
  const X: number[] = [];
  { let cx = M; for (const w of W) { X.push(cx); cx += w; } }
  const XEND = M + CW;

  const HDR1 = 6.4;   // first header row height
  const HDR2 = 5.6;   // second header row height (rate/amount sub-row, padded)
  const THDR = HDR1 + HDR2;
  const TROW = 6.9;   // minimum row height; a wrapped description grows it

  const drawTableHeader = (yy: number): number => {
    fill(M, yy, CW, THDR, NAVY);

    const allCols = [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14];
    for (const i of allCols) ln(X[i], yy, X[i], yy + THDR, WHITE, 0.2);
    ln(X[9],  yy + HDR1, X[9],  yy + THDR, WHITE, 0.15);
    ln(X[11], yy + HDR1, X[11], yy + THDR, WHITE, 0.15);
    ln(X[13], yy + HDR1, X[13], yy + THDR, WHITE, 0.15);
    // Divider between the GST group captions and their RATE/AMOUNT sub-row —
    // spans all six GST columns and nothing else.
    ln(X[8], yy + HDR1, X[14], yy + HDR1, WHITE, 0.15);

    const cy1 = yy + THDR / 2 + 1.8;
    txt("SL",           X[0]  + W[0]/2,  cy1 - 1.6, { bold: true, size: 6, color: WHITE, align: "center" });
    txt("NO.",          X[0]  + W[0]/2,  cy1 + 1.6, { bold: true, size: 6, color: WHITE, align: "center" });
    txt("DESCRIPTION OF GOODS", X[1]+2, cy1,         { bold: true, size: 6.6, color: WHITE });
    txt("HSN",          X[2]  + W[2]/2,  cy1 - 1.6, { bold: true, size: 6, color: WHITE, align: "center" });
    txt("CODE",         X[2]  + W[2]/2,  cy1 + 1.6, { bold: true, size: 6, color: WHITE, align: "center" });
    txt("QTY",          X[3]  + W[3]/2,  cy1,        { bold: true, size: 6, color: WHITE, align: "center" });
    txt("UNIT",         X[4]  + W[4]/2,  cy1,        { bold: true, size: 6, color: WHITE, align: "center" });
    txt("MRP",          X[5]  + W[5]/2,  cy1 - 1.6, { bold: true, size: 5.6, color: WHITE, align: "center" });
    txt("(\u20B9)",     X[5]  + W[5]/2,  cy1 + 1.6, { bold: true, size: 5.6, color: WHITE, align: "center" });
    txt("DISC./UNIT",   X[6]  + W[6]/2,  cy1 - 1.6, { bold: true, size: 5.2, color: WHITE, align: "center" });
    txt("(\u20B9)",     X[6]  + W[6]/2,  cy1 + 1.6, { bold: true, size: 5.2, color: WHITE, align: "center" });
    txt("TAXABLE",      X[7]  + W[7]/2,  cy1 - 1.6, { bold: true, size: 5.8, color: WHITE, align: "center" });
    txt("VALUE (\u20B9)", X[7] + W[7]/2, cy1 + 1.6, { bold: true, size: 5.8, color: WHITE, align: "center" });
    const gy1 = yy + HDR1 - 2;
    txt("CGST", X[8]  + (W[8]+W[9])/2,  gy1, { bold: true, size: 6.6, color: WHITE, align: "center" });
    txt("SGST", X[10] + (W[10]+W[11])/2, gy1, { bold: true, size: 6.6, color: WHITE, align: "center" });
    txt("IGST", X[12] + (W[12]+W[13])/2,gy1, { bold: true, size: 6.6, color: WHITE, align: "center" });
    txt("TOTAL",        X[14] + W[14]/2, cy1 - 1.6, { bold: true, size: 6, color: WHITE, align: "center" });
    txt("(\u20B9)",     X[14] + W[14]/2, cy1 + 1.6, { bold: true, size: 6, color: WHITE, align: "center" });
    // Sub-row labels are centred on the sub-row's own vertical middle so the
    // divider above never crosses the text; the three groups share identical
    // geometry by construction.
    const cy2 = yy + HDR1 + HDR2 / 2;
    for (const g of [8, 10, 12]) {
      txt("RATE",   X[g]   + W[g]/2,   cy2 - 0.4, { bold: true, size: 4.8, color: WHITE, align: "center" });
      txt("(%)",    X[g]   + W[g]/2,   cy2 + 1.8, { bold: true, size: 4.8, color: WHITE, align: "center" });
      txt("AMOUNT", X[g+1] + W[g+1]/2, cy2 + 0.7, { bold: true, size: 4.8, color: WHITE, align: "center" });
    }

    return yy + THDR;
  };

  y = drawTableHeader(y);

  const drawRowGrid = (yy: number, h: number) => {
    ln(M, yy + h, XEND, yy + h, BORDER, 0.2);
    ln(M, yy, M, yy + h, BORDER, 0.3);
    ln(XEND, yy, XEND, yy + h, BORDER, 0.3);
    for (let i = 1; i < X.length; i++) ln(X[i], yy, X[i], yy + h, BORDER, 0.15);
  };

  let tQty = 0, tTaxable = 0, tCgst = 0, tSgst = 0, tIgst = 0, tTot = 0;
  const items = sale.lineItems || [];
  const DESC_LH = 3.4;

  // GST is summarised per rate, not in one lump: a bill mixing 5% and 12% goods
  // owes a separate figure for each slab, and labelling the combined total with
  // the first line's rate would understate one of them on the face of the
  // document. Keyed by the rate that gets printed — half the slab for CGST/SGST.
  const byRate = { cgst: new Map<number, number>(), sgst: new Map<number, number>(), igst: new Map<number, number>() };
  const bump = (m: Map<number, number>, rate: number, amt: number): void => {
    if (amt > 0) m.set(rate, (m.get(rate) ?? 0) + amt);
  };

  items.forEach((li, idx) => {
    const qty     = Number(li.quantity  ?? 0);
    const gross   = qty * Number(li.unitPrice ?? 0) - Number(li.discount ?? 0);
    const taxable = Number(li.lineSubtotal ?? gross);
    // Display-only decomposition: MRP column shows the stored per-unit price
    // (the selling price BEFORE discount — sale lines are floored at master
    // MRP), and the discount column shows the line's total pre-tax deduction
    // (item discount + any allocated bill-discount share) per unit. Legacy
    // lines store the discount as a line total, so dividing by qty yields the
    // per-unit figure for both generations. Nothing here feeds the totals —
    // taxable, GST and line total keep reading the stored figures. A line
    // without a positive, finite quantity has no meaningful per-unit figure,
    // so it renders "-" rather than mislabelling a line total as per-unit.
    const discRaw = Number(li.discount ?? 0);
    const discPerUnit = Number.isFinite(discRaw) && Number.isFinite(qty) && qty > 0 ? discRaw / qty : 0;
    const cgst    = Number(li.cgst ?? 0);
    const sgst    = Number(li.sgst ?? 0);
    const igst    = Number(li.igst ?? 0);
    const rate    = Number(li.taxRate ?? 0);
    const lineTot = taxable + Number(li.taxAmount ?? 0);
    const isIgst  = li.taxType === "igst" || igst > 0;

    // A long product name wraps onto extra lines and grows the row, rather than
    // being cut off — the description is what the customer checks the bill by.
    const nameLines2 = wrap(esc(li.itemName || `Item #${li.itemId}`), W[1] - 3, 7.2).slice(0, 4);
    const rowH = Math.max(TROW, nameLines2.length * DESC_LH + 4.1);

    if (y + rowH > BOT - 40) { doc.addPage(); y = M; y = drawTableHeader(y); }

    tQty += qty; tTaxable += taxable; tCgst += cgst; tSgst += sgst; tIgst += igst; tTot += lineTot;
    bump(byRate.cgst, rate / 2, cgst); bump(byRate.sgst, rate / 2, sgst); bump(byRate.igst, rate, igst);

    drawRowGrid(y, rowH);

    // Single-line cells sit on the vertical centre of the row so a one-line row
    // reads centred, like the reference.
    const ry = nameLines2.length > 1 ? y + 4.7 : y + rowH / 2 + 1.2;
    txt(String(idx + 1), X[0] + W[0]/2, ry, { size: 7.2, align: "center" });
    nameLines2.forEach((nl, i) => txt(nl, X[1] + 2, ry + i * DESC_LH, { size: 7.2 }));
    cell(li.hsnCode ? esc(li.hsnCode) : "-", X[2] + W[2]/2, ry, W[2] - 2, { size: 7, align: "center" });
    cell(String(qty),                        X[3] + W[3]/2, ry, W[3] - 2, { size: 7.2, align: "center" });
    cell((li.unit || "-").toUpperCase(),      X[4] + W[4]/2, ry, W[4] - 2, { size: 7, align: "center" });
    cell(money(Number(li.unitPrice ?? 0)),    X[5] + W[5]-1.5, ry, W[5] - 3, { size: 7.2, align: "right" });
    if (discPerUnit > 0.004) {
      cell(money(discPerUnit), X[6] + W[6]-1.5, ry, W[6] - 3, { size: 7.2, align: "right" });
    } else {
      txt("-", X[6] + W[6]/2, ry, { size: 7, align: "center", color: MUT });
    }
    cell(money(taxable),                      X[7] + W[7]-1.5, ry, W[7] - 3, { size: 7.2, align: "right" });

    if (isIgst) {
      txt("-", X[8] + W[8]/2,  ry, { size: 7, align: "center", color: MUT });
      txt("-", X[9] + W[9]/2,  ry, { size: 7, align: "center", color: MUT });
      txt("-", X[10]+ W[10]/2, ry, { size: 7, align: "center", color: MUT });
      txt("-", X[11]+ W[11]/2, ry, { size: 7, align: "center", color: MUT });
      cell(`${rate}%`,   X[12]+ W[12]/2, ry, W[12] - 2, { size: 6.8, align: "center" });
      cell(money(igst),  X[13]+ W[13]-1.5, ry, W[13] - 3, { size: 7.2, align: "right" });
    } else {
      cell(`${rate/2}%`, X[8] + W[8]/2,  ry, W[8] - 2,  { size: 6.8, align: "center" });
      cell(money(cgst),  X[9] + W[9]-1.5,  ry, W[9] - 3,  { size: 7.2, align: "right" });
      cell(`${rate/2}%`, X[10]+ W[10]/2,  ry, W[10] - 2,  { size: 6.8, align: "center" });
      cell(money(sgst),  X[11]+ W[11]-1.5, ry, W[11] - 3, { size: 7.2, align: "right" });
      txt("-", X[12]+ W[12]/2, ry, { size: 7, align: "center", color: MUT });
      txt("-", X[13]+ W[13]/2, ry, { size: 7, align: "center", color: MUT });
    }
    cell(money(lineTot), X[14] + W[14]-1.5, ry, W[14] - 3, { size: 7.2, align: "right", bold: true });
    y += rowH;
  });

  // TOTAL row — light-blue highlight with navy bold figures, per the reference.
  if (y + TROW > BOT - 40) { doc.addPage(); y = M; y = drawTableHeader(y); }
  fill(M, y, CW, TROW, TOTBG);
  drawRowGrid(y, TROW);
  const sr = y + TROW / 2 + 1.2;
  txt("TOTAL (E&OE)", X[1] + 2, sr, { bold: true, size: 7.2, color: NAVY });
  cell(String(Math.round(tQty * 1000) / 1000), X[3] + W[3]/2, sr, W[3] - 2, { bold: true, size: 7.2, color: NAVY, align: "center" });
  cell(money(tTaxable), X[7] + W[7]-1.5, sr, W[7] - 3, { bold: true, size: 7.2, color: NAVY, align: "right" });
  cell(tCgst > 0 ? money(tCgst) : "-", X[9]  + W[9]-1.5,  sr, W[9] - 3,  { bold: true, size: 7.2, color: NAVY, align: "right" });
  cell(tSgst > 0 ? money(tSgst) : "-", X[11] + W[11]-1.5, sr, W[11] - 3, { bold: true, size: 7.2, color: NAVY, align: "right" });
  cell(tIgst > 0 ? money(tIgst) : "-", X[13] + W[13]-1.5, sr, W[13] - 3, { bold: true, size: 7.2, color: NAVY, align: "right" });
  cell(money(tTot), X[14] + W[14]-1.5, sr, W[14] - 3, { bold: true, size: 7.2, color: NAVY, align: "right" });
  y += TROW + 3.5;

  // ══════════════════════════════════════════════════════════════════════════
  // 4. AMOUNT IN WORDS (left) + TAX SUMMARY (right)
  // ══════════════════════════════════════════════════════════════════════════
  const grandTotal  = sale.totalAmount;
  const discount    = sale.discountTotal;
  const roundOff    = 0;

  /**
   * One row per slab, ascending. A rate of zero means the line carried tax but
   * no rate we can name, so the head is labelled without a percentage rather
   * than being captioned "(0%)" next to a non-zero figure.
   */
  const slabRows = (label: string, m: Map<number, number>): [string, string][] =>
    [...m.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([rate, amt]) => [rate > 0 ? `${label} (${+rate.toFixed(2)}%)` : label, rs(amt)]);

  // Decompose the pre-tax discounts so the customer can follow the arithmetic:
  // Gross − Item Discounts − Bill Discount = the post-discount value whose
  // Taxable + GST breakdown follows. The stored line figures already carry
  // both discounts, so these rows are informational — nothing is deducted
  // twice. Per-unit lines total unitDiscount × qty; historical lines keep the
  // recorded line-total amount.
  const grossItemValue = sale.lineItems.reduce(
    (s, li) => s + Math.round(Number(li.quantity ?? 0) * Number(li.unitPrice ?? 0) * 100) / 100, 0);
  const itemDiscTotal = sale.lineItems.reduce((s, li) => {
    const perLine = li.unitDiscount != null
      ? Math.round(Number(li.unitDiscount) * Number(li.quantity ?? 0) * 100) / 100
      : Math.max(0, Number(li.discount ?? 0) - Number(li.billDiscountShare ?? 0));
    return s + perLine;
  }, 0);
  const billDiscount = Number(sale.billDiscount ?? 0);

  const taxRows: [string, string][] = [];
  if (itemDiscTotal > 0.004 || billDiscount > 0.004) {
    taxRows.push(["Gross Item Value", rs(grossItemValue)]);
    if (itemDiscTotal > 0.004) taxRows.push(["Item Discounts", `- ${rs(itemDiscTotal)}`]);
    if (billDiscount > 0.004) taxRows.push(["Bill Discount", `- ${rs(billDiscount)}`]);
  }
  taxRows.push(["Taxable Value", rs(sale.subtotal)]);
  taxRows.push(...slabRows("CGST", byRate.cgst));
  taxRows.push(...slabRows("SGST", byRate.sgst));
  taxRows.push(...slabRows("IGST", byRate.igst));
  if (discount > 0) taxRows.push(["Coupon Discount", `- ${rs(discount)}`]);
  // Other Charges — stored figures with their ledger names, one row each.
  // Already inside the grand total and outside the taxable/GST rows above;
  // nothing here is computed, so a chargeless invoice shows no extra rows.
  for (const oc of sale.otherCharges ?? []) {
    taxRows.push([oc.name, rs(oc.amount)]);
  }
  taxRows.push(["Round Off", rs(roundOff)]);

  const TR_H    = 5.9;
  const GT_H    = 8.6;
  const SUMH    = taxRows.length * TR_H + GT_H;
  // The words panel must also fit its own content: heading, every wrapped
  // words line, and the certification block pinned to its floor — a very
  // large total ("Ninety-Nine Lakh …") wraps to 3-4 lines and would otherwise
  // run into the certification text.
  const wordLines = wrap(toIndianWords(grandTotal), HW - 9, 9.2, true);
  const WORDS_H = Math.max(SUMH, 15.5 + wordLines.length * 4.8 + 12, 32);
  if (y + WORDS_H > BOT - 24) { doc.addPage(); y = M; }

  // Left — amount in words.
  bx(M, y, HW, WORDS_H, BORDER, 1.2);
  icoRupee(M + 4, y + 4, 4.6);
  txt("AMOUNT IN WORDS", M + 11.5, y + 7.4, { bold: true, size: 7.2, color: MUT });
  wordLines.forEach((w, i) =>
    txt(w, M + 4.5, y + 15.5 + i * 4.8, { bold: true, size: 9.2, color: NAVY }));
  icoMedal(M + 4.5, y + WORDS_H - 9.5, 4);
  txt("Certified that the particulars given", M + 11, y + WORDS_H - 8.2, { size: 6.8, color: MUT });
  txt("above are true and correct.", M + 11, y + WORDS_H - 5, { size: 6.8, color: MUT });

  // Right — tax summary rows with alternating tint, then the navy Grand Total.
  bx(L2, y, HW, WORDS_H, BORDER, 1.2);
  const sumTop = y + (WORDS_H - SUMH);
  taxRows.forEach(([label, val], i) => {
    const ry = sumTop + i * TR_H;
    if (i % 2 === 1) fill(L2 + 0.3, ry, HW - 0.6, TR_H, PANEL);
    if (i > 0) ln(L2, ry, L2 + HW, ry, BORDER, 0.15);
    txt(label, L2 + 4, ry + TR_H / 2 + 1.2, { size: 7.8, color: INK });
    cell(val, L2 + HW - 3.5, ry + TR_H / 2 + 1.2, HW - 46, { size: 7.8, align: "right", color: INK });
  });

  const gtY = sumTop + taxRows.length * TR_H;
  fill(L2 + 0.15, gtY, HW - 0.3, GT_H - 0.15, NAVY);
  txt("GRAND TOTAL", L2 + 4, gtY + GT_H / 2 + 1.6, { bold: true, size: 10, color: WHITE });
  cell(rs(grandTotal), L2 + HW - 3.5, gtY + GT_H / 2 + 1.6, HW - 40, { bold: true, size: 10.5, color: WHITE, align: "right" });

  y += WORDS_H + 3.5;

  // ══════════════════════════════════════════════════════════════════════════
  // 5. PAYMENT POSITION — status strip, then either a request or a receipt
  //    (invoices only — a quotation OMITS every payment surface entirely)
  // ══════════════════════════════════════════════════════════════════════════
  // The strip states where the invoice stands; the panel below either asks for
  // the balance or records that nothing is owed. Both read the same position
  // object, so the QR can never ask for an amount the invoice does not print.
  if (!isQuotation && position) {
  const STATUS_LABEL: Record<string, string> = {
    unpaid: "UNPAID", partially_paid: "PARTIAL", paid: "PAID", cancelled: "CANCELLED",
  };
  const statusColor = BADGE[position.status];
  const statusText  = STATUS_LABEL[position.status];

  // Figures across the strip. Credit notes only appear when there are some —
  // an empty "Less Credit Notes  ₹0.00" row invites questions about a return
  // that never happened.
  const posCells: Array<[string, string, RGB?]> = [["Invoice Total", rs(position.invoiceTotal)]];
  if (position.creditAdjustments > 0) posCells.push(["Less Credit Notes", `- ${rs(position.creditAdjustments)}`]);
  posCells.push(["Amount Received", rs(position.amountReceived)]);
  posCells.push(["Balance Due", rs(position.outstanding), position.outstanding > 0 ? RED : undefined]);

  const STRIP_H = 13;
  if (y + STRIP_H > BOT - 8) { doc.addPage(); y = M; }
  bx(M, y, CW, STRIP_H, BORDER, 1.2);
  const LBL_W = 46;
  icoCard(M + 4.5, y + STRIP_H / 2 - 2.2, 4.4);
  txt("PAYMENT STATUS", M + 11, y + STRIP_H / 2 + 1.3, { bold: true, size: 7.4, color: NAVY });
  const pillW = Math.max(24, 12 + statusText.length * 2);
  const figW = (CW - LBL_W - (pillW + 10)) / posCells.length;
  posCells.forEach(([label, value, color], i) => {
    const cx = M + LBL_W + i * figW;
    txt(label, cx, y + 5.2, { size: 6.8, color: MUT });
    cell(value, cx, y + 10.6, figW - 5, { bold: true, size: 9.2, color: color ?? INK });
  });
  doc.setFillColor(statusColor[0], statusColor[1], statusColor[2]);
  doc.roundedRect(M + CW - pillW - 5, y + (STRIP_H - 7.4) / 2, pillW, 7.4, 2.6, 2.6, "F");
  txt(statusText, M + CW - 5 - pillW / 2, y + STRIP_H / 2 + 1.5, { bold: true, size: 7.6, color: WHITE, align: "center" });
  y += STRIP_H + 3;

  // Whether the arrangement the bill was raised under ("credit") was already
  // stated inside the bank-details panel; if not, it gets its own bar below.
  let paymentModeShown = false;

  if (position.isCancelled) {
    // Cancelled: the stock, revenue and receivable were all reversed. Asking for
    // money against it — by QR or by bank transfer — would be a real error.
    const CAN_H = 20;
    if (y + CAN_H > BOT) { doc.addPage(); y = M; }
    bx(M, y, CW, CAN_H, BORDER, 1.2);
    txt("PAYMENT DETAILS", M + 4.5, y + 6, { bold: true, size: 7.6, color: NAVY });
    txt("This invoice has been cancelled. No payment is due and no payment should be made against it.",
        M + 4.5, y + 12.5, { size: 7.2, color: INK, maxWidth: CW - 9 });
    if (sale.cancelledAt) {
      txt(`Cancelled on ${String(sale.cancelledAt).slice(0, 10)}`, M + 4.5, y + 17, { size: 6.4, color: MUT });
    }
    y += CAN_H + 4;
  } else if (position.outstanding > 0) {
    // Something is owed. Three panels, each dropped when it has nothing to say:
    // what to pay, where to transfer it, and the QR to scan.
    const bank = showBankDetails ? issuer.bank : null;
    const bankRows: [string, string][] = [];
    if (bank) {
      if (bank.holder)        bankRows.push(["Account Holder Name", bank.holder]);
      if (bank.name)          bankRows.push(["Bank Name", bank.name]);
      if (bank.branch)        bankRows.push(["Branch", bank.branch]);
      if (bank.accountNumber) bankRows.push(["Account Number", bank.accountNumber]);
      if (bank.accountType)   bankRows.push(["Account Type", bank.accountType]);
      if (bank.ifsc)          bankRows.push(["IFSC Code", bank.ifsc]);
    }
    // Payment mode joins the payment details, as on the reference layout.
    if (bankRows.length > 0 && sale.paymentMode) {
      bankRows.push(["Payment Mode", paymentModeLabel(sale.paymentMode)]);
      paymentModeShown = true;
    }
    const hasQr = Boolean(qrDataUrl && upiRequest);
    const QR_SIZE = 27;

    // Widths adapt to what is actually present, so a seller with no bank
    // account does not get a wide empty box next to the QR.
    const payW  = hasQr && bankRows.length > 0 ? 57 : bankRows.length > 0 || hasQr ? HW : CW;
    const qrW   = hasQr ? (bankRows.length > 0 ? 49 : CW - payW - GAP) : 0;
    const bankW = bankRows.length > 0 ? CW - payW - qrW - (hasQr ? GAP * 2 : GAP) : 0;
    const PAY_H = Math.max(40, 13.5 + bankRows.length * 4.6, hasQr ? QR_SIZE + 17 : 0);
    if (y + PAY_H > BOT) { doc.addPage(); y = M; }

    // Amount payable
    bx(M, y, payW, PAY_H, BORDER, 1.2);
    icoBag(M + 4.5, y + 4.4, 4.8);
    txt("AMOUNT PAYABLE", M + 11.5, y + 8, { bold: true, size: 7.6, color: NAVY });
    cell(rs(position.outstanding), M + 4.5, y + 20.5, payW - 9, { bold: true, size: 16.5, color: NAVY });
    wrap(bankRows.length > 0
          ? "Please settle this balance by bank transfer using the details alongside."
          : position.status === "partially_paid"
            ? "Balance outstanding on this invoice."
            : "Total amount outstanding on this invoice.", payW - 10, 6.8)
      .forEach((t, i) => txt(t, M + 4.5, y + 27.5 + i * 3.6, { size: 6.8, color: MUT }));
    if (sale.invoiceNumber) {
      txt(`Ref: ${esc(sale.invoiceNumber)}`, M + 4.5, y + PAY_H - 4, { size: 6.4, color: MUT });
    }

    // Bank transfer details
    if (bankRows.length > 0) {
      const bxx = M + payW + GAP;
      bx(bxx, y, bankW, PAY_H, BORDER, 1.2);
      icoBank(bxx + 4.5, y + 3.9, 4.6);
      txt("BANK ACCOUNT DETAILS", bxx + 11.5, y + 8, { bold: true, size: 7.6, color: NAVY });
      bankRows.forEach(([k, v], i) => {
        const by = y + 14 + i * 4.6;
        txt(k, bxx + 4.5, by, { size: 6.8, color: INK });
        txt(":", bxx + 33, by, { size: 6.8, color: INK });
        cell(v, bxx + 36, by, bankW - 41, { size: 6.9, color: INK, bold: true });
      });
    }

    // Scan & pay
    if (hasQr && upiRequest) {
      const qx = M + CW - qrW;
      bx(qx, y, qrW, PAY_H, BORDER, 1.2);
      txt("SCAN & PAY", qx + qrW / 2, y + 6.6, { bold: true, size: 7.6, color: NAVY, align: "center" });
      doc.addImage(qrDataUrl!, "PNG", qx + (qrW - QR_SIZE) / 2, y + 9.5, QR_SIZE, QR_SIZE);
      // Navy strip footing the panel with the UPI handle, per the reference.
      const stripH = 6.5;
      doc.setFillColor(NAVY[0], NAVY[1], NAVY[2]);
      doc.roundedRect(qx, y + PAY_H - stripH, qrW, stripH, 1.2, 1.2, "F");
      fill(qx, y + PAY_H - stripH, qrW, 1.4, NAVY); // square off the top edge
      cell(`UPI ID: ${upiRequest.upiId}`, qx + qrW / 2, y + PAY_H - stripH / 2 + 1.1, qrW - 5,
           { bold: true, size: 6.4, color: WHITE, align: "center" });
    }
    y += PAY_H + 3;
  } else {
    // Settled: say how it was paid instead of asking for it again.
    const shown = recordedPayments.slice(0, 6);
    const REC_H = 15 + Math.max(shown.length, 1) * 5.2;
    if (y + REC_H > BOT) { doc.addPage(); y = M; }
    bx(M, y, CW, REC_H, BORDER, 1.2);
    icoCard(M + 4.5, y + 3.9, 4.4);
    txt("PAYMENT RECEIVED", M + 11.5, y + 7.4, { bold: true, size: 7.6, color: NAVY });
    txt("Settled in full — no payment is due.", M + CW - 4.5, y + 7.4, { size: 6.8, color: MUT, align: "right" });
    if (shown.length === 0) {
      txt("Settled in full.", M + 4.5, y + 14.5, { size: 7.2, color: INK });
    } else {
      shown.forEach((p, i) => {
        const py = y + 14.5 + i * 5.2;
        const parts = [paymentModeLabel(p.method ?? "") || "-"];
        if (p.paymentDate) parts.push(p.paymentDate);
        if (p.referenceNumber) parts.push(`Ref ${p.referenceNumber}`);
        if (p.source === "counter") parts.push("received at counter");
        cell(parts.join("   -   "), M + 4.5, py, CW - 46, { size: 6.9, color: INK });
        txt(rs(p.amount), M + CW - 4.5, py, { size: 6.9, bold: true, align: "right", color: INK });
      });
    }
    y += REC_H + 4;
  }

  // The payment MODE is the arrangement the bill was raised under ("credit"), not
  // its status — the strip above owns the status, so the mode is stated once here.
  if (sale.paymentMode && !paymentModeShown) {
    if (y + 8 > BOT) { doc.addPage(); y = M; }
    bx(M, y, CW, 8, BORDER, 1.2);
    txt("Payment Mode", M + 4.5, y + 5.4, { bold: true, size: 7.4, color: NAVY });
    txt(`:  ${esc(paymentModeLabel(sale.paymentMode))}`, M + 33, y + 5.4, { size: 7.4, color: INK, bold: true });
    y += 8 + 4;
  }

  // Payment terms (Company Settings → Invoice PDF section)
  const payTerms = typeof cs.paymentTerms === "string" ? cs.paymentTerms.trim() : "";
  if (payTerms) {
    const termLines = wrap(payTerms, CW - 9, 6.8);
    const termsH = 9 + termLines.length * 3.4;
    if (y + termsH > BOT) { doc.addPage(); y = M; }
    bx(M, y, CW, termsH, BORDER, 1.2);
    txt("PAYMENT TERMS", M + 4.5, y + 5.2, { bold: true, size: 7.2, color: NAVY });
    termLines.forEach((t, i) => txt(t, M + 4.5, y + 9.6 + i * 3.4, { size: 6.8, color: INK }));
    y += termsH + 3;
  }
  } // end invoice-only payment sections

  // ── Quotation text panels: its OWN payment terms, notes, and T&C ───────────
  // Drawn where the invoice would talk about money. Each panel appears only
  // when it has content.
  if (isQuotation && q) {
    const panels: [string, string][] = [];
    if (q.paymentTerms) panels.push(["PAYMENT TERMS", q.paymentTerms]);
    if (q.notes) panels.push(["NOTES", q.notes]);
    if (q.termsConditions) panels.push(["TERMS & CONDITIONS", q.termsConditions]);
    for (const [title, body] of panels) {
      const bodyLines = wrap(body, CW - 9, 6.8).slice(0, 24);
      const panelH = 9 + bodyLines.length * 3.4;
      if (y + panelH > BOT) { doc.addPage(); y = M; }
      bx(M, y, CW, panelH, BORDER, 1.2);
      txt(title, M + 4.5, y + 5.2, { bold: true, size: 7.2, color: NAVY });
      bodyLines.forEach((t, i) => txt(t, M + 4.5, y + 9.6 + i * 3.4, { size: 6.8, color: INK }));
      y += panelH + 3;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 6. SIGNATURE + FOOTER — anchored to the page floor, per the reference
  // ══════════════════════════════════════════════════════════════════════════
  const footerLines = issuer.invoiceFooter ? wrap(issuer.invoiceFooter, CW - 10, 6.6) : [];
  const SIGN_H = 11;
  const FOOT_H = 10.2 + footerLines.length * 3.4;
  if (y + SIGN_H + FOOT_H > PH - 3) { doc.addPage(); y = M; }

  // Signed for the location that issued the invoice, not the company as a whole.
  // Compact and borderless so the page closes like the reference does.
  const signY = Math.max(y, PH - 6 - FOOT_H - SIGN_H);
  const signX = M + CW - 58;
  txt(`For ${issuer.tradeName}`, signX + 27.5, signY + 2.8, { bold: true, size: 7.6, color: NAVY, align: "center" });
  if (issuer.signatory) txt(issuer.signatory, signX + 27.5, signY + 7.2, { size: 7, color: INK, align: "center" });
  ln(signX, signY + SIGN_H - 3.6, signX + 55, signY + SIGN_H - 3.6, BORDER, 0.3);
  txt("Authorised Signatory", signX + 27.5, signY + SIGN_H - 0.6, { size: 6.2, color: MUT, align: "center" });

  // Decorative rules with diamond tips flanking a script sign-off.
  const fy = signY + SIGN_H + 4.2;
  const diamond = (dx: number, dy: number, r = 1.1) => {
    doc.setFillColor(NAVY[0], NAVY[1], NAVY[2]);
    doc.triangle(dx - r, dy, dx, dy - r, dx + r, dy, "F");
    doc.triangle(dx - r, dy, dx, dy + r, dx + r, dy, "F");
  };
  const thanks = "Thank You For Your Business!";
  let halfGap = 44;
  if (scriptOk) {
    doc.setFont(SCRIPT_FONT, "normal");
    doc.setFontSize(16);
    halfGap = doc.getTextWidth(thanks) / 2 + 6;
  }
  ln(M + 2, fy, PW / 2 - halfGap - 3, fy, NAVY, 0.4);
  diamond(PW / 2 - halfGap, fy);
  diamond(PW / 2 + halfGap, fy);
  ln(PW / 2 + halfGap + 3, fy, M + CW - 2, fy, NAVY, 0.4);
  if (scriptOk) {
    doc.setFont(SCRIPT_FONT, "normal");
    doc.setFontSize(16);
    doc.setTextColor(NAVY[0], NAVY[1], NAVY[2]);
    doc.text(thanks, PW / 2, fy + 1.8, { align: "center" });
  } else {
    txt(thanks, PW / 2, fy + 1.6, { bold: true, size: 11, color: NAVY, align: "center" });
  }

  let noteY = fy + 6.2;
  for (const t of footerLines) {
    txt(t, PW / 2, noteY, { size: 6.6, color: INK, align: "center" });
    noteY += 3.4;
  }
  if (isQuotation) {
    // The validity line is part of the document's meaning, not decoration:
    // it is what makes the offer time-bound.
    if (q?.validTill) {
      const vt = new Date(q.validTill).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
      txt(`This quotation is valid until ${vt}.`, PW / 2, noteY, { bold: true, size: 7, color: NAVY, align: "center" });
      noteY += 3.6;
    }
    txt("This is a computer-generated quotation, not a tax invoice.", PW / 2, noteY, { size: 6.6, color: MUT, align: "center" });
  } else {
    txt("This is a computer-generated invoice.", PW / 2, noteY, { size: 6.6, color: MUT, align: "center" });
  }

  // ── Quotation watermark — light diagonal text on every page ────────────────
  // Drawn last so it sits over the content. Opacity via GState when the jsPDF
  // build supports it; otherwise skipped rather than stamping opaque text
  // across the goods table.
  if (isQuotation && q?.watermark) {
    try {
      const anyDoc = doc as any;
      if (typeof anyDoc.GState === "function" && typeof anyDoc.setGState === "function") {
        const pages = doc.getNumberOfPages();
        for (let p = 1; p <= pages; p++) {
          doc.setPage(p);
          anyDoc.saveGraphicsState?.();
          anyDoc.setGState(new anyDoc.GState({ opacity: 0.07 }));
          doc.setFont(FONT, "bold");
          doc.setFontSize(88);
          doc.setTextColor(NAVY[0], NAVY[1], NAVY[2]);
          doc.text("QUOTATION", PW / 2, PH / 2, { align: "center", angle: 40 });
          anyDoc.restoreGraphicsState?.();
        }
      }
    } catch { /* watermark is optional — never fail the document over it */ }
  }

  const buffer = Buffer.from(doc.output("arraybuffer"));
  return {
    buffer,
    fileName: isQuotation
      ? quotationFileName(sale.invoiceNumber, sale.id)
      : invoiceFileName(sale.invoiceNumber, sale.id),
  };
}
