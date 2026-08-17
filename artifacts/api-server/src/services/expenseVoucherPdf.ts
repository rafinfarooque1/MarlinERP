/**
 * Expense voucher PDF — jsPDF, A4 portrait.
 *
 * A payment voucher is the document an auditor asks for: who authorised the
 * spend, what it was for, which ledger it hit, what it was paid from, and the
 * signatures. The route assembles this from the stored row so a voucher can
 * never be printed with figures the books do not hold.
 *
 * Wears the shared letterhead: the ISSUING LOCATION is the masthead (the
 * company profile only as fallback), matching invoices and money vouchers.
 * Money-out documents use the house navy, same as payment vouchers.
 */
import { jsPDF } from "jspdf";
import {
  FONT, registerFonts, drawLetterhead, drawSignatureRow, drawGeneratedNote,
  amountInWords,
} from "@workspace/pdf-kit";
import type { InvoiceIssuer } from "../lib/billingProfile";

type RGB = [number, number, number];

export interface ExpenseVoucherPdfInput {
  issuer: InvoiceIssuer;
  logoDataUrl?: string | null;
  voucherNumber: string;
  expenseDate: string;
  amount: number;
  category: string | null;
  description: string | null;
  expenseLedgerName: string;
  paidFromName: string;
  paidFromLabel: string;
  locationName: string;
  recordedBy: string | null;
  recordedAt: string | null;
  attachmentUrl: string | null;
}

function fmtDate(v: string | null | undefined): string {
  if (!v) return "—";
  try {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return String(v);
    return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  } catch { return String(v); }
}

export async function generateExpenseVoucherPdf(data: ExpenseVoucherPdfInput): Promise<Buffer> {
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait", compress: true });
  await registerFonts(doc);

  const PW = 210, PH = 297, M = 12, CW = PW - M * 2;
  const ACCENT: RGB = [23, 42, 92];      // money-out navy, same as payment vouchers
  const SOFT: RGB = [242, 245, 252];
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
    size?: number; bold?: boolean; color?: RGB;
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
  const money = (n: number) =>
    `\u20B9${Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  // ── Header ────────────────────────────────────────────────────────────────
  const metaRows: Array<[string, string]> = [
    ["Voucher No.", data.voucherNumber || "—"],
    ["Voucher Date", fmtDate(data.expenseDate)],
  ];
  if (data.category) metaRows.push(["Category", data.category]);
  if (data.locationName && data.locationName !== data.issuer.tradeName) {
    metaRows.push(["Location", data.locationName]);
  }

  let y = drawLetterhead(doc, {
    issuer: data.issuer,
    logoDataUrl: data.logoDataUrl,
    badgeTitle: "PAYMENT VOUCHER",
    accent: ACCENT,
    metaRows,
    margin: M,
  });

  // ── Particulars table ─────────────────────────────────────────────────────
  fillRect(M, y, CW, 8, ACCENT);
  txt("PARTICULARS", M + 3, y + 5.4, { size: 8, bold: true, color: WHITE });
  txt("AMOUNT", M + CW - 3, y + 5.4, { size: 8, bold: true, align: "right", color: WHITE });
  y += 8;

  const rows: Array<[string, string]> = [
    ["Expense Account (Debit)", data.expenseLedgerName || "—"],
    [`${data.paidFromLabel} (Credit)`, data.paidFromName || "—"],
  ];
  rows.forEach(([label, value], i) => {
    if (i % 2 === 1) fillRect(M, y, CW, 9, SOFT);
    box(M, y, CW, 9);
    txt(label, M + 3, y + 5.9, { size: 7.8, color: MUT });
    cell(value, M + 64, y + 5.9, CW - 64 - 34, { size: 8.6, bold: true, color: INK });
    if (i === 0) txt(money(data.amount), M + CW - 3, y + 5.9, { size: 8.6, bold: true, align: "right" });
    y += 9;
  });

  // Narration — wrapped, so a long note is fully readable rather than clipped.
  const narration = (data.description || "—").trim();
  const nLines = wrap(narration, CW - 70, 7.8);
  const nh = Math.max(9, nLines.length * 3.8 + 4.8);
  box(M, y, CW, nh);
  txt("Narration", M + 3, y + 5.9, { size: 7.8, color: MUT });
  nLines.forEach((ln, i) => txt(ln, M + 64, y + 5.9 + i * 3.8, { size: 7.8, color: INK }));
  y += nh;

  // ── Total band ────────────────────────────────────────────────────────────
  fillRect(M, y, CW, 11, ACCENT);
  txt("TOTAL", M + 4, y + 7.4, { size: 10, bold: true, color: WHITE });
  txt(money(data.amount), M + CW - 4, y + 7.4, { size: 11, bold: true, align: "right", color: WHITE });
  y += 14;

  // Amount in words — a voucher without it is not a complete instrument.
  const wLines = wrap(amountInWords(data.amount), CW - 40, 7.8).slice(0, 3);
  const wh = Math.max(9, wLines.length * 3.9 + 4.5);
  fillRect(M, y, CW, wh, SOFT);
  box(M, y, CW, wh);
  txt("Amount in Words", M + 3, y + 5.8, { size: 7.2, color: MUT });
  wLines.forEach((l, i) => {
    doc.setFont(FONT, "bold");
    txt(l, M + 36, y + 5.8 + i * 3.9, { size: 7.8, bold: true, color: INK });
  });
  y += wh + 3;

  // ── Supporting document ───────────────────────────────────────────────────
  box(M, y, CW, 10);
  txt("Supporting bill / receipt", M + 3, y + 4.2, { size: 6.8, color: MUT });
  txt(
    data.attachmentUrl ? "Attached in the system against this voucher" : "Not attached",
    M + 3, y + 8.2,
    { size: 7.8, bold: true, color: data.attachmentUrl ? [22, 130, 74] : [180, 100, 0] },
  );
  y += 13;

  // ── Audit trail ───────────────────────────────────────────────────────────
  const trail = [
    data.recordedBy ? `Recorded by: ${data.recordedBy}` : "",
    data.recordedAt ? `Recorded on: ${fmtDate(data.recordedAt)}` : "",
  ].filter(Boolean).join("      ");
  if (trail) { txt(trail, M, y + 3, { size: 7, color: MUT }); y += 9; }

  // ── Signatures ────────────────────────────────────────────────────────────
  // Content-driven (no fixed 235mm anchor): sits below the last printed line,
  // capped so it never collides with the fixed footer.
  // Overflowing bodies push the row to a fresh page rather than overprinting.
  y += 4;
  if (y > PH - 30) { doc.addPage(); y = 24; }
  drawSignatureRow(doc, ["Prepared By", "Approved By", "Received By"], y, M, CW);

  drawGeneratedNote(doc, "This is a computer-generated payment voucher.", M);

  return Buffer.from(doc.output("arraybuffer"));
}
