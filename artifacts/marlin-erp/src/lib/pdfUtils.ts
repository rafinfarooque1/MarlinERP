/**
 * Client-side PDF generation using jsPDF.
 * Three document types: Tax Invoice, Payslip, Purchase Order.
 * Logo is read from localStorage (key: 'marlin_company_logo').
 */
import jsPDF from 'jspdf';

const PAGE_W = 210;
const PAGE_H = 297;
const MARGIN = 15;
const CONTENT_W = PAGE_W - MARGIN * 2;
const LOGO_KEY = 'marlin_company_logo';

type RGB = [number, number, number];
const TEAL: RGB   = [13, 148, 136];
const DARK: RGB   = [30, 30, 30];
const MUTED: RGB  = [110, 110, 110];
const LIGHT: RGB  = [245, 247, 250];
const WHITE: RGB  = [255, 255, 255];
const RED: RGB    = [220, 38, 38];
const GREEN: RGB  = [22, 163, 74];

// ── helpers ──────────────────────────────────────────────────────────────────

function esc(s: unknown): string { return String(s ?? ''); }

function fmt(n: unknown): string {
  return '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });
}

function setColor(doc: jsPDF, rgb: RGB) { doc.setTextColor(rgb[0], rgb[1], rgb[2]); }
function setFill(doc: jsPDF, rgb: RGB)  { doc.setFillColor(rgb[0], rgb[1], rgb[2]); }
function setDraw(doc: jsPDF, rgb: RGB)  { doc.setDrawColor(rgb[0], rgb[1], rgb[2]); }

function addLogoIfPresent(doc: jsPDF, x: number, y: number, maxW: number, maxH: number): number {
  const logo = typeof localStorage !== 'undefined' ? localStorage.getItem(LOGO_KEY) : null;
  if (!logo) return y;
  try {
    const ext = logo.startsWith('data:image/png') ? 'PNG'
      : logo.startsWith('data:image/webp') ? 'WEBP' : 'JPEG';
    doc.addImage(logo, ext, x, y, maxW, maxH, undefined, 'FAST');
    return y + maxH;
  } catch {
    return y;
  }
}

/** Renders company header + horizontal rule. Returns next Y. */
function drawHeader(doc: jsPDF, cs: any, docTitle: string): number {
  const y = MARGIN;
  const logoH = 18;
  const logoW = 36;
  const logoBottom = addLogoIfPresent(doc, MARGIN, y, logoW, logoH);
  const hasLogo = logoBottom > y;
  const textX = hasLogo ? MARGIN + logoW + 4 : MARGIN;

  // Company name
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  setColor(doc, DARK);
  doc.text(esc(cs?.companyName || cs?.name || 'Company'), textX, y + 6);

  // Company details
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  setColor(doc, MUTED);
  let iy = y + 11;
  if (cs?.address)  { doc.text(esc(cs.address), textX, iy); iy += 4; }
  const city = [cs?.city, cs?.state, cs?.pincode].filter(Boolean).join(', ');
  if (city)         { doc.text(city, textX, iy); iy += 4; }
  if (cs?.gstNumber){ doc.text(`GSTIN: ${esc(cs.gstNumber)}`, textX, iy); iy += 4; }
  if (cs?.phone)    { doc.text(`Ph: ${esc(cs.phone)}`, textX, iy); }

  // Document title (top-right)
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  setColor(doc, TEAL);
  doc.text(docTitle, PAGE_W - MARGIN, y + 9, { align: 'right' });

  const headerEnd = Math.max(hasLogo ? logoBottom : y, iy, y + logoH) + 4;
  setDraw(doc, TEAL);
  doc.setLineWidth(0.5);
  doc.line(MARGIN, headerEnd, PAGE_W - MARGIN, headerEnd);
  return headerEnd + 5;
}

interface TableCol { header: string; width: number; align?: 'left' | 'right' | 'center'; }

