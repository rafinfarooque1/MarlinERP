/**
 * Receipt / Payment voucher PDF — jsPDF, A4 portrait.
 *
 * The formal instrument for money received or paid outside the sale/purchase
 * documents: who the money came from or went to, which cash box or bank it
 * touched, the reference, and the signatures. The account itself is the
 * instrument — no separate "mode" is printed. Rendered only from the stored
 * row (never client JSON) so the print can never disagree with the books.
 *
 * Styled to match the tax invoice: the ISSUING LOCATION (warehouse/outlet) is
 * the letterhead, exactly as it is the seller on an invoice — company settings
 * only ever appear through the issuer's own fallback rules. Receipts keep the
 * green accent, payments the house navy, so the two kinds are told apart in a
 * stack of printouts without reading a word.
 */
import { jsPDF } from "jspdf";
import { FONT, registerFonts, drawLetterhead } from "@workspace/pdf-kit";
import type { InvoiceIssuer } from "../lib/billingProfile";

type RGB = [number, number, number];

export interface MoneyVoucherPdfInput {
  kind: "receipt" | "payment";
  /** The issuing location's identity — same resolution as the invoice seller. */
  issuer: InvoiceIssuer;
  /** Company logo as a data URI, or null for the lettermark fallback. */
  logoDataUrl?: string | null;
  voucherNumber: string;
  voucherDate: string;
  amount: number;
  /** Counterparty ledger (the Cr leg on a receipt, the Dr leg on a payment). */
  partyName: string;
  /** Cash/bank ledger (the Dr leg on a receipt, the Cr leg on a payment). */
  cashBankName: string;
  referenceNumber: string | null;
  narration: string | null;
  locationName: string;
  recordedBy: string | null;
  recordedAt: string | null;
}

/** Amount in words — a voucher without it is not a complete instrument. */
function amountInWords(value: number): string {
  const n = Math.floor(Math.abs(value));
  if (n === 0) return "Zero Rupees Only";
  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
    "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
    "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  const two = (x: number): string =>
    x < 20 ? ones[x] : `${tens[Math.floor(x / 10)]}${x % 10 ? " " + ones[x % 10] : ""}`;
  const three = (x: number): string =>
    x >= 100 ? `${ones[Math.floor(x / 100)]} Hundred${x % 100 ? " " + two(x % 100) : ""}` : two(x);

  const parts: string[] = [];
  const crore = Math.floor(n / 10000000);
  const lakh = Math.floor((n % 10000000) / 100000);
  const thousand = Math.floor((n % 100000) / 1000);
  const rest = n % 1000;
  if (crore) parts.push(`${three(crore)} Crore`);
  if (lakh) parts.push(`${three(lakh)} Lakh`);
  if (thousand) parts.push(`${three(thousand)} Thousand`);
  if (rest) parts.push(three(rest));

  const paise = Math.round((Math.abs(value) - n) * 100);
  const rupees = `${parts.join(" ")} Rupees`;
  return paise > 0 ? `${rupees} and ${two(paise)} Paise Only` : `${rupees} Only`;
}

function fmtDate(v: string | null | undefined): string {
  if (!v) return "—";
  try {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return String(v);
    return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  } catch { return String(v); }
}

