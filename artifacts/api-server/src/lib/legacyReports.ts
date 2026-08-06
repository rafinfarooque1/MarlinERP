/**
 * Old-software report converters.
 *
 * The owner's previous software exports five report families (Payment,
 * Receipt, Item-wise Sales, Item-wise Purchase, Day Book) whose layout the
 * normal import parser cannot read: banner rows above the header (the real
 * header usually sits on row 6), DD-MM-YY two-digit-year dates, unit-group
 * separator rows inside the sales report, and a Tally-style day book where
 * the date lives on section rows and one voucher's legs span several rows.
 *
 * This module DETECTS that layout (the sample templates never match its
 * signatures) and converts the sheet into the exact { rowNumber, values }
 * records the existing per-module validators consume — the validate → map →
 * demo → approve pipeline downstream runs unchanged. Detection failing means
 * "not an old-software report": the caller falls through to the normal
 * sample-template parser, which keeps working as-is.
 *
 * Self-contained on purpose: it duplicates the few tiny cell/date helpers
 * instead of importing them from routes/imports.ts (no route↔lib cycle).
 */
import type ExcelJS from "exceljs";

// ── Result types ─────────────────────────────────────────────────────────────

export interface LegacyConversionMeta {
  detected: true;
  /** Human label of the recognised report, e.g. "Item-wise Sales report". */
  report: string;
  /** Spreadsheet row the real header was found on. */
  headerRow: number;
  /** Converted data rows fed into validation. */
  keptRows: number;
  /** Separator/total/blank-ish rows dropped by the converter. */
  droppedRows: number;
  /** Plain-language notes about what the conversion did. */
  notes: string[];
  /** Day book only: voucher types excluded because their own files cover them. */
  excluded?: Array<{ type: string; vouchers: number }>;
}

export interface LegacyParsedRow { rowNumber: number; values: Record<string, string> }

export type LegacyConvertResult =
  | { parsed: LegacyParsedRow[]; conversion: LegacyConversionMeta }
  | { error: string }
  | null; // not an old-software report — use the normal parser

// ── Tiny local helpers (duplicated from the import route by design) ─────────

/** lower-case and strip everything that is not a letter or digit. */
const normHeader = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** lower/trim/squeeze — the same key the mapping memory uses. */
const normName = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");

/** exceljs cell values can be rich objects — flatten to a trimmed string. */
function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as any;
    if (typeof o.text === "string") return o.text.trim();
    if (Array.isArray(o.richText)) return o.richText.map((r: any) => r.text ?? "").join("").trim();
    if (o.result !== undefined) return cellText(o.result);
    if (o.hyperlink && typeof o.hyperlink === "string") return String(o.text ?? o.hyperlink).trim();
  }
  return String(v).trim();
}

