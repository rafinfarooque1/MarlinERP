import { useState, useMemo, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCreateAccountLedger, customFetch } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  BookOpen, Plus, Landmark, BarChart3, TrendingDown, TrendingUp,
  CalendarDays, Store,
} from 'lucide-react';
type AccountLedgerInputType = 'asset' | 'liability' | 'income' | 'expense' | 'equity';
import { toast } from 'sonner';

/* ── types ──────────────────────────────────────────────────────────────────── */
interface LedgerNode {
  id: number; name: string; type: string;
  parentId: number | null; code: string | null;
  balance: number; children: LedgerNode[];
}
interface GroupSummary {
  id: number | null; name: string; code: string | null; type?: string;
  total: number; children: LedgerNode[];
}
interface FinancialStatements {
  filters: {
    warehouses: { id: number; name: string }[];
    outlets:    { id: number; name: string }[];
  };
  profitAndLoss: {
    expenses: {
      openingStock: number; purchases: number;
      directExpenses: GroupSummary; indirectExpenses: GroupSummary;
      total: number;
    };
    incomes: {
      sales: number; closingStock: number;
      directIncomes: GroupSummary; indirectIncomes: GroupSummary;
      total: number;
    };
    netProfit: number;
  };
  balanceSheet: {
    liabilities: {
      capitalAccount: GroupSummary; loans: GroupSummary; currentLiabilities: GroupSummary;
      pandlCarryForward: number; difference: number; total: number;
    };
    assets: {
      fixedAssets: GroupSummary; currentAssets: GroupSummary; total: number;
    };
  };
}

/* ── helpers ────────────────────────────────────────────────────────────────── */
const fmt = (n: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n);

function computeDateRange(period: string, customFrom: string, customTo: string) {
  const today = new Date();
  const iso = (d: Date) => d.toISOString().split('T')[0];
  if (period === 'month') {
    const from = new Date(today.getFullYear(), today.getMonth(), 1);
    return { fromDate: iso(from), toDate: iso(today) };
  }
  if (period === 'quarter') {
    const q = Math.floor(today.getMonth() / 3);
    const from = new Date(today.getFullYear(), q * 3, 1);
    return { fromDate: iso(from), toDate: iso(today) };
  }
  if (period === 'year') {
    return { fromDate: `${today.getFullYear()}-04-01`, toDate: iso(today) }; // Indian FY
  }
  if (period === 'custom') {
    return { fromDate: customFrom || undefined, toDate: customTo || undefined };
  }
  return { fromDate: undefined, toDate: undefined };
}

/* ── inline add ─────────────────────────────────────────────────────────────── */
function InlineAdd({
  parentId, parentType, depth, onCreated,
}: {
  parentId: number; parentType: string; depth: number; onCreated: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const createMutation = useCreateAccountLedger();

  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) { setEditing(false); setName(''); return; }
    createMutation.mutate(
      { data: { name: trimmed, type: parentType as AccountLedgerInputType, parentId } },
      {
        onSuccess: () => { toast.success('Ledger created'); setEditing(false); setName(''); onCreated(); },
        onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
      },
    );
  };

  const indent = `${depth * 20}px`;

  if (editing) {
    return (
      <div className="flex items-center gap-1.5 py-1" style={{ paddingLeft: indent }}>
        <Plus className="w-3 h-3 text-primary shrink-0" />
        <input
          ref={inputRef}
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
            if (e.key === 'Escape') { setEditing(false); setName(''); }
          }}
          onBlur={submit}
          placeholder="Ledger name…"
          className="flex-1 text-xs bg-transparent border-b border-primary/50 outline-none text-foreground placeholder:text-muted-foreground/50 pb-0.5"
          disabled={createMutation.isPending}
        />
        {createMutation.isPending && <span className="text-[10px] text-muted-foreground">Saving…</span>}
      </div>
    );
  }

  return (
    <button
      onClick={() => setEditing(true)}
      className="flex items-center gap-1 text-[11px] text-muted-foreground/40 hover:text-primary transition-colors py-0.5 w-full"
      style={{ paddingLeft: indent }}
    >
      <Plus className="w-3 h-3" />
      <span>add ledger</span>
    </button>
  );
}

