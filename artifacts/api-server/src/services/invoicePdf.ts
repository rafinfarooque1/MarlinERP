/**
 * Canonical Sales Invoice PDF service.
 *
 * Professional A4 GST tax-invoice layout matching the Marlin brand design:
 *   • Dark-navy header — company info (left) + TAX INVOICE badge (right)
 *   • Teal "Billed To / Shipped To" section
 *   • Navy items table with CGST/SGST/IGST group columns
 *   • Amount-in-words (left) + tax summary (right) with navy Grand Total
 *   • UPI QR (left) + bank account details (right)
 *   • Navy "Thank You" footer bar
 *
 * ONE renderer used by every output channel:
 *   • Preview  (inline PDF in browser tab)
 *   • Download (attachment download)
 *   • WhatsApp (secure tokenized public link)
 */
import { jsPDF } from "jspdf";
import QRCode from "qrcode";
import {
  db, pool, salesTable, outletsTable, customersTable, itemsTable, companySettingsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { paymentModeLabel } from "../lib/paymentModes";
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
    totalAmount: number;
    lineItems: InvoiceLineItem[];
    cancelledAt: string | null;
  };
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

  // Location-aware lookup: warehouse sales carry location_type/location_id in
  // raw columns (not in the Drizzle schema). Fall back to the legacy outlet_id
  // path for older rows.
  let locationName = "";
  let locationUpiId = "";
  const { rows: [locRow] } = await pool.query<{
    location_type: string | null; location_id: number | null; cancelled_at: Date | null;
  }>(
    `SELECT location_type, location_id, cancelled_at FROM sales WHERE id = $1`, [saleId]
  );
  if (locRow?.location_type === "warehouse" && locRow.location_id) {
    const { rows: [wh] } = await pool.query<{ name: string; upi_id: string | null }>(
      `SELECT name, upi_id FROM warehouses WHERE id = $1`, [locRow.location_id]
    );
    locationName = wh?.name ?? "";
    locationUpiId = wh?.upi_id ?? "";
  } else {
    const outletId = (locRow?.location_type === "outlet" && locRow.location_id) ? locRow.location_id : sale.outletId;
    const [outlet] = await db.select().from(outletsTable).where(eq(outletsTable.id, outletId)).limit(1);
    locationName = outlet?.name ?? "";
    locationUpiId = (outlet?.upiId as string | null) ?? "";
  }

  const customerRow = sale.customerId
    ? (await db.select().from(customersTable).where(eq(customersTable.id, sale.customerId)).limit(1))[0] ?? null
    : null;
  const [cs] = await db.select().from(companySettingsTable).limit(1);

  // Invoice-PDF settings live in raw columns (startup migration), which Drizzle's
  // select() cannot see — including the bank block's branch/type/holder fields.
  let paymentTerms: string | null = null;
  let invoiceFooter: string | null = null;
  let bankExtras: Record<string, unknown> = {};
  if (cs) {
    const { rows: [pdfCols] } = await pool.query<any>(
      `SELECT payment_terms, invoice_footer, bank_branch, account_type, bank_account_holder
         FROM company_settings WHERE id = $1`, [cs.id]
    );
    paymentTerms = pdfCols?.payment_terms ?? null;
    invoiceFooter = pdfCols?.invoice_footer ?? null;
    bankExtras = {
      bankBranch: pdfCols?.bank_branch ?? null,
      accountType: pdfCols?.account_type ?? null,
      bankAccountHolder: pdfCols?.bank_account_holder ?? null,
    };
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
  // took it. The company ID is the fallback for locations without one.
  const effectiveUpiId = locationUpiId || paySettings.upiId;
  const upiRequest = buildUpiRequest({
    position,
    upiId: effectiveUpiId,
    payeeName: paySettings.upiPayeeName || locationName || String((cs as any)?.companyName ?? ""),
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
      totalAmount: Number(sale.totalAmount),
      lineItems,
      cancelledAt: locRow?.cancelled_at ? new Date(locRow.cancelled_at).toISOString() : null,
    },
    outletName: locationName,
    outletUpiId: effectiveUpiId,
    customer: customerRow ? {
      name: customerRow.name,
      phone: customerRow.phone ?? "",
      address: customerRow.address ?? "",
      state: customerRow.state ?? "",
      gstNumber: customerRow.gstNumber ?? "",
    } : null,
    cs: { ...(cs ?? {}), paymentTerms, invoiceFooter, ...bankExtras } as Record<string, unknown>,
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

function money(n: number): string {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
  let r = Math.floor(amount);
  const paise = Math.round((amount - r) * 100);
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
const TEAL:   RGB = [14,  85, 105];   // billed/shipped header teal
const WHITE:  RGB = [255, 255, 255];
const LGRAY:  RGB = [245, 247, 250];  // alternating row / light bg
const MGRAY:  RGB = [160, 170, 185];  // label text
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
  const { sale, outletName, customer, cs, position, recordedPayments, upiRequest, showBankDetails } = data;
  const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });

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
    doc.setFont("helvetica", opts?.bold ? "bold" : "normal");
    doc.setFontSize(opts?.size ?? 7.5);
    const c = opts?.color ?? BK;
    doc.setTextColor(c[0], c[1], c[2]);
    const tOpts: { align?: "left" | "right" | "center"; maxWidth?: number } = {};
    if (opts?.align) tOpts.align = opts.align;
    if (opts?.maxWidth) tOpts.maxWidth = opts.maxWidth;
    doc.text(s, x, y, tOpts);
  };

  const companyName  = esc(cs.companyName  || "Marlin Frozen Fruits");
  const companyAddr  = [cs.address, cs.city, cs.state, cs.pincode].filter(Boolean).join(", ");
  const companyPhone = esc(cs.phone || "");
  const companyEmail = esc(cs.email || "");
  const companyGstin = esc(cs.gstNumber || "");

  const fmtDate = new Date(sale.saleDate).toLocaleDateString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric" });
  const placeOfSupply = customer?.state || esc(cs.state || "");

  let y = M;

  // ══════════════════════════════════════════════════════════════════════════
  // 1. HEADER — company left | TAX INVOICE badge right
  // ══════════════════════════════════════════════════════════════════════════
  const HDR_H = 30;

  // Left side: navy "M" logo mark
  fill(M, y, 11, 11, NAVY);
  txt("M", M + 5.5, y + 7.8, { bold: true, size: 9, color: WHITE, align: "center" });

  // Company name
  txt(companyName.toUpperCase(), M + 14, y + 7, { bold: true, size: 14, color: NAVY });

  // Address
  if (companyAddr) txt(companyAddr, M + 14, y + 12, { size: 7, color: MGRAY });

  // Phone / email row
  const contactLine = [companyPhone ? `+${companyPhone}` : "", companyEmail].filter(Boolean).join("   |   ");
  if (contactLine) txt(contactLine, M + 14, y + 17, { size: 6.5, color: MGRAY });

  // GSTIN bar (below contact line)
  fill(M, y + 20, CW, 7, LGRAY);
  bx(M, y + 20, CW, 7, BORDER);
  txt(`GSTIN: ${companyGstin || "-"}`, M + 3, y + 25, { bold: true, size: 7.5, color: NAVY });

  // Right: TAX INVOICE badge — navy box
  const badgeX = M + CW - 68;
  fill(badgeX, y, 68, 8, NAVY);
  txt("TAX INVOICE", badgeX + 34, y + 5.8, { bold: true, size: 9.5, color: WHITE, align: "center" });

  // Invoice meta box below badge
  const metaX = badgeX;
  const metaW = 68;
  const metaRows: [string, string][] = [
    ["Invoice No.", esc(sale.invoiceNumber || "-")],
    ["Invoice Date", fmtDate],
    ["Place of Supply", placeOfSupply || "-"],
    ["Reverse Charge", "No"],
  ];
  const mRH = 4.8;
  fill(metaX, y + 8, metaW, metaRows.length * mRH + 0.5, [250, 252, 255]);
  bx(metaX, y + 8, metaW, metaRows.length * mRH + 0.5, BORDER);
  metaRows.forEach(([k, v], i) => {
    const ry = y + 8 + i * mRH + 3.5;
    txt(k, metaX + 2, ry, { size: 6.5, color: MGRAY });
    txt(`: ${v}`, metaX + 30, ry, { size: 6.5, bold: true, color: NAVY });
  });

  y += HDR_H;

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

  // Left box — Billed To
  fill(M, y, HW, BT_HDR, TEAL);
  bx(M, y, HW, BT_H, BORDER);
  txt("  BILLED TO", M + 3, y + BT_HDR - 1.8, { bold: true, size: 7.5, color: WHITE });

  // Right box — Shipped To
  fill(L2, y, HW, BT_HDR, TEAL);
  bx(L2, y, HW, BT_H, BORDER);
  txt("  SHIPPED TO", L2 + 3, y + BT_HDR - 1.8, { bold: true, size: 7.5, color: WHITE });

  custRows.forEach(([k, v], i) => {
    const ry = y + BT_HDR + i * BT_ROW + BT_ROW - 1.5;
    if (i > 0) {
      ln(M, y + BT_HDR + i * BT_ROW, M + HW, y + BT_HDR + i * BT_ROW);
      ln(L2, y + BT_HDR + i * BT_ROW, L2 + HW, y + BT_HDR + i * BT_ROW);
    }
    // Billed
    txt(k, M + 3, ry, { size: 7, color: MGRAY });
    txt(`:  ${v}`, M + 28, ry, { size: 7, color: BK, maxWidth: HW - 32 });
    // Shipped (same values — retail)
    txt(k, L2 + 3, ry, { size: 7, color: MGRAY });
    txt(`:  ${v}`, L2 + 28, ry, { size: 7, color: BK, maxWidth: HW - 32 });
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
  const TROW = 6.5;

  const drawTableHeader = (yy: number): number => {
    // Navy background for header
    fill(M, yy, CW, THDR, NAVY);

    // Draw all vertical lines in white through full header
    const allCols = [1,2,3,4,5,6,7,9,11,13];
    for (const i of allCols) ln(X[i], yy, X[i], yy + THDR, WHITE, 0.2);
    // Sub-separators in row 2 for Rate/Amount pairs
    ln(X[8],  yy + HDR1, X[8],  yy + THDR, WHITE, 0.15);
    ln(X[10], yy + HDR1, X[10], yy + THDR, WHITE, 0.15);
    ln(X[12], yy + HDR1, X[12], yy + THDR, WHITE, 0.15);
    // Separator between row1 and row2 inside GST groups
    ln(X[7], yy + HDR1, X[13], yy + HDR1, WHITE, 0.15);

    // Row 1 headers (vertically centred in full height for simple cols)
    const cy1 = yy + THDR / 2 + 1.8; // centre of full header
    txt("SL",           X[0]  + W[0]/2,  cy1 - 1.5, { bold: true, size: 6, color: WHITE, align: "center" });
    txt("NO.",          X[0]  + W[0]/2,  cy1 + 1.5, { bold: true, size: 6, color: WHITE, align: "center" });
    txt("DESCRIPTION OF GOODS", X[1]+2, cy1,         { bold: true, size: 6.5, color: WHITE });
    txt("HSN",          X[2]  + W[2]/2,  cy1 - 1.5, { bold: true, size: 6, color: WHITE, align: "center" });
    txt("CODE",         X[2]  + W[2]/2,  cy1 + 1.5, { bold: true, size: 6, color: WHITE, align: "center" });
    txt("QTY",          X[3]  + W[3]-1,  cy1,        { bold: true, size: 6, color: WHITE, align: "right" });
    txt("UNIT",         X[4]  + W[4]/2,  cy1,        { bold: true, size: 6, color: WHITE, align: "center" });
    txt("UNIT",         X[5]  + W[5]-1,  cy1 - 1.5, { bold: true, size: 6, color: WHITE, align: "right" });
    txt("PRICE (Rs.)",  X[5]  + W[5]-1,  cy1 + 1.5, { bold: true, size: 5.5, color: WHITE, align: "right" });
    txt("TAXABLE",      X[6]  + W[6]-1,  cy1 - 1.5, { bold: true, size: 6, color: WHITE, align: "right" });
    txt("VALUE (Rs.)",  X[6]  + W[6]-1,  cy1 + 1.5, { bold: true, size: 5.5, color: WHITE, align: "right" });
    // GST group labels row 1
    const gy1 = yy + HDR1 - 1.5;
    txt("CGST", X[7]  + (W[7]+W[8])/2,  gy1, { bold: true, size: 6.5, color: WHITE, align: "center" });
    txt("SGST", X[9]  + (W[9]+W[10])/2, gy1, { bold: true, size: 6.5, color: WHITE, align: "center" });
    txt("IGST", X[11] + (W[11]+W[12])/2,gy1, { bold: true, size: 6.5, color: WHITE, align: "center" });
    txt("TOTAL (Rs.)", X[13] + W[13]-1,  cy1, { bold: true, size: 6, color: WHITE, align: "right" });
    // Sub-labels row 2
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

  items.forEach((li, idx) => {
    if (y + TROW > PH - 50) { doc.addPage(); y = M; y = drawTableHeader(y); }

    const qty     = Number(li.quantity  ?? 0);
    const gross   = qty * Number(li.unitPrice ?? 0) - Number(li.discount ?? 0);
    const taxable = Number(li.lineSubtotal ?? gross);
    const cgst    = Number(li.cgst ?? 0);
    const sgst    = Number(li.sgst ?? 0);
    const igst    = Number(li.igst ?? 0);
    const rate    = Number(li.taxRate ?? 0);
    const lineTot = taxable + Number(li.taxAmount ?? 0);
    const isIgst  = li.taxType === "igst" || igst > 0;
    tQty += qty; tTaxable += taxable; tCgst += cgst; tSgst += sgst; tIgst += igst; tTot += lineTot;

    if (idx % 2 === 1) fill(M, y, CW, TROW, LGRAY);
    drawRowGrid(y, TROW);

    const ry = y + TROW - 2;
    txt(String(idx + 1), X[0] + W[0]/2, ry, { size: 7, align: "center" });
    const name = esc(li.itemName || `Item #${li.itemId}`);
    txt(name.length > 32 ? name.slice(0, 31) + "…" : name, X[1] + 1.5, ry, { size: 7 });
    txt(li.hsnCode ? esc(li.hsnCode) : "-", X[2] + W[2]/2, ry, { size: 6.5, align: "center" });
    txt(String(qty),                          X[3] + W[3]-1, ry, { size: 7, align: "right" });
    txt((li.unit || "-").toUpperCase(),        X[4] + W[4]/2, ry, { size: 7, align: "center" });
    txt(money(Number(li.unitPrice ?? 0)),      X[5] + W[5]-1, ry, { size: 7, align: "right" });
    txt(money(taxable),                        X[6] + W[6]-1, ry, { size: 7, align: "right" });

    if (isIgst) {
      txt("-", X[7] + W[7]/2,  ry, { size: 7, align: "center", color: MGRAY });
      txt("-", X[8] + W[8]-1,  ry, { size: 7, align: "right",  color: MGRAY });
      txt("-", X[9] + W[9]/2,  ry, { size: 7, align: "center", color: MGRAY });
      txt("-", X[10]+ W[10]-1, ry, { size: 7, align: "right",  color: MGRAY });
      txt(`${rate}%`,   X[11]+ W[11]/2, ry, { size: 6.5, align: "center" });
      txt(money(igst),  X[12]+ W[12]-1, ry, { size: 7,   align: "right" });
    } else {
      txt(`${rate/2}%`, X[7] + W[7]/2,  ry, { size: 6.5, align: "center" });
      txt(money(cgst),  X[8] + W[8]-1,  ry, { size: 7,   align: "right" });
      txt(`${rate/2}%`, X[9] + W[9]/2,  ry, { size: 6.5, align: "center" });
      txt(money(sgst),  X[10]+ W[10]-1, ry, { size: 7,   align: "right" });
      txt("-", X[11]+ W[11]/2, ry, { size: 7, align: "center", color: MGRAY });
      txt("-", X[12]+ W[12]-1, ry, { size: 7, align: "right",  color: MGRAY });
    }
    txt(money(lineTot), X[13] + W[13]-1, ry, { size: 7, align: "right", bold: true });
    y += TROW;
  });

  // TOTAL row — navy bg
  fill(M, y, CW, TROW, NAVY);
  drawRowGrid(y, TROW);
  const sr = y + TROW - 2;
  txt("TOTAL  (E&OE)", X[1] + 1.5, sr, { bold: true, size: 7, color: WHITE });
  txt(String(tQty), X[3] + W[3]-1, sr, { bold: true, size: 7, color: WHITE, align: "right" });
  txt(money(tTaxable), X[6] + W[6]-1, sr, { bold: true, size: 7, color: WHITE, align: "right" });
  txt(tCgst > 0 ? money(tCgst) : "-", X[8]  + W[8]-1,  sr, { bold: true, size: 7, color: WHITE, align: "right" });
  txt(tSgst > 0 ? money(tSgst) : "-", X[10] + W[10]-1, sr, { bold: true, size: 7, color: WHITE, align: "right" });
  txt(tIgst > 0 ? money(tIgst) : "-", X[12] + W[12]-1, sr, { bold: true, size: 7, color: WHITE, align: "right" });
  txt(money(tTot), X[13] + W[13]-1, sr, { bold: true, size: 7, color: WHITE, align: "right" });
  y += TROW + 1;

  // ══════════════════════════════════════════════════════════════════════════
  // 4. AMOUNT IN WORDS (left) + TAX SUMMARY (right)
  // ══════════════════════════════════════════════════════════════════════════
  const grandTotal  = sale.totalAmount;
  const discount    = sale.discountTotal;
  const roundOff    = 0;

  const taxRows: [string, string, boolean?][] = [["Taxable Value", `Rs. ${money(sale.subtotal)}`]];
  if (tCgst > 0) taxRows.push([`CGST (${items[0]?.taxRate ? items[0].taxRate / 2 : ""}%)`, `Rs. ${money(tCgst)}`]);
  if (tSgst > 0) taxRows.push([`SGST (${items[0]?.taxRate ? items[0].taxRate / 2 : ""}%)`, `Rs. ${money(tSgst)}`]);
  if (tIgst > 0) taxRows.push([`IGST (${items[0]?.taxRate ?? ""}%)`, `Rs. ${money(tIgst)}`]);
  if (discount > 0) taxRows.push(["Discount", `- Rs. ${money(discount)}`]);
  taxRows.push(["Round Off", `Rs. ${money(roundOff)}`]);

  const TR_H    = 6;
  const SUMH    = taxRows.length * TR_H + TR_H + 2; // +TR_H for Grand Total row
  const WORDS_H = Math.max(SUMH, 28);
  if (y + WORDS_H > PH - 55) { doc.addPage(); y = M; }

  bx(M, y, HW, WORDS_H, BORDER);
  fill(M, y, HW, 7, LGRAY);
  txt("AMOUNT IN WORDS", M + 3, y + 5, { bold: true, size: 7, color: NAVY });
  const wordStr = doc.splitTextToSize(toIndianWords(grandTotal), HW - 6) as string[];
  wordStr.forEach((w, i) => txt(w, M + 3, y + 10 + i * 4.5, { size: 7.5, color: BK }));
  txt("Certified that the particulars given above are true and correct.",
      M + 3, y + WORDS_H - 4, { size: 6, color: MGRAY, maxWidth: HW - 6 });

  // Right: tax summary box
  bx(L2, y, HW, WORDS_H, BORDER);
  taxRows.forEach(([label, val], i) => {
    const ry = y + i * TR_H;
    if (i > 0) ln(L2, ry, L2 + HW, ry, BORDER);
    txt(label, L2 + 3, ry + TR_H - 1.8, { size: 7.5, color: MGRAY });
    txt(val, L2 + HW - 2, ry + TR_H - 1.8, { size: 7.5, align: "right" });
  });

  // Grand Total — navy highlight row
  const gtY = y + taxRows.length * TR_H;
  fill(L2, gtY, HW, TR_H + 2, NAVY);
  txt("GRAND TOTAL", L2 + 3, gtY + TR_H - 0.5, { bold: true, size: 9, color: WHITE });
  txt(`Rs. ${money(grandTotal)}`, L2 + HW - 2, gtY + TR_H - 0.5, { bold: true, size: 9, color: WHITE, align: "right" });

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
  // an empty "Less Credit Notes  Rs. 0.00" row invites questions about a
  // return that never happened.
  const posCells: Array<[string, string, RGB?]> = [["Invoice Total", `Rs. ${money(position.invoiceTotal)}`]];
  if (position.creditAdjustments > 0) posCells.push(["Less Credit Notes", `- Rs. ${money(position.creditAdjustments)}`]);
  posCells.push(["Amount Received", `Rs. ${money(position.amountReceived)}`]);
  posCells.push(["Balance Due", `Rs. ${money(position.outstanding)}`, statusColor]);

  const STRIP_H = 19;
  if (y + STRIP_H > PH - 34) { doc.addPage(); y = M; }
  bx(M, y, CW, STRIP_H, BORDER);
  fill(M, y, CW, 7, LGRAY);
  txt("PAYMENT STATUS", M + 3, y + 5, { bold: true, size: 7, color: NAVY });
  const badgeW = 8 + statusText.length * 1.6;
  fill(M + CW - badgeW - 2, y + 1.5, badgeW, 4.4, statusColor);
  txt(statusText, M + CW - badgeW / 2 - 2, y + 4.7, { bold: true, size: 6.5, color: WHITE, align: "center" });

  const cellW = CW / posCells.length;
  posCells.forEach(([label, value, color], i) => {
    if (i > 0) ln(M + i * cellW, y + 7, M + i * cellW, y + STRIP_H, BORDER);
    txt(label, M + i * cellW + 3, y + 12, { size: 6.5, color: MGRAY });
    txt(value, M + i * cellW + 3, y + 17, { bold: true, size: 8.5, color: color ?? BK });
  });
  y += STRIP_H + 2;

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
    // Something is owed — ask for exactly that, and show the other way to pay it.
    const bankRows: [string, string][] = [];
    if (showBankDetails) {
      const holder = esc(cs.bankAccountHolder) || companyName;
      if (holder)         bankRows.push(["Account Holder Name", holder]);
      if (cs.bankName)    bankRows.push(["Bank Name",      esc(cs.bankName)]);
      if (cs.bankBranch)  bankRows.push(["Branch",         esc(cs.bankBranch)]);
      if (cs.bankAccount) bankRows.push(["Account Number", esc(cs.bankAccount)]);
      if (cs.accountType) bankRows.push(["Account Type",   esc(cs.accountType)]);
      if (cs.ifscCode)    bankRows.push(["IFSC Code",      esc(cs.ifscCode)]);
    }
    const QR_SIZE = 34;
    const PAY_H = Math.max(qrDataUrl ? QR_SIZE + 22 : 30, 14 + bankRows.length * 5.5);
    if (y + PAY_H > PH - 18) { doc.addPage(); y = M; }

    // Left: the payment request itself
    const leftW = bankRows.length > 0 ? HW : CW;
    bx(M, y, leftW, PAY_H, BORDER);
    fill(M, y, leftW, 7, LGRAY);
    txt(qrDataUrl ? "SCAN TO PAY (UPI)" : "AMOUNT PAYABLE", M + 3, y + 5, { bold: true, size: 7, color: NAVY });
    if (qrDataUrl && upiRequest) {
      doc.addImage(qrDataUrl, "PNG", M + (leftW - QR_SIZE) / 2, y + 9, QR_SIZE, QR_SIZE);
      txt(`Pay Rs. ${money(upiRequest.amount)}`, M + leftW / 2, y + QR_SIZE + 14,
          { bold: true, size: 9, color: NAVY, align: "center" });
      txt(position.status === "partially_paid" ? "Balance outstanding on this invoice" : "Amount outstanding on this invoice",
          M + leftW / 2, y + QR_SIZE + 18, { size: 6, color: MGRAY, align: "center" });
      txt(`UPI ID: ${upiRequest.upiId}`, M + 3, y + PAY_H - 2.5, { size: 6, color: MGRAY });
      txt(`Ref: ${esc(sale.invoiceNumber)}`, M + leftW - 3, y + PAY_H - 2.5, { size: 6, color: MGRAY, align: "right" });
    } else {
      // No UPI configured, or the QR was switched off: state the balance plainly
      // rather than printing a broken or empty code.
      txt(`Rs. ${money(position.outstanding)}`, M + 3, y + 16, { bold: true, size: 12, color: statusColor });
      txt(bankRows.length > 0
            ? "Please settle this balance by bank transfer using the details alongside."
            : "Please settle this balance with the seller.",
          M + 3, y + 22, { size: 6.5, color: MGRAY, maxWidth: leftW - 6 });
    }

    // Right: bank transfer details
    if (bankRows.length > 0) {
      bx(L2, y, HW, PAY_H, BORDER);
      fill(L2, y, HW, 7, LGRAY);
      txt("BANK ACCOUNT DETAILS", L2 + 3, y + 5, { bold: true, size: 7, color: NAVY });
      bankRows.forEach(([k, v], i) => {
        const by = y + 12 + i * 5.5;
        txt(k, L2 + 3, by, { size: 6.5, color: MGRAY });
        txt(`:  ${v}`, L2 + 38, by, { size: 6.5, color: BK, maxWidth: HW - 44 });
      });
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
        txt(parts.join("   -   "), M + 3, py, { size: 6.5, color: BK, maxWidth: CW - 40 });
        txt(`Rs. ${money(p.amount)}`, M + CW - 3, py, { size: 6.5, bold: true, align: "right" });
      });
    }
    y += REC_H + 2;
  }

  // The payment MODE is the arrangement the bill was raised under ("credit"), not
  // its status — the strip above owns the status, so the mode is stated once here.
  if (sale.paymentMode) {
    bx(M, y, CW, 7, BORDER);
    fill(M, y, CW, 7, LGRAY);
    txt(`Payment Mode : ${esc(paymentModeLabel(sale.paymentMode))}`,
        M + 3, y + 5, { bold: true, size: 7.5, color: NAVY });
    txt(`For ${companyName}`, M + CW - 3, y + 5, { bold: true, size: 7.5, color: NAVY, align: "right" });
    y += 9;
  }

  // Payment terms (Company Settings → Invoice PDF section)
  const payTerms = typeof cs.paymentTerms === "string" ? cs.paymentTerms.trim() : "";
  if (payTerms) {
    const termLines = doc.splitTextToSize(payTerms, CW - 6) as string[];
    const termsH = 9 + termLines.length * 3.8;
    if (y + termsH > PH - 18) { doc.addPage(); y = M; }
    bx(M, y, CW, termsH, BORDER);
    fill(M, y, CW, 7, LGRAY);
    txt("PAYMENT TERMS", M + 3, y + 5, { bold: true, size: 7, color: NAVY });
    termLines.forEach((t, i) => txt(t, M + 3, y + 10.5 + i * 3.8, { size: 6.5, color: BK }));
    y += termsH + 2;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 6. FOOTER — navy bar + custom footer + subtitle
  // ══════════════════════════════════════════════════════════════════════════
  const customFooter = typeof cs.invoiceFooter === "string" ? cs.invoiceFooter.trim() : "";
  const footerLines = customFooter ? (doc.splitTextToSize(customFooter, CW - 10) as string[]) : [];
  if (y + 14 + footerLines.length * 3.8 > PH - 4) { doc.addPage(); y = M; }
  fill(M, y, CW, 9, NAVY);
  txt("THANK YOU FOR YOUR BUSINESS!", PW / 2, y + 6, { bold: true, size: 9, color: WHITE, align: "center" });
  y += 11;
  for (const t of footerLines) {
    txt(t, PW / 2, y + 3, { size: 6.5, color: BK, align: "center" });
    y += 3.8;
  }
  txt("This is a computer-generated invoice.", PW / 2, y + 3, { size: 6.5, color: MGRAY, align: "center" });

  const buffer = Buffer.from(doc.output("arraybuffer"));
  return { buffer, fileName: invoiceFileName(sale.invoiceNumber, sale.id) };
}
