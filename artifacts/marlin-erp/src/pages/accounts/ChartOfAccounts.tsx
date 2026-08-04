import { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { customFetch } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CalendarDays, Store, TrendingDown, TrendingUp, Landmark, BarChart3, ChevronDown, ChevronRight, Package, Lock, Trash2, ScrollText, ArrowUpRight, ArrowDownLeft, ShieldOff, AlertTriangle, Settings2, FoldVertical, UnfoldVertical, Folder } from 'lucide-react';
import { toast } from 'sonner';
import { usePermission } from '@/lib/usePermission';
import { useLocationContext, locationFilterParams } from '@/lib/locationContext';
import { useIsLocationKindEnabled } from '@/lib/locationStructure';
import { useClearOutletSelection } from '@/lib/useFeatureFlags';

/* ── shared types & helpers live in chartCommon so the hierarchy view and the
 * statement views cannot drift apart on formatting or payload shape ────────── */
import {
  fmt, BalTag, naturalSide, useStatementExpansion, collectExpandableIds,
  type ALType, type StockItem, type LedgerNode, type GroupSummary,
  type FinancialStatements, type StatementTarget, type StatementExpansion,
} from './chartCommon';
import { ChartHierarchy } from './ChartHierarchy';

/* ── helpers ─────────────────────────────────────────────────────────────────── */
function computeDateRange(period: string, from: string, to: string) {
  const today = new Date();
  const iso = (d: Date) => d.toISOString().split('T')[0];
  if (period === 'month')   { const f = new Date(today.getFullYear(), today.getMonth(), 1);        return { fromDate: iso(f),  toDate: iso(today) }; }
  if (period === 'quarter') { const q = Math.floor(today.getMonth() / 3); const f = new Date(today.getFullYear(), q * 3, 1); return { fromDate: iso(f),  toDate: iso(today) }; }
  if (period === 'year')    { return { fromDate: `${today.getFullYear()}-04-01`, toDate: iso(today) }; }
  if (period === 'custom')  { return { fromDate: from || undefined, toDate: to || undefined }; }
  return { fromDate: undefined, toDate: undefined };
}

/* ── manual ledger creation retired ───────────────────────────────────────────
 * Ledgers are no longer created by hand — they are provisioned automatically
 * alongside their master record (customers, vendors, employees, locations,
 * standard chart accounts). The inline "Add ledger" / "Add sub-group" affordances
 * have been withdrawn; the backend enforces this with a 409. Once per group we
 * leave a short muted line so the absence reads as deliberate, not broken. */
function LedgerCreationRetiredNote({ depth = 1 }: { depth?: number }) {
  const pl = `${8 + depth * 16}px`;
  return (
    <p className="py-1.5 text-[11px] text-muted-foreground/40 italic" style={{ paddingLeft: pl }}>
      Ledgers are provisioned automatically with their master record.
    </p>
  );
}

