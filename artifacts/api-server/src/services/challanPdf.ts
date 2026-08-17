/**
 * Delivery Challan PDF — jsPDF, A4 portrait.
 *
 * The goods-movement document for a stock transfer: FROM/TO endpoints, the
 * dispatched lines with HSN and quantity, status, and the receiver's
 * signature block. Assembled by the route from the stored transfer row —
 * never from client-composed figures.
 *
 * Wears the shared letterhead: the DISPATCHING LOCATION is the masthead
 * (company profile as fallback), so a challan carries the same identity as
 * the invoices that location issues. Accent is the house teal, telling
 * goods-movement paper apart from money documents at a glance.
 */
import { jsPDF } from "jspdf";
import {
  FONT, registerFonts, drawLetterhead, drawSignatureRow, drawGeneratedNote,
} from "@workspace/pdf-kit";
import type { InvoiceIssuer } from "../lib/billingProfile";

type RGB = [number, number, number];

export interface ChallanItem {
  name: string;
  hsnCode?: string | null;
  quantity: number;
  unit?: string | null;
}

export interface ChallanPdfInput {
  issuer: InvoiceIssuer;
  logoDataUrl?: string | null;
  challanNo: string;
  date: string;
  fromName: string;
  fromType: string;
  toName: string;
  toType: string;
  lineItems: ChallanItem[];
  isInterstate?: boolean;
  status?: string | null;
  notes?: string | null;
  approvedBy?: string | null;
}

function fmtDate(v: string | null | undefined): string {
  if (!v) return "—";
  try {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return String(v);
    return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  } catch { return String(v); }
}

const typeLabel = (t: string) =>
  t === "warehouse" ? "Warehouse" : t === "outlet" ? "Outlet" : t === "headoffice" ? "Head Office" : t || "";

