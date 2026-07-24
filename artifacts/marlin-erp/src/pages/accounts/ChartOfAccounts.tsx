import { useState, useMemo, useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCreateAccountLedger, customFetch } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Building2, CalendarDays, Store, TrendingDown, TrendingUp, Landmark, BarChart3, Plus, ChevronDown, ChevronRight, Package, Lock, Trash2, ScrollText, ArrowUpRight, ArrowDownLeft, FolderPlus, Folder } from 'lucide-react';
import { toast } from 'sonner';

/* ── types ──────────────────────────────────────────────────────────────────── */
type ALType = 'asset' | 'liability' | 'income' | 'expense' | 'equity';

interface StockItem { id: number; name: string; unit: string; stock: number; mrp: number; total: number }
interface LedgerNode { id: number; name: string; type: string; parentId: number | null; code: string | null; balance: number; isGroup?: boolean; children: LedgerNode[] }
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

/* ── inline add sub-group ────────────────────────────────────────────────────── */
function InlineAddGroup({ parentId, parentType, depth = 1, onCreated }: {
  parentId: number; parentType: ALType; depth?: number; onCreated: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);

  const submit = async () => {
    const t = name.trim();
    if (!t) { setEditing(false); setName(''); return; }
    setSaving(true);
    try {
      await customFetch('/api/accounts/chart', {
        method: 'POST',
        body: JSON.stringify({ name: t, type: parentType, parentId, isGroup: true }),
      });
      toast.success('Sub-group created');
      setEditing(false);
      setName('');
      onCreated();
    } catch (e: any) {
      toast.error(e?.data?.error || e?.message || 'Failed to create sub-group');
    } finally {
      setSaving(false);
    }
  };

  const pl = `${8 + depth * 16}px`;

  if (editing) {
    return (
      <div className="flex items-center gap-2 py-2" style={{ paddingLeft: pl }}>
        <FolderPlus className="w-3.5 h-3.5 text-violet-400 shrink-0" />
        <input
          ref={ref} value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') { setEditing(false); setName(''); } }}
          onBlur={submit}
          placeholder="Sub-group name…"
          disabled={saving}
          className="flex-1 text-sm bg-transparent border-b-2 border-violet-500 outline-none pb-0.5 text-foreground placeholder:text-muted-foreground/40"
        />
        {saving && <span className="text-[10px] text-muted-foreground">Saving…</span>}
      </div>
    );
  }

  return (
    <button
      onClick={() => setEditing(true)}
      style={{ paddingLeft: pl }}
      className="flex items-center gap-1.5 py-1.5 w-full text-xs text-violet-400/60 hover:text-violet-400 transition-colors font-medium"
    >
      <FolderPlus className="w-3.5 h-3.5" />
      Add sub-group
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

/* ── ledger statement sheet ──────────────────────────────────────────────────── */
function LedgerStatementSheet({ ledgerNode, fromDate, toDate, onClose }: {
  ledgerNode: LedgerNode; fromDate?: string; toDate?: string; onClose: () => void;
}) {
  const qs = new URLSearchParams();
  if (fromDate) qs.set('fromDate', fromDate);
  if (toDate)   qs.set('toDate', toDate);
  const q = qs.toString();

  const { data, isLoading } = useQuery<any>({
    queryKey: ['ledger-statement', ledgerNode.id, fromDate, toDate],
    queryFn: () => customFetch(`/api/accounts/ledger/${ledgerNode.id}/statement${q ? `?${q}` : ''}`),
    staleTime: 30_000,
  });

  const fmtAmt = (n: number) => n === 0 ? '—' : `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
  const fmtDate = (d: string) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

  return (
    <Sheet open onOpenChange={v => !v && onClose()}>
      <SheetContent className="sm:max-w-2xl overflow-y-auto">
        <SheetHeader className="pb-4">
          <SheetTitle className="flex items-center gap-2">
            <ScrollText className="w-4 h-4 text-primary" />
            {ledgerNode.name}
            {ledgerNode.code && <span className="text-xs font-mono text-muted-foreground">({ledgerNode.code})</span>}
          </SheetTitle>
          <p className="text-xs text-muted-foreground">
            Ledger Statement {fromDate || toDate ? `· ${fromDate ?? '…'} to ${toDate ?? '…'}` : '· All dates'}
          </p>
        </SheetHeader>

        {isLoading ? (
          <div className="space-y-2 mt-4">{[...Array(5)].map((_, i) => (
            <div key={i} className="h-8 bg-muted/30 rounded animate-pulse" />
          ))}</div>
        ) : !data || data.entries.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <ScrollText className="w-8 h-8 mx-auto mb-2 opacity-20" />
            <p className="text-sm">No entries for this ledger yet</p>
          </div>
        ) : (
          <div className="space-y-4 mt-2">
            {/* Summary cards */}
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-muted/20 rounded-lg p-3">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Total Debit</p>
                <p className="font-bold font-mono text-sm text-foreground mt-0.5">
                  ₹{Number(data.totalDebit).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                </p>
              </div>
              <div className="bg-muted/20 rounded-lg p-3">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Total Credit</p>
                <p className="font-bold font-mono text-sm text-foreground mt-0.5">
                  ₹{Number(data.totalCredit).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                </p>
              </div>
              <div className="bg-muted/20 rounded-lg p-3">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Closing Balance</p>
                <p className={`font-bold font-mono text-sm mt-0.5 ${data.closingBalance >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                  ₹{Math.abs(Number(data.closingBalance)).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  <span className="text-[10px] ml-0.5">{data.closingBalance >= 0 ? 'Dr' : 'Cr'}</span>
                </p>
              </div>
            </div>

            {/* Statement table */}
            <div className="rounded-lg border border-border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/10">
                    <TableHead className="text-xs">Date</TableHead>
                    <TableHead className="text-xs">Description</TableHead>
                    <TableHead className="text-xs">Ref</TableHead>
                    <TableHead className="text-right text-xs">Debit</TableHead>
                    <TableHead className="text-right text-xs">Credit</TableHead>
                    <TableHead className="text-right text-xs">Balance</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.entries.map((e: any, i: number) => (
                    <TableRow key={i} className="hover:bg-muted/10">
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{fmtDate(e.date)}</TableCell>
                      <TableCell className="text-xs max-w-[180px]">
                        <span className="flex items-center gap-1">
                          {e.debit > 0
                            ? <ArrowDownLeft className="w-3 h-3 text-primary/50 shrink-0" />
                            : <ArrowUpRight className="w-3 h-3 text-muted-foreground/50 shrink-0" />}
                          <span className="truncate">{e.description}</span>
                        </span>
                      </TableCell>
                      <TableCell className="text-xs font-mono text-muted-foreground">{e.reference}</TableCell>
                      <TableCell className="text-right text-xs font-mono">
                        {e.debit > 0 ? <span className="text-primary font-medium">{fmtAmt(e.debit)}</span> : <span className="text-muted-foreground/40">—</span>}
                      </TableCell>
                      <TableCell className="text-right text-xs font-mono">
                        {e.credit > 0 ? <span className="text-muted-foreground">{fmtAmt(e.credit)}</span> : <span className="text-muted-foreground/40">—</span>}
                      </TableCell>
                      <TableCell className="text-right text-xs font-mono font-semibold">
                        <span className={e.balance >= 0 ? 'text-foreground' : 'text-red-500'}>
                          {fmtAmt(Math.abs(e.balance))}<span className="text-[9px] ml-0.5 text-muted-foreground">{e.balance >= 0 ? 'Dr' : 'Cr'}</span>
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

/* ── ledger line (handles both leaf ledgers and user sub-groups) ─────────────── */
type LedgerLineProps = {
  node: LedgerNode; depth: number; onCreated: () => void;
  onBankAdd?: (parentId: number, parentType: ALType) => void;
  onDelete?: (id: number, name: string) => void;
  onRename?: (id: number, newName: string) => void;
  onViewStatement?: (node: LedgerNode) => void;
  onMove?: (nodeId: number, newParentId: number) => void;
};
function LedgerLine({ node, depth, onCreated, onBankAdd, onDelete, onRename, onViewStatement, onMove }: LedgerLineProps) {
  const pl = `${8 + depth * 16}px`;
  const balance = Math.abs(node.balance);
  const isBank = node.code === 'STD-BANK';
  const isSystem = node.code != null;
  const canDrag = !isSystem;

  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState('');
  const [dropOver, setDropOver] = useState(false);
  const [subOpen, setSubOpen] = useState(true);

  const startRename = () => { if (isSystem) return; setRenameVal(node.name); setRenaming(true); };
  const submitRename = () => { const t = renameVal.trim(); setRenaming(false); if (!t || t === node.name) return; onRename?.(node.id, t); };

  const sharedProps: Omit<LedgerLineProps, 'node' | 'depth'> = { onCreated, onBankAdd, onDelete, onRename, onViewStatement, onMove };

  /* ── sub-group rendering ────────────────────────────────────────────────── */
  if (node.isGroup) {
    return (
      <div>
        {/* Sub-group header row — draggable + drop target */}
        <div
          className={`flex items-center gap-1.5 py-1.5 pr-2 mx-2 my-0.5 rounded-md group transition-colors
            ${dropOver
              ? 'bg-violet-500/15 ring-1 ring-violet-500/40'
              : 'bg-muted/5 hover:bg-muted/10'}`}
          style={{ paddingLeft: pl }}
          draggable={canDrag}
          onDragStart={canDrag ? (e) => { e.stopPropagation(); e.dataTransfer.setData('text/plain', String(node.id)); e.dataTransfer.effectAllowed = 'move'; } : undefined}
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDropOver(true); }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropOver(false); }}
          onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setDropOver(false); const id = Number(e.dataTransfer.getData('text/plain')); if (id && id !== node.id) onMove?.(id, node.id); }}
        >
          <button onClick={() => setSubOpen(o => !o)} className="shrink-0 text-muted-foreground/50 hover:text-muted-foreground">
            {subOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </button>
          <Folder className="w-3.5 h-3.5 text-violet-400/80 shrink-0" />

          {renaming ? (
            <input autoFocus value={renameVal}
              onChange={e => setRenameVal(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') setRenaming(false); }}
              onBlur={submitRename}
              className="flex-1 text-xs bg-transparent border-b-2 border-violet-500 outline-none pb-0.5 text-foreground"
            />
          ) : (
            <span
              className={`flex-1 text-xs font-semibold select-none ${canDrag ? 'cursor-grab' : 'cursor-default'} text-foreground/80`}
              onDoubleClick={startRename}
              title={canDrag ? 'Drag to move · double-click to rename' : 'System sub-group'}
            >
              {node.name}
            </span>
          )}

          {balance > 0 && <span className="text-[11px] font-mono tabular-nums text-muted-foreground shrink-0">{fmt(balance)}</span>}

          {!isSystem && (
            <button onClick={() => onDelete?.(node.id, node.name)}
              className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:text-red-400 text-muted-foreground/30 shrink-0"
              title="Delete sub-group">
              <Trash2 className="w-3 h-3" />
            </button>
          )}
        </div>

        {/* Children of sub-group */}
        {subOpen && (
          <>
            {node.children.map(c => (
              <LedgerLine key={c.id} node={c} depth={depth + 1} {...sharedProps} />
            ))}
            <InlineAdd parentId={node.id} parentType={node.type as ALType} depth={depth + 1} onCreated={onCreated} />
            <InlineAddGroup parentId={node.id} parentType={node.type as ALType} depth={depth + 1} onCreated={onCreated} />
          </>
        )}
      </div>
    );
  }

  /* ── leaf ledger rendering ─────────────────────────────────────────────── */
  return (
    <div
      draggable={canDrag}
      onDragStart={canDrag ? (e) => { e.dataTransfer.setData('text/plain', String(node.id)); e.dataTransfer.effectAllowed = 'move'; } : undefined}
    >
      {/* Row */}
      <div className="flex items-center gap-1.5 py-1.5 pr-2 group" style={{ paddingLeft: pl }}>
        <span className="w-1 h-1 rounded-full bg-muted-foreground/25 shrink-0" />

        {renaming ? (
          <input autoFocus value={renameVal}
            onChange={e => setRenameVal(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') setRenaming(false); }}
            onBlur={submitRename}
            className="flex-1 text-xs bg-transparent border-b-2 border-primary outline-none pb-0.5 text-foreground"
          />
        ) : (
          <span
            className={`flex-1 text-xs select-none ${depth === 1 ? 'text-foreground font-medium' : 'text-muted-foreground'} ${canDrag ? 'cursor-grab' : 'cursor-default'}`}
            onDoubleClick={startRename}
            title={isSystem ? 'System ledger — locked' : 'Drag to move · double-click to rename'}
          >
            {node.name}
          </span>
        )}

        {isSystem && (
          <span className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5 text-[9px] px-1 py-0.5 rounded bg-muted text-muted-foreground/50 font-medium uppercase tracking-wide shrink-0">
            <Lock className="w-2.5 h-2.5" /> system
          </span>
        )}

        {balance > 0 && <span className="text-[11px] font-mono tabular-nums text-muted-foreground shrink-0">{fmt(balance)}</span>}

        {node.children.length === 0 && (
          <button onClick={() => onViewStatement?.(node)}
            className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:text-primary text-muted-foreground/30 shrink-0"
            title="View ledger statement">
            <ScrollText className="w-3 h-3" />
          </button>
        )}

        {!isSystem && (
          <button onClick={() => onDelete?.(node.id, node.name)}
            className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:text-red-400 text-muted-foreground/30 shrink-0"
            title="Delete ledger">
            <Trash2 className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* Sub-ledgers (existing recursive pattern) */}
      {node.children.map(c => (
        <LedgerLine key={c.id} node={c} depth={depth + 1} {...sharedProps} />
      ))}

      {/* Add sub-ledger at depth 1 */}
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
function GroupBlock({ group, onCreated, onBankAdd, onDelete, onRename, onViewStatement, onMove }: {
  group: GroupSummary;
  onCreated: () => void;
  onBankAdd?: (parentId: number, parentType: ALType) => void;
  onDelete?: (id: number, name: string) => void;
  onRename?: (id: number, newName: string) => void;
  onViewStatement?: (node: LedgerNode) => void;
  onMove?: (nodeId: number, newParentId: number) => void;
}) {
  if (!group.id) return null;
  const hasChildren = group.children.length > 0;
  const [dropOver, setDropOver] = useState(false);
  const pt = (group.type ?? 'expense') as ALType;

  return (
    <div className="mb-3">
      {/* Group label row — drop target for drag-and-drop */}
      <div
        className={`flex items-center gap-2 py-2 px-3 rounded-md mx-2 transition-colors select-none
          ${dropOver ? 'bg-blue-500/15 ring-1 ring-blue-500/30' : 'bg-muted/10'}`}
        onDragOver={(e) => { e.preventDefault(); setDropOver(true); }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropOver(false); }}
        onDrop={(e) => { e.preventDefault(); setDropOver(false); const id = Number(e.dataTransfer.getData('text/plain')); if (id && group.id) onMove?.(id, group.id); }}
      >
        <span className="flex-1 text-xs font-bold text-foreground/70 uppercase tracking-wide">{group.name}</span>
        {dropOver && <span className="text-[10px] text-blue-400 font-medium">Drop here</span>}
        {group.total > 0 && !dropOver && (
          <span className="text-xs font-mono font-semibold tabular-nums text-foreground/60">{fmt(group.total)}</span>
        )}
      </div>

      {/* Ledgers and sub-groups under this group */}
      {group.children.map(node => (
        <LedgerLine key={node.id} node={node} depth={1} onCreated={onCreated}
          onBankAdd={onBankAdd} onDelete={onDelete} onRename={onRename}
          onViewStatement={onViewStatement} onMove={onMove} />
      ))}

      {!hasChildren && (
        <p className="pl-6 py-1 text-[11px] text-muted-foreground/40 italic">No ledgers yet</p>
      )}

      <InlineAdd parentId={group.id!} parentType={pt} depth={1} onCreated={onCreated} />
      <InlineAddGroup parentId={group.id!} parentType={pt} depth={1} onCreated={onCreated} />

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
  const [bankParent, setBankParent]     = useState<{ id: number; type: ALType } | null>(null);
  const [selectedLedger, setSelectedLedger] = useState<LedgerNode | null>(null);
  const queryClient               = useQueryClient();

  const onViewStatement = (node: LedgerNode) => setSelectedLedger(node);

  const onBankAdd = (parentId: number, parentType: ALType) =>
    setBankParent({ id: parentId, type: parentType });

  const onRename = async (id: number, newName: string) => {
    try {
      await customFetch(`/api/accounts/chart/${id}`, { method: 'PATCH', body: JSON.stringify({ name: newName }) });
      toast.success('Ledger renamed');
      queryClient.invalidateQueries({ queryKey: qKey });
    } catch (e: any) {
      toast.error(e?.data?.error || e?.message || 'Could not rename ledger');
    }
  };

  const onDelete = async (id: number, name: string) => {
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return;
    try {
      await customFetch(`/api/accounts/chart/${id}`, { method: 'DELETE' });
      toast.success(`"${name}" deleted`);
      queryClient.invalidateQueries({ queryKey: qKey });
    } catch (e: any) {
      toast.error(e?.data?.error || e?.message || 'Could not delete');
    }
  };

  const onMove = async (nodeId: number, newParentId: number) => {
    try {
      await customFetch(`/api/accounts/chart/${nodeId}/move`, {
        method: 'PATCH',
        body: JSON.stringify({ parentId: newParentId }),
      });
      toast.success('Moved successfully');
      queryClient.invalidateQueries({ queryKey: qKey });
    } catch (e: any) {
      toast.error(e?.data?.error || e?.message || 'Could not move account');
    }
  };

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
                      <GroupBlock group={bs.liabilities.capitalAccount} onCreated={onCreated} onDelete={onDelete} onRename={onRename} onViewStatement={onViewStatement} onMove={onMove} />

                      {/* Loans */}
                      <GroupBlock group={bs.liabilities.loans} onCreated={onCreated} onDelete={onDelete} onRename={onRename} onViewStatement={onViewStatement} onMove={onMove} />

                      {/* Current Liabilities — STD-DTX (Duty & Tax) is already a child ledger with correct balance */}
                      <GroupBlock group={bs.liabilities.currentLiabilities} onCreated={onCreated} onDelete={onDelete} onRename={onRename} onViewStatement={onViewStatement} onMove={onMove} />

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
                      <GroupBlock group={bs.assets.fixedAssets} onCreated={onCreated} onBankAdd={onBankAdd} onDelete={onDelete} onRename={onRename} onViewStatement={onViewStatement} onMove={onMove} />
                      <GroupBlock group={bs.assets.currentAssets} onCreated={onCreated} onBankAdd={onBankAdd} onDelete={onDelete} onRename={onRename} onViewStatement={onViewStatement} onMove={onMove} />
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
                      <GroupBlock group={exp.directExpenses} onCreated={onCreated} onDelete={onDelete} onRename={onRename} onViewStatement={onViewStatement} onMove={onMove} />

                      {/* Indirect Expenses */}
                      <GroupBlock group={exp.indirectExpenses} onCreated={onCreated} onDelete={onDelete} onRename={onRename} onViewStatement={onViewStatement} onMove={onMove} />
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
                      <GroupBlock group={inc.directIncomes} onCreated={onCreated} onDelete={onDelete} onRename={onRename} onViewStatement={onViewStatement} onMove={onMove} />

                      {/* Closing Stock */}
                      <StockBlock
                        label="Closing Stock"
                        items={inc.closingStockItems}
                        total={inc.closingStock}
                      />

                      <Divider />

                      {/* Indirect Incomes */}
                      <GroupBlock group={inc.indirectIncomes} onCreated={onCreated} onDelete={onDelete} onRename={onRename} onViewStatement={onViewStatement} onMove={onMove} />
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

      {selectedLedger && (
        <LedgerStatementSheet
          ledgerNode={selectedLedger}
          fromDate={fromDate}
          toDate={toDate}
          onClose={() => setSelectedLedger(null)}
        />
      )}
    </AppLayout>
  );
}
