/**
 * Sales / Purchase return note PDF — jsPDF, A4 portrait.
 *
 * The formal print of a recorded return: which invoice or bill it is against,
 * the returned lines with their taxable value and GST, how it was settled
 * (credit note or cash refund), and the reason. Rendered ONLY from the stored
 * return row — every figure is the server's own prorated r2 chain, never a
 * qty×rate recomputation, so the print can never disagree with the credit or
 * debit note that posted to the books.
 *
 * Shares the letterhead with invoices and vouchers: the ISSUING LOCATION is
 * the masthead. Sales returns wear the credit-note green, purchase returns
 * the debit-note umber — the same accents as the notes they settle through.
 */
import { jsPDF } from "jspdf";
import {
  FONT, registerFonts, drawLetterhead, drawSignatureRow, drawGeneratedNote,
  amountInWords,
} from "@workspace/pdf-kit";
import type { InvoiceIssuer } from "../lib/billingProfile";

type RGB = [number, number, number];

export interface ReturnNoteLine {
  name: string;
  unit: string;
  quantity: number;
  /** Stored line money — already prorated server-side; printed as stored. */
  taxableAmount: number;
  taxAmount: number;
  grossAmount: number;
}

export interface ReturnNotePdfInput {
  kind: "sales" | "purchase";
  issuer: InvoiceIssuer;
  logoDataUrl?: string | null;
  returnNumber: string;
  returnDate: string;
  /** The invoice (sales) or vendor bill (purchase) the return is against. */
  againstNumber: string;
  /** Credit note (sales) / debit note (purchase) number, when one exists. */
  noteNumber: string | null;
  /** Sales only: 'credit_note' | 'cash'. */
  refundMode: string | null;
  partyLabel: string;      // "Returned By" / "Returned To"
  partyName: string;
  reason: string | null;
  lines: ReturnNoteLine[];
  subtotal: number;
  taxTotal: number;
  totalAmount: number;
  locationName: string | null;
  recordedBy: string | null;
  recordedAt: string | null;
}

function fmtDate(v: string | null | undefined): string {
  if (!v) return "—";
  try {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return String(v);
    return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  } catch { return String(v); }
}