export async function generateChallanPdf(data: ChallanPdfInput): Promise<Buffer> {
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait", compress: true });
  await registerFonts(doc);

  const PW = 210, PH = 297, M = 12, CW = PW - M * 2;
  const ACCENT: RGB = [14, 85, 105];     // goods-movement teal
  const SOFT: RGB = [238, 247, 249];
  const INK: RGB = [32, 44, 74];
  const MUT: RGB = [104, 116, 140];
  const BORDER: RGB = [201, 213, 229];
  const WHITE: RGB = [255, 255, 255];

  const txt = (
    s: string, x: number, y: number,
    o: { size?: number; bold?: boolean; align?: "left" | "center" | "right"; color?: RGB } = {},
  ) => {
    doc.setFont(FONT, o.bold ? "bold" : "normal");
    doc.setFontSize(o.size ?? 9);
    const c = o.color ?? INK;
    doc.setTextColor(c[0], c[1], c[2]);
    doc.text(s, x, y, o.align ? { align: o.align } : {});
  };
  const cell = (s: string, x: number, y: number, w: number, o: {
    size?: number; bold?: boolean; align?: "left" | "center" | "right"; color?: RGB;
  } = {}) => {
    let size = o.size ?? 8;
    doc.setFont(FONT, o.bold ? "bold" : "normal");
    doc.setFontSize(size);
    let t = s;
    while (size > 5 && doc.getTextWidth(t) > w) { size -= 0.25; doc.setFontSize(size); }
    while (t.length > 1 && doc.getTextWidth(`${t}\u2026`) > w && doc.getTextWidth(t) > w) t = t.slice(0, -1);
    if (t !== s) t = `${t}\u2026`;
    txt(t, x, y, { ...o, size });
  };
  const fillRect = (x: number, y: number, w: number, h: number, rgb: RGB) => {
    doc.setFillColor(rgb[0], rgb[1], rgb[2]); doc.rect(x, y, w, h, "F");
  };
  const box = (x: number, y: number, w: number, h: number) => {
    doc.setDrawColor(BORDER[0], BORDER[1], BORDER[2]); doc.setLineWidth(0.2); doc.rect(x, y, w, h);
  };
  const wrap = (s: string, w: number, size: number): string[] => {
    doc.setFont(FONT, "normal");
    doc.setFontSize(size);
    return doc.splitTextToSize(s || "", w) as string[];
  };

  // ── Header ────────────────────────────────────────────────────────────────
  const stRaw = data.status || "in_transit";
  const stLabel = stRaw === "completed" ? "Completed" : stRaw === "rejected" ? "Rejected" : "In Transit";
  const metaRows: Array<[string, string]> = [
    ["Challan No.", data.challanNo || "—"],
    ["Date", fmtDate(data.date)],
    ["Status", stLabel],
    ["Type", data.isInterstate ? "Interstate Transfer" : "Internal Transfer"],
  ];

  let y = drawLetterhead(doc, {
    issuer: data.issuer,
    logoDataUrl: data.logoDataUrl,
    badgeTitle: "DELIVERY CHALLAN",
    accent: ACCENT,
    metaRows,
    margin: M,
  });

  // ── FROM / TO boxes ───────────────────────────────────────────────────────
  const HW = (CW - 4) / 2;
  const L2 = M + HW + 4;
  const FT_H = 22;
  for (const [x, label, name, type] of [
    [M, "FROM", data.fromName, data.fromType],
    [L2, "TO", data.toName, data.toType],
  ] as Array<[number, string, string, string]>) {
    fillRect(x, y, HW, 6.5, ACCENT);
    box(x, y, HW, FT_H);
    txt(label, x + 3, y + 4.6, { size: 7.5, bold: true, color: WHITE });
    cell(name || "—", x + 3, y + 12.5, HW - 6, { size: 9.5, bold: true, color: INK });
    txt(typeLabel(type), x + 3, y + 17.8, { size: 7.4, color: MUT });
  }
  if (data.isInterstate) {
    fillRect(L2 + HW - 27, y + FT_H - 7, 25, 5, [160, 100, 0]);
    txt("INTERSTATE", L2 + HW - 14.5, y + FT_H - 3.5, { size: 5.8, bold: true, color: WHITE, align: "center" });
  }
  y += FT_H + 3;

  // Notes / approved-by strip.
  const bits: string[] = [];
  if (data.approvedBy) bits.push(`Approved by: ${data.approvedBy}`);
  if (data.notes) bits.push(`Notes: ${data.notes}`);
  if (bits.length) {
    const sLines = wrap(bits.join("   |   "), CW - 6, 7.2).slice(0, 3);
    const sh = Math.max(7, sLines.length * 3.6 + 3.6);
    fillRect(M, y, CW, sh, SOFT);
    box(M, y, CW, sh);
    sLines.forEach((l, i) => txt(l, M + 3, y + 4.8 + i * 3.6, { size: 7.2, color: MUT }));
    y += sh + 3;
  }

  // ── Items — SL | Description | HSN | Qty | Unit ──────────────────────────
  const C_SL = 10, C_HSN = 32, C_QTY = 26, C_UNIT = 20;
  const C_DESC = CW - C_SL - C_HSN - C_QTY - C_UNIT;
  const xSl = M, xDesc = xSl + C_SL, xHsn = xDesc + C_DESC, xQty = xHsn + C_HSN, xUnit = xQty + C_QTY;

  const drawTableHead = () => {
    fillRect(M, y, CW, 8, ACCENT);
    txt("SL", xSl + 2, y + 5.4, { size: 8, bold: true, color: WHITE });
    txt("DESCRIPTION OF GOODS", xDesc + 2, y + 5.4, { size: 8, bold: true, color: WHITE });
    txt("HSN CODE", xHsn + 2, y + 5.4, { size: 8, bold: true, color: WHITE });
    txt("QTY", xQty + C_QTY - 2, y + 5.4, { size: 8, bold: true, align: "right", color: WHITE });
    txt("UNIT", xUnit + 2, y + 5.4, { size: 8, bold: true, color: WHITE });
    y += 8;
  };
  drawTableHead();

  const genNote = "This is a computer-generated delivery challan.";
  let totalQty = 0;
  (data.lineItems || []).forEach((item, i) => {
    totalQty += Number(item.quantity) || 0;
    if (y > PH - 75) {
      drawGeneratedNote(doc, genNote, M);
      doc.addPage();
      y = M + 4;
      drawTableHead();
    }
    if (i % 2 === 1) fillRect(M, y, CW, 8, SOFT);
    box(M, y, CW, 8);
    txt(String(i + 1), xSl + 2, y + 5.3, { size: 8, color: MUT });
    cell(item.name || "—", xDesc + 2, y + 5.3, C_DESC - 4, { size: 8.4, bold: true, color: INK });
    txt(item.hsnCode || "—", xHsn + 2, y + 5.3, { size: 7.8, color: MUT });
    txt(String(item.quantity ?? ""), xQty + C_QTY - 2, y + 5.3, { size: 8.4, bold: true, align: "right", color: INK });
    cell(item.unit || "—", xUnit + 2, y + 5.3, C_UNIT - 4, { size: 7.8, color: MUT });
    y += 8;
  });

  // Total row.
  fillRect(M, y, CW, 9, ACCENT);
  txt("TOTAL", xDesc + 2, y + 6.1, { size: 8.5, bold: true, color: WHITE });
  const tq = Math.round(totalQty * 1000) / 1000;
  txt(String(tq), xQty + C_QTY - 2, y + 6.1, { size: 8.5, bold: true, align: "right", color: WHITE });
  y += 12;

  // ── Signatures ────────────────────────────────────────────────────────────
  y = Math.min(Math.max(y, 235), PH - 30);
  drawSignatureRow(doc, ["Dispatched By", "Receiver's Signature & Stamp", "Authorized Signatory"], y, M, CW);

  drawGeneratedNote(doc, genNote, M);

  return Buffer.from(doc.output("arraybuffer"));
}
