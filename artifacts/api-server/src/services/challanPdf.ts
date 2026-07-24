/**
 * Delivery Challan PDF generator — jsPDF, A4 portrait.
 * Accepts pre-assembled data posted from the frontend.
 */
import { jsPDF } from "jspdf";

export interface ChallanItem {
  name: string;
  hsnCode?: string;
  quantity: number;
  unit?: string;
}

export interface ChallanPdfInput {
  cs?: { companyName?: string; address?: string; gstin?: string; phone?: string };
  challanNo: string;
  date: string;
  fromName: string;
  fromType: string;
  toName: string;
  toType: string;
  lineItems: ChallanItem[];
  isInterstate?: boolean;
  status?: string;
  notes?: string;
  approvedBy?: string;
}

type RGB = [number, number, number];

export function generateChallanPdf(data: ChallanPdfInput): Buffer {
  const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });

  const M  = 15;        // margin
  const PW = 210;       // page width
  const PH = 297;       // page height
  const CW = PW - M*2; // content width = 180mm

  // ── Drawing helpers ──────────────────────────────────────────────────────
  const setFont = (bold: boolean, size: number) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(size);
  };
  const color = (rgb: RGB) => doc.setTextColor(rgb[0], rgb[1], rgb[2]);
  const txt = (s: string, x: number, y: number, opts?: {
    size?: number; bold?: boolean; align?: "left"|"center"|"right"; color?: RGB;
  }) => {
    setFont(opts?.bold ?? false, opts?.size ?? 8);
    color(opts?.color ?? [0, 0, 0]);
    doc.text(s, x, y, { align: opts?.align ?? "left" });
  };
  const hline = (x1: number, y: number, x2: number, lw = 0.3) => {
    doc.setDrawColor(0); doc.setLineWidth(lw); doc.line(x1, y, x2, y);
  };
  const vline = (x: number, y1: number, y2: number, lw = 0.2) => {
    doc.setDrawColor(180); doc.setLineWidth(lw); doc.line(x, y1, x, y2);
  };
  const fillRect = (x: number, y: number, w: number, h: number, rgb: RGB) => {
    doc.setFillColor(rgb[0], rgb[1], rgb[2]); doc.rect(x, y, w, h, "F");
  };
  const outlineRect = (x: number, y: number, w: number, h: number) => {
    doc.setDrawColor(0); doc.setLineWidth(0.3); doc.rect(x, y, w, h);
  };

  let y = M;
  const cName = data.cs?.companyName || "Company";

  // ── Company header band ──────────────────────────────────────────────────
  fillRect(M, y, CW, 14, [25, 72, 140]);
  txt(cName, PW/2, y+8, { size: 13, bold: true, align: "center", color: [255, 255, 255] });
  txt("DELIVERY CHALLAN", PW/2, y+12.5, { size: 7.5, align: "center", color: [180, 215, 255] });
  y += 16;

  // ── Challan info row ─────────────────────────────────────────────────────
  outlineRect(M, y, CW, 11);
  vline(M + 60, y, y+11);
  vline(M + 120, y, y+11);

  txt("Challan No.", M+2, y+4.5, { size: 6.5, color: [100, 100, 100] });
  txt(data.challanNo || "—", M+2, y+9, { size: 9, bold: true });

  txt("Date", M+62, y+4.5, { size: 6.5, color: [100, 100, 100] });
  txt(data.date || "—", M+62, y+9, { size: 9, bold: true });

  const st = (data.status || "in_transit");
  const stLabel = st === "completed" ? "COMPLETED" : st === "rejected" ? "REJECTED" : "IN TRANSIT";
  const stColor: RGB = st === "completed" ? [22, 163, 74] : st === "rejected" ? [220, 38, 38] : [180, 100, 0];
  txt("Status", M+122, y+4.5, { size: 6.5, color: [100, 100, 100] });
  txt(stLabel, M+122, y+9, { size: 8.5, bold: true, color: stColor });
  y += 13;

  // ── From / To ────────────────────────────────────────────────────────────
  const half = CW/2;
  outlineRect(M, y, half, 20);
  outlineRect(M+half, y, half, 20);

  txt("FROM", M+3, y+5, { size: 6, bold: true, color: [60, 90, 160] });
  hline(M+3, y+6, M+half-3, 0.2);
  txt(data.fromName || "—", M+3, y+12, { size: 9, bold: true });
  txt(data.fromType || "", M+3, y+17, { size: 7, color: [120, 120, 120] });

  txt("TO", M+half+3, y+5, { size: 6, bold: true, color: [60, 90, 160] });
  hline(M+half+3, y+6, M+CW-3, 0.2);
  txt(data.toName || "—", M+half+3, y+12, { size: 9, bold: true });
  txt(data.toType || "", M+half+3, y+17, { size: 7, color: [120, 120, 120] });
  if (data.isInterstate) txt("(Interstate)", M+CW-3, y+17, { size: 6, align: "right", color: [160, 80, 0] });
  y += 22;

  // ── Items table ──────────────────────────────────────────────────────────
  // col widths: [Sl, Description, HSN, Qty, Unit]
  const cw = [10, 87, 32, 26, 25];
  const cx = [M];
  cw.forEach(w => cx.push(cx[cx.length-1] + w));

  // Table header
  fillRect(M, y, CW, 8, [225, 237, 255]);
  outlineRect(M, y, CW, 8);
  const headers = ["Sl", "Description of Goods", "HSN Code", "Qty", "Unit"];
  headers.forEach((h, i) => {
    txt(h, cx[i]+2, y+5.5, { size: 7, bold: true, color: [25, 60, 130] });
    if (i > 0) vline(cx[i], y, y+8, 0.3);
  });
  y += 8;

  let totalQty = 0;
  const ROW_H = 8;
  (data.lineItems || []).forEach((item, idx) => {
    totalQty += Number(item.quantity) || 0;
    if (idx % 2 === 1) fillRect(M, y, CW, ROW_H, [248, 250, 254]);
    doc.setDrawColor(200); doc.setLineWidth(0.2); doc.rect(M, y, CW, ROW_H);
    txt(String(idx+1), cx[0]+2, y+5.5, { size: 7 });
    // Clip long names
    const name = (doc.splitTextToSize(item.name || "", cw[1]-4) as string[])[0] || item.name;
    txt(name, cx[1]+2, y+5.5, { size: 7 });
    txt(item.hsnCode || "—", cx[2]+2, y+5.5, { size: 7, color: [100, 100, 100] });
    txt(String(item.quantity ?? ""), cx[3]+2, y+5.5, { size: 7, bold: true });
    txt(item.unit || "—", cx[4]+2, y+5.5, { size: 7, color: [100, 100, 100] });
    for (let i = 1; i < cx.length; i++) vline(cx[i], y, y+ROW_H, 0.2);
    y += ROW_H;
    if (y > PH - 50) { doc.addPage(); y = M; }
  });

  // Total row
  fillRect(M, y, CW, 8, [225, 237, 255]);
  outlineRect(M, y, CW, 8);
  txt("TOTAL", cx[1]+2, y+5.5, { size: 7, bold: true, color: [25, 60, 130] });
  txt(String(totalQty), cx[3]+2, y+5.5, { size: 7, bold: true, color: [25, 60, 130] });
  for (let i = 1; i < cx.length; i++) vline(cx[i], y, y+8, 0.3);
  y += 10;

  // Notes / Approved by
  if (data.notes) {
    txt(`Notes: ${data.notes}`, M, y, { size: 7, color: [80, 80, 80] });
    y += 5;
  }
  if (data.approvedBy) {
    txt(`Approved by: ${data.approvedBy}`, M, y, { size: 7, color: [80, 80, 80] });
    y += 5;
  }

  // ── Signature footer ──────────────────────────────────────────────────────
  const footY = PH - 38;
  hline(M, footY, M+CW, 0.5);
  outlineRect(M, footY, CW/2, 24);
  outlineRect(M+CW/2, footY, CW/2, 24);
  txt("Receiver's Signature & Stamp", M+3, footY+5, { size: 6, color: [100, 100, 100] });
  txt("Name: _______________________", M+3, footY+15, { size: 6, color: [130, 130, 130] });
  txt("Date: _______________", M+3, footY+21, { size: 6, color: [130, 130, 130] });
  txt(cName, M+CW-3, footY+5, { size: 7.5, bold: true, align: "right" });
  txt("Authorised Signatory", M+CW-3, footY+21, { size: 6, align: "right", color: [100, 100, 100] });

  return Buffer.from(doc.output("arraybuffer"));
}
