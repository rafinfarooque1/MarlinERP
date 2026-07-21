import { useState, useMemo, useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCreateAccountLedger, customFetch } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Building2, CalendarDays, Store, TrendingDown, TrendingUp, Landmark, BarChart3, Plus, ChevronDown, ChevronRight, Package } from 'lucide-react';
import { toast } from 'sonner';

/* ── types ──────────────────────────────────────────────────────────────────── */
type ALType = 'asset' | 'liability' | 'income' | 'expense' | 'equity';

interface StockItem { id: number; name: string; unit: string; stock: number; mrp: number; total: number }
interface LedgerNode { id: number; name: string; type: string; parentId: number | null; code: string | null; balance: number; children: LedgerNode[] }
interface GroupSummary { id: number | null; name: string; code: string | null; type?: string; total: number; children: LedgerNode[]; dutyAndTax?: number }
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

/* ── helpers ─────────────────────────────────────────────────────────────────── */
const fmt = (n: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n);

function computeDateRange(period: string, from: string, to: string) {
  const today = new Date();
  const iso = (d: Date) => d.toISOString().split('T')[0];
  if (period === 'month')   { const f = new Date(today.getFullYear(), today.getMonth(), 1);        return { fromDate: iso(f),  toDate: iso(today) }; }
  if (period === 'quarter') { const q = Math.floor(today.getMonth() / 3); const f = new Date(today.getFullYear(), q * 3, 1); return { fromDate: iso(f),  toDate: iso(today) }; }
  if (period === 'year')    { return { fromDate: `${today.getFullYear()}-04-01`, toDate: iso(today) }; }
  if (period === 'custom')  { return { fromDate: from || undefined, toDate: to || undefined }; }
  return { fromDate: undefined, toDate: undefined };
}

