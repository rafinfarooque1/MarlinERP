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
  const w = window.open('', '_blank', 'width=900,height=700');
  if (!w) return;
  w.document.write(`<!DOCTYPE html><html><head><title>${title}</title>
    <style>body{font-family:sans-serif;padding:32px}table{border-collapse:collapse;width:100%}
    th,td{border:1px solid #ccc;padding:8px 12px;text-align:left}th{background:#f0f0f0}
    h2{margin:0 0 8px}p{margin:4px 0;color:#555}.total{font-size:1.2em;font-weight:bold;margin-top:16px}</style>
    </head><body>${html}<script>window.onload=()=>window.print()</script></body></html>`);
  w.document.close();
}
