/**
 * Purchase Invoice PDF — the printable form of a recorded purchase bill.
 *
 * The old version of this document was titled "PURCHASE ORDER", which was
 * wrong: this module records bills for goods that have already been received,
 * priced, taxed and posted to stock and to the vendor's payable. A purchase
 * order is a pre-purchase document and this ERP has no such record. The title
 * follows what the record actually is.
 *
 * It also printed six columns and one flat total, dropped every GST, HSN and
 * batch figure the bill carries, and had no pagination at all — a fifty-line
 * bill drew its rows straight off the bottom of page one and lost them. This
 * renderer prints the full tax breakdown and flows across as many pages as the
 * bill needs.
 *
 * Everything here is read from the stored bill. Nothing is recomputed, so the
 * printed figures are the posted figures.
 */
import { jsPDF } from 'jspdf';
import {
  registerFonts, Painter, flowTable, stampFooters, amountInWords,
  inr, inGrouping, qty, dateIN,
  NAVY, TEAL, WHITE, LGRAY, MGRAY, BORDER, BK,
  PW, PH, M, CW, type Col,
} from '@workspace/pdf-kit';

const LOGO_KEY = 'marlin_company_logo';
const DASH = '-';

/** Blank, null and whitespace all print as a dash. Nothing is invented. */
function val(v: unknown): string {
  const s = v == null ? '' : String(v).trim();
  return s === '' ? DASH : s;
}

/**
 * A money cell that distinguishes "zero" from "not recorded". A pre-pricing
 * line has no taxable value at all, and printing 0.00 there would assert a
 * figure the bill never carried.
 */
function money(v: unknown): string {
  return v == null || v === '' ? DASH : inGrouping(Number(v));
}

export interface PurchaseDocVendor {
  name?: string | null;
  gstNumber?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  phone?: string | null;
  email?: string | null;
}

const TYPE_LABEL: Record<string, string> = {
  material: 'Raw Material',
  raw_material: 'Packing Material',
  item: 'Finished Item',
};

/** Draws the logo inside a white plate so a dark logo stays visible on navy. */
function drawLogo(doc: jsPDF, x: number, y: number, boxW: number, boxH: number): boolean {
  const logo = typeof localStorage !== 'undefined' ? localStorage.getItem(LOGO_KEY) : null;
  if (!logo) return false;
  try {
    const fmt = logo.startsWith('data:image/png') ? 'PNG'
      : logo.startsWith('data:image/webp') ? 'WEBP' : 'JPEG';
    // Fit inside the plate without distorting the artwork.
    let w = boxW - 3;
    let h = boxH - 3;
    try {
      const props = doc.getImageProperties(logo);
      const scale = Math.min((boxW - 3) / props.width, (boxH - 3) / props.height);
      w = props.width * scale;
      h = props.height * scale;
    } catch { /* fall back to the plate size */ }
    doc.setFillColor(255, 255, 255);
    doc.roundedRect(x, y, boxW, boxH, 1.5, 1.5, 'F');
    doc.addImage(logo, fmt, x + (boxW - w) / 2, y + (boxH - h) / 2, w, h, undefined, 'FAST');
    return true;
  } catch {
    return false;
  }
}

/** Builds the document. Kept separate from saving so it can be rendered and
 *  inspected outside a browser. */
