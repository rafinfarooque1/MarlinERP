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
import { FONT, registerFonts } from "@workspace/pdf-kit";
import { paymentModeLabel } from "../lib/paymentModes";
import { resolveInvoiceIssuer, type InvoiceIssuer } from "../lib/billingProfile";
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
  };
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
   */
  position: PaymentPosition;
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

  const { rows: [locRow] } = await pool.query<{ cancelled_at: Date | null }>(
    `SELECT cancelled_at FROM sales WHERE id = $1`, [saleId],
  );

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

// ── Helpers ───────────────────────────────────────────────────────────────────

export function invoiceFileName(invoiceNumber: string | null, saleId: number): string {
  const base = (invoiceNumber || `INV-${saleId}`).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `Invoice-${base}.pdf`;
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

// ── Colour palette ────────────────────────────────────────────────────────────
type RGB = [number, number, number];
const NAVY:   RGB = [13,  42,  83];   // primary dark navy
const WHITE:  RGB = [255, 255, 255];
const LGRAY:  RGB = [245, 247, 250];  // alternating row / light bg
const MGRAY:  RGB = [140, 152, 168];  // label text
const BORDER: RGB = [200, 210, 220];  // table grid lines
const BK:     RGB = [20,  20,  20];   // body text

// ── Page constants ────────────────────────────────────────────────────────────
const PW = 210;
const PH = 297;
const M  = 10;
const CW = PW - M * 2;  // 190
const HW = CW / 2;      // 95
const L2 = M + HW;

// ── Renderer ──────────────────────────────────────────────────────────────────

export async function renderInvoicePdf(data: InvoiceData): Promise<{ buffer: Buffer; fileName: string }> {
  const {
    sale, issuer, customer, cs, logoDataUrl, position, recordedPayments, upiRequest, showBankDetails,
  } = data;
  const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });
  await registerFonts(doc);

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
  const bx = (x: number, y: number, w: number, h: number, rgb: RGB = BORDER) => {
    doc.setDrawColor(rgb[0], rgb[1], rgb[2]); doc.setLineWidth(0.25); doc.rect(x, y, w, h);
  };
  const ln = (x1: number, y1: number, x2: number, y2: number, rgb: RGB = BORDER, lw = 0.2) => {
    doc.setDrawColor(rgb[0], rgb[1], rgb[2]); doc.setLineWidth(lw); doc.line(x1, y1, x2, y2);
  };
  const txt = (s: string, x: number, y: number, opts?: {
    align?: "left" | "right" | "center"; bold?: boolean; size?: number; color?: RGB; maxWidth?: number;
  }) => {
    doc.setFont(FONT, opts?.bold ? "bold" : "normal");
    doc.setFontSize(opts?.size ?? 7.5);
    const c = opts?.color ?? BK;
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

  const fmtDate = new Date(sale.saleDate).toLocaleDateString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric" });
  const placeOfSupply = customer?.state || issuer.state;

  let y = M;

  // ══════════════════════════════════════════════════════════════════════════
  // 1. HEADER — issuing warehouse left | TAX INVOICE badge right
  // ══════════════════════════════════════════════════════════════════════════
  const BADGE_W = 70;
  const badgeX = M + CW - BADGE_W;
  const nameW = badgeX - (M + 21) - 7;   // never run under the badge

  // Logo: the company mark when one is uploaded, otherwise a navy lettermark
  // built from the seller's own initial.
  const LOGO_S = 16;
  const drawLettermark = () => {
    fill(M, y, LOGO_S, LOGO_S, NAVY);
    txt((issuer.tradeName[0] || "M").toUpperCase(), M + LOGO_S / 2, y + LOGO_S / 2 + 3.4,
        { bold: true, size: 13, color: WHITE, align: "center" });
  };
  if (logoDataUrl) {
    try {
      // Fit inside the 16mm box preserving aspect ratio — a wide or tall mark
      // is centred in the box rather than stretched square.
      const props = doc.getImageProperties(logoDataUrl);
      const s = Math.min(LOGO_S / (props.width || 1), LOGO_S / (props.height || 1));
      const lw = (props.width || 1) * s;
      const lh = (props.height || 1) * s;
      doc.addImage(logoDataUrl, M + (LOGO_S - lw) / 2, y + (LOGO_S - lh) / 2, lw, lh, undefined, "FAST");
    } catch { drawLettermark(); }
  } else {
    drawLettermark();
  }

  // Seller name — wraps to a second line rather than colliding with the badge.
  const nameLines = wrap(issuer.tradeName.toUpperCase() || "-", nameW, 15, true).slice(0, 2);
  let ly = y + 6.8;
  for (const nl of nameLines) {
    txt(nl, M + 21, ly, { bold: true, size: 15, color: NAVY });
    ly += 6;
  }
  ly += 0.8;

  // Address, then the contact line. Both omitted entirely when unset — the
  // header closes up rather than printing an empty label.
  for (const line of issuer.addressLines.slice(0, 3)) {
    cell(line, M + 21, ly, nameW, { size: 6.8, color: MGRAY });
    ly += 3.5;
  }
  const contactLine = [issuer.phone, issuer.email].filter(Boolean).join("   |   ");
  if (contactLine) {
    cell(contactLine, M + 21, ly, nameW, { size: 6.5, color: MGRAY });
    ly += 3.5;
  }
  // Registrations live inside the identity block, as on the reference layout —
  // a full-width bar read like a system banner rather than who is billing.
  if (issuer.gstin) {
    ly += 1.2;
    cell(`GSTIN: ${issuer.gstin}`, M + 21, ly + 2.4, nameW, { bold: true, size: 8, color: NAVY });
    ly += 5.2;
  }
  if (issuer.fssai) {
    cell(`FSSAI Lic. No.: ${issuer.fssai}`, M + 21, ly + 1.6, nameW, { bold: true, size: 7, color: NAVY });
    ly += 4.6;
  }

  // Right: TAX INVOICE badge + invoice meta
  fill(badgeX, y, BADGE_W, 8, NAVY);
  txt("TAX INVOICE", badgeX + BADGE_W / 2, y + 5.8, { bold: true, size: 9.5, color: WHITE, align: "center" });

  const metaRows: [string, string][] = [
    ["Invoice No.", esc(sale.invoiceNumber || "-")],
    ["Invoice Date", fmtDate],
  ];
  // Which branch raised it. Only worth a line when the location is named
  // something other than the trade name printed above.
  if (issuer.locationName && issuer.locationName !== issuer.tradeName) {
    metaRows.push(["Issued From", issuer.locationName]);
  }
  if (placeOfSupply) metaRows.push(["Place of Supply", placeOfSupply]);
  metaRows.push(["Reverse Charge", "No"]);

  const mRH = 4.8;
  const metaH = metaRows.length * mRH + 0.5;
  fill(badgeX, y + 8, BADGE_W, metaH, [250, 252, 255]);
  bx(badgeX, y + 8, BADGE_W, metaH, BORDER);
  metaRows.forEach(([k, v], i) => {
    const ry = y + 8 + i * mRH + 3.4;
    txt(k, badgeX + 2, ry, { size: 6.4, color: MGRAY });
    cell(`: ${v}`, badgeX + 28, ry, BADGE_W - 30, { size: 6.4, bold: true, color: NAVY });
  });

  const headerBottom = Math.max(ly, y + 8 + metaH);
  // Light divider between the identity block and the invoice-meta column, then
  // a rule closing the header off from the body — both per the reference.
  ln(badgeX - 3.5, y + 1, badgeX - 3.5, headerBottom - 1, BORDER, 0.25);
  ln(M, headerBottom + 1.5, M + CW, headerBottom + 1.5, NAVY, 0.5);
  y = headerBottom + 4.5;

  // ══════════════════════════════════════════════════════════════════════════
  // 2. BILLED TO / SHIPPED TO
  // ══════════════════════════════════════════════════════════════════════════
  const custRows: [string, string][] = [
    ["Name", customer?.name || "Walk-in Customer"],
  ];
  if (customer?.address)   custRows.push(["Address", customer.address]);
  if (customer?.state)     custRows.push(["State", customer.state]);
  if (customer?.phone)     custRows.push(["Mobile No.", customer.phone]);
  if (customer?.gstNumber) custRows.push(["GSTIN", customer.gstNumber]);

  const BT_HDR = 7;
  const BT_ROW = 5.5;
  const BT_H   = BT_HDR + custRows.length * BT_ROW + 2;

  fill(M, y, HW, BT_HDR, NAVY);
  bx(M, y, HW, BT_H, BORDER);
  txt("BILLED TO", M + 3, y + BT_HDR - 1.9, { bold: true, size: 7.5, color: WHITE });

  fill(L2, y, HW, BT_HDR, NAVY);
  bx(L2, y, HW, BT_H, BORDER);
  txt("SHIPPED TO", L2 + 3, y + BT_HDR - 1.9, { bold: true, size: 7.5, color: WHITE });

  custRows.forEach(([k, v], i) => {
    const ry = y + BT_HDR + i * BT_ROW + BT_ROW - 1.5;
    if (i > 0) {
      ln(M, y + BT_HDR + i * BT_ROW, M + HW, y + BT_HDR + i * BT_ROW);
      ln(L2, y + BT_HDR + i * BT_ROW, L2 + HW, y + BT_HDR + i * BT_ROW);
    }
    txt(k, M + 3, ry, { size: 7, color: MGRAY });
    cell(`:  ${v}`, M + 26, ry, HW - 29, { size: 7, color: BK });
    // Retail sale: goods go to the same party that is billed.
    txt(k, L2 + 3, ry, { size: 7, color: MGRAY });
    cell(`:  ${v}`, L2 + 26, ry, HW - 29, { size: 7, color: BK });
  });

  y += BT_H + 2;

  // ══════════════════════════════════════════════════════════════════════════
  // 3. ITEMS TABLE
  // ══════════════════════════════════════════════════════════════════════════
  // Col widths: Sl | Desc | HSN | Qty | Unit | UnitPrice | Taxable | C% | CAmt | S% | SAmt | I% | IAmt | Total
  const W = [7, 44, 13, 8, 9, 15, 18, 7, 11, 7, 11, 7, 11, 18];
  const X: number[] = [];
  { let cx = M; for (const w of W) { X.push(cx); cx += w; } }
  const XEND = M + CW;

  const HDR1 = 6;   // first header row height
  const HDR2 = 5;   // second header row height
  const THDR = HDR1 + HDR2;
  const TROW = 6.5; // minimum row height; a wrapped description grows it

  const drawTableHeader = (yy: number): number => {
    fill(M, yy, CW, THDR, NAVY);

    const allCols = [1,2,3,4,5,6,7,9,11,13];
    for (const i of allCols) ln(X[i], yy, X[i], yy + THDR, WHITE, 0.2);
    ln(X[8],  yy + HDR1, X[8],  yy + THDR, WHITE, 0.15);
    ln(X[10], yy + HDR1, X[10], yy + THDR, WHITE, 0.15);
    ln(X[12], yy + HDR1, X[12], yy + THDR, WHITE, 0.15);
    ln(X[7], yy + HDR1, X[13], yy + HDR1, WHITE, 0.15);

    const cy1 = yy + THDR / 2 + 1.8;
    txt("SL",           X[0]  + W[0]/2,  cy1 - 1.5, { bold: true, size: 6, color: WHITE, align: "center" });
    txt("NO.",          X[0]  + W[0]/2,  cy1 + 1.5, { bold: true, size: 6, color: WHITE, align: "center" });
    txt("DESCRIPTION OF GOODS", X[1]+2, cy1,         { bold: true, size: 6.5, color: WHITE });
    txt("HSN",          X[2]  + W[2]/2,  cy1 - 1.5, { bold: true, size: 6, color: WHITE, align: "center" });
    txt("CODE",         X[2]  + W[2]/2,  cy1 + 1.5, { bold: true, size: 6, color: WHITE, align: "center" });
    txt("QTY",          X[3]  + W[3]-1,  cy1,        { bold: true, size: 6, color: WHITE, align: "right" });
    txt("UNIT",         X[4]  + W[4]/2,  cy1,        { bold: true, size: 6, color: WHITE, align: "center" });
    txt("UNIT",         X[5]  + W[5]-1,  cy1 - 1.5, { bold: true, size: 6, color: WHITE, align: "right" });
    txt("PRICE (\u20B9)", X[5] + W[5]-1, cy1 + 1.5, { bold: true, size: 5.5, color: WHITE, align: "right" });
    txt("TAXABLE",      X[6]  + W[6]-1,  cy1 - 1.5, { bold: true, size: 6, color: WHITE, align: "right" });
    txt("VALUE (\u20B9)", X[6] + W[6]-1, cy1 + 1.5, { bold: true, size: 5.5, color: WHITE, align: "right" });
    const gy1 = yy + HDR1 - 1.5;
    txt("CGST", X[7]  + (W[7]+W[8])/2,  gy1, { bold: true, size: 6.5, color: WHITE, align: "center" });
    txt("SGST", X[9]  + (W[9]+W[10])/2, gy1, { bold: true, size: 6.5, color: WHITE, align: "center" });
    txt("IGST", X[11] + (W[11]+W[12])/2,gy1, { bold: true, size: 6.5, color: WHITE, align: "center" });
    txt("TOTAL (\u20B9)", X[13] + W[13]-1, cy1, { bold: true, size: 6, color: WHITE, align: "right" });
    const gy2 = yy + HDR1 + HDR2 - 1.5;
    txt("RATE(%)", X[7]  + W[7]/2,  gy2, { bold: true, size: 5,   color: WHITE, align: "center" });
    txt("AMOUNT",  X[8]  + W[8]-1,  gy2, { bold: true, size: 5,   color: WHITE, align: "right" });
    txt("RATE(%)", X[9]  + W[9]/2,  gy2, { bold: true, size: 5,   color: WHITE, align: "center" });
    txt("AMOUNT",  X[10] + W[10]-1, gy2, { bold: true, size: 5,   color: WHITE, align: "right" });
    txt("RATE(%)", X[11] + W[11]/2, gy2, { bold: true, size: 5,   color: WHITE, align: "center" });
    txt("AMOUNT",  X[12] + W[12]-1, gy2, { bold: true, size: 5,   color: WHITE, align: "right" });

    bx(M, yy, CW, THDR, NAVY);
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
  const DESC_LH = 3.3;

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
    const cgst    = Number(li.cgst ?? 0);
    const sgst    = Number(li.sgst ?? 0);
    const igst    = Number(li.igst ?? 0);
    const rate    = Number(li.taxRate ?? 0);
    const lineTot = taxable + Number(li.taxAmount ?? 0);
    const isIgst  = li.taxType === "igst" || igst > 0;

    // A long product name wraps onto extra lines and grows the row, rather than
    // being cut off — the description is what the customer checks the bill by.
    const nameLines = wrap(esc(li.itemName || `Item #${li.itemId}`), W[1] - 3, 7).slice(0, 4);
    const rowH = Math.max(TROW, nameLines.length * DESC_LH + 3.4);

    if (y + rowH > PH - 50) { doc.addPage(); y = M; y = drawTableHeader(y); }

    tQty += qty; tTaxable += taxable; tCgst += cgst; tSgst += sgst; tIgst += igst; tTot += lineTot;
    bump(byRate.cgst, rate / 2, cgst); bump(byRate.sgst, rate / 2, sgst); bump(byRate.igst, rate, igst);

    if (idx % 2 === 1) fill(M, y, CW, rowH, LGRAY);
    drawRowGrid(y, rowH);

    // Single-line cells sit on the first text baseline so they line up with the
    // first line of a wrapped description.
    const ry = y + 4.4;
    txt(String(idx + 1), X[0] + W[0]/2, ry, { size: 7, align: "center" });
    nameLines.forEach((nl, i) => txt(nl, X[1] + 1.5, ry + i * DESC_LH, { size: 7 }));
    cell(li.hsnCode ? esc(li.hsnCode) : "-", X[2] + W[2]/2, ry, W[2] - 2, { size: 6.5, align: "center" });
    cell(String(qty),                        X[3] + W[3]-1, ry, W[3] - 2, { size: 7, align: "right" });
    cell((li.unit || "-").toUpperCase(),      X[4] + W[4]/2, ry, W[4] - 2, { size: 7, align: "center" });
    cell(money(Number(li.unitPrice ?? 0)),    X[5] + W[5]-1, ry, W[5] - 2, { size: 7, align: "right" });
    cell(money(taxable),                      X[6] + W[6]-1, ry, W[6] - 2, { size: 7, align: "right" });

    if (isIgst) {
      txt("-", X[7] + W[7]/2,  ry, { size: 7, align: "center", color: MGRAY });
      txt("-", X[8] + W[8]-1,  ry, { size: 7, align: "right",  color: MGRAY });
      txt("-", X[9] + W[9]/2,  ry, { size: 7, align: "center", color: MGRAY });
      txt("-", X[10]+ W[10]-1, ry, { size: 7, align: "right",  color: MGRAY });
      cell(`${rate}%`,   X[11]+ W[11]/2, ry, W[11] - 2, { size: 6.5, align: "center" });
      cell(money(igst),  X[12]+ W[12]-1, ry, W[12] - 2, { size: 7,   align: "right" });
    } else {
      cell(`${rate/2}%`, X[7] + W[7]/2,  ry, W[7] - 2,  { size: 6.5, align: "center" });
      cell(money(cgst),  X[8] + W[8]-1,  ry, W[8] - 2,  { size: 7,   align: "right" });
      cell(`${rate/2}%`, X[9] + W[9]/2,  ry, W[9] - 2,  { size: 6.5, align: "center" });
      cell(money(sgst),  X[10]+ W[10]-1, ry, W[10] - 2, { size: 7,   align: "right" });
      txt("-", X[11]+ W[11]/2, ry, { size: 7, align: "center", color: MGRAY });
      txt("-", X[12]+ W[12]-1, ry, { size: 7, align: "right",  color: MGRAY });
    }
    cell(money(lineTot), X[13] + W[13]-1, ry, W[13] - 2, { size: 7, align: "right", bold: true });
    y += rowH;
  });

  // TOTAL row — navy bg
  if (y + TROW > PH - 50) { doc.addPage(); y = M; y = drawTableHeader(y); }
  fill(M, y, CW, TROW, NAVY);
  drawRowGrid(y, TROW);
  const sr = y + TROW - 2;
  txt("TOTAL  (E&OE)", X[1] + 1.5, sr, { bold: true, size: 7, color: WHITE });
  cell(String(Math.round(tQty * 1000) / 1000), X[3] + W[3]-1, sr, W[3] - 2, { bold: true, size: 7, color: WHITE, align: "right" });
  cell(money(tTaxable), X[6] + W[6]-1, sr, W[6] - 2, { bold: true, size: 7, color: WHITE, align: "right" });
  cell(tCgst > 0 ? money(tCgst) : "-", X[8]  + W[8]-1,  sr, W[8] - 2,  { bold: true, size: 7, color: WHITE, align: "right" });
  cell(tSgst > 0 ? money(tSgst) : "-", X[10] + W[10]-1, sr, W[10] - 2, { bold: true, size: 7, color: WHITE, align: "right" });
  cell(tIgst > 0 ? money(tIgst) : "-", X[12] + W[12]-1, sr, W[12] - 2, { bold: true, size: 7, color: WHITE, align: "right" });
  cell(money(tTot), X[13] + W[13]-1, sr, W[13] - 2, { bold: true, size: 7, color: WHITE, align: "right" });
  y += TROW + 1;

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
  taxRows.push(["Round Off", rs(roundOff)]);

  const TR_H    = 6;
  const SUMH    = taxRows.length * TR_H + TR_H + 2; // +TR_H for Grand Total row
  const WORDS_H = Math.max(SUMH, 28);
  if (y + WORDS_H > PH - 55) { doc.addPage(); y = M; }

  bx(M, y, HW, WORDS_H, BORDER);
  fill(M, y, HW, 7, LGRAY);
  txt("AMOUNT IN WORDS", M + 3, y + 5, { bold: true, size: 7, color: NAVY });
  wrap(toIndianWords(grandTotal), HW - 6, 7.5).forEach((w, i) =>
    txt(w, M + 3, y + 10.5 + i * 4, { size: 7.5, color: BK }));
  txt("Certified that the particulars given above are true and correct.",
      M + 3, y + WORDS_H - 3.5, { size: 6, color: MGRAY, maxWidth: HW - 6 });

  bx(L2, y, HW, WORDS_H, BORDER);
  taxRows.forEach(([label, val], i) => {
    const ry = y + i * TR_H;
    if (i > 0) ln(L2, ry, L2 + HW, ry, BORDER);
    txt(label, L2 + 3, ry + TR_H - 1.8, { size: 7.5, color: MGRAY });
    cell(val, L2 + HW - 2, ry + TR_H - 1.8, HW - 46, { size: 7.5, align: "right" });
  });

  const gtY = y + taxRows.length * TR_H;
  fill(L2, gtY, HW, TR_H + 2, NAVY);
  txt("GRAND TOTAL", L2 + 3, gtY + TR_H - 0.5, { bold: true, size: 9, color: WHITE });
  cell(rs(grandTotal), L2 + HW - 2, gtY + TR_H - 0.5, HW - 34, { bold: true, size: 9, color: WHITE, align: "right" });

  y += WORDS_H + 2;

  // ══════════════════════════════════════════════════════════════════════════
  // 5. PAYMENT POSITION — status strip, then either a request or a receipt
  // ══════════════════════════════════════════════════════════════════════════
  // The strip states where the invoice stands; the panel below either asks for
  // the balance or records that nothing is owed. Both read the same position
  // object, so the QR can never ask for an amount the invoice does not print.
  const STATUS_LABEL: Record<string, string> = {
    unpaid: "UNPAID", partially_paid: "PARTIALLY PAID", paid: "PAID", cancelled: "CANCELLED",
  };
  const STATUS_RGB: Record<string, RGB> = {
    unpaid: [176, 42, 42], partially_paid: [166, 108, 12], paid: [17, 110, 76], cancelled: [90, 96, 106],
  };
  const statusColor = STATUS_RGB[position.status];
  const statusText  = STATUS_LABEL[position.status];

  // Figures across the strip. Credit notes only appear when there are some —
  // an empty "Less Credit Notes  ₹0.00" row invites questions about a return
  // that never happened.
  const posCells: Array<[string, string, RGB?]> = [["Invoice Total", rs(position.invoiceTotal)]];
  if (position.creditAdjustments > 0) posCells.push(["Less Credit Notes", `- ${rs(position.creditAdjustments)}`]);
  posCells.push(["Amount Received", rs(position.amountReceived)]);
  posCells.push(["Balance Due", rs(position.outstanding), statusColor]);

  // One row, as on the reference: label block on the left, the figures across
  // the middle, the status pill on the right.
  const STRIP_H = 16;
  if (y + STRIP_H > PH - 34) { doc.addPage(); y = M; }
  bx(M, y, CW, STRIP_H, BORDER);
  const LBL_W = 32;
  fill(M, y, LBL_W, STRIP_H, LGRAY);
  txt("PAYMENT", M + 3, y + STRIP_H / 2 - 1, { bold: true, size: 7, color: NAVY });
  txt("STATUS",  M + 3, y + STRIP_H / 2 + 2.6, { bold: true, size: 7, color: NAVY });
  const pillW = 10 + statusText.length * 1.8;
  const figW = (CW - LBL_W - (pillW + 8)) / posCells.length;
  posCells.forEach(([label, value, color], i) => {
    const cx = M + LBL_W + i * figW;
    ln(cx, y, cx, y + STRIP_H, BORDER);
    cell(label, cx + 3, y + 6.2, figW - 6, { size: 6.5, color: MGRAY });
    cell(value, cx + 3, y + 11.8, figW - 6, { bold: true, size: 8.5, color: color ?? BK });
  });
  fill(M + CW - pillW - 4, y + (STRIP_H - 6) / 2, pillW, 6, statusColor);
  txt(statusText, M + CW - 4 - pillW / 2, y + STRIP_H / 2 + 1.5, { bold: true, size: 6.8, color: WHITE, align: "center" });
  y += STRIP_H + 2;

  // Whether the arrangement the bill was raised under ("credit") was already
  // stated inside the bank-details panel; if not, it gets its own bar below.
  let paymentModeShown = false;

  if (position.isCancelled) {
    // Cancelled: the stock, revenue and receivable were all reversed. Asking for
    // money against it — by QR or by bank transfer — would be a real error.
    const CAN_H = 18;
    if (y + CAN_H > PH - 18) { doc.addPage(); y = M; }
    bx(M, y, CW, CAN_H, BORDER);
    fill(M, y, CW, 7, LGRAY);
    txt("PAYMENT DETAILS", M + 3, y + 5, { bold: true, size: 7, color: NAVY });
    txt("This invoice has been cancelled. No payment is due and no payment should be made against it.",
        M + 3, y + 12, { size: 7, color: BK, maxWidth: CW - 6 });
    if (sale.cancelledAt) {
      txt(`Cancelled on ${String(sale.cancelledAt).slice(0, 10)}`, M + 3, y + 16, { size: 6, color: MGRAY });
    }
    y += CAN_H + 2;
  } else if (position.outstanding > 0) {
    // Something is owed. Three panels, each dropped when it has nothing to say:
    // what to pay, where to transfer it, and the QR to scan.
    const bank = showBankDetails ? issuer.bank : null;
    const bankRows: [string, string][] = [];
    if (bank) {
      if (bank.holder)        bankRows.push(["Account Holder", bank.holder]);
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
    const QR_SIZE = 30;

    // Widths adapt to what is actually present, so a seller with no bank
    // account does not get a wide empty box next to the QR.
    const payW  = hasQr && bankRows.length > 0 ? 56 : bankRows.length > 0 || hasQr ? HW : CW;
    const qrW   = hasQr ? (bankRows.length > 0 ? 46 : CW - payW) : 0;
    const bankW = bankRows.length > 0 ? CW - payW - qrW : 0;
    const PAY_H = Math.max(30, 13 + bankRows.length * 5.2, hasQr ? QR_SIZE + 17 : 0);
    if (y + PAY_H > PH - 18) { doc.addPage(); y = M; }

    // Amount payable
    bx(M, y, payW, PAY_H, BORDER);
    fill(M, y, payW, 7, LGRAY);
    txt("AMOUNT PAYABLE", M + 3, y + 5, { bold: true, size: 7, color: NAVY });
    cell(rs(position.outstanding), M + 3, y + 17, payW - 6, { bold: true, size: 14, color: statusColor });
    txt(bankRows.length > 0
          ? "Please settle this balance by bank transfer using the details alongside."
          : position.status === "partially_paid"
            ? "Balance outstanding on this invoice"
            : "Total amount outstanding on this invoice",
        M + 3, y + 22, { size: 6, color: MGRAY, maxWidth: payW - 6 });
    if (sale.invoiceNumber) {
      txt(`Ref: ${esc(sale.invoiceNumber)}`, M + 3, y + PAY_H - 2.5, { size: 6, color: MGRAY });
    }

    // Bank transfer details
    if (bankRows.length > 0) {
      const bxx = M + payW;
      bx(bxx, y, bankW, PAY_H, BORDER);
      fill(bxx, y, bankW, 7, LGRAY);
      txt("BANK ACCOUNT DETAILS", bxx + 3, y + 5, { bold: true, size: 7, color: NAVY });
      bankRows.forEach(([k, v], i) => {
        const by = y + 11.5 + i * 5.2;
        txt(k, bxx + 3, by, { size: 6.3, color: MGRAY });
        cell(v, bxx + bankW - 3, by, bankW - 32, { size: 6.3, color: BK, align: "right", bold: true });
      });
    }

    // Scan & pay
    if (hasQr && upiRequest) {
      const qx = M + payW + bankW;
      bx(qx, y, qrW, PAY_H, BORDER);
      fill(qx, y, qrW, 7, LGRAY);
      txt("SCAN & PAY", qx + 3, y + 5, { bold: true, size: 7, color: NAVY });
      doc.addImage(qrDataUrl!, "PNG", qx + (qrW - QR_SIZE) / 2, y + 8.5, QR_SIZE, QR_SIZE);
      cell(`UPI ID: ${upiRequest.upiId}`, qx + qrW / 2, y + QR_SIZE + 12.5, qrW - 4, { size: 5.8, color: MGRAY, align: "center" });
    }
    y += PAY_H + 2;
  } else {
    // Settled: say how it was paid instead of asking for it again.
    const shown = recordedPayments.slice(0, 6);
    const REC_H = 13 + Math.max(shown.length, 1) * 5;
    if (y + REC_H > PH - 18) { doc.addPage(); y = M; }
    bx(M, y, CW, REC_H, BORDER);
    fill(M, y, CW, 7, LGRAY);
    txt("PAYMENT RECEIVED", M + 3, y + 5, { bold: true, size: 7, color: NAVY });
    txt("Settled in full — no payment is due.", M + CW - 3, y + 5, { size: 6.5, color: MGRAY, align: "right" });
    if (shown.length === 0) {
      txt("Settled in full.", M + 3, y + 11.5, { size: 7, color: BK });
    } else {
      shown.forEach((p, i) => {
        const py = y + 11.5 + i * 5;
        const parts = [paymentModeLabel(p.method ?? "") || "-"];
        if (p.paymentDate) parts.push(p.paymentDate);
        if (p.referenceNumber) parts.push(`Ref ${p.referenceNumber}`);
        if (p.source === "counter") parts.push("received at counter");
        cell(parts.join("   -   "), M + 3, py, CW - 44, { size: 6.5, color: BK });
        txt(rs(p.amount), M + CW - 3, py, { size: 6.5, bold: true, align: "right" });
      });
    }
    y += REC_H + 2;
  }

  // The payment MODE is the arrangement the bill was raised under ("credit"), not
  // its status — the strip above owns the status, so the mode is stated once here.
  if (sale.paymentMode && !paymentModeShown) {
    bx(M, y, CW, 7, BORDER);
    fill(M, y, CW, 7, LGRAY);
    txt(`Payment Mode : ${esc(paymentModeLabel(sale.paymentMode))}`,
        M + 3, y + 5, { bold: true, size: 7.5, color: NAVY });
    y += 9;
  }

  // Payment terms (Company Settings → Invoice PDF section)
  const payTerms = typeof cs.paymentTerms === "string" ? cs.paymentTerms.trim() : "";
  if (payTerms) {
    const termLines = wrap(payTerms, CW - 6, 6.5);
    const termsH = 9 + termLines.length * 3.8;
    if (y + termsH > PH - 18) { doc.addPage(); y = M; }
    bx(M, y, CW, termsH, BORDER);
    fill(M, y, CW, 7, LGRAY);
    txt("PAYMENT TERMS", M + 3, y + 5, { bold: true, size: 7, color: NAVY });
    termLines.forEach((t, i) => txt(t, M + 3, y + 10.5 + i * 3.8, { size: 6.5, color: BK }));
    y += termsH + 2;
  }

  // ── Authorised signatory ────────────────────────────────────────────────────
  // Signed for the location that issued the invoice, not the company as a whole.
  const SIGN_H = 20;
  if (y + SIGN_H + 16 > PH - 4) { doc.addPage(); y = M; }
  const signX = M + CW - 62;
  bx(signX, y, 62, SIGN_H, BORDER);
  cell(`For ${issuer.tradeName}`, signX + 3, y + 5, 56, { bold: true, size: 7.5, color: NAVY });
  if (issuer.signatory) txt(issuer.signatory, signX + 3, y + SIGN_H - 6.5, { size: 7, color: BK });
  ln(signX + 3, y + SIGN_H - 5, signX + 59, y + SIGN_H - 5, BORDER, 0.3);
  txt("Authorised Signatory", signX + 31, y + SIGN_H - 1.8, { size: 6.2, color: MGRAY, align: "center" });
  y += SIGN_H + 2;

  // ══════════════════════════════════════════════════════════════════════════
  // 6. FOOTER — navy bar + the issuing location's footer note
  // ══════════════════════════════════════════════════════════════════════════
  const footerLines = issuer.invoiceFooter ? wrap(issuer.invoiceFooter, CW - 10, 6.5) : [];
  if (y + 14 + footerLines.length * 3.8 > PH - 4) { doc.addPage(); y = M; }
  // A centred sign-off between two short rules, per the reference — not a bar.
  ln(M + 12, y + 4, PW / 2 - 40, y + 4, NAVY, 0.4);
  ln(PW / 2 + 40, y + 4, M + CW - 12, y + 4, NAVY, 0.4);
  txt("Thank You For Your Business!", PW / 2, y + 5.6, { bold: true, size: 10.5, color: NAVY, align: "center" });
  y += 10;
  for (const t of footerLines) {
    txt(t, PW / 2, y + 3, { size: 6.5, color: BK, align: "center" });
    y += 3.8;
  }
  txt("This is a computer-generated invoice.", PW / 2, y + 3, { size: 6.5, color: MGRAY, align: "center" });

  const buffer = Buffer.from(doc.output("arraybuffer"));
  return { buffer, fileName: invoiceFileName(sale.invoiceNumber, sale.id) };
}