export async function generateMoneyVoucherPdf(data: MoneyVoucherPdfInput): Promise<Buffer> {
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait", compress: true });
  await registerFonts(doc);

  const PW = 210, M = 12, CW = PW - M * 2;
  const isReceipt = data.kind === "receipt";
  // Receipt green / payment navy — matched to the invoice's tonal system.
  const ACCENT: RGB = isReceipt ? [22, 101, 52] : [23, 42, 92];
  const SOFT:   RGB = isReceipt ? [240, 250, 244] : [242, 245, 251];
  const INK:    RGB = [32, 44, 74];
  const MUT:    RGB = [104, 116, 140];
  const BORDER: RGB = [201, 213, 229];
  const WHITE:  RGB = [255, 255, 255];

  const txt = (
    s: string, x: number, y: number,
    o: { size?: number; bold?: boolean; align?: "left" | "center" | "right"; color?: RGB; maxWidth?: number } = {},
  ) => {
    doc.setFont(FONT, o.bold ? "bold" : "normal");
    doc.setFontSize(o.size ?? 9);
    const c = o.color ?? INK;
    doc.setTextColor(c[0], c[1], c[2]);
    const tOpts: { align?: "left" | "center" | "right"; maxWidth?: number } = {};
    if (o.align) tOpts.align = o.align;
    if (o.maxWidth) tOpts.maxWidth = o.maxWidth;
    doc.text(s, x, y, tOpts);
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
  const rfill = (x: number, y: number, w: number, h: number, rgb: RGB, r = 1.2) => {
    doc.setFillColor(rgb[0], rgb[1], rgb[2]); doc.roundedRect(x, y, w, h, r, r, "F");
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

  const issuer = data.issuer;
  let y = M + 2;

  // ══════════════════════════════════════════════════════════════════════════
  // 1. HEADER — the shared letterhead (logo + issuing-location identity left,
  //    badge + meta right), so every document prints the same masthead.
  // ══════════════════════════════════════════════════════════════════════════
  const metaRows: Array<[string, string]> = [
    ["Voucher No.", data.voucherNumber || "—"],
    ["Voucher Date", fmtDate(data.voucherDate)],
  ];
  // Which branch raised it — only worth a line when the location is named
  // something other than the letterhead above.
  if (data.locationName && data.locationName !== issuer.tradeName) {
    metaRows.push(["Location", data.locationName]);
  }
  if (data.referenceNumber) metaRows.push(["Reference", data.referenceNumber]);

  y = drawLetterhead(doc, {
    issuer,
    logoDataUrl: data.logoDataUrl,
    badgeTitle: isReceipt ? "RECEIPT VOUCHER" : "PAYMENT VOUCHER",
    accent: ACCENT,
    metaRows,
    margin: M,
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2. PARTICULARS — Dr first, Cr second: the double-entry order an auditor
  //    expects. The amount rides the first (Dr) row.
  // ══════════════════════════════════════════════════════════════════════════
  fillRect(M, y, CW, 8, ACCENT);
  txt("PARTICULARS", M + 3, y + 5.4, { size: 8, bold: true, color: WHITE });
  txt("AMOUNT", M + CW - 3, y + 5.4, { size: 8, bold: true, align: "right", color: WHITE });
  y += 8;

  const rows: Array<[string, string]> = isReceipt
    ? [
        ["Received Into (Debit)", data.cashBankName || "—"],
        ["Received From (Credit)", data.partyName || "—"],
      ]
    : [
        ["Paid To (Debit)", data.partyName || "—"],
        ["Paid From (Credit)", data.cashBankName || "—"],
      ];
  rows.forEach(([label, value], i) => {
    if (i % 2 === 1) fillRect(M, y, CW, 9, SOFT);
    doc.setDrawColor(BORDER[0], BORDER[1], BORDER[2]); doc.setLineWidth(0.2); doc.rect(M, y, CW, 9);
    txt(label, M + 3, y + 5.8, { size: 7.6, color: MUT });
    cell(value, M + 58, y + 5.8, CW - 100, { size: 8.6, bold: true, color: INK });
    if (i === 0) txt(money(data.amount), M + CW - 3, y + 5.8, { size: 8.6, bold: true, align: "right", color: INK });
    y += 9;
  });

  // Narration — wrapped so a long note is readable, but capped: a voucher is a
  // one-page instrument, and an unbounded note would push the signature block
  // into the footer. Ten lines is ~600 characters; beyond that it ellipsizes.
  const narration = (data.narration || "—").trim();
  const allNLines = wrap(narration, CW - 64, 7.6);
  const nLines = allNLines.slice(0, 10);
  if (allNLines.length > 10) nLines[9] = `${nLines[9]}\u2026`;
  const nh = Math.max(9, nLines.length * 3.8 + 4.5);
  doc.setDrawColor(BORDER[0], BORDER[1], BORDER[2]); doc.setLineWidth(0.2); doc.rect(M, y, CW, nh);
  txt("Narration", M + 3, y + 5.8, { size: 7.6, color: MUT });
  nLines.forEach((l, i) => txt(l, M + 58, y + 5.8 + i * 3.8, { size: 7.6, color: INK }));
  y += nh;

  // ── Total band ────────────────────────────────────────────────────────────
  fillRect(M, y, CW, 12, ACCENT);
  txt("TOTAL", M + 4, y + 8, { size: 10, bold: true, color: WHITE });
  txt(money(data.amount), M + CW - 4, y + 8, { size: 12.5, bold: true, align: "right", color: WHITE });
  y += 15;

  // Amount in words — boxed like the invoice's words strip. Three lines holds
  // any representable amount; the cap only guards the fixed layout below.
  const wordLines = wrap(amountInWords(data.amount), CW - 40, 7.8, true).slice(0, 3);
  const wh = Math.max(9, wordLines.length * 3.9 + 4.5);
  fillRect(M, y, CW, wh, SOFT);
  doc.setDrawColor(BORDER[0], BORDER[1], BORDER[2]); doc.setLineWidth(0.2); doc.rect(M, y, CW, wh);
  txt("Amount in Words", M + 3, y + 5.8, { size: 7.2, color: MUT });
  wordLines.forEach((l, i) => txt(l, M + 36, y + 5.8 + i * 3.9, { size: 7.8, bold: true, color: INK }));
  y += wh + 6;

  // ── Audit trail ───────────────────────────────────────────────────────────
  const trail = [
    data.recordedBy ? `Recorded by: ${data.recordedBy}` : "",
    data.recordedAt ? `Recorded on: ${fmtDate(data.recordedAt)}` : "",
  ].filter(Boolean).join("      ");
  if (trail) { txt(trail, M, y, { size: 7, color: MUT }); y += 8; }

  // ── Signatures ────────────────────────────────────────────────────────────
  y = Math.max(y, 235);
  const sigW = CW / 3;
  const sigs = isReceipt
    ? ["Received By", "Authorized Signatory", "Payer's Signature"]
    : ["Prepared By", "Authorized Signatory", "Received By"];
  sigs.forEach((label, i) => {
    const x = M + sigW * i;
    line(x + 6, y + 12, x + sigW - 6, y + 12, [120, 130, 150], 0.25);
    txt(label, x + sigW / 2, y + 16, { size: 7, align: "center", color: MUT });
  });

  // Footer rule + computer-generated note, per the invoice.
  line(M, 285, M + CW, 285, BORDER, 0.3);
  txt("This is a computer-generated voucher.", PW / 2, 289, { size: 6.6, align: "center", color: MUT });

  return Buffer.from(doc.output("arraybuffer"));
}
