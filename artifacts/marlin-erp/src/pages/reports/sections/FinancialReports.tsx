/**
 * Financial reports — P&L and Balance Sheet (from /api/accounts/financial-statements,
 * same derivation as Chart of Accounts) plus quick links to the books.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { customFetch } from '@workspace/api-client-react';
import { Link } from 'wouter';
import {
  BookOpen, Scale, FileSpreadsheet, Landmark, Wallet, Percent, ArrowRight, Clock,
} from 'lucide-react';
import { downloadCSV } from '@/lib/download';
import {
  fmt, pdfMoney, periodLabel,
  useDateRange, RangeBar, ReportPicker, SummaryCards, RTable, ExportButtons, exportReportPdf,
  type RangeState, type Col,
} from '../shared';

type FinReport = 'pnl' | 'balanceSheet' | 'books';

// Shapes mirror /api/accounts/financial-statements (see ChartOfAccounts page).
interface StockItem { id: number; name: string; unit: string; stock: number; mrp: number; total: number }
interface LedgerNode { id: number; name: string; type: string; parentId: number | null; code: string | null; balance: number; children: LedgerNode[] }
interface GroupSummary { id: number | null; name: string; code: string | null; total: number; children: LedgerNode[] }
interface FinancialStatements {
  filters: { warehouses: { id: number; name: string }[]; outlets: { id: number; name: string }[] };
  profitAndLoss: {
    expenses: { openingStock: number; openingStockItems: StockItem[]; purchases: number; directExpenses: GroupSummary; indirectExpenses: GroupSummary; total: number };
    incomes: { sales: number; closingStock: number; closingStockItems: StockItem[]; directIncomes: GroupSummary; indirectIncomes: GroupSummary; total: number };
    netProfit: number;
  };
  balanceSheet: {
    liabilities: { capitalAccount: GroupSummary; loans: GroupSummary; currentLiabilities: GroupSummary; pandlCarryForward: number; difference: number; total: number };
    assets: { fixedAssets: GroupSummary; currentAssets: GroupSummary; total: number };
  };
}

interface Line { name: string; amount: number; depth: number; bold?: boolean }

function groupLines(gs: GroupSummary | undefined): Line[] {
  if (!gs) return [];
  const kids = (gs.children ?? []).filter((c) => Math.abs(c.balance) > 0.005);
  return [
    { name: gs.name, amount: gs.total, depth: 0, bold: true },
    ...kids.map((c) => ({ name: c.name, amount: c.balance, depth: 1 })),
  ];
}

function useFinancialStatements(range: RangeState) {
  const params = new URLSearchParams();
  if (range.from) params.set('fromDate', range.from);
  if (range.to) params.set('toDate', range.to);
  const qs = params.toString();
  return useQuery({
    queryKey: ['/api/accounts/financial-statements', qs],
    queryFn: () => customFetch<FinancialStatements>(`/api/accounts/financial-statements${qs ? `?${qs}` : ''}`),
  });
}

function LineTable({ lines, total, totalLabel, loading }: { lines: Line[]; total: number; totalLabel: string; loading?: boolean }) {
  return (
    <RTable
      cols={[
        { key: 'name', label: 'Particulars', render: (l) => (
          <span className={l.bold ? 'font-semibold' : ''} style={{ paddingLeft: l.depth * 16 }}>{l.name}</span>
        ) },
        { key: 'amount', label: 'Amount', align: 'right', render: (l) => (
          <span className={l.bold ? 'font-bold' : ''}>{fmt(l.amount)}</span>
        ) },
      ] satisfies Col<Line>[]}
      rows={lines} loading={loading} rowKey={(_, i) => i}
      empty="No entries"
      footer={[totalLabel, fmt(total)]}
    />
  );
}

// ── Profit & Loss ─────────────────────────────────────────────────────────────
function PnlReport({ range }: { range: RangeState }) {
  const { data, isLoading } = useFinancialStatements(range);
  const pl = data?.profitAndLoss;

  const expenseLines: Line[] = pl ? [
    { name: 'Opening Stock', amount: pl.expenses.openingStock, depth: 0 },
    { name: 'Purchases', amount: pl.expenses.purchases, depth: 0 },
    ...groupLines(pl.expenses.directExpenses),
    ...groupLines(pl.expenses.indirectExpenses),
  ] : [];
  const incomeLines: Line[] = pl ? [
    { name: 'Sales', amount: pl.incomes.sales, depth: 0 },
    { name: 'Closing Stock', amount: pl.incomes.closingStock, depth: 0 },
    ...groupLines(pl.incomes.directIncomes),
    ...groupLines(pl.incomes.indirectIncomes),
  ] : [];

  const toRows = (lines: Line[]) => lines.map((l) => [`${'   '.repeat(l.depth)}${l.name}`, pdfMoney(l.amount)] as (string | number)[]);

  return (
    <div className="space-y-4">
      <RangeBar range={range}>
        <ExportButtons
          disabled={isLoading || !pl}
          onCSV={() => downloadCSV('profit-and-loss.csv', [
            ...expenseLines.map((l) => ({ Side: 'Expenses', Particulars: l.name, 'Amount (₹)': l.amount.toFixed(2) })),
            { Side: 'Expenses', Particulars: 'TOTAL', 'Amount (₹)': (pl?.expenses.total ?? 0).toFixed(2) },
            ...incomeLines.map((l) => ({ Side: 'Incomes', Particulars: l.name, 'Amount (₹)': l.amount.toFixed(2) })),
            { Side: 'Incomes', Particulars: 'TOTAL', 'Amount (₹)': (pl?.incomes.total ?? 0).toFixed(2) },
            { Side: '', Particulars: 'NET PROFIT', 'Amount (₹)': (pl?.netProfit ?? 0).toFixed(2) },
          ])}
          onPDF={() => exportReportPdf({
            title: 'Profit & Loss Statement',
            subtitle: `Period: ${periodLabel(range.from, range.to)}`,
            metaRows: [
              ['Period', periodLabel(range.from, range.to)],
              ['Total Income', pdfMoney(pl?.incomes.total)],
              ['Total Expenses', pdfMoney(pl?.expenses.total)],
              ['Net Profit', pdfMoney(pl?.netProfit)],
            ],
            sections: [
              {
                heading: 'Expenses',
                columns: [{ label: 'Particulars', width: 3 }, { label: 'Amount', align: 'right', width: 1.4 }],
                rows: toRows(expenseLines),
                totalsRow: ['Total Expenses', pdfMoney(pl?.expenses.total)],
              },
              {
                heading: 'Incomes',
                columns: [{ label: 'Particulars', width: 3 }, { label: 'Amount', align: 'right', width: 1.4 }],
                rows: toRows(incomeLines),
                totalsRow: ['Total Incomes', pdfMoney(pl?.incomes.total)],
              },
            ],
            footerNote: `Net ${(pl?.netProfit ?? 0) >= 0 ? 'Profit' : 'Loss'}: ${pdfMoney(Math.abs(pl?.netProfit ?? 0))}. Stock values derived from current item costs.`,
          })}
        />
      </RangeBar>

      <SummaryCards cards={[
        { label: 'Total Income', value: fmt(pl?.incomes.total), tone: 'pos' },
        { label: 'Total Expenses', value: fmt(pl?.expenses.total), tone: 'warn' },
        { label: (pl?.netProfit ?? 0) >= 0 ? 'Net Profit' : 'Net Loss', value: fmt(Math.abs(pl?.netProfit ?? 0)), tone: (pl?.netProfit ?? 0) >= 0 ? 'pos' : 'neg' },
        { label: 'Margin on Income', value: pl?.incomes.total ? `${((pl.netProfit / pl.incomes.total) * 100).toFixed(1)}%` : '—' },
      ]} />

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-muted-foreground">Expenses</h3>
          <LineTable lines={expenseLines} total={pl?.expenses.total ?? 0} totalLabel="Total Expenses" loading={isLoading} />
        </div>
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-muted-foreground">Incomes</h3>
          <LineTable lines={incomeLines} total={pl?.incomes.total ?? 0} totalLabel="Total Incomes" loading={isLoading} />
        </div>
      </div>
    </div>
  );
}

// ── Balance Sheet ─────────────────────────────────────────────────────────────
function BalanceSheetReport({ range }: { range: RangeState }) {
  const { data, isLoading } = useFinancialStatements(range);
  const bs = data?.balanceSheet;

  const liabilityLines: Line[] = bs ? [
    ...groupLines(bs.liabilities.capitalAccount),
    { name: 'P&L (carried forward)', amount: bs.liabilities.pandlCarryForward, depth: 0 },
    ...groupLines(bs.liabilities.loans),
    ...groupLines(bs.liabilities.currentLiabilities),
    ...(Math.abs(bs.liabilities.difference) > 0.005 ? [{ name: 'Difference in books', amount: bs.liabilities.difference, depth: 0 }] : []),
  ] : [];
  const assetLines: Line[] = bs ? [
    ...groupLines(bs.assets.fixedAssets),
    ...groupLines(bs.assets.currentAssets),
  ] : [];

  const toRows = (lines: Line[]) => lines.map((l) => [`${'   '.repeat(l.depth)}${l.name}`, pdfMoney(l.amount)] as (string | number)[]);

  return (
    <div className="space-y-4">
      <RangeBar range={range}>
        <ExportButtons
          disabled={isLoading || !bs}
          onCSV={() => downloadCSV('balance-sheet.csv', [
            ...liabilityLines.map((l) => ({ Side: 'Liabilities', Particulars: l.name, 'Amount (₹)': l.amount.toFixed(2) })),
            { Side: 'Liabilities', Particulars: 'TOTAL', 'Amount (₹)': (bs?.liabilities.total ?? 0).toFixed(2) },
            ...assetLines.map((l) => ({ Side: 'Assets', Particulars: l.name, 'Amount (₹)': l.amount.toFixed(2) })),
            { Side: 'Assets', Particulars: 'TOTAL', 'Amount (₹)': (bs?.assets.total ?? 0).toFixed(2) },
          ])}
          onPDF={() => exportReportPdf({
            title: 'Balance Sheet',
            subtitle: `As at ${range.to ? periodLabel(undefined as unknown as string, range.to).replace('Up to ', '') : 'today'}`,
            metaRows: [
              ['Period', periodLabel(range.from, range.to)],
              ['Total Liabilities', pdfMoney(bs?.liabilities.total)],
              ['Total Assets', pdfMoney(bs?.assets.total)],
            ],
            sections: [
              {
                heading: 'Liabilities',
                columns: [{ label: 'Particulars', width: 3 }, { label: 'Amount', align: 'right', width: 1.4 }],
                rows: toRows(liabilityLines),
                totalsRow: ['Total Liabilities', pdfMoney(bs?.liabilities.total)],
              },
              {
                heading: 'Assets',
                columns: [{ label: 'Particulars', width: 3 }, { label: 'Amount', align: 'right', width: 1.4 }],
                rows: toRows(assetLines),
                totalsRow: ['Total Assets', pdfMoney(bs?.assets.total)],
              },
            ],
          })}
        />
      </RangeBar>

      <SummaryCards cards={[
        { label: 'Total Liabilities', value: fmt(bs?.liabilities.total) },
        { label: 'Total Assets', value: fmt(bs?.assets.total) },
        { label: 'P&L Carry Forward', value: fmt(bs?.liabilities.pandlCarryForward), tone: (bs?.liabilities.pandlCarryForward ?? 0) >= 0 ? 'pos' : 'neg' },
        { label: 'Books Difference', value: fmt(bs?.liabilities.difference), tone: Math.abs(bs?.liabilities.difference ?? 0) > 0.005 ? 'warn' : 'pos' },
      ]} />

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-muted-foreground">Liabilities</h3>
          <LineTable lines={liabilityLines} total={bs?.liabilities.total ?? 0} totalLabel="Total Liabilities" loading={isLoading} />
        </div>
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-muted-foreground">Assets</h3>
          <LineTable lines={assetLines} total={bs?.assets.total ?? 0} totalLabel="Total Assets" loading={isLoading} />
        </div>
      </div>
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
  const range = useDateRange('fy');
  const [report, setReport] = useState<FinReport>('pnl');
  return (
    <div className="space-y-4">
      <ReportPicker
        options={[
          { value: 'pnl', label: 'Profit & Loss' },
          { value: 'balanceSheet', label: 'Balance Sheet' },
          { value: 'books', label: 'Books & Registers' },
        ]}
        value={report} onChange={setReport}
      />
      {report === 'pnl' && <PnlReport range={range} />}
      {report === 'balanceSheet' && <BalanceSheetReport range={range} />}
      {report === 'books' && <BooksLinks />}
    </div>
  );
}
