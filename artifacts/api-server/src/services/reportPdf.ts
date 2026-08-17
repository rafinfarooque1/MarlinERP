/**
 * Generic tabular report PDF — jsPDF, A4 portrait or landscape.
 *
 * Shared renderer for every Reports Center export. Matches the Marlin brand
 * design used by invoicePdf/challanPdf:
 *   • Navy "M" logo + company info left, navy report-title badge right
 *   • GSTIN bar, meta box (period / filters / generated-on)
 *   • One or more sections: optional teal heading band, navy column header,
 *     zebra rows, optional navy totals row
 *   • Page numbers + "computer-generated" note on every page
 *
 * The caller supplies preformatted strings for cells (money already ₹-formatted
 * etc.) — this keeps one formatting source of truth in the UI, and the PDF
 * always matches what the user sees on screen.
 */
import { jsPDF } from "jspdf";

type RGB = [number, number, number];

const NAVY:   RGB = [13,  42,  83];
const TEAL:   RGB = [14,  85, 105];
const WHITE:  RGB = [255, 255, 255];
const LGRAY:  RGB = [245, 247, 250];
const MGRAY:  RGB = [160, 170, 185];
const BORDER: RGB = [200, 210, 220];
const BK:     RGB = [20,  20,  20];

export interface ReportColumn {
  label: string;
  /** Relative width weight (defaults to 1). Scaled to fill the page width. */
  width?: number;
  align?: "left" | "right" | "center";
}

export interface ReportSection {
  heading?: string;
  columns: ReportColumn[];
  rows: (string | number)[][];
  /** Rendered as a navy bottom row (e.g. totals). Same cell count as columns. */
  totalsRow?: (string | number)[];
}

export interface ReportPdfInput {
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
  };
  title: string;
  subtitle?: string;
  metaRows?: [string, string][];
  orientation?: "portrait" | "landscape";
  sections: ReportSection[];
  footerNote?: string;
}

