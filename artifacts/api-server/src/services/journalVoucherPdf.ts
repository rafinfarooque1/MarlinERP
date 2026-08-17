/**
 * Journal-family voucher PDF — jsPDF, A4 portrait.
 *
 * The formal print of a journal voucher, contra voucher, credit note or debit
 * note: every ledger leg with its debit/credit, the balanced totals, the
 * narration and the signatures. Rendered only from the stored row and its
 * lines (never client JSON) so the print can never disagree with the books.
 *
 * Shares the letterhead with the invoice and money vouchers: the ISSUING
 * LOCATION is the masthead (manual vouchers are stamped 'headoffice' at
 * creation, so those print under the Head Office identity via the company
 * fallback). Each kind keeps its own accent so a stack of printouts is
 * told apart at a glance: journal navy, contra teal, credit note green,
 * debit note umber.
 */
import { jsPDF } from "jspdf";
import {
  FONT, registerFonts, drawLetterhead, drawSignatureRow, drawGeneratedNote,
  amountInWords,
} from "@workspace/pdf-kit";
import type { InvoiceIssuer } from "../lib/billingProfile";

type RGB = [number, number, number];

export type JournalVoucherKind = "journal" | "contra" | "credit_note" | "debit_note";

export interface JournalVoucherLine {
  ledgerName: string;
  ledgerCode: string | null;
  debit: number;
  credit: number;
}

export interface JournalVoucherPdfInput {
  kind: JournalVoucherKind;
  /** The issuing location's identity — same resolution as the invoice seller. */
  issuer: InvoiceIssuer;
  /** Letterhead logo as a data URI, or null for the lettermark fallback. */
  logoDataUrl?: string | null;
  voucherNumber: string;
  voucherDate: string;
  /** Credit/debit notes carry the counterparty; null on journals/contras. */
  partyName: string | null;
  /** Credit/debit notes carry a reason; null on journals/contras. */
  reason: string | null;
  narration: string | null;
  lines: JournalVoucherLine[];
  locationName: string | null;
  recordedBy: string | null;
  recordedAt: string | null;
}

const TITLES: Record<JournalVoucherKind, string> = {
  journal: "JOURNAL VOUCHER",
  contra: "CONTRA VOUCHER",
  credit_note: "CREDIT NOTE",
  debit_note: "DEBIT NOTE",
};

const ACCENTS: Record<JournalVoucherKind, RGB> = {
  journal: [23, 42, 92],      // house navy — matches the payment voucher
  contra: [14, 85, 105],      // teal — internal money movement
  credit_note: [22, 101, 52], // green — matches the receipt voucher
  debit_note: [141, 63, 21],  // umber — the "we are owed" document
};

const SOFTS: Record<JournalVoucherKind, RGB> = {
  journal: [242, 245, 251],
  contra: [240, 247, 249],
  credit_note: [240, 250, 244],
  debit_note: [250, 244, 239],
};

function fmtDate(v: string | null | undefined): string {
  if (!v) return "—";
  try {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return String(v);
    return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  } catch { return String(v); }
}

