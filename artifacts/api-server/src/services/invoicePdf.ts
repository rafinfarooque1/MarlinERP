/**
 * Canonical Sales Invoice PDF service.
 *
 * ONE renderer used by every output channel:
 *   • Preview  (inline PDF in browser tab)
 *   • Download (attachment download)
 *   • WhatsApp (secure tokenized public link)
 *
 * Professional A4 GST tax-invoice layout rendered with jsPDF.
 * The UPI QR (outlet UPI ID + grand total + invoice ref) is embedded
 * as a plain PNG image — no active/executable PDF content.
 */
import { jsPDF } from "jspdf";
import QRCode from "qrcode";
import {
  db, salesTable, outletsTable, customersTable, itemsTable, companySettingsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// ── Data assembly ─────────────────────────────────────────────────────────────

export interface InvoiceLineItem {
  itemId: number;
  itemName?: string;
  hsnCode?: string;
  unit?: string;
  quantity: number;
  unitPrice: number;
  discount?: number;
  lineSubtotal?: number;   // taxable (ex-GST)
  taxRate?: number;
  taxType?: string;        // 'cgst_sgst' | 'igst'
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
  cs: Record<string, unknown>; // company settings
}

/** Load everything the renderer needs for one sale. Returns null if not found. */
export async function assembleInvoiceData(saleId: number): Promise<InvoiceData | null> {
  const [sale] = await db.select().from(salesTable).where(eq(salesTable.id, saleId)).limit(1);
  if (!sale) return null;

  const [outlet] = await db.select().from(outletsTable).where(eq(outletsTable.id, sale.outletId)).limit(1);
  const customerRow = sale.customerId
    ? (await db.select().from(customersTable).where(eq(customersTable.id, sale.customerId)).limit(1))[0] ?? null
    : null;
  const [cs] = await db.select().from(companySettingsTable).limit(1);

  const lineItems: InvoiceLineItem[] = Array.isArray(sale.lineItems) ? (sale.lineItems as InvoiceLineItem[]) : [];

  // Older sales may lack itemName/hsnCode/unit inside lineItems — backfill each
  // field independently from the items table.
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
    },
    outletName: outlet?.name ?? "",
    outletUpiId: (outlet?.upiId as string | null) ?? "",
    customer: customerRow ? {
      name: customerRow.name,
      phone: customerRow.phone ?? "",
      address: customerRow.address ?? "",
      state: customerRow.state ?? "",
      gstNumber: customerRow.gstNumber ?? "",
    } : null,
    cs: (cs ?? {}) as Record<string, unknown>,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** "TST/2025-26/0004" → "Invoice-TST-2025-26-0004.pdf" (filesystem/header safe). */
export function invoiceFileName(invoiceNumber: string | null, saleId: number): string {
  const base = (invoiceNumber || `INV-${saleId}`).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `Invoice-${base}.pdf`;
}

function esc(s: unknown): string { return String(s ?? ""); }

/** Consistent money formatting inside the PDF (standard fonts lack the ₹ glyph). */
function money(n: number): string {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Convert a numeric amount to Indian-English words (Rupees ... Only). */
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

function buildUpiUri(upiId: string, payeeName: string, amount: number, ref: string): string {
  const params = new URLSearchParams({ pa: upiId, pn: payeeName, am: amount.toFixed(2), cu: "INR", tn: ref });
  return `upi://pay?${params.toString()}`;
}

// ── Renderer ──────────────────────────────────────────────────────────────────

const PAGE_W = 210;
const PAGE_H = 297;
const M = 10;                    // page margin
const CW = PAGE_W - M * 2;       // 190 mm content width
const HW = CW / 2;               // half width
const L2 = M + HW;               // x of right column

type RGB = [number, number, number];
const BK: RGB = [0, 0, 0];
const GR: RGB = [80, 80, 80];
const LG: RGB = [235, 235, 235];
const ZEBRA: RGB = [248, 248, 248];

/** Render the canonical invoice PDF. Returns the PDF bytes + safe filename. */
export async function renderInvoicePdf(data: InvoiceData): Promise<{ buffer: Buffer; fileName: string }> {
  const { sale, outletName, outletUpiId, customer, cs } = data;
  const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });

  // ── UPI QR (plain PNG data URL — no active content) ───────────────────────
  let qrDataUrl: string | undefined;
  if (outletUpiId) {
    try {
      const uri = buildUpiUri(outletUpiId, outletName, sale.totalAmount, sale.invoiceNumber || "");
      qrDataUrl = await QRCode.toDataURL(uri, { width: 300, margin: 2, color: { dark: "#000000", light: "#FFFFFF" } });
    } catch { /* render without QR */ }
  }

  const setColor = (rgb: RGB) => doc.setTextColor(rgb[0], rgb[1], rgb[2]);
  const ln = (x1: number, y1: number, x2: number, y2: number, lw = 0.3) => {
    doc.setDrawColor(BK[0], BK[1], BK[2]); doc.setLineWidth(lw); doc.line(x1, y1, x2, y2);
  };
  const bx = (x: number, y: number, w: number, h: number) => {
    doc.setDrawColor(BK[0], BK[1], BK[2]); doc.setLineWidth(0.3); doc.rect(x, y, w, h);
  };
  const fill = (x: number, y: number, w: number, h: number, rgb: RGB) => {
    doc.setFillColor(rgb[0], rgb[1], rgb[2]); doc.rect(x, y, w, h, "F");
  };
  const txt = (s: string, x: number, y: number, opts?: { align?: "left" | "right" | "center"; bold?: boolean; size?: number; color?: RGB }) => {
    doc.setFont("helvetica", opts?.bold ? "bold" : "normal");
    doc.setFontSize(opts?.size ?? 7.5);
    setColor(opts?.color ?? BK);
    doc.text(s, x, y, { align: opts?.align ?? "left" });
  };

  const companyName = esc(cs.companyName || "Marlin Frozen Fruits");
  let y = M;

  // ── 1. Header ──────────────────────────────────────────────────────────────
  txt(companyName, PAGE_W / 2, y + 6, { bold: true, size: 15, align: "center" });
  y += 10;

  const addrLine = [cs.address, cs.city, cs.state, cs.pincode].filter(Boolean).join(", ");
  if (addrLine) { txt(addrLine, PAGE_W / 2, y, { size: 8, color: GR, align: "center" }); y += 4.5; }

  const contactBits: string[] = [];
  if (cs.gstNumber) contactBits.push(`GSTIN: ${esc(cs.gstNumber)}`);
  if (cs.phone)     contactBits.push(`Phone: ${esc(cs.phone)}`);
  if (cs.email)     contactBits.push(`E-Mail: ${esc(cs.email)}`);
  if (contactBits.length) { txt(contactBits.join("   |   "), PAGE_W / 2, y, { size: 8, color: GR, align: "center" }); y += 5; }

  // TAX INVOICE banner
  fill(M, y, CW, 7, LG);
  bx(M, y, CW, 7);
  txt("TAX INVOICE", PAGE_W / 2, y + 4.8, { bold: true, size: 10.5, align: "center" });
  y += 7;

  // ── 2. Invoice information grid ────────────────────────────────────────────
  const rowH = 6;
  const fmtDate = new Date(sale.saleDate).toLocaleDateString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric" });
  const placeOfSupply = customer?.state || esc(cs.state || "");
  const metaL: [string, string][] = [
    ["GST Number", esc(cs.gstNumber || "-")],
    ["Invoice Number", esc(sale.invoiceNumber || "-")],
    ["Invoice Date", fmtDate],
    ["Tax Payable on Reverse Charge", "No"],
  ];
  const metaR: [string, string][] = [
    ["Transportation Mode", "-"],
    ["Vehicle Number", "-"],
    ["Date & Time of Supply", fmtDate],
    ["Place of Supply", placeOfSupply || "-"],
  ];
  const mH = metaL.length * rowH;
  bx(M, y, CW, mH);
  ln(L2, y, L2, y + mH);
  for (let i = 1; i < metaL.length; i++) ln(M, y + i * rowH, PAGE_W - M, y + i * rowH, 0.1);
  metaL.forEach(([k, v], i) => {
    const ry = y + i * rowH + rowH - 2;
    txt(k, M + 2, ry, { size: 7.5, color: GR });
    txt(`:  ${v}`, M + 52, ry, { size: 7.5 });
    txt(metaR[i][0], L2 + 2, ry, { size: 7.5, color: GR });
    txt(`:  ${metaR[i][1]}`, L2 + 52, ry, { size: 7.5 });
  });
  y += mH;

  // ── 3. Receiver / Consignee ────────────────────────────────────────────────
  // Only rows with actual data (billed-to = shipped-to for retail sales).
  const custRows: [string, string][] = [["Name", customer?.name || "Walk-in Customer"]];
  if (customer?.address)   custRows.push(["Address", customer.address]);
  if (customer?.state)     custRows.push(["State", customer.state]);
  if (customer?.phone)     custRows.push(["Mobile No.", customer.phone]);
  if (customer?.gstNumber) custRows.push(["GSTIN", customer.gstNumber]);

  const cH = (custRows.length + 1) * rowH;
  bx(M, y, CW, cH);
  ln(L2, y, L2, y + cH);
  fill(M, y, CW, rowH, LG);
  ln(M, y + rowH, PAGE_W - M, y + rowH);
  ln(L2, y, L2, y + rowH);
  txt("Details of Receiver (Billed to)", M + 2, y + rowH - 1.5, { bold: true, size: 7.5 });
  txt("Details of Consignee (Shipped to)", L2 + 2, y + rowH - 1.5, { bold: true, size: 7.5 });
  y += rowH;
  custRows.forEach(([k, v], i) => {
    if (i > 0) ln(M, y + i * rowH, PAGE_W - M, y + i * rowH, 0.1);
    const ry = y + i * rowH + rowH - 1.5;
    txt(k, M + 2, ry, { size: 7.5, color: GR });
    txt(`: ${v}`, M + 24, ry, { size: 7.5 });
    txt(k, L2 + 2, ry, { size: 7.5, color: GR });
    txt(`: ${v}`, L2 + 24, ry, { size: 7.5 });
  });
  y += custRows.length * rowH;

  // ── 4. Item table (grouped GST columns) ────────────────────────────────────
  // Leaf columns — widths sum to 190:
  // Sl 7 | Desc 46 | HSN 12 | Qty 8 | Unit 9 | Price 15 | Taxable 18 |
  // C% 7.5 | CAmt 11.5 | S% 7.5 | SAmt 11.5 | I% 7.5 | IAmt 11.5 | Total 18
  const W = [7, 46, 12, 8, 9, 15, 18, 7.5, 11.5, 7.5, 11.5, 7.5, 11.5, 18];
  const X: number[] = [];
  { let cx = M; for (const w of W) { X.push(cx); cx += w; } }
  const XEND = M + CW;
  const hdr1H = 5.5, hdr2H = 4.5, tHdrH = hdr1H + hdr2H;
  const tRowH = 6.5;

  const drawItemHeader = (yy: number): number => {
    fill(M, yy, CW, tHdrH, LG);
    bx(M, yy, CW, tHdrH);
    // Vertical separators: simple columns span both header rows
    const simpleCols = [1, 2, 3, 4, 5, 6, 7, 13]; // x-index where a full-height line starts
    for (const i of simpleCols) ln(X[i], yy, X[i], yy + tHdrH);
    // Group boundaries (CGST|SGST|IGST) — full height at group starts already covered (7, 9, 11, 13)
    ln(X[9], yy, X[9], yy + tHdrH);
    ln(X[11], yy, X[11], yy + tHdrH);
    // Sub-column separators only in second header row
    ln(X[8], yy + hdr1H, X[8], yy + tHdrH, 0.15);
    ln(X[10], yy + hdr1H, X[10], yy + tHdrH, 0.15);
    ln(X[12], yy + hdr1H, X[12], yy + tHdrH, 0.15);
    // Horizontal split under group labels only
    ln(X[7], yy + hdr1H, X[13], yy + hdr1H, 0.15);

    const midTop = yy + 6.4; // vertical centre for full-height labels
    txt("Sl", X[0] + W[0] / 2, midTop - 2, { bold: true, size: 6.5, align: "center" });
    txt("No", X[0] + W[0] / 2, midTop + 1.5, { bold: true, size: 6.5, align: "center" });
    txt("Description of Goods", X[1] + 1.5, midTop, { bold: true, size: 7 });
    txt("HSN", X[2] + W[2] / 2, midTop - 2, { bold: true, size: 6.5, align: "center" });
    txt("Code", X[2] + W[2] / 2, midTop + 1.5, { bold: true, size: 6.5, align: "center" });
    txt("Qty", X[3] + W[3] - 1, midTop, { bold: true, size: 6.5, align: "right" });
    txt("Unit", X[4] + W[4] / 2, midTop, { bold: true, size: 6.5, align: "center" });
    txt("Unit", X[5] + W[5] - 1, midTop - 2, { bold: true, size: 6.5, align: "right" });
    txt("Price", X[5] + W[5] - 1, midTop + 1.5, { bold: true, size: 6.5, align: "right" });
    txt("Taxable", X[6] + W[6] - 1, midTop - 2, { bold: true, size: 6.5, align: "right" });
    txt("Value", X[6] + W[6] - 1, midTop + 1.5, { bold: true, size: 6.5, align: "right" });
    // Group headers
    txt("CGST", X[7] + (W[7] + W[8]) / 2, yy + 4, { bold: true, size: 7, align: "center" });
    txt("SGST", X[9] + (W[9] + W[10]) / 2, yy + 4, { bold: true, size: 7, align: "center" });
    txt("IGST", X[11] + (W[11] + W[12]) / 2, yy + 4, { bold: true, size: 7, align: "center" });
    const sub = yy + hdr1H + 3.3;
    txt("%", X[7] + W[7] / 2, sub, { bold: true, size: 6, align: "center" });
    txt("Amount", X[8] + W[8] - 1, sub, { bold: true, size: 6, align: "right" });
    txt("%", X[9] + W[9] / 2, sub, { bold: true, size: 6, align: "center" });
    txt("Amount", X[10] + W[10] - 1, sub, { bold: true, size: 6, align: "right" });
    txt("%", X[11] + W[11] / 2, sub, { bold: true, size: 6, align: "center" });
    txt("Amount", X[12] + W[12] - 1, sub, { bold: true, size: 6, align: "right" });
    txt("Total", X[13] + W[13] - 1, midTop, { bold: true, size: 7, align: "right" });
    return yy + tHdrH;
  };

  y = drawItemHeader(y);

  const drawRowLines = (yy: number, h: number, lw = 0.15) => {
    for (let i = 1; i < X.length; i++) {
      // Skip internal sub-separators of merged look? keep all leaf separators for clean grid
      ln(X[i], yy, X[i], yy + h, lw);
    }
    ln(M, yy, M, yy + h, 0.3);
    ln(XEND, yy, XEND, yy + h, 0.3);
    ln(M, yy + h, XEND, yy + h, lw);
  };

  let tQty = 0, tTaxable = 0, tCgst = 0, tSgst = 0, tIgst = 0, tTot = 0;
  const items = sale.lineItems || [];
  items.forEach((li, idx) => {
    // Page break with header redraw
    if (y + tRowH > PAGE_H - 20) {
      doc.addPage();
      y = M;
      y = drawItemHeader(y);
    }
    const qty = Number(li.quantity ?? 0);
    const gross = qty * Number(li.unitPrice ?? 0) - Number(li.discount ?? 0);
    const taxable = Number(li.lineSubtotal ?? gross);
    const cgst = Number(li.cgst ?? 0);
    const sgst = Number(li.sgst ?? 0);
    const igst = Number(li.igst ?? 0);
    const rate = Number(li.taxRate ?? 0);
    const lineTotal = taxable + Number(li.taxAmount ?? 0);
    const isIgst = li.taxType === "igst" || igst > 0;
    tQty += qty; tTaxable += taxable; tCgst += cgst; tSgst += sgst; tIgst += igst; tTot += lineTotal;

    if (idx % 2 === 1) fill(M, y, CW, tRowH, ZEBRA);
    drawRowLines(y, tRowH);
    const ry = y + tRowH - 2.2;
    txt(String(idx + 1), X[0] + W[0] / 2, ry, { size: 7, align: "center" });
    const name = esc(li.itemName || `Item #${li.itemId}`);
    txt(name.length > 34 ? name.slice(0, 33) + "…" : name, X[1] + 1.5, ry, { size: 7 });
    txt(li.hsnCode ? esc(li.hsnCode) : "-", X[2] + W[2] / 2, ry, { size: 7, align: "center" });
    txt(String(qty), X[3] + W[3] - 1, ry, { size: 7, align: "right" });
    txt((li.unit || "-").toUpperCase(), X[4] + W[4] / 2, ry, { size: 7, align: "center" });
    txt(money(Number(li.unitPrice ?? 0)), X[5] + W[5] - 1, ry, { size: 7, align: "right" });
    txt(money(taxable), X[6] + W[6] - 1, ry, { size: 7, align: "right" });
    if (isIgst) {
      txt("-", X[7] + W[7] / 2, ry, { size: 7, align: "center" });
      txt("-", X[8] + W[8] - 1, ry, { size: 7, align: "right" });
      txt("-", X[9] + W[9] / 2, ry, { size: 7, align: "center" });
      txt("-", X[10] + W[10] - 1, ry, { size: 7, align: "right" });
      txt(`${rate}%`, X[11] + W[11] / 2, ry, { size: 6.5, align: "center" });
      txt(money(igst), X[12] + W[12] - 1, ry, { size: 7, align: "right" });
    } else {
      txt(`${rate / 2}%`, X[7] + W[7] / 2, ry, { size: 6.5, align: "center" });
      txt(money(cgst), X[8] + W[8] - 1, ry, { size: 7, align: "right" });
      txt(`${rate / 2}%`, X[9] + W[9] / 2, ry, { size: 6.5, align: "center" });
      txt(money(sgst), X[10] + W[10] - 1, ry, { size: 7, align: "right" });
      txt("-", X[11] + W[11] / 2, ry, { size: 7, align: "center" });
      txt("-", X[12] + W[12] - 1, ry, { size: 7, align: "right" });
    }
    txt(money(lineTotal), X[13] + W[13] - 1, ry, { size: 7, align: "right" });
    y += tRowH;
  });

  // Totals row of the table
  drawRowLines(y, tRowH, 0.3);
  ln(M, y, XEND, y, 0.3);
  const sr = y + tRowH - 2.2;
  txt("Total  (E&OE)", X[1] + 1.5, sr, { bold: true, size: 7 });
  txt(String(tQty), X[3] + W[3] - 1, sr, { bold: true, size: 7, align: "right" });
  txt(money(tTaxable), X[6] + W[6] - 1, sr, { bold: true, size: 7, align: "right" });
  txt(tCgst > 0 ? money(tCgst) : "-", X[8] + W[8] - 1, sr, { bold: true, size: 7, align: "right" });
  txt(tSgst > 0 ? money(tSgst) : "-", X[10] + W[10] - 1, sr, { bold: true, size: 7, align: "right" });
  txt(tIgst > 0 ? money(tIgst) : "-", X[12] + W[12] - 1, sr, { bold: true, size: 7, align: "right" });
  txt(money(tTot), X[13] + W[13] - 1, sr, { bold: true, size: 7, align: "right" });
  y += tRowH;

  // ── 5. Totals section ──────────────────────────────────────────────────────
  const grandTotal = sale.totalAmount;
  const discount = sale.discountTotal;

  const totRows: [string, string, boolean?][] = [["Taxable Value", money(sale.subtotal)]];
  if (tCgst > 0) totRows.push(["CGST", money(tCgst)]);
  if (tSgst > 0) totRows.push(["SGST", money(tSgst)]);
  if (tIgst > 0) totRows.push(["IGST", money(tIgst)]);
  if (discount > 0) totRows.push(["Discount", `- ${money(discount)}`]);
  totRows.push(["Round Off", "0.00"]);
  totRows.push(["GRAND TOTAL", `Rs. ${money(grandTotal)}`, true]);

  const trH = 5.5;
  const totSH = Math.max(totRows.length * trH, 24);
  if (y + totSH > PAGE_H - 20) { doc.addPage(); y = M; }
  bx(M, y, CW, totSH);
  ln(L2, y, L2, y + totSH);

  txt("Invoice Value (In Words)", M + 2, y + 5, { bold: true, size: 7.5 });
  const words = doc.splitTextToSize(toIndianWords(grandTotal), HW - 6) as string[];
  words.forEach((w, i) => txt(w, M + 2, y + 10 + i * 4, { size: 7.5, color: GR }));
  txt("Certified that the particulars given above are true and correct.", M + 2, y + totSH - 3, { size: 6.5, color: GR });

  totRows.forEach(([label, val, big], i) => {
    const ry = y + i * trH;
    if (i > 0) ln(L2, ry, PAGE_W - M, ry, 0.1);
    if (big) fill(L2 + 0.2, ry + 0.2, HW - 0.4, trH - 0.4 + (totSH - totRows.length * trH), LG);
    const ty = ry + trH - 1.6;
    txt(label, L2 + 2, ty, { bold: big, size: big ? 9 : 7.5 });
    txt(val, PAGE_W - M - 2, ty, { bold: big, size: big ? 9 : 7.5, align: "right" });
  });
  y += totSH;

  // ── 6. Payment details: UPI QR ─────────────────────────────────────────────
  if (qrDataUrl && outletUpiId) {
    const qrSize = 34;               // ≈ 128 px equivalent — reliable scanning
    const qrBH = qrSize + 12;
    if (y + qrBH > PAGE_H - 20) { doc.addPage(); y = M; }
    bx(M, y, CW, qrBH);
    ln(L2, y, L2, y + qrBH);

    txt("PAYMENT DETAILS", M + 2, y + 5.5, { bold: true, size: 8 });
    txt("SCAN TO PAY (UPI)", M + 2, y + 11, { bold: true, size: 7.5, color: GR });
    txt(`UPI ID : ${outletUpiId}`, M + 2, y + 17, { size: 7.5 });
    txt(`Amount : Rs. ${money(grandTotal)}`, M + 2, y + 22, { bold: true, size: 7.5 });
    txt(`Ref : ${esc(sale.invoiceNumber)}`, M + 2, y + 27, { size: 7.5, color: GR });
    if (sale.paymentMode) txt(`Payment Mode : ${esc(sale.paymentMode).replace(/_/g, " ").toUpperCase()}`, M + 2, y + 32, { size: 7, color: GR });

    doc.addImage(qrDataUrl, "PNG", L2 - qrSize - 6, y + (qrBH - qrSize) / 2, qrSize, qrSize);

    txt("Scan the QR code with any UPI app", L2 + 4, y + qrBH / 2 - 2, { size: 7.5, color: GR });
    txt("(GPay / PhonePe / Paytm / BHIM) to pay instantly.", L2 + 4, y + qrBH / 2 + 2.5, { size: 7.5, color: GR });
    y += qrBH;
  }

  // ── 7. Bank details + signature ────────────────────────────────────────────
  const bankRows: [string, string][] = [];
  if (cs.bankName)    bankRows.push(["Bank Name", esc(cs.bankName)]);
  if (cs.bankAccount) bankRows.push(["A/C No", esc(cs.bankAccount)]);
  if (cs.ifscCode)    bankRows.push(["IFSC", esc(cs.ifscCode)]);

  const footH = Math.max(24, bankRows.length * 4.5 + 12);
  if (y + footH > PAGE_H - 14) { doc.addPage(); y = M; }
  bx(M, y, CW, footH);
  ln(L2, y, L2, y + footH);

  if (bankRows.length > 0) {
    txt("Bank Details", M + 2, y + 5.5, { bold: true, size: 7.5 });
    bankRows.forEach(([k, v], i) => {
      const by = y + 10.5 + i * 4.5;
      txt(k, M + 2, by, { size: 7.5, color: GR });
      txt(`: ${v}`, M + 22, by, { size: 7.5 });
    });
  } else {
    txt(`Payment Mode : ${esc(sale.paymentMode ?? "-").replace(/_/g, " ").toUpperCase()}`, M + 2, y + 5.5, { size: 7.5, color: GR });
  }

  txt(`For ${companyName}`, PAGE_W - M - 3, y + 6, { bold: true, size: 8.5, align: "right" });
  txt("Authorised Signatory", PAGE_W - M - 3, y + footH - 4, { size: 7.5, color: GR, align: "right" });
  y += footH;

  // ── 8. Footer ──────────────────────────────────────────────────────────────
  txt("This is a computer-generated invoice.", PAGE_W / 2, y + 4.5, { size: 7, color: GR, align: "center" });

  const buffer = Buffer.from(doc.output("arraybuffer"));
  return { buffer, fileName: invoiceFileName(sale.invoiceNumber, sale.id) };
}