export function generateReportPdf(data: ReportPdfInput): Buffer {
  const landscape = data.orientation === "landscape";
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: landscape ? "landscape" : "portrait", compress: true });

  const PW = landscape ? 297 : 210;
  const PH = landscape ? 210 : 297;
  const M  = 10;
  const CW = PW - M * 2;
  const FOOT = 12;                    // reserved footer space per page

  // ── Drawing helpers (same style as challanPdf) ──────────────────────────────
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
  /** Clip a cell value to one line that fits the column. */
  const clip = (s: string, w: number): string => {
    const parts = doc.splitTextToSize(s, w) as string[];
    if (parts.length <= 1) return s;
    return (parts[0] ?? "").replace(/\s+\S*$/, "") + "…";
  };

  const cs = data.cs ?? {};
  const companyName  = cs.companyName || "Frozen Fruits ERP";
  const companyAddr  = [cs.address, cs.city, cs.state, cs.pincode].filter(Boolean).join(", ");
  const companyGstin = cs.gstNumber || cs.gstin || "";
  const contactLine  = [cs.phone ? `+${cs.phone}` : "", cs.email].filter(Boolean).join("   |   ");

  let y = M;

  // ══════════════════════════════════════════════════════════════════════════
  // 1. HEADER — brand header + report badge
  // ══════════════════════════════════════════════════════════════════════════
  fill(M, y, 11, 11, NAVY);
  // Lettermark = first letter of whoever's letterhead this is (location or
  // company), not a hardcoded brand initial.
  txt((companyName.trim().charAt(0) || "F").toUpperCase(), M + 5.5, y + 7.8, { bold: true, size: 9, color: WHITE, align: "center" });
  txt(companyName.toUpperCase(), M + 14, y + 7, { bold: true, size: 14, color: NAVY });
  if (companyAddr)  txt(companyAddr, M + 14, y + 12, { size: 7, color: MGRAY });
  if (contactLine)  txt(contactLine, M + 14, y + 17, { size: 6.5, color: MGRAY });

  // Right: report title badge (width adapts to title)
  doc.setFont("helvetica", "bold"); doc.setFontSize(9);
  const badgeW = Math.max(58, Math.min(100, doc.getTextWidth(data.title.toUpperCase()) + 14));
  const badgeX = M + CW - badgeW;
  fill(badgeX, y, badgeW, 8, NAVY);
  txt(data.title.toUpperCase(), badgeX + badgeW / 2, y + 5.8, { bold: true, size: 9, color: WHITE, align: "center" });

  // Meta box below badge
  const metaRows = data.metaRows ?? [];
  if (metaRows.length) {
    const mRH = 4.8;
    fill(badgeX, y + 8, badgeW, metaRows.length * mRH + 0.5, [250, 252, 255]);
    bx(badgeX, y + 8, badgeW, metaRows.length * mRH + 0.5, BORDER);
    metaRows.forEach(([k, v], i) => {
      const ry = y + 8 + i * mRH + 3.5;
      txt(k, badgeX + 2, ry, { size: 6.5, color: MGRAY });
      txt(`: ${clip(v, badgeW - 26)}`, badgeX + 22, ry, { size: 6.5, bold: true, color: NAVY });
    });
  }

  // GSTIN bar
  fill(M, y + 20, CW - badgeW - 4, 7, LGRAY);
  bx(M, y + 20, CW - badgeW - 4, 7, BORDER);
  txt(`GSTIN: ${companyGstin || "-"}`, M + 3, y + 25, { bold: true, size: 7.5, color: NAVY });

  y += Math.max(30, 10 + metaRows.length * 4.8 + 4);

  // Subtitle strip (e.g. period)
  if (data.subtitle) {
    fill(M, y, CW, 7, LGRAY);
    bx(M, y, CW, 7, BORDER);
    txt(data.subtitle, M + 3, y + 4.8, { bold: true, size: 7.5, color: TEAL, maxWidth: CW - 6 });
    y += 10;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 2. SECTIONS
  // ══════════════════════════════════════════════════════════════════════════
  const HDR_H = 7.5;
  const ROW_H = 6.5;

  const drawColHeader = (cx: number[], cw: number[], cols: ReportColumn[]) => {
    fill(M, y, CW, HDR_H, NAVY);
    cols.forEach((c, i) => {
      if (i > 0) ln(cx[i], y, cx[i], y + HDR_H, WHITE, 0.2);
      const tx = c.align === "right" ? cx[i] + cw[i] - 2 : c.align === "center" ? cx[i] + cw[i] / 2 : cx[i] + 2;
      txt(c.label.toUpperCase(), tx, y + HDR_H - 2.4, { bold: true, size: 6.8, color: WHITE, align: c.align ?? "left" });
    });
    y += HDR_H;
  };

  for (const section of data.sections) {
    const cols = section.columns;
    const weights = cols.map((c) => c.width && c.width > 0 ? c.width : 1);
    const wSum = weights.reduce((s, w) => s + w, 0);
    const cw = weights.map((w) => (w / wSum) * CW);
    const cx: number[] = [];
    { let acc = M; for (const w of cw) { cx.push(acc); acc += w; } }

    // Section heading (teal band)
    const headingH = section.heading ? 7 : 0;
    if (y + headingH + HDR_H + ROW_H > PH - FOOT) { doc.addPage(); y = M; }
    if (section.heading) {
      fill(M, y, CW, 7, TEAL);
      txt(section.heading.toUpperCase(), M + 3, y + 4.8, { bold: true, size: 7.5, color: WHITE });
      y += 7;
    }
    drawColHeader(cx, cw, cols);

    if (!section.rows.length) {
      bx(M, y, CW, ROW_H, BORDER);
      txt("No records for the selected period.", M + 3, y + ROW_H - 2.2, { size: 7, color: MGRAY });
      y += ROW_H;
    }

    section.rows.forEach((row, idx) => {
      if (y + ROW_H > PH - FOOT) {
        doc.addPage(); y = M;
        drawColHeader(cx, cw, cols);
      }
      if (idx % 2 === 1) fill(M, y, CW, ROW_H, LGRAY);
      bx(M, y, CW, ROW_H, BORDER);
      for (let i = 1; i < cx.length; i++) ln(cx[i], y, cx[i], y + ROW_H, BORDER, 0.15);
      const ry = y + ROW_H - 2.2;
      cols.forEach((c, i) => {
        const raw = row[i] == null ? "" : String(row[i]);
        const v = clip(raw, cw[i] - 4);
        const tx = c.align === "right" ? cx[i] + cw[i] - 2 : c.align === "center" ? cx[i] + cw[i] / 2 : cx[i] + 2;
        txt(v, tx, ry, { size: 6.8, align: c.align ?? "left" });
      });
      y += ROW_H;
    });

    if (section.totalsRow) {
      if (y + ROW_H > PH - FOOT) { doc.addPage(); y = M; drawColHeader(cx, cw, cols); }
      fill(M, y, CW, ROW_H, NAVY);
      for (let i = 1; i < cx.length; i++) ln(cx[i], y, cx[i], y + ROW_H, WHITE, 0.2);
      const ry = y + ROW_H - 2.2;
      cols.forEach((c, i) => {
        const raw = section.totalsRow![i] == null ? "" : String(section.totalsRow![i]);
        const v = clip(raw, cw[i] - 4);
        const tx = c.align === "right" ? cx[i] + cw[i] - 2 : c.align === "center" ? cx[i] + cw[i] / 2 : cx[i] + 2;
        txt(v, tx, ry, { bold: true, size: 6.8, color: WHITE, align: c.align ?? "left" });
      });
      y += ROW_H;
    }

    y += 5; // gap between sections
  }

  if (data.footerNote) {
    if (y + 8 > PH - FOOT) { doc.addPage(); y = M; }
    txt(data.footerNote, M, y + 4, { size: 6.5, color: MGRAY, maxWidth: CW });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 3. FOOTER on every page — page number + note
  // ══════════════════════════════════════════════════════════════════════════
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    txt("This is a computer-generated report.", PW / 2, PH - 5, { size: 6, color: MGRAY, align: "center" });
    txt(`Page ${p} of ${pages}`, PW - M, PH - 5, { size: 6, color: MGRAY, align: "right" });
  }

  return Buffer.from(doc.output("arraybuffer"));
}
