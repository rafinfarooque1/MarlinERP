/**
 * Financial reports.
 *
 * Nine report families behind one sidebar link. Every one of them reads the
 * same derived posting stream the Chart of Accounts and the books read, so a
 * GST figure here and a GST figure there cannot disagree.
 *
 * Two rules run through the whole file:
 *
 *  - The Balance Sheet has no plug. `integrity.difference` used to be printed
 *    as an ordinary line called "Difference in books"; it is now an error
 *    banner, because a balance sheet that needs a plug is broken, not balanced.
 *  - Financial statements are company-wide. The posting stream carries no
 *    location, so a per-warehouse slice of it would be an unbalanced fragment.
 *    The warehouse control is rendered disabled with that reason rather than
 *    hidden, so it reads as a rule instead of an oversight.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { customFetch } from '@workspace/api-client-react';
import { Link } from 'wouter';
import {
  BookOpen, Scale, FileSpreadsheet, Landmark, Wallet, Percent, ArrowRight, Clock,
  AlertTriangle, Info, ChevronDown, ChevronRight, FoldVertical, UnfoldVertical,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { usePermission } from '@/lib/usePermission';
import { useEnabledOutlets } from '@/lib/locationStructure';
import { downloadCSV } from '@/lib/download';
import {
  fmt, num, pdfMoney, periodLabel, fmtDate,
  useDateRange, useLocationFilter, RangeBar, LocationFilter, ReportPicker, SummaryCards, RTable,
  ExportButtons,
  type RangeState, type LocationFilterState, type LocationOption, type Col, type ReportDoc,
} from '../shared';

type FinReport =
  | 'pnl' | 'balanceSheet' | 'trialBalance' | 'dayBook' | 'ledgers'
  | 'cash' | 'bank' | 'gst' | 'expenses' | 'salary' | 'books';

const MONEY_COL = { label: 'Amount', align: 'right' as const, width: 1.4 };

// ── Shared payload shapes ─────────────────────────────────────────────────────
// `id` is unique only within a product kind, so anything keyed by a stock item
// must combine `materialType` with `id`. Cost is `unitCost` (weighted average),
// never MRP — these lines are valued at cost, not at selling price.
interface StockItem { id: number; name: string; unit: string; stock: number; unitCost: number; total: number; materialType: string }
interface LedgerNode { id: number; name: string; type: string; parentId: number | null; code: string | null; balance: number; children: LedgerNode[] }
interface GroupSummary { id: number | null; name: string; code: string | null; total: number; children: LedgerNode[] }
interface FinancialStatements {
  locationScoped: boolean;
  filters: { warehouses: { id: number; name: string }[]; outlets: { id: number; name: string }[] };
  profitAndLoss: {
    expenses: {
      openingStock: number; openingStockItems: StockItem[];
      openingStockReliable: boolean; openingStockNote: string | null;
      purchases: number; directExpenses: GroupSummary; indirectExpenses: GroupSummary; total: number;
    };
    incomes: {
      sales: number; closingStock: number; closingStockItems: StockItem[]; closingStockInTransit: number;
      closingStockReliable: boolean; closingStockNote: string | null;
      directIncomes: GroupSummary; indirectIncomes: GroupSummary; total: number;
    };
    netProfit: number;
    summary: {
      revenue: number; costOfGoodsSold: number; grossProfit: number; grossMarginPct: number | null;
      otherIncome: number; operatingExpenses: number; netProfit: number; netMarginPct: number | null;
    };
  };
  balanceSheet: {
    liabilities: { capitalAccount: GroupSummary; loans: GroupSummary; currentLiabilities: GroupSummary; pandlCarryForward: number; difference: number; total: number };
    assets: { fixedAssets: GroupSummary; currentAssets: GroupSummary; closingStock: number; total: number };
  };
  integrity: { balanced: boolean; difference: number; issues: string[] };
}

/**
 * A statement line.
 *
 * `key`/`parentKey`/`hasChildren` drive the on-screen collapsible tree only.
 * They are presentation metadata — the amount, depth, sign and aggregation are
 * exactly what they always were, so PDF/CSV exports (which read the full,
 * unfiltered list) are untouched by collapsing.
 */
interface Line { name: string; amount: number; depth: number; bold?: boolean; key: string; parentKey: string | null; hasChildren?: boolean }

/**
 * Flatten a group into indented lines.
 *
 * Recursive on purpose: the chart of accounts nests sub-groups (per-employee
 * salary ledgers under "Salary Expense", per-location sales under "Location
 * Sales"…), and a single level of children would print the sub-group's rolled-up
 * total with the accounts inside it invisible. Zero-balance branches are pruned
 * whole — a sub-group is only listed when something under it moved.
 *
 * Each emitted line carries a stable `key` (its parent path + group root) and a
 * `parentKey`, so the on-screen table can hide a branch by knowing which lines
 * descend from a collapsed one. `hasChildren` marks the lines that get a
 * disclosure arrow.
 */
function groupLines(gs: GroupSummary | undefined): Line[] {
  if (!gs) return [];
  const printed = (nodes: LedgerNode[] | undefined) =>
    (nodes ?? []).filter((c) => Math.abs(c.balance) > 0.005);

  // Root key is scoped to this group summary so keys never collide across the
  // several groups stacked in one column (e.g. Direct + Indirect expenses).
  const rootKey = `g:${gs.id ?? gs.code ?? gs.name}`;

  const walk = (nodes: LedgerNode[] | undefined, depth: number, parentKey: string): Line[] =>
    printed(nodes).flatMap((c) => {
      const key = `${parentKey}/${c.id}`;
      const kids = walk(c.children, depth + 1, key);
      const lines: Line[] = [{ name: c.name, amount: c.balance, depth, bold: kids.length > 0, key, parentKey, hasChildren: kids.length > 0 }, ...kids];
      // Accounts like "Cash" carry entries of their own as well as children, so
      // the listed accounts need not add up to the parent. Print the remainder
      // rather than leaving an unexplained gap in the statement.
      if (kids.length > 0) {
        const own = c.balance - printed(c.children).reduce((s, x) => s + x.balance, 0);
        if (Math.abs(own) > 0.005) lines.push({ name: 'Direct entries', amount: own, depth: depth + 1, key: `${key}/direct`, parentKey: key });
      }
      return lines;
    });

  const kids = walk(gs.children, 1, rootKey);
  const ownAtRoot = gs.total - printed(gs.children).reduce((s, x) => s + x.balance, 0);
  return [
    { name: gs.name, amount: gs.total, depth: 0, bold: true, key: rootKey, parentKey: null, hasChildren: kids.length > 0 },
    ...kids,
    ...(Math.abs(ownAtRoot) > 0.005 ? [{ name: 'Direct entries', amount: ownAtRoot, depth: 1, key: `${rootKey}/direct`, parentKey: rootKey }] : []),
  ];
}

