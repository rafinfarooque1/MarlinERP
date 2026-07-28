/**
 * Client-side PDF generation using jsPDF.
 * Two document types: Payslip, Purchase Order.
 * (Sales invoices are rendered server-side by the canonical renderer in
 *  api-server/src/services/invoicePdf.ts and served over HTTP.)
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

// ── Voucher (Journal / Contra / Credit Note / Debit Note / Payment / Receipt) ─

const VOUCHER_TITLES: Record<string, string> = {
  journal:     'JOURNAL VOUCHER',
  contra:      'CONTRA VOUCHER',
  credit_note: 'CREDIT NOTE',
  debit_note:  'DEBIT NOTE',
  payment:     'PAYMENT VOUCHER',
  receipt:     'RECEIPT VOUCHER',
};

export function downloadVoucherPDF(row: {
  voucherNumber: string;
  type: string;
  date: string;
  description: string;
  narration?: string;
  amount: number;
  raw: any;
}, companySettings?: any) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  const cs  = companySettings ?? {};
  const title = VOUCHER_TITLES[row.type] ?? 'VOUCHER';
  let y = drawHeader(doc, cs, title);

  // ── Voucher info box ──────────────────────────────────────────────────────
  const infoH = 18;
  setFill(doc, LIGHT);
  setDraw(doc, [200, 200, 200]);
  doc.setLineWidth(0.2);
  doc.rect(MARGIN, y, CONTENT_W, infoH, 'FD');

  const colW = CONTENT_W / 2;
  const left:  [string, string][] = [
    ['Voucher No.', esc(row.voucherNumber)],
    ['Date',        esc(row.date)],
  ];
  const right: [string, string][] = [
    ['Type',   title],
    ['Amount', fmt(row.amount)],
  ];

  doc.setFontSize(8);
  for (let i = 0; i < left.length; i++) {
    const iy = y + 5 + i * 6;
    doc.setFont('helvetica', 'normal'); setColor(doc, MUTED);
    doc.text(left[i][0] + ':', MARGIN + 3, iy);
    doc.setFont('helvetica', 'bold'); setColor(doc, DARK);
    doc.text(left[i][1], MARGIN + 28, iy);
  }
  for (let i = 0; i < right.length; i++) {
    const iy = y + 5 + i * 6;
    doc.setFont('helvetica', 'normal'); setColor(doc, MUTED);
    doc.text(right[i][0] + ':', MARGIN + colW + 3, iy);
    doc.setFont('helvetica', 'bold');
    setColor(doc, i === 1 ? TEAL : DARK);
    doc.text(right[i][1], MARGIN + colW + 28, iy);
  }
  y += infoH + 5;

  // ── Accounting entries ────────────────────────────────────────────────────
  const isJV = !['payment', 'receipt'].includes(row.type);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  setColor(doc, TEAL);
  doc.text('ACCOUNTING ENTRIES', MARGIN, y);
  y += 4;

  if (isJV) {
    const jvLines: any[] = row.raw?.lines ?? [];
    const tableRows = jvLines.map((l: any) => [
      esc(l.ledgerName || `Ledger #${l.ledgerId}`),
      Number(l.debit)  > 0 ? fmt(l.debit)  : '—',
      Number(l.credit) > 0 ? fmt(l.credit) : '—',
    ]);
    const drTotal = jvLines.reduce((s: number, l: any) => s + Number(l.debit  || 0), 0);
    const crTotal = jvLines.reduce((s: number, l: any) => s + Number(l.credit || 0), 0);
    tableRows.push(['', fmt(drTotal), fmt(crTotal)]);
    y = drawTable(doc, y, [
      { header: 'Account / Ledger', width: 130 },
      { header: 'Debit (Dr)',        width: 30, align: 'right' },
      { header: 'Credit (Cr)',       width: 20, align: 'right' },
    ], tableRows);
  } else {
    // Payment / Receipt: show From → To
    const raw = row.raw;
    const isPayment = row.type === 'payment';
    const fromName = isPayment ? (raw.paidFromName   || '—') : (raw.receivedFromName || '—');
    const toName   = isPayment ? (raw.paidToName     || '—') : (raw.receivedInName   || '—');
    y = drawTable(doc, y, [
      { header: 'Account / Ledger', width: 120 },
      { header: 'Role',              width: 30, align: 'center' },
      { header: 'Amount',            width: 30, align: 'right' },
    ], [
      [esc(fromName), isPayment ? 'Paid From' : 'Received From', fmt(row.amount)],
      [esc(toName),   isPayment ? 'Paid To'   : 'Received In',   fmt(row.amount)],
    ]);
  }
  y += 5;

  // ── Amount box ────────────────────────────────────────────────────────────
  setFill(doc, TEAL);
  doc.roundedRect(MARGIN, y, CONTENT_W, 12, 3, 3, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  setColor(doc, WHITE);
  doc.text('AMOUNT', MARGIN + 5, y + 8);
  doc.setFontSize(14);
  doc.text(fmt(row.amount), PAGE_W - MARGIN - 5, y + 8, { align: 'right' });
  y += 18;

  // ── Narration ─────────────────────────────────────────────────────────────
  const narration = row.narration || row.description || '';
  if (narration) {
    setFill(doc, LIGHT);
    setDraw(doc, [200, 200, 200]);
    doc.setLineWidth(0.2);
    const lines = doc.splitTextToSize(esc(narration), CONTENT_W - 6);
    const boxH  = Math.max(10, lines.length * 4.5 + 4);
    doc.rect(MARGIN, y, CONTENT_W, boxH, 'FD');
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8);
    setColor(doc, MUTED);
    doc.text('Narration:', MARGIN + 3, y + 4);
    doc.setFont('helvetica', 'normal');
    setColor(doc, DARK);
    doc.text(lines, MARGIN + 3, y + 8.5);
    y += boxH + 6;
  }

  // ── Signature lines ───────────────────────────────────────────────────────
  const sigY = Math.max(y + 10, PAGE_H - 42);
  setDraw(doc, [150, 150, 150]);
  doc.setLineWidth(0.3);
  doc.line(MARGIN, sigY, MARGIN + 60, sigY);
  doc.line(PAGE_W - MARGIN - 60, sigY, PAGE_W - MARGIN, sigY);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  setColor(doc, MUTED);
  doc.text('Prepared by', MARGIN, sigY + 4);
  doc.text('Authorised Signatory', PAGE_W - MARGIN, sigY + 4, { align: 'right' });

  drawFooter(doc, 'This is a computer-generated voucher.');
  const safeNum = row.voucherNumber.replace(/[^a-zA-Z0-9-]/g, '_');
  doc.save(`${safeNum}.pdf`);
}

// ── Employee Advance Voucher ───────────────────────────────────────────────────

export function downloadAdvancePDF(advance: {
  id: number;
  employeeName: string;
  amount: number;
  date: string;
  note?: string | null;
  isDeducted: boolean;
}, companySettings?: any) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  const cs  = companySettings ?? {};
  let y = drawHeader(doc, cs, 'ADVANCE VOUCHER');

  // ── Info box ──────────────────────────────────────────────────────────────
  const infoH = 24;
  setFill(doc, LIGHT);
  setDraw(doc, [200, 200, 200]);
  doc.setLineWidth(0.2);
  doc.rect(MARGIN, y, CONTENT_W, infoH, 'FD');

  const colW  = CONTENT_W / 2;
  const left:  [string, string][] = [
    ['Employee', esc(advance.employeeName)],
    ['Date',     esc(advance.date)],
    ['Ref No.',  `ADV-${String(advance.id).padStart(4, '0')}`],
  ];
  const right: [string, string][] = [
    ['Amount',  fmt(advance.amount)],
    ['Status',  advance.isDeducted ? 'Recovered from Payroll' : 'Pending Recovery'],
  ];

  doc.setFontSize(8);
  for (let i = 0; i < left.length; i++) {
    const iy = y + 5 + i * 6;
    doc.setFont('helvetica', 'normal'); setColor(doc, MUTED);
    doc.text(left[i][0] + ':', MARGIN + 3, iy);
    doc.setFont('helvetica', 'bold'); setColor(doc, DARK);
    doc.text(left[i][1], MARGIN + 28, iy);
  }
  for (let i = 0; i < right.length; i++) {
    const iy = y + 5 + i * 6;
    doc.setFont('helvetica', 'normal'); setColor(doc, MUTED);
    doc.text(right[i][0] + ':', MARGIN + colW + 3, iy);
    doc.setFont('helvetica', 'bold');
    setColor(doc, i === 0 ? TEAL : (advance.isDeducted ? GREEN : RED));
    doc.text(right[i][1], MARGIN + colW + 28, iy);
  }
  y += infoH + 5;

  // ── Accounting entry note ──────────────────────────────────────────────────
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  setColor(doc, TEAL);
  doc.text('ACCOUNTING ENTRY', MARGIN, y);
  y += 4;

  y = drawTable(doc, y, [
    { header: 'Account',  width: 120 },
    { header: 'Role',     width: 30, align: 'center' },
    { header: 'Amount',   width: 30, align: 'right' },
  ], [
    [`Advance — ${esc(advance.employeeName)}`, 'Debit (Dr)', fmt(advance.amount)],
    ['Cash',                                    'Credit (Cr)', fmt(advance.amount)],
  ]);
  y += 5;

  // ── Amount box ────────────────────────────────────────────────────────────
  setFill(doc, TEAL);
  doc.roundedRect(MARGIN, y, CONTENT_W, 12, 3, 3, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  setColor(doc, WHITE);
  doc.text('ADVANCE AMOUNT', MARGIN + 5, y + 8);
  doc.setFontSize(14);
  doc.text(fmt(advance.amount), PAGE_W - MARGIN - 5, y + 8, { align: 'right' });
  y += 18;

  // ── Note ──────────────────────────────────────────────────────────────────
  if (advance.note) {
    setFill(doc, LIGHT);
    setDraw(doc, [200, 200, 200]);
    doc.setLineWidth(0.2);
    const noteLines = doc.splitTextToSize(esc(advance.note), CONTENT_W - 6);
    const boxH = Math.max(10, noteLines.length * 4.5 + 4);
    doc.rect(MARGIN, y, CONTENT_W, boxH, 'FD');
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8);
    setColor(doc, MUTED);
    doc.text('Reason / Note:', MARGIN + 3, y + 4);
    doc.setFont('helvetica', 'normal');
    setColor(doc, DARK);
    doc.text(noteLines, MARGIN + 3, y + 8.5);
    y += boxH + 6;
  }

  // ── Signature lines ───────────────────────────────────────────────────────
  const sigY = Math.max(y + 10, PAGE_H - 42);
  setDraw(doc, [150, 150, 150]);
  doc.setLineWidth(0.3);
  doc.line(MARGIN, sigY, MARGIN + 60, sigY);
  doc.line(PAGE_W - MARGIN - 60, sigY, PAGE_W - MARGIN, sigY);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  setColor(doc, MUTED);
  doc.text('Authorised Signatory', MARGIN, sigY + 4);
  doc.text("Employee's Signature", PAGE_W - MARGIN, sigY + 4, { align: 'right' });

  drawFooter(doc, 'This is a computer-generated advance voucher.');
  const safeName = esc(advance.employeeName).replace(/[^a-zA-Z0-9-]/g, '_');
  doc.save(`Advance-${safeName}-${advance.date}.pdf`);
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
    // Prefer the server-enriched materialName; fall back to client-side maps.
    const fallback = li.materialType === 'raw_material'
      ? (rawMaterialsMap.get(Number(li.materialId)) || `Packing Mat. #${li.materialId}`)
      : li.materialType === 'item'
        ? `Item #${li.materialId}`
        : (materialsMap.get(Number(li.materialId)) || `Material #${li.materialId}`);
    const name = li.materialName || fallback;
    const typeLabel = li.materialType === 'raw_material' ? 'Packing Material' : li.materialType === 'item' ? 'Item Name (SKU)' : 'Raw Material';
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
