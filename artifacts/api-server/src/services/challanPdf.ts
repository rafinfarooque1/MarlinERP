/**
 * Delivery Challan PDF generator — jsPDF, A4 portrait.
 *
 * Matches Marlin brand design:
 *   • Same header as invoice (navy M logo + company info left, badge right)
 *   • Teal FROM / TO boxes
 *   • Navy items table header
 *   • Receiver signature + authorised signatory footer
 *   • Navy "Thank You" footer bar
 */
import { jsPDF } from "jspdf";

export interface ChallanItem {
  name: string;
  hsnCode?: string;
  quantity: number;
  unit?: string;
}

export interface ChallanPdfInput {
  cs?: {
    companyName?: string;
    address?: string;
    city?: string;
    state?: string;
    pincode?: string;
    gstin?: string;
    gstNumber?: string;
    phone?: string;
    email?: string;
    bankName?: string;
    bankAccount?: string;
    ifscCode?: string;
  };
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

// ── Colour palette (matches invoicePdf.ts) ────────────────────────────────────
const NAVY:   RGB = [13,  42,  83];
const TEAL:   RGB = [14,  85, 105];
const WHITE:  RGB = [255, 255, 255];
const LGRAY:  RGB = [245, 247, 250];
const MGRAY:  RGB = [160, 170, 185];
const BORDER: RGB = [200, 210, 220];
const BK:     RGB = [20,  20,  20];

export function generateChallanPdf(data: ChallanPdfInput): Buffer {
  const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });

  const PW = 210;
  const PH = 297;
  const M  = 10;
  const CW = PW - M * 2;   // 190
  const HW = CW / 2;       // 95
  const L2 = M + HW;

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
    if (opts?.align)    tOpts.align    = opts.align;
    if (opts?.maxWidth) tOpts.maxWidth = opts.maxWidth;
    doc.text(s, x, y, tOpts);
  };

  const cs = data.cs ?? {};
  const companyName  = cs.companyName  || "Marlin Frozen Fruits";
  const companyAddr  = [cs.address, cs.city, cs.state, cs.pincode].filter(Boolean).join(", ");
  const companyGstin = cs.gstNumber || cs.gstin || "";
  const companyPhone = cs.phone || "";
  const companyEmail = cs.email || "";

  let y = M;

  // ══════════════════════════════════════════════════════════════════════════
  // 1. HEADER — same layout as invoice
  // ══════════════════════════════════════════════════════════════════════════
  // Navy "M" logo mark
  fill(M, y, 11, 11, NAVY);
  txt("M", M + 5.5, y + 7.8, { bold: true, size: 9, color: WHITE, align: "center" });

  // Company name
  txt(companyName.toUpperCase(), M + 14, y + 7, { bold: true, size: 14, color: NAVY });
  if (companyAddr) txt(companyAddr, M + 14, y + 12, { size: 7, color: MGRAY });
  const contactLine = [companyPhone ? `+${companyPhone}` : "", companyEmail].filter(Boolean).join("   |   ");
  if (contactLine) txt(contactLine, M + 14, y + 17, { size: 6.5, color: MGRAY });

  // GSTIN bar
  fill(M, y + 20, CW, 7, LGRAY);
  bx(M, y + 20, CW, 7, BORDER);
  txt(`GSTIN: ${companyGstin || "-"}`, M + 3, y + 25, { bold: true, size: 7.5, color: NAVY });

  // Right: DELIVERY CHALLAN badge
  const badgeX = M + CW - 68;
  fill(badgeX, y, 68, 8, NAVY);
  txt("DELIVERY CHALLAN", badgeX + 34, y + 5.8, { bold: true, size: 9, color: WHITE, align: "center" });

  // Status chip colour
  const stRaw   = data.status || "in_transit";
  const stLabel = stRaw === "completed" ? "COMPLETED" : stRaw === "rejected" ? "REJECTED" : "IN TRANSIT";
  const stBg: RGB = stRaw === "completed" ? [22, 120, 74] : stRaw === "rejected" ? [180, 30, 30] : [160, 100, 0];

  // Meta box below badge
  const metaRows: [string, string][] = [
    ["Challan No.",  data.challanNo || "-"],
    ["Date",         data.date      || "-"],
    ["Status",       stLabel],
    ["Type",         data.isInterstate ? "Interstate Transfer" : "Internal Transfer"],
  ];
  const mRH  = 4.8;
  const metaW = 68;
  fill(badgeX, y + 8, metaW, metaRows.length * mRH + 0.5, [250, 252, 255]);
  bx(badgeX, y + 8, metaW, metaRows.length * mRH + 0.5, BORDER);
  metaRows.forEach(([k, v], i) => {
    const ry = y + 8 + i * mRH + 3.5;
    txt(k, badgeX + 2, ry, { size: 6.5, color: MGRAY });
    if (k === "Status") {
      fill(badgeX + 29, ry - 3.2, metaW - 31, 4, stBg);
      txt(v, badgeX + 30, ry - 0.5, { size: 6, bold: true, color: WHITE });
    } else {
      txt(`: ${v}`, badgeX + 29, ry, { size: 6.5, bold: true, color: NAVY });
    }
  });

  y += 30;

  // ══════════════════════════════════════════════════════════════════════════
  // 2. FROM / TO boxes
  // ══════════════════════════════════════════════════════════════════════════
  const FT_HDR = 7;
  const FT_H   = 28;

  // FROM
  fill(M, y, HW, FT_HDR, TEAL);
  bx(M, y, HW, FT_H, BORDER);
  txt("  FROM", M + 3, y + FT_HDR - 1.8, { bold: true, size: 7.5, color: WHITE });
  txt(data.fromName || "-", M + 3, y + FT_HDR + 6,  { bold: true, size: 10, color: NAVY });
  txt(data.fromType || "",  M + 3, y + FT_HDR + 12, { size: 7.5, color: MGRAY });

  // TO
  fill(L2, y, HW, FT_HDR, TEAL);
  bx(L2, y, HW, FT_H, BORDER);
  txt("  TO", L2 + 3, y + FT_HDR - 1.8, { bold: true, size: 7.5, color: WHITE });
  txt(data.toName || "-", L2 + 3, y + FT_HDR + 6,  { bold: true, size: 10, color: NAVY });
  txt(data.toType || "",  L2 + 3, y + FT_HDR + 12, { size: 7.5, color: MGRAY });
  if (data.isInterstate) {
    fill(L2 + HW - 28, y + FT_H - 8, 26, 6, [160, 100, 0]);
    txt("INTERSTATE", L2 + HW - 15, y + FT_H - 3.5, { size: 5.5, bold: true, color: WHITE, align: "center" });
  }

  y += FT_H + 3;

  // Notes / Approved by strip
  if (data.approvedBy || data.notes) {
    fill(M, y, CW, 7, LGRAY);
    bx(M, y, CW, 7, BORDER);
    const bits: string[] = [];
    if (data.approvedBy) bits.push(`Approved by: ${data.approvedBy}`);
    if (data.notes)      bits.push(`Notes: ${data.notes}`);
    txt(bits.join("   |   "), M + 3, y + 4.8, { size: 7, color: MGRAY, maxWidth: CW - 6 });
    y += 9;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 3. ITEMS TABLE
  // ══════════════════════════════════════════════════════════════════════════
  // Col widths: Sl | Description | HSN Code | Qty | Unit
  const CLS = [10, 96, 35, 28, 21];
  const CX: number[] = [];
  { let cx = M; for (const w of CLS) { CX.push(cx); cx += w; } }

  const HDR_H = 8;
  const ROW_H = 8;

  // Header row — navy
  fill(M, y, CW, HDR_H, NAVY);
  bx(M, y, CW, HDR_H, NAVY);
  const HEADERS = ["SL", "DESCRIPTION OF GOODS", "HSN CODE", "QTY", "UNIT"];
  HEADERS.forEach((h, i) => {
    if (i > 0) ln(CX[i], y, CX[i], y + HDR_H, WHITE, 0.2);
    txt(h, CX[i] + 2, y + HDR_H - 2.5, { bold: true, size: 7, color: WHITE });
  });
  y += HDR_H;

  let totalQty = 0;
  (data.lineItems || []).forEach((item, idx) => {
    totalQty += Number(item.quantity) || 0;
    if (y + ROW_H > PH - 60) { doc.addPage(); y = M; }

    if (idx % 2 === 1) fill(M, y, CW, ROW_H, LGRAY);
    bx(M, y, CW, ROW_H, BORDER);
    for (let i = 1; i < CX.length; i++) ln(CX[i], y, CX[i], y + ROW_H, BORDER, 0.15);

    const ry = y + ROW_H - 2.5;
    txt(String(idx + 1), CX[0] + CLS[0]/2, ry, { size: 7, align: "center" });
    const name = (doc.splitTextToSize(item.name || "", CLS[1] - 4) as string[])[0] || item.name;
    txt(name, CX[1] + 2, ry, { size: 7 });
    txt(item.hsnCode || "-", CX[2] + 2, ry, { size: 7, color: MGRAY });
    txt(String(item.quantity ?? ""), CX[3] + CLS[3]-2, ry, { size: 7, bold: true, align: "right" });
    txt(item.unit || "-", CX[4] + 2, ry, { size: 7, color: MGRAY });
    y += ROW_H;
  });

  // Total row — navy
  fill(M, y, CW, ROW_H, NAVY);
  bx(M, y, CW, ROW_H, NAVY);
  for (let i = 1; i < CX.length; i++) ln(CX[i], y, CX[i], y + ROW_H, WHITE, 0.2);
  txt("TOTAL", CX[1] + 2, y + ROW_H - 2.5, { bold: true, size: 7.5, color: WHITE });
  txt(String(totalQty), CX[3] + CLS[3]-2, y + ROW_H - 2.5, { bold: true, size: 7.5, color: WHITE, align: "right" });
  y += ROW_H + 4;

  // ══════════════════════════════════════════════════════════════════════════
  // 4. SIGNATURE SECTION
  // ══════════════════════════════════════════════════════════════════════════
  const SIG_H = 28;
  if (y + SIG_H + 14 > PH - 4) { doc.addPage(); y = M; }

  // Receiver box
  bx(M, y, HW - 2, SIG_H, BORDER);
  fill(M, y, HW - 2, 7, LGRAY);
  txt("RECEIVER'S SIGNATURE & STAMP", M + 3, y + 5, { bold: true, size: 6.5, color: NAVY });
  txt("Name  : ___________________________", M + 3, y + 14, { size: 6.5, color: MGRAY });
  txt("Date   : _________________________", M + 3, y + 21, { size: 6.5, color: MGRAY });

  // Authorised signatory box
  bx(L2 + 2, y, HW - 2, SIG_H, BORDER);
  fill(L2 + 2, y, HW - 2, 7, LGRAY);
  txt(`For ${companyName.toUpperCase()}`, L2 + HW - 2, y + 5, { bold: true, size: 6.5, color: NAVY, align: "right" });
  txt("Authorised Signatory", L2 + HW - 2, y + SIG_H - 4, { size: 6.5, color: MGRAY, align: "right" });

  y += SIG_H + 4;

  // ══════════════════════════════════════════════════════════════════════════
  // 5. FOOTER — navy bar
  // ══════════════════════════════════════════════════════════════════════════
  if (y + 14 > PH - 4) { doc.addPage(); y = M; }
  fill(M, y, CW, 9, NAVY);
  txt("THANK YOU FOR YOUR BUSINESS!", PW / 2, y + 6, { bold: true, size: 9, color: WHITE, align: "center" });
  y += 11;
  txt("This is a computer-generated document.", PW / 2, y + 3, { size: 6.5, color: MGRAY, align: "center" });

  return Buffer.from(doc.output("arraybuffer"));
}