/* ── ledger statement sheet ──────────────────────────────────────────────────── */
function LedgerStatementSheet({ ledgerNode, fromDate, toDate, onClose }: {
  ledgerNode: StatementTarget; fromDate?: string; toDate?: string; onClose: () => void;
}) {
  // Global location selector narrows the statement to that location's slice of
  // the books; the query key must carry the same params or a location change
  // would keep serving the cached slice.
  const { locationState } = useLocationContext();
  const locParams = locationFilterParams(locationState);
  const qs = new URLSearchParams();
  if (fromDate) qs.set('fromDate', fromDate);
  if (toDate)   qs.set('toDate', toDate);
  if (locParams.locationType) {
    qs.set('locationType', locParams.locationType);
    qs.set('locationId', String(locParams.locationId));
  }
  const q = qs.toString();

  const { data, isLoading } = useQuery<any>({
    queryKey: ['ledger-statement', ledgerNode.id, fromDate, toDate, locParams.locationType ?? null, locParams.locationId ?? null],
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
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
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
  /** Shared open/closed state for this statement — see useStatementExpansion(). */
  expansion: StatementExpansion;
  onBankAdd?: (parentId: number, parentType: ALType) => void;
  onDelete?: (id: number, name: string) => void;
  onRename?: (id: number, newName: string) => void;
  onViewStatement?: (node: LedgerNode) => void;
  onMove?: (nodeId: number, newParentId: number) => void;
  canAdd?: boolean; canEdit?: boolean; canDelete?: boolean;
};
function LedgerLine({ node, depth, onCreated, expansion, onBankAdd, onDelete, onRename, onViewStatement, onMove, canAdd, canEdit, canDelete }: LedgerLineProps) {
  const pl = `${8 + depth * 16}px`;
  const balance = Math.abs(node.balance);
  const isSystem = node.code != null;
  const canDrag = !isSystem;

  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState('');
  const [dropOver, setDropOver] = useState(false);

  // Only a node that really has accounts inside it is expandable — a chevron on
  // a leaf would be an affordance that does nothing.
  const hasChildren = node.children.length > 0;
  const subOpen = hasChildren && expansion.isOpen(node.id);

  const startRename = () => { if (isSystem || !canEdit) return; setRenameVal(node.name); setRenaming(true); };
  const submitRename = () => { const t = renameVal.trim(); setRenaming(false); if (!t || t === node.name) return; onRename?.(node.id, t); };

  const sharedProps: Omit<LedgerLineProps, 'node' | 'depth'> = { onCreated, expansion, onBankAdd, onDelete, onRename, onViewStatement, onMove, canAdd, canEdit, canDelete };

  // Drag-to-move is an edit; disable dragging entirely without edit rights.
  const allowDrag = canDrag && !!canEdit;

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
          draggable={allowDrag}
          onDragStart={allowDrag ? (e) => { e.stopPropagation(); e.dataTransfer.setData('text/plain', String(node.id)); e.dataTransfer.effectAllowed = 'move'; } : undefined}
          onDragOver={canEdit ? (e) => { e.preventDefault(); e.stopPropagation(); setDropOver(true); } : undefined}
          onDragLeave={canEdit ? (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropOver(false); } : undefined}
          onDrop={canEdit ? (e) => { e.preventDefault(); e.stopPropagation(); setDropOver(false); const id = Number(e.dataTransfer.getData('text/plain')); if (id && id !== node.id) onMove?.(id, node.id); } : undefined}
        >
          {hasChildren ? (
            <button
              onClick={() => expansion.toggle(node.id)}
              className="shrink-0 text-muted-foreground/50 hover:text-muted-foreground"
              aria-label={subOpen ? 'Collapse' : 'Expand'}
              aria-expanded={subOpen}
              data-testid={`stmt-toggle-${node.id}`}
            >
              {subOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            </button>
          ) : (
            <span className="w-3 shrink-0" />
          )}
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
              className={`flex-1 text-xs font-semibold select-none ${allowDrag ? 'cursor-grab' : 'cursor-default'} text-foreground/80`}
              onDoubleClick={startRename}
              title={allowDrag ? 'Drag to move · double-click to rename' : 'System sub-group'}
            >
              {node.name}
            </span>
          )}

          <BalTag balance={node.balance} natural={naturalSide(node.type)} />

          {!isSystem && canDelete && (
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
          </>
        )}
      </div>
    );
  }

  /* ── leaf ledger rendering ─────────────────────────────────────────────── */
  return (
    <div
      draggable={allowDrag}
      onDragStart={allowDrag ? (e) => { e.dataTransfer.setData('text/plain', String(node.id)); e.dataTransfer.effectAllowed = 'move'; } : undefined}
    >
      {/* Row */}
      <div className="flex items-center gap-1.5 py-1.5 pr-2 group" style={{ paddingLeft: pl }}>
        {/* A ledger can parent sub-ledgers; only then does it get a toggle. */}
        {hasChildren ? (
          <button
            onClick={() => expansion.toggle(node.id)}
            className="shrink-0 text-muted-foreground/50 hover:text-muted-foreground"
            aria-label={subOpen ? 'Collapse' : 'Expand'}
            aria-expanded={subOpen}
            data-testid={`stmt-toggle-${node.id}`}
          >
            {subOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </button>
        ) : (
          <span className="w-1 h-1 rounded-full bg-muted-foreground/25 shrink-0" />
        )}

        {renaming ? (
          <input autoFocus value={renameVal}
            onChange={e => setRenameVal(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') setRenaming(false); }}
            onBlur={submitRename}
            className="flex-1 text-xs bg-transparent border-b-2 border-primary outline-none pb-0.5 text-foreground"
          />
        ) : (
          <span
            className={`flex-1 text-xs select-none ${depth === 1 ? 'text-foreground font-medium' : 'text-muted-foreground'} ${allowDrag ? 'cursor-grab' : 'cursor-default'}`}
            onDoubleClick={startRename}
            title={isSystem ? 'System ledger — locked' : allowDrag ? 'Drag to move · double-click to rename' : node.name}
          >
            {node.name}
          </span>
        )}

        {node.locationName && (
          <span className="text-[9px] px-1 py-0.5 rounded bg-muted text-muted-foreground/60 font-medium shrink-0"
            title={`Owned by ${node.locationName}`}>
            {node.locationName}
          </span>
        )}

        {isSystem && (
          <span className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5 text-[9px] px-1 py-0.5 rounded bg-muted text-muted-foreground/50 font-medium uppercase tracking-wide shrink-0">
            <Lock className="w-2.5 h-2.5" /> system
          </span>
        )}

        <BalTag balance={node.balance} size="xs" natural={naturalSide(node.type)} />

        {node.children.length === 0 && (
          <button onClick={() => onViewStatement?.(node)}
            className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:text-primary text-muted-foreground/30 shrink-0"
            title="View ledger statement">
            <ScrollText className="w-3 h-3" />
          </button>
        )}

        {!isSystem && canDelete && (
          <button onClick={() => onDelete?.(node.id, node.name)}
            className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:text-red-400 text-muted-foreground/30 shrink-0"
            title="Delete ledger">
            <Trash2 className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* Sub-ledgers (existing recursive pattern) — hidden while collapsed.
          The parent row and its balance above stay on screen either way. */}
      {subOpen && node.children.map(c => (
        <LedgerLine key={c.id} node={c} depth={depth + 1} {...sharedProps} />
      ))}
    </div>
  );
}

/* ── group block ────────────────────────────────────────────────────────────── */
function GroupBlock({ group, onCreated, expansion, onBankAdd, onDelete, onRename, onViewStatement, onMove, canAdd, canEdit, canDelete }: {
  group: GroupSummary;
  onCreated: () => void;
  expansion: StatementExpansion;
  onBankAdd?: (parentId: number, parentType: ALType) => void;
  onDelete?: (id: number, name: string) => void;
  onRename?: (id: number, newName: string) => void;
  onViewStatement?: (node: LedgerNode) => void;
  onMove?: (nodeId: number, newParentId: number) => void;
  canAdd?: boolean; canEdit?: boolean; canDelete?: boolean;
}) {
  const [dropOver, setDropOver] = useState(false);
  const groupId = group.id;
  const hasChildren = group.children.length > 0;
  // Group heads are top level, so they stay on screen by default; what is inside
  // them starts closed. The head keeps showing group.total either way.
  const open = hasChildren && groupId != null && expansion.isOpen(groupId);
  if (!groupId) return null;

  return (
    <div className="mb-3">
      {/* Group label row — toggle + drop target for drag-and-drop */}
      <div
        className={`flex items-center gap-2 py-2 px-3 rounded-md mx-2 transition-colors select-none
          ${dropOver ? 'bg-blue-500/15 ring-1 ring-blue-500/30' : 'bg-muted/10'}`}
        onDragOver={canEdit ? (e) => { e.preventDefault(); setDropOver(true); } : undefined}
        onDragLeave={canEdit ? (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropOver(false); } : undefined}
        onDrop={canEdit ? (e) => { e.preventDefault(); setDropOver(false); const id = Number(e.dataTransfer.getData('text/plain')); if (id && groupId) onMove?.(id, groupId); } : undefined}
      >
        {hasChildren ? (
          <button
            onClick={() => expansion.toggle(groupId)}
            className="shrink-0 text-muted-foreground/60 hover:text-foreground"
            aria-label={open ? 'Collapse' : 'Expand'}
            aria-expanded={open}
            data-testid={`stmt-toggle-${groupId}`}
          >
            {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <span className="flex-1 text-xs font-bold text-foreground/70 uppercase tracking-wide">{group.name}</span>
        {dropOver
          ? <span className="text-[10px] text-blue-400 font-medium">Drop here</span>
          : <span className="text-xs font-mono font-semibold tabular-nums text-foreground/60">
              {group.total === 0 ? '—' : fmt(group.total)}
            </span>
        }
      </div>

      {/* Ledgers and sub-groups under this group */}
      {open && group.children.map(node => (
        <LedgerLine key={node.id} node={node} depth={1} onCreated={onCreated}
          expansion={expansion}
          onDelete={onDelete} onRename={onRename}
          onViewStatement={onViewStatement} onMove={onMove}
          canAdd={canAdd} canEdit={canEdit} canDelete={canDelete} />
      ))}

      {!hasChildren && (
        <p className="pl-6 py-1 text-[11px] text-muted-foreground/40 italic">No ledgers yet</p>
      )}

      {open && <LedgerCreationRetiredNote depth={1} />}

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
            <div key={`${item.materialType}:${item.id}`} className="flex items-center gap-2 py-1">
              <span className="w-1 h-1 rounded-full bg-muted-foreground/25 shrink-0" />
              <span className="flex-1 text-xs text-muted-foreground">{item.name}</span>
              <span className="text-[10px] text-muted-foreground/50 font-mono">
                {item.stock.toLocaleString('en-IN')} {item.unit} × {fmt(item.unitCost)}
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

/* ── statement toolbar ───────────────────────────────────────────────────────
 * Expand/Collapse act on the whole statement, and "Manage Chart of Accounts"
 * opens the one hierarchy editor rather than a second one — see ManageChartDialog.
 */
function StatementToolbar({ expansion, expandableIds, onManage, statement }: {
  expansion: StatementExpansion;
  expandableIds: number[];
  /** Omitted when the user lacks edit rights on page:/accounts/chart. */
  onManage?: () => void;
  statement: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 mb-3">
      <Button
        variant="ghost" size="sm" className="h-8 px-2 text-xs gap-1"
        onClick={() => expansion.expandAll(expandableIds)}
        disabled={expandableIds.length === 0}
        data-testid={`${statement}-expand-all`}
      >
        <UnfoldVertical className="w-3.5 h-3.5" /> Expand All
      </Button>
      <Button
        variant="ghost" size="sm" className="h-8 px-2 text-xs gap-1"
        onClick={expansion.collapseAll}
        data-testid={`${statement}-collapse-all`}
      >
        <FoldVertical className="w-3.5 h-3.5" /> Collapse All
      </Button>

      {onManage && (
        <Button
          variant="outline" size="sm" className="h-8 px-2.5 text-xs gap-1.5 ml-auto"
          onClick={onManage}
          data-testid={`${statement}-manage-chart`}
        >
          <Settings2 className="w-3.5 h-3.5" /> Manage Chart of Accounts
        </Button>
      )}
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
  const perm = usePermission('page:/accounts/chart');
  const [period, setPeriod]       = useState('all');
  const [customFrom, setFrom]     = useState('');
  const [customTo, setTo]         = useState('');
  const [outletId, setOutletId]   = useState('all');
  const [selectedLedger, setSelectedLedger] = useState<StatementTarget | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  // Same ids appear on both statements, so each keeps its own namespaced state.
  const bsExpansion               = useStatementExpansion('balance_sheet');
  const plExpansion               = useStatementExpansion('profit_loss');
  const queryClient               = useQueryClient();
  const outletsVisible            = useIsLocationKindEnabled('outlet');
  // Global location selector scopes the statements to that location's slice of
  // the books (the page's own outlet dropdown is a separate, legacy narrowing).
  const { locationState }         = useLocationContext();
  const locParams                 = locationFilterParams(locationState);
  // A filter still holding an outlet would keep scoping the statements after the
  // control to clear it disappears, quietly narrowing every figure on screen.
  useClearOutletSelection(outletId !== 'all', () => setOutletId('all'));

  const onViewStatement = (node: StatementTarget) => setSelectedLedger(node);

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

  const qKey = useMemo(
    () => ['fin-stmt', fromDate, toDate, outletId, locParams.locationType ?? null, locParams.locationId ?? null],
    [fromDate, toDate, outletId, locParams.locationType, locParams.locationId],
  );

  const { data: fs, isLoading, isError, error } = useQuery<FinancialStatements>({
    queryKey: qKey,
    queryFn: () => {
      const p = new URLSearchParams();
      if (fromDate) p.set('fromDate', fromDate);
      if (toDate)   p.set('toDate', toDate);
      if (outletId && outletId !== 'all') p.set('outletId', outletId);
      if (locParams.locationType) {
        p.set('locationType', locParams.locationType);
        p.set('locationId', String(locParams.locationId));
      }
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
  // The statements payload always carries every outlet, for historical reports.
  // This dropdown is a selector, so it offers them only while the module is on —
  // and the whole control disappears when the list comes back empty.
  const outlets = outletsVisible ? (fs?.filters?.outlets ?? []) : [];

  // "Expand All" needs the nodes that genuinely have children, taken from the
  // real children arrays of the groups each statement renders.
  const bsExpandable = useMemo(() => collectExpandableIds([
    bs?.liabilities.capitalAccount, bs?.liabilities.loans, bs?.liabilities.currentLiabilities,
    bs?.assets.fixedAssets, bs?.assets.currentAssets,
  ]), [bs]);
  const plExpandable = useMemo(() => collectExpandableIds([
    exp?.directExpenses, exp?.indirectExpenses,
    inc?.directIncomes, inc?.indirectIncomes,
  ]), [exp, inc]);

  // ── Trading + P&L presentation figures ──
  // Gross/Net Profit come from the SAME engine summary the dashboard tiles read
  // — displayed, never recomputed here. Panel totals are the standard two-side
  // sums; they tie to those figures by construction (tradingInc − tradingExp =
  // GP, plInc − plExp = NP). `sales`/`purchases` arrive net of returns; the
  // gross + "Less: Returns" rows only surface the split.
  const salesReturns    = inc?.salesReturns ?? 0;
  const grossSales      = inc?.grossSales ?? ((inc?.sales ?? 0) + salesReturns);
  const purchaseReturns = exp?.purchaseReturns ?? 0;
  const grossProfit     = pl ? (pl.summary?.grossProfit
    ?? ((inc ? inc.sales + inc.closingStock + inc.directIncomes.total : 0)
      - (exp ? exp.openingStock + exp.purchases + exp.directExpenses.total : 0))) : null;
  // Each Trading side includes the GP c/d balancing row (debit when profit,
  // credit when loss), so the two panel headers always show the SAME total —
  // that is what makes it a balanced two-sided account.
  const tradingExpBase  = exp ? exp.openingStock + exp.purchases + exp.directExpenses.total : 0;
  const tradingIncBase  = inc ? inc.sales + inc.closingStock + inc.directIncomes.total : 0;
  const tradingExpTotal = tradingExpBase + (grossProfit !== null && grossProfit > 0 ? grossProfit : 0);
  const tradingIncTotal = tradingIncBase + (grossProfit !== null && grossProfit < 0 ? -grossProfit : 0);
  const plExpTotal = (exp?.indirectExpenses.total ?? 0) + (grossProfit !== null && grossProfit < 0 ? -grossProfit : 0);
  const plIncTotal = (inc?.indirectIncomes.total ?? 0) + (grossProfit !== null && grossProfit > 0 ? grossProfit : 0);

  // Managing the chart mutates it, so it follows the same 'edit' gate other
  // pages use. The backend guards stay authoritative regardless.
  const canManageChart = perm.canEdit;

  if (!perm.isLoading && !perm.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center">
          <div className="w-16 h-16 rounded-2xl bg-destructive/10 flex items-center justify-center">
            <ShieldOff className="w-8 h-8 text-destructive" />
          </div>
          <div>
            <h2 className="text-xl font-bold">Access Denied</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              You don't have permission to view this page.<br />
              Contact your administrator to request access.
            </p>
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-5">

        {/* ── Header ── */}
        <div>
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <Landmark className="w-5 h-5 text-primary" /> Chart of Accounts
          </h1>
          <p className="text-muted-foreground mt-0.5 text-xs">
            Account hierarchy, Balance Sheet &amp; Profit &amp; Loss · All figures computed live from transactions
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
          <>
          {/* ── Integrity warning banner ──
              'difference' is no longer a plug figure — on healthy books it is ~0.
              Any non-zero difference or any reported integrity issue is a REAL
              defect (orphan ledgers, unbalanced opening balances, unmatched
              production-costing overlay, incomplete stock ledgers) and is surfaced
              here to investigate, never as an ordinary balance-sheet line. */}
          {fs?.integrity && (!fs.integrity.balanced || fs.integrity.issues.length > 0) && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 mb-4">
              <div className="flex items-center gap-2 text-amber-500 font-semibold text-sm">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>Books integrity check failed — investigate before relying on these statements</span>
              </div>
              {Math.abs(fs.integrity.difference) > 0.01 && (
                <p className="mt-1.5 text-xs text-amber-500/90">
                  Unexplained difference of <span className="font-mono font-semibold">{fmt(Math.abs(fs.integrity.difference))}</span>{' '}
                  — the balance sheet does not tie out. This is a defect, not a balancing figure.
                </p>
              )}
              {fs.integrity.issues.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs text-amber-600/90 dark:text-amber-300/90 list-disc pl-5">
                  {fs.integrity.issues.map((issue, i) => (
                    <li key={i}>{issue}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* The account hierarchy is no longer a tab — the two statements are the
              primary views, and the same ChartHierarchy editor opens over either
              of them via "Manage Chart of Accounts". */}
          <Tabs defaultValue="balance_sheet">
            <TabsList className="grid w-full max-w-md grid-cols-2">
              <TabsTrigger value="balance_sheet" className="gap-1.5 text-xs">
                <Landmark className="w-3.5 h-3.5" /> Balance Sheet
              </TabsTrigger>
              <TabsTrigger value="profit_loss" className="gap-1.5 text-xs">
                <BarChart3 className="w-3.5 h-3.5" /> Profit &amp; Loss
              </TabsTrigger>
            </TabsList>

            {/* ══════════════════ BALANCE SHEET ══════════════════ */}
            <TabsContent value="balance_sheet" className="mt-4">
              <StatementToolbar
                statement="balance-sheet"
                expansion={bsExpansion}
                expandableIds={bsExpandable}
                onManage={canManageChart ? () => setManageOpen(true) : undefined}
              />

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
                      <GroupBlock group={bs.liabilities.capitalAccount} onCreated={onCreated} expansion={bsExpansion} onDelete={onDelete} onRename={onRename} onViewStatement={onViewStatement} onMove={onMove} canAdd={perm.canAdd} canEdit={perm.canEdit} canDelete={perm.canDelete} />

                      {/* Loans */}
                      <GroupBlock group={bs.liabilities.loans} onCreated={onCreated} expansion={bsExpansion} onDelete={onDelete} onRename={onRename} onViewStatement={onViewStatement} onMove={onMove} canAdd={perm.canAdd} canEdit={perm.canEdit} canDelete={perm.canDelete} />

                      {/* Current Liabilities — STD-DTX (Duty & Tax) is already a child ledger with correct balance */}
                      <GroupBlock group={bs.liabilities.currentLiabilities} onCreated={onCreated} expansion={bsExpansion} onDelete={onDelete} onRename={onRename} onViewStatement={onViewStatement} onMove={onMove} canAdd={perm.canAdd} canEdit={perm.canEdit} canDelete={perm.canDelete} />

                      <Divider />

                      {/* Reserves & Surplus (P&L) — cumulative retained earnings
                          (all postings up to toDate), not just the period profit. */}
                      <div className={`flex items-center gap-2 py-2 px-3 mx-2 rounded-lg text-xs font-semibold
                        ${bs.liabilities.pandlCarryForward >= 0
                          ? 'bg-emerald-500/10 text-emerald-400'
                          : 'bg-red-500/10 text-red-400'}`}>
                        <span className="flex-1">Reserves &amp; Surplus (P&amp;L)</span>
                        <span className="font-mono tabular-nums">{fmt(Math.abs(bs.liabilities.pandlCarryForward))}</span>
                      </div>

                      {/* 'Difference' is intentionally NOT rendered as a balance-sheet
                          line anymore — a non-zero difference is a defect surfaced in
                          the integrity warning banner above, not a plug figure here. */}
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
                      <GroupBlock group={bs.assets.fixedAssets} onCreated={onCreated} expansion={bsExpansion} onDelete={onDelete} onRename={onRename} onViewStatement={onViewStatement} onMove={onMove} canAdd={perm.canAdd} canEdit={perm.canEdit} canDelete={perm.canDelete} />

                      {/* Closing Stock — a real asset line. Before this change closing
                          stock never appeared on the balance sheet, which is why a
                          plug 'Difference' was needed. It now shows explicitly. */}
                      <div className="flex items-center gap-2 py-2 px-3 mx-2 mb-2 rounded-lg text-xs font-semibold bg-emerald-500/5 text-foreground/80">
                        <span className="flex-1">Closing Stock</span>
                        <span className="font-mono tabular-nums text-foreground/70">
                          {bs.assets.closingStock === 0 ? '—' : fmt(bs.assets.closingStock)}
                        </span>
                      </div>

                      <GroupBlock group={bs.assets.currentAssets} onCreated={onCreated} expansion={bsExpansion} onDelete={onDelete} onRename={onRename} onViewStatement={onViewStatement} onMove={onMove} canAdd={perm.canAdd} canEdit={perm.canEdit} canDelete={perm.canDelete} />
                    </>
                  )}
                </Panel>
              </div>
            </TabsContent>

            {/* ══════════════════ PROFIT & LOSS ══════════════════
                Standard vertical order: Trading Account (Sales/Returns, Opening
                Stock, Purchases/Returns, Direct Expenses, Closing Stock) → Gross
                Profit banner → Profit & Loss Account (GP b/d, Other Income,
                Indirect Expenses) → Net Profit banner. GP/NP are the engine's
                own summary figures — identical to the dashboard tiles. */}
            <TabsContent value="profit_loss" className="mt-4">
              <StatementToolbar
                statement="profit-loss"
                expansion={plExpansion}
                expandableIds={plExpandable}
                onManage={canManageChart ? () => setManageOpen(true) : undefined}
              />

              {/* ── Trading Account ── */}
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Trading Account</span>
                <div className="flex-1 border-t border-border/30" />
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

                {/* ── Trading Expense (Debit) ── */}
                <Panel
                  title="Expense (Debit)" icon={TrendingDown}
                  total={tradingExpTotal}
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

                      {/* Purchase Account (auto) — gross + returns split shown only
                          when debit notes exist; `purchases` is already the net. */}
                      {purchaseReturns !== 0 ? (
                        <>
                          <AutoRow label="Purchase Account" amount={exp.purchases + purchaseReturns} sub="auto · from purchase orders" />
                          <AutoRow label="Less: Purchase Returns" amount={-purchaseReturns} sub="debit notes" />
                          <AutoRow label="Net Purchases" amount={exp.purchases} accent="text-foreground/80" />
                        </>
                      ) : (
                        <AutoRow label="Purchase Account" amount={exp.purchases} sub="auto · from purchase orders" />
                      )}

                      <Divider />

                      {/* Direct Expenses */}
                      <GroupBlock group={exp.directExpenses} onCreated={onCreated} expansion={plExpansion} onDelete={onDelete} onRename={onRename} onViewStatement={onViewStatement} onMove={onMove} canAdd={perm.canAdd} canEdit={perm.canEdit} canDelete={perm.canDelete} />

                      {/* Balancing transfer — makes both Trading sides equal */}
                      {grossProfit !== null && grossProfit > 0 && (
                        <>
                          <Divider />
                          <AutoRow label="Gross Profit c/d" amount={grossProfit} accent="text-emerald-500" sub="carried down to P&L" />
                        </>
                      )}
                    </>
                  )}
                </Panel>

                {/* ── Trading Income (Credit) ── */}
                <Panel
                  title="Income (Credit)" icon={TrendingUp}
                  total={tradingIncTotal}
                  hdrClass="bg-emerald-500/10 text-emerald-400 border-b border-emerald-500/15"
                  borderClass="border-emerald-500/20"
                >
                  {inc && (
                    <>
                      {/* Sales Account (auto) — gross + returns split shown only
                          when credit notes exist; `sales` is already the net. */}
                      {salesReturns !== 0 ? (
                        <>
                          <AutoRow label="Sales Account" amount={grossSales} sub="auto · from sales invoices" />
                          <AutoRow label="Less: Sales Returns" amount={-salesReturns} sub="credit notes" />
                          <AutoRow label="Net Sales" amount={inc.sales} accent="text-foreground/80" />
                        </>
                      ) : (
                        <AutoRow label="Sales Account" amount={inc.sales} sub="auto · from sales invoices" />
                      )}

                      <Divider />

                      {/* Direct Incomes */}
                      <GroupBlock group={inc.directIncomes} onCreated={onCreated} expansion={plExpansion} onDelete={onDelete} onRename={onRename} onViewStatement={onViewStatement} onMove={onMove} canAdd={perm.canAdd} canEdit={perm.canEdit} canDelete={perm.canDelete} />

                      {/* Closing Stock */}
                      <StockBlock
                        label="Closing Stock"
                        items={inc.closingStockItems}
                        total={inc.closingStock}
                      />

                      {/* Balancing transfer — makes both Trading sides equal */}
                      {grossProfit !== null && grossProfit < 0 && (
                        <>
                          <Divider />
                          <AutoRow label="Gross Loss c/d" amount={-grossProfit} accent="text-red-400" sub="carried down to P&L" />
                        </>
                      )}
                    </>
                  )}
                </Panel>
              </div>

              {/* ── Gross Profit banner — same highlighted style as Net Profit ── */}
              {pl && grossProfit !== null && (
                <div
                  data-testid="coa-gross-profit"
                  className={`flex items-center gap-3 px-4 py-3 rounded-xl my-4 text-sm font-semibold
                  ${grossProfit >= 0
                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                    : 'bg-red-500/10 text-red-400 border border-red-500/20'}`}>
                  {grossProfit >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                  <span>{grossProfit >= 0 ? 'Gross Profit' : 'Gross Loss'}</span>
                  <span className="text-[10px] font-normal opacity-70">Net Sales − Cost of Goods Sold · carried down</span>
                  <span className="font-mono text-base ml-auto">{fmt(Math.abs(grossProfit))}</span>
                </div>
              )}

              {/* ── Profit & Loss Account ── */}
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Profit &amp; Loss Account</span>
                <div className="flex-1 border-t border-border/30" />
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

                {/* ── P&L Expense (Debit) ── */}
                <Panel
                  title="Expense (Debit)" icon={TrendingDown}
                  total={plExpTotal}
                  hdrClass="bg-red-500/10 text-red-400 border-b border-red-500/15"
                  borderClass="border-red-500/20"
                >
                  {exp && (
                    <>
                      {grossProfit !== null && grossProfit < 0 && (
                        <>
                          <AutoRow label="Gross Loss b/d" amount={-grossProfit} accent="text-red-400" sub="from Trading Account" />
                          <Divider />
                        </>
                      )}
                      {/* Indirect Expenses */}
                      <GroupBlock group={exp.indirectExpenses} onCreated={onCreated} expansion={plExpansion} onDelete={onDelete} onRename={onRename} onViewStatement={onViewStatement} onMove={onMove} canAdd={perm.canAdd} canEdit={perm.canEdit} canDelete={perm.canDelete} />
                    </>
                  )}
                </Panel>

                {/* ── P&L Income (Credit) ── */}
                <Panel
                  title="Income (Credit)" icon={TrendingUp}
                  total={plIncTotal}
                  hdrClass="bg-emerald-500/10 text-emerald-400 border-b border-emerald-500/15"
                  borderClass="border-emerald-500/20"
                >
                  {inc && (
                    <>
                      {grossProfit !== null && grossProfit >= 0 && (
                        <>
                          <AutoRow label="Gross Profit b/d" amount={grossProfit} accent="text-emerald-500" sub="from Trading Account" />
                          <Divider />
                        </>
                      )}
                      {/* Indirect Incomes (Other Income) */}
                      <GroupBlock group={inc.indirectIncomes} onCreated={onCreated} expansion={plExpansion} onDelete={onDelete} onRename={onRename} onViewStatement={onViewStatement} onMove={onMove} canAdd={perm.canAdd} canEdit={perm.canEdit} canDelete={perm.canDelete} />
                    </>
                  )}
                </Panel>
              </div>

              {/* ── Net P&L banner — unchanged, closing the statement ── */}
              {pl && (
                <div
                  data-testid="coa-net-profit"
                  className={`flex items-center gap-3 px-4 py-3 rounded-xl mt-4 text-sm font-semibold
                  ${pl.netProfit >= 0
                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                    : 'bg-red-500/10 text-red-400 border border-red-500/20'}`}>
                  {pl.netProfit >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                  <span>{pl.netProfit >= 0 ? 'Net Profit' : 'Net Loss'}</span>
                  <span className="text-[10px] font-normal opacity-70">Gross {grossProfit !== null && grossProfit < 0 ? 'Loss' : 'Profit'} + Other Income − Indirect Expenses</span>
                  <span className="font-mono text-base ml-auto">{fmt(Math.abs(pl.netProfit))}</span>
                </div>
              )}
            </TabsContent>
          </Tabs>
          </>
        )}
      </div>

      {/* ── Manage Chart of Accounts ──
          The very same ChartHierarchy the Accounts tab used, moved into a large
          scrollable dialog. Every create / rename / activate / move / delete
          action, and the protections around them, still live inside it — nothing
          is reimplemented here. */}
      {canManageChart && (
        <Dialog open={manageOpen} onOpenChange={setManageOpen}>
          <DialogContent className="max-w-[95vw] xl:max-w-6xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="text-base flex items-center gap-2">
                <Folder className="w-4 h-4 text-primary" /> Manage Chart of Accounts
              </DialogTitle>
              <DialogDescription className="text-xs">
                Add, rename, move, deactivate or delete accounts. Balances shown here are the
                same live figures as the statements behind this dialog.
              </DialogDescription>
            </DialogHeader>

            <ChartHierarchy
              statements={fs}
              statementsLoading={isLoading}
              onViewStatement={(t) => { setManageOpen(false); onViewStatement(t); }}
              onStructureChanged={onCreated}
              perm={{ canAdd: perm.canAdd, canEdit: perm.canEdit, canDelete: perm.canDelete }}
            />
          </DialogContent>
        </Dialog>
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
