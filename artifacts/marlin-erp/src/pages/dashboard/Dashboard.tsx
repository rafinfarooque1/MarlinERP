import { useMemo, useRef, useState, useLayoutEffect } from 'react';
import {
  useGetDashboardBi,
  type DashboardBiFilters,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { usePermission } from '@/lib/usePermission';
import { formatDateTime } from '@/lib/date';
import { useLocationContext, locationFilterParams, locationKeysParams } from '@/lib/locationContext';
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app/page-header';
import { EmptyState } from '@/components/app/empty-state';
import {
  ShieldOff, TrendingUp, ShoppingCart, Boxes,
  Landmark, Trophy, Users,
  Warehouse, Store, ArrowUpRight, ArrowDownRight, Wallet,
  Receipt, PieChart, BarChart3, Banknote, HandCoins,
  LayoutDashboard, Share2, Loader2, type LucideIcon,
} from 'lucide-react';
import { useLocation } from 'wouter';
import {
  fmt, num, fmtDate, periodLabel,
  useDateRange, RangeBar, SummaryCards, LocationBadge, TONE_CLS,
  type CardTone, type SummaryCard,
} from '@/pages/reports/shared';
import { DashboardShareReport, type ShareKpi } from './DashboardShareReport';
import { DashboardLocationBreakdown } from './DashboardLocationBreakdown';
import { DashboardLocationSalesReportCard } from './DashboardLocationSalesReportCard';
import { DashboardExpenseDetailsReport } from './DashboardExpenseDetailsReport';

// ── Small helpers ───────────────────────────────────────────────────────────

const WAREHOUSE_COLOR = 'hsl(var(--primary))';
const OUTLET_COLOR = 'hsl(var(--chart-2))';

const PAY_LABEL: Record<string, string> = {
  cash: 'Cash', card: 'Card', upi: 'UPI',
  bank_transfer: 'Bank', credit: 'Credit', unknown: 'Other',
};

/** Period chip on the shared KPI report — mirrors the RangeBar presets. */
const PRESET_LABEL: Record<string, string> = {
  today: 'Today', yesterday: 'Yesterday', week: 'Last 7 days', month: 'This month',
  quarter: 'Quarter', fy: 'This FY', all: 'All time', custom: 'Custom range',
};

// ── Mobile KPI cards (phones only — desktop keeps SummaryCards untouched) ───

/** Compact rupees for breakdown lines — whole rupees keep the lines short. */
const rup = (n: number | null | undefined) =>
  `₹${Math.round(Number(n ?? 0)).toLocaleString('en-IN')}`;

/**
 * Indian compact notation for amounts too wide to fit a card even at the
 * minimum font size — ₹1.23Cr / ₹4.56L. The full figure stays available via
 * the element's title/aria-label, so no digit is ever silently lost.
 */
function compactINR(text: string): string {
  const n = Number(text.replace(/[₹,\s]/g, ''));
  if (!Number.isFinite(n)) return text;
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)}L`;
  return `${sign}₹${Math.round(abs).toLocaleString('en-IN')}`;
}

/**
 * Renders an amount that shrinks (24px → 10px) until it fits its card on one
 * line at any phone width down to 320px. If even 10px cannot hold the full
 * figure, it switches to Indian compact notation (₹x.xxCr/L) and exposes the
 * exact amount via title + aria-label — never wrapped, never clipped digits.
 * Font-size refits mutate the style directly (no state), so resizes cause no
 * React re-renders; only the rare compact switch does.
 */
function FitAmount({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [compact, setCompact] = useState(false);
  const shown = compact ? compactINR(text) : text;
  useLayoutEffect(() => setCompact(false), [text]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      let size = 24;
      el.style.fontSize = `${size}px`;
      while (size > 10 && el.scrollWidth > el.clientWidth) {
        size -= 1;
        el.style.fontSize = `${size}px`;
      }
      // Still too wide at the floor: fall back to compact notation (sticky
      // for this value so it cannot oscillate with resizes).
      if (el.scrollWidth > el.clientWidth) setCompact(true);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, compact]);
  return (
    <p
      ref={ref}
      title={compact ? text : undefined}
      aria-label={compact ? text : undefined}
      className={`font-bold tabular-nums tracking-tight leading-tight whitespace-nowrap overflow-hidden ${className ?? ''}`}
    >
      {shown}
    </p>
  );
}

interface MobileKpi {
  label: string;
  icon: LucideIcon;
  value: string;
  tone?: CardTone;
  /** Structured breakdown, e.g. Suppliers/Salary/Rent — one compact line each. */
  lines?: { label: string; value: string }[];
  /** One-line muted description (GP/NP). */
  desc?: string;
  /** Card takes the full row — used to keep semantic pairs intact when a
      permission-hidden card (Inventory) would otherwise shift every pair. */
  spanTwo?: boolean;
  onClick?: () => void;
}

function MobileKpiCard({ card }: { card: MobileKpi }) {
  const Icon = card.icon;
  const body = (
    <>
      <div className="flex items-center gap-1.5 min-w-0">
        <Icon className="w-4 h-4 shrink-0 text-muted-foreground/60" />
        <span className="text-[16px] font-medium text-muted-foreground truncate">{card.label}</span>
      </div>
      <FitAmount text={card.value} className={`mt-1.5 ${TONE_CLS[card.tone ?? 'default']}`} />
      {card.lines && card.lines.length > 0 && (
        <div className="mt-auto pt-2 space-y-0.5">
          {card.lines.map((l) => (
            <div key={l.label} className="flex items-baseline justify-between gap-2 text-[12px] leading-tight">
              <span className="text-muted-foreground truncate">{l.label}</span>
              <span className="font-semibold tabular-nums whitespace-nowrap text-foreground/80">{l.value}</span>
            </div>
          ))}
        </div>
      )}
      {card.desc && (
        <p className="mt-auto pt-1.5 text-[12px] leading-tight text-muted-foreground truncate">{card.desc}</p>
      )}
    </>
  );
  const base = `bg-card border border-border rounded-xl shadow-sm p-3 flex flex-col min-w-0 text-left ${card.spanTwo ? 'col-span-2' : ''}`;
  return card.onClick ? (
    <button type="button" onClick={card.onClick} className={`${base} active:bg-muted/40 transition-colors`}>
      {body}
    </button>
  ) : (
    <div className={base}>{body}</div>
  );
}

/** 2-across equal-height KPI grid; spanTwo cards take a full row. */
function MobileSummaryCards({ cards }: { cards: MobileKpi[] }) {
  return (
    <div className="grid grid-cols-2 auto-rows-fr gap-2.5 md:hidden">
      {cards.map((c) => <MobileKpiCard key={c.label} card={c} />)}
    </div>
  );
}

/** Horizontal CSS bar row — used for trends and breakdowns. */
function BarRow({ label, sub, value, max, color, valueLabel }: {
  label: string; sub?: string; value: number; max: number; color: string; valueLabel: string;
}) {
  const pct = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="truncate font-medium">{label}</span>
        <span className="font-mono text-xs shrink-0">{valueLabel}</span>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
      {sub && <p className="text-[10px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

function SectionCard({ title, icon, description, children }: {
  title: string; icon: React.ReactNode; description?: string; children: React.ReactNode;
}) {
  return (
    <Card className="border-card-border bg-card shadow-sm flex flex-col">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">{icon}{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="flex-1">{children}</CardContent>
    </Card>
  );
}

function Empty({ message }: { message: string }) {
  return (
    <div className="h-full min-h-[140px] flex items-center justify-center">
      <EmptyState icon={Boxes} title={message} compact />
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Dashboard() {
  const dashPerm = usePermission('page:/');
  // The dashboard is the owner's daily console — it opens on Today. The
  // RangeBar keeps every other preset one tap away.
  const range = useDateRange('today');
  // Location comes from the shared header GlobalLocationSelector — no local picker.
  const { locationState } = useLocationContext();
  const [reportMode, setReportMode] = useState<'details' | 'consolidated'>('details');

  const filters = useMemo<DashboardBiFilters>(() => {
    const f: DashboardBiFilters = {};
    if (range.from) f.fromDate = range.from;
    if (range.to) f.toDate = range.to;
    const loc = locationFilterParams(locationState);
    if (loc.locationType && loc.locationId) {
      f.locationType = loc.locationType;
      f.locationId = loc.locationId;
    }
    const keys = locationKeysParams(locationState);
    if (keys) f.locationKeys = keys;
    return f;
  }, [range.from, range.to, locationState]);

  const { data: bi, isLoading, isError } = useGetDashboardBi(filters);

  const pLabel = periodLabel(range.from || undefined, range.to || undefined);
  const reportLocationLabel = locationState.locationKeys?.length
    ? (locationState.locationNames ?? locationState.locationKeys).join(' + ')
    : bi?.scope.label === 'All locations' ? 'All Locations' : bi?.scope.label;

  // Permission gate
  if (!dashPerm.isLoading && !dashPerm.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center">
          <div className="w-16 h-16 rounded-2xl bg-destructive/10 flex items-center justify-center">
            <ShieldOff className="w-8 h-8 text-destructive" />
          </div>
          <div>
            <h2 className="text-xl font-bold">Access Denied</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              You don't have permission to view the Dashboard.<br />
              Contact your administrator to request access.
            </p>
          </div>
        </div>
      </AppLayout>
    );
  }

  const s = bi?.sales;
  const salesDayMax = Math.max(0, ...(s?.byDay.map(d => d.total) ?? [0]));
  const payMax = Math.max(0, ...(s?.byPaymentMode.map(p => p.total) ?? [0]));
  const locMax = Math.max(0, ...(s?.byLocation.map(l => l.total) ?? [0]));
  const topItemMax = Math.max(0, ...(bi?.topItems.map(i => i.revenue) ?? [0]));

  // GP / NP for the selected period — served off the SAME P&L build as the
  // Expenses tile, so they always equal the Profit & Loss report for the same
  // range and location.
  const pf = bi?.profit;
  // Period money paid out / received over the cash+bank ledger subtrees, from
  // the SAME derived-posting stream as the Cash/Bank balance tiles — so the
  // Payments/Receipts tiles always agree with the books for the range and
  // location. Null exactly when the balance tiles are null.
  const mf = bi?.moneyFlows;
  const showLocationBreakdown = reportMode === 'details' &&
    (!!bi?.scope.isAllLocations || (locationState.locationKeys?.length ?? 0) > 0);
  const locationBreakdown = bi?.locationBreakdown ?? [];
  const selectedMetric = (metric: keyof typeof locationBreakdown[number]) =>
    locationState.locationKeys?.length
      ? locationBreakdown.reduce((sum, row) => sum + Number(row[metric] ?? 0), 0)
      : null;
  const dashboardValue = (metric: keyof typeof locationBreakdown[number], fallback: number | null | undefined) =>
    selectedMetric(metric) ?? fallback;
  type BreakdownMetric = keyof Omit<typeof locationBreakdown[number], 'locationType' | 'locationId' | 'name'>;
  const locationLines = (metric: BreakdownMetric) =>
    showLocationBreakdown
      ? locationBreakdown.map((l) => ({ label: l.name, value: fmt(l[metric] as number | null) }))
      : undefined;
  const locationHint = (metric: BreakdownMetric, fallback?: React.ReactNode): React.ReactNode =>
    showLocationBreakdown
      ? <DashboardLocationBreakdown lines={locationBreakdown.map((l) => ({
          label: l.name,
          value: fmt(l[metric] as number | null),
        }))} />
      : fallback;
  const [, navigate] = useLocation();
  // Every KPI card drills into its source report carrying the dashboard's own
  // date range (?view= picks the sub-report, ?range=/from/to seed useDateRange
  // in the section — both read once on mount, then stripped). Location is NOT
  // in the URL: the global header location selector follows the user between
  // pages and is exactly the location context these figures were computed
  // under, so the target report opens on the same slice by construction.
  const drillQs = (view: string) => {
    const p = new URLSearchParams({ view, range: range.preset });
    if (range.preset === 'custom') {
      if (range.customFrom) p.set('from', range.customFrom);
      if (range.customTo) p.set('to', range.customTo);
    }
    return p.toString();
  };
  const drillTo = (path: string, view: string, anchor = '') => () =>
    navigate(`${path}?${drillQs(view)}${anchor ? `#${anchor}` : ''}`);
  const drill = (anchor: string) => drillTo('/reports/financial', 'pnl', anchor);
  // ── Export / Share: capture ONLY the dedicated KPI report (owner spec) ────
  // The DashboardShareReport component renders off-screen at a fixed design
  // width, so the image is identical on phone/tablet/desktop and can never
  // include the trend/BI sections, navigation or floating buttons. Never a
  // cropped page screenshot.
  const shareRef = useRef<HTMLDivElement>(null);
  const [sharing, setSharing] = useState(false);
  const shareDashboard = async () => {
    if (sharing) return;
    if (isLoading || !bi) {
      // The report shows exactly the on-screen figures — there are none yet.
      toast.info('Dashboard figures are still loading — try again in a moment');
      return;
    }
    const el = shareRef.current;
    if (!el) {
      // Should be unreachable — the report mounts whenever bi is loaded.
      console.error('[dashboard] share: report node not mounted');
      toast.error('Could not capture the dashboard image');
      return;
    }
    console.debug('[dashboard] share: capturing KPI report…');
    setSharing(true);
    try {
      // Wait for webfonts first — a mid-swap capture measures fallback font
      // metrics, shifting line wraps and the report height between captures.
      await document.fonts.ready;
      // html-to-image renders via SVG <foreignObject>, so the BROWSER paints
      // the clone — modern color functions (Tailwind v4 emits oklab/oklch,
      // which html2canvas could not parse) work for free.
      const { toBlob } = await import('html-to-image');
      const blob = await toBlob(el, {
        backgroundColor: '#ffffff',
        // Fixed design width → fixed output size on every device.
        pixelRatio: 2,
        cacheBust: true,
      });
      if (!blob) throw new Error('empty canvas');
      const slugify = (s: string) =>
        s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'all-locations';
      const dateSlug = range.from && range.to
        ? (range.from === range.to ? range.from : `${range.from}_to_${range.to}`)
        : 'all-time';
      const file = new File(
        [blob],
        `business-dashboard-${dateSlug}-${slugify(bi.scope.label)}.png`,
        { type: 'image/png' },
      );
      if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Business Dashboard' });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = file.name;
        a.click();
        URL.revokeObjectURL(url);
        toast.success('Dashboard report image downloaded');
      }
    } catch (e: any) {
      // The user closing the share sheet is not an error.
      if (e?.name !== 'AbortError') {
        console.error('[dashboard] share failed', e);
        toast.error('Could not capture the dashboard image');
      }
    } finally {
      setSharing(false);
    }
  };

  // Fixed two-per-row pair layout (owner's spec), identical on desktop and
  // mobile: Sales|Purchases, Inventory|Expenses, Payables|Receivables,
  // Payments|Receipts, Cash|Reconciliation Pending, GP|NP.
  // Inventory Value is hidden entirely for employees without the valuation
  // right (the server omits the figure) — Expenses then spans its full row so
  // every later pair stays intact.
  const hasInventory = !!bi?.canViewValuation;

  const summaryCards: SummaryCard[] = [
    // ── Row 1: Sales · Purchases ────────────────────────────────────────────
    { label: 'Sales', value: fmt(dashboardValue('sales', s?.total) ?? 0), tone: 'pos', hint: locationHint('sales'), onClick: drillTo('/reports/sales', 'register') },
    { label: 'Purchases', value: fmt(dashboardValue('purchases', bi?.purchases.total) ?? 0), hint: locationHint('purchases'), onClick: drillTo('/reports/purchases', 'register') },
    // ── Row 2: Inventory · Expenses ─────────────────────────────────────────
    ...(hasInventory
      ? [{ label: 'Inventory Value', value: fmt(dashboardValue('inventoryValue', bi!.inventory.valuation) ?? 0), tone: 'info' as CardTone, hint: locationHint('inventoryValue'), onClick: drillTo('/reports/inventory', 'valuation') }]
      : []),
    // Expenses and the balance tiles come from the accounting postings, which
    // carry no location. The API returns null for a single-location login
    // rather than passing off a company-wide number as that branch's — render
    // the gap instead of a misleading zero.
    {
      label: 'Expenses',
      value: dashboardValue('expense', bi?.expenses?.total) == null ? '—' : fmt(dashboardValue('expense', bi?.expenses?.total)!),
      tone: (bi?.expenses?.total ?? 0) > 0 ? 'neg' : 'default',
      // Same three-way breakdown style as the Payables card. Salary and Rent
      // are read off the same P&L build as the total and Other is the exact
      // remainder, so the line always sums to the figure above it for every
      // date range. Hidden (like the total) for single-location logins.
      hint: locationHint(
        'expense',
        bi?.expenses?.total != null && bi.expenses.salary != null
          ? `Salary ${fmt(bi.expenses.salary)} · Rent ${fmt(bi.expenses.rent ?? 0)} · Other ${fmt(bi.expenses.other ?? 0)}`
          : undefined,
      ),
      // When Inventory is permission-hidden, Expenses takes the whole row so
      // the later pairs (Payables|Receivables etc.) stay aligned.
      className: hasInventory ? undefined : 'md:col-span-2',
      // The tile is Direct + Indirect expenses off the P&L build, so it drills
      // into the P&L's own "Total Expenses" memo line — never the operational
      // expense report, which measures location expenses (a different figure).
      onClick: drillTo('/reports/financial', 'pnl', 'pl-expenses'),
    },
    // ── Row 3: Payables · Receivables ───────────────────────────────────────
    // Balance Sheet positions taken from the accounting ledgers, so they carry
    // no location and read '—' for a single-location login, like Expenses.
    // Everything the company owes, not just its trade creditors. Salary accrues
    // to a payable that sits outside Sundry Creditors, so the old tile read the
    // control account alone and showed nothing at all for unpaid wages.
    {
      label: 'Payables',
      value: dashboardValue('payables', (bi?.payables as any)?.allPayables ?? bi?.payables?.total) == null ? '—' : fmt(dashboardValue('payables', (bi?.payables as any)?.allPayables ?? bi?.payables?.total)!),
      tone: (bi?.payables as any)?.allPayables == null ? 'default' : 'neg',
      // Breakdown of everything the company owes: trade creditors, accrued
      // salary and accrued rent — the same three figures allPayables sums, so
      // the hint always reconciles with the number above it. Rendered whenever
      // the ledger figures are available (they are null for non-HO scopes).
      hint: locationHint(
        'payables',
        (bi?.payables as any)?.salaryPayable != null
          ? `Suppliers ${fmt(bi!.payables.total ?? 0)} · Salary ${fmt((bi!.payables as any).salaryPayable)} · Rent ${fmt((bi!.payables as any).rentPayable ?? 0)}`
          : undefined,
      ),
      // allPayables spans trade creditors + accrued salary + accrued rent, so
      // the Balance Sheet liabilities table (which shows all three lines) is
      // the report that equals it — vendor-only Payables Ageing matches just
      // the Suppliers figure in the hint.
      onClick: drillTo('/reports/financial', 'balanceSheet', 'bs-liabilities'),
    },
    {
      label: 'Receivables',
      value: dashboardValue('receivables', bi?.receivables?.total) == null ? '—' : fmt(dashboardValue('receivables', bi?.receivables?.total)!),
      tone: bi?.receivables?.total == null ? 'default' : (bi?.receivables?.overdue ?? 0) > 0 ? 'warn' : 'info',
      hint: locationHint('receivables'),
      onClick: drillTo('/reports/parties', 'receivables'),
    },
    // ── Row 4: Payments · Receipts ──────────────────────────────────────────
    // Period money out / in over the cash AND bank books; the hint splits the
    // figure by book, so it always reconciles with the number above it. Both
    // tiles drill into the combined Cash & Bank book — the Cash Book alone
    // excludes bank movements and could never equal these figures.
    {
      label: 'Payments',
      value: dashboardValue('payments', mf?.totalOut) == null ? '—' : fmt(dashboardValue('payments', mf?.totalOut)!),
      tone: mf == null ? 'default' : mf.totalOut > 0 ? 'neg' : 'default',
      hint: locationHint('payments', mf == null ? undefined : `Cash ${fmt(mf.cashOut)} · Bank ${fmt(mf.bankOut)}`),
      onClick: drillTo('/reports/financial', 'cashBank'),
    },
    {
      label: 'Receipts',
      value: dashboardValue('receipts', mf?.totalIn) == null ? '—' : fmt(dashboardValue('receipts', mf?.totalIn)!),
      tone: mf == null ? 'default' : mf.totalIn > 0 ? 'pos' : 'default',
      hint: locationHint('receipts', mf == null ? undefined : `Cash ${fmt(mf.cashIn)} · Bank ${fmt(mf.bankIn)}`),
      onClick: drillTo('/reports/financial', 'cashBank'),
    },
    // ── Row 5: Cash · Reconciliation Pending ───────────────────────────────
    {
      label: 'Cash Balance',
      value: dashboardValue('cash', bi?.cash?.balance) == null ? '—' : fmt(dashboardValue('cash', bi?.cash?.balance)!),
      tone: bi?.cash?.balance == null ? 'default' : bi.cash.balance >= 0 ? 'pos' : 'neg',
      hint: locationHint('cash'),
      onClick: drillTo('/reports/financial', 'cash'),
    },
    {
      label: 'Reconciliation Pending',
      value: fmt(dashboardValue('reconciliationPending', bi?.bank?.reconciliationPending) ?? 0),
      tone: (dashboardValue('reconciliationPending', bi?.bank?.reconciliationPending) ?? 0) > 0 ? 'warn' : 'default',
      hint: locationHint('reconciliationPending', 'Awaiting bank clearance'),
    },
    // ── Row 6: GP · NP — both read the P&L's own summary, never a re-sum ──
    // NP stays beside GP in the final KPI pair.
    {
      label: 'GP',
      value: dashboardValue('grossProfit', pf?.gross) == null ? '—' : fmt(dashboardValue('grossProfit', pf?.gross)!),
      tone: pf?.gross == null ? 'default' : pf.gross >= 0 ? 'pos' : 'neg',
      hint: locationHint('grossProfit', 'Gross Profit · tap for P&L'),
      onClick: drill('pl-gross-profit'),
    },
    {
      label: 'NP',
      value: dashboardValue('netProfit', pf?.net) == null ? '—' : fmt(dashboardValue('netProfit', pf?.net)!),
      tone: pf?.net == null ? 'default' : pf.net >= 0 ? 'pos' : 'neg',
      hint: locationHint('netProfit', 'Net Profit · tap for P&L'),
      onClick: drill('pl-net-profit'),
    },
  ];

  // The shared KPI report picks its figures OUT OF summaryCards, so the image
  // can never disagree with the screen (same data, same formatting — never
  // refetched or recomputed). Owner spec fixes the card list to these twelve;
  // Inventory drops out when the valuation permission hides it on screen too. Reconciling breakdown hints ride along
  // only where they are pure figures ("tap for P&L" hints make no sense in a
  // static image).
  const SHARE_PICKS: { src: string; out: string; metric: BreakdownMetric; fallbackHint?: string }[] = [
    { src: 'Sales', out: 'Sales', metric: 'sales' },
    { src: 'Purchases', out: 'Purchases', metric: 'purchases' },
    { src: 'Inventory Value', out: 'Inventory', metric: 'inventoryValue' },
    { src: 'Expenses', out: 'Expenses', metric: 'expense', fallbackHint: 'tap for P&L' },
    { src: 'Payables', out: 'Payables', metric: 'payables', fallbackHint: 'tap for Balance Sheet' },
    { src: 'Receivables', out: 'Receivables', metric: 'receivables' },
    { src: 'Payments', out: 'Payments', metric: 'payments' },
    { src: 'Receipts', out: 'Receipts', metric: 'receipts' },
    { src: 'Cash Balance', out: 'Cash', metric: 'cash' },
    { src: 'Reconciliation Pending', out: 'Reconciliation Pending', metric: 'reconciliationPending', fallbackHint: 'awaiting bank clearance' },
    { src: 'GP', out: 'GP · Gross Profit', metric: 'grossProfit', fallbackHint: 'tap for P&L' },
    { src: 'NP', out: 'NP · Net Profit', metric: 'netProfit', fallbackHint: 'tap for P&L' },
  ];
  const shareCards: ShareKpi[] = SHARE_PICKS.flatMap(({ src, out, metric, fallbackHint }) => {
    const c = summaryCards.find((x) => x.label === src);
    if (!c) return []; // permission-hidden (Inventory) — omitted, like on screen
    return [{
      label: out,
       value: typeof c.value === 'string' ? c.value : '—',
      tone: c.tone,
      hint: showLocationBreakdown ? undefined : fallbackHint,
      locationLines: showLocationBreakdown
        ? locationBreakdown.map((l) => ({ label: l.name, value: fmt(l[metric] as number | null) }))
        : undefined,
    }];
  });

  // Mobile-only card set: same figures, order and tones as summaryCards, but
  // with shorter labels, subtle icons, structured breakdown lines and one-line
  // descriptions, per the owner's mobile-dashboard spec. Pairs land as
  // Sales|Purchases, Inventory|Expenses, Payables|Receivables,
  // Payments|Receipts, Cash|Reconciliation Pending, GP|NP; when Inventory is permission-hidden,
  // Expenses spans its full row so every later semantic pair stays intact.
  const mobileCards: MobileKpi[] = [
     { label: 'Sales', icon: TrendingUp, value: fmt(dashboardValue('sales', s?.total) ?? 0), tone: 'pos', lines: locationLines('sales'), onClick: drillTo('/reports/sales', 'register') },
     { label: 'Purchases', icon: ShoppingCart, value: fmt(dashboardValue('purchases', bi?.purchases.total) ?? 0), lines: locationLines('purchases'), onClick: drillTo('/reports/purchases', 'register') },
    ...(hasInventory
        ? [{ label: 'Inventory', icon: Boxes, value: fmt(dashboardValue('inventoryValue', bi!.inventory.valuation) ?? 0), tone: 'info' as CardTone, lines: locationLines('inventoryValue'), onClick: drillTo('/reports/inventory', 'valuation') }]
      : []),
    {
      label: 'Expenses',
      icon: Receipt,
       value: dashboardValue('expense', bi?.expenses?.total) == null ? '—' : fmt(dashboardValue('expense', bi?.expenses?.total)!),
      tone: (bi?.expenses?.total ?? 0) > 0 ? 'neg' : 'default',
      lines: showLocationBreakdown
        ? locationLines('expense')
        : bi?.expenses?.total != null && bi.expenses.salary != null
          ? [
              { label: 'Salary', value: rup(bi.expenses.salary) },
              { label: 'Rent', value: rup(bi.expenses.rent) },
              { label: 'Other', value: rup(bi.expenses.other) },
            ]
          : undefined,
      spanTwo: !hasInventory,
      onClick: drillTo('/reports/financial', 'pnl', 'pl-expenses'),
    },
    {
      label: 'Payables',
      icon: ArrowUpRight,
       value: dashboardValue('payables', (bi?.payables as any)?.allPayables ?? bi?.payables?.total) == null ? '—' : fmt(dashboardValue('payables', (bi?.payables as any)?.allPayables ?? bi?.payables?.total)!),
       tone: dashboardValue('payables', (bi?.payables as any)?.allPayables ?? bi?.payables?.total) == null ? 'default' : 'neg',
      lines: showLocationBreakdown
        ? locationLines('payables')
        : (bi?.payables as any)?.salaryPayable != null
          ? [
              { label: 'Suppliers', value: rup(bi!.payables.total) },
              { label: 'Salary', value: rup((bi!.payables as any).salaryPayable) },
              { label: 'Rent', value: rup((bi!.payables as any).rentPayable) },
            ]
          : undefined,
      onClick: drillTo('/reports/financial', 'balanceSheet', 'bs-liabilities'),
    },
    {
      label: 'Receivables',
      icon: ArrowDownRight,
       value: dashboardValue('receivables', bi?.receivables?.total) == null ? '—' : fmt(dashboardValue('receivables', bi?.receivables?.total)!),
      tone: bi?.receivables?.total == null ? 'default' : (bi?.receivables?.overdue ?? 0) > 0 ? 'warn' : 'info',
      lines: locationLines('receivables'),
      onClick: drillTo('/reports/parties', 'receivables'),
    },
    {
      label: 'Payments',
      icon: Banknote,
       value: dashboardValue('payments', mf == null ? null : mf.totalOut) == null ? '—' : fmt(dashboardValue('payments', mf?.totalOut)!),
      tone: mf == null ? 'default' : mf.totalOut > 0 ? 'neg' : 'default',
      lines: showLocationBreakdown
        ? locationLines('payments')
        : mf == null
          ? undefined
          : [
              { label: 'Cash', value: rup(mf.cashOut) },
              { label: 'Bank', value: rup(mf.bankOut) },
            ],
      onClick: drillTo('/reports/financial', 'cashBank'),
    },
    {
      label: 'Receipts',
      icon: HandCoins,
       value: dashboardValue('receipts', mf == null ? null : mf.totalIn) == null ? '—' : fmt(dashboardValue('receipts', mf?.totalIn)!),
      tone: mf == null ? 'default' : mf.totalIn > 0 ? 'pos' : 'default',
      lines: showLocationBreakdown
        ? locationLines('receipts')
        : mf == null
          ? undefined
          : [
              { label: 'Cash', value: rup(mf.cashIn) },
              { label: 'Bank', value: rup(mf.bankIn) },
            ],
      onClick: drillTo('/reports/financial', 'cashBank'),
    },
    {
      label: 'Cash',
      icon: Wallet,
       value: dashboardValue('cash', bi?.cash?.balance) == null ? '—' : fmt(dashboardValue('cash', bi?.cash?.balance)!),
      tone: bi?.cash?.balance == null ? 'default' : bi.cash.balance >= 0 ? 'pos' : 'neg',
      lines: locationLines('cash'),
      onClick: drillTo('/reports/financial', 'cash'),
    },
    {
      label: 'Reconciliation Pending',
      icon: Landmark,
      value: fmt(dashboardValue('reconciliationPending', bi?.bank?.reconciliationPending) ?? 0),
      tone: (dashboardValue('reconciliationPending', bi?.bank?.reconciliationPending) ?? 0) > 0 ? 'warn' : 'default',
      lines: locationLines('reconciliationPending'),
      desc: showLocationBreakdown ? undefined : 'Awaiting bank clearance',
    },
    {
      label: 'GP',
      icon: PieChart,
       value: dashboardValue('grossProfit', pf?.gross) == null ? '—' : fmt(dashboardValue('grossProfit', pf?.gross)!),
      tone: pf?.gross == null ? 'default' : pf.gross >= 0 ? 'pos' : 'neg',
      lines: locationLines('grossProfit'),
      desc: showLocationBreakdown ? undefined : 'Gross Profit',
      onClick: drill('pl-gross-profit'),
    },
    {
      label: 'NP',
      icon: BarChart3,
       value: dashboardValue('netProfit', pf?.net) == null ? '—' : fmt(dashboardValue('netProfit', pf?.net)!),
      tone: pf?.net == null ? 'default' : pf.net >= 0 ? 'pos' : 'neg',
      lines: locationLines('netProfit'),
      desc: showLocationBreakdown ? undefined : 'Net Profit',
      onClick: drill('pl-net-profit'),
      spanTwo: true,
    },
  ];

  return (
    <AppLayout>
      <div className="space-y-6">

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <PageHeader
          title="Business Dashboard"
          icon={LayoutDashboard}
          actions={
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20 px-3 py-1 max-md:hidden">
                <span className="w-2 h-2 rounded-full bg-primary mr-2 animate-pulse" />
                Live Sync Active
              </Badge>
              <Button variant="outline" size="sm" onClick={shareDashboard} disabled={sharing} data-testid="button-share-dashboard">
                {sharing ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Share2 className="w-4 h-4 mr-1.5" />}
                Share
              </Button>
              <div
                role="group"
                aria-label="Share report mode"
                className="flex items-center rounded-md border border-border bg-muted/30 p-0.5"
                data-testid="dashboard-report-mode"
              >
                <button
                  type="button"
                  aria-pressed={reportMode === 'details'}
                  onClick={() => setReportMode('details')}
                  className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${reportMode === 'details' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'}`}
                >
                  Details
                </button>
                <button
                  type="button"
                  aria-pressed={reportMode === 'consolidated'}
                  onClick={() => setReportMode('consolidated')}
                  className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${reportMode === 'consolidated' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'}`}
                >
                  Consolidated
                </button>
              </div>
            </div>
          }
        >
          <p className="text-muted-foreground text-sm">{pLabel}</p>
          {/* ── Controls: date range (location comes from the header selector) ─ */}
          <div className="flex flex-wrap items-center gap-3">
            <RangeBar range={range} />
          </div>
        </PageHeader>

        {isError && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            Could not load dashboard figures. Please try again.
          </div>
        )}

        {/* ── Summary cards ──────────────────────────────────────────────── */}
        {isLoading ? (
          <div className="grid grid-cols-2 gap-2.5 md:gap-3">
            {[...Array(14)].map((_, i) => <Skeleton key={i} className="h-24 md:h-[68px] rounded-xl md:rounded-lg" />)}
          </div>
        ) : (
          <>
            {/* Phones get the compact banking-app card grid; md+ keeps the
                original SummaryCards layout pixel-identical. */}
            <MobileSummaryCards cards={mobileCards} />
            <SummaryCards cards={summaryCards} gridClassName="hidden md:grid md:grid-cols-2 gap-3" />
            {bi && bi.expenses?.total == null && (
              <p className="text-xs text-muted-foreground">
                Expenses are company-level accounting figures and are not broken down by
                location, so that figure is not shown for a single-location view. Reconciliation
                Pending is scoped to the current warehouse/location.
              </p>
            )}
          </>
        )}

        {/* ── Sales trend + payment mix ──────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2">
            <SectionCard
              title="Sales Trend"
              icon={<TrendingUp className="w-5 h-5 text-primary" />}
              description={s ? `${fmt(s.total)} across ${num(s.count)} invoice${s.count !== 1 ? 's' : ''}` : undefined}
            >
              {isLoading ? (
                <div className="space-y-3">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-8" />)}</div>
              ) : !s || s.byDay.length === 0 ? (
                <Empty message="No sales in this period" />
              ) : (
                <div className="space-y-3">
                  {s.byDay.map(d => (
                    <BarRow
                      key={d.date}
                      label={fmtDate(d.date)}
                      value={d.total}
                      max={salesDayMax}
                      color={WAREHOUSE_COLOR}
                      valueLabel={`${fmt(d.total)} · ${d.count}`}
                    />
                  ))}
                </div>
              )}
            </SectionCard>
          </div>

          <SectionCard title="Payment Mix" icon={<Wallet className="w-5 h-5 text-chart-2" />}>
            {isLoading ? (
              <div className="space-y-3">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-8" />)}</div>
            ) : !s || s.byPaymentMode.length === 0 ? (
              <Empty message="No payments in this period" />
            ) : (
              <div className="space-y-3">
                {s.byPaymentMode.map(p => (
                  <BarRow
                    key={p.mode}
                    label={PAY_LABEL[p.mode] ?? p.mode}
                    value={p.total}
                    max={payMax}
                    color={OUTLET_COLOR}
                    valueLabel={fmt(p.total)}
                    sub={`${p.count} invoice${p.count !== 1 ? 's' : ''}`}
                  />
                ))}
              </div>
            )}
          </SectionCard>
        </div>

        {/* ── Sales by location (HO) + Top items ─────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <SectionCard
            title="Sales by Location"
            icon={<Trophy className="w-5 h-5 text-amber-500" />}
            description={`Ranked by revenue — ${pLabel}`}
          >
            {isLoading ? (
              <div className="space-y-3">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
            ) : !s || s.byLocation.length === 0 ? (
              <Empty message="No sales in this period" />
            ) : (
              <div className="space-y-3">
                {s.byLocation.map(l => (
                  <div key={`${l.locationType}:${l.locationId}`} className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        {l.locationType === 'warehouse'
                          ? <Warehouse className="w-3.5 h-3.5 text-primary shrink-0" />
                          : <Store className="w-3.5 h-3.5 text-chart-2 shrink-0" />}
                        <span className="font-medium text-sm truncate">{l.name}</span>
                        <LocationBadge type={l.locationType} />
                      </div>
                      <span className="font-bold text-sm font-mono shrink-0">{fmt(l.total)}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <div className="h-full rounded-full transition-all" style={{
                        width: `${locMax > 0 ? Math.max(2, (l.total / locMax) * 100) : 0}%`,
                        background: l.locationType === 'warehouse' ? WAREHOUSE_COLOR : OUTLET_COLOR,
                      }} />
                    </div>
                    <p className="text-[10px] text-muted-foreground">{l.count} invoice{l.count !== 1 ? 's' : ''}</p>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>

          <SectionCard
            title="Top Items"
            icon={<ShoppingCart className="w-5 h-5 text-primary" />}
            description="Best sellers by revenue"
          >
            {isLoading ? (
              <div className="space-y-3">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-8" />)}</div>
            ) : !bi || bi.topItems.length === 0 ? (
              <Empty message="No item sales in this period" />
            ) : (
              <div className="space-y-3">
                {bi.topItems.map(i => (
                  <BarRow
                    key={i.itemId}
                    label={i.name}
                    value={i.revenue}
                    max={topItemMax}
                    color="hsl(var(--chart-3))"
                    valueLabel={fmt(i.revenue)}
                    sub={`${num(i.qty)} sold`}
                  />
                ))}
              </div>
            )}
          </SectionCard>
        </div>

        {/* ── Top customers ──────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <SectionCard
            title="Top Customers"
            icon={<Users className="w-5 h-5 text-chart-2" />}
            description="By revenue"
          >
            {isLoading ? (
              <div className="space-y-3">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-8" />)}</div>
            ) : !bi || bi.topCustomers.length === 0 ? (
              <Empty message="No customer sales in this period" />
            ) : (
              <div className="space-y-2">
                {bi.topCustomers.map((c, i) => (
                  <div key={c.customerId} className="flex items-center justify-between gap-2 p-2 rounded-lg border border-border bg-muted/10">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-xs text-muted-foreground w-4 shrink-0">#{i + 1}</span>
                      <span className="font-medium text-sm truncate">{c.name}</span>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="font-bold text-sm font-mono">{fmt(c.revenue)}</p>
                      <p className="text-[10px] text-muted-foreground">{c.count} order{c.count !== 1 ? 's' : ''}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
          <div className="lg:col-span-2">
            <DashboardLocationSalesReportCard
              rows={bi?.locationSalesReport}
              isLoading={isLoading}
              isError={isError}
              description={`${pLabel} · outstanding as of ${range.to ? fmtDate(range.to) : 'today'}`}
              fromDate={range.from || undefined}
              toDate={range.to || undefined}
            />
          </div>
        </div>

        <DashboardExpenseDetailsReport
          data={bi?.financialMatrix}
          isLoading={isLoading}
          isError={isError}
          fromDate={range.from || undefined}
          toDate={range.to || undefined}
        />

      </div>
      {/* Off-screen KPI share report — exists only to be photographed by the
          Share button. Fixed left offset keeps it out of view and out of the
          layout without display:none (which html-to-image cannot capture). */}
      {!isLoading && bi && (
        <div aria-hidden className="fixed top-0 -left-[10000px] pointer-events-none" style={{ zIndex: -1 }}>
          <DashboardShareReport
            ref={shareRef}
            locationLabel={reportLocationLabel ?? 'All Locations'}
            periodLabel={pLabel}
            presetLabel={PRESET_LABEL[range.preset] ?? 'Custom range'}
            generatedAt={formatDateTime(new Date())}
            cards={shareCards}
            reportMode={reportMode}
          />
        </div>
      )}
    </AppLayout>
  );
}
