/**
 * Receipt / Payment voucher PDF — jsPDF, A4 portrait.
 *
 * The formal instrument for money received or paid outside the sale/purchase
 * documents: who the money came from or went to, which cash box or bank it
 * touched, the mode and reference, and the signatures. Rendered only from the
 * stored row (never client JSON) so the print can never disagree with the
 * books.
 */
import { jsPDF } from "jspdf";

type RGB = [number, number, number];

export interface MoneyVoucherPdfInput {
  kind: "receipt" | "payment";
  cs?: {
    companyName?: string;
    address?: string; city?: string; state?: string; pincode?: string;
    gstNumber?: string; phone?: string; email?: string;
  };
  voucherNumber: string;
  voucherDate: string;
  amount: number;
  /** Counterparty ledger (the Cr leg on a receipt, the Dr leg on a payment). */
  partyName: string;
  /** Cash/bank ledger (the Dr leg on a receipt, the Cr leg on a payment). */
  cashBankName: string;
  paymentMode: string | null;
  referenceNumber: string | null;
  narration: string | null;
  locationName: string;
  recordedBy: string | null;
  recordedAt: string | null;
  attachmentUrl: string | null;
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

const MODE_LABELS: Record<string, string> = {
  cash: "Cash", upi: "UPI", bank: "Bank Transfer", card: "Card",
  cheque: "Cheque", neft: "NEFT", rtgs: "RTGS",
};

export function generateMoneyVoucherPdf(data: MoneyVoucherPdfInput): Buffer {
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
  const PW = 210, M = 14, CW = PW - M * 2;
  const isReceipt = data.kind === "receipt";
  // Receipts in green, payments in the house navy — tells the two apart in a
  // stack of printouts without reading a word.
  const ACCENT: RGB = isReceipt ? [22, 101, 52] : [25, 72, 140];
  const ACCENT_SOFT: RGB = isReceipt ? [240, 250, 244] : [240, 244, 255];

  const txt = (
    s: string, x: number, y: number,
    o: { size?: number; bold?: boolean; align?: "left" | "center" | "right"; color?: RGB } = {},
  ) => {
    doc.setFontSize(o.size ?? 9);
    doc.setFont("helvetica", o.bold ? "bold" : "normal");
    const c = o.color ?? [0, 0, 0];
    doc.setTextColor(c[0], c[1], c[2]);
    doc.text(s, x, y, { align: o.align ?? "left" });
  };
  const fillRect = (x: number, y: number, w: number, h: number, rgb: RGB) => {
    doc.setFillColor(rgb[0], rgb[1], rgb[2]); doc.rect(x, y, w, h, "F");
  };
  const outlineRect = (x: number, y: number, w: number, h: number, lw = 0.3) => {
    doc.setDrawColor(0); doc.setLineWidth(lw); doc.rect(x, y, w, h);
  };
  const vline = (x: number, y1: number, y2: number) => {
    doc.setDrawColor(200); doc.setLineWidth(0.2); doc.line(x, y1, x, y2);
  };
  const money = (n: number) =>
    `Rs. ${Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  let y = M;

  // ── Header ────────────────────────────────────────────────────────────────
  fillRect(M, y, CW, 16, ACCENT);
  txt(data.cs?.companyName || "Company", PW / 2, y + 7, { size: 13, bold: true, align: "center", color: [255, 255, 255] });
  const addr = [data.cs?.address, data.cs?.city, data.cs?.state, data.cs?.pincode].filter(Boolean).join(", ");
  if (addr) txt(addr, PW / 2, y + 11.5, { size: 6.5, align: "center", color: [220, 235, 225] });
  const contact = [
    data.cs?.gstNumber ? `GSTIN: ${data.cs.gstNumber}` : "",
    data.cs?.phone ? `Ph: ${data.cs.phone}` : "",
    data.cs?.email || "",
  ].filter(Boolean).join("   ");
  if (contact) txt(contact, PW / 2, y + 15, { size: 6.5, align: "center", color: [220, 235, 225] });
  y += 19;

  txt(isReceipt ? "RECEIPT VOUCHER" : "PAYMENT VOUCHER", PW / 2, y, { size: 11, bold: true, align: "center", color: ACCENT });
  y += 5;

  // ── Voucher meta ──────────────────────────────────────────────────────────
  outlineRect(M, y, CW, 18);
  vline(M + CW / 2, y, y + 18);
  txt("Voucher No.", M + 3, y + 5, { size: 6.5, color: [100, 100, 100] });
  txt(data.voucherNumber || "—", M + 3, y + 11, { size: 10, bold: true });
  txt(`Location: ${data.locationName || "—"}`, M + 3, y + 16, { size: 7, color: [80, 80, 80] });

  txt("Date", M + CW / 2 + 3, y + 5, { size: 6.5, color: [100, 100, 100] });
  txt(fmtDate(data.voucherDate), M + CW / 2 + 3, y + 11, { size: 10, bold: true });
  const modeLabel = data.paymentMode ? (MODE_LABELS[data.paymentMode] ?? data.paymentMode) : null;
  const modeLine = [
    modeLabel ? `Mode: ${modeLabel}` : "",
    data.referenceNumber ? `Ref: ${data.referenceNumber}` : "",
  ].filter(Boolean).join("   ");
  if (modeLine) txt(modeLine, M + CW / 2 + 3, y + 16, { size: 7, color: [80, 80, 80] });
  y += 21;

  // ── Detail table ──────────────────────────────────────────────────────────
  fillRect(M, y, CW, 7, ACCENT_SOFT);
  outlineRect(M, y, CW, 7, 0.2);
  txt("PARTICULARS", M + 3, y + 5, { size: 7.5, bold: true, color: ACCENT });
  txt("AMOUNT", M + CW - 3, y + 5, { size: 7.5, bold: true, align: "right", color: ACCENT });
  y += 7;

  // Dr first, Cr second — the double-entry order an auditor expects.
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
    if (i % 2 === 1) fillRect(M, y, CW, 8, [248, 250, 252]);
    doc.setDrawColor(220); doc.setLineWidth(0.2); doc.rect(M, y, CW, 8);
    txt(label, M + 3, y + 5.5, { size: 7.5, color: [90, 90, 90] });
    txt(value, M + 62, y + 5.5, { size: 8, bold: true });
    if (i === 0) txt(money(data.amount), M + CW - 3, y + 5.5, { size: 8, bold: true, align: "right" });
    y += 8;
  });

  // Narration — wrapped, so a long note is fully readable rather than clipped.
  const narration = (data.narration || "—").trim();
  doc.setFontSize(7.5); doc.setFont("helvetica", "normal");
  const lines = doc.splitTextToSize(narration, CW - 66) as string[];
  const nh = Math.max(8, lines.length * 3.6 + 4);
  doc.setDrawColor(220); doc.setLineWidth(0.2); doc.rect(M, y, CW, nh);
  txt("Narration", M + 3, y + 5.5, { size: 7.5, color: [90, 90, 90] });
  lines.forEach((ln, i) => txt(ln, M + 62, y + 5.5 + i * 3.6, { size: 7.5 }));
  y += nh;

  // ── Total ─────────────────────────────────────────────────────────────────
  fillRect(M, y, CW, 12, ACCENT);
  outlineRect(M, y, CW, 12, 0.5);
  txt("TOTAL", M + 4, y + 8, { size: 10, bold: true, color: [255, 255, 255] });
  txt(money(data.amount), M + CW - 4, y + 8, { size: 12, bold: true, align: "right", color: [255, 235, 160] });
  y += 15;

  txt(`Amount in words: ${amountInWords(data.amount)}`, M, y, { size: 7.5, bold: true, color: [60, 60, 60] });
  y += 8;

  // ── Supporting document ───────────────────────────────────────────────────
  outlineRect(M, y, CW, 10, 0.2);
  txt("Supporting document", M + 3, y + 4, { size: 6.5, color: [100, 100, 100] });
  txt(
    data.attachmentUrl ? "Attached in the system against this voucher" : "Not attached",
    M + 3, y + 8,
    { size: 7.5, bold: true, color: data.attachmentUrl ? [22, 130, 74] : [180, 100, 0] },
  );
  y += 13;

  // ── Audit trail ───────────────────────────────────────────────────────────
  const trail = [
    data.recordedBy ? `Recorded by: ${data.recordedBy}` : "",
    data.recordedAt ? `Recorded on: ${fmtDate(data.recordedAt)}` : "",
  ].filter(Boolean).join("      ");
  if (trail) { txt(trail, M, y, { size: 7, color: [110, 110, 110] }); y += 8; }

  // ── Signatures ────────────────────────────────────────────────────────────
  y = Math.max(y, 235);
  const sigW = CW / 3;
  const sigs = isReceipt
    ? ["Received By", "Authorized Signatory", "Payer's Signature"]
    : ["Prepared By", "Authorized Signatory", "Received By"];
  sigs.forEach((label, i) => {
    const x = M + sigW * i;
    doc.setDrawColor(120); doc.setLineWidth(0.2);
    doc.line(x + 4, y + 12, x + sigW - 4, y + 12);
    txt(label, x + sigW / 2, y + 16, { size: 7, align: "center", color: [90, 90, 90] });
  });

  return Buffer.from(doc.output("arraybuffer"));
}
