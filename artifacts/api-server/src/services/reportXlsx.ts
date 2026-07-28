/**
 * Excel (.xlsx) renderer for Reports Center exports.
 *
 * Deliberately mirrors services/reportPdf.ts: same payload, same sections, same
 * company header read server-side. A report that prints one way and exports
 * another is a support ticket waiting to happen, so the two renderers take the
 * identical input shape and differ only in output format.
 *
 * Unlike the PDF renderer this keeps numbers as numbers. The point of an Excel
 * export is that the recipient can sum a column; shipping "Rs. 1,23,456.00" as
 * text would defeat the entire feature.
 */
import ExcelJS from "exceljs";
import type { ReportPdfInput } from "./reportPdf";

const BRAND = "FF0B7285";      // slate-teal header fill
const BRAND_TEXT = "FFFFFFFF";
const SUBTLE = "FFF1F5F9";

/** Strip the currency decoration the PDF path adds so Excel sees a number.
 *  Returns the original string when it is genuinely text. */
function coerce(v: string | number): string | number {
  if (typeof v === "number") return v;
  const s = String(v ?? "").trim();
  if (!s || s === "—" || s === "-") return "";
  // "Rs. 1,23,456.00" | "₹1,23,456.00" | "(1,234.00)" | "-1,234.00" | "12.5%"
  const cleaned = s
    .replace(/^Rs\.?\s*/i, "")
    .replace(/^₹\s*/, "")
    .replace(/,/g, "")
    .trim();
  const neg = /^\((.*)\)$/.exec(cleaned);
  const body = neg ? neg[1] : cleaned;
  if (/^-?\d+(\.\d+)?$/.test(body)) {
    const n = Number(body);
    return neg ? -n : n;
  }
  return s;
}

export function generateReportXlsx(input: ReportPdfInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = input.cs?.companyName ?? "Marlin Frozen Fruits";
  const ws = wb.addWorksheet(input.title.slice(0, 28) || "Report", {
    views: [{ state: "frozen", ySplit: 0 }],
    pageSetup: { orientation: input.orientation === "landscape" ? "landscape" : "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  const widest = Math.max(1, ...input.sections.map((s) => s.columns.length));
  let row = 1;

  const merge = (text: string, opts: { size?: number; bold?: boolean; color?: string } = {}) => {
    ws.mergeCells(row, 1, row, widest);
    const c = ws.getCell(row, 1);
    c.value = text;
    c.font = { size: opts.size ?? 11, bold: opts.bold ?? false, color: { argb: opts.color ?? "FF0F172A" } };
    c.alignment = { horizontal: "left", vertical: "middle" };
    row += 1;
  };

  // ── Letterhead ───────────────────────────────────────────────────────────
  const cs = input.cs;
  if (cs?.companyName) merge(cs.companyName, { size: 15, bold: true });
  const addr = [cs?.address, cs?.city, cs?.state, cs?.pincode].filter(Boolean).join(", ");
  if (addr) merge(addr, { size: 9, color: "FF64748B" });
  const contact = [cs?.gstNumber ? `GSTIN: ${cs.gstNumber}` : "", cs?.phone, cs?.email].filter(Boolean).join("  •  ");
  if (contact) merge(contact, { size: 9, color: "FF64748B" });
  if (cs?.companyName) row += 1;

  merge(input.title, { size: 13, bold: true });
  if (input.subtitle) merge(input.subtitle, { size: 10, color: "FF475569" });

  for (const [k, v] of input.metaRows ?? []) {
    ws.getCell(row, 1).value = k;
    ws.getCell(row, 1).font = { size: 9, bold: true, color: { argb: "FF475569" } };
    ws.getCell(row, 2).value = v;
    ws.getCell(row, 2).font = { size: 9, color: { argb: "FF475569" } };
    row += 1;
  }
  row += 1;

  // ── Sections ─────────────────────────────────────────────────────────────
  const colWidths: number[] = [];
  const note = (i: number, len: number) => { colWidths[i] = Math.max(colWidths[i] ?? 10, Math.min(46, len + 3)); };

  for (const section of input.sections) {
    if (section.heading) {
      merge(section.heading, { size: 11, bold: true });
    }

    const headerRow = ws.getRow(row);
    section.columns.forEach((c, i) => {
      const cell = headerRow.getCell(i + 1);
      cell.value = c.label;
      cell.font = { bold: true, size: 10, color: { argb: BRAND_TEXT } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BRAND } };
      cell.alignment = { horizontal: c.align === "right" ? "right" : c.align === "center" ? "center" : "left", vertical: "middle", wrapText: true };
      cell.border = { bottom: { style: "thin", color: { argb: "FFCBD5E1" } } };
      note(i, c.label.length);
    });
    headerRow.height = 20;
    const headerRowNumber = row;
    row += 1;

    for (const r of section.rows) {
      const dataRow = ws.getRow(row);
      r.forEach((v, i) => {
        const cell = dataRow.getCell(i + 1);
        const val = coerce(v);
        cell.value = val;
        const align = section.columns[i]?.align;
        cell.alignment = { horizontal: align === "right" ? "right" : align === "center" ? "center" : "left" };
        if (typeof val === "number") cell.numFmt = "#,##0.00";
        cell.font = { size: 10 };
        note(i, String(v ?? "").length);
      });
      row += 1;
    }

    if (section.totalsRow) {
      const totalRow = ws.getRow(row);
      section.totalsRow.forEach((v, i) => {
        const cell = totalRow.getCell(i + 1);
        const val = coerce(v);
        cell.value = val;
        const align = section.columns[i]?.align;
        cell.alignment = { horizontal: align === "right" ? "right" : align === "center" ? "center" : "left" };
        if (typeof val === "number") cell.numFmt = "#,##0.00";
        cell.font = { size: 10, bold: true };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: SUBTLE } };
        cell.border = { top: { style: "thin", color: { argb: "FF94A3B8" } } };
        note(i, String(v ?? "").length);
      });
      row += 1;
    }

    // Filters on the header make a long report usable in Excel.
    if (section.rows.length > 0) {
      ws.autoFilter = {
        from: { row: headerRowNumber, column: 1 },
        to: { row: headerRowNumber + section.rows.length, column: section.columns.length },
      };
    }
    row += 1;
  }

  if (input.footerNote) merge(input.footerNote, { size: 9, color: "FF64748B" });

  colWidths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  return wb.xlsx.writeBuffer().then((b) => Buffer.from(b as ArrayBuffer));
}