export async function buildPurchaseInvoicePDF(
  purchase: any,
  companySettings: any,
  vendor: PurchaseDocVendor | undefined,
): Promise<{ doc: jsPDF; fileName: string }> {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  await registerFonts(doc);
  const p = new Painter(doc);

  const cs = companySettings ?? {};
  const lines: any[] = Array.isArray(purchase?.lineItems) ? purchase.lineItems : [];
  const docNo = `PB-${String(purchase?.id ?? 0).padStart(4, '0')}`;
  const inclusive = String(purchase?.priceMode ?? 'exclusive') === 'inclusive';

  // ── Totals, footed from the stored lines so the table adds up to the box ───
  const sum = (pick: (l: any) => number) =>
    Math.round(lines.reduce((a, l) => a + (Number(pick(l)) || 0), 0) * 100) / 100;
  // Every line the purchase module writes carries its own priced fields. A line
  // without them predates pricing, and re-deriving qty x rate here would print a
  // gross that the posted bill never agreed to — so the breakdown is withheld
  // instead, and the box falls back to the aggregates the bill row itself holds.
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
  // Other Purchase Charges — shown exactly as stored on the bill (never
  // recomputed here). They add to what the vendor is owed, not to the
  // goods/GST figures above.
  const otherCharges: any[] = Array.isArray(purchase?.otherCharges) ? purchase.otherCharges : [];
  const otherChargesTotal = Number(purchase?.otherChargesTotal ?? 0);
  const payableTotal = otherCharges.length > 0 ? grandTotal + otherChargesTotal : grandTotal;

  // ── Page furniture ────────────────────────────────────────────────────────
  const BAND_H = 34;

  const drawBand = (continuation: boolean): number => {
    p.fill(0, 0, PW, continuation ? 20 : BAND_H, NAVY);

    if (continuation) {
      p.txt(val(cs.companyName || cs.name), M, 8.5, { size: 10, bold: true, color: WHITE });
      p.txt('PURCHASE INVOICE (continued)', M, 14.5, { size: 6.8, color: [190, 205, 225] });
      p.txt(docNo, PW - M, 9, { size: 10, bold: true, color: WHITE, align: 'right' });
      p.txt(dateIN(purchase?.purchaseDate), PW - M, 14.5,
        { size: 7, color: [190, 205, 225], align: 'right' });
      return 26;
    }

    const hasLogo = drawLogo(doc, M, 6, 24, 22);
    const tx = hasLogo ? M + 28 : M;
    p.txt(val(cs.companyName || cs.name), tx, 12, { size: 13.5, bold: true, color: WHITE });

    let iy = 17.5;
    const addr = [cs.address, [cs.city, cs.state, cs.pincode].filter(Boolean).join(', ')]
      .filter(Boolean).join(' \u2022 ');
    if (addr) {
      for (const l of p.wrap(addr, 105, 6.6).slice(0, 2)) {
        p.txt(l, tx, iy, { size: 6.6, color: [190, 205, 225] });
        iy += 3.4;
      }
    }
    const reg = [cs.gstNumber ? `GSTIN: ${cs.gstNumber}` : '', cs.phone ? `Ph: ${cs.phone}` : '']
      .filter(Boolean).join('   |   ');
    if (reg) p.txt(reg, tx, iy, { size: 6.6, color: [190, 205, 225] });

    p.txt('PURCHASE INVOICE', PW - M, 13, { size: 16, bold: true, color: WHITE, align: 'right' });
    p.txt('Goods received and posted to stock', PW - M, 17.6,
      { size: 6.2, color: [170, 190, 215], align: 'right' });
    return BAND_H + 5;
  };

  let y = drawBand(false);

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

  const vendorAddr = [vendor?.address, [vendor?.city, vendor?.state, vendor?.pincode]
    .filter(Boolean).join(', ')].filter(Boolean).join(', ');
  party(M, 'VENDOR / SUPPLIER', [
    val(vendor?.name ?? purchase?.vendorName),
    vendorAddr,
    `GSTIN: ${val(vendor?.gstNumber)}`,
    vendor?.phone ? `Ph: ${vendor.phone}` : '',
  ]);
  party(M + halfW + 4, 'RECEIVING LOCATION (BILL TO)', [
    val(purchase?.locationName),
    val(cs.companyName || cs.name),
    `GSTIN: ${val(cs.gstNumber)}`,
    cs.state ? `State: ${cs.state}` : '',
  ]);
  y += partyH + 4;

  // ── Document reference strip ──────────────────────────────────────────────
  const stripH = 12;
  p.fill(M, y, CW, stripH, LGRAY);
  p.box(M, y, CW, stripH, BORDER, 0.25);
  const cells: Array<[string, string]> = [
    ['PURCHASE BILL NO.', docNo],
    ['BILL DATE', dateIN(purchase?.purchaseDate)],
    ['VENDOR INVOICE REF.', val(purchase?.invoiceNumber)],
    ['RATE BASIS', inclusive ? 'GST Inclusive' : 'GST Exclusive'],
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
  // Widths sum to CW (182 mm). MFG and Expiry share one column: two dates side
  // by side need ~24 mm of the row, which the money columns cannot spare, and
  // stacked they cost no height — the product name already runs to two lines.
  const cols: Col[] = [
    { header: '#', width: 5.5, align: 'center', wrap: false },
    { header: 'Item / Material', width: 37 },
    { header: 'HSN', width: 12, align: 'center', wrap: false },
    { header: 'Batch', width: 22, align: 'center' },
    { header: 'MFG / Exp', width: 15, align: 'center' },
    { header: 'Qty', width: 11.5, align: 'right', wrap: false },
    { header: 'UOM', width: 8, align: 'center', wrap: false },
    { header: `Rate (\u20B9)`, width: 14, align: 'right', wrap: false },
    { header: 'GST%', width: 8, align: 'center', wrap: false },
    { header: `Taxable (\u20B9)`, width: 16.5, align: 'right', wrap: false },
    { header: `GST (\u20B9)`, width: 14, align: 'right', wrap: false },
    { header: `Total (\u20B9)`, width: 18.5, align: 'right', wrap: false },
  ];

  /** 28-Jul-2026 -> 28-Jul-26. Two dates have to share one narrow column. */
  const shortDate = (v: unknown): string => {
    const s = dateIN(v);
    return s === DASH ? DASH : s.replace(/-\d{2}(\d{2})$/, '-$1');
  };

  /**
   * Server-issued batch numbers (PUR-YYYYMMDD-NNNNN) are wider than any column
   * this table can spare, so they wrap. Left alone the break lands mid-number;
   * breaking at the last hyphen keeps the sequence readable.
   */
  const batchCell = (v: unknown): string => {
    const s = val(v);
    if (s.length <= 14) return s;
    const i = s.lastIndexOf('-');
    return i > 0 ? `${s.slice(0, i)}\n${s.slice(i + 1)}` : s;
  };

  const rows = lines.map((li, i) => {
    const kind = TYPE_LABEL[String(li?.materialType ?? 'material')] ?? 'Material';
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
    onNewPage: () => { doc.addPage(); return drawBand(true); },
  });
  y += 5;

  // ── Totals, amount in words, signatures — final page only ─────────────────
  const docDiscount = Number(purchase?.discountTotal ?? 0);
  const docTax = Number(purchase?.taxTotal ?? 0);
  const shownDiscount = priced ? discountTotal : docDiscount;
  const shownTax = priced ? taxTotal : docTax;

  const totalRows: Array<[string, string, boolean?]> = [
    [inclusive ? 'Gross Value (incl. GST)' : 'Gross Value', priced ? inr(grossTotal) : DASH],
  ];
  if (shownDiscount > 0) totalRows.push(['Less: Discount', `- ${inr(shownDiscount)}`]);
  totalRows.push(['Taxable Value', priced ? inr(taxableTotal) : DASH]);
  if (priced && cgstTotal > 0) totalRows.push(['CGST', inr(cgstTotal)]);
  if (priced && sgstTotal > 0) totalRows.push(['SGST', inr(sgstTotal)]);
  if (priced && igstTotal > 0) totalRows.push(['IGST', inr(igstTotal)]);
  // A bill can carry tax without a head-wise split (an older record, or one
  // edited before the split was stored). Show the tax that was actually posted
  // rather than dropping the GST line entirely.
  if (!priced || cgstTotal + sgstTotal + igstTotal === 0) {
    totalRows.push(['GST', shownTax > 0 ? inr(shownTax) : 'Nil']);
  }
  if (Math.abs(roundOff) >= 0.005) {
    totalRows.push(['Round Off', `${roundOff < 0 ? '- ' : '+ '}${inr(Math.abs(roundOff))}`]);
  }
  if (otherCharges.length > 0) {
    totalRows.push(['Goods Total', inr(grandTotal)]);
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
  const wordsH = 12 + wordLines.length * 3.8;    // sized to its text, not stretched
  const notesLines = purchase?.notes ? p.wrap(String(purchase.notes), CW - totW - 10, 6.8) : [];
  const notesH = notesLines.length ? 6 + notesLines.length * 3.4 : 0;
  const blockH = Math.max(totalsH, wordsH + (notesH ? notesH + 2 : 0));
  const SIG_H = 22;

  if (y + blockH + SIG_H + 4 > BOTTOM) {
    doc.addPage();
    y = drawBand(true);
  }

  // Amount in words (left)
  const leftW = CW - totW - 4;
  p.box(M, y, leftW, wordsH, BORDER, 0.25);
  p.txt('AMOUNT IN WORDS', M + 3, y + 5, { size: 5.8, color: MGRAY });
  let wy = y + 9.6;
  for (const l of wordLines) {
    p.txt(l, M + 3, wy, { size: 7.4, bold: true });
    wy += 3.8;
  }
  if (notesLines.length) {
    p.box(M, y + wordsH + 2, leftW, notesH, BORDER, 0.25);
    p.txt('NOTES', M + 3, y + wordsH + 6, { size: 5.8, color: MGRAY });
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
    p.txt(value, totX + totW - 3, ty, { size: 7, align: 'right' });
    ty += rowH;
  });
  ty = y + totalsBoxH;
  p.fill(totX, ty, totW, 9.5, NAVY);
  p.txt(otherCharges.length > 0 ? 'TOTAL PAYABLE' : 'GRAND TOTAL', totX + 3, ty + 6.2, { size: 8, bold: true, color: WHITE });
  p.txt(inr(payableTotal), totX + totW - 3, ty + 6.2,
    { size: 10, bold: true, color: WHITE, align: 'right' });

  y += blockH + 8;

  // ── Signatures ────────────────────────────────────────────────────────────
  // Sat directly under the totals, a short bill left a third of the sheet
  // hanging empty below them. Anchored to the foot of the page instead, the
  // sheet reads as a finished form rather than one that ran out of content.
  if (y + SIG_H > BOTTOM) { doc.addPage(); y = drawBand(true) + 6; }
  const sigY = Math.max(y, BOTTOM - SIG_H);
  const sigW = CW / 3;
  p.box(M, sigY, CW, SIG_H, BORDER, 0.25);
  ['Prepared By', 'Checked / Authorised By', 'Vendor Acknowledgement'].forEach((label, i) => {
    const sx = M + sigW * i;
    if (i > 0) p.line(sx, sigY, sx, sigY + SIG_H, BORDER, 0.2);
    p.txt(label, sx + 3, sigY + 4.6, { size: 6, color: MGRAY });
    p.line(sx + 3, sigY + SIG_H - 4.5, sx + sigW - 3, sigY + SIG_H - 4.5, [170, 180, 195], 0.25);
    p.txt('Signature & Date', sx + 3, sigY + SIG_H - 1.8, { size: 5.4, color: MGRAY });
  });

  stampFooters(doc, 'This is a computer-generated document and does not require a signature.');

  const safeVendor = String(vendor?.name ?? purchase?.vendorName ?? 'Vendor')
    .replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 40);
  return { doc, fileName: `Purchase-Invoice-${docNo}-${safeVendor}.pdf` };
}

export async function downloadPurchaseInvoicePDF(
  purchase: any,
  companySettings: any,
  vendor: PurchaseDocVendor | undefined,
): Promise<void> {
  const { doc, fileName } = await buildPurchaseInvoicePDF(purchase, companySettings, vendor);
  doc.save(fileName);
}