/* ── ledger tree row ─────────────────────────────────────────────────────────── */
function LedgerRow({
  node, depth, onCreated,
}: {
  node: LedgerNode; depth: number; onCreated: () => void;
}) {
  const canAddChild = depth < 2;
  const absBalance = Math.abs(node.balance);

  return (
    <div>
      <div
        className="flex items-center gap-1.5 py-1 px-2 hover:bg-muted/5 group rounded transition-colors"
        style={{ paddingLeft: `${8 + depth * 20}px` }}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/25 shrink-0" />
        <span className={`flex-1 text-xs ${depth === 1 ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
          {node.name}
        </span>
        {absBalance > 0 && (
          <span className="text-[11px] font-mono text-muted-foreground tabular-nums">{fmt(absBalance)}</span>
        )}
      </div>

      {/* Children */}
      {node.children.length > 0 && node.children.map(child => (
        <LedgerRow key={child.id} node={child} depth={depth + 1} onCreated={onCreated} />
      ))}

      {/* Inline add for sub-ledger */}
      {canAddChild && (
        <InlineAdd parentId={node.id} parentType={node.type} depth={depth + 1} onCreated={onCreated} />
      )}
    </div>
  );
}

/* ── system group card ───────────────────────────────────────────────────────── */
function GroupSection({
  group, accentClass, onCreated,
}: {
  group: GroupSummary; accentClass: string; onCreated: () => void;
}) {
  const [open, setOpen] = useState(true);
  if (!group.id) return null;

  return (
    <div className="mb-1">
      <button
        onClick={() => setOpen(o => !o)}
        className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-colors ${accentClass}`}
      >
        <span className="flex-1 text-xs font-semibold tracking-wide">{group.name}</span>
        {group.total > 0 && (
          <span className="text-xs font-mono tabular-nums opacity-80">{fmt(group.total)}</span>
        )}
        <span className="text-[10px] opacity-40">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="pl-1 mt-0.5">
          {group.children.map(child => (
            <LedgerRow key={child.id} node={child} depth={1} onCreated={onCreated} />
          ))}
          <InlineAdd parentId={group.id!} parentType={(group.type ?? group.children[0]?.type ?? 'expense') as AccountLedgerInputType} depth={1} onCreated={onCreated} />
        </div>
      )}
    </div>
  );
}

