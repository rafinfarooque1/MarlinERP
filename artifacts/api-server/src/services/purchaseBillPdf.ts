/**
 * Purchase Invoice PDF — jsPDF, A4 portrait, server-rendered.
 *
 * The printable form of a recorded purchase bill: goods already received,
 * priced, taxed and posted to stock and to the vendor's payable. Every figure
 * is read from the stored bill — nothing is recomputed, so the printed
 * figures are the posted figures.
 *
 * Wears the shared letterhead: the RECEIVING LOCATION's identity is the
 * masthead (per-location logo, company profile as fallback) — the same
 * identity that location's sales invoices carry. The route resolves the
 * issuer and applies LBAC; this module only draws.
 */
import { jsPDF } from "jspdf";
import {
  registerFonts, Painter, flowTable, stampFooters, amountInWords,
  inr, inGrouping, qty, dateIN,
  drawLetterhead,
  NAVY, WHITE, LGRAY, MGRAY, BORDER, TEAL,
  PW, PH, M, CW, type Col,
} from "@workspace/pdf-kit";
import type { InvoiceIssuer } from "../lib/billingProfile";

const DASH = "-";

/** Blank, null and whitespace all print as a dash. Nothing is invented. */
function val(v: unknown): string {
  const s = v == null ? "" : String(v).trim();
  return s === "" ? DASH : s;
}

/** A money cell that distinguishes "zero" from "not recorded". */
function money(v: unknown): string {
  return v == null || v === "" ? DASH : inGrouping(Number(v));
}

const TYPE_LABEL: Record<string, string> = {
  material: "Raw Material",
  raw_material: "Packing Material",
  item: "Finished Item",
};

export interface PurchaseBillPdfInput {
  issuer: InvoiceIssuer;
  logoDataUrl?: string | null;
  purchase: any;          // the loadPurchaseBillDoc shape
}