export async function generateReturnNotePdf(data: ReturnNotePdfInput): Promise<Buffer> {
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait", compress: true });
  await registerFonts(doc);

  const PW = 210, PH = 297, M = 12, CW = PW - M * 2;
  const isSales = data.kind === "sales";
  // Same accents as the notes these settle through (see journalVoucherPdf).
  const ACCENT: RGB = isSales ? [22, 101, 52] : [141, 63, 21];
  const SOFT: RGB = isSales ? [240, 250, 244] : [250, 244, 239];
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
  const line = (x1: number, y1: number, x2: number, y2: number, rgb: RGB = BORDER, lw = 0.2) => {
    doc.setDrawColor(rgb[0], rgb[1], rgb[2]); doc.setLineWidth(lw); doc.line(x1, y1, x2, y2);
  };
  const wrap = (s: string, w: number, size: number, bold = false): string[] => {
    doc.setFont(FONT, bold ? "bold" : "normal");
    doc.setFontSize(size);
    return doc.splitTextToSize(s || "", w) as string[];
  };
  const money = (n: number) =>
    `\u20B9${Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const qtyFmt = (n: number) => {
    const r = Math.round(n * 1000) / 1000;
    return Number.isInteger(r) ? String(r) : String(r);
  };

  // ── Header ────────────────────────────────────────────────────────────────
  const metaRows: Array<[string, string]> = [
    ["Return No.", data.returnNumber || "—"],
    ["Return Date", fmtDate(data.returnDate)],
    [isSales ? "Against Invoice" : "Against Bill", data.againstNumber || "—"],
  ];
  if (data.noteNumber) metaRows.push([isSales ? "Credit Note" : "Debit Note", data.noteNumber]);
  if (isSales) {
    metaRows.push(["Settlement", data.refundMode === "cash" ? "Cash Refund" : "Credit Note"]);
  }
  if (data.locationName && data.locationName !== data.issuer.tradeName) {
    metaRows.push(["Location", data.locationName]);
  }

  let y = drawLetterhead(doc, {
    issuer: data.issuer,
    logoDataUrl: data.logoDataUrl,
    badgeTitle: isSales ? "SALES RETURN" : "PURCHASE RETURN",
    accent: ACCENT,
    metaRows,
    margin: M,
  });

  // ── Party strip ───────────────────────────────────────────────────────────
  fillRect(M, y, CW, 9, SOFT);
  doc.setDrawColor(BORDER[0], BORDER[1], BORDER[2]); doc.setLineWidth(0.2); doc.rect(M, y, CW, 9);
  txt(data.partyLabel, M + 3, y + 5.8, { size: 7.6, color: MUT });
  cell(data.partyName || "—", M + 34, y + 5.8, CW - 40, { size: 8.8, bold: true, color: INK });
  y += 12;

  // ── Lines — # | Item | Qty | Unit | Taxable | GST | Total ────────────────
  const C_NO = 8, C_QTY = 18, C_UNIT = 14, C_AMT = 27;
  const C_NAME = CW - C_NO - C_QTY - C_UNIT - C_AMT * 3;
  const xNo = M, xName = xNo + C_NO, xQty = xName + C_NAME, xUnit = xQty + C_QTY,
        xTaxable = xUnit + C_UNIT, xGst = xTaxable + C_AMT, xTotal = xGst + C_AMT;

  const drawTableHead = () => {
    fillRect(M, y, CW, 8, ACCENT);
    txt("#", xNo + 2, y + 5.4, { size: 8, bold: true, color: WHITE });
    txt("ITEM", xName + 2, y + 5.4, { size: 8, bold: true, color: WHITE });
    txt("QTY", xQty + C_QTY - 2, y + 5.4, { size: 8, bold: true, align: "right", color: WHITE });
    txt("UNIT", xUnit + 2, y + 5.4, { size: 8, bold: true, color: WHITE });
    txt("TAXABLE", xTaxable + C_AMT - 2, y + 5.4, { size: 8, bold: true, align: "right", color: WHITE });
    txt("GST", xGst + C_AMT - 2, y + 5.4, { size: 8, bold: true, align: "right", color: WHITE });
    txt("TOTAL", xTotal + C_AMT - 2, y + 5.4, { size: 8, bold: true, align: "right", color: WHITE });
    y += 8;
  };
  drawTableHead();

  const genNote = `This is a computer-generated ${isSales ? "sales" : "purchase"} return note.`;
  data.lines.forEach((l, i) => {
    if (y > PH - 70) {
      drawGeneratedNote(doc, genNote, M);
      doc.addPage();
      y = M + 4;
      drawTableHead();
    }
    if (i % 2 === 1) fillRect(M, y, CW, 8, SOFT);
    doc.setDrawColor(BORDER[0], BORDER[1], BORDER[2]); doc.setLineWidth(0.2); doc.rect(M, y, CW, 8);
    txt(String(i + 1), xNo + 2, y + 5.3, { size: 8, color: MUT });
    cell(l.name || "—", xName + 2, y + 5.3, C_NAME - 4, { size: 8.4, bold: true, color: INK });
    txt(qtyFmt(l.quantity), xQty + C_QTY - 2, y + 5.3, { size: 8.4, align: "right", color: INK });
    cell(l.unit || "", xUnit + 2, y + 5.3, C_UNIT - 4, { size: 7.6, color: MUT });
    txt(money(l.taxableAmount), xTaxable + C_AMT - 2, y + 5.3, { size: 8.2, align: "right", color: INK });
    txt(money(l.taxAmount), xGst + C_AMT - 2, y + 5.3, { size: 8.2, align: "right", color: INK });
    txt(money(l.grossAmount), xTotal + C_AMT - 2, y + 5.3, { size: 8.2, align: "right", color: INK });
    y += 8;
  });

  // ── Totals band — stored totals, never re-summed ─────────────────────────
  fillRect(M, y, CW, 11, ACCENT);
  txt("TOTAL", M + 4, y + 7.4, { size: 10, bold: true, color: WHITE });
  txt(money(data.subtotal), xTaxable + C_AMT - 2, y + 7.4, { size: 9.5, bold: true, align: "right", color: WHITE });
  txt(money(data.taxTotal), xGst + C_AMT - 2, y + 7.4, { size: 9.5, bold: true, align: "right", color: WHITE });
  txt(money(data.totalAmount), xTotal + C_AMT - 2, y + 7.4, { size: 10.5, bold: true, align: "right", color: WHITE });
  y += 14;

  // Amount in words.
  const wordLines = wrap(amountInWords(data.totalAmount), CW - 40, 7.8, true).slice(0, 3);
  const wh = Math.max(9, wordLines.length * 3.9 + 4.5);
  fillRect(M, y, CW, wh, SOFT);
  doc.setDrawColor(BORDER[0], BORDER[1], BORDER[2]); doc.setLineWidth(0.2); doc.rect(M, y, CW, wh);
  txt("Amount in Words", M + 3, y + 5.8, { size: 7.2, color: MUT });
  wordLines.forEach((l, i) => txt(l, M + 36, y + 5.8 + i * 3.9, { size: 7.8, bold: true, color: INK }));
  y += wh;

  // Reason — capped so the signatures never collide with the footer.
  const reason = (data.reason || "—").trim();
  const allR = wrap(reason, CW - 64, 7.6);
  const rLines = allR.slice(0, 8);
  if (allR.length > 8) rLines[7] = `${rLines[7]}\u2026`;
  const rh = Math.max(9, rLines.length * 3.8 + 4.5);
  doc.setDrawColor(BORDER[0], BORDER[1], BORDER[2]); doc.setLineWidth(0.2); doc.rect(M, y, CW, rh);
  txt("Reason", M + 3, y + 5.8, { size: 7.6, color: MUT });
  rLines.forEach((l, i) => txt(l, M + 58, y + 5.8 + i * 3.8, { size: 7.6, color: INK }));
  y += rh + 6;

  // ── Audit trail ───────────────────────────────────────────────────────────
  const trail = [
    data.recordedBy ? `Recorded by: ${data.recordedBy}` : "",
    data.recordedAt ? `Recorded on: ${fmtDate(data.recordedAt)}` : "",
  ].filter(Boolean).join("      ");
  if (trail) { txt(trail, M, y, { size: 7, color: MUT }); y += 8; }

  // ── Signatures ────────────────────────────────────────────────────────────
  y = Math.min(Math.max(y, 235), PH - 30);
  drawSignatureRow(
    doc,
    isSales
      ? ["Received By", "Authorized Signatory", "Customer's Signature"]
      : ["Prepared By", "Authorized Signatory", "Vendor's Acknowledgement"],
    y, M, CW,
  );

  drawGeneratedNote(doc, genNote, M);

  return Buffer.from(doc.output("arraybuffer"));
}
