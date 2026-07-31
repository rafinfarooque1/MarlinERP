/**
 * Shared print/PDF toolkit for Marlin ERP business documents.
 *
 * Both the browser (purchase invoice) and the server (payslip) build documents
 * with jsPDF, and both used to carry their own copy of the page frame, the
 * palette, the money formatter and the amount-in-words routine. They had
 * drifted: different brand colours, different currency rendering, and only one
 * of them could paginate. This module is the single source for all of that, so
 * a change to the house style reaches every document.
 *
 * The palette matches the canonical sales invoice renderer, which is the
 * document customers already receive.
 */
import type { jsPDF } from "jspdf";

// ── Brand ────────────────────────────────────────────────────────────────────

export type RGB = [number, number, number];

export const NAVY: RGB = [13, 42, 83];
export const TEAL: RGB = [14, 85, 105];
export const WHITE: RGB = [255, 255, 255];
export const LGRAY: RGB = [245, 247, 250];
export const MGRAY: RGB = [122, 134, 150];
export const BORDER: RGB = [200, 210, 220];
export const BK: RGB = [20, 20, 20];
export const GREEN: RGB = [22, 120, 74];
export const RED: RGB = [178, 40, 40];
export const AMBER: RGB = [166, 104, 12];

// ── A4 geometry, in millimetres ──────────────────────────────────────────────

export const PW = 210;
export const PH = 297;
export const M = 14;
export const CW = PW - M * 2;

// ── Typeface ─────────────────────────────────────────────────────────────────

export const FONT = "Roboto";

let fontCache: { regular: string; bold: string } | null = null;

/**
 * Registers the embedded typeface on a document.
 *
 * The font module is ~450 kB of base64 and is imported dynamically so it stays
 * out of the main browser bundle — it is fetched the first time someone
 * generates a PDF and cached for the rest of the session.
 */
export async function registerFonts(doc: jsPDF): Promise<void> {
  if (!fontCache) {
    const m = await import("./fonts.js");
    fontCache = { regular: m.ROBOTO_REGULAR_B64, bold: m.ROBOTO_BOLD_B64 };
  }
  doc.addFileToVFS("Roboto-Regular.ttf", fontCache.regular);
  doc.addFont("Roboto-Regular.ttf", FONT, "normal");
  doc.addFileToVFS("Roboto-Bold.ttf", fontCache.bold);
  doc.addFont("Roboto-Bold.ttf", FONT, "bold");
  doc.setFont(FONT, "normal");
}

// ── Script face (invoice footer sign-off) ────────────────────────────────────

export const SCRIPT_FONT = "GreatVibes";

let scriptCache: string | null = null;

/**
 * Registers the calligraphic script face used for the invoice's
 * "Thank You For Your Business!" sign-off. Separate from registerFonts and
 * dynamically imported so the ~600 kB face is only ever loaded by the
 * server-side renderer, never the browser bundle.
 */
export async function registerScriptFont(doc: jsPDF): Promise<void> {
  if (!scriptCache) {
    const m = await import("./fonts-script.js");
    scriptCache = m.GREAT_VIBES_B64;
  }
  doc.addFileToVFS("GreatVibes-Regular.ttf", scriptCache);
  doc.addFont("GreatVibes-Regular.ttf", SCRIPT_FONT, "normal");
}

// ── Formatting ───────────────────────────────────────────────────────────────

/** Indian digit grouping: 6,33,194.00 — lakhs and crores, not thousands. */
export function inGrouping(value: number, dp = 2): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return dp > 0 ? (0).toFixed(dp) : "0";
  return Math.abs(n).toLocaleString("en-IN", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

/** Money with the real rupee sign. Safe only with the embedded font. */
export function inr(value: number, dp = 2): string {
  const n = Number(value) || 0;
  return `${n < 0 ? "-" : ""}\u20B9${inGrouping(n, dp)}`;
}

/** Quantities: up to 3 decimals, trailing zeros dropped, grouped Indian-style. */
export function qty(value: number): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  const rounded = Math.round(n * 1000) / 1000;
  const dp = Number.isInteger(rounded) ? 0 : String(rounded).split(".")[1]?.length ?? 0;
  return `${n < 0 ? "-" : ""}${inGrouping(rounded, Math.min(dp, 3))}`;
}