/** Draws a table and returns the next Y position. */
function drawTable(
  doc: jsPDF,
  startY: number,
  cols: TableCol[],
  rows: (string | number)[][],
  opts?: { rowH?: number; headerBg?: RGB; fontSize?: number }
): number {
  const rowH      = opts?.rowH ?? 7;
  const hdrBg     = opts?.headerBg ?? TEAL;
  const fs        = opts?.fontSize ?? 8;
  let y = startY;

  // Header row
  setFill(doc, hdrBg);
  doc.rect(MARGIN, y, CONTENT_W, rowH, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(fs);
  setColor(doc, WHITE);

  let cx = MARGIN;
  for (const col of cols) {
    const px = col.align === 'right'  ? cx + col.width - 1.5
             : col.align === 'center' ? cx + col.width / 2
             :                          cx + 1.5;
    const align = col.align ?? 'left';
    doc.text(col.header, px, y + rowH - 2, { align });
    cx += col.width;
  }
  y += rowH;

  // Data rows
  doc.setFont('helvetica', 'normal');
  setColor(doc, DARK);
  for (let ri = 0; ri < rows.length; ri++) {
    if (ri % 2 === 1) {
      setFill(doc, LIGHT);
      doc.rect(MARGIN, y, CONTENT_W, rowH, 'F');
    }
    cx = MARGIN;
    for (let ci = 0; ci < cols.length; ci++) {
      const col = cols[ci];
      const val = String(rows[ri][ci] ?? '');
      const px  = col.align === 'right'  ? cx + col.width - 1.5
                : col.align === 'center' ? cx + col.width / 2
                :                          cx + 1.5;
      const align = col.align ?? 'left';
      doc.text(val, px, y + rowH - 2, { align });
      cx += col.width;
    }
    setDraw(doc, [215, 215, 215]);
    doc.setLineWidth(0.1);
    doc.line(MARGIN, y + rowH, MARGIN + CONTENT_W, y + rowH);
    y += rowH;
  }
  setDraw(doc, [180, 180, 180]);
  doc.setLineWidth(0.25);
  doc.rect(MARGIN, startY, CONTENT_W, y - startY);
  return y;
}

function drawFooter(doc: jsPDF, note: string) {
  setDraw(doc, TEAL);
  doc.setLineWidth(0.5);
  doc.line(MARGIN, PAGE_H - 13, PAGE_W - MARGIN, PAGE_H - 13);
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(7.5);
  setColor(doc, MUTED);
  doc.text(note, PAGE_W / 2, PAGE_H - 9, { align: 'center' });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildUpiUri(upiId: string, payeeName: string, amount: number, ref: string): string {
  const params = new URLSearchParams({ pa: upiId, pn: payeeName, am: amount.toFixed(2), cu: 'INR', tn: ref });
  return `upi://pay?${params.toString()}`;
}

/** Convert a numeric amount to Indian-English words (Rupees ... Only). */
function toIndianWords(amount: number): string {
  const o = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
              'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
              'Seventeen', 'Eighteen', 'Nineteen'];
  const t = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  function h(n: number): string {
    if (n <= 0) return '';
    if (n < 20) return o[n] + ' ';
    if (n < 100) return t[Math.floor(n / 10)] + (n % 10 ? ' ' + o[n % 10] : '') + ' ';
    return o[Math.floor(n / 100)] + ' Hundred ' + h(n % 100);
  }
  let r = Math.floor(amount);
  const paise = Math.round((amount - r) * 100);
  if (r === 0 && paise === 0) return 'Rupees Zero Only';
  let words = 'Rupees ';
  if (r >= 10000000) { words += h(Math.floor(r / 10000000)) + 'Crore '; r %= 10000000; }
  if (r >= 100000)   { words += h(Math.floor(r / 100000))   + 'Lakh ';  r %= 100000;  }
  if (r >= 1000)     { words += h(Math.floor(r / 1000))     + 'Thousand '; r %= 1000; }
  if (r > 0)         { words += h(r); }
  words = words.trim();
  if (paise > 0) words += ` and ${h(paise).trim()} Paise`;
  return words + ' Only';
}

// ── Tax Invoice — standard GST format ────────────────────────────────────────

async function buildInvoicePDFDoc(sale: any, companySettings: any): Promise<jsPDF> {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  const cs = companySettings as any;

  const BK: RGB  = [0, 0, 0];
  const GR: RGB  = [80, 80, 80];
  const LG: RGB  = [235, 235, 235]; // light-grey section headers

  const M  = 10;                    // page margin
  const CW = PAGE_W - M * 2;       // 190 mm
  const HW = CW / 2;               // half-width = 95 mm
  const L2 = M + HW;               // x of right column

  // ── UPI QR pre-generation ─────────────────────────────────────────────────
  let qrDataUrl: string | undefined;
  const outletUpiId: string = (sale as any).outletUpiId || '';
  if (outletUpiId) {
    try {
      const upiUri = buildUpiUri(outletUpiId, sale.outletName || '', Number(sale.totalAmount), sale.invoiceNumber || '');
      const QR = (await import('qrcode')) as any;
      qrDataUrl = await QR.toDataURL(upiUri, { width: 200, margin: 2, color: { dark: '#000000', light: '#FFFFFF' } });
    } catch { /* omit silently */ }
  }

  // ── helpers for this invoice ──────────────────────────────────────────────
  const ln = (x1: number, y1: number, x2: number, y2: number, lw = 0.3) => {
    setDraw(doc, BK); doc.setLineWidth(lw); doc.line(x1, y1, x2, y2);
  };
  const bx = (x: number, y: number, w: number, h: number, fill?: RGB) => {
    if (fill) { setFill(doc, fill); doc.rect(x, y, w, h, 'FD'); }
    else { setDraw(doc, BK); doc.setLineWidth(0.3); doc.rect(x, y, w, h); }
  };
  const txt = (s: string, x: number, y: number, opts?: { align?: 'left'|'right'|'center'; bold?: boolean; size?: number; color?: RGB }) => {
    doc.setFont('helvetica', opts?.bold ? 'bold' : 'normal');
    doc.setFontSize(opts?.size ?? 7.5);
    setColor(doc, opts?.color ?? BK);
    doc.text(s, x, y, { align: opts?.align ?? 'left' });
  };

  const companyName = esc(cs?.companyName || cs?.name || 'Company');
  let y = M;

  // ── 1. Company header ────────────────────────────────────────────────────
  txt(companyName, PAGE_W / 2, y + 8, { bold: true, size: 16, align: 'center' });
  y += 11;

  const addrLine = [cs?.address, cs?.city, cs?.state, cs?.pincode].filter(Boolean).join(', ');
  if (addrLine) {
    txt(addrLine, PAGE_W / 2, y, { size: 8, color: GR, align: 'center' });
    y += 5;
  }

  // E-Mail left | "GST INVOICE B2C" center | Phone right
  if (cs?.email) txt(`E-Mail  :  ${esc(cs.email)}`, M, y, { size: 8 });
  txt('GST INVOICE B2C', PAGE_W / 2, y, { bold: true, size: 10, align: 'center' });
  if (cs?.phone) txt(`Phone  :  ${esc(cs.phone)}`, PAGE_W - M, y, { size: 8, align: 'right' });
  y += 5;

  ln(M, y, PAGE_W - M, y);
  y += 1;

  // ── 2. Invoice details grid ───────────────────────────────────────────────
  const rowH = 6;
  const metaL = [
    ['GST Number',                    esc(cs?.gstNumber || '')],
    ['Invoice Number',                esc(sale.invoiceNumber || '')],
    ['Invoice Date',                  new Date(sale.saleDate).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: '2-digit' })],
    ['Tax Payable on Reverse Charge', 'No'],
  ];
  const metaR = [
    ['Transportation Mode',   ''],
    ['Vehicle Number',        ''],
    ['Date & Time of Supply', new Date(sale.saleDate).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: '2-digit' })],
    ['Place of Supply',       esc(cs?.state || '')],
  ];
  const mH = metaL.length * rowH;
  bx(M, y, CW, mH);
  ln(L2, y, L2, y + mH);
  for (let i = 1; i < metaL.length; i++) ln(M, y + i * rowH, PAGE_W - M, y + i * rowH, 0.1);

  metaL.forEach(([k, v], i) => {
    const ry = y + i * rowH + rowH - 2;
    txt(k,          M + 2,      ry, { size: 7.5, color: GR });
    txt(`:  ${v}`,  M + 52,     ry, { size: 7.5 });
    txt(metaR[i][0], L2 + 2,    ry, { size: 7.5, color: GR });
    txt(`:  ${metaR[i][1]}`, L2 + 52, ry, { size: 7.5 });
  });
  y += mH;

  // ── 3. Receiver / Consignee grid ─────────────────────────────────────────
  const custName   = esc(sale.customerName || 'Walk-in Customer');
  const custAddr   = esc(sale.outletName || '');
  const custState  = esc(cs?.state || '');
  const custPhone  = esc((sale as any).customerPhone || '');
  const custGstin  = esc((sale as any).customerGstin || '');

  const custRows = [
    ['Name',       custName],
    ['Address',    custAddr],
    ['State',      custState],
    ['Mobile No.', custPhone],
    ['GST No',     custGstin],
  ];
  const cH = (custRows.length + 1) * rowH;
  bx(M, y, CW, cH);
  ln(L2, y, L2, y + cH);

  // Section header row (shaded)
  setFill(doc, LG); doc.rect(M, y, HW, rowH, 'F');
  setFill(doc, LG); doc.rect(L2, y, HW, rowH, 'F');
  ln(M, y + rowH, PAGE_W - M, y + rowH);
  txt('Details of Receiver (Billed to)',   M + 2,  y + rowH - 1.5, { bold: true, size: 7.5 });
  txt('Details of Consignee (Shipped to)', L2 + 2, y + rowH - 1.5, { bold: true, size: 7.5 });
  y += rowH;

  custRows.forEach(([k, v], i) => {
    if (i > 0) ln(M, y + i * rowH, PAGE_W - M, y + i * rowH, 0.1);
    const ry = y + i * rowH + rowH - 1.5;
    txt(k,       M + 2,  ry, { size: 7.5, color: GR });
    txt(`: ${v}`, M + 22, ry, { size: 7.5 });
    if (i < 3) {
      txt(k,        L2 + 2,  ry, { size: 7.5, color: GR });
      txt(`: ${v}`, L2 + 22, ry, { size: 7.5 });
    }
  });
  y += custRows.length * rowH;

  // ── 4. Line items table ───────────────────────────────────────────────────
  // 11 columns, total CW = 190 mm
  // Sl:8 | Desc:47 | HSN:14 | Qty:9 | Unit:10 | UnitPrice:18 | Taxable:18 | CGST:17 | SGST:17 | IGST:17 | Total:15
  const TC = [
    { lbl: ['Sl', 'No'],           w: 8,  align: 'center' as const },
    { lbl: ['Description of Goods'], w: 47, align: 'left'   as const },
    { lbl: ['Hsn', 'Code', '(GST)'], w: 14, align: 'center' as const },
    { lbl: ['Qty'],                w: 9,  align: 'right'  as const },
    { lbl: ['Unit'],               w: 10, align: 'center' as const },
    { lbl: ['Unit', 'Price'],      w: 18, align: 'right'  as const },
    { lbl: ['Taxable', 'Value'],   w: 18, align: 'right'  as const },
    { lbl: ['CGST', '%', 'Amount'], w: 17, align: 'center' as const },
    { lbl: ['SGST', '%', 'Amount'], w: 17, align: 'center' as const },
    { lbl: ['IGST', '%', 'Amount'], w: 17, align: 'center' as const },
    { lbl: ['Total'],              w: 15, align: 'right'  as const },
  ];
  // Compute x positions
  const TX: number[] = [];
  { let cx = M; TC.forEach(c => { TX.push(cx); cx += c.w; }); }

  const tHdrH = 11;
  const tRowH = 7;

  // Header
  setFill(doc, LG); doc.rect(M, y, CW, tHdrH, 'FD');
  setDraw(doc, BK); doc.setLineWidth(0.3);
  TC.forEach((c, i) => { if (i > 0) ln(TX[i], y, TX[i], y + tHdrH); });
  ln(PAGE_W - M, y, PAGE_W - M, y + tHdrH);

  TC.forEach((c, i) => {
    const cx = TX[i] + c.w / 2;
    const step = tHdrH / (c.lbl.length + 0.5);
    c.lbl.forEach((line, li) => {
      txt(line, c.align === 'right' ? TX[i] + c.w - 1 : c.align === 'center' ? cx : TX[i] + 1,
          y + step * (li + 1), { bold: true, size: 7, align: c.align });
    });
  });
  y += tHdrH;

  // Data rows
  let tQty = 0, tTax = 0, tCgst = 0, tSgst = 0, tIgst = 0, tTot = 0;
  (sale.lineItems || []).forEach((li: any, idx: number) => {
    const sub  = Number(li.lineSubtotal ?? (li.quantity * li.unitPrice));
    const tot  = sub + Number(li.taxAmount ?? 0);
    const cgst = Number(li.cgst ?? 0);
    const sgst = Number(li.sgst ?? 0);
    const igst = Number(li.igst ?? 0);
    const rate = li.taxRate ?? 0;
    const isIgst = li.taxType === 'igst' || igst > 0;
    tQty += Number(li.quantity); tTax += sub; tCgst += cgst;
    tSgst += sgst; tIgst += igst; tTot += tot;

    if (idx % 2 === 1) { setFill(doc, [248, 248, 248]); doc.rect(M, y, CW, tRowH, 'F'); }
    ln(M, y, PAGE_W - M, y, 0.15);
    TC.forEach((_, i) => { if (i > 0) ln(TX[i], y, TX[i], y + tRowH, 0.15); });
    ln(PAGE_W - M, y, PAGE_W - M, y + tRowH, 0.15);

    const ry = y + tRowH - 2;
    txt(String(idx + 1),                        TX[0] + TC[0].w / 2, ry, { size: 7.5, align: 'center' });
    txt(esc(li.itemName || `Item #${li.itemId}`), TX[1] + 1, ry, { size: 7.5 });
    txt(li.hsnCode ? esc(li.hsnCode) : '—',     TX[2] + TC[2].w / 2, ry, { size: 7.5, align: 'center' });
    txt(String(li.quantity),                     TX[3] + TC[3].w - 1, ry, { size: 7.5, align: 'right' });
    txt(li.unit || 'KG',                         TX[4] + TC[4].w / 2, ry, { size: 7.5, align: 'center' });
    txt(Number(li.unitPrice).toFixed(2),         TX[5] + TC[5].w - 1, ry, { size: 7.5, align: 'right' });
    txt(sub.toFixed(2),                          TX[6] + TC[6].w - 1, ry, { size: 7.5, align: 'right' });

    if (isIgst) {
      txt('—', TX[7] + TC[7].w / 2, ry, { size: 7.5, align: 'center' });
      txt('—', TX[8] + TC[8].w / 2, ry, { size: 7.5, align: 'center' });
      txt(`${rate}%`,        TX[9] + TC[9].w / 2, ry - 2, { size: 6.5, align: 'center' });
      txt(igst.toFixed(2),   TX[9] + TC[9].w / 2, ry + 1.5, { size: 6.5, align: 'center' });
    } else {
      txt(`${rate / 2}%`,    TX[7] + TC[7].w / 2, ry - 2, { size: 6.5, align: 'center' });
      txt(cgst.toFixed(2),   TX[7] + TC[7].w / 2, ry + 1.5, { size: 6.5, align: 'center' });
      txt(`${rate / 2}%`,    TX[8] + TC[8].w / 2, ry - 2, { size: 6.5, align: 'center' });
      txt(sgst.toFixed(2),   TX[8] + TC[8].w / 2, ry + 1.5, { size: 6.5, align: 'center' });
      txt('—',               TX[9] + TC[9].w / 2, ry, { size: 7.5, align: 'center' });
    }
    txt(tot.toFixed(2), TX[10] + TC[10].w - 1, ry, { size: 7.5, align: 'right' });
    y += tRowH;
  });

  // E&OE summary row
  ln(M, y, PAGE_W - M, y, 0.3);
  TC.forEach((_, i) => { if (i > 0) ln(TX[i], y, TX[i], y + tRowH, 0.3); });
  ln(PAGE_W - M, y, PAGE_W - M, y + tRowH, 0.3);
  const sr = y + tRowH - 2;
  txt('E&OE', TX[1] + 1, sr, { bold: true, size: 7.5 });
  txt(String(tQty),          TX[3] + TC[3].w - 1, sr, { bold: true, size: 7.5, align: 'right' });
  txt(tTax.toFixed(2),       TX[6] + TC[6].w - 1, sr, { bold: true, size: 7.5, align: 'right' });
  txt(tCgst.toFixed(2),      TX[7] + TC[7].w / 2, sr, { bold: true, size: 7.5, align: 'center' });
  txt(tSgst.toFixed(2),      TX[8] + TC[8].w / 2, sr, { bold: true, size: 7.5, align: 'center' });
  txt(tIgst > 0 ? tIgst.toFixed(2) : '—', TX[9] + TC[9].w / 2, sr, { bold: true, size: 7.5, align: 'center' });
  txt(tTot.toFixed(2),       TX[10] + TC[10].w - 1, sr, { bold: true, size: 7.5, align: 'right' });
  y += tRowH;
  ln(M, y, PAGE_W - M, y, 0.3);
  y += 2;

  // ── 5. Totals section (words left | discount/total right) ────────────────
  const grandTotal = Number(sale.totalAmount ?? 0);
  const discount   = Number(sale.discount ?? 0);
  const totSH = 22;

  bx(M, y, CW, totSH);
  ln(L2, y, L2, y + totSH);

  // Left: words
  txt('Invoice Value (In Words)', M + 2, y + 5.5, { bold: true, size: 7.5 });
  txt(`( ${toIndianWords(grandTotal)} )`, M + 2, y + 11, { size: 7.5, color: GR });
  txt('Certified that the Particulars given above are true and correct', M + 2, y + 19, { size: 7, color: GR });

  // Right: discount / round to / total
  const totRows: [string, string, boolean?][] = [];
  if (discount > 0) totRows.push(['Discount', discount.toFixed(2)]);
  totRows.push(['Round To', '0.00']);
  totRows.push(['Total', grandTotal.toFixed(2), true]);
  const trH = totSH / totRows.length;
  totRows.forEach(([label, val, bold], i) => {
    if (i > 0) ln(L2, y + i * trH, PAGE_W - M, y + i * trH, 0.1);
    const ry = y + i * trH + trH - 2;
    txt(label, L2 + 2, ry, { bold, size: bold ? 9 : 7.5 });
    txt(val, PAGE_W - M - 2, ry, { bold, size: bold ? 9 : 7.5, align: 'right' });
  });
  y += totSH;

  // ── 6. UPI QR section (full width, if available) ─────────────────────────
  if (qrDataUrl && outletUpiId) {
    const qrSize = 28;
    const qrBH   = qrSize + 10;
    bx(M, y, CW, qrBH);
    ln(L2, y, L2, y + qrBH);

    // Left text info
    txt('SCAN TO PAY (UPI)', M + 2, y + 5.5, { bold: true, size: 7.5 });
    txt(`UPI: ${outletUpiId}`,        M + 2, y + 11,   { size: 7, color: GR });
    txt(`Amount: ₹${grandTotal.toFixed(2)}`, M + 2, y + 16, { size: 7.5, bold: true });
    txt(`Ref: ${esc(sale.invoiceNumber)}`,   M + 2, y + 21, { size: 7, color: GR });
    // QR image (right of left column centre)
    doc.addImage(qrDataUrl, 'PNG', M + HW / 2, y + 1, qrSize, qrSize);

    // Right column: pay instruction
    txt('Scan QR code to pay instantly', L2 + 3, y + qrBH / 2, { size: 7.5, color: GR });
    y += qrBH;
  }

  // ── 7. Bank details / Authorised signature ───────────────────────────────
  const footH = 28;
  bx(M, y, CW, footH);
  ln(L2, y, L2, y + footH);

  txt('Bank Details :-', M + 2, y + 6, { bold: true, size: 7.5 });
  let by = y + 11;
  if (cs?.bankName)    { txt(`Bank Name: ${esc(cs.bankName)}`,    M + 2, by, { size: 7.5 }); by += 4.5; }
  if (cs?.bankAccount) { txt(`A/C No    : ${esc(cs.bankAccount)}`, M + 2, by, { size: 7.5 }); by += 4.5; }
  if (cs?.ifscCode)    { txt(`IFSC      : ${esc(cs.ifscCode)}`,   M + 2, by, { size: 7.5 }); }

  txt(companyName, PAGE_W - M - 3, y + 6, { bold: true, size: 8.5, align: 'right' });
  txt('Authorised Signatory', PAGE_W - M - 3, y + footH - 4, { size: 7.5, color: GR, align: 'right' });
  y += footH;

  // Footer note
  txt('This is a computer-generated invoice and does not require a physical signature.',
      PAGE_W / 2, y + 5, { size: 7, color: GR, align: 'center' });

  return doc;
}