/* ── inline add ─────────────────────────────────────────────────────────────── */
function InlineAdd({ parentId, parentType, depth = 1, onCreated, hint }: {
  parentId: number; parentType: ALType; depth?: number; onCreated: () => void; hint?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  const create = useCreateAccountLedger();

  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);

  const submit = () => {
    const t = name.trim();
    if (!t) { setEditing(false); setName(''); return; }
    create.mutate({ data: { name: t, type: parentType, parentId } }, {
      onSuccess: () => { toast.success('Ledger created'); setEditing(false); setName(''); onCreated(); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  const pl = `${8 + depth * 16}px`;

  if (editing) {
    return (
      <div className="flex items-center gap-2 py-2" style={{ paddingLeft: pl }}>
        <Plus className="w-3.5 h-3.5 text-primary shrink-0" />
        <input
          ref={ref} value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') { setEditing(false); setName(''); } }}
          onBlur={submit}
          placeholder={hint ?? (depth === 1 ? 'Ledger name…' : 'Sub-ledger name…')}
          className="flex-1 text-sm bg-transparent border-b-2 border-primary outline-none pb-0.5 text-foreground placeholder:text-muted-foreground/40"
          disabled={create.isPending}
        />
        {create.isPending && <span className="text-[10px] text-muted-foreground">Saving…</span>}
      </div>
    );
  }

  return (
    <button
      onClick={() => setEditing(true)}
      style={{ paddingLeft: pl }}
      className="flex items-center gap-1.5 py-2 w-full text-xs text-primary/60 hover:text-primary active:text-primary transition-colors font-medium"
    >
      <Plus className="w-3.5 h-3.5" />
      {hint ?? (depth === 1 ? 'Add ledger' : 'Add sub-ledger')}
    </button>
  );
}

/* ── bank ledger dialog ──────────────────────────────────────────────────────── */
function BankLedgerDialog({ parentId, parentType, onCreated, onClose }: {
  parentId: number; parentType: ALType; onCreated: () => void; onClose: () => void;
}) {
  const [name, setName]         = useState('');
  const [bankName, setBankName] = useState('');
  const [accNo, setAccNo]       = useState('');
  const [ifsc, setIfsc]         = useState('');
  const [branch, setBranch]     = useState('');
  const create = useCreateAccountLedger();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate(
      { data: { name: name.trim(), type: parentType, parentId, bankDetails: { bankName, accountNumber: accNo, ifscCode: ifsc.toUpperCase(), branch } } as any },
      {
        onSuccess: () => { toast.success('Bank account added'); onCreated(); onClose(); },
        onError: (err: any) => toast.error(err?.data?.error || err.message || 'Failed'),
      }
    );
  };

  return (
    <Dialog open onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="w-4 h-4 text-primary" /> Add Bank Account
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3 pt-1">
          <div>
            <label className="text-xs font-medium text-foreground">Account Name / Branch Label <span className="text-destructive">*</span></label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. HDFC Current A/C" className="mt-1" autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-foreground">Bank Name</label>
              <Input value={bankName} onChange={e => setBankName(e.target.value)} placeholder="HDFC Bank" className="mt-1" />
            </div>
            <div>
              <label className="text-xs font-medium text-foreground">Account Number</label>
              <Input value={accNo} onChange={e => setAccNo(e.target.value)} placeholder="50100XXXXXXXX" className="mt-1" />
            </div>
            <div>
              <label className="text-xs font-medium text-foreground">IFSC Code</label>
              <Input value={ifsc} onChange={e => setIfsc(e.target.value.toUpperCase())} placeholder="HDFC0001234" className="mt-1 font-mono" />
            </div>
            <div>
              <label className="text-xs font-medium text-foreground">Branch</label>
              <Input value={branch} onChange={e => setBranch(e.target.value)} placeholder="Anna Nagar" className="mt-1" />
            </div>
          </div>
          <DialogFooter className="pt-2">
            <Button variant="outline" type="button" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={create.isPending || !name.trim()}>
              {create.isPending ? 'Saving…' : 'Add Bank Account'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ── ledger line (recursive) ─────────────────────────────────────────────────── */
function LedgerLine({ node, depth, onCreated, onBankAdd }: {
  node: LedgerNode; depth: number; onCreated: () => void;
  onBankAdd?: (parentId: number, parentType: ALType) => void;
}) {
  const pl = `${8 + depth * 16}px`;
  const balance = Math.abs(node.balance);
  const isBank = node.code === 'STD-BANK';

  return (
    <div>
      {/* Row */}
      <div className="flex items-center gap-2 py-1.5 group" style={{ paddingLeft: pl }}>
        <span className="w-1 h-1 rounded-full bg-muted-foreground/25 shrink-0" />
        <span className={`flex-1 text-xs ${depth === 1 ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
          {node.name}
        </span>
        {balance > 0 && (
          <span className="text-[11px] font-mono tabular-nums text-muted-foreground pr-3">{fmt(balance)}</span>
        )}
      </div>

      {/* Sub-ledgers */}
      {node.children.map(c => (
        <LedgerLine key={c.id} node={c} depth={depth + 1} onCreated={onCreated} onBankAdd={onBankAdd} />
      ))}

      {/* Add sub-ledger button (only at depth 1) */}
      {depth === 1 && (
        isBank && onBankAdd
          ? (
            <button
              onClick={() => onBankAdd(node.id, node.type as ALType)}
              style={{ paddingLeft: `${8 + 2 * 16}px` }}
              className="flex items-center gap-1.5 py-2 w-full text-xs text-primary/60 hover:text-primary active:text-primary transition-colors font-medium"
            >
              <Plus className="w-3.5 h-3.5" />
              Add bank account
            </button>
          )
          : <InlineAdd parentId={node.id} parentType={node.type as ALType} depth={2} onCreated={onCreated} />
      )}
    </div>
  );
}

/* ── group block ────────────────────────────────────────────────────────────── */
function GroupBlock({ group, onCreated, extraRows, onBankAdd }: {
  group: GroupSummary;
  onCreated: () => void;
  extraRows?: React.ReactNode;
  onBankAdd?: (parentId: number, parentType: ALType) => void;
}) {
  if (!group.id) return null;
  const hasChildren = group.children.length > 0 || !!extraRows;

  return (
    <div className="mb-3">
      {/* Group label row */}
      <div className="flex items-center gap-2 py-2 px-3 bg-muted/10 rounded-md mx-2">
        <span className="flex-1 text-xs font-bold text-foreground/70 uppercase tracking-wide">{group.name}</span>
        {group.total > 0 && (
          <span className="text-xs font-mono font-semibold tabular-nums text-foreground/60">{fmt(group.total)}</span>
        )}
      </div>

      {/* Ledgers under group */}
      {group.children.map(ledger => (
        <LedgerLine key={ledger.id} node={ledger} depth={1} onCreated={onCreated} onBankAdd={onBankAdd} />
      ))}

      {/* Extra auto rows (e.g. Duty & Tax) */}
      {extraRows}

      {/* Empty state hint */}
      {!hasChildren && (
        <p className="pl-6 py-1 text-[11px] text-muted-foreground/40 italic">No ledgers yet</p>
      )}

      {/* Inline add ledger */}
      <InlineAdd parentId={group.id!} parentType={(group.type ?? 'expense') as ALType} depth={1} onCreated={onCreated} />

      <div className="border-b border-border/20 mx-2 mt-1" />
    </div>
  );
}

/* ── auto row ────────────────────────────────────────────────────────────────── */
function AutoRow({ label, amount, sub, accent, depth = 0 }: {
  label: string; amount: number; sub?: string; accent?: string; depth?: number;
}) {
  const pl = `${8 + depth * 16}px`;
  return (
    <div className={`flex items-center gap-2 py-1.5 ${accent ?? ''}`} style={{ paddingLeft: pl }}>
      <span className={`flex-1 text-xs ${accent ? 'font-medium' : 'text-muted-foreground italic'}`}>{label}</span>
      {sub && <span className="text-[10px] text-muted-foreground/50 italic">{sub}</span>}
      <span className="text-[11px] font-mono tabular-nums text-muted-foreground pr-3">{fmt(amount)}</span>
    </div>
  );
}

/* ── stock breakdown ────────────────────────────────────────────────────────── */
function StockBlock({ label, items, total }: { label: string; items: StockItem[]; total: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-1">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 w-full py-2 px-2 hover:bg-muted/5 rounded transition-colors"
      >
        <Package className="w-3 h-3 text-muted-foreground/50 shrink-0" />
        <span className="flex-1 text-xs font-semibold text-foreground/80 text-left">{label}</span>
        {total > 0
          ? <span className="text-xs font-mono tabular-nums text-foreground/70">{fmt(total)}</span>
          : <span className="text-xs text-muted-foreground/40 italic">₹0.00</span>
        }
        {items.length > 0 && (open ? <ChevronDown className="w-3 h-3 text-muted-foreground/50" /> : <ChevronRight className="w-3 h-3 text-muted-foreground/50" />)}
      </button>

      {open && items.length > 0 && (
        <div className="pl-6 pb-1">
          {items.map(item => (
            <div key={item.id} className="flex items-center gap-2 py-1">
              <span className="w-1 h-1 rounded-full bg-muted-foreground/25 shrink-0" />
              <span className="flex-1 text-xs text-muted-foreground">{item.name}</span>
              <span className="text-[10px] text-muted-foreground/50 font-mono">
                {item.stock.toLocaleString('en-IN')} {item.unit} × {fmt(item.mrp)}
              </span>
              <span className="text-[11px] font-mono tabular-nums text-muted-foreground pr-3">{fmt(item.total)}</span>
            </div>
          ))}
        </div>
      )}

      {items.length === 0 && open && (
        <p className="pl-8 pb-2 text-[11px] text-muted-foreground/40 italic">No stock items found</p>
      )}
    </div>
  );
}

/* ── divider ─────────────────────────────────────────────────────────────────── */
const Divider = () => <div className="border-t border-border/30 my-2 mx-2" />;

/* ── section panel ───────────────────────────────────────────────────────────── */
function Panel({ title, icon: Icon, total, hdrClass, borderClass, children }: {
  title: string; icon: React.ElementType; total: number;
  hdrClass: string; borderClass: string; children: React.ReactNode;
}) {
  return (
    <div className={`bg-card border ${borderClass} rounded-xl overflow-hidden shadow-sm flex flex-col min-h-[340px]`}>
      {/* Header */}
      <div className={`flex items-center gap-2 px-4 py-3 ${hdrClass}`}>
        <Icon className="w-4 h-4 shrink-0" />
        <span className="flex-1 text-sm font-bold uppercase tracking-widest">{title}</span>
        <span className="text-sm font-mono font-bold tabular-nums">{fmt(total)}</span>
      </div>
      {/* Body */}
      <div className="flex-1 py-2">{children}</div>
    </div>
  );
}

/* ── period filter ───────────────────────────────────────────────────────────── */
const PERIODS = [
  { value: 'all', label: 'All' },
  { value: 'month', label: 'This Month' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'year', label: 'This Year' },
  { value: 'custom', label: 'Custom' },
];

/* ── main ─────────────────────────────────────────────────────────────────────── */
export default function ChartOfAccounts() {
  const [period, setPeriod]       = useState('all');
  const [customFrom, setFrom]     = useState('');
  const [customTo, setTo]         = useState('');
  const [outletId, setOutletId]   = useState('all');
  const [bankParent, setBankParent] = useState<{ id: number; type: ALType } | null>(null);
  const queryClient               = useQueryClient();

  const onBankAdd = (parentId: number, parentType: ALType) =>
    setBankParent({ id: parentId, type: parentType });

  const { fromDate, toDate } = useMemo(
    () => computeDateRange(period, customFrom, customTo),
    [period, customFrom, customTo],
  );

  const qKey = useMemo(() => ['fin-stmt', fromDate, toDate, outletId], [fromDate, toDate, outletId]);

  const { data: fs, isLoading, isError, error } = useQuery<FinancialStatements>({
    queryKey: qKey,
    queryFn: () => {
      const p = new URLSearchParams();
      if (fromDate) p.set('fromDate', fromDate);
      if (toDate)   p.set('toDate', toDate);
      if (outletId && outletId !== 'all') p.set('outletId', outletId);
      const qs = p.toString();
      return customFetch(`/api/accounts/financial-statements${qs ? `?${qs}` : ''}`, { method: 'GET' });
    },
    staleTime: 30_000,
  });

  const onCreated = () => queryClient.invalidateQueries({ queryKey: qKey });

  const bs  = fs?.balanceSheet;
  const pl  = fs?.profitAndLoss;
  const exp = fs?.profitAndLoss?.expenses;
  const inc = fs?.profitAndLoss?.incomes;
  const outlets = fs?.filters?.outlets ?? [];

  return (
    <AppLayout>
      <div className="space-y-5">

        {/* ── Header ── */}
        <div>
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <Landmark className="w-5 h-5 text-primary" /> Chart of Accounts
          </h1>
          <p className="text-muted-foreground mt-0.5 text-xs">
            Balance Sheet &amp; Profit &amp; Loss · All figures computed live from transactions
          </p>
        </div>

        {/* ── Filter bar ── */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 bg-muted/20 rounded-lg p-1">
            <CalendarDays className="w-3.5 h-3.5 text-muted-foreground ml-1 shrink-0" />
            {PERIODS.map(p => (
              <button key={p.value} onClick={() => setPeriod(p.value)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors
                  ${period === p.value ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
                {p.label}
              </button>
            ))}
          </div>
          {period === 'custom' && (
            <div className="flex items-center gap-1.5">
              <Input type="date" value={customFrom} onChange={e => setFrom(e.target.value)} className="h-8 text-xs w-36" />
              <span className="text-muted-foreground text-xs">to</span>
              <Input type="date" value={customTo} onChange={e => setTo(e.target.value)} className="h-8 text-xs w-36" />
            </div>
          )}
          {outlets.length > 0 && (
            <div className="flex items-center gap-1.5">
              <Store className="w-3.5 h-3.5 text-muted-foreground" />
              <Select value={outletId} onValueChange={setOutletId}>
                <SelectTrigger className="h-8 text-xs w-36"><SelectValue placeholder="All Outlets" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Outlets</SelectItem>
                  {outlets.map(o => <SelectItem key={o.id} value={String(o.id)}>{o.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        {/* ── Tabs ── */}
        {isLoading ? (
          <div className="py-16 text-center text-muted-foreground text-sm animate-pulse">Computing financial statements…</div>
        ) : isError ? (
          <div className="py-10 text-center space-y-2">
            <p className="text-red-400 text-sm font-medium">Failed to load financial statements</p>
            <p className="text-muted-foreground text-xs">{(error as any)?.message ?? 'Unknown error'}</p>
          </div>
        ) : (
          <Tabs defaultValue="balance_sheet">
            <TabsList className="grid w-full max-w-xs grid-cols-2">
              <TabsTrigger value="balance_sheet" className="gap-1.5 text-xs">
                <Landmark className="w-3.5 h-3.5" /> Balance Sheet
              </TabsTrigger>
              <TabsTrigger value="profit_loss" className="gap-1.5 text-xs">
                <BarChart3 className="w-3.5 h-3.5" /> Profit &amp; Loss
              </TabsTrigger>
            </TabsList>

            {/* ══════════════════ BALANCE SHEET ══════════════════ */}
            <TabsContent value="balance_sheet" className="mt-4">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

                {/* ── Liabilities ── */}
                <Panel
                  title="Liabilities" icon={TrendingDown}
                  total={bs?.liabilities.total ?? 0}
                  hdrClass="bg-red-500/10 text-red-400 border-b border-red-500/15"
                  borderClass="border-red-500/20"
                >
                  {bs && (
                    <>
                      {/* Capital Account */}
                      <GroupBlock group={bs.liabilities.capitalAccount} onCreated={onCreated} />

                      {/* Loans */}
                      <GroupBlock group={bs.liabilities.loans} onCreated={onCreated} />

                      {/* Current Liabilities */}
                      <GroupBlock
                        group={bs.liabilities.currentLiabilities}
                        onCreated={onCreated}
                        extraRows={
                          <AutoRow
                            label="Duty & Tax"
                            amount={bs.liabilities.currentLiabilities.dutyAndTax ?? 0}
                            sub="auto · GST collected on sales"
                            depth={1}
                          />
                        }
                      />

                      <Divider />

                      {/* P&L carry-forward */}
                      <div className={`flex items-center gap-2 py-2 px-3 mx-2 rounded-lg text-xs font-semibold
                        ${bs.liabilities.pandlCarryForward >= 0
                          ? 'bg-emerald-500/10 text-emerald-400'
                          : 'bg-red-500/10 text-red-400'}`}>
                        <span className="flex-1">
                          P&amp;L {bs.liabilities.pandlCarryForward >= 0 ? '(Net Profit)' : '(Net Loss)'}
                        </span>
                        <span className="font-mono tabular-nums">{fmt(Math.abs(bs.liabilities.pandlCarryForward))}</span>
                      </div>

                      {/* Difference */}
                      {Math.abs(bs.liabilities.difference) > 0.01 && (
                        <div className="flex items-center gap-2 py-2 px-3 mx-2 mt-1 rounded-lg text-xs font-semibold bg-amber-500/10 text-amber-400">
                          <span className="flex-1">Difference</span>
                          <span className="font-mono tabular-nums">{fmt(Math.abs(bs.liabilities.difference))}</span>
                        </div>
                      )}
                    </>
                  )}
                </Panel>

                {/* ── Assets ── */}
                <Panel
                  title="Assets" icon={TrendingUp}
                  total={bs?.assets.total ?? 0}
                  hdrClass="bg-emerald-500/10 text-emerald-400 border-b border-emerald-500/15"
                  borderClass="border-emerald-500/20"
                >
                  {bs && (
                    <>
                      <GroupBlock group={bs.assets.fixedAssets} onCreated={onCreated} onBankAdd={onBankAdd} />
                      <GroupBlock group={bs.assets.currentAssets} onCreated={onCreated} onBankAdd={onBankAdd} />
                    </>
                  )}
                </Panel>
              </div>
            </TabsContent>

            {/* ══════════════════ PROFIT & LOSS ══════════════════ */}
            <TabsContent value="profit_loss" className="mt-4">

              {/* Net P&L banner */}
              {pl && (
                <div className={`flex items-center gap-3 px-4 py-3 rounded-xl mb-4 text-sm font-semibold
                  ${pl.netProfit >= 0
                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                    : 'bg-red-500/10 text-red-400 border border-red-500/20'}`}>
                  {pl.netProfit >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                  <span>{pl.netProfit >= 0 ? 'Net Profit' : 'Net Loss'}</span>
                  <span className="font-mono text-base ml-auto">{fmt(Math.abs(pl.netProfit))}</span>
                </div>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

                {/* ── Expense (Debit) ── */}
                <Panel
                  title="Expense (Debit)" icon={TrendingDown}
                  total={exp?.total ?? 0}
                  hdrClass="bg-red-500/10 text-red-400 border-b border-red-500/15"
                  borderClass="border-red-500/20"
                >
                  {exp && (
                    <>
                      {/* Opening Stock */}
                      <StockBlock
                        label="Opening Stock"
                        items={exp.openingStockItems}
                        total={exp.openingStock}
                      />

                      {/* Purchase Account (auto) */}
                      <AutoRow label="Purchase Account" amount={exp.purchases} sub="auto · from purchase orders" />

                      <Divider />

                      {/* Direct Expenses */}
                      <GroupBlock group={exp.directExpenses} onCreated={onCreated} />

                      {/* Indirect Expenses */}
                      <GroupBlock group={exp.indirectExpenses} onCreated={onCreated} />
                    </>
                  )}
                </Panel>

                {/* ── Income (Credit) ── */}
                <Panel
                  title="Income (Credit)" icon={TrendingUp}
                  total={inc?.total ?? 0}
                  hdrClass="bg-emerald-500/10 text-emerald-400 border-b border-emerald-500/15"
                  borderClass="border-emerald-500/20"
                >
                  {inc && (
                    <>
                      {/* Sales Account (auto) */}
                      <AutoRow label="Sales Account" amount={inc.sales} sub="auto · from sales invoices" />

                      <Divider />

                      {/* Direct Incomes */}
                      <GroupBlock group={inc.directIncomes} onCreated={onCreated} />

                      {/* Closing Stock */}
                      <StockBlock
                        label="Closing Stock"
                        items={inc.closingStockItems}
                        total={inc.closingStock}
                      />

                      <Divider />

                      {/* Indirect Incomes */}
                      <GroupBlock group={inc.indirectIncomes} onCreated={onCreated} />
                    </>
                  )}
                </Panel>
              </div>
            </TabsContent>
          </Tabs>
        )}
      </div>

      {/* ── Bank details dialog ── */}
      {bankParent && (
        <BankLedgerDialog
          parentId={bankParent.id}
          parentType={bankParent.type}
          onCreated={() => { queryClient.invalidateQueries({ queryKey: qKey }); }}
          onClose={() => setBankParent(null)}
        />
      )}
    </AppLayout>
  );
}
