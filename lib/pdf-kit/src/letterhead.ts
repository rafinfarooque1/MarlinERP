/**
 * Shared document letterhead — the ONE header every A4 business document
 * (vouchers, returns, expense vouchers, challans…) draws, so a stack of
 * printouts from different modules reads as one company's paperwork.
 *
 * Layout (extracted from the receipt/payment voucher, which matches the tax
 * invoice's design language):
 *
 *   ┌ logo ┐  ISSUING LOCATION NAME              ┌────── badge ──────┐
 *   └──────┘  address lines                       │  DOCUMENT TITLE   │
 *             Ph / email                          └───────────────────┘
 *             GSTIN: …                             Meta label : value
 *             FSSAI Lic. No.: …                    Meta label : value
 *   ───────────────────────────────────────────────────────────────────
 *
 * The issuer is the SELECTED LOCATION's identity (resolved server-side with
 * the company profile only as fallback) — never a generic company banner.
 * Callers must `await registerFonts(doc)` before drawing: the letterhead
 * assumes the embedded ₹-capable face is available.
 */
import type { jsPDF } from "jspdf";
import { FONT } from "./index";
import type { RGB } from "./index";

export interface LetterheadIssuer {
  /** The name printed as the document's issuing identity. */
  tradeName: string;
  /** Street/area lines, already split and trimmed. */
  addressLines: string[];
  phone: string;
  email: string;
  gstin: string;
  fssai: string;
}

export interface LetterheadOpts {
  issuer: LetterheadIssuer;
  /** Inline data URI, or null/undefined for the lettermark fallback. */
  logoDataUrl?: string | null;
  /** Document title in the badge, e.g. "JOURNAL VOUCHER". */
  badgeTitle: string;
  /** Brand accent for the badge, name and GSTIN line. */
  accent: RGB;
  /** Label/value rows under the badge, e.g. [["Voucher No.", "JV/26-27/12"]]. */
  metaRows: Array<[label: string, value: string]>;
  /** Page margin in mm. Default 12. */
  margin?: number;
  /** Content width in mm. Default A4 width minus both margins. */
  width?: number;
  /** Top of the header. Default margin + 2. */
  y?: number;
}

const INK: RGB = [32, 44, 74];
const MUT: RGB = [104, 116, 140];
const LINE: RGB = [201, 213, 229];
const WHITE: RGB = [255, 255, 255];