export async function downloadInvoicePDF(sale: any, companySettings: any) {
  const doc = await buildInvoicePDFDoc(sale, companySettings);
  // Open in a new browser tab via blob URL so the PDF never touches the
  // Windows file system directly — avoids antivirus false-positive triggers
  // on jsPDF-generated content. The user can print/save from the browser's
  // own PDF viewer, which produces a clean OS-level file.
  const blob = doc.output('blob') as Blob;
  const blobUrl = URL.createObjectURL(blob);
  const newTab = window.open(blobUrl, '_blank', 'noopener');
  if (newTab) {
    // Revoke the blob URL after the new tab has had time to load the PDF
    newTab.addEventListener('load', () => URL.revokeObjectURL(blobUrl));
    setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
  } else {
    // Pop-up was blocked — fall back to direct save
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    doc.save(`Invoice-${esc(sale.invoiceNumber || String(sale.id))}.pdf`);
  }
}

/** Returns a Blob of the invoice PDF without downloading (used for WhatsApp file share). */
export async function generateInvoicePDFBlob(sale: any, companySettings: any): Promise<Blob> {
  return (await buildInvoicePDFDoc(sale, companySettings)).output('blob') as Blob;
}

// ── Payslip ───────────────────────────────────────────────────────────────────

export function downloadPayslipPDF(p: any, companySettings?: any) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  const MONTH_NAMES = ['January','February','March','April','May','June',
    'July','August','September','October','November','December'];
  const monthLabel = `${MONTH_NAMES[(p.month || 1) - 1]} ${p.year}`;

  let y = drawHeader(doc, companySettings ?? {}, 'PAYSLIP');

  // Pay period badge
  setFill(doc, TEAL);
  doc.roundedRect(MARGIN, y, 65, 8, 2, 2, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  setColor(doc, WHITE);
  doc.text(`Pay Period: ${monthLabel}`, MARGIN + 3, y + 5.5);
  y += 13;

  // Employee info grid
  setFill(doc, LIGHT);
  setDraw(doc, [200, 200, 200]);
  doc.setLineWidth(0.2);
  doc.rect(MARGIN, y, CONTENT_W, 20, 'FD');

  const leftInfoItems: [string, string][] = [
    ['Employee', esc(p.employeeName)],
    ['Branch',   esc(p.branchName)],
    ['Status',   p.isPaid ? 'PAID' : 'PENDING'],
  ];
  const rightInfoItems: [string, string][] = [
    ['Working Days', String(p.workingDays ?? '—')],
    ['Days Present', String(p.presentDays ?? '—')],
    ['LOP Days',     String(p.lopDays ?? 0)],
  ];

  doc.setFontSize(8);
  const colW = CONTENT_W / 2;
  for (let i = 0; i < leftInfoItems.length; i++) {
    const [k, v] = leftInfoItems[i];
    const iy = y + 5 + i * 5.5;
    doc.setFont('helvetica', 'normal');
    setColor(doc, MUTED);
    doc.text(k + ':', MARGIN + 3, iy);
    doc.setFont('helvetica', 'bold');
    if (k === 'Status') {
      setColor(doc, p.isPaid ? GREEN : RED);
    } else {
      setColor(doc, DARK);
    }
    doc.text(v, MARGIN + 33, iy);
  }
  for (let i = 0; i < rightInfoItems.length; i++) {
    const [k, v] = rightInfoItems[i];
    const iy = y + 5 + i * 5.5;
    doc.setFont('helvetica', 'normal');
    setColor(doc, MUTED);
    doc.text(k + ':', MARGIN + colW + 3, iy);
    doc.setFont('helvetica', 'bold');
    if (k === 'LOP Days' && Number(p.lopDays) > 0) {
      setColor(doc, RED);
    } else {
      setColor(doc, DARK);
    }
    doc.text(v, MARGIN + colW + 33, iy);
  }
  y += 24;

  // Earnings
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  setColor(doc, TEAL);
  doc.text('EARNINGS', MARGIN, y);
  y += 4;

  const earningRows: (string | number)[][] = [
    ['Basic Salary', fmt(p.baseSalary)],
  ];
  if (Number(p.lopDays) > 0) {
    earningRows.push([`Less: LOP (${p.lopDays} days)`, `-${fmt(p.lopDeduction)}`]);
  }
  for (const a of (p.allowancesBreakdown || [])) {
    earningRows.push([esc(a.name), fmt(a.amount)]);
  }
  earningRows.push(['Gross Pay', fmt(p.grossPay)]);

  y = drawTable(doc, y, [
    { header: 'Component', width: 140 },
    { header: 'Amount',    width: 40, align: 'right' },
  ], earningRows);
  y += 6;

  // Deductions
  if ((p.deductionsBreakdown || []).length > 0) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    setColor(doc, RED);
    doc.text('DEDUCTIONS', MARGIN, y);
    y += 4;

    const dedRows: (string | number)[][] = [
      ...(p.deductionsBreakdown || []).map((d: any) => [esc(d.name), fmt(d.amount)]),
      ['Total Deductions', fmt(p.deductions)],
    ];
    y = drawTable(doc, y, [
      { header: 'Component', width: 140 },
      { header: 'Amount',    width: 40, align: 'right' },
    ], dedRows, { headerBg: RED });
    y += 6;
  }

  // Net Pay box
  setFill(doc, TEAL);
  doc.roundedRect(MARGIN, y, CONTENT_W, 16, 3, 3, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  setColor(doc, WHITE);
  doc.text('NET PAY', MARGIN + 5, y + 10.5);
  doc.setFontSize(16);
  doc.text(fmt(p.netPay), PAGE_W - MARGIN - 5, y + 10.5, { align: 'right' });
  y += 24;

  // Signature lines
  const sigY = Math.max(y + 4, PAGE_H - 42);
  setDraw(doc, [150, 150, 150]);
  doc.setLineWidth(0.3);
  doc.line(MARGIN, sigY, MARGIN + 60, sigY);
  doc.line(PAGE_W - MARGIN - 60, sigY, PAGE_W - MARGIN, sigY);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  setColor(doc, MUTED);
  doc.text('Authorised Signatory', MARGIN, sigY + 4);
  doc.text("Employee's Signature", PAGE_W - MARGIN, sigY + 4, { align: 'right' });

  drawFooter(doc, 'This is a computer-generated payslip.');
  const safeName = esc(p.employeeName || 'Employee').replace(/[^a-zA-Z0-9-]/g, '_');
  doc.save(`Payslip-${safeName}-${p.year}-${String(p.month).padStart(2, '0')}.pdf`);
}