/* ── auto row (read-only computed line) ─────────────────────────────────────── */
function AutoRow({ label, amount, className = '' }: { label: string; amount: number; className?: string }) {
  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 ${className}`}>
      <span className="flex-1 text-xs text-muted-foreground italic">{label}</span>
      <span className="text-xs font-mono tabular-nums text-muted-foreground">{fmt(amount)}</span>
    </div>
  );
}

/* ── section panel ───────────────────────────────────────────────────────────── */
function SectionPanel({
  title, icon: Icon, total, totalLabel, borderClass, headerClass, children,
}: {
  title: string; icon: React.ElementType; total: number; totalLabel?: string;
  borderClass: string; headerClass: string; children: React.ReactNode;
}) {
  return (
    <div className={`bg-card border ${borderClass} rounded-xl overflow-hidden shadow-sm flex flex-col`}>
      <div className={`flex items-center gap-2 px-4 py-3 ${headerClass}`}>
        <Icon className="w-4 h-4 shrink-0" />
        <span className="flex-1 text-sm font-bold uppercase tracking-widest">{title}</span>
        <span className="text-sm font-mono font-bold tabular-nums">{fmt(total)}</span>
        {totalLabel && <span className="text-[10px] opacity-60 ml-1">{totalLabel}</span>}
      </div>
      <div className="flex-1 overflow-auto p-3 space-y-0.5">
        {children}
      </div>
    </div>
  );
}

/* ── filter bar ─────────────────────────────────────────────────────────────── */
const PERIODS = [
  { value: 'all', label: 'All' },
  { value: 'month', label: 'This Month' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'year', label: 'This Year' },
  { value: 'custom', label: 'Custom' },
];

/* ── divider row ─────────────────────────────────────────────────────────────── */
function DividerRow() {
  return <div className="border-t border-border/40 my-2" />;
}

/* ── special carry-forward row ───────────────────────────────────────────────── */
function PnLRow({ amount }: { amount: number }) {
  const isProfit = amount >= 0;
  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold
      ${isProfit ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
      <span className="flex-1">P&amp;L {isProfit ? '(Profit)' : '(Loss)'}</span>
      <span className="font-mono tabular-nums">{fmt(Math.abs(amount))}</span>
    </div>
  );
}

function DifferenceRow({ amount }: { amount: number }) {
  if (Math.abs(amount) < 0.01) return null;
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold bg-amber-500/10 text-amber-400">
      <span className="flex-1">Difference</span>
      <span className="font-mono tabular-nums">{fmt(Math.abs(amount))}</span>
    </div>
  );
}

/* ── main component ─────────────────────────────────────────────────────────── */
export default function ChartOfAccounts() {
  const [period, setPeriod] = useState('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [outletId, setOutletId] = useState<string>('all');
  const queryClient = useQueryClient();

  const { fromDate, toDate } = useMemo(
    () => computeDateRange(period, customFrom, customTo),
    [period, customFrom, customTo],
  );

  const queryKey = useMemo(
    () => ['financial-statements', fromDate, toDate, outletId],
    [fromDate, toDate, outletId],
  );

  const { data: fs, isLoading, refetch } = useQuery<FinancialStatements>({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (fromDate) params.set('fromDate', fromDate);
      if (toDate)   params.set('toDate', toDate);
      if (outletId && outletId !== 'all') params.set('outletId', outletId);
      const qs = params.toString();
      return customFetch(`/accounts/financial-statements${qs ? `?${qs}` : ''}`, { method: 'GET' });
    },
    staleTime: 30_000,
  });

  const onCreated = () => queryClient.invalidateQueries({ queryKey });

  const plExpenses = fs?.profitAndLoss?.expenses;
  const plIncomes  = fs?.profitAndLoss?.incomes;
  const pl         = fs?.profitAndLoss;
  const bs         = fs?.balanceSheet;
  const outlets    = fs?.filters?.outlets ?? [];

  return (
    <AppLayout>
      <div className="space-y-5">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <BookOpen className="w-6 h-6 text-primary" /> Chart of Accounts
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Tally-style Balance Sheet &amp; Profit &amp; Loss · All figures auto-computed from transactions
          </p>
        </div>

        {/* Filter bar */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Period */}
          <div className="flex items-center gap-1 bg-muted/20 rounded-lg p-1">
            <CalendarDays className="w-3.5 h-3.5 text-muted-foreground ml-1" />
            {PERIODS.map(p => (
              <button
                key={p.value}
                onClick={() => setPeriod(p.value)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors
                  ${period === p.value ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Custom date range */}
          {period === 'custom' && (
            <div className="flex items-center gap-1.5">
              <Input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
                className="h-8 text-xs w-36" />
              <span className="text-muted-foreground text-xs">to</span>
              <Input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)}
                className="h-8 text-xs w-36" />
            </div>
          )}

          {/* Outlet filter */}
          {outlets.length > 0 && (
            <div className="flex items-center gap-1.5">
              <Store className="w-3.5 h-3.5 text-muted-foreground" />
              <Select value={outletId} onValueChange={setOutletId}>
                <SelectTrigger className="h-8 text-xs w-36">
                  <SelectValue placeholder="All Outlets" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Outlets</SelectItem>
                  {outlets.map(o => (
                    <SelectItem key={o.id} value={String(o.id)}>{o.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        {/* Tabs */}
        {isLoading ? (
          <div className="p-12 text-center text-muted-foreground text-sm animate-pulse">Computing financial statements…</div>
        ) : (
          <Tabs defaultValue="balance_sheet" className="space-y-4">
            <TabsList className="grid w-full max-w-xs grid-cols-2">
              <TabsTrigger value="balance_sheet" className="flex items-center gap-1.5">
                <Landmark className="w-3.5 h-3.5" /> Balance Sheet
              </TabsTrigger>
              <TabsTrigger value="profit_loss" className="flex items-center gap-1.5">
                <BarChart3 className="w-3.5 h-3.5" /> Profit &amp; Loss
              </TabsTrigger>
            </TabsList>

            {/* ── Balance Sheet ───────────────────────────────────────────── */}
            <TabsContent value="balance_sheet" className="mt-0">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

                {/* Liabilities */}
                <SectionPanel
                  title="Liabilities"
                  icon={TrendingDown}
                  total={bs?.liabilities.total ?? 0}
                  borderClass="border-red-500/20"
                  headerClass="bg-red-500/10 text-red-400 border-b border-red-500/15"
                >
                  {bs && (
                    <>
                      <GroupSection group={bs.liabilities.capitalAccount} onCreated={onCreated}
                        accentClass="bg-violet-500/10 text-violet-300 hover:bg-violet-500/15" />
                      <GroupSection group={bs.liabilities.loans} onCreated={onCreated}
                        accentClass="bg-red-500/10 text-red-300 hover:bg-red-500/15" />
                      <GroupSection group={bs.liabilities.currentLiabilities} onCreated={onCreated}
                        accentClass="bg-orange-500/10 text-orange-300 hover:bg-orange-500/15" />
                      <DividerRow />
                      <PnLRow amount={bs.liabilities.pandlCarryForward} />
                      <DifferenceRow amount={bs.liabilities.difference} />
                    </>
                  )}
                </SectionPanel>

                {/* Assets */}
                <SectionPanel
                  title="Assets"
                  icon={TrendingUp}
                  total={bs?.assets.total ?? 0}
                  borderClass="border-emerald-500/20"
                  headerClass="bg-emerald-500/10 text-emerald-400 border-b border-emerald-500/15"
                >
                  {bs && (
                    <>
                      <GroupSection group={bs.assets.fixedAssets} onCreated={onCreated}
                        accentClass="bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/15" />
                      <GroupSection group={bs.assets.currentAssets} onCreated={onCreated}
                        accentClass="bg-teal-500/10 text-teal-300 hover:bg-teal-500/15" />
                    </>
                  )}
                </SectionPanel>
              </div>
            </TabsContent>

            {/* ── Profit & Loss ───────────────────────────────────────────── */}
            <TabsContent value="profit_loss" className="mt-0">
              {/* Net P&L summary banner */}
              {pl && (
                <div className={`flex items-center gap-3 px-4 py-3 rounded-xl mb-4 text-sm font-semibold
                  ${pl.netProfit >= 0 ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'}`}>
                  {pl.netProfit >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                  <span>{pl.netProfit >= 0 ? 'Net Profit' : 'Net Loss'}</span>
                  <span className="font-mono text-base ml-auto">{fmt(Math.abs(pl.netProfit))}</span>
                </div>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

                {/* Expenses / Debit */}
                <SectionPanel
                  title="Expense"
                  icon={TrendingDown}
                  total={plExpenses?.total ?? 0}
                  totalLabel="(Debit)"
                  borderClass="border-red-500/20"
                  headerClass="bg-red-500/10 text-red-400 border-b border-red-500/15"
                >
                  {plExpenses && (
                    <>
                      <AutoRow label="Opening Stock" amount={plExpenses.openingStock} />
                      <AutoRow label="Purchase Account (auto)" amount={plExpenses.purchases}
                        className="border-l-2 border-orange-500/30 ml-2" />
                      <DividerRow />
                      <GroupSection group={plExpenses.directExpenses} onCreated={onCreated}
                        accentClass="bg-orange-500/10 text-orange-300 hover:bg-orange-500/15" />
                      <GroupSection group={plExpenses.indirectExpenses} onCreated={onCreated}
                        accentClass="bg-amber-500/10 text-amber-300 hover:bg-amber-500/15" />
                    </>
                  )}
                </SectionPanel>

                {/* Incomes / Credit */}
                <SectionPanel
                  title="Income"
                  icon={TrendingUp}
                  total={plIncomes?.total ?? 0}
                  totalLabel="(Credit)"
                  borderClass="border-emerald-500/20"
                  headerClass="bg-emerald-500/10 text-emerald-400 border-b border-emerald-500/15"
                >
                  {plIncomes && (
                    <>
                      <AutoRow label="Sales Account (auto)" amount={plIncomes.sales}
                        className="border-l-2 border-emerald-500/30 ml-2" />
                      <DividerRow />
                      <GroupSection group={plIncomes.directIncomes} onCreated={onCreated}
                        accentClass="bg-teal-500/10 text-teal-300 hover:bg-teal-500/15" />
                      <AutoRow label="Closing Stock (auto)" amount={plIncomes.closingStock}
                        className="border-l-2 border-blue-500/30 ml-2" />
                      <DividerRow />
                      <GroupSection group={plIncomes.indirectIncomes} onCreated={onCreated}
                        accentClass="bg-blue-500/10 text-blue-300 hover:bg-blue-500/15" />
                    </>
                  )}
                </SectionPanel>
              </div>
            </TabsContent>
          </Tabs>
        )}
      </div>
    </AppLayout>
  );
}
