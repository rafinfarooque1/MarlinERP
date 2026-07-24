/** Export an array of objects as a CSV file download. */
export function downloadCSV(filename: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]);
  const escape = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [keys.join(','), ...rows.map(r => keys.map(k => escape(r[k])).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Open a print window with HTML content (for PDF-like output). */
export function printHTML(html: string, title = 'Print') {
  const w = window.open('', '_blank', 'width=960,height=800');
  if (!w) return;
  w.document.write(`<!DOCTYPE html><html><head><title>${title}</title>
    <style>
      * { box-sizing: border-box; }
      body { font-family: Arial, sans-serif; font-size: 11px; color: #111; padding: 18px 24px; margin: 0; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border: 1px solid #555; padding: 5px 7px; text-align: left; vertical-align: top; }
      th { background: #e8e8e8; font-weight: bold; text-align: center; }
      .no-border td, .no-border th { border: none; padding: 2px 4px; }
      .outer { border: 2px solid #333; }
      h2 { margin: 0; font-size: 18px; text-align: center; }
      h3 { margin: 0; font-size: 13px; text-align: center; }
      .center { text-align: center; }
      .right { text-align: right; }
      .bold { font-weight: bold; }
      .small { font-size: 10px; }
      .label { color: #555; font-size: 10px; }
      @media print { body { padding: 8px; } }
    </style>
    </head><body>${html}<script>window.onload=()=>window.print()</script></body></html>`);
  w.document.close();
}

/**
 * POST JSON data to an authenticated API endpoint that returns a PDF,
 * then download the file and open it in a new browser tab.
 *
 * Opens a blank window synchronously (before the async fetch) so popup
 * blockers don't interfere, then steers it to the blob URL once ready.
 */
export async function downloadPDFFromEndpoint(
  endpoint: string,
  data: unknown,
  filename: string,
): Promise<void> {
  const win = window.open('about:blank', '_blank');
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(data),
    });
    if (!resp.ok) {
      win?.close();
      const err: any = await resp.json().catch(() => ({}));
      throw new Error(err?.error || `PDF generation failed (${resp.status})`);
    }
    const blob = await resp.blob();
    const url  = URL.createObjectURL(blob);
    // Download
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    // Display
    if (win && !win.closed) win.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 15_000);
  } catch (e) {
    win?.close();
    throw e;
  }
}

/** Convert a number to Indian words (e.g. 1020 → "One Thousand And Twenty Only") */
export function numberToWords(amount: number): string {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  function inWords(n: number): string {
    if (n === 0) return '';
    if (n < 20) return ones[n];
    if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '');
    if (n < 1000) return ones[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' And ' + inWords(n % 100) : '');
    if (n < 100000) return inWords(Math.floor(n / 1000)) + ' Thousand' + (n % 1000 ? ' ' + inWords(n % 1000) : '');
    if (n < 10000000) return inWords(Math.floor(n / 100000)) + ' Lakh' + (n % 100000 ? ' ' + inWords(n % 100000) : '');
    return inWords(Math.floor(n / 10000000)) + ' Crore' + (n % 10000000 ? ' ' + inWords(n % 10000000) : '');
  }

  const rupees = Math.floor(Math.abs(amount));
  const paise = Math.round((Math.abs(amount) - rupees) * 100);
  let result = inWords(rupees) || 'Zero';
  if (paise > 0) result += ' And ' + inWords(paise) + ' Paise';
  return 'Rupees ' + result + ' Only';
}