// ── Purchase Order ────────────────────────────────────────────────────────────

export function downloadPurchaseOrderPDF(
  po: any,
  companySettings: any,
  materialsMap: Map<number, string>,
  rawMaterialsMap: Map<number, string>,
) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  const cs = companySettings as any;
  let y = drawHeader(doc, cs, 'PURCHASE ORDER');

  const poNumber = `PO-${String(po.id).padStart(4, '0')}`;

  // PO + Vendor info box
  const infoH = 22;
  setFill(doc, LIGHT);
  setDraw(doc, [200, 200, 200]);
  doc.setLineWidth(0.2);
  doc.rect(MARGIN, y, CONTENT_W, infoH, 'FD');

  const colW = CONTENT_W / 2;
  const infoLeft: [string, string][] = [
    ['PO Number', poNumber],
    ['Date',      new Date(po.purchaseDate).toLocaleDateString('en-IN')],
    ['Ref Invoice', esc(po.invoiceNumber || '—')],
  ];
  const infoRight: [string, string][] = [
    ['Vendor',        esc(po.vendorName || '—')],
    ['Vendor GSTIN',  esc(po.vendorGstin || '—')],
    ['Total Amount',  fmt(po.totalAmount)],
  ];

  doc.setFontSize(8);
  for (let i = 0; i < infoLeft.length; i++) {
    const iy = y + 5.5 + i * 5.5;
    doc.setFont('helvetica', 'normal'); setColor(doc, MUTED);
    doc.text(infoLeft[i][0] + ':', MARGIN + 3, iy);
    doc.setFont('helvetica', 'bold'); setColor(doc, DARK);
    doc.text(infoLeft[i][1], MARGIN + 30, iy);
  }
  for (let i = 0; i < infoRight.length; i++) {
    const iy = y + 5.5 + i * 5.5;
    doc.setFont('helvetica', 'normal'); setColor(doc, MUTED);
    doc.text(infoRight[i][0] + ':', MARGIN + colW + 3, iy);
    doc.setFont('helvetica', 'bold'); setColor(doc, DARK);
    doc.text(infoRight[i][1], MARGIN + colW + 30, iy);
  }
  y += infoH + 5;

  // Line items table
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  setColor(doc, TEAL);
  doc.text('LINE ITEMS', MARGIN, y);
  y += 4;

  const poCols: TableCol[] = [
    { header: '#',         width: 8,  align: 'center' },
    { header: 'Type',      width: 22, align: 'center' },
    { header: 'Material',  width: 78 },
    { header: 'Qty',       width: 20, align: 'right' },
    { header: 'Unit Cost', width: 26, align: 'right' },
    { header: 'Amount',    width: 26, align: 'right' },
  ];

  const poRows = (po.lineItems || []).map((li: any, i: number) => {
    const name = li.materialType === 'raw_material'
      ? (rawMaterialsMap.get(Number(li.materialId)) || `Raw Mat. #${li.materialId}`)
      : (materialsMap.get(Number(li.materialId)) || `Material #${li.materialId}`);
    const typeLabel = li.materialType === 'raw_material' ? 'Raw Mat.' : 'Packaging';
    const amount = Number(li.quantity) * Number(li.unitCost);
    return [i + 1, typeLabel, esc(name), Number(li.quantity), fmt(li.unitCost), fmt(amount)];
  });

  y = drawTable(doc, y, poCols, poRows);
  y += 5;

  // Total box
  const totBoxW = 80;
  const totBoxX = PAGE_W - MARGIN - totBoxW;
  setFill(doc, TEAL);
  doc.roundedRect(totBoxX, y, totBoxW, 10, 2, 2, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  setColor(doc, WHITE);
  doc.text('Total:', totBoxX + 4, y + 7);
  doc.text(fmt(po.totalAmount), totBoxX + totBoxW - 3, y + 7, { align: 'right' });
  y += 16;

  // Notes
  if (po.notes) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    setColor(doc, MUTED);
    doc.text('NOTES', MARGIN, y);
    y += 4;
    doc.setFont('helvetica', 'normal');
    setColor(doc, DARK);
    const lines = doc.splitTextToSize(esc(po.notes), CONTENT_W);
    doc.text(lines, MARGIN, y);
    y += lines.length * 4.5 + 4;
  }

  // Signature lines
  const sigY = Math.max(y + 8, PAGE_H - 42);
  setDraw(doc, [150, 150, 150]);
  doc.setLineWidth(0.3);
  doc.line(MARGIN, sigY, MARGIN + 60, sigY);
  doc.line(PAGE_W - MARGIN - 60, sigY, PAGE_W - MARGIN, sigY);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  setColor(doc, MUTED);
  doc.text('Authorised by', MARGIN, sigY + 4);
  doc.text('Vendor Acknowledgement', PAGE_W - MARGIN, sigY + 4, { align: 'right' });

  drawFooter(doc, 'This is a computer-generated purchase order.');
  const safeName = esc(po.vendorName || 'Vendor').replace(/[^a-zA-Z0-9-]/g, '_');
  doc.save(`PO-${String(po.id).padStart(4, '0')}-${safeName}.pdf`);
}