/** YYYY-MM-DD (real Date cells) or DD-MM-YY[YY] with -/. or / separators → ISO. */
function toIsoDate(s: string): string | null {
  const t = (s ?? "").trim();
  if (!t) return null;
  let y: number, m: number, d: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (iso) { y = +iso[1]; m = +iso[2]; d = +iso[3]; }
  else {
    const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(t);
    if (!dmy) return null;
    d = +dmy[1]; m = +dmy[2]; y = +dmy[3];
    if (y < 100) y += 2000;
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Loose numeric parse for report cells (₹/comma/space slack). null = blank/NaN. */
function num(s: string): number | null {
  const t = (s ?? "").replace(/[₹,\s]/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

interface HeaderCol { col: number; raw: string; norm: string }

/** Find the first row within the banner zone whose cells carry ALL the
 *  required normalised header tokens. Sample templates never match these
 *  signatures (they carry no SlNo / Vch Name columns). */
function findHeaderRow(
  ws: ExcelJS.Worksheet, required: string[], maxScan = 15,
): { headerRow: number; cols: HeaderCol[] } | null {
  const last = Math.min(maxScan, ws.rowCount);
  for (let rn = 1; rn <= last; rn++) {
    const row = ws.getRow(rn);
    const cols: HeaderCol[] = [];
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const raw = cellText(cell.value);
      const norm = normHeader(raw);
      if (norm) cols.push({ col: colNumber, raw, norm });
    });
    const norms = new Set(cols.map((c) => c.norm));
    if (required.every((r) => norms.has(r))) return { headerRow: rn, cols };
  }
  return null;
}

const colOf = (cols: HeaderCol[], ...norms: string[]): number | null => {
  for (const n of norms) {
    const hit = cols.find((c) => c.norm === n);
    if (hit) return hit.col;
  }
  return null;
};

/** GST columns: "CGST%" and "CGST" both normalise to "cgst" — the raw '%'
 *  character is the only discriminator between the rate and amount columns. */
function gstCols(cols: HeaderCol[]): {
  pct: Partial<Record<"cgst" | "sgst" | "igst", number>>;
  amt: Partial<Record<"cgst" | "sgst" | "igst", number>>;
} {
  const pct: any = {}, amt: any = {};
  for (const c of cols) {
    if (c.norm !== "cgst" && c.norm !== "sgst" && c.norm !== "igst") continue;
    if (c.raw.includes("%")) pct[c.norm] = c.col;
    else amt[c.norm] = c.col;
  }
  return { pct, amt };
}

const txt = (row: ExcelJS.Row, col: number | null): string =>
  col == null ? "" : cellText(row.getCell(col).value);

/** A data row of the tabular reports: SlNo is a plain integer. Banner text,
 *  unit-group separators and "Total" tail rows never carry one. */
const isDataSlNo = (s: string) => /^\d+$/.test(s.trim());

const isRowBlank = (row: ExcelJS.Row): boolean => {
  let any = false;
  row.eachCell({ includeEmpty: false }, (cell) => { if (cellText(cell.value)) any = true; });
  return !any;
};

// ── Sales report ─────────────────────────────────────────────────────────────
// Columns: SlNo | Date | Invoice No | Party Name | Item Name | Qty | Rate |
// Amount | CGST% | CGST | SGST% | SGST | IGST% | IGST | UNIT.
// Rate is PRE-tax; Amount is the GST-INCLUSIVE line total. Rows sit inside
// unit-group sections whose separator/total rows carry no SlNo.

function convertSales(ws: ExcelJS.Worksheet): LegacyConvertResult {
  const hdr = findHeaderRow(ws, ["slno", "date", "invoiceno", "partyname", "itemname", "qty", "rate", "amount", "unit"]);
  if (!hdr) return null;
  const { cols, headerRow } = hdr;
  const c = {
    slno: colOf(cols, "slno"), date: colOf(cols, "date"), inv: colOf(cols, "invoiceno"),
    party: colOf(cols, "partyname"), item: colOf(cols, "itemname"), qty: colOf(cols, "qty"),
    rate: colOf(cols, "rate"), amount: colOf(cols, "amount"), unit: colOf(cols, "unit"),
  };
  const gst = gstCols(cols);

  const parsed: LegacyParsedRow[] = [];
  let dropped = 0, walkIns = 0, badDates = 0;
  // The old software restarts invoice numbering (per month/series), so the
  // same "Invoice No" can name several different bills. The ERP pipeline
  // groups lines by invoice number alone — disambiguate by (number, date,
  // customer): the first bill keeps the number, later ones get "/2", "/3"…
  // Rows of one bill can sit in DIFFERENT unit-group sections, so this must
  // be a lookup, not a consecutive-run check.
  const invoiceAliases = new Map<string, Array<{ date: string; party: string; alias: string }>>();
  let renumbered = 0;
  for (let rn = headerRow + 1; rn <= ws.rowCount; rn++) {
    const row = ws.getRow(rn);
    if (isRowBlank(row)) continue;
    if (!isDataSlNo(txt(row, c.slno)) || !txt(row, c.item)) { dropped++; continue; }

    const qty = num(txt(row, c.qty));
    const amount = num(txt(row, c.amount));
    const rateRaw = txt(row, c.rate);
    // The report's Amount is the inclusive line total — the ERP's Price
    // column is the inclusive per-unit price, so derive it from Amount.
    const price = amount != null && qty != null && qty > 0 ? String(r2(amount / qty)) : rateRaw;

    const pct = (["cgst", "sgst", "igst"] as const)
      .map((k) => num(txt(row, gst.pct[k] ?? null)) ?? 0)
      .reduce((a, b) => a + b, 0);

    const iso = toIsoDate(txt(row, c.date));
    if (!iso) badDates++;

    const party = txt(row, c.party);
    const walkIn = normName(party) === "walking customer";
    if (walkIn) walkIns++;

    const invRaw = txt(row, c.inv);
    const dateKey = iso ?? txt(row, c.date);
    const partyKey = walkIn ? "" : normName(party);
    let invoiceNo = invRaw;
    if (invRaw) {
      const variants = invoiceAliases.get(invRaw) ?? [];
      const hit = variants.find((v) => v.date === dateKey && v.party === partyKey);
      if (hit) {
        invoiceNo = hit.alias;
      } else {
        invoiceNo = variants.length === 0 ? invRaw : `${invRaw}/${variants.length + 1}`;
        if (variants.length > 0) renumbered++;
        variants.push({ date: dateKey, party: partyKey, alias: invoiceNo });
        invoiceAliases.set(invRaw, variants);
      }
    }

    parsed.push({
      rowNumber: rn,
      values: {
        invoiceNo,
        date: iso ?? txt(row, c.date),
        party: walkIn ? "" : party,
        item: txt(row, c.item),
        quantity: txt(row, c.qty),
        unit: txt(row, c.unit),
        price,
        lineTotal: amount != null ? String(amount) : "",
        gstRate: pct > 0 ? String(r2(pct)) : "",
        cgst: txt(row, gst.amt.cgst ?? null),
        sgst: txt(row, gst.amt.sgst ?? null),
        igst: txt(row, gst.amt.igst ?? null),
        // Walk-ins settle in cash on the spot; named customers import as
        // credit sales so the Receipt report settles them afterwards.
        paymentMode: walkIn ? "Cash" : "Credit",
      },
    });
  }

  const notes = [
    "The report's Rate column is pre-tax — the GST-inclusive Amount column was used for line totals (Price = Amount ÷ Qty).",
    `${dropped} unit-group separator/total rows were dropped.`,
    walkIns > 0 ? `${walkIns} WALKING CUSTOMER rows import as walk-in cash sales; all other sales import as credit so the Receipt report can settle them.` : "All sales import as credit so the Receipt report can settle them.",
  ];
  if (renumbered > 0) notes.push(`The old software reused ${renumbered} invoice number(s) for different bills (different date or customer) — those bills were renumbered with a "/2", "/3"… suffix so each stays a separate invoice.`);
  if (badDates > 0) notes.push(`${badDates} rows carry a date the converter could not read — they will show as errors below.`);
  return {
    parsed,
    conversion: { detected: true, report: "Item-wise Sales report", headerRow, keptRows: parsed.length, droppedRows: dropped, notes },
  };
}

// ── Purchase report ──────────────────────────────────────────────────────────
// Columns: SlNo | Invoice No | IDate | Party | Item Name | Rate | Qty |
// SGST% | SGST | CGST% | CGST | IGST% | IGST | Amount.
// Rate is GST-EXCLUSIVE (exactly what the ERP's purchase Rate column means),
// so it maps straight through; Amount (inclusive) is deliberately NOT emitted
// — the pipeline recomputes and cross-checks GST from the masters instead.

function convertPurchases(ws: ExcelJS.Worksheet): LegacyConvertResult {
  const hdr = findHeaderRow(ws, ["slno", "invoiceno", "idate", "party", "itemname", "rate", "qty", "amount"]);
  if (!hdr) return null;
  const { cols, headerRow } = hdr;
  const c = {
    slno: colOf(cols, "slno"), inv: colOf(cols, "invoiceno"), date: colOf(cols, "idate"),
    party: colOf(cols, "party"), item: colOf(cols, "itemname"), rate: colOf(cols, "rate"), qty: colOf(cols, "qty"),
  };
  const gst = gstCols(cols);

  const parsed: LegacyParsedRow[] = [];
  let dropped = 0, badDates = 0;
  for (let rn = headerRow + 1; rn <= ws.rowCount; rn++) {
    const row = ws.getRow(rn);
    if (isRowBlank(row)) continue;
    if (!isDataSlNo(txt(row, c.slno)) || !txt(row, c.item)) { dropped++; continue; }

    const pct = (["cgst", "sgst", "igst"] as const)
      .map((k) => num(txt(row, gst.pct[k] ?? null)) ?? 0)
      .reduce((a, b) => a + b, 0);
    const iso = toIsoDate(txt(row, c.date));
    if (!iso) badDates++;

    parsed.push({
      rowNumber: rn,
      values: {
        invoiceNo: txt(row, c.inv),
        date: iso ?? txt(row, c.date),
        party: txt(row, c.party),
        item: txt(row, c.item),
        quantity: txt(row, c.qty),
        rate: txt(row, c.rate), // GST-exclusive — same meaning as the ERP column
        gstRate: pct > 0 ? String(r2(pct)) : "",
        cgst: txt(row, gst.amt.cgst ?? null),
        sgst: txt(row, gst.amt.sgst ?? null),
        igst: txt(row, gst.amt.igst ?? null),
      },
    });
  }

  const notes = [
    "The report's Rate column is GST-exclusive and maps straight onto the purchase Rate; GST is recomputed and cross-checked against the report's tax columns.",
    "Charge-type lines (e.g. PACKING AND TRANSPORT) can be marked as bill charges instead of stock items in the mapping step.",
  ];
  if (dropped > 0) notes.push(`${dropped} separator/total rows were dropped.`);
  if (badDates > 0) notes.push(`${badDates} rows carry a date the converter could not read — they will show as errors below.`);
  return {
    parsed,
    conversion: { detected: true, report: "Item-wise Purchase report", headerRow, keptRows: parsed.length, droppedRows: dropped, notes },
  };
}

// ── Receipt / Payment reports ────────────────────────────────────────────────
// Columns: SlNo | Voucher No | Date | Account Name | Address1 | Amount |
// Discount [| Payment Type]. The payment file carries real Excel date cells
// and a Payment Type column (blank/NEFT/UPI/HDFC/TPT…); the receipt file has
// DD-MM-YY strings and no mode column (everything settled in cash).

function convertVouchers(module: "receipts" | "payments", ws: ExcelJS.Worksheet): LegacyConvertResult {
  const hdr = findHeaderRow(ws, ["slno", "voucherno", "date", "accountname", "amount"]);
  if (!hdr) return null;
  const { cols, headerRow } = hdr;
  const c = {
    slno: colOf(cols, "slno"), vno: colOf(cols, "voucherno"), date: colOf(cols, "date"),
    party: colOf(cols, "accountname"), amount: colOf(cols, "amount"),
    discount: colOf(cols, "discount"), mode: colOf(cols, "paymenttype"),
  };

  const parsed: LegacyParsedRow[] = [];
  const vnoSeen = new Map<string, number>();
  let dropped = 0, renumbered = 0, discounts = 0, badDates = 0;
  for (let rn = headerRow + 1; rn <= ws.rowCount; rn++) {
    const row = ws.getRow(rn);
    if (isRowBlank(row)) continue;
    if (!isDataSlNo(txt(row, c.slno)) || !txt(row, c.party)) { dropped++; continue; }

    // The old software restarts its voucher numbering per series, so one file
    // holds the same number twice. Each row is a separate voucher — keep both
    // by suffixing the repeats.
    let vno = txt(row, c.vno);
    if (vno) {
      const n = (vnoSeen.get(vno.toLowerCase()) ?? 0) + 1;
      vnoSeen.set(vno.toLowerCase(), n);
      if (n > 1) { vno = `${vno}/${n}`; renumbered++; }
    }

    const iso = toIsoDate(txt(row, c.date));
    if (!iso) badDates++;

    // Mode → received-in / paid-from account. Only GENERIC spellings collapse:
    // NEFT/plain HDFC/TPT and friends → Bank, UPI apps → UPI, blank/cash →
    // the cash till. Anything more specific — digits or extra words, e.g.
    // "hdfc-4737" — is an account NAME and passes through verbatim so the
    // validator can exact-match the ledger (collapsing it to generic "Bank"
    // would erase which account, and be ambiguous at multi-bank locations).
    let account = "";
    const modeRaw = txt(row, c.mode);
    if (modeRaw) {
      // Keep digits when normalising: "hdfc-4737" must NOT reduce to "hdfc".
      const t = modeRaw.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (["neft", "rtgs", "imps", "hdfc", "tpt", "cheque", "chq", "check", "dd", "banktransfer", "transfer", "netbanking", "online", "bank", "card"].includes(t)) account = "Bank";
      else if (["upi", "gpay", "googlepay", "phonepe", "paytm", "bhim", "qr"].includes(t)) account = "UPI";
      else if (t === "cash") account = "";
      else account = modeRaw; // specific account name (or unknown) — the validator matches or names it
    }

    const disc = num(txt(row, c.discount)) ?? 0;
    if (disc > 0) discounts++;

    parsed.push({
      rowNumber: rn,
      values: {
        voucherNo: vno,
        date: iso ?? txt(row, c.date),
        party: txt(row, c.party),
        amount: txt(row, c.amount),
        account,
        narration: disc > 0 ? `Old software discount column: ₹${disc}` : "",
      },
    });
  }

  const label = module === "receipts" ? "Receipt" : "Payment";
  const notes: string[] = [];
  if (c.mode == null) notes.push("This report has no payment-mode column — every voucher imports against the cash ledger.");
  else notes.push("Payment Type mapped to the money account: generic spellings (NEFT/HDFC/TPT…) → Bank, UPI apps → UPI, blank → Cash; a specific account name (e.g. hdfc-4737) is kept as-is and must match a ledger name exactly.");
  notes.push("Names that are not customers/vendors (capital accounts, expense heads…) are surfaced in the mapping step — route each to a ledger as a journal entry, or skip it explicitly.");
  if (renumbered > 0) notes.push(`${renumbered} repeated voucher numbers were kept by suffixing (/2 style) — each row is a separate voucher in the old software.`);
  if (discounts > 0) notes.push(`${discounts} rows carry a Discount amount — noted in the voucher narration, NOT posted (record discount vouchers manually if needed).`);
  if (dropped > 0) notes.push(`${dropped} total/separator rows were dropped.`);
  if (badDates > 0) notes.push(`${badDates} rows carry a date the converter could not read — they will show as errors below.`);
  return {
    parsed,
    conversion: { detected: true, report: `${label} report`, headerRow, keptRows: parsed.length, droppedRows: dropped, notes },
  };
}

// ── Day book ─────────────────────────────────────────────────────────────────
// Columns: Description | Narration | Vch Name | Vch No. | Debit | Credit.
// The date lives on "Date : DD-MM-YY Day" section rows; each voucher starts
// on the row carrying Vch Name + Vch No. (that row is ALSO its first leg) and
// its remaining legs follow with just a ledger name and one amount.

const DAYBOOK_COVERED: Record<string, string> = {
  receipt: "the Receipt report file",
  payment: "the Payment report file",
  sales: "the Sales report file",
  sale: "the Sales report file",
  purchase: "the Purchase report file",
  purchases: "the Purchase report file",
};

function convertDaybook(ws: ExcelJS.Worksheet): LegacyConvertResult {
  const hdr = findHeaderRow(ws, ["description", "vchname", "vchno", "debit", "credit"]);
  if (!hdr) return null;
  const { cols, headerRow } = hdr;
  const c = {
    desc: colOf(cols, "description"), narr: colOf(cols, "narration"),
    type: colOf(cols, "vchname"), vno: colOf(cols, "vchno"),
    debit: colOf(cols, "debit"), credit: colOf(cols, "credit"),
  };

  interface Leg { rowNumber: number; ledger: string; debit: string; credit: string }
  interface Voucher { vno: string; type: string; dateIso: string | null; dateRaw: string; narration: string; legs: Leg[] }

  const vouchers: Voucher[] = [];
  let current: Voucher | null = null;
  let currentDateIso: string | null = null;
  let currentDateRaw = "";
  let dropped = 0;

  for (let rn = headerRow + 1; rn <= ws.rowCount; rn++) {
    const row = ws.getRow(rn);
    if (isRowBlank(row)) continue;
    const desc = txt(row, c.desc);

    // Section row: "Date : 20-04-26 Mon" — the date every voucher below it uses.
    const dateM = /^date\s*:\s*(\S+)/i.exec(desc.trim());
    if (dateM) {
      currentDateRaw = dateM[1];
      currentDateIso = toIsoDate(dateM[1]);
      current = null;
      continue;
    }

    const vno = txt(row, c.vno);
    const vtype = txt(row, c.type);
    const debit = txt(row, c.debit);
    const credit = txt(row, c.credit);

    if (vno || vtype) {
      // Voucher start — this row is also the first leg.
      current = { vno, type: vtype, dateIso: currentDateIso, dateRaw: currentDateRaw, narration: txt(row, c.narr), legs: [] };
      vouchers.push(current);
      if (desc) current.legs.push({ rowNumber: rn, ledger: desc, debit, credit });
      continue;
    }
    if (desc && (num(debit) != null || num(credit) != null) && current) {
      current.legs.push({ rowNumber: rn, ledger: desc, debit, credit });
      if (!current.narration) current.narration = txt(row, c.narr);
      continue;
    }
    dropped++; // page footers / stray text
  }

  // Keep ONLY Journal and Contra — every other voucher family is covered by
  // its own report file; importing it here would double-enter the books.
  const excludedCounts = new Map<string, number>();
  const kept: Voucher[] = [];
  for (const v of vouchers) {
    const t = v.type.toLowerCase().trim();
    if (t.includes("journal") || t.includes("jrnl") || t === "contra") kept.push(v);
    else excludedCounts.set(v.type || "(unnamed)", (excludedCounts.get(v.type || "(unnamed)") ?? 0) + 1);
  }
  const excluded = [...excludedCounts.entries()]
    .map(([type, vouchersN]) => ({ type, vouchers: vouchersN }))
    .sort((a, b) => b.vouchers - a.vouchers);

  if (kept.length === 0) {
    const coveredBits: string[] = [];
    const uncoveredBits: string[] = [];
    for (const e of excluded) {
      const coveredBy = DAYBOOK_COVERED[e.type.toLowerCase().trim()];
      if (coveredBy) coveredBits.push(`${e.vouchers} ${e.type} (covered by ${coveredBy})`);
      else uncoveredBits.push(`${e.vouchers} ${e.type}`);
    }
    let msg = `Old-software Day Book recognised, but it holds no Journal or Contra vouchers — there is nothing to import from it. `
      + `Its ${vouchers.length} vouchers are: ${coveredBits.join(", ")}`;
    if (uncoveredBits.length > 0) {
      msg += `; and ${uncoveredBits.join(", ")}, which no report file covers — record those manually (returns become credit/debit notes) after the migration`;
    }
    msg += ". Import the dedicated report files instead of this one — importing the day book too would enter everything twice.";
    return { error: msg };
  }

  // Old software numbering repeats across series — the day book validator
  // groups legs BY voucher number, so repeats must be suffixed apart.
  const vnoSeen = new Map<string, number>();
  const parsed: LegacyParsedRow[] = [];
  for (const v of kept) {
    let vno = v.vno || "(blank)";
    const n = (vnoSeen.get(vno.toLowerCase()) ?? 0) + 1;
    vnoSeen.set(vno.toLowerCase(), n);
    if (n > 1) vno = `${vno}/${n}`;
    for (let i = 0; i < v.legs.length; i++) {
      const leg = v.legs[i];
      parsed.push({
        rowNumber: leg.rowNumber,
        values: {
          voucherNo: vno,
          date: v.dateIso ?? v.dateRaw,
          voucherType: /contra/i.test(v.type) ? "Contra" : "Journal",
          ledger: leg.ledger,
          debit: leg.debit,
          credit: leg.credit,
          narration: i === 0 ? v.narration : "",
        },
      });
    }
  }

  const notes = [
    "Multi-row vouchers were folded back together and section dates filled down onto every voucher.",
    `Only Journal and Contra vouchers import from the day book — ${kept.length} kept.`,
  ];
  if (excluded.length > 0) {
    notes.push(
      "Excluded (covered by their own report files — importing them here would double-enter the books): "
      + excluded.map((e) => `${e.type} ${e.vouchers}`).join(", ") + ".",
    );
    const uncovered = excluded.filter((e) => !DAYBOOK_COVERED[e.type.toLowerCase().trim()]);
    if (uncovered.length > 0) {
      notes.push(`No report file covers: ${uncovered.map((e) => `${e.type} ${e.vouchers}`).join(", ")} — record those manually after the migration.`);
    }
  }
  return {
    parsed,
    conversion: {
      detected: true, report: "Day Book report", headerRow,
      keptRows: parsed.length, droppedRows: dropped, notes, excluded,
    },
  };
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Detect and convert an old-software report worksheet for the given import
 * module. Returns null when the sheet is NOT that layout (caller falls back
 * to the normal sample-template parser).
 */
export function convertLegacyReport(module: string, ws: ExcelJS.Worksheet): LegacyConvertResult {
  switch (module) {
    case "sales": return convertSales(ws);
    case "purchases": return convertPurchases(ws);
    case "receipts": return convertVouchers("receipts", ws);
    case "payments": return convertVouchers("payments", ws);
    case "daybook": return convertDaybook(ws);
    default: return null;
  }
}
