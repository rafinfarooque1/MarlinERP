/**
 * Client-side PDF export for the Chart of Accounts page.
 *
 * Mirrors the EXACT data already displayed on screen — no re-computation, no
 * server round-trip. Accepts the same `FinancialStatements` + optional monthly
 * series that the React components render, builds rows in the same order and
 * with the same figures, then emits a landscape-if-many-months jsPDF document.
 */
import { jsPDF } from 'jspdf';
import {
  registerFonts, FONT, WHITE, LGRAY, BORDER, NAVY,
  type RGB, Painter, inr, stampFooters,
} from '@workspace/pdf-kit';
import { drawLetterhead, type LetterheadIssuer } from '@workspace/pdf-kit';
import type { FinancialStatements, GroupSummary, LedgerNode } from './chartCommon';

export type { LetterheadIssuer };

// ─── Public API ───────────────────────────────────────────────────────────────

export interface CoaPdfOpts {
  fs: FinancialStatements;
  /** Monthly data when "Month Wise" is ON; null for normal view. */
  mw: {
    months: { key: string; from: string; to: string }[];
    series: Record<string, number[]>;
  } | null;
  issuer: LetterheadIssuer;
  logoDataUrl?: string | null;
  /** "All Locations", "Head Office", "Warehouse Name", etc. */
  locationLabel: string;
  /** "All Dates", "01-Apr-2026 – 18-Aug-2026", etc. */
  periodLabel: string;
}

// ─── Internal row model ───────────────────────────────────────────────────────

type RowKind = 'section' | 'panel' | 'group' | 'leaf' | 'auto' | 'total' | 'banner' | 'spacer';

interface Row {
  kind: RowKind;
  name: string;
  /** Additional left indent inside the name cell, in mm. */
  indent: number;
  /** One value per month column (empty array for normal view). */
  months: number[];
  total: number;
  /** For 'banner' rows: true = profit (green), false = loss (red). */
  profitPositive?: boolean;
}

// ─── Palette ──────────────────────────────────────────────────────────────────

const INK: RGB    = [20,  30,  60];
const MUT: RGB    = [90,  102, 130];
const ZERO: RGB   = [180, 185, 200];
const SEC_BG: RGB = [13,  42,  83];   // dark navy — section header
const PAN_BG: RGB = [35,  70,  120];  // medium blue — panel header
const GRP_BG: RGB = [220, 228, 240];  // light grey-blue — group header
const TOT_BG: RGB = [195, 212, 235];  // total row tint
const PRF_BG: RGB = [17,  100, 52];   // profit banner
const LOS_BG: RGB = [145, 28,  28];   // loss banner
const SEP: RGB    = [225, 231, 238];  // row separator

// ─── Row heights (mm) ────────────────────────────────────────────────────────

const ROW_H: Record<RowKind, number> = {
  section: 8.5, panel: 7, group: 6.5, leaf: 5.5,
  auto: 5.5, total: 6.5, banner: 8.5, spacer: 3,
};

// ─── Month-column label ───────────────────────────────────────────────────────

function mwLabel(ym: string): string {
  return new Date(`${ym}-01T00:00:00`).toLocaleDateString('en-IN', {
    month: 'short', year: 'numeric',
  });
}

// ─── Row builders ─────────────────────────────────────────────────────────────

function zeroArr(n: number): number[] { return new Array(n).fill(0); }

function ledgerRows(node: LedgerNode, depth: number, series: Record<string, number[]>, n: number): Row[] {
  const out: Row[] = [];
  const mv = series[`n:${node.id}`] ?? zeroArr(n);
  out.push({
    kind: node.children.length > 0 ? 'group' : 'leaf',
    name: node.name,
    indent: depth * 4,
    months: mv,
    total: node.balance,
  });
  for (const child of node.children) {
    out.push(...ledgerRows(child, depth + 1, series, n));
  }
  return out;
}

function groupRows(
  group: GroupSummary,
  seriesKey: string,
  series: Record<string, number[]>,
  n: number,
  depth = 0,
): Row[] {
  const out: Row[] = [];
  const mv = series[seriesKey] ?? zeroArr(n);
  out.push({ kind: 'group', name: group.name, indent: depth * 4, months: mv, total: group.total });
  for (const child of group.children) {
    out.push(...ledgerRows(child, depth + 1, series, n));
  }
  return out;
}

// ─── Main generator ───────────────────────────────────────────────────────────

