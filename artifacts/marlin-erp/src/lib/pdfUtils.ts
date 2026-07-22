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

// ── Tax Invoice ───────────────────────────────────────────────────────────────

function buildInvoicePDFDoc(sale: any, companySettings: any): jsPDF {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const cs = companySettings as any;
  let y = drawHeader(doc, cs, 'TAX INVOICE');

  // ── Invoice meta box ──
  const metaH = 14;
  setFill(doc, LIGHT);
  setDraw(doc, [200, 200, 200]);
  doc.setLineWidth(0.2);
  doc.rect(MARGIN, y, CONTENT_W, metaH, 'FD');
  doc.setFontSize(8);

  const metaItems: [string, string, number, number][] = [
    ['Invoice No', esc(sale.invoiceNumber || '—'), MARGIN + 3, y + 5],
    ['Date', new Date(sale.saleDate).toLocaleDateString('en-IN'), MARGIN + 3, y + 10],
    ['Outlet', esc(sale.outletName || '—'), MARGIN + CONTENT_W / 2 + 3, y + 5],
    ['Payment', esc((sale.paymentMode || '').replace('_', ' ').toUpperCase()), MARGIN + CONTENT_W / 2 + 3, y + 10],
  ];
  for (const [k, v, mx, my] of metaItems) {
    doc.setFont('helvetica', 'normal');
    setColor(doc, MUTED);
    doc.text(k + ':', mx, my);
    doc.setFont('helvetica', 'bold');
    setColor(doc, DARK);
    doc.text(v, mx + 26, my);
  }
  y += metaH + 3;

  // ── Bill-to ──
  const customer = esc(sale.customerName || 'Walk-in Customer');
  setFill(doc, [240, 255, 250]);
  setDraw(doc, [190, 225, 210]);
  doc.setLineWidth(0.3);
  doc.rect(MARGIN, y, CONTENT_W, 12, 'FD');
  doc.setFontSize(7.5);
  doc.setFont('helvetica', 'normal');
  setColor(doc, MUTED);
  doc.text('BILL TO', MARGIN + 2, y + 4.5);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  setColor(doc, DARK);
  doc.text(customer, MARGIN + 2, y + 10);
  if (sale.customerGstin) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    setColor(doc, MUTED);
    doc.text(`GSTIN: ${esc(sale.customerGstin)}`, MARGIN + 70, y + 10);
  }
  y += 16;

  // ── Line items table ──
  const cols: TableCol[] = [
    { header: '#',           width: 7,  align: 'center' },
    { header: 'Item / HSN',  width: 44 },
    { header: 'GST%',        width: 13, align: 'center' },
    { header: 'Qty',         width: 12, align: 'right' },
    { header: 'Unit Price',  width: 22, align: 'right' },
    { header: 'Taxable',     width: 22, align: 'right' },
    { header: 'CGST',        width: 14, align: 'right' },
    { header: 'SGST',        width: 14, align: 'right' },
    { header: 'IGST',        width: 14, align: 'right' },
    { header: 'Total',       width: 18, align: 'right' },
  ];

  const lineRows = (sale.lineItems || []).map((li: any, i: number) => {
    const name        = esc(li.itemName || `Item #${li.itemId}`);
    const hsn         = li.hsnCode ? ` (HSN:${esc(li.hsnCode)})` : '';
    const lineSubtotal = li.lineSubtotal ?? (li.quantity * li.unitPrice);
    const total        = Number(lineSubtotal) + Number(li.taxAmount ?? 0);
    return [
      i + 1,
      name + hsn,
      `${li.taxRate ?? 0}%`,
      li.quantity,
      fmt(li.unitPrice),
      fmt(lineSubtotal),
      (li.cgst ?? 0) > 0 ? fmt(li.cgst) : '—',
      (li.sgst ?? 0) > 0 ? fmt(li.sgst) : '—',
      (li.igst ?? 0) > 0 ? fmt(li.igst) : '—',
      fmt(total),
    ];
  });

  y = drawTable(doc, y, cols, lineRows, { fontSize: 7.5 });
  y += 5;

  // ── Totals ──
  const totBoxW = 78;
  const totBoxX = PAGE_W - MARGIN - totBoxW;
  const hasCgst = (sale.lineItems || []).some((li: any) => (li.cgst ?? 0) > 0);
  const hasIgst = (sale.lineItems || []).some((li: any) => (li.igst ?? 0) > 0);

  const totals: [string, string, boolean?][] = [
    ['Subtotal', fmt(sale.subtotal ?? 0)],
  ];
  if (hasCgst) {
    const cgst = (sale.lineItems || []).reduce((s: number, li: any) => s + Number(li.cgst ?? 0), 0);
    const sgst = (sale.lineItems || []).reduce((s: number, li: any) => s + Number(li.sgst ?? 0), 0);
    totals.push(['CGST', fmt(cgst)], ['SGST', fmt(sgst)]);
  }
  if (hasIgst) {
    const igst = (sale.lineItems || []).reduce((s: number, li: any) => s + Number(li.igst ?? 0), 0);
    totals.push(['IGST', fmt(igst)]);
  }
  totals.push(['Grand Total', fmt(sale.totalAmount ?? 0), true]);

  const totRowH = 7;
  const totH = totals.length * totRowH + 2;
  setFill(doc, LIGHT);
  setDraw(doc, [200, 200, 200]);
  doc.setLineWidth(0.25);
  doc.rect(totBoxX, y, totBoxW, totH, 'FD');

  let ty = y + 5;
  for (const [label, val, isBold] of totals) {
    if (isBold) {
      setFill(doc, TEAL);
      doc.rect(totBoxX, ty - 5, totBoxW, totRowH, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      setColor(doc, WHITE);
    } else {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      setColor(doc, DARK);
    }
    doc.text(label, totBoxX + 3, ty);
    doc.text(val, totBoxX + totBoxW - 3, ty, { align: 'right' });
    ty += totRowH;
  }
  y += totH + 8;

  // ── Bank details (left of totals) ──
  if (cs?.bankName || cs?.bankAccount) {
    const bankY = y - totH - 8 + 2;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    setColor(doc, MUTED);
    doc.text('BANK DETAILS', MARGIN, bankY);
    doc.setFont('helvetica', 'normal');
    setColor(doc, DARK);
    let by = bankY + 4.5;
    if (cs.bankName)    { doc.text(`Bank: ${esc(cs.bankName)}`, MARGIN, by); by += 4; }
    if (cs.bankAccount) { doc.text(`A/c: ${esc(cs.bankAccount)}`, MARGIN, by); by += 4; }
    if (cs.ifscCode)    { doc.text(`IFSC: ${esc(cs.ifscCode)}`, MARGIN, by); }
  }

  drawFooter(doc, 'This is a computer-generated invoice and does not require a physical signature.');
  return doc;
}

export function downloadInvoicePDF(sale: any, companySettings: any) {
  buildInvoicePDFDoc(sale, companySettings)
    .save(`Invoice-${esc(sale.invoiceNumber || String(sale.id))}.pdf`);
}

/** Returns a Blob of the invoice PDF without downloading (used for WhatsApp file share). */
export function generateInvoicePDFBlob(sale: any, companySettings: any): Blob {
  return buildInvoicePDFDoc(sale, companySettings).output('blob') as Blob;
}

// ── Payslip ───────────────────────────────────────────────────────────────────

export function downloadPayslipPDF(p: any, companySettings?: any) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
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
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
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