/** Build a professional GST Invoice HTML (matching standard B2C/B2B format) */
export function buildGstInvoiceHtml(opts: {
  cs: any;          // company settings
  sale: any;        // sale record with lineItems
  invoiceType?: string;
  qrDataUrl?: string; // optional UPI QR code data URL
}): string {
  const { cs, sale, qrDataUrl } = opts;
  const invoiceType = sale.customerGstin ? 'GST INVOICE B2B' : 'GST INVOICE B2C';
  const dateStr = new Date(sale.saleDate).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: '2-digit' });

  const lineRows = (sale.lineItems || []).map((li: any, i: number) => {
    const taxable = Number(li.lineSubtotal ?? (li.quantity * li.unitPrice));
    const cgstRate = li.taxRate ? Number(li.taxRate) / 2 : 0;
    const sgstRate = cgstRate;
    const igstRate = li.igst > 0 ? Number(li.taxRate ?? 0) : 0;
    const cgst = Number(li.cgst ?? 0);
    const sgst = Number(li.sgst ?? 0);
    const igst = Number(li.igst ?? 0);
    const lineTotal = taxable + cgst + sgst + igst;
    return `<tr>
      <td class="center">${i + 1}</td>
      <td>${li.itemName || `Item #${li.itemId}`}</td>
      <td class="center">${li.hsnCode || '—'}</td>
      <td class="center">${li.quantity}</td>
      <td class="center">${li.unit || 'KG'}</td>
      <td class="right">${Number(li.unitPrice).toFixed(2)}</td>
      <td class="right">${taxable.toFixed(2)}</td>
      ${igst > 0
        ? `<td class="center" colspan="2">—</td><td class="center">${igstRate}%<br/>${igst.toFixed(2)}</td>`
        : `<td class="center">${cgstRate}%<br/>${cgst.toFixed(2)}</td><td class="center">${sgstRate}%<br/>${sgst.toFixed(2)}</td><td class="center">—</td>`
      }
      <td class="right bold">${lineTotal.toFixed(2)}</td>
    </tr>`;
  }).join('');

  const subtotal = Number(sale.subtotal ?? 0);
  const taxTotal = Number(sale.taxTotal ?? 0);
  const grandTotal = Number(sale.totalAmount ?? 0);
  const roundOff = Number((grandTotal - Math.floor(grandTotal + 0.5) < 0.01 ? grandTotal - Math.round(grandTotal) : 0).toFixed(2));
  const discount = Number(sale.discountAmount ?? 0);
  const itemCount = (sale.lineItems || []).reduce((s: number, l: any) => s + Number(l.quantity), 0);

  const cgstTotal = (sale.lineItems || []).reduce((s: number, l: any) => s + Number(l.cgst ?? 0), 0);
  const sgstTotal = (sale.lineItems || []).reduce((s: number, l: any) => s + Number(l.sgst ?? 0), 0);
  const igstTotal = (sale.lineItems || []).reduce((s: number, l: any) => s + Number(l.igst ?? 0), 0);

  const hasIgst = igstTotal > 0;
  const amtInWords = numberToWords(grandTotal);

  return `
  <table class="outer">
    <tr><td colspan="2" style="border-bottom:2px solid #333;padding:10px 12px">
      <h2>${cs?.companyName || 'Tax Invoice'}</h2>
      <div class="center small">${cs?.address || ''}${cs?.state ? ', ' + cs.state : ''}${cs?.pincode ? ' - ' + cs.pincode : ''}</div>
      <table class="no-border" style="margin-top:6px">
        <tr>
          <td class="label">E-Mail &nbsp;: ${cs?.email || ''}</td>
          <td class="center bold" style="font-size:13px">${invoiceType}</td>
          <td class="right label">Phone : ${cs?.phone || ''}</td>
        </tr>
      </table>
    </td></tr>

    <tr>
      <td style="width:50%;border-right:1px solid #555">
        <table class="no-border">
          <tr><td class="label" style="width:200px">GST Number</td><td>: &nbsp;<strong>${cs?.gstNumber || ''}</strong></td></tr>
          <tr><td class="label">Invoice Number</td><td>: &nbsp;<strong>${sale.invoiceNumber}</strong></td></tr>
          <tr><td class="label">Invoice Date</td><td>: &nbsp;${dateStr}</td></tr>
          <tr><td class="label">Tax Payable on Reverse Charge</td><td>: &nbsp;No</td></tr>
        </table>
      </td>
      <td style="width:50%">
        <table class="no-border">
          <tr><td class="label" style="width:180px">Transportation Mode</td><td>:</td></tr>
          <tr><td class="label">Vehicle Number</td><td>:</td></tr>
          <tr><td class="label">Date &amp; Time of Supply</td><td>: &nbsp;${dateStr}</td></tr>
          <tr><td class="label">Place of Supply</td><td>: &nbsp;${cs?.state || ''}</td></tr>
        </table>
      </td>
    </tr>

    <tr>
      <td style="border-right:1px solid #555;border-top:1px solid #555">
        <div class="bold small" style="margin-bottom:4px">Details of Receiver (Billed to)</div>
        <table class="no-border">
          <tr><td class="label" style="width:80px">Name</td><td>: &nbsp;<strong>${sale.customerName || 'Walk-in Customer'}</strong></td></tr>
          <tr><td class="label">Address</td><td>: &nbsp;${(sale as any).customerAddress || sale.outletName || ''}</td></tr>
          <tr><td></td><td></td></tr>
          <tr><td class="label">State</td><td>: &nbsp;${(sale as any).customerState || cs?.state || ''} &nbsp;&nbsp; <span class="label">State Code :</span> ${(sale as any).customerStateCode || ''}</td></tr>
          <tr><td class="label">Mobile No.</td><td>: &nbsp;${(sale as any).customerMobile || ''}</td></tr>
          <tr><td class="label">GST No</td><td>: &nbsp;${(sale as any).customerGstin || ''}</td></tr>
        </table>
      </td>
      <td style="border-top:1px solid #555">
        <div class="bold small" style="margin-bottom:4px">Details of Consignee (Shipped to)</div>
        <table class="no-border">
          <tr><td class="label" style="width:80px">Name</td><td>: &nbsp;<strong>${sale.customerName || 'Walk-in Customer'}</strong></td></tr>
          <tr><td class="label">Address</td><td>: &nbsp;${(sale as any).customerAddress || sale.outletName || ''}</td></tr>
          <tr><td></td><td></td></tr>
          <tr><td class="label">State</td><td>: &nbsp;${(sale as any).customerState || cs?.state || ''}</td></tr>
        </table>
      </td>
    </tr>

    <tr><td colspan="2" style="padding:0;border-top:1px solid #555">
      <table>
        <thead>
          <tr>
            <th style="width:28px">Sl<br/>No</th>
            <th>Description of Goods</th>
            <th style="width:60px">Hsn Code<br/>(GST)</th>
            <th style="width:36px">Qty</th>
            <th style="width:36px">Unit</th>
            <th style="width:60px">Unit<br/>Price</th>
            <th style="width:65px">Taxable<br/>Value</th>
            <th style="width:60px">CGST<br/>% &nbsp; Amount</th>
            <th style="width:60px">SGST<br/>% &nbsp; Amount</th>
            <th style="width:60px">IGST<br/>% &nbsp; Amount</th>
            <th style="width:68px">Total</th>
          </tr>
        </thead>
        <tbody>${lineRows}</tbody>
        <tfoot>
          <tr style="background:#f5f5f5">
            <td></td><td class="bold">E&amp;OE</td>
            <td></td>
            <td class="center bold">${itemCount}</td>
            <td></td><td></td>
            <td class="right bold">${subtotal.toFixed(2)}</td>
            <td class="right bold">${hasIgst ? '—' : cgstTotal.toFixed(2)}</td>
            <td class="right bold">${hasIgst ? '—' : sgstTotal.toFixed(2)}</td>
            <td class="right bold">${hasIgst ? igstTotal.toFixed(2) : '—'}</td>
            <td class="right bold">${grandTotal.toFixed(2)}</td>
          </tr>
        </tfoot>
      </table>
    </td></tr>

    <tr><td colspan="2" style="padding:0;border-top:1px solid #555">
      <table class="no-border">
        <tr>
          <td style="width:55%;vertical-align:top;border-right:1px solid #ccc;padding:8px">
            <div class="bold small">Invoice Value (In Words)</div>
            <div style="margin-top:4px">( ${amtInWords} )</div>
            <div class="small label" style="margin-top:8px">Certified that the Particulars given above are true and correct</div>
          </td>
          <td style="width:45%;padding:8px">
            <table class="no-border" style="width:100%">
              <tr><td>Discount</td><td class="right">${discount.toFixed(2)}</td></tr>
              <tr><td>Round To</td><td class="right">${roundOff !== 0 ? roundOff.toFixed(2) : '0.00'}</td></tr>
              <tr style="border-top:1px solid #555"><td class="bold" style="font-size:13px">Total</td><td class="right bold" style="font-size:13px">${grandTotal.toFixed(2)}</td></tr>
            </table>
          </td>
        </tr>
      </table>
    </td></tr>

    <tr><td colspan="2" style="padding:0;border-top:1px solid #555">
      <table class="no-border">
        <tr>
          <td style="width:${qrDataUrl ? '38%' : '55%'};vertical-align:top;border-right:1px solid #ccc;padding:8px">
            <div class="bold small" style="margin-bottom:4px">Bank Details :-</div>
            ${cs?.bankName ? `<div>Bank Name: ${cs.bankName}</div>` : ''}
            ${cs?.bankAccount ? `<div>A/C No &nbsp;&nbsp;: ${cs.bankAccount}</div>` : ''}
            ${cs?.ifscCode ? `<div>IFSC &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;: ${cs.ifscCode}</div>` : ''}
          </td>
          ${qrDataUrl ? `
          <td style="width:24%;vertical-align:top;border-right:1px solid #ccc;padding:6px;text-align:center">
            <div class="bold small" style="color:#0d9488;margin-bottom:4px;font-size:8px;letter-spacing:0.5px">SCAN TO PAY (UPI)</div>
            <img src="${qrDataUrl}" style="width:100px;height:100px;display:block;margin:0 auto" alt="UPI QR" />
            <div style="font-size:8px;color:#666;margin-top:3px;word-break:break-all">${(sale as any).outletUpiId || ''}</div>
            <div style="font-size:10px;font-weight:bold;margin-top:2px">₹${Number(sale.totalAmount).toFixed(2)}</div>
            <div style="font-size:7px;color:#999">${sale.invoiceNumber || ''}</div>
          </td>` : ''}
          <td style="width:${qrDataUrl ? '38%' : '45%'};padding:8px;text-align:right">
            <div class="bold" style="margin-bottom:4px">${cs?.companyName || ''}</div>
            <div style="margin-top:40px" class="label">Authorised Signatory</div>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>`;
}

/** Build a professional Delivery Challan HTML */
export function buildChallanHtml(opts: {
  cs: any;
  challanNo: string;
  date: string;
  fromName: string;
  fromType: string;
  toName: string;
  toType: string;
  lineItems: Array<{ name: string; hsnCode?: string; quantity: number; unit?: string }>;
  isInterstate?: boolean;
  status?: string;
  notes?: string;
  approvedBy?: string;
}): string {
  const { cs, challanNo, date, fromName, fromType, toName, toType, lineItems, isInterstate, status, notes, approvedBy } = opts;
  const statusLabel = status === 'completed' ? 'APPROVED' : status === 'in_transit' ? 'IN TRANSIT' : status === 'rejected' ? 'REJECTED' : (status || '').toUpperCase();

  const lineRows = lineItems.map((li, i) => `
    <tr>
      <td class="center">${i + 1}</td>
      <td>${li.name}</td>
      <td class="center">${li.hsnCode || '—'}</td>
      <td class="center">${li.quantity}</td>
      <td class="center">${li.unit || '—'}</td>
      <td></td>
    </tr>`).join('');

  const totalQty = lineItems.reduce((s, l) => s + Number(l.quantity), 0);

  return `
  <table class="outer">
    <tr><td style="border-bottom:2px solid #333;padding:10px 12px">
      <h2>${cs?.companyName || 'Delivery Challan'}</h2>
      <div class="center small">${cs?.address || ''}${cs?.state ? ', ' + cs.state : ''}${cs?.pincode ? ' - ' + cs.pincode : ''}</div>
      ${cs?.phone ? `<div class="center small label">Phone: ${cs.phone}${cs?.email ? ' &nbsp;|&nbsp; Email: ' + cs.email : ''}</div>` : ''}
      <h3 style="margin-top:8px;letter-spacing:2px">DELIVERY CHALLAN</h3>
    </td></tr>

    <tr><td style="padding:0;border-bottom:1px solid #555">
      <table class="no-border">
        <tr>
          <td style="width:50%;border-right:1px solid #ccc;padding:8px">
            <table class="no-border">
              <tr><td class="label" style="width:120px">Challan No.</td><td>: &nbsp;<strong>${challanNo}</strong></td></tr>
              <tr><td class="label">Date</td><td>: &nbsp;${date}</td></tr>
              <tr><td class="label">Status</td><td>: &nbsp;<strong>${statusLabel}</strong></td></tr>
              ${isInterstate ? `<tr><td class="label">Type</td><td>: &nbsp;<strong>Interstate</strong></td></tr>` : ''}
            </table>
          </td>
          <td style="width:50%;padding:8px">
            <table class="no-border">
              <tr><td class="label" style="width:80px">From</td><td>: &nbsp;<strong>${fromName}</strong> <span class="label">(${fromType})</span></td></tr>
              <tr><td class="label">To</td><td>: &nbsp;<strong>${toName}</strong> <span class="label">(${toType})</span></td></tr>
              ${notes ? `<tr><td class="label">Notes</td><td>: &nbsp;${notes}</td></tr>` : ''}
              ${approvedBy ? `<tr><td class="label">Approved by</td><td>: &nbsp;${approvedBy}</td></tr>` : ''}
            </table>
          </td>
        </tr>
      </table>
    </td></tr>

    <tr><td style="padding:0">
      <table>
        <thead>
          <tr>
            <th style="width:32px">Sl No</th>
            <th>Description of Goods</th>
            <th style="width:70px">HSN Code</th>
            <th style="width:50px">Qty</th>
            <th style="width:50px">Unit</th>
            <th>Remarks</th>
          </tr>
        </thead>
        <tbody>${lineRows}</tbody>
        <tfoot>
          <tr style="background:#f5f5f5">
            <td></td><td class="bold">Total</td><td></td>
            <td class="center bold">${totalQty}</td>
            <td></td><td></td>
          </tr>
        </tfoot>
      </table>
    </td></tr>

    <tr><td style="padding:0;border-top:1px solid #555">
      <table class="no-border">
        <tr>
          <td style="width:50%;border-right:1px solid #ccc;padding:30px 12px 12px">
            <div class="label small">Receiver's Signature &amp; Stamp</div>
            <div style="margin-top:4px" class="small label">Name: _____________________ &nbsp; Date: ___________</div>
          </td>
          <td style="width:50%;padding:12px;text-align:right">
            <div class="bold">${cs?.companyName || ''}</div>
            <div style="margin-top:40px" class="label">Authorised Signatory</div>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>`;
}
