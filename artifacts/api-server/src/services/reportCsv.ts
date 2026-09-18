import type { ReportPdfInput } from "./reportPdf";

/** RFC 4180 quoting plus spreadsheet-formula neutralisation for TEXT cells.
 * Real negative numeric values remain numeric; never coerce account identifiers.
 */
export function csvCell(value: string | number): string {
  let text = String(value);
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Non-finite report number");
  if (typeof value === "string" && /^[\s]*[=+\-@\t\r]/.test(value)) text = `'${value}`;
  return `"${text.replace(/"/g, '""')}"`;
}
export function generateReportCsv(input: ReportPdfInput): Buffer {
  const rows: (string | number)[][] = [[input.title]];
  if (input.subtitle) rows.push([input.subtitle]);
  rows.push(...input.metaRows ?? []);
  for (const section of input.sections) {
    rows.push([]);
    if (section.heading) rows.push([section.heading]);
    rows.push(section.columns.map(c => c.label), ...section.rows);
    if (section.totalsRow) rows.push(section.totalsRow);
  }
  if (input.footerNote) rows.push([], [input.footerNote]);
  return Buffer.from("\uFEFF" + rows.map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n", "utf8");
}