/**
 * DD-MMM-YYYY, e.g. 30-Jul-2026.
 *
 * Accepts the DATE columns as they arrive from pg (a JS Date), plus plain
 * YYYY-MM-DD text. A YYYY-MM-DD string is split by hand rather than passed to
 * the Date constructor, which would read it as UTC midnight and print the
 * previous day for anyone east of Greenwich.
 */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function dateIN(value: unknown, dash = "-"): string {
  if (value == null || value === "") return dash;
  if (typeof value === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
    if (m) return `${m[3]}-${MONTHS[Number(m[2]) - 1] ?? "?"}-${m[1]}`;
  }
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return dash;
  return `${String(d.getDate()).padStart(2, "0")}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
}

/** Indian-system amount in words, including paise. */
export function amountInWords(value: number): string {
  // Normalise to whole paise *before* splitting. Flooring the rupees first and
  // rounding the remainder separately reads 1.999 as one rupee and a hundred
  // paise, which is both wrong and unspellable.
  const totalPaise = Math.round(Math.abs(Number(value) || 0) * 100);
  const rupees = Math.floor(totalPaise / 100);
  const paise = totalPaise % 100;

  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
    "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
    "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  const two = (x: number): string =>
    x < 20 ? ones[x] : `${tens[Math.floor(x / 10)]}${x % 10 ? " " + ones[x % 10] : ""}`;
  const three = (x: number): string =>
    x >= 100 ? `${ones[Math.floor(x / 100)]} Hundred${x % 100 ? " " + two(x % 100) : ""}` : two(x);

  const words = (n: number): string => {
    if (n === 0) return "Zero";
    const parts: string[] = [];
    const crore = Math.floor(n / 10000000);
    const lakh = Math.floor((n % 10000000) / 100000);
    const thousand = Math.floor((n % 100000) / 1000);
    const rest = n % 1000;
    if (crore) parts.push(`${words(crore)} Crore`);
    if (lakh) parts.push(`${three(lakh)} Lakh`);
    if (thousand) parts.push(`${three(thousand)} Thousand`);
    if (rest) parts.push(three(rest));
    return parts.join(" ");
  };

  const sign = Number(value) < 0 ? "Minus " : "";
  const head = `${sign}${words(rupees)} Rupees`;
  return paise > 0 ? `${head} and ${two(paise)} Paise Only` : `${head} Only`;
}

// ── Drawing primitives ───────────────────────────────────────────────────────

export interface TextOpts {
  size?: number;
  bold?: boolean;
  color?: RGB;
  align?: "left" | "center" | "right";
}

/** Thin wrapper that keeps font/size/colour handling out of the documents. */
export class Painter {
  constructor(public readonly doc: jsPDF) {}

  txt(s: string, x: number, y: number, o?: TextOpts): void {
    const d = this.doc;
    d.setFont(FONT, o?.bold ? "bold" : "normal");
    d.setFontSize(o?.size ?? 8);
    const c = o?.color ?? BK;
    d.setTextColor(c[0], c[1], c[2]);
    d.text(s, x, y, { align: o?.align ?? "left" });
  }

  fill(x: number, y: number, w: number, h: number, rgb: RGB): void {
    this.doc.setFillColor(rgb[0], rgb[1], rgb[2]);
    this.doc.rect(x, y, w, h, "F");
  }

  box(x: number, y: number, w: number, h: number, rgb: RGB = BORDER, lw = 0.2): void {
    this.doc.setDrawColor(rgb[0], rgb[1], rgb[2]);
    this.doc.setLineWidth(lw);
    this.doc.rect(x, y, w, h);
  }

  line(x1: number, y1: number, x2: number, y2: number, rgb: RGB = BORDER, lw = 0.2): void {
    this.doc.setDrawColor(rgb[0], rgb[1], rgb[2]);
    this.doc.setLineWidth(lw);
    this.doc.line(x1, y1, x2, y2);
  }

  /** Wraps to `w` at the given size, so callers can measure before drawing. */
  wrap(s: string, w: number, size: number, bold = false): string[] {
    this.doc.setFont(FONT, bold ? "bold" : "normal");
    this.doc.setFontSize(size);
    return this.doc.splitTextToSize(s || "", w) as string[];
  }

  /**
   * Makes a single line fit a fixed width: shrink a little, then ellipsize.
   *
   * A table cell that must stay on one line — a date, a code, a money figure —
   * has no wrapping to save it, so without this it silently draws straight over
   * the next column. Returns the size it settled on; the caller must draw with
   * it, not with the size it asked for.
   */
  fit(s: string, w: number, size: number, bold = false, floor = 1.6): { text: string; size: number } {
    const d = this.doc;
    d.setFont(FONT, bold ? "bold" : "normal");
    d.setFontSize(size);
    if (d.getTextWidth(s) <= w) return { text: s, size };
    for (let sz = size - 0.25; sz >= size - floor; sz -= 0.25) {
      d.setFontSize(sz);
      if (d.getTextWidth(s) <= w) return { text: s, size: sz };
    }
    const sz = Math.max(size - floor, 4);
    d.setFontSize(sz);
    let t = s;
    while (t.length > 1 && d.getTextWidth(`${t}\u2026`) > w) t = t.slice(0, -1);
    // A column can be narrower than a single character plus the ellipsis. Give
    // back something that fits rather than something that runs into its
    // neighbour: the bare ellipsis, or nothing at all.
    const clipped = `${t}\u2026`;
    if (d.getTextWidth(clipped) <= w) return { text: clipped, size: sz };
    if (d.getTextWidth("\u2026") <= w) return { text: "\u2026", size: sz };
    return { text: "", size: sz };
  }

  /** A label above a value, the pattern used by every info block. */
  field(label: string, value: string, x: number, y: number, size = 8): void {
    this.txt(label, x, y, { size: 5.8, color: MGRAY });
    this.txt(value, x, y + 4, { size, bold: true });
  }
}

// ── Flowing table ────────────────────────────────────────────────────────────

export interface Col {
  header: string;
  /** Millimetres. The caller is responsible for making these sum to the width. */
  width: number;
  align?: "left" | "right" | "center";
  /**
   * Long text wraps onto extra lines. On by default; set it false for cells
   * that must stay on one line (dates, money) — those are shrunk to fit
   * instead. Either way a cell can never draw over its neighbour.
   */
  wrap?: boolean;
}

export interface FlowTableOpts {
  x?: number;
  width?: number;
  /** Lowest y a row may occupy. Rows that would cross it move to a new page. */
  bottomLimit: number;
  /** Called after each page break; returns the y to resume drawing at. */
  onNewPage: () => number;
  fontSize?: number;
  headerFill?: RGB;
  headerColor?: RGB;
  zebra?: boolean;
  minRowH?: number;
}

/**
 * Draws a table that flows across as many pages as it needs.
 *
 * The header is repeated on every page and a row is never split down the middle
 * — if it does not fit in the space that is left, the whole row moves to the
 * next page. Row height follows the tallest wrapped cell, so long product names
 * push the row taller rather than colliding with the next column.
 */
export function flowTable(
  p: Painter,
  startY: number,
  cols: Col[],
  rows: string[][],
  opts: FlowTableOpts,
): number {
  const x0 = opts.x ?? M;
  const width = opts.width ?? CW;
  const fs = opts.fontSize ?? 7.2;
  const lineH = fs * 0.42 + 1.2;
  const padY = 1.5;
  const minRowH = opts.minRowH ?? 6;
  const headerH = 7;

  let y = startY;

  const drawHeader = (): void => {
    p.fill(x0, y, width, headerH, opts.headerFill ?? NAVY);
    let cx = x0;
    for (const c of cols) {
      const tx = c.align === "right" ? cx + c.width - 1.5
        : c.align === "center" ? cx + c.width / 2
        : cx + 1.5;
      const h = p.fit(c.header, c.width - 3, fs - 0.4, true);
      p.txt(h.text, tx, y + headerH - 2.4, {
        size: h.size, bold: true, color: opts.headerColor ?? WHITE, align: c.align ?? "left",
      });
      cx += c.width;
    }
    y += headerH;
  };

  drawHeader();
  const tableTop = startY;
  let sectionTop = tableTop;
  let zebraIndex = 0;

  for (const row of rows) {
    // Measure first: the row's height is set by its tallest wrapped cell.
    // Non-wrapping cells are shrunk to their column instead of overflowing.
    const cells = cols.map((c, i) => {
      const raw = String(row[i] ?? "");
      if (c.wrap === false) {
        const f = p.fit(raw, c.width - 3, fs);
        return { lines: [f.text], size: f.size };
      }
      return { lines: p.wrap(raw, c.width - 3, fs), size: fs };
    });
    const measure = () =>
      Math.max(minRowH, Math.max(...cells.map(c => c.lines.length)) * lineH + padY * 2);
    let rowH = measure();

    if (y + rowH > opts.bottomLimit) {
      // Close the section's outline before leaving the page.
      p.box(x0, sectionTop, width, y - sectionTop, BORDER, 0.25);
      y = opts.onNewPage();
      sectionTop = y;
      drawHeader();
      zebraIndex = 0;
    }

    // A single row can be taller than a whole page — an unbounded note, or a
    // product name with no spaces to wrap on. Moving it to a fresh page does
    // not help, so clamp it to the space that is actually there and mark the
    // cut. Without this the surplus lines are drawn past the bottom edge.
    if (y + rowH > opts.bottomLimit) {
      const maxLines = Math.max(1, Math.floor((opts.bottomLimit - y - padY * 2) / lineH));
      for (const cell of cells) {
        if (cell.lines.length > maxLines) {
          cell.lines = cell.lines.slice(0, maxLines);
          cell.lines[maxLines - 1] = `${cell.lines[maxLines - 1]}\u2026`;
        }
      }
      rowH = Math.min(measure(), Math.max(minRowH, opts.bottomLimit - y));
    }

    if ((opts.zebra ?? true) && zebraIndex % 2 === 1) p.fill(x0, y, width, rowH, LGRAY);

    let cx = x0;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      const tx = c.align === "right" ? cx + c.width - 1.5
        : c.align === "center" ? cx + c.width / 2
        : cx + 1.5;
      const { lines, size } = cells[i];
      for (let li = 0; li < lines.length; li++) {
        p.txt(lines[li], tx, y + padY + lineH * (li + 1) - 1, { size, align: c.align ?? "left" });
      }
      cx += c.width;
    }

    p.line(x0, y + rowH, x0 + width, y + rowH, [225, 231, 238], 0.1);
    y += rowH;
    zebraIndex++;
  }

  p.box(x0, sectionTop, width, y - sectionTop, BORDER, 0.25);

  // Column separators, drawn per page section so they never cross a page break.
  let cx = x0;
  for (let i = 0; i < cols.length - 1; i++) {
    cx += cols[i].width;
    p.line(cx, sectionTop, cx, y, BORDER, 0.15);
  }

  return y;
}

// ── Page numbering ───────────────────────────────────────────────────────────

/**
 * Stamps "Page X of Y" plus the computer-generated note on every page.
 *
 * Run this last: the total is only known once the document is complete.
 */
export function stampFooters(doc: jsPDF, note: string): void {
  const p = new Painter(doc);
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    p.line(M, PH - 11, PW - M, PH - 11, BORDER, 0.3);
    p.txt(note, M, PH - 7, { size: 6.2, color: MGRAY });
    p.txt(`Page ${i} of ${total}`, PW - M, PH - 7, { size: 6.2, color: MGRAY, align: "right" });
  }
}