export async function generateJournalVoucherPdf(data: JournalVoucherPdfInput): Promise<Buffer> {
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait", compress: true });
  await registerFonts(doc);

  const PW = 210, PH = 297, M = 12, CW = PW - M * 2;
  const ACCENT = ACCENTS[data.kind];
  const SOFT = SOFTS[data.kind];
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
  /** Shrink a one-line cell until it fits — never draw over a neighbour. */
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
  // Real rupee sign — safe because the TrueType face is embedded.
  const money = (n: number) =>
    `\u20B9${Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  // ── Header ────────────────────────────────────────────────────────────────
  const metaRows: Array<[string, string]> = [
    ["Voucher No.", data.voucherNumber || "—"],
    ["Voucher Date", fmtDate(data.voucherDate)],
  ];
  if (data.locationName && data.locationName !== data.issuer.tradeName) {
    metaRows.push(["Location", data.locationName]);
  }
  if (data.partyName) metaRows.push(["Party", data.partyName]);

  let y = drawLetterhead(doc, {
    issuer: data.issuer,
    logoDataUrl: data.logoDataUrl,
    badgeTitle: TITLES[data.kind],
    accent: ACCENT,
    metaRows,
    margin: M,
  });

  // ── Ledger legs — Particulars | Debit | Credit ────────────────────────────
  const AMT_W = 34;                 // each amount column
  const nameW = CW - AMT_W * 2;
  const drawTableHead = () => {
    fillRect(M, y, CW, 8, ACCENT);
    txt("PARTICULARS", M + 3, y + 5.4, { size: 8, bold: true, color: WHITE });
    txt("DEBIT", M + nameW + AMT_W - 3, y + 5.4, { size: 8, bold: true, align: "right", color: WHITE });
    txt("CREDIT", M + CW - 3, y + 5.4, { size: 8, bold: true, align: "right", color: WHITE });
    y += 8;
  };
  drawTableHead();

  // Debit legs first, credit legs after — the double-entry order an auditor
  // expects, with "To " prefixed on credit legs per Indian convention.
  const legs = [
    ...data.lines.filter((l) => l.debit > 0 || (l.debit === 0 && l.credit === 0)),
    ...data.lines.filter((l) => l.credit > 0),
  ];
  let totalDr = 0, totalCr = 0;
  legs.forEach((l, i) => {
    // Room for the row + totals + words + signatures; spill to a fresh page.
    if (y > PH - 60) {
      drawGeneratedNote(doc, `This is a computer-generated ${TITLES[data.kind].toLowerCase()}.`, M);
      doc.addPage();
      y = M + 4;
      drawTableHead();
    }
    const isCredit = l.credit > 0;
    if (i % 2 === 1) fillRect(M, y, CW, 8, SOFT);
    doc.setDrawColor(BORDER[0], BORDER[1], BORDER[2]); doc.setLineWidth(0.2); doc.rect(M, y, CW, 8);
    const name = isCredit ? `To  ${l.ledgerName}` : l.ledgerName;
    cell(name, M + (isCredit ? 9 : 3), y + 5.3, nameW - (isCredit ? 13 : 7), { size: 8.4, bold: !isCredit, color: INK });
    if (l.debit > 0) txt(money(l.debit), M + nameW + AMT_W - 3, y + 5.3, { size: 8.4, align: "right", color: INK });
    if (l.credit > 0) txt(money(l.credit), M + CW - 3, y + 5.3, { size: 8.4, align: "right", color: INK });
    totalDr += l.debit;
    totalCr += l.credit;
    y += 8;
  });

  // ── Totals band ───────────────────────────────────────────────────────────
  fillRect(M, y, CW, 11, ACCENT);
  txt("TOTAL", M + 4, y + 7.4, { size: 10, bold: true, color: WHITE });
  txt(money(totalDr), M + nameW + AMT_W - 3, y + 7.4, { size: 10.5, bold: true, align: "right", color: WHITE });
  txt(money(totalCr), M + CW - 3, y + 7.4, { size: 10.5, bold: true, align: "right", color: WHITE });
  y += 14;

  // Amount in words — on the debit total (equal to the credit total by
  // construction; the books refuse an unbalanced voucher).
  const wordLines = wrap(amountInWords(totalDr), CW - 40, 7.8, true).slice(0, 3);
  const wh = Math.max(9, wordLines.length * 3.9 + 4.5);
  fillRect(M, y, CW, wh, SOFT);
  doc.setDrawColor(BORDER[0], BORDER[1], BORDER[2]); doc.setLineWidth(0.2); doc.rect(M, y, CW, wh);
  txt("Amount in Words", M + 3, y + 5.8, { size: 7.2, color: MUT });
  wordLines.forEach((l, i) => txt(l, M + 36, y + 5.8 + i * 3.9, { size: 7.8, bold: true, color: INK }));
  y += wh;

  // Reason (credit/debit notes) and narration — wrapped, capped so the
  // signature block never collides with the footer.
  const noteRows: Array<[string, string]> = [];
  if (data.reason?.trim()) noteRows.push(["Reason", data.reason.trim()]);
  noteRows.push(["Narration", (data.narration || "—").trim()]);
  for (const [label, text] of noteRows) {
    const all = wrap(text, CW - 64, 7.6);
    const rows = all.slice(0, 8);
    if (all.length > 8) rows[7] = `${rows[7]}\u2026`;
    const nh = Math.max(9, rows.length * 3.8 + 4.5);
    doc.setDrawColor(BORDER[0], BORDER[1], BORDER[2]); doc.setLineWidth(0.2); doc.rect(M, y, CW, nh);
    txt(label, M + 3, y + 5.8, { size: 7.6, color: MUT });
    rows.forEach((l, i) => txt(l, M + 58, y + 5.8 + i * 3.8, { size: 7.6, color: INK }));
    y += nh;
  }
  y += 6;

  // ── Audit trail ───────────────────────────────────────────────────────────
  const trail = [
    data.recordedBy ? `Recorded by: ${data.recordedBy}` : "",
    data.recordedAt ? `Recorded on: ${fmtDate(data.recordedAt)}` : "",
  ].filter(Boolean).join("      ");
  if (trail) { txt(trail, M, y, { size: 7, color: MUT }); y += 8; }

  // ── Signatures ────────────────────────────────────────────────────────────
  // Content-driven (no fixed 235mm anchor): sits below the last printed line,
  // capped so it never collides with the fixed footer.
  // Overflowing bodies push the row to a fresh page rather than overprinting.
  y += 4;
  if (y > PH - 30) { doc.addPage(); y = 24; }
  drawSignatureRow(doc, ["Prepared By", "Checked By", "Authorized Signatory"], y, M, CW);

  drawGeneratedNote(doc, `This is a computer-generated ${TITLES[data.kind].toLowerCase()}.`, M);

  return Buffer.from(doc.output("arraybuffer"));
}
