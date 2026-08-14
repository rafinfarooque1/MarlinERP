import { useMemo, useRef, useState, useLayoutEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  useGetDashboardBi,
  useAssetSummary,
  getStockAlerts,
  customFetch,
  type DashboardBiFilters,
  type ReceivablesAging,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { usePermission } from '@/lib/usePermission';
import { useLocationContext, locationFilterParams } from '@/lib/locationContext';
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
  ShieldOff, TrendingUp, ShoppingCart, Factory, Boxes,
  Landmark, Trophy, Users, AlertTriangle, Clock, MapPin,
  Warehouse, Store, ArrowUpRight, ArrowDownRight, Wallet,
  Receipt, PieChart, BarChart3, Banknote, HandCoins,
  LayoutDashboard, Share2, Loader2, Hourglass, ChevronRight, type LucideIcon,
} from 'lucide-react';
import { useLocation } from 'wouter';
import {
  fmt, num, fmtDate, periodLabel,
  useDateRange, RangeBar, SummaryCards, LocationBadge, TONE_CLS,
  type CardTone, type SummaryCard,
} from '@/pages/reports/shared';

// ── Small helpers ───────────────────────────────────────────────────────────

const WAREHOUSE_COLOR = 'hsl(var(--primary))';
const OUTLET_COLOR = 'hsl(var(--chart-2))';