const pct = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(1)}%`);

// ── Query helpers ─────────────────────────────────────────────────────────────
function qs(range: RangeState, extra: Record<string, string | number | undefined> = {}, dateKeys: [string, string] = ['from', 'to']) {
  const p = new URLSearchParams();
  if (range.from) p.set(dateKeys[0], range.from);
  if (range.to) p.set(dateKeys[1], range.to);
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== '' && v !== 0) p.set(k, String(v));
  return p.toString();
}

function useReport<T>(path: string, query: string) {
  return useQuery({
    queryKey: [path, query],
    queryFn: () => customFetch<T>(`${path}${query ? `?${query}` : ''}`),
  });
}

function useFinancialStatements(range: RangeState, loc?: LocationFilterState) {
  return useReport<FinancialStatements>(
    '/api/accounts/financial-statements',
    qs(range, { locationType: loc?.type || undefined, locationId: loc?.id || undefined }, ['fromDate', 'toDate']),
  );
}

/**
 * Company-level bucket note for location-sliced books: postings with no
 * location dimension (journal vouchers, opening balances) sit outside every
 * location slice. They are excluded, never silently dropped — this line says
 * what is missing and how to see it.
 */
interface CompanyLevel { entries: number; debit: number; credit: number }
function CompanyLevelNote({ active, companyLevel }: { active: boolean; companyLevel?: CompanyLevel | null }) {
  if (!active || !companyLevel || companyLevel.entries === 0) return null;
  return (
    <NoteLine>
      {companyLevel.entries} company-level {companyLevel.entries === 1 ? 'entry' : 'entries'} ({fmt(companyLevel.debit)} Dr)
      in this period carry no location and are excluded from this slice — choose All locations to include them.
    </NoteLine>
  );
}

function useLocationOptions() {
  const wh = useQuery({ queryKey: ['/api/warehouses'], queryFn: () => customFetch<{ id: number; name: string }[]>('/api/warehouses') });
  // Selectable options, so outlets come from the location service and disappear
  // with the module rather than being listed unconditionally.
  const ou = useEnabledOutlets();
  const options: LocationOption[] = [
    ...(wh.data ?? []).map((w) => ({ type: 'warehouse' as const, id: w.id, name: w.name })),
    ...ou.data.map((o) => ({ type: 'outlet' as const, id: o.id, name: o.name })),
  ];
  return { options, loading: wh.isLoading || ou.isLoading };
}

// ── Integrity banner ──────────────────────────────────────────────────────────
/**
 * Replaces the old "Difference in books" line. The statements balance by
 * construction now, so anything shown here is a defect to chase, not a figure
 * to file.
 */
function IntegrityBanner({ integrity }: { integrity?: FinancialStatements['integrity'] }) {
  if (!integrity) return null;
  const off = Math.abs(integrity.difference) > 0.005;
  if (integrity.balanced && !off && integrity.issues.length === 0) return null;
  return (
    <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-3.5">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
        <div className="space-y-1.5 min-w-0">
          <p className="text-sm font-semibold text-amber-700">
            {off ? `Books are out by ${fmt(integrity.difference)}` : 'Accounting integrity warnings'}
          </p>
          {off && (
            <p className="text-xs text-amber-700/90">
              Assets do not equal liabilities plus profit. This is a data defect — it is not absorbed
              into a balancing figure. Do not file these statements until it is resolved.
            </p>
          )}
          {integrity.issues.length > 0 && (
            <ul className="text-xs text-amber-700/90 list-disc pl-4 space-y-0.5">
              {integrity.issues.map((i, n) => <li key={n}>{i}</li>)}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function NoteLine({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <Info className="w-3.5 h-3.5 mt-px shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/**
 * Every line whose `key` is used as some other line's `parentKey` — i.e. the
 * lines that own a disclosure arrow.
 */
function parentKeys(lines: Line[]): Set<string> {
  const s = new Set<string>();
  for (const l of lines) if (l.parentKey) s.add(l.parentKey);
  return s;
}

/**
 * A line is visible only if every ancestor between it and the root is expanded.
 * Walking parentKey up to the root keeps this honest no matter how deep the
 * chart of accounts nests.
 */
function visibleLines(lines: Line[], expanded: Set<string>): Line[] {
  const byKey = new Map(lines.map((l) => [l.key, l]));
  const isVisible = (l: Line): boolean => {
    let p = l.parentKey;
    while (p) {
      if (!expanded.has(p)) return false;
      p = byKey.get(p)?.parentKey ?? null;
    }
    return true;
  };
  return lines.filter(isVisible);
}

/**
 * Collapsible statement table.
 *
 * A presentation layer over the flat `lines`: collapsing only hides rows, it
 * never changes an amount or a total. Parent totals still equal the sum of
 * their children because those numbers come straight from the posting stream —
 * the arrow just decides whether the children are on screen. The footer total
 * is always the true total regardless of what is expanded.
 *
 * Default disclosure state is decided by the caller (top-level sections open,
 * deeper sub-ledgers closed).
 */
function LineTable({
  lines, total, totalLabel, loading, expanded, onToggle,
}: {
  lines: Line[]; total: number; totalLabel: string; loading?: boolean;
  expanded: Set<string>; onToggle: (key: string) => void;
}) {
  const rows = useMemo(() => visibleLines(lines, expanded), [lines, expanded]);
  return (
    <RTable
      cols={[
        { key: 'name', label: 'Particulars', render: (l) => (
          <span className="flex items-center gap-1" style={{ paddingLeft: l.depth * 16 }}>
            {l.hasChildren ? (
              <button
                type="button"
                onClick={() => onToggle(l.key)}
                className="p-0.5 -ml-1 rounded hover:bg-muted/60 text-muted-foreground shrink-0"
                aria-label={expanded.has(l.key) ? 'Collapse' : 'Expand'}
                aria-expanded={expanded.has(l.key)}
                data-testid={`fin-toggle-${l.key}`}
              >
                {expanded.has(l.key) ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              </button>
            ) : (
              <span className="w-[18px] shrink-0" />
            )}
            <span className={l.bold ? 'font-semibold' : ''}>{l.name}</span>
          </span>
        ) },
        { key: 'amount', label: 'Amount', align: 'right', render: (l) => (
          <span className={l.bold ? 'font-bold' : ''}>{fmt(l.amount)}</span>
        ) },
      ] satisfies Col<Line>[]}
      rows={rows} loading={loading} rowKey={(l) => l.key}
      empty="No entries"
      footer={[totalLabel, fmt(total)]}
    />
  );
}

/**
 * Shared collapse state for one statement column.
 *
 * `defaultOpen` seeds the sensible default (top-level sections expanded, deep
 * sub-ledgers collapsed). Expand All / Collapse All operate over exactly the
 * lines that carry a disclosure arrow, so nothing dangles half-open.
 */
function useCollapse(lines: Line[], defaultOpen: (l: Line) => boolean) {
  // A stable signature of the tree's shape: the arrays are rebuilt on every
  // render, so keying anything off array identity would loop. The signature
  // only changes when the actual set of lines changes (period/date change).
  const sig = lines.map((l) => l.key).join('|');
  const allParents = useMemo(() => parentKeys(lines), [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const defaults = useMemo(() => {
    const s = new Set<string>();
    for (const l of lines) if (l.hasChildren && defaultOpen(l)) s.add(l.key);
    return s;
    // defaultOpen is a stable predicate; re-seed only when the shape changes.
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const [expanded, setExpanded] = useState<Set<string>>(defaults);
  // Re-seed when a new payload changes the set of lines (period/date change).
  const [seededFor, setSeededFor] = useState(sig);
  if (seededFor !== sig) { setSeededFor(sig); setExpanded(defaults); }

  const toggle = (key: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const expandAll = () => setExpanded(new Set(allParents));
  const collapseAll = () => setExpanded(new Set());
  const hasCollapsible = allParents.size > 0;
  return { expanded, toggle, expandAll, collapseAll, hasCollapsible };
}

/** Expand All / Collapse All control pair, matching the Chart of Accounts UX. */
function DisclosureControls({ expandAll, collapseAll, disabled }: { expandAll: () => void; collapseAll: () => void; disabled?: boolean }) {
  return (
    <div className="flex items-center gap-1">
      <Button variant="ghost" size="sm" onClick={expandAll} disabled={disabled} className="h-7 px-2 text-xs gap-1" data-testid="fin-expand-all">
        <UnfoldVertical className="w-3.5 h-3.5" /> Expand
      </Button>
      <Button variant="ghost" size="sm" onClick={collapseAll} disabled={disabled} className="h-7 px-2 text-xs gap-1" data-testid="fin-collapse-all">
        <FoldVertical className="w-3.5 h-3.5" /> Collapse
      </Button>
    </div>
  );
}

const COMPANY_WIDE = 'Company-wide';

// ── Profit & Loss ─────────────────────────────────────────────────────────────
function PnlReport({ range, loc, canDownload }: { range: RangeState; loc: LocationFilterState; canDownload: boolean }) {
  const { options, loading: locLoading } = useLocationOptions();
  const { data, isLoading } = useFinancialStatements(range, loc);
  const pl = data?.profitAndLoss;
  const s = pl?.summary;
  const locLabel = loc.key ? (options.find((o) => `${o.type}:${o.id}` === loc.key)?.name ?? loc.key) : COMPANY_WIDE;

  // ── Standard trading-account presentation ─────────────────────────────────
  // Sales returns are netted into the sales subtree by the books (a credit
  // note debits Sales), so the server sends the split separately. The
  // generated response type predates these fields, hence the casts.
  const salesReturns = Number((pl?.incomes as any)?.salesReturns ?? 0);
  const grossSales = Number((pl?.incomes as any)?.grossSales ?? (pl?.incomes.sales ?? 0));
  const directIncome = pl?.incomes.directIncomes.total ?? 0;
  const goodsAvailable = pl
    ? pl.expenses.openingStock + pl.expenses.purchases + pl.expenses.directExpenses.total
    : 0;
  // Financial charges and depreciation are ordinary indirect-expense ledgers;
  // they get their own statement lines when such ledgers exist. Topmost match
  // only — a node's balance already includes its whole subtree. The match is
  // deliberately narrow (charges/paid/expense phrasing, not any "interest…"
  // mention) so recovery/receipt-named contra ledgers are never pulled in;
  // anything unmatched stays inside the Indirect Expenses remainder, which is
  // computed by subtraction, so the statement always ties to Net Profit
  // regardless of how the split classifies.
  const pickByName = (nodes: { name: string; balance: number; children: any[] }[], re: RegExp): number => {
    let t = 0;
    for (const n of nodes) {
      if (re.test(n.name)) t += n.balance;
      else t += pickByName(n.children ?? [], re);
    }
    return t;
  };
  const indirectNodes = (pl?.expenses.indirectExpenses.children ?? []) as { name: string; balance: number; children: any[] }[];
  const depreciation = pickByName(indirectNodes, /\bdeprec/i);
  const financialCharges = pickByName(
    indirectNodes,
    /(bank|financ\w*|loan) charg|interest (paid|expense|on )|\bfinance cost/i,
  );
  const otherIndirect = (pl?.expenses.indirectExpenses.total ?? 0) - depreciation - financialCharges;

  type StmtRow = { name: string; amount: number | null; kind?: 'line' | 'sub' | 'total'; less?: boolean; id?: string };
  const stmtRows: StmtRow[] = pl ? [
    { name: 'Sales (net of GST)', amount: grossSales },
    { name: 'Less: Sales Returns', amount: salesReturns, less: true },
    { name: 'Net Sales', amount: pl.incomes.sales, kind: 'sub' },
    ...(Math.abs(directIncome) > 0.005 ? [{ name: 'Add: Direct Income', amount: directIncome }] : []),
    { name: 'Opening Stock', amount: pl.expenses.openingStock },
    { name: 'Add: Purchases (net of returns)', amount: pl.expenses.purchases },
    { name: 'Add: Direct Expenses', amount: pl.expenses.directExpenses.total },
    { name: 'Goods Available for Sale', amount: goodsAvailable, kind: 'sub' },
    { name: 'Less: Closing Stock', amount: pl.incomes.closingStock, less: true },
    { name: 'Cost of Goods Sold (COGS)', amount: s?.costOfGoodsSold ?? 0, kind: 'sub' },
    { name: `Gross ${(s?.grossProfit ?? 0) >= 0 ? 'Profit' : 'Loss'} (GP)`, amount: Math.abs(s?.grossProfit ?? 0), kind: 'total', id: 'pl-gross-profit' },
    { name: 'Add: Other Income', amount: s?.otherIncome ?? 0 },
    { name: 'Less: Indirect Expenses', amount: otherIndirect, less: true },
    { name: 'Less: Financial Charges', amount: financialCharges, less: true },
    { name: 'Less: Depreciation', amount: depreciation, less: true },
    { name: `Net ${(s?.netProfit ?? 0) >= 0 ? 'Profit' : 'Loss'} (NP)`, amount: Math.abs(s?.netProfit ?? 0), kind: 'total', id: 'pl-net-profit' },
  ] : [];

  // Dashboard GP/NP tiles link here with #pl-gross-profit / #pl-net-profit.
  useEffect(() => {
    if (isLoading) return undefined;
    const h = window.location.hash.slice(1);
    if (h !== 'pl-gross-profit' && h !== 'pl-net-profit') return undefined;
    const el = document.getElementById(h);
    if (!el) return undefined;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('bg-primary/10');
    const t = setTimeout(() => el.classList.remove('bg-primary/10'), 2500);
    return () => clearTimeout(t);
  }, [isLoading]);

  const expenseLines: Line[] = pl ? [
    { name: 'Opening Stock', amount: pl.expenses.openingStock, depth: 0, key: 'pl:openingStock', parentKey: null },
    { name: 'Purchases', amount: pl.expenses.purchases, depth: 0, key: 'pl:purchases', parentKey: null },
    ...groupLines(pl.expenses.directExpenses),
    ...groupLines(pl.expenses.indirectExpenses),
  ] : [];
  const incomeLines: Line[] = pl ? [
    { name: 'Sales (net of GST)', amount: pl.incomes.sales, depth: 0, key: 'pl:sales', parentKey: null },
    {
      name: 'Closing Stock', amount: pl.incomes.closingStock, depth: 0,
      key: 'pl:closingStock', parentKey: null,
      hasChildren: pl.incomes.closingStockInTransit > 0.005,
    },
    ...(pl.incomes.closingStockInTransit > 0.005
      ? [{ name: 'of which in transit', amount: pl.incomes.closingStockInTransit, depth: 1, key: 'pl:closingStock/transit', parentKey: 'pl:closingStock' }] : []),
    ...groupLines(pl.incomes.directIncomes),
    ...groupLines(pl.incomes.indirectIncomes),
  ] : [];

  // Default open: top-level sections (depth 0). Deep sub-ledgers stay collapsed.
  const expCol = useCollapse(expenseLines, (l) => l.depth === 0);
  const incCol = useCollapse(incomeLines, (l) => l.depth === 0);

  const toRows = (lines: Line[]) => lines.map((l) => [`${'   '.repeat(l.depth)}${l.name}`, pdfMoney(l.amount)] as (string | number)[]);

  const doc = (): ReportDoc => ({
    title: 'Profit & Loss Statement',
    subtitle: `Period: ${periodLabel(range.from, range.to)} · ${locLabel}`,
    metaRows: [
      ['Period', periodLabel(range.from, range.to)],
      ['Revenue', pdfMoney(s?.revenue)],
      ['Gross Profit', `${pdfMoney(s?.grossProfit)} (${pct(s?.grossMarginPct)})`],
      ['Net Profit', `${pdfMoney(s?.netProfit)} (${pct(s?.netMarginPct)})`],
    ],
    sections: [
      {
        heading: 'Trading and Profit & Loss (standard format)',
        columns: [{ label: 'Particulars', width: 3 }, MONEY_COL],
        rows: stmtRows.map((r) => [
          r.kind === 'total' ? r.name.toUpperCase() : r.name,
          pdfMoney(r.amount ?? 0),
        ] as (string | number)[]),
        totalsRow: [`Net ${(s?.netProfit ?? 0) >= 0 ? 'Profit' : 'Loss'}`, pdfMoney(Math.abs(s?.netProfit ?? 0))],
      },
      {
        heading: 'Expenses',
        columns: [{ label: 'Particulars', width: 3 }, MONEY_COL],
        rows: toRows(expenseLines),
        totalsRow: ['Total Expenses', pdfMoney(pl?.expenses.total)],
      },
      {
        heading: 'Incomes',
        columns: [{ label: 'Particulars', width: 3 }, MONEY_COL],
        rows: toRows(incomeLines),
        totalsRow: ['Total Incomes', pdfMoney(pl?.incomes.total)],
      },
    ],
    footerNote: `Net ${(pl?.netProfit ?? 0) >= 0 ? 'Profit' : 'Loss'}: ${pdfMoney(Math.abs(pl?.netProfit ?? 0))}. `
      + `Inventory is periodic: purchases are expensed and stock enters through opening and closing stock, valued at weighted-average cost.`
      + (pl?.expenses.openingStockReliable === false ? ` Opening stock is incomplete — see the note on screen.` : ''),
  });

  return (
    <div className="space-y-4">
      <RangeBar range={range}>
        <LocationFilter state={loc} options={options} loading={locLoading} />
        <ExportButtons
          canDownload={canDownload}
          disabled={isLoading || !pl}
          doc={doc}
          onCSV={() => downloadCSV('profit-and-loss.csv', [
            ...stmtRows.map((r) => ({ Side: 'Statement', Particulars: r.name, 'Amount (₹)': (r.amount ?? 0).toFixed(2) })),
            ...expenseLines.map((l) => ({ Side: 'Expenses', Particulars: l.name, 'Amount (₹)': l.amount.toFixed(2) })),
            { Side: 'Expenses', Particulars: 'TOTAL', 'Amount (₹)': (pl?.expenses.total ?? 0).toFixed(2) },
            ...incomeLines.map((l) => ({ Side: 'Incomes', Particulars: l.name, 'Amount (₹)': l.amount.toFixed(2) })),
            { Side: 'Incomes', Particulars: 'TOTAL', 'Amount (₹)': (pl?.incomes.total ?? 0).toFixed(2) },
            { Side: '', Particulars: 'NET PROFIT', 'Amount (₹)': (pl?.netProfit ?? 0).toFixed(2) },
          ])}
        />
      </RangeBar>

      <IntegrityBanner integrity={data?.integrity} />
      <CompanyLevelNote active={!!loc.key} companyLevel={(data as any)?.companyLevel} />

      <SummaryCards cards={[
        { label: 'Revenue (net of GST)', value: fmt(s?.revenue), tone: 'accent' },
        { label: 'Gross Profit', value: `${fmt(s?.grossProfit)} · ${pct(s?.grossMarginPct)}`, tone: (s?.grossProfit ?? 0) >= 0 ? 'pos' : 'neg' },
        { label: 'Operating Expenses', value: fmt(s?.operatingExpenses), tone: 'warn' },
        { label: (s?.netProfit ?? 0) >= 0 ? 'Net Profit' : 'Net Loss', value: `${fmt(Math.abs(s?.netProfit ?? 0))} · ${pct(s?.netMarginPct)}`, tone: (s?.netProfit ?? 0) >= 0 ? 'pos' : 'neg' },
      ]} />

      {pl?.expenses.openingStockReliable === false && pl.expenses.openingStockNote && (
        <NoteLine>{pl.expenses.openingStockNote}</NoteLine>
      )}
      {pl?.incomes.closingStockReliable === false && pl.incomes.closingStockNote && (
        <NoteLine>{pl.incomes.closingStockNote}</NoteLine>
      )}
      <NoteLine>
        Basis: <b>Periodic</b>. Inventory is accounted periodically — purchases are expensed and stock
        enters through opening and closing stock at weighted-average cost. Cost of goods sold is therefore
        opening stock + purchases − closing stock. This differs from the Sales → Profitability report,
        which computes gross profit per item from actual batch cost (perpetual method); the two
        gross-profit figures are legitimately different and will not tie out.
      </NoteLine>

      {/* ── Standard trading-account statement ──────────────────────────── */}
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="px-4 py-2.5 border-b border-border bg-muted/30">
          <h3 className="text-sm font-semibold">Trading and Profit &amp; Loss Account</h3>
          <p className="text-xs text-muted-foreground">Standard vertical format · {periodLabel(range.from, range.to)} · {locLabel}</p>
        </div>
        {isLoading ? (
          <div className="p-4 space-y-2">{[...Array(8)].map((_, i) => <Skeleton key={i} className="h-5" />)}</div>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {stmtRows.map((r) => (
                <tr
                  key={r.name}
                  id={r.id}
                  className={`transition-colors ${
                    r.kind === 'total'
                      ? 'border-t-2 border-b-2 border-border font-bold'
                      : r.kind === 'sub'
                        ? 'border-t border-border/60 font-semibold'
                        : ''
                  }`}
                >
                  <td className={`px-4 py-1.5 ${r.less ? 'pl-8 text-muted-foreground' : r.kind ? '' : 'pl-8'}`}>{r.name}</td>
                  <td className={`px-4 py-1.5 text-right font-mono ${
                    r.kind === 'total'
                      ? (r.name.startsWith('Gross') ? ((s?.grossProfit ?? 0) >= 0 ? 'text-emerald-600' : 'text-red-500')
                        : ((s?.netProfit ?? 0) >= 0 ? 'text-emerald-600' : 'text-red-500'))
                      : ''
                  }`}>
                    {r.less ? `(${fmt(r.amount ?? 0)})` : fmt(r.amount ?? 0)}
                    {r.id === 'pl-gross-profit' && s?.grossMarginPct != null ? <span className="text-xs text-muted-foreground font-sans"> · {pct(s.grossMarginPct)}</span> : null}
                    {r.id === 'pl-net-profit' && s?.netMarginPct != null ? <span className="text-xs text-muted-foreground font-sans"> · {pct(s.netMarginPct)}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-muted-foreground">Expenses</h3>
            <DisclosureControls expandAll={expCol.expandAll} collapseAll={expCol.collapseAll} disabled={isLoading || !expCol.hasCollapsible} />
          </div>
          <LineTable lines={expenseLines} total={pl?.expenses.total ?? 0} totalLabel="Total Expenses" loading={isLoading} expanded={expCol.expanded} onToggle={expCol.toggle} />
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-muted-foreground">Incomes</h3>
            <DisclosureControls expandAll={incCol.expandAll} collapseAll={incCol.collapseAll} disabled={isLoading || !incCol.hasCollapsible} />
          </div>
          <LineTable lines={incomeLines} total={pl?.incomes.total ?? 0} totalLabel="Total Incomes" loading={isLoading} expanded={incCol.expanded} onToggle={incCol.toggle} />
        </div>
      </div>
    </div>
  );
}

// ── Balance Sheet ─────────────────────────────────────────────────────────────
function BalanceSheetReport({ range, loc, canDownload }: { range: RangeState; loc: LocationFilterState; canDownload: boolean }) {
  const { options, loading: locLoading } = useLocationOptions();
  const { data, isLoading } = useFinancialStatements(range, loc);
  const bs = data?.balanceSheet;
  const locLabel = loc.key ? (options.find((o) => `${o.type}:${o.id}` === loc.key)?.name ?? loc.key) : COMPANY_WIDE;

  const liabilityLines: Line[] = bs ? [
    ...groupLines(bs.liabilities.capitalAccount),
    { name: 'Reserves & Surplus (P&L)', amount: bs.liabilities.pandlCarryForward, depth: 0, key: 'bs:pandlCarryForward', parentKey: null },
    ...groupLines(bs.liabilities.loans),
    ...groupLines(bs.liabilities.currentLiabilities),
  ] : [];
  const assetLines: Line[] = bs ? [
    ...groupLines(bs.assets.fixedAssets),
    { name: 'Closing Stock', amount: bs.assets.closingStock, depth: 0, key: 'bs:closingStock', parentKey: null },
    ...groupLines(bs.assets.currentAssets),
  ] : [];

  // Default open: top-level sections (depth 0). Deep sub-ledgers stay collapsed.
  const liaCol = useCollapse(liabilityLines, (l) => l.depth === 0);
  const astCol = useCollapse(assetLines, (l) => l.depth === 0);

  const toRows = (lines: Line[]) => lines.map((l) => [`${'   '.repeat(l.depth)}${l.name}`, pdfMoney(l.amount)] as (string | number)[]);
  const asAt = range.to || 'today';

  const doc = (): ReportDoc => ({
    title: 'Balance Sheet',
    subtitle: `As at ${asAt} · ${locLabel}`,
    metaRows: [
      ['As at', asAt],
      ['Total Liabilities', pdfMoney(bs?.liabilities.total)],
      ['Total Assets', pdfMoney(bs?.assets.total)],
      ['Balanced', data?.integrity.balanced ? 'Yes' : `No — out by ${pdfMoney(data?.integrity.difference)}`],
    ],
    sections: [
      {
        heading: 'Liabilities',
        columns: [{ label: 'Particulars', width: 3 }, MONEY_COL],
        rows: toRows(liabilityLines),
        totalsRow: ['Total Liabilities', pdfMoney(bs?.liabilities.total)],
      },
      {
        heading: 'Assets',
        columns: [{ label: 'Particulars', width: 3 }, MONEY_COL],
        rows: toRows(assetLines),
        totalsRow: ['Total Assets', pdfMoney(bs?.assets.total)],
      },
    ],
    footerNote: data?.integrity.balanced
      ? 'Assets equal liabilities plus retained profit. No balancing figure has been used.'
      : `WARNING: out by ${pdfMoney(data?.integrity.difference)}. This is a data defect, not a balancing figure.`,
  });

  return (
    <div className="space-y-4">
      <RangeBar range={range}>
        <LocationFilter state={loc} options={options} loading={locLoading} />
        <ExportButtons
          canDownload={canDownload}
          disabled={isLoading || !bs}
          doc={doc}
          onCSV={() => downloadCSV('balance-sheet.csv', [
            ...liabilityLines.map((l) => ({ Side: 'Liabilities', Particulars: l.name, 'Amount (₹)': l.amount.toFixed(2) })),
            { Side: 'Liabilities', Particulars: 'TOTAL', 'Amount (₹)': (bs?.liabilities.total ?? 0).toFixed(2) },
            ...assetLines.map((l) => ({ Side: 'Assets', Particulars: l.name, 'Amount (₹)': l.amount.toFixed(2) })),
            { Side: 'Assets', Particulars: 'TOTAL', 'Amount (₹)': (bs?.assets.total ?? 0).toFixed(2) },
          ])}
        />
      </RangeBar>

      <IntegrityBanner integrity={data?.integrity} />
      <CompanyLevelNote active={!!loc.key} companyLevel={(data as any)?.companyLevel} />

      <SummaryCards cards={[
        { label: 'Total Assets', value: fmt(bs?.assets.total) },
        { label: 'Total Liabilities', value: fmt(bs?.liabilities.total) },
        { label: 'Closing Stock', value: fmt(bs?.assets.closingStock), tone: 'accent' },
        { label: 'Reserves & Surplus', value: fmt(bs?.liabilities.pandlCarryForward), tone: (bs?.liabilities.pandlCarryForward ?? 0) >= 0 ? 'pos' : 'neg' },
      ]} />

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-muted-foreground">Liabilities</h3>
            <DisclosureControls expandAll={liaCol.expandAll} collapseAll={liaCol.collapseAll} disabled={isLoading || !liaCol.hasCollapsible} />
          </div>
          <LineTable lines={liabilityLines} total={bs?.liabilities.total ?? 0} totalLabel="Total Liabilities" loading={isLoading} expanded={liaCol.expanded} onToggle={liaCol.toggle} />
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-muted-foreground">Assets</h3>
            <DisclosureControls expandAll={astCol.expandAll} collapseAll={astCol.collapseAll} disabled={isLoading || !astCol.hasCollapsible} />
          </div>
          <LineTable lines={assetLines} total={bs?.assets.total ?? 0} totalLabel="Total Assets" loading={isLoading} expanded={astCol.expanded} onToggle={astCol.toggle} />
        </div>
      </div>
    </div>
  );
}

// ── Trial Balance ─────────────────────────────────────────────────────────────
interface TrialBalanceRow { ledgerId: number; name: string; code: string | null; type: string | null; groupName: string | null; debit: number; credit: number }
interface TrialBalancePayload { rows: TrialBalanceRow[]; totalDebit: number; totalCredit: number; difference: number; balanced: boolean; companyLevel?: CompanyLevel | null }

function TrialBalanceReport({ range, loc, canDownload }: { range: RangeState; loc: LocationFilterState; canDownload: boolean }) {
  const { options, loading: locLoading } = useLocationOptions();
  const { data, isLoading } = useReport<TrialBalancePayload>('/api/reports/fin/trial-balance', qs(range, { locationType: loc.type, locationId: loc.id }));
  const rows = data?.rows ?? [];
  const locLabel = loc.key ? (options.find((o) => `${o.type}:${o.id}` === loc.key)?.name ?? loc.key) : COMPANY_WIDE;

  const doc = (): ReportDoc => ({
    title: 'Trial Balance',
    subtitle: `Period: ${periodLabel(range.from, range.to)} · ${locLabel}`,
    orientation: 'portrait',
    metaRows: [
      ['Period', periodLabel(range.from, range.to)],
      ['Total Debit', pdfMoney(data?.totalDebit)],
      ['Total Credit', pdfMoney(data?.totalCredit)],
      ['Balanced', data?.balanced ? 'Yes' : `No — out by ${pdfMoney(data?.difference)}`],
    ],
    sections: [{
      columns: [{ label: 'Group', width: 1.6 }, { label: 'Ledger', width: 2.2 }, { label: 'Debit', align: 'right', width: 1.2 }, { label: 'Credit', align: 'right', width: 1.2 }],
      rows: rows.map((r) => [r.groupName ?? '—', r.name, r.debit ? pdfMoney(r.debit) : '', r.credit ? pdfMoney(r.credit) : '']),
      totalsRow: ['', 'Total', pdfMoney(data?.totalDebit), pdfMoney(data?.totalCredit)],
    }],
    footerNote: data?.balanced ? 'Debits equal credits.' : 'WARNING: the trial balance does not balance.',
  });

  return (
    <div className="space-y-4">
      <RangeBar range={range}>
        <LocationFilter state={loc} options={options} loading={locLoading} />
        <ExportButtons
          canDownload={canDownload} disabled={isLoading} doc={doc}
          onCSV={() => downloadCSV('trial-balance.csv', rows.map((r) => ({
            Group: r.groupName ?? '', Ledger: r.name, Code: r.code ?? '',
            'Debit (₹)': r.debit.toFixed(2), 'Credit (₹)': r.credit.toFixed(2),
          })))}
        />
      </RangeBar>

      {data && !data.balanced && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
          <p className="text-xs text-amber-700">
            Debits and credits differ by {fmt(data.difference)}. Every posting is generated as a balanced
            pair, so a difference means a posting references a ledger that no longer exists.
          </p>
        </div>
      )}
      <CompanyLevelNote active={!!loc.key} companyLevel={data?.companyLevel} />

      <SummaryCards cards={[
        { label: 'Ledgers', value: num(rows.length) },
        { label: 'Total Debit', value: fmt(data?.totalDebit) },
        { label: 'Total Credit', value: fmt(data?.totalCredit) },
        { label: 'Difference', value: fmt(data?.difference), tone: data?.balanced ? 'pos' : 'neg' },
      ]} />

      <RTable
        cols={[
          { key: 'groupName', label: 'Group', render: (r) => r.groupName ?? '—' },
          { key: 'name', label: 'Ledger', render: (r) => (
            <span className="font-medium">{r.name}{r.code ? <span className="text-muted-foreground font-mono text-[10px] ml-1.5">{r.code}</span> : null}</span>
          ) },
          { key: 'debit', label: 'Debit', align: 'right', render: (r) => (r.debit ? fmt(r.debit) : '—') },
          { key: 'credit', label: 'Credit', align: 'right', render: (r) => (r.credit ? fmt(r.credit) : '—') },
        ] satisfies Col<TrialBalanceRow>[]}
        rows={rows} loading={isLoading} rowKey={(r) => r.ledgerId}
        footer={['', 'Total', fmt(data?.totalDebit), fmt(data?.totalCredit)]}
      />
    </div>
  );
}

// ── Day Book ──────────────────────────────────────────────────────────────────
interface DayBookEntry { id: string; date: string; source: string; voucherNumber: string | null; narration: string | null; particulars: string; debit: number; credit: number; amount: number }
interface DayBookPayload { entries: DayBookEntry[]; totals: { count: number; amount: number; debit: number; credit: number; balanced: boolean } | null; companyLevel?: CompanyLevel | null }

function DayBookReport({ range, loc, canDownload }: { range: RangeState; loc: LocationFilterState; canDownload: boolean }) {
  const { options, loading: locLoading } = useLocationOptions();
  const { data, isLoading } = useReport<DayBookPayload>('/api/reports/fin/day-book', qs(range, { locationType: loc.type, locationId: loc.id }));
  const rows = data?.entries ?? [];

  const doc = (): ReportDoc => ({
    title: 'Day Book',
    subtitle: `Period: ${periodLabel(range.from, range.to)}`,
    orientation: 'landscape',
    metaRows: [['Period', periodLabel(range.from, range.to)], ['Entries', String(data?.totals?.count ?? 0)], ['Total Debit', pdfMoney(data?.totals?.debit)], ['Total Credit', pdfMoney(data?.totals?.credit)]],
    sections: [{
      columns: [{ label: 'Date', width: 1 }, { label: 'Voucher', width: 1.3 }, { label: 'Type', width: 0.9 }, { label: 'Particulars', width: 3.4 }, { label: 'Amount', align: 'right', width: 1.2 }],
      rows: rows.map((e) => [e.date, e.voucherNumber ?? '—', e.source, e.particulars, pdfMoney(e.amount)]),
      totalsRow: ['', '', '', 'Total', pdfMoney(data?.totals?.amount)],
    }],
  });

  return (
    <div className="space-y-4">
      <RangeBar range={range}>
        <LocationFilter state={loc} options={options} loading={locLoading} />
        <ExportButtons
          canDownload={canDownload} disabled={isLoading} doc={doc}
          onCSV={() => downloadCSV('day-book.csv', rows.map((e) => ({
            Date: e.date, Voucher: e.voucherNumber ?? '', Type: e.source,
            Particulars: e.particulars, Narration: e.narration ?? '',
            'Debit (₹)': e.debit.toFixed(2), 'Credit (₹)': e.credit.toFixed(2),
          })))}
        />
      </RangeBar>

      <CompanyLevelNote active={!!loc.key} companyLevel={data?.companyLevel} />

      <SummaryCards cards={[
        { label: 'Entries', value: num(data?.totals?.count) },
        { label: 'Total Debit', value: fmt(data?.totals?.debit) },
        { label: 'Total Credit', value: fmt(data?.totals?.credit) },
        { label: 'Balanced', value: data?.totals?.balanced === false ? 'No' : 'Yes', tone: data?.totals?.balanced === false ? 'neg' : 'pos' },
      ]} />

      <RTable
        cols={[
          { key: 'date', label: 'Date', render: (e) => fmtDate(e.date) },
          { key: 'voucherNumber', label: 'Voucher', render: (e) => <span className="font-mono text-xs">{e.voucherNumber ?? '—'}</span> },
          { key: 'source', label: 'Type', render: (e) => <span className="capitalize text-xs">{e.source}</span> },
          { key: 'particulars', label: 'Particulars', render: (e) => (
            <div className="max-w-md">
              <p className="truncate">{e.particulars}</p>
              {e.narration && <p className="text-[11px] text-muted-foreground truncate">{e.narration}</p>}
            </div>
          ) },
          { key: 'amount', label: 'Amount', align: 'right', render: (e) => fmt(e.amount) },
        ] satisfies Col<DayBookEntry>[]}
        rows={rows} loading={isLoading} rowKey={(e) => e.id}
        footer={['', '', '', 'Total', fmt(data?.totals?.amount)]}
      />
    </div>
  );
}

// ── Ledger report ─────────────────────────────────────────────────────────────
interface LedgerRow { ledgerId: number; name: string; code: string | null; groupName: string | null; rootCode: string | null; opening: number; debit: number; credit: number; closing: number }
interface LedgersPayload { rows: LedgerRow[]; totals: { opening: number; debit: number; credit: number; closing: number } | null; companyLevel?: CompanyLevel | null }

function LedgersReport({ range, loc, canDownload }: { range: RangeState; loc: LocationFilterState; canDownload: boolean }) {
  const { options, loading: locLoading } = useLocationOptions();
  const { data, isLoading } = useReport<LedgersPayload>('/api/reports/fin/ledgers', qs(range, { locationType: loc.type, locationId: loc.id }));
  const rows = data?.rows ?? [];

  const doc = (): ReportDoc => ({
    title: 'Ledger Balances',
    subtitle: `Period: ${periodLabel(range.from, range.to)}`,
    orientation: 'landscape',
    metaRows: [['Period', periodLabel(range.from, range.to)], ['Ledgers', String(rows.length)]],
    sections: [{
      columns: [
        { label: 'Group', width: 1.5 }, { label: 'Ledger', width: 2 },
        { label: 'Opening', align: 'right', width: 1.1 }, { label: 'Debit', align: 'right', width: 1.1 },
        { label: 'Credit', align: 'right', width: 1.1 }, { label: 'Closing', align: 'right', width: 1.1 },
      ],
      rows: rows.map((r) => [r.groupName ?? '—', r.name, pdfMoney(r.opening), pdfMoney(r.debit), pdfMoney(r.credit), pdfMoney(r.closing)]),
      totalsRow: ['', 'Total', pdfMoney(data?.totals?.opening), pdfMoney(data?.totals?.debit), pdfMoney(data?.totals?.credit), pdfMoney(data?.totals?.closing)],
    }],
    footerNote: 'A positive balance is a net debit; a negative balance is a net credit.',
  });

  return (
    <div className="space-y-4">
      <RangeBar range={range}>
        <LocationFilter state={loc} options={options} loading={locLoading} />
        <ExportButtons
          canDownload={canDownload} disabled={isLoading} doc={doc}
          onCSV={() => downloadCSV('ledger-balances.csv', rows.map((r) => ({
            Group: r.groupName ?? '', Ledger: r.name, Code: r.code ?? '',
            'Opening (₹)': r.opening.toFixed(2), 'Debit (₹)': r.debit.toFixed(2),
            'Credit (₹)': r.credit.toFixed(2), 'Closing (₹)': r.closing.toFixed(2),
          })))}
        />
      </RangeBar>

      <NoteLine>A positive balance is a net debit; a negative balance is a net credit. Ledgers with no movement and no balance are omitted.</NoteLine>
      <CompanyLevelNote active={!!loc.key} companyLevel={data?.companyLevel} />

      <RTable
        cols={[
          { key: 'groupName', label: 'Group', render: (r) => r.groupName ?? '—' },
          { key: 'name', label: 'Ledger', render: (r) => <span className="font-medium">{r.name}</span> },
          { key: 'opening', label: 'Opening', align: 'right', render: (r) => fmt(r.opening) },
          { key: 'debit', label: 'Debit', align: 'right', render: (r) => fmt(r.debit) },
          { key: 'credit', label: 'Credit', align: 'right', render: (r) => fmt(r.credit) },
          { key: 'closing', label: 'Closing', align: 'right', render: (r) => <span className="font-semibold">{fmt(r.closing)}</span> },
        ] satisfies Col<LedgerRow>[]}
        rows={rows} loading={isLoading} rowKey={(r) => r.ledgerId}
        footer={['', 'Total', fmt(data?.totals?.opening), fmt(data?.totals?.debit), fmt(data?.totals?.credit), fmt(data?.totals?.closing)]}
      />
    </div>
  );
}

// ── Cash / Bank books ─────────────────────────────────────────────────────────
interface BookEntry { date: string; source: string; voucherNumber: string | null; description: string; account: string; receipt: number; payment: number; balance: number }
interface BookAccount { ledgerId: number; name: string; opening: number; inflow: number; outflow: number; closing: number }
interface BookPayload {
  scope: { ledgerId: number | null; name: string };
  openingBalance: number; entries: BookEntry[];
  totalReceipts: number; totalPayments: number; closingBalance: number;
  accounts: BookAccount[];
  companyLevel?: CompanyLevel | null;
}

function BookReport({ kind, range, loc, canDownload }: { kind: 'cash' | 'bank'; range: RangeState; loc: LocationFilterState; canDownload: boolean }) {
  const [ledgerId, setLedgerId] = useState(0);
  const { options, loading: locLoading } = useLocationOptions();
  const { data, isLoading } = useReport<BookPayload>(`/api/reports/fin/${kind}`, qs(range, { ledgerId, locationType: loc.type, locationId: loc.id }));
  const rows = data?.entries ?? [];
  const label = kind === 'cash' ? 'Cash' : 'Bank';

  const doc = (): ReportDoc => ({
    title: `${label} Book`,
    subtitle: `${data?.scope.name ?? ''} · ${periodLabel(range.from, range.to)}`,
    orientation: 'landscape',
    metaRows: [
      ['Period', periodLabel(range.from, range.to)],
      ['Opening Balance', pdfMoney(data?.openingBalance)],
      ['Receipts', pdfMoney(data?.totalReceipts)],
      ['Payments', pdfMoney(data?.totalPayments)],
      ['Closing Balance', pdfMoney(data?.closingBalance)],
    ],
    sections: [
      {
        heading: `${label} accounts`,
        columns: [{ label: 'Account', width: 2.4 }, { label: 'Opening', align: 'right', width: 1.1 }, { label: 'In', align: 'right', width: 1.1 }, { label: 'Out', align: 'right', width: 1.1 }, { label: 'Closing', align: 'right', width: 1.1 }],
        rows: (data?.accounts ?? []).map((a) => [a.name, pdfMoney(a.opening), pdfMoney(a.inflow), pdfMoney(a.outflow), pdfMoney(a.closing)]),
      },
      {
        heading: 'Transactions',
        columns: [{ label: 'Date', width: 1 }, { label: 'Voucher', width: 1.3 }, { label: 'Account', width: 1.6 }, { label: 'Particulars', width: 2.4 }, { label: 'Receipt', align: 'right', width: 1 }, { label: 'Payment', align: 'right', width: 1 }, { label: 'Balance', align: 'right', width: 1.1 }],
        rows: rows.map((e) => [e.date, e.voucherNumber ?? '—', e.account, e.description, e.receipt ? pdfMoney(e.receipt) : '', e.payment ? pdfMoney(e.payment) : '', pdfMoney(e.balance)]),
        totalsRow: ['', '', '', 'Total', pdfMoney(data?.totalReceipts), pdfMoney(data?.totalPayments), pdfMoney(data?.closingBalance)],
      },
    ],
  });

  return (
    <div className="space-y-4">
      <RangeBar range={range}>
        <LocationFilter state={loc} options={options} loading={locLoading} />
        <select
          value={ledgerId}
          onChange={(e) => setLedgerId(Number(e.target.value))}
          className="h-8 rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
        >
          <option value={0}>All {kind} accounts</option>
          {(data?.accounts ?? []).map((a) => <option key={a.ledgerId} value={a.ledgerId}>{a.name}</option>)}
        </select>
        <ExportButtons
          canDownload={canDownload} disabled={isLoading} doc={doc}
          onCSV={() => downloadCSV(`${kind}-book.csv`, rows.map((e) => ({
            Date: e.date, Voucher: e.voucherNumber ?? '', Account: e.account, Particulars: e.description,
            'Receipt (₹)': e.receipt.toFixed(2), 'Payment (₹)': e.payment.toFixed(2), 'Balance (₹)': e.balance.toFixed(2),
          })))}
        />
      </RangeBar>

      <CompanyLevelNote active={!!loc.key} companyLevel={data?.companyLevel} />

      <SummaryCards cards={[
        { label: 'Opening Balance', value: fmt(data?.openingBalance) },
        { label: 'Receipts', value: fmt(data?.totalReceipts), tone: 'pos' },
        { label: 'Payments', value: fmt(data?.totalPayments), tone: 'warn' },
        { label: 'Closing Balance', value: fmt(data?.closingBalance), tone: (data?.closingBalance ?? 0) >= 0 ? 'pos' : 'neg' },
      ]} />

      {(data?.accounts.length ?? 0) > 1 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-muted-foreground">{label} position by account</h3>
          <RTable
            cols={[
              { key: 'name', label: 'Account', render: (a) => <span className="font-medium">{a.name}</span> },
              { key: 'opening', label: 'Opening', align: 'right', render: (a) => fmt(a.opening) },
              { key: 'inflow', label: 'In', align: 'right', render: (a) => fmt(a.inflow) },
              { key: 'outflow', label: 'Out', align: 'right', render: (a) => fmt(a.outflow) },
              { key: 'closing', label: 'Closing', align: 'right', render: (a) => <span className="font-semibold">{fmt(a.closing)}</span> },
            ] satisfies Col<BookAccount>[]}
            rows={data?.accounts ?? []} loading={isLoading} rowKey={(a) => a.ledgerId}
          />
        </div>
      )}

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-muted-foreground">Transactions</h3>
        <RTable
          cols={[
            { key: 'date', label: 'Date', render: (e) => fmtDate(e.date) },
            { key: 'voucherNumber', label: 'Voucher', render: (e) => <span className="font-mono text-xs">{e.voucherNumber ?? '—'}</span> },
            { key: 'account', label: 'Account' },
            { key: 'description', label: 'Particulars', render: (e) => <span className="block max-w-xs truncate">{e.description}</span> },
            { key: 'receipt', label: 'Receipt', align: 'right', render: (e) => (e.receipt ? fmt(e.receipt) : '—') },
            { key: 'payment', label: 'Payment', align: 'right', render: (e) => (e.payment ? fmt(e.payment) : '—') },
            { key: 'balance', label: 'Balance', align: 'right', render: (e) => <span className="font-semibold">{fmt(e.balance)}</span> },
          ] satisfies Col<BookEntry>[]}
          rows={rows} loading={isLoading} rowKey={(_, i) => i}
          footer={['', '', '', 'Total', fmt(data?.totalReceipts), fmt(data?.totalPayments), fmt(data?.closingBalance)]}
        />
      </div>
    </div>
  );
}

// ── GST summary ───────────────────────────────────────────────────────────────
interface GstSide { cgst: number; sgst: number; igst: number; total: number }
interface GstPayload {
  output: GstSide; input: GstSide; netPayable: number;
  taxableTurnover: number; taxablePurchases: number;
  byMonth: { month: string; output: number; input: number; net: number }[];
}

function GstReport({ range, canDownload }: { range: RangeState; canDownload: boolean }) {
  const { data, isLoading } = useReport<GstPayload>('/api/reports/fin/gst', qs(range));
  const payable = data?.netPayable ?? 0;

  const headRows: (string | number)[][] = data ? [
    ['CGST', pdfMoney(data.output.cgst), pdfMoney(data.input.cgst), pdfMoney(data.output.cgst - data.input.cgst)],
    ['SGST', pdfMoney(data.output.sgst), pdfMoney(data.input.sgst), pdfMoney(data.output.sgst - data.input.sgst)],
    ['IGST', pdfMoney(data.output.igst), pdfMoney(data.input.igst), pdfMoney(data.output.igst - data.input.igst)],
  ] : [];

  const doc = (): ReportDoc => ({
    title: 'GST Summary',
    subtitle: `Period: ${periodLabel(range.from, range.to)}`,
    metaRows: [
      ['Period', periodLabel(range.from, range.to)],
      ['Taxable turnover', pdfMoney(data?.taxableTurnover)],
      ['Output tax', pdfMoney(data?.output.total)],
      ['Input credit', pdfMoney(data?.input.total)],
      [payable >= 0 ? 'Net payable' : 'Credit carried forward', pdfMoney(Math.abs(payable))],
    ],
    sections: [
      {
        heading: 'By tax head',
        columns: [{ label: 'Head', width: 1.4 }, { label: 'Output tax', align: 'right', width: 1.3 }, { label: 'Input credit', align: 'right', width: 1.3 }, { label: 'Net', align: 'right', width: 1.3 }],
        rows: headRows,
        totalsRow: ['Total', pdfMoney(data?.output.total), pdfMoney(data?.input.total), pdfMoney(payable)],
      },
      {
        heading: 'By month',
        columns: [{ label: 'Month', width: 1.4 }, { label: 'Output tax', align: 'right', width: 1.3 }, { label: 'Input credit', align: 'right', width: 1.3 }, { label: 'Net', align: 'right', width: 1.3 }],
        rows: (data?.byMonth ?? []).map((m) => [m.month, pdfMoney(m.output), pdfMoney(m.input), pdfMoney(m.net)]),
      },
    ],
    footerNote: 'Derived from the posted output and input tax ledgers. A negative net is input credit carried forward, not a refund due.',
  });

  return (
    <div className="space-y-4">
      <RangeBar range={range}>
        <LocationFilter state={{ key: '', setKey: () => {}, type: '', id: 0, label: COMPANY_WIDE }} options={[]} disabledReason={COMPANY_WIDE} />
        <ExportButtons
          canDownload={canDownload} disabled={isLoading} doc={doc}
          onCSV={() => downloadCSV('gst-summary.csv', (data?.byMonth ?? []).map((m) => ({
            Month: m.month, 'Output tax (₹)': m.output.toFixed(2), 'Input credit (₹)': m.input.toFixed(2), 'Net (₹)': m.net.toFixed(2),
          })))}
        />
      </RangeBar>

      <SummaryCards cards={[
        { label: 'Taxable turnover', value: fmt(data?.taxableTurnover), tone: 'accent' },
        { label: 'Output tax', value: fmt(data?.output.total) },
        { label: 'Input credit', value: fmt(data?.input.total) },
        { label: payable >= 0 ? 'Net payable' : 'Credit carried forward', value: fmt(Math.abs(payable)), tone: payable >= 0 ? 'warn' : 'pos' },
      ]} />

      {payable < 0 && (
        <NoteLine>
          Input credit exceeds output tax for this period, so nothing is payable — the balance carries
          forward. It is not a refund due.
        </NoteLine>
      )}

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-muted-foreground">By tax head</h3>
          <RTable
            cols={[
              { key: 'head', label: 'Head' },
              { key: 'output', label: 'Output tax', align: 'right' },
              { key: 'input', label: 'Input credit', align: 'right' },
              { key: 'net', label: 'Net', align: 'right' },
            ] satisfies Col<{ head: string; output: string; input: string; net: string }>[]}
            rows={data ? [
              { head: 'CGST', output: fmt(data.output.cgst), input: fmt(data.input.cgst), net: fmt(data.output.cgst - data.input.cgst) },
              { head: 'SGST', output: fmt(data.output.sgst), input: fmt(data.input.sgst), net: fmt(data.output.sgst - data.input.sgst) },
              { head: 'IGST', output: fmt(data.output.igst), input: fmt(data.input.igst), net: fmt(data.output.igst - data.input.igst) },
            ] : []}
            loading={isLoading} rowKey={(r) => r.head}
            footer={['Total', fmt(data?.output.total), fmt(data?.input.total), fmt(payable)]}
          />
        </div>
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-muted-foreground">By month</h3>
          <RTable
            cols={[
              { key: 'month', label: 'Month' },
              { key: 'output', label: 'Output tax', align: 'right', render: (m) => fmt(m.output) },
              { key: 'input', label: 'Input credit', align: 'right', render: (m) => fmt(m.input) },
              { key: 'net', label: 'Net', align: 'right', render: (m) => <span className="font-semibold">{fmt(m.net)}</span> },
            ] satisfies Col<GstPayload['byMonth'][number]>[]}
            rows={data?.byMonth ?? []} loading={isLoading} rowKey={(m) => m.month}
          />
        </div>
      </div>
    </div>
  );
}

// ── Expense report ────────────────────────────────────────────────────────────
interface ExpenseRow {
  id: number; expenseNumber: string | null; date: string; category: string;
  ledgerName: string; paidFrom: string; description: string;
  locationType: string; locationName: string; createdBy: string | null; amount: number;
}
interface Rollup { name: string; count: number; amount: number }
interface ExpensePayload { rows: ExpenseRow[]; byCategory: Rollup[]; byLedger: Rollup[]; byLocation: Rollup[]; total: number; count: number }

function ExpenseReport({ range, loc, canDownload }: { range: RangeState; loc: LocationFilterState; canDownload: boolean }) {
  const { options, loading } = useLocationOptions();
  const { data, isLoading } = useReport<ExpensePayload>('/api/reports/fin/expenses', qs(range, { locationType: loc.type, locationId: loc.id }));
  const rows = data?.rows ?? [];

  const doc = (): ReportDoc => ({
    title: 'Expense Report',
    subtitle: `Period: ${periodLabel(range.from, range.to)}${loc.key ? ` · ${options.find((o) => `${o.type}:${o.id}` === loc.key)?.name ?? ''}` : ''}`,
    orientation: 'landscape',
    metaRows: [['Period', periodLabel(range.from, range.to)], ['Vouchers', String(data?.count ?? 0)], ['Total spend', pdfMoney(data?.total)]],
    sections: [
      {
        heading: 'By category',
        columns: [{ label: 'Category', width: 2.4 }, { label: 'Vouchers', align: 'right', width: 1 }, MONEY_COL],
        rows: (data?.byCategory ?? []).map((c) => [c.name, c.count, pdfMoney(c.amount)]),
      },
      {
        heading: 'By location',
        columns: [{ label: 'Location', width: 2.4 }, { label: 'Vouchers', align: 'right', width: 1 }, MONEY_COL],
        rows: (data?.byLocation ?? []).map((c) => [c.name, c.count, pdfMoney(c.amount)]),
      },
      {
        heading: 'Register',
        columns: [{ label: 'Date', width: 1 }, { label: 'Voucher', width: 1.4 }, { label: 'Category', width: 1.3 }, { label: 'Account', width: 1.6 }, { label: 'Location', width: 1.4 }, { label: 'Particulars', width: 2 }, MONEY_COL],
        rows: rows.map((r) => [r.date, r.expenseNumber ?? '—', r.category, r.ledgerName, r.locationName, r.description, pdfMoney(r.amount)]),
        totalsRow: ['', '', '', '', '', 'Total', pdfMoney(data?.total)],
      },
    ],
  });

  return (
    <div className="space-y-4">
      <RangeBar range={range}>
        <LocationFilter state={loc} options={options} loading={loading} />
        <ExportButtons
          canDownload={canDownload} disabled={isLoading} doc={doc}
          onCSV={() => downloadCSV('expense-report.csv', rows.map((r) => ({
            Date: r.date, Voucher: r.expenseNumber ?? '', Category: r.category, Account: r.ledgerName,
            'Paid from': r.paidFrom, Location: r.locationName, Particulars: r.description,
            'Recorded by': r.createdBy ?? '', 'Amount (₹)': r.amount.toFixed(2),
          })))}
        />
      </RangeBar>

      <SummaryCards cards={[
        { label: 'Total spend', value: fmt(data?.total), tone: 'warn' },
        { label: 'Vouchers', value: num(data?.count) },
        { label: 'Categories', value: num(data?.byCategory.length) },
        { label: 'Largest category', value: data?.byCategory[0] ? `${data.byCategory[0].name} · ${fmt(data.byCategory[0].amount)}` : '—' },
      ]} />

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-muted-foreground">By category</h3>
          <RTable
            cols={[
              { key: 'name', label: 'Category' },
              { key: 'count', label: 'Vouchers', align: 'right', render: (c) => num(c.count) },
              { key: 'amount', label: 'Amount', align: 'right', render: (c) => fmt(c.amount) },
            ] satisfies Col<Rollup>[]}
            rows={data?.byCategory ?? []} loading={isLoading} rowKey={(c) => c.name}
            footer={['Total', num(data?.count), fmt(data?.total)]}
          />
        </div>
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-muted-foreground">By location</h3>
          <RTable
            cols={[
              { key: 'name', label: 'Location' },
              { key: 'count', label: 'Vouchers', align: 'right', render: (c) => num(c.count) },
              { key: 'amount', label: 'Amount', align: 'right', render: (c) => fmt(c.amount) },
            ] satisfies Col<Rollup>[]}
            rows={data?.byLocation ?? []} loading={isLoading} rowKey={(c) => c.name}
          />
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-muted-foreground">Register</h3>
        <RTable
          cols={[
            { key: 'date', label: 'Date', render: (r) => fmtDate(r.date) },
            { key: 'expenseNumber', label: 'Voucher', render: (r) => <span className="font-mono text-xs">{r.expenseNumber ?? '—'}</span> },
            { key: 'category', label: 'Category' },
            { key: 'ledgerName', label: 'Account' },
            { key: 'locationName', label: 'Location' },
            { key: 'description', label: 'Particulars', render: (r) => <span className="block max-w-xs truncate">{r.description || '—'}</span> },
            { key: 'amount', label: 'Amount', align: 'right', render: (r) => fmt(r.amount) },
          ] satisfies Col<ExpenseRow>[]}
          rows={rows} loading={isLoading} rowKey={(r) => r.id}
          footer={['', '', '', '', '', 'Total', fmt(data?.total)]}
        />
      </div>
    </div>
  );
}

// ── Salary report ─────────────────────────────────────────────────────────────
interface SalaryRow {
  id: number; employeeName: string; role: string | null; location: string; period: string;
  status: string; paidDate: string | null; workingDays: number; presentDays: number; lopDays: number;
  baseSalary: number; allowances: number; grossPay: number;
  lopDeduction: number; advanceDeduction: number; pfEmployee: number; esiEmployee: number; otherDeductions: number;
  netPay: number; paidAmount: number; pfEmployer: number; esiEmployer: number; costToCompany: number;
}
interface SalaryPayload {
  rows: SalaryRow[];
  totals: { count: number; grossPay: number; deductions: number; netPay: number; paidAmount: number; pfEmployer: number; esiEmployer: number; costToCompany: number } | null;
  byStatus: { status: string; count: number; netPay: number }[];
}

function SalaryReport({ range, canDownload }: { range: RangeState; canDownload: boolean }) {
  const { data, isLoading } = useReport<SalaryPayload>('/api/reports/fin/salary', qs(range));
  const rows = data?.rows ?? [];
  const t = data?.totals;

  const doc = (): ReportDoc => ({
    title: 'Salary Report',
    subtitle: `Period: ${periodLabel(range.from, range.to)}`,
    orientation: 'landscape',
    metaRows: [
      ['Period', periodLabel(range.from, range.to)],
      ['Payslips', String(t?.count ?? 0)],
      ['Gross pay', pdfMoney(t?.grossPay)],
      ['Net pay', pdfMoney(t?.netPay)],
      ['Cost to company', pdfMoney(t?.costToCompany)],
    ],
    sections: [{
      columns: [
        { label: 'Employee', width: 1.8 }, { label: 'Period', width: 1 }, { label: 'Location', width: 1.4 },
        { label: 'Status', width: 0.9 }, { label: 'Gross', align: 'right', width: 1.1 },
        { label: 'Deductions', align: 'right', width: 1.1 }, { label: 'Net pay', align: 'right', width: 1.1 },
        { label: 'CTC', align: 'right', width: 1.1 },
      ],
      rows: rows.map((r) => [
        r.employeeName, r.period, r.location, r.status,
        pdfMoney(r.grossPay),
        pdfMoney(r.lopDeduction + r.advanceDeduction + r.pfEmployee + r.esiEmployee + r.otherDeductions),
        pdfMoney(r.netPay), pdfMoney(r.costToCompany),
      ]),
      totalsRow: ['Total', '', '', '', pdfMoney(t?.grossPay), pdfMoney(t?.deductions), pdfMoney(t?.netPay), pdfMoney(t?.costToCompany)],
    }],
    footerNote: 'Cost to company includes employer PF and ESI, which are a company cost but not part of net pay.',
  });

  return (
    <div className="space-y-4">
      <RangeBar range={range}>
        <LocationFilter state={{ key: '', setKey: () => {}, type: '', id: 0, label: COMPANY_WIDE }} options={[]} disabledReason="All locations" />
        <ExportButtons
          canDownload={canDownload} disabled={isLoading} doc={doc}
          onCSV={() => downloadCSV('salary-report.csv', rows.map((r) => ({
            Employee: r.employeeName, Role: r.role ?? '', Location: r.location, Period: r.period, Status: r.status,
            'Working days': r.workingDays, 'Present days': r.presentDays, 'LOP days': r.lopDays,
            'Base (₹)': r.baseSalary.toFixed(2), 'Allowances (₹)': r.allowances.toFixed(2), 'Gross (₹)': r.grossPay.toFixed(2),
            'LOP (₹)': r.lopDeduction.toFixed(2), 'Advance (₹)': r.advanceDeduction.toFixed(2),
            'PF employee (₹)': r.pfEmployee.toFixed(2), 'ESI employee (₹)': r.esiEmployee.toFixed(2),
            'Net pay (₹)': r.netPay.toFixed(2), 'PF employer (₹)': r.pfEmployer.toFixed(2),
            'ESI employer (₹)': r.esiEmployer.toFixed(2), 'CTC (₹)': r.costToCompany.toFixed(2),
          })))}
        />
      </RangeBar>

      <SummaryCards cards={[
        { label: 'Payslips', value: num(t?.count) },
        { label: 'Gross pay', value: fmt(t?.grossPay) },
        { label: 'Net pay', value: fmt(t?.netPay), tone: 'accent' },
        { label: 'Cost to company', value: fmt(t?.costToCompany), tone: 'warn' },
      ]} />

      <NoteLine>
        Cost to company adds employer PF and ESI to gross pay. Those are a company cost but never part
        of an employee's net pay, so the two figures are meant to differ.
      </NoteLine>

      <RTable
        cols={[
          { key: 'employeeName', label: 'Employee', render: (r) => (
            <div><p className="font-medium">{r.employeeName}</p>{r.role && <p className="text-[11px] text-muted-foreground">{r.role}</p>}</div>
          ) },
          { key: 'period', label: 'Period' },
          { key: 'location', label: 'Location' },
          { key: 'status', label: 'Status', render: (r) => <span className="capitalize text-xs">{r.status}</span> },
          { key: 'grossPay', label: 'Gross', align: 'right', render: (r) => fmt(r.grossPay) },
          { key: 'ded', label: 'Deductions', align: 'right', render: (r) => fmt(r.lopDeduction + r.advanceDeduction + r.pfEmployee + r.esiEmployee + r.otherDeductions) },
          { key: 'netPay', label: 'Net pay', align: 'right', render: (r) => <span className="font-semibold">{fmt(r.netPay)}</span> },
          { key: 'costToCompany', label: 'CTC', align: 'right', render: (r) => fmt(r.costToCompany) },
        ] satisfies Col<SalaryRow>[]}
        rows={rows} loading={isLoading} rowKey={(r) => r.id}
        footer={['Total', '', '', '', fmt(t?.grossPay), fmt(t?.deductions), fmt(t?.netPay), fmt(t?.costToCompany)]}
      />
    </div>
  );
}

// ── Books & registers quick links ────────────────────────────────────────────
const BOOKS = [
  { title: 'Trial Balance', desc: 'Ledger-wise debit/credit balances', href: '/accounts/trial-balance', icon: Scale },
  { title: 'Day Book', desc: 'All vouchers day by day', href: '/accounts/day-book', icon: BookOpen },
  { title: 'Cash Book', desc: 'Cash ledger with running balance', href: '/accounts/cash-book', icon: Wallet },
  { title: 'Bank Book', desc: 'Bank ledger with running balance', href: '/accounts/bank-book', icon: Landmark },
  { title: 'GST Summary', desc: 'Output tax, ITC and net liability', href: '/accounts/gst', icon: Percent },
  { title: 'GST Returns', desc: 'GSTR-1 / GSTR-3B workings', href: '/accounts/gst-returns', icon: FileSpreadsheet },
  { title: 'Outstanding', desc: 'Receivables & payables follow-up', href: '/outstanding', icon: Clock },
];

function BooksLinks() {
  return (
    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {BOOKS.map((b) => {
        const Icon = b.icon;
        return (
          <Link key={b.href} href={b.href}>
            <div className="bg-card border border-border rounded-xl p-4 hover:border-primary/50 hover:shadow-md transition-all cursor-pointer group">
              <div className="flex items-start justify-between">
                <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center mb-3">
                  <Icon className="w-4.5 h-4.5 text-primary" />
                </div>
                <ArrowRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
              <p className="font-semibold text-sm text-foreground">{b.title}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{b.desc}</p>
            </div>
          </Link>
        );
      })}
    </div>
  );
}

// ── Section root ──────────────────────────────────────────────────────────────
export default function FinancialSection() {
  const { canDownload } = usePermission('page:/reports/sales');
  const range = useDateRange('fy');
  const loc = useLocationFilter();
  const [report, setReport] = useState<FinReport>('pnl');
  const cap = { canDownload };
  return (
    <div className="space-y-4">
      <ReportPicker
        options={[
          { value: 'pnl', label: 'Profit & Loss' },
          { value: 'balanceSheet', label: 'Balance Sheet' },
          { value: 'trialBalance', label: 'Trial Balance' },
          { value: 'ledgers', label: 'Ledgers' },
          { value: 'dayBook', label: 'Day Book' },
          { value: 'cash', label: 'Cash' },
          { value: 'bank', label: 'Bank' },
          { value: 'gst', label: 'GST' },
          { value: 'expenses', label: 'Expenses' },
          { value: 'salary', label: 'Salary' },
          { value: 'books', label: 'Books & Registers' },
        ]}
        value={report} onChange={setReport}
      />
      {report === 'pnl' && <PnlReport range={range} loc={loc} {...cap} />}
      {report === 'balanceSheet' && <BalanceSheetReport range={range} loc={loc} {...cap} />}
      {report === 'trialBalance' && <TrialBalanceReport range={range} loc={loc} {...cap} />}
      {report === 'ledgers' && <LedgersReport range={range} loc={loc} {...cap} />}
      {report === 'dayBook' && <DayBookReport range={range} loc={loc} {...cap} />}
      {report === 'cash' && <BookReport kind="cash" range={range} loc={loc} {...cap} />}
      {report === 'bank' && <BookReport kind="bank" range={range} loc={loc} {...cap} />}
      {report === 'gst' && <GstReport range={range} {...cap} />}
      {report === 'expenses' && <ExpenseReport range={range} loc={loc} {...cap} />}
      {report === 'salary' && <SalaryReport range={range} {...cap} />}
      {report === 'books' && <BooksLinks />}
    </div>
  );
}