/** Draw the letterhead; returns the y where document content should begin. */
export function drawLetterhead(doc: jsPDF, o: LetterheadOpts): number {
  const PAGE_W = doc.internal.pageSize.getWidth();
  const M = o.margin ?? 12;
  const CW = o.width ?? PAGE_W - M * 2;
  const ACCENT = o.accent;
  let y = o.y ?? M + 2;

  const txt = (
    s: string, x: number, ty: number,
    t: { size?: number; bold?: boolean; align?: "left" | "center" | "right"; color?: RGB } = {},
  ) => {
    doc.setFont(FONT, t.bold ? "bold" : "normal");
    doc.setFontSize(t.size ?? 9);
    const c = t.color ?? INK;
    doc.setTextColor(c[0], c[1], c[2]);
    doc.text(s, x, ty, t.align ? { align: t.align } : {});
  };
  /** Shrink a one-line cell until it fits — never draw over a neighbour. */
  const cell = (s: string, x: number, cy: number, w: number, t: {
    size?: number; bold?: boolean; color?: RGB;
  } = {}) => {
    let size = t.size ?? 8;
    doc.setFont(FONT, t.bold ? "bold" : "normal");
    doc.setFontSize(size);
    let v = s;
    while (size > 5 && doc.getTextWidth(v) > w) { size -= 0.25; doc.setFontSize(size); }
    while (v.length > 1 && doc.getTextWidth(`${v}\u2026`) > w && doc.getTextWidth(v) > w) v = v.slice(0, -1);
    if (v !== s) v = `${v}\u2026`;
    txt(v, x, cy, { ...t, size });
  };
  const wrap = (s: string, w: number, size: number, bold = false): string[] => {
    doc.setFont(FONT, bold ? "bold" : "normal");
    doc.setFontSize(size);
    return doc.splitTextToSize(s || "", w) as string[];
  };
  const rfill = (x: number, ry: number, w: number, h: number, rgb: RGB, r = 1.2) => {
    doc.setFillColor(rgb[0], rgb[1], rgb[2]); doc.roundedRect(x, ry, w, h, r, r, "F");
  };
  const line = (x1: number, y1: number, x2: number, y2: number, lw = 0.2) => {
    doc.setDrawColor(LINE[0], LINE[1], LINE[2]); doc.setLineWidth(lw); doc.line(x1, y1, x2, y2);
  };

  const BADGE_W = 64;
  const badgeX = M + CW - BADGE_W;
  const nameX = M + 23;
  const nameW = badgeX - nameX - 9;

  // ── Logo (or lettermark) ────────────────────────────────────────────────
  const LOGO_S = 19;
  const drawLettermark = () => {
    rfill(M, y, LOGO_S, LOGO_S, ACCENT, 2);
    txt((o.issuer.tradeName[0] || "M").toUpperCase(), M + LOGO_S / 2, y + LOGO_S / 2 + 4,
        { bold: true, size: 16, color: WHITE, align: "center" });
  };
  if (o.logoDataUrl) {
    try {
      const props = doc.getImageProperties(o.logoDataUrl);
      const s = Math.min(LOGO_S / (props.width || 1), LOGO_S / (props.height || 1));
      const lw = (props.width || 1) * s;
      const lh = (props.height || 1) * s;
      doc.addImage(o.logoDataUrl, M + (LOGO_S - lw) / 2, y + (LOGO_S - lh) / 2, lw, lh, undefined, "FAST");
    } catch { drawLettermark(); }
  } else {
    drawLettermark();
  }

  // ── Issuing identity ────────────────────────────────────────────────────
  const nameLines = wrap((o.issuer.tradeName || "—").toUpperCase(), nameW, 15.5, true).slice(0, 2);
  let ly = y + 7;
  for (const nl of nameLines) {
    txt(nl, nameX, ly, { bold: true, size: 15.5, color: ACCENT });
    ly += 6.4;
  }
  ly -= 0.8;

  for (const l of o.issuer.addressLines.slice(0, 4)) {
    cell(l, nameX, ly, nameW, { size: 7.4, color: INK });
    ly += 3.9;
  }
  const contactBits = [
    o.issuer.phone ? `Ph: +91 ${o.issuer.phone}`.replace(/\+91 \+/, "+") : "",
    o.issuer.email || "",
  ].filter(Boolean).join("    ");
  if (contactBits) {
    ly += 1;
    cell(contactBits, nameX, ly, nameW, { size: 7.4, color: INK });
    ly += 4.2;
  }
  if (o.issuer.gstin) {
    ly += 0.6;
    txt(`GSTIN: ${o.issuer.gstin}`, nameX, ly + 1.4, { bold: true, size: 8.6, color: ACCENT });
    ly += 5.4;
  }
  if (o.issuer.fssai) {
    txt(`FSSAI Lic. No.: ${o.issuer.fssai}`, nameX, ly + 0.6, { bold: true, size: 7.6, color: ACCENT });
    ly += 4.6;
  }

  // ── Badge + meta rows ───────────────────────────────────────────────────
  rfill(badgeX, y, BADGE_W, 9.5, ACCENT, 1);
  txt(o.badgeTitle, badgeX + BADGE_W / 2, y + 6.3, { bold: true, size: 10.5, color: WHITE, align: "center" });

  let my = y + 14.6;
  for (const [label, value] of o.metaRows) {
    txt(label, badgeX + 0.5, my, { size: 7.4, color: MUT });
    cell(`:  ${value}`, badgeX + 22.5, my, BADGE_W - 23, { size: 7.4, bold: true, color: INK });
    my += 5.6;
  }
  my -= 2;

  const headerBottom = Math.max(ly + 1, my, y + LOGO_S + 1);
  line(badgeX - 4.5, y + 1, badgeX - 4.5, headerBottom - 1, 0.35);
  line(M, headerBottom + 2, M + CW, headerBottom + 2, 0.4);
  return headerBottom + 7;
}

/**
 * Signature strip: evenly spaced signature lines with captions. `y` is the
 * baseline the lines sit on; returns the y below the captions.
 */
export function drawSignatureRow(
  doc: jsPDF, labels: string[], y: number, margin = 12, width?: number,
): number {
  const PAGE_W = doc.internal.pageSize.getWidth();
  const CW = width ?? PAGE_W - margin * 2;
  const sigW = CW / labels.length;
  labels.forEach((label, i) => {
    const x = margin + sigW * i;
    doc.setDrawColor(120, 130, 150); doc.setLineWidth(0.25);
    doc.line(x + 6, y + 12, x + sigW - 6, y + 12);
    doc.setFont(FONT, "normal"); doc.setFontSize(7);
    doc.setTextColor(MUT[0], MUT[1], MUT[2]);
    doc.text(label, x + sigW / 2, y + 16, { align: "center" });
  });
  return y + 18;
}

/** Bottom rule + "computer-generated" note on the CURRENT page. */
export function drawGeneratedNote(doc: jsPDF, note: string, margin = 12): void {
  const PAGE_W = doc.internal.pageSize.getWidth();
  const PAGE_H = doc.internal.pageSize.getHeight();
  doc.setDrawColor(LINE[0], LINE[1], LINE[2]); doc.setLineWidth(0.3);
  doc.line(margin, PAGE_H - 12, PAGE_W - margin, PAGE_H - 12);
  doc.setFont(FONT, "normal"); doc.setFontSize(6.6);
  doc.setTextColor(MUT[0], MUT[1], MUT[2]);
  doc.text(note, PAGE_W / 2, PAGE_H - 8, { align: "center" });
}