export async function generatePurchaseBillPdf(
  { issuer, logoDataUrl, purchase }: PurchaseBillPdfInput,
): Promise<{ buffer: Buffer; fileName: string }> {
  const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });
  await registerFonts(doc);
  const p = new Painter(doc);

  const lines: any[] = Array.isArray(purchase?.lineItems) ? purchase.lineItems : [];
  const docNo = `PB-${String(purchase?.id ?? 0).padStart(4, "0")}`;
  const inclusive = String(purchase?.priceMode ?? "exclusive") === "inclusive";

  // ── Totals, footed from the stored lines so the table adds up to the box ───
  const sum = (pick: (l: any) => number) =>
    Math.round(lines.reduce((a, l) => a + (Number(pick(l)) || 0), 0) * 100) / 100;
  // A line without priced fields predates pricing; re-deriving qty x rate here
  // would print a gross the posted bill never agreed to — withheld instead.
  const priced = lines.length > 0
    && lines.every(l => l.lineSubtotal != null && l.taxableValue != null);
  const grossTotal = sum(l => l.lineSubtotal ?? 0);
  const discountTotal = sum(l => l.discountAmt ?? 0);
  const taxableTotal = sum(l => l.taxableValue ?? 0);
  const cgstTotal = sum(l => l.cgst ?? 0);
  const sgstTotal = sum(l => l.sgst ?? 0);
  const igstTotal = sum(l => l.igst ?? 0);
  const taxTotal = sum(l => l.taxAmount ?? 0);
  const roundOff = Number(purchase?.roundOff ?? 0);
  const grandTotal = Number(purchase?.totalAmount ?? 0);
  // Other Purchase Charges — shown exactly as stored (never recomputed). They
  // add to what the vendor is owed, not to the goods/GST figures above.
  const otherCharges: any[] = Array.isArray(purchase?.otherCharges) ? purchase.otherCharges : [];
  const otherChargesTotal = Number(purchase?.otherChargesTotal ?? 0);
  const payableTotal = otherCharges.length > 0 ? grandTotal + otherChargesTotal : grandTotal;

  // ── Page furniture ────────────────────────────────────────────────────────
  /** Compact continuation band for pages 2+. */
  const drawContinuationBand = (): number => {
    p.fill(0, 0, PW, 20, NAVY);
    p.txt(val(issuer.tradeName), M, 8.5, { size: 10, bold: true, color: WHITE });
    p.txt("PURCHASE INVOICE (continued)", M, 14.5, { size: 6.8, color: [190, 205, 225] });
    p.txt(docNo, PW - M, 9, { size: 10, bold: true, color: WHITE, align: "right" });
    p.txt(dateIN(purchase?.purchaseDate), PW - M, 14.5,
      { size: 7, color: [190, 205, 225], align: "right" });
    return 26;
  };

  // First page: the shared letterhead — receiving location identity.
  let y = drawLetterhead(doc, {
    issuer,
    logoDataUrl,
    badgeTitle: "PURCHASE INVOICE",
    accent: NAVY,
    metaRows: [
      ["Bill No.", docNo],
      ["Bill Date", dateIN(purchase?.purchaseDate)],
    ],
    margin: M,
    width: CW,
  });

  // ── Vendor / receiving location ───────────────────────────────────────────
  const halfW = (CW - 4) / 2;
  const partyH = 27;

  const party = (x: number, title: string, rows: string[]) => {
    p.fill(x, y, halfW, 5.6, TEAL);
    p.txt(title, x + 2.5, y + 3.9, { size: 6.2, bold: true, color: WHITE });
    p.box(x, y, halfW, partyH, BORDER, 0.25);
    let ly = y + 10;
    p.txt(rows[0], x + 2.5, ly, { size: 9, bold: true });
    ly += 4.4;
    for (const r of rows.slice(1)) {
      if (!r) continue;
      for (const l of p.wrap(r, halfW - 5, 6.8).slice(0, 2)) {
        if (ly > y + partyH - 1.5) break;
        p.txt(l, x + 2.5, ly, { size: 6.8, color: [70, 80, 95] });
        ly += 3.5;
      }
    }
  };

  const vendor = purchase?.vendor ?? {};
  const vendorAddr = [vendor.address, vendor.state].filter(Boolean).join(", ");
  party(M, "VENDOR / SUPPLIER", [
    val(vendor.name ?? purchase?.vendorName),
    vendorAddr,
    `GSTIN: ${val(vendor.gstNumber)}`,
    vendor.phone ? `Ph: ${vendor.phone}` : "",
  ]);
  party(M + halfW + 4, "RECEIVING LOCATION (BILL TO)", [
    val(purchase?.locationName),
    val(issuer.tradeName),
    `GSTIN: ${val(issuer.gstin)}`,
  ]);
  y += partyH + 4;

  // ── Document reference strip ──────────────────────────────────────────────
  const stripH = 12;
  p.fill(M, y, CW, stripH, LGRAY);
  p.box(M, y, CW, stripH, BORDER, 0.25);
  const cells: Array<[string, string]> = [
    ["PURCHASE BILL NO.", docNo],
    ["BILL DATE", dateIN(purchase?.purchaseDate)],
    ["VENDOR INVOICE REF.", val(purchase?.invoiceNumber)],
    // Absent on historical bills — a dash, never a fabricated date.
    ["VENDOR INVOICE DATE", purchase?.vendorInvoiceDate ? dateIN(purchase.vendorInvoiceDate) : "\u2014"],
    ["RATE BASIS", inclusive ? "GST Inclusive" : "GST Exclusive"],
  ];
  const cellW = CW / cells.length;
  cells.forEach(([label, value], i) => {
    const cx = M + cellW * i;
    if (i > 0) p.line(cx, y + 1.5, cx, y + stripH - 1.5, BORDER, 0.2);
    p.txt(label, cx + 3, y + 4.6, { size: 5.6, color: MGRAY });
    p.txt(value, cx + 3, y + 9.2, { size: 8, bold: true });
  });
  y += stripH + 5;

  // ── Line items ────────────────────────────────────────────────────────────
  const cols: Col[] = [
    { header: "#", width: 5.5, align: "center", wrap: false },
    { header: "Item / Material", width: 37 },
    { header: "HSN", width: 12, align: "center", wrap: false },
    { header: "Batch", width: 22, align: "center" },
    { header: "MFG / Exp", width: 15, align: "center" },
    { header: "Qty", width: 11.5, align: "right", wrap: false },
    { header: "UOM", width: 8, align: "center", wrap: false },
    { header: `Rate (\u20B9)`, width: 14, align: "right", wrap: false },
    { header: "GST%", width: 8, align: "center", wrap: false },
    { header: `Taxable (\u20B9)`, width: 16.5, align: "right", wrap: false },
    { header: `GST (\u20B9)`, width: 14, align: "right", wrap: false },
    { header: `Total (\u20B9)`, width: 18.5, align: "right", wrap: false },
  ];

  /** 28-Jul-2026 -> 28-Jul-26. Two dates share one narrow column. */
  const shortDate = (v: unknown): string => {
    const s = dateIN(v);
    return s === DASH ? DASH : s.replace(/-\d{2}(\d{2})$/, "-$1");
  };

  /** Break server-issued batch numbers at the last hyphen, not mid-number. */
  const batchCell = (v: unknown): string => {
    const s = val(v);
    if (s.length <= 14) return s;
    const i = s.lastIndexOf("-");
    return i > 0 ? `${s.slice(0, i)}\n${s.slice(i + 1)}` : s;
  };

  const rows = lines.map((li, i) => {
    const kind = TYPE_LABEL[String(li?.materialType ?? "material")] ?? "Material";
    const name = val(li?.materialName ?? `#${li?.materialId}`);
    return [
      String(i + 1),
      `${name}\n${kind}`,
      val(li?.hsnCode),
      batchCell(li?.batchNumber),
      `${shortDate(li?.mfgDate)}\n${shortDate(li?.expiryDate)}`,
      qty(li?.quantity),
      val(li?.unit),
      inGrouping(Number(li?.unitCost ?? 0)),
      `${inGrouping(Number(li?.gstRate ?? 0), 0)}%`,
      money(li?.taxableValue),
      money(li?.taxAmount),
      money(li?.lineTotal),
    ];
  });

  const BOTTOM = PH - 16;
  y = flowTable(p, y, cols, rows, {
    bottomLimit: BOTTOM,
    fontSize: 6.5,
    onNewPage: () => { doc.addPage(); return drawContinuationBand(); },
  });
  y += 5;

  // ── Totals, amount in words, signatures — final page only ─────────────────
  const docDiscount = Number(purchase?.discountTotal ?? 0);
  const docTax = Number(purchase?.taxTotal ?? 0);
  const shownDiscount = priced ? discountTotal : docDiscount;
  const shownTax = priced ? taxTotal : docTax;

  const totalRows: Array<[string, string]> = [
    [inclusive ? "Gross Value (incl. GST)" : "Gross Value", priced ? inr(grossTotal) : DASH],
  ];
  if (shownDiscount > 0) totalRows.push(["Less: Discount", `- ${inr(shownDiscount)}`]);
  totalRows.push(["Taxable Value", priced ? inr(taxableTotal) : DASH]);
  if (priced && cgstTotal > 0) totalRows.push(["CGST", inr(cgstTotal)]);
  if (priced && sgstTotal > 0) totalRows.push(["SGST", inr(sgstTotal)]);
  if (priced && igstTotal > 0) totalRows.push(["IGST", inr(igstTotal)]);
  // A bill can carry tax without a head-wise split — show the tax actually
  // posted rather than dropping the GST line entirely.
  if (!priced || cgstTotal + sgstTotal + igstTotal === 0) {
    totalRows.push(["GST", shownTax > 0 ? inr(shownTax) : "Nil"]);
  }
  if (Math.abs(roundOff) >= 0.005) {
    totalRows.push(["Round Off", `${roundOff < 0 ? "- " : "+ "}${inr(Math.abs(roundOff))}`]);
  }
  if (otherCharges.length > 0) {
    totalRows.push(["Goods Total", inr(grandTotal)]);
    for (const c of otherCharges) {
      totalRows.push([String(c.ledgerName || `Ledger #${c.ledgerId}`), inr(Number(c.amount ?? 0))]);
    }
  }

  const totW = 74;
  const totX = PW - M - totW;
  const rowH = 5.4;
  const totalsBoxH = totalRows.length * rowH + 1.5;
  const totalsH = totalsBoxH + 9.5;              // + the grand-total bar
  const wordLines = p.wrap(amountInWords(payableTotal), CW - totW - 10, 7.4, true);
  const wordsH = 12 + wordLines.length * 3.8;
  const notesLines = purchase?.notes ? p.wrap(String(purchase.notes), CW - totW - 10, 6.8) : [];
  const notesH = notesLines.length ? 6 + notesLines.length * 3.4 : 0;
  const blockH = Math.max(totalsH, wordsH + (notesH ? notesH + 2 : 0));
  const SIG_H = 22;

  if (y + blockH + SIG_H + 4 > BOTTOM) {
    doc.addPage();
    y = drawContinuationBand();
  }

  // Amount in words (left)
  const leftW = CW - totW - 4;
  p.box(M, y, leftW, wordsH, BORDER, 0.25);
  p.txt("AMOUNT IN WORDS", M + 3, y + 5, { size: 5.8, color: MGRAY });
  let wy = y + 9.6;
  for (const l of wordLines) {
    p.txt(l, M + 3, wy, { size: 7.4, bold: true });
    wy += 3.8;
  }
  if (notesLines.length) {
    p.box(M, y + wordsH + 2, leftW, notesH, BORDER, 0.25);
    p.txt("NOTES", M + 3, y + wordsH + 6, { size: 5.8, color: MGRAY });
    let ny = y + wordsH + 10;
    for (const l of notesLines) {
      p.txt(l, M + 3, ny, { size: 6.8, color: [70, 80, 95] });
      ny += 3.4;
    }
  }

  // Totals (right)
  let ty = y;
  p.box(totX, ty, totW, totalsBoxH, BORDER, 0.25);
  ty += 4.6;
  totalRows.forEach(([label, value]) => {
    p.txt(label, totX + 3, ty, { size: 7, color: [70, 80, 95] });
    p.txt(value, totX + totW - 3, ty, { size: 7, align: "right" });
    ty += rowH;
  });
  ty = y + totalsBoxH;
  p.fill(totX, ty, totW, 9.5, NAVY);
  p.txt(otherCharges.length > 0 ? "TOTAL PAYABLE" : "GRAND TOTAL", totX + 3, ty + 6.2, { size: 8, bold: true, color: WHITE });
  p.txt(inr(payableTotal), totX + totW - 3, ty + 6.2,
    { size: 10, bold: true, color: WHITE, align: "right" });

  y += blockH + 8;

  // ── Signatures — anchored to the foot of the page ─────────────────────────
  if (y + SIG_H > BOTTOM) { doc.addPage(); y = drawContinuationBand() + 6; }
  const sigY = Math.max(y, BOTTOM - SIG_H);
  const sigW = CW / 3;
  p.box(M, sigY, CW, SIG_H, BORDER, 0.25);
  ["Prepared By", "Checked / Authorised By", "Vendor Acknowledgement"].forEach((label, i) => {
    const sx = M + sigW * i;
    if (i > 0) p.line(sx, sigY, sx, sigY + SIG_H, BORDER, 0.2);
    p.txt(label, sx + 3, sigY + 4.6, { size: 6, color: MGRAY });
    p.line(sx + 3, sigY + SIG_H - 4.5, sx + sigW - 3, sigY + SIG_H - 4.5, [170, 180, 195], 0.25);
    p.txt("Signature & Date", sx + 3, sigY + SIG_H - 1.8, { size: 5.4, color: MGRAY });
  });

  stampFooters(doc, "This is a computer-generated document and does not require a signature.");

  const safeVendor = String(vendor.name ?? purchase?.vendorName ?? "Vendor")
    .replace(/[^a-zA-Z0-9-]/g, "_").slice(0, 40);
  return {
    buffer: Buffer.from(doc.output("arraybuffer")),
    fileName: `Purchase-Invoice-${docNo}-${safeVendor}.pdf`,
  };
}