const PAY_LABEL: Record<string, string> = {
  cash: 'Cash', card: 'Card', upi: 'UPI',
  bank_transfer: 'Bank', credit: 'Credit', unknown: 'Other',
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

  const filters = useMemo<DashboardBiFilters>(() => {
    const f: DashboardBiFilters = {};
    if (range.from) f.fromDate = range.from;
    if (range.to) f.toDate = range.to;
    const loc = locationFilterParams(locationState);
    if (loc.locationType && loc.locationId) {
      f.locationType = loc.locationType;
      f.locationId = loc.locationId;
    }
    return f;
  }, [range.from, range.to, locationState]);

  const { data: bi, isLoading, isError } = useGetDashboardBi(filters);

  const pLabel = periodLabel(range.from || undefined, range.to || undefined);

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
  const prodDayMax = Math.max(0, ...(bi?.production.byDay.map(d => d.qty) ?? [0]));
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

  // ── Export / Share: capture the dashboard as one PNG (client-side) ────────
  // Rendered off the live DOM with html2canvas (lazy-loaded — it's only paid
  // for on tap). Mobile browsers get the native share sheet (WhatsApp etc.);
  // everywhere else the image downloads.
  const captureRef = useRef<HTMLDivElement>(null);
  const [sharing, setSharing] = useState(false);
  const shareDashboard = async () => {
    const el = captureRef.current;
    if (!el) {
      // Should be unreachable — the button lives inside the captured div.
      console.error('[dashboard] share: capture root not mounted');
      toast.error('Could not capture the dashboard image');
      return;
    }
    if (sharing) return;
    console.debug('[dashboard] share: capturing…');
    setSharing(true);
    try {
      // html-to-image renders via SVG <foreignObject>, so the BROWSER paints
      // the clone — modern color functions (Tailwind v4 emits oklab/oklch,
      // which html2canvas could not parse) work for free.
      const { toBlob } = await import('html-to-image');
      const blob = await toBlob(el, {
        backgroundColor: getComputedStyle(document.body).backgroundColor || '#ffffff',
        pixelRatio: Math.min(2, Math.max(1, window.devicePixelRatio || 1)),
        cacheBust: true,
      });
      if (!blob) throw new Error('empty canvas');
      const file = new File([blob], `dashboard-${new Date().toISOString().slice(0, 10)}.png`, { type: 'image/png' });
      if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Business Dashboard' });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = file.name;
        a.click();
        URL.revokeObjectURL(url);
        toast.success('Dashboard image downloaded');
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
  // Payments|Receipts, Cash|Bank, GP|NP.
  // Inventory Value is hidden entirely for employees without the valuation
  // right (the server omits the figure) — Expenses then spans its full row so
  // every later pair stays intact.
  const hasInventory = !!bi?.canViewValuation;

  const summaryCards: SummaryCard[] = [
    // ── Row 1: Sales · Purchases ────────────────────────────────────────────
    { label: 'Sales', value: fmt(s?.total ?? 0), tone: 'pos', onClick: drillTo('/reports/sales', 'register') },
    { label: 'Purchases', value: fmt(bi?.purchases.total ?? 0), onClick: drillTo('/reports/purchases', 'register') },
    // ── Row 2: Inventory · Expenses ─────────────────────────────────────────
    ...(hasInventory
      ? [{ label: 'Inventory Value', value: fmt(bi!.inventory.valuation ?? 0), tone: 'info' as CardTone, onClick: drillTo('/reports/inventory', 'valuation') }]
      : []),
    // Expenses and the balance tiles come from the accounting postings, which
    // carry no location. The API returns null for a single-location login
    // rather than passing off a company-wide number as that branch's — render
    // the gap instead of a misleading zero.
    {
      label: 'Expenses',
      value: bi?.expenses?.total == null ? '—' : fmt(bi.expenses.total),
      tone: (bi?.expenses?.total ?? 0) > 0 ? 'neg' : 'default',
      // Same three-way breakdown style as the Payables card. Salary and Rent
      // are read off the same P&L build as the total and Other is the exact
      // remainder, so the line always sums to the figure above it for every
      // date range. Hidden (like the total) for single-location logins.
      hint: bi?.expenses?.total != null && bi.expenses.salary != null
        ? `Salary ${fmt(bi.expenses.salary)} · Rent ${fmt(bi.expenses.rent ?? 0)} · Other ${fmt(bi.expenses.other ?? 0)}`
        : undefined,
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
      value: (bi?.payables as any)?.allPayables == null ? '—' : fmt((bi!.payables as any).allPayables),
      tone: (bi?.payables as any)?.allPayables == null ? 'default' : 'neg',
      // Breakdown of everything the company owes: trade creditors, accrued
      // salary and accrued rent — the same three figures allPayables sums, so
      // the hint always reconciles with the number above it. Rendered whenever
      // the ledger figures are available (they are null for non-HO scopes).
      hint: (bi?.payables as any)?.salaryPayable != null
        ? `Suppliers ${fmt(bi!.payables.total ?? 0)} · Salary ${fmt((bi!.payables as any).salaryPayable)} · Rent ${fmt((bi!.payables as any).rentPayable ?? 0)}`
        : undefined,
      // allPayables spans trade creditors + accrued salary + accrued rent, so
      // the Balance Sheet liabilities table (which shows all three lines) is
      // the report that equals it — vendor-only Payables Ageing matches just
      // the Suppliers figure in the hint.
      onClick: drillTo('/reports/financial', 'balanceSheet', 'bs-liabilities'),
    },
    {
      label: 'Receivables',
      value: bi?.receivables?.total == null ? '—' : fmt(bi.receivables.total),
      tone: bi?.receivables?.total == null ? 'default' : (bi?.receivables?.overdue ?? 0) > 0 ? 'warn' : 'info',
      onClick: drillTo('/reports/parties', 'receivables'),
    },
    // ── Row 4: Payments · Receipts ──────────────────────────────────────────
    // Period money out / in over the cash AND bank books; the hint splits the
    // figure by book, so it always reconciles with the number above it. Both
    // tiles drill into the combined Cash & Bank book — the Cash Book alone
    // excludes bank movements and could never equal these figures.
    {
      label: 'Payments',
      value: mf == null ? '—' : fmt(mf.totalOut),
      tone: mf == null ? 'default' : mf.totalOut > 0 ? 'neg' : 'default',
      hint: mf == null ? undefined : `Cash ${fmt(mf.cashOut)} · Bank ${fmt(mf.bankOut)}`,
      onClick: drillTo('/reports/financial', 'cashBank'),
    },
    {
      label: 'Receipts',
      value: mf == null ? '—' : fmt(mf.totalIn),
      tone: mf == null ? 'default' : mf.totalIn > 0 ? 'pos' : 'default',
      hint: mf == null ? undefined : `Cash ${fmt(mf.cashIn)} · Bank ${fmt(mf.bankIn)}`,
      onClick: drillTo('/reports/financial', 'cashBank'),
    },
    // ── Row 5: Cash · Bank ──────────────────────────────────────────────────
    {
      label: 'Cash Balance',
      value: bi?.cash?.balance == null ? '—' : fmt(bi.cash.balance),
      tone: bi?.cash?.balance == null ? 'default' : bi.cash.balance >= 0 ? 'pos' : 'neg',
      onClick: drillTo('/reports/financial', 'cash'),
    },
    {
      label: 'Bank Balance',
      value: bi?.bank?.balance == null ? '—' : fmt(bi.bank.balance),
      tone: bi?.bank?.balance == null ? 'default' : bi.bank.balance >= 0 ? 'pos' : 'neg',
      onClick: drillTo('/reports/financial', 'bank'),
    },
    // ── Row 6: COGS · GP — both read the P&L's own summary, never a re-sum ──
    {
      label: 'COGS',
      value: pf?.cogs == null ? '—' : fmt(pf.cogs),
      tone: 'default',
      hint: 'Cost of Goods Sold · tap for P&L',
      onClick: drill('pl-cogs'),
    },
    {
      label: 'GP',
      value: pf?.gross == null ? '—' : fmt(pf.gross),
      tone: pf?.gross == null ? 'default' : pf.gross >= 0 ? 'pos' : 'neg',
      hint: 'Gross Profit · tap for P&L',
      onClick: drill('pl-gross-profit'),
    },
    // ── Row 7: NP — the bottom line takes the full row ──────────────────────
    {
      label: 'NP',
      value: pf?.net == null ? '—' : fmt(pf.net),
      tone: pf?.net == null ? 'default' : pf.net >= 0 ? 'pos' : 'neg',
      hint: 'Net Profit · tap for P&L',
      onClick: drill('pl-net-profit'),
      className: 'md:col-span-2',
    },
  ];

  // Mobile-only card set: same figures, order and tones as summaryCards, but
  // with shorter labels, subtle icons, structured breakdown lines and one-line
  // descriptions, per the owner's mobile-dashboard spec. Pairs land as
  // Sales|Purchases, Inventory|Expenses, Payables|Receivables,
  // Payments|Receipts, Cash|Bank, GP|NP; when Inventory is permission-hidden,
  // Expenses spans its full row so every later semantic pair stays intact.
  const mobileCards: MobileKpi[] = [
    { label: 'Sales', icon: TrendingUp, value: fmt(s?.total ?? 0), tone: 'pos', onClick: drillTo('/reports/sales', 'register') },
    { label: 'Purchases', icon: ShoppingCart, value: fmt(bi?.purchases.total ?? 0), onClick: drillTo('/reports/purchases', 'register') },
    ...(hasInventory
      ? [{ label: 'Inventory', icon: Boxes, value: fmt(bi!.inventory.valuation ?? 0), tone: 'info' as CardTone, onClick: drillTo('/reports/inventory', 'valuation') }]
      : []),
    {
      label: 'Expenses',
      icon: Receipt,
      value: bi?.expenses?.total == null ? '—' : fmt(bi.expenses.total),
      tone: (bi?.expenses?.total ?? 0) > 0 ? 'neg' : 'default',
      lines: bi?.expenses?.total != null && bi.expenses.salary != null
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
      value: (bi?.payables as any)?.allPayables == null ? '—' : fmt((bi!.payables as any).allPayables),
      tone: (bi?.payables as any)?.allPayables == null ? 'default' : 'neg',
      lines: (bi?.payables as any)?.salaryPayable != null
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
      value: bi?.receivables?.total == null ? '—' : fmt(bi.receivables.total),
      tone: bi?.receivables?.total == null ? 'default' : (bi?.receivables?.overdue ?? 0) > 0 ? 'warn' : 'info',
      onClick: drillTo('/reports/parties', 'receivables'),
    },
    {
      label: 'Payments',
      icon: Banknote,
      value: mf == null ? '—' : fmt(mf.totalOut),
      tone: mf == null ? 'default' : mf.totalOut > 0 ? 'neg' : 'default',
      lines: mf == null
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
      value: mf == null ? '—' : fmt(mf.totalIn),
      tone: mf == null ? 'default' : mf.totalIn > 0 ? 'pos' : 'default',
      lines: mf == null
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
      value: bi?.cash?.balance == null ? '—' : fmt(bi.cash.balance),
      tone: bi?.cash?.balance == null ? 'default' : bi.cash.balance >= 0 ? 'pos' : 'neg',
      onClick: drillTo('/reports/financial', 'cash'),
    },
    {
      label: 'Bank',
      icon: Landmark,
      value: bi?.bank?.balance == null ? '—' : fmt(bi.bank.balance),
      tone: bi?.bank?.balance == null ? 'default' : bi.bank.balance >= 0 ? 'pos' : 'neg',
      onClick: drillTo('/reports/financial', 'bank'),
    },
    {
      label: 'COGS',
      icon: Boxes,
      value: pf?.cogs == null ? '—' : fmt(pf.cogs),
      desc: 'Cost of Goods Sold',
      onClick: drill('pl-cogs'),
    },
    {
      label: 'GP',
      icon: PieChart,
      value: pf?.gross == null ? '—' : fmt(pf.gross),
      tone: pf?.gross == null ? 'default' : pf.gross >= 0 ? 'pos' : 'neg',
      desc: 'Gross Profit',
      onClick: drill('pl-gross-profit'),
    },
    {
      label: 'NP',
      icon: BarChart3,
      value: pf?.net == null ? '—' : fmt(pf.net),
      tone: pf?.net == null ? 'default' : pf.net >= 0 ? 'pos' : 'neg',
      desc: 'Net Profit',
      onClick: drill('pl-net-profit'),
      spanTwo: true,
    },
  ];

  return (
    <AppLayout>
      <div className="space-y-6" ref={captureRef}>

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
            </div>
          }
        >
          <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
            <MapPin className="w-3.5 h-3.5" />
            {bi?.scope.label ?? '…'} · {pLabel}
          </p>
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
                Expenses and Bank Balance are company-level accounting figures and are not
                broken down by location, so they are not shown for a single-location view.
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

        {/* ── Production + inventory + top customers ──────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <SectionCard
            title="Production"
            icon={<Factory className="w-5 h-5 text-chart-3" />}
            description={bi ? `${num(bi.production.batches)} batch${bi.production.batches !== 1 ? 'es' : ''}` : undefined}
          >
            {isLoading ? (
              <div className="space-y-3">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-8" />)}</div>
            ) : !bi || bi.production.byDay.length === 0 ? (
              <Empty message="No production in this period" />
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2 mb-4">
                  <div className="rounded-lg border border-border bg-muted/10 p-2 text-center">
                    <p className="text-[10px] text-muted-foreground">Output</p>
                    <p className="font-bold font-mono text-sm">{num(bi.production.outputQty)}</p>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/10 p-2 text-center">
                    <p className="text-[10px] text-muted-foreground">Wastage</p>
                    <p className="font-bold font-mono text-sm text-amber-600">
                      {num(bi.production.wastageQty)} ({bi.production.wastagePct}%)
                    </p>
                  </div>
                </div>
                <div className="space-y-3">
                  {bi.production.byDay.map(d => (
                    <BarRow
                      key={d.date}
                      label={fmtDate(d.date)}
                      value={d.qty}
                      max={prodDayMax}
                      color="hsl(var(--chart-3))"
                      valueLabel={num(d.qty)}
                    />
                  ))}
                </div>
              </>
            )}
          </SectionCard>

          <SectionCard title="Inventory" icon={<Boxes className="w-5 h-5 text-primary" />}>
            {isLoading ? (
              <div className="space-y-3">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
            ) : !bi ? (
              <Empty message="No inventory data" />
            ) : (
              <div className="space-y-2.5">
                {bi.canViewValuation && (
                  <StatRow icon={<Landmark className="w-4 h-4 text-primary" />} label="Valuation" value={fmt(bi.inventory.valuation ?? 0)} />
                )}
                <StatRow icon={<Boxes className="w-4 h-4 text-muted-foreground" />} label="Products in stock" value={num(bi.inventory.itemCount)} />
                <StatRow
                  icon={<AlertTriangle className="w-4 h-4 text-destructive" />}
                  label="Low-stock alerts"
                  value={num(bi.inventory.lowStockCount)}
                  tone={bi.inventory.lowStockCount > 0 ? 'neg' : undefined}
                />
                <StatRow
                  icon={<Clock className="w-4 h-4 text-amber-600" />}
                  label="Expiring ≤ 30 days"
                  value={num(bi.inventory.expiringSoonCount)}
                  tone={bi.inventory.expiringSoonCount > 0 ? 'warn' : undefined}
                />
                <div className="pt-2 mt-2 border-t border-border space-y-2.5">
                  <StatRow icon={<ArrowUpRight className="w-4 h-4 text-emerald-600" />} label="Cash inflow" value={fmt(bi.cash.inflow)} tone="pos" />
                  <StatRow icon={<ArrowDownRight className="w-4 h-4 text-red-500" />} label="Cash outflow" value={fmt(bi.cash.outflow)} tone="neg" />
                </div>
              </div>
            )}
          </SectionCard>

          <AssetsSection />

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
        </div>

        {/* ── Receivables ageing + stock alerts ───────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <AgeingSnapshot asOf={range.to || undefined} onOpen={drillTo('/reports/parties', 'receivables')} />
          <StockAlertsCard
            expiringSoonCount={bi?.inventory.expiringSoonCount ?? 0}
            onOpenReorder={drillTo('/reports/inventory', 'reorder')}
            onOpenExpiry={drillTo('/reports/inventory', 'near_expiry')}
          />
        </div>
      </div>
    </AppLayout>
  );
}

/**
 * Receivables ageing snapshot — reads the SAME endpoint as the Parties →
 * Receivables report (as-of the dashboard range end), so every figure here
 * equals that report opened from the card. Hidden entirely for users who
 * can't open that report (the endpoint would 403 for them anyway).
 */
function AgeingSnapshot({ asOf, onOpen }: { asOf?: string; onOpen: () => void }) {
  const outstandingPerm = usePermission('page:/outstanding');
  const customersPerm = usePermission('page:/customers');
  const canView = outstandingPerm.canView || customersPerm.canView;
  const { locationState } = useLocationContext();
  // The endpoint follows the global x-location headers, so the header context
  // must be part of the key or a location switch would serve a stale slice.
  // First element mirrors getReceivablesAgingQueryKey() — the existing
  // returns/receipts invalidations refresh this widget too.
  const locKey = JSON.stringify(locationFilterParams(locationState));
  const { data, isLoading } = useQuery({
    queryKey: ['/api/outstanding/receivables', asOf ?? '', locKey],
    queryFn: () => customFetch<ReceivablesAging>(`/api/outstanding/receivables${asOf ? `?asOf=${asOf}` : ''}`),
    enabled: canView,
  });
  if (!canView) return null;

  const t = data?.totals;
  const buckets = [
    { label: '0–30 d', value: t?.b0_30 ?? 0 },
    { label: '31–60 d', value: t?.b31_60 ?? 0 },
    { label: '61–90 d', value: t?.b61_90 ?? 0 },
    { label: '> 90 d', value: t?.b90p ?? 0 },
  ];
  const top = (data?.customers ?? [])
    .filter((c) => c.netDue > 0)
    .sort((a, b) => b.netDue - a.netDue)
    .slice(0, 5);
  const topMax = Math.max(0, ...top.map((c) => c.netDue));

  return (
    <SectionCard
      title="Receivables Ageing"
      icon={<Hourglass className="w-5 h-5 text-amber-600" />}
      description={data ? `Net due ${fmt(t?.netDue ?? 0)} as of ${fmtDate(data.asOf)}` : undefined}
    >
      {isLoading ? (
        <div className="space-y-3">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-8" />)}</div>
      ) : !data ? (
        <Empty message="No receivables data" />
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-4 gap-2">
            {buckets.map((b) => (
              <div key={b.label} className="rounded-lg border border-border bg-muted/10 p-2 text-center min-w-0">
                <p className="text-[10px] text-muted-foreground whitespace-nowrap">{b.label}</p>
                <p className="text-xs font-bold font-mono truncate" title={fmt(b.value)}>{compactINR(fmt(b.value))}</p>
              </div>
            ))}
          </div>
          {top.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-3">Nothing outstanding — all collected.</p>
          ) : (
            <div className="space-y-2">
              {top.map((c) => (
                <BarRow
                  key={c.customerId}
                  label={c.name}
                  sub={c.b90p > 0 ? `${fmt(c.b90p)} over 90 d` : undefined}
                  value={c.netDue}
                  max={topMax}
                  color={c.b90p > 0 ? 'hsl(var(--destructive))' : 'hsl(var(--chart-2))'}
                  valueLabel={fmt(c.netDue)}
                />
              ))}
            </div>
          )}
          <Button variant="ghost" size="sm" className="w-full justify-between" onClick={onOpen}>
            Open receivables report
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      )}
    </SectionCard>
  );
}

/**
 * Low-stock + near-expiry alerts — item-level detail behind the Inventory
 * card's alert counts, from the existing /dashboard/stock-alerts endpoint
 * (same LBAC + view-location scoping as every other dashboard figure).
 */
function StockAlertsCard({ expiringSoonCount, onOpenReorder, onOpenExpiry }: {
  expiringSoonCount: number;
  onOpenReorder: () => void;
  onOpenExpiry: () => void;
}) {
  const { locationState } = useLocationContext();
  const locKey = JSON.stringify(locationFilterParams(locationState));
  const { data, isLoading } = useQuery({
    // Same first element as the generated getGetStockAlertsQueryKey() so the
    // shared /api/dashboard invalidation predicate refreshes this widget.
    queryKey: ['/api/dashboard/stock-alerts', locKey],
    queryFn: () => getStockAlerts(),
  });
  const alerts = data ?? [];

  return (
    <SectionCard
      title="Stock Alerts"
      icon={<AlertTriangle className="w-5 h-5 text-destructive" />}
      description="Below reorder level, plus items expiring within 30 days"
    >
      {isLoading ? (
        <div className="space-y-3">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-8" />)}</div>
      ) : (
        <div className="space-y-3">
          {alerts.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-3">No items below reorder level.</p>
          ) : (
            <div className="space-y-2">
              {alerts.slice(0, 6).map((a, i) => (
                <div key={`${a.itemId}-${a.branchName}-${i}`} className="flex items-center justify-between gap-2 p-2 rounded-lg border border-border bg-muted/10">
                  <div className="min-w-0">
                    <p className="font-medium text-sm truncate">{a.itemName || `Item #${a.itemId}`}</p>
                    <p className="text-[10px] text-muted-foreground truncate">{a.branchName}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-bold text-sm font-mono text-destructive">{num(a.quantity ?? 0)}</p>
                    {(a as any).reorderLevel != null && (
                      <p className="text-[10px] text-muted-foreground">reorder at {num((a as any).reorderLevel)}</p>
                    )}
                  </div>
                </div>
              ))}
              {alerts.length > 6 && (
                <p className="text-[11px] text-muted-foreground text-center">+{alerts.length - 6} more in the reorder report</p>
              )}
            </div>
          )}
          <div className="flex items-center justify-between gap-2 p-2 rounded-lg border border-border bg-muted/10">
            <div className="flex items-center gap-2 min-w-0">
              <Clock className="w-4 h-4 text-amber-600 shrink-0" />
              <span className="text-sm truncate">Expiring ≤ 30 days</span>
            </div>
            <span className={`font-bold text-sm font-mono ${expiringSoonCount > 0 ? 'text-amber-600' : ''}`}>{num(expiringSoonCount)}</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="ghost" size="sm" className="justify-between" onClick={onOpenReorder}>
              Reorder report
              <ChevronRight className="w-4 h-4" />
            </Button>
            <Button variant="ghost" size="sm" className="justify-between" onClick={onOpenExpiry}>
              Near-expiry report
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}
    </SectionCard>
  );
}

/**
 * Fixed-asset summary — visible only to users with asset view rights. Renders
 * nothing (not an empty shell) for everyone else: the summary endpoint would
 * 403 for them anyway.
 */
function AssetsSection() {
  const registerPerm = usePermission('page:/assets/register');
  const purchasesPerm = usePermission('page:/assets/purchases');
  const reportsPerm = usePermission('page:/assets/reports');
  const canSee = registerPerm.canView || purchasesPerm.canView || reportsPerm.canView;
  const { data: summary, isLoading } = useAssetSummary(canSee);

  if (!canSee) return null;

  const byLocMax = Math.max(0, ...(summary?.byLocation.map(l => l.value) ?? [0]));

  return (
    <SectionCard
      title="Assets"
      icon={<Landmark className="w-5 h-5 text-primary" />}
      description="Fixed assets at cost — separate from inventory"
    >
      {isLoading || !summary ? (
        <div className="space-y-3">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
      ) : (
        <div className="space-y-2.5">
          <StatRow icon={<Boxes className="w-4 h-4 text-muted-foreground" />} label="Total assets" value={num(summary.totalAssets)} />
          <StatRow icon={<Landmark className="w-4 h-4 text-primary" />} label="Asset value" value={fmt(summary.assetValue)} />
          <StatRow
            icon={<ShoppingCart className="w-4 h-4 text-emerald-600" />}
            label="Purchased this month"
            value={<>{num(summary.purchasedThisMonth.count)} <span className="text-muted-foreground font-normal">· {fmt(summary.purchasedThisMonth.value)}</span></>}
          />
          <StatRow
            icon={<Clock className="w-4 h-4 text-amber-600" />}
            label={`Warranty ending ≤ ${summary.warrantyExpiringSoon.withinDays} days`}
            value={num(summary.warrantyExpiringSoon.count)}
            tone={summary.warrantyExpiringSoon.count > 0 ? 'warn' : undefined}
          />
          {summary.byLocation.length > 0 && (
            <div className="pt-2 mt-2 border-t border-border space-y-2">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">By location</p>
              {summary.byLocation.slice(0, 5).map(l => (
                <BarRow
                  key={`${l.locationType}:${l.locationId}`}
                  label={l.name}
                  value={l.value}
                  max={byLocMax}
                  color={WAREHOUSE_COLOR}
                  valueLabel={`${l.count} · ${fmt(l.value)}`}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </SectionCard>
  );
}
function StatRow({ icon, label, value, tone }: {
  icon: React.ReactNode; label: string; value: React.ReactNode; tone?: 'pos' | 'neg' | 'warn';
}) {
  const cls = tone === 'pos' ? 'text-emerald-600' : tone === 'neg' ? 'text-red-500' : tone === 'warn' ? 'text-amber-600' : '';
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-2 text-sm text-muted-foreground">{icon}{label}</span>
      <span className={`font-bold font-mono text-sm ${cls}`}>{value}</span>
    </div>
  );
}