export async function generateChartOfAccountsPdf(opts: CoaPdfOpts): Promise<void> {
  const { fs, mw, issuer, logoDataUrl, locationLabel, periodLabel } = opts;
  const months  = mw ? mw.months : [];
  const series  = mw ? mw.series : {};
  const N       = months.length;

  // Landscape if more than 5 month columns so every column has breathing room.
  const landscape = N > 5;
  const doc = new jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' });
  await registerFonts(doc);

  const PAGE_W = doc.internal.pageSize.getWidth();
  const PAGE_H = doc.internal.pageSize.getHeight();
  const M      = 12;
  const CW     = PAGE_W - M * 2;
  const BOTTOM = PAGE_H - 14;

  // Column geometry
  const NAME_W  = mw ? 65 : CW * 0.70;
  const TOTAL_W = mw ? 28 : CW * 0.30;
  const MONTH_W = N > 0 ? (CW - NAME_W - TOTAL_W) / N : 0;

  const colHeaders = ['Account', ...months.map(m => mwLabel(m.key)), 'Total'];

  const p = new Painter(doc);

  // ── Page header helpers ───────────────────────────────────────────────────

  let firstPage = true;

  const drawPageHeader = (): number => {
    if (firstPage) {
      firstPage = false;
      return drawLetterhead(doc, {
        issuer,
        logoDataUrl,
        badgeTitle: 'CHART OF ACCOUNTS',
        accent: NAVY,
        metaRows: [
          ['Location', locationLabel],
          ['Period',   periodLabel],
        ],
        margin: M,
        width: CW,
      }) + 1;
    }
    // Compact header on pages 2+
    const y = M;
    p.fill(M, y, CW, 6.5, SEC_BG);
    p.txt(issuer.tradeName.toUpperCase(), M + 2, y + 4.5, { bold: true, size: 7.5, color: WHITE });
    const right = `Chart of Accounts  ·  ${locationLabel}  ·  ${periodLabel}`;
    p.txt(right, M + CW - 2, y + 4.5, { size: 6.5, color: WHITE, align: 'right' });
    return y + 9;
  };

  const drawColHeaders = (y: number): number => {
    const H = 6.5;
    p.fill(M, y, CW, H, [40, 65, 108] as RGB);
    let cx = M;
    for (let i = 0; i < colHeaders.length; i++) {
      const w = i === 0 ? NAME_W : i < colHeaders.length - 1 ? MONTH_W : TOTAL_W;
      const isRight = i > 0;
      const tx = isRight ? cx + w - 1.5 : cx + 1.5;
      const { text, size } = p.fit(colHeaders[i], w - 3, 6.8, true);
      p.txt(text, tx, y + H - 2, {
        bold: true, size, color: WHITE, align: isRight ? 'right' : 'left',
      });
      cx += w;
    }
    return y + H;
  };

  // ── Pagination ────────────────────────────────────────────────────────────

  let newPage: () => number;

  const renderRows = (rows: Row[], startY: number): number => {
    let y = startY;
    for (const row of rows) {
      const h = ROW_H[row.kind];
      if (row.kind !== 'spacer' && y + h > BOTTOM) {
        y = newPage();
      }
      y += drawRow(row, y);
    }
    return y;
  };

  newPage = (): number => {
    doc.addPage();
    const headerY = drawPageHeader();
    return drawColHeaders(headerY);
  };

  // ── Row renderer ──────────────────────────────────────────────────────────

  const drawRow = (row: Row, y: number): number => {
    if (row.kind === 'spacer') return ROW_H.spacer;

    const h    = ROW_H[row.kind];
    const midY = y + h - 1.8;

    // Row background
    if      (row.kind === 'section') p.fill(M, y, CW, h, SEC_BG);
    else if (row.kind === 'panel')   p.fill(M, y, CW, h, PAN_BG);
    else if (row.kind === 'group')   p.fill(M, y, CW, h, GRP_BG);
    else if (row.kind === 'total')   { p.fill(M, y, CW, h, TOT_BG); p.line(M, y, M + CW, y, BORDER, 0.3); }
    else if (row.kind === 'banner')  p.fill(M, y, CW, h, row.profitPositive ? PRF_BG : LOS_BG);
    else { p.line(M, y + h, M + CW, y + h, SEP, 0.1); }

    // Style for this row kind
    const isBold   = ['section', 'panel', 'group', 'total', 'banner'].includes(row.kind);
    const inkColor: RGB = ['section', 'panel', 'banner'].includes(row.kind) ? WHITE
      : row.kind === 'auto' ? MUT
      : INK;
    const textSize = row.kind === 'section' ? 8.5
      : row.kind === 'panel' ? 8
      : row.kind === 'group' || row.kind === 'total' ? 7.5
      : 7;

    // Name cell
    const nameIndentX = M + 1.5 + row.indent;
    const nameW2      = NAME_W - 1.5 - row.indent;
    const { text: nameText, size: nameActualSize } = p.fit(row.name, nameW2, textSize, isBold);
    p.txt(nameText, nameIndentX, midY, { bold: isBold, size: nameActualSize, color: inkColor });

    // Month value cells
    if (mw && row.months.length === N && N > 0) {
      let cx = M + NAME_W;
      for (let i = 0; i < N; i++) {
        const v    = row.months[i] ?? 0;
        const text = v === 0 ? '—' : inr(Math.abs(v));
        p.txt(text, cx + MONTH_W - 1.5, midY, {
          size: 6.5, color: v === 0 ? ZERO : inkColor, align: 'right',
        });
        cx += MONTH_W;
      }
    }

    // Total cell (always rightmost)
    const totalText = row.total === 0 ? '—' : inr(Math.abs(row.total));
    p.txt(totalText, M + CW - 1.5, midY, {
      bold: isBold, size: textSize, color: inkColor, align: 'right',
    });

    return h;
  };

  // ── Series helpers ────────────────────────────────────────────────────────

  const sv  = (k: string): number[]   => series[k] ?? zeroArr(N);
  const add = (a: number[], b: number[]) => a.map((v, i) => v + (b[i] ?? 0));
  const neg = (a: number[])              => a.map(v => -v);

  const rowAuto  = (name: string, mv: number[], total: number): Row =>
    ({ kind: 'auto',  name, indent: 2, months: mv, total });
  const rowTotal = (name: string, total: number, months?: number[]): Row =>
    ({ kind: 'total', name, indent: 0, months: months ?? zeroArr(N), total });
  const rowSect  = (name: string): Row =>
    ({ kind: 'section', name, indent: 0, months: zeroArr(N), total: 0 });
  const rowPanel = (name: string): Row =>
    ({ kind: 'panel',   name, indent: 0, months: zeroArr(N), total: 0 });
  const rowSpacer = (): Row =>
    ({ kind: 'spacer',  name: '', indent: 0, months: zeroArr(N), total: 0 });

  // ── Balance Sheet section ─────────────────────────────────────────────────

  let y = drawPageHeader();
  y = drawColHeaders(y);

  const bs = fs.balanceSheet;

  const bsRows: Row[] = [
    rowSect('BALANCE SHEET'),
    rowSpacer(),
    rowPanel('LIABILITIES'),
    ...groupRows(bs.liabilities.capitalAccount,      'grp:capital', series, N),
    ...groupRows(bs.liabilities.loans,               'grp:loans',   series, N),
    ...groupRows(bs.liabilities.currentLiabilities,  'grp:curliab', series, N),
    rowAuto('Reserves & Surplus (P&L)', sv('pandl'), bs.liabilities.pandlCarryForward),
    rowTotal('Total Liabilities', bs.liabilities.total, sv('liabTotal')),
    rowSpacer(),
    rowPanel('ASSETS'),
    ...groupRows(bs.assets.fixedAssets,   'grp:fixed',    series, N),
    rowAuto('Closing Stock', sv('bsClosingStock'), bs.assets.closingStock),
    ...groupRows(bs.assets.currentAssets, 'grp:curassets', series, N),
    rowTotal('Total Assets', bs.assets.total, sv('assetsTotal')),
  ];

  y = renderRows(bsRows, y);

  // ── Profit & Loss section — always starts on a fresh page ─────────────────

  doc.addPage();
  y = drawPageHeader();
  y = drawColHeaders(y);

  const pl  = fs.profitAndLoss;
  const exp = pl.expenses;
  const inc = pl.incomes;

  const salesReturns    = inc.salesReturns    ?? 0;
  const grossSales      = inc.grossSales      ?? (inc.sales + salesReturns);
  const purchaseReturns = exp.purchaseReturns ?? 0;
  const grossProfit: number = pl.summary?.grossProfit
    ?? ((inc.sales + inc.closingStock + inc.directIncomes.total)
       - (exp.openingStock + exp.purchases + exp.directExpenses.total));

  // Per-month derived arrays — same arithmetic as StatementsView
  const mwSales      = sv('sales');
  const mwSalesRet   = sv('salesReturns');
  const mwPur        = sv('purchases');
  const mwPurRet     = sv('purchaseReturns');
  const mwGp         = sv('gp');
  const mwNp         = sv('np');
  const mwGrossSales = add(mwSales, mwSalesRet);
  const mwGrossPur   = add(mwPur,   mwPurRet);
  const mwGpPos      = mwGp.map(v => v > 0 ?  v : 0);
  const mwGpNeg      = mwGp.map(v => v < 0 ? -v : 0);

  const tradingExpBase  = exp.openingStock + exp.purchases + exp.directExpenses.total;
  const tradingIncBase  = inc.sales + inc.closingStock + inc.directIncomes.total;
  const tradingExpTotal = tradingExpBase + (grossProfit > 0 ?  grossProfit : 0);
  const tradingIncTotal = tradingIncBase + (grossProfit < 0 ? -grossProfit : 0);
  const plExpTotal      = exp.indirectExpenses.total + (grossProfit < 0 ? -grossProfit : 0);
  const plIncTotal      = inc.indirectIncomes.total  + (grossProfit > 0 ?  grossProfit : 0);

  const plRows: Row[] = [
    rowSect('PROFIT & LOSS'),
    rowSpacer(),

    // ── Trading Account ──
    rowPanel('TRADING ACCOUNT — EXPENSE (DEBIT)'),
    rowAuto('Opening Stock', sv('openingStock'), exp.openingStock),
    ...(purchaseReturns !== 0
      ? [
          rowAuto('Purchase Account',       mwGrossPur,              exp.purchases + purchaseReturns),
          rowAuto('Less: Purchase Returns', neg(mwPurRet),           -purchaseReturns),
          rowAuto('Net Purchases',          mwPur,                   exp.purchases),
        ]
      : [rowAuto('Purchase Account', mwPur, exp.purchases)]),
    ...groupRows(exp.directExpenses, 'grp:direxp', series, N),
    ...(grossProfit > 0 ? [rowAuto('Gross Profit c/d', mwGpPos, grossProfit)] : []),
    rowTotal('Total', tradingExpTotal),
    rowSpacer(),

    rowPanel('TRADING ACCOUNT — INCOME (CREDIT)'),
    ...(salesReturns !== 0
      ? [
          rowAuto('Sales Account',          mwGrossSales,            grossSales),
          rowAuto('Less: Sales Returns',    neg(mwSalesRet),         -salesReturns),
          rowAuto('Net Sales',              mwSales,                 inc.sales),
        ]
      : [rowAuto('Sales Account', mwSales, inc.sales)]),
    ...groupRows(inc.directIncomes, 'grp:dirinc', series, N),
    rowAuto('Closing Stock', sv('closingStock'), inc.closingStock),
    ...(grossProfit < 0 ? [rowAuto('Gross Loss c/d', mwGpNeg, -grossProfit)] : []),
    rowTotal('Total', tradingIncTotal),
    rowSpacer(),

    // ── Gross Profit / Loss banner ──
    {
      kind: 'banner',
      name: grossProfit >= 0 ? 'GROSS PROFIT' : 'GROSS LOSS',
      indent: 0,
      months: mwGp.map(v => Math.abs(v)),
      total: Math.abs(grossProfit),
      profitPositive: grossProfit >= 0,
    },
    rowSpacer(),

    // ── P&L Account ──
    rowPanel('P&L ACCOUNT — EXPENSE (DEBIT)'),
    ...(grossProfit < 0 ? [rowAuto('Gross Loss b/d', mwGpNeg, -grossProfit)] : []),
    ...groupRows(exp.indirectExpenses, 'grp:indexp', series, N),
    rowTotal('Total', plExpTotal),
    rowSpacer(),

    rowPanel('P&L ACCOUNT — INCOME (CREDIT)'),
    ...(grossProfit >= 0 ? [rowAuto('Gross Profit b/d', mwGpPos, grossProfit)] : []),
    ...groupRows(inc.indirectIncomes, 'grp:indinc', series, N),
    rowTotal('Total', plIncTotal),
    rowSpacer(),

    // ── Net Profit / Loss banner ──
    {
      kind: 'banner',
      name: pl.netProfit >= 0 ? 'NET PROFIT' : 'NET LOSS',
      indent: 0,
      months: mwNp.map(v => Math.abs(v)),
      total: Math.abs(pl.netProfit),
      profitPositive: pl.netProfit >= 0,
    },
  ];

  renderRows(plRows, y);

  // ── Footer on every page ──────────────────────────────────────────────────

  const generated = new Date().toLocaleString('en-IN', {
    dateStyle: 'medium', timeStyle: 'short',
  });
  stampFooters(
    doc,
    `${locationLabel}  ·  ${periodLabel}  ·  Generated: ${generated}  ·  Chart of Accounts`,
  );

  // ── Download ──────────────────────────────────────────────────────────────

  const slug = locationLabel.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  doc.save(`chart-of-accounts-${slug}-${Date.now()}.pdf`);
}
