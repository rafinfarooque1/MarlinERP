import { useState, useMemo, useCallback, memo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { customFetch } from '@workspace/api-client-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  ChevronRight, ChevronDown, Folder, FolderOpen, Search, Plus, Pencil, Trash2,
  Eye, EyeOff, Lock, ScrollText, Settings2, X, FoldVertical, UnfoldVertical,
  Check, ShieldCheck, Info, CornerDownRight,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  fmt, BalTag, naturalSide,
  type FinancialStatements, type GroupSummary, type LedgerNode, type StatementTarget,
} from './chartCommon';

/* ── types ──────────────────────────────────────────────────────────────────── */

/** A node of `GET /accounts/chart` — structure and management flags, no balances. */
export interface ChartNode {
  id: number;
  name: string;
  type: string;
  parentId: number | null;
  code: string | null;
  section: string | null;
  isGroup: boolean;
  isSystemGroup: boolean;
  isActive: boolean;
  /** Postings and vouchers referencing this ledger. */
  transactionCount: number;
  childCount: number;
  canRename: boolean;
  /** Why delete is unavailable, straight from the route that would refuse it. */
  deleteBlockedReason: string | null;
  /**
   * True across the Cash / Bank Accounts subtrees: those ledgers mirror
   * Cash & Bank accounts, so add/move/deactivate live on that screen, not here.
   */
  moduleManaged?: boolean;
  children: ChartNode[];
}

/* ── section filters ────────────────────────────────────────────────────────── */
/**
 * Exactly five top-level filters, one per Balance-Sheet / P&L section. Each chip
 * selects whole group heads and the tree renders their entire subtree, so
 * filtering is descendant-inclusive: "Expenses" shows the complete Direct +
 * Indirect (and Purchases) expense hierarchy, "Assets" every asset descendant,
 * and so on. Detailed groups — Current Assets, Current Liabilities, Direct /
 * Indirect Expense — are NOT chips; they live inside the hierarchy where they
 * belong.
 *
 * Capital / Equity (SYS-CAP) is a balance-sheet section reported on the
 * liabilities side of the Balance Sheet (owner's funds are a claim on the
 * business), so it sits under "Liabilities" here rather than being dropped or
 * mis-filed under Income/Expenses.
 */
const SECTION_FILTERS: { key: string; label: string; codes?: string[] }[] = [
  { key: 'all',    label: 'All' },
  { key: 'assets', label: 'Assets',      codes: ['SYS-FIXD', 'SYS-CURA', 'SYS-OPSTOCK', 'SYS-CLSTOCK'] },
  { key: 'liab',   label: 'Liabilities', codes: ['SYS-CAP', 'SYS-LOAN', 'SYS-CURL'] },
  { key: 'inc',    label: 'Income',      codes: ['SYS-SAL', 'SYS-DIRINC', 'SYS-INDINC'] },
  { key: 'exp',    label: 'Expenses',    codes: ['SYS-PUR', 'SYS-DIREXP', 'SYS-INDEXP'] },
];

/** Statement order, so the hierarchy reads like the books rather than A–Z. */
const ROOT_ORDER = [
  'SYS-CAP', 'SYS-LOAN', 'SYS-CURL',
  'SYS-FIXD', 'SYS-CURA',
  'SYS-SAL', 'SYS-DIRINC', 'SYS-INDINC',
  'SYS-PUR', 'SYS-DIREXP', 'SYS-INDEXP',
  'SYS-OPSTOCK', 'SYS-CLSTOCK',
];

/** Left accent per group head — grouping cue only, never decoration. */
const ACCENT: Record<string, string> = {
  asset: 'border-l-emerald-500/60',
  income: 'border-l-emerald-500/60',
  liability: 'border-l-red-500/60',
  equity: 'border-l-red-500/60',
  expense: 'border-l-amber-500/60',
};

/* ── balances ───────────────────────────────────────────────────────────────── */
/**
 * Every ledger's balance, keyed by id, taken from the statements payload.
 *
 * The statement builder already rolls a group's balance up from its children, so
 * a parent's figure here is by construction the sum of the ledgers underneath
 * it — the hierarchy does not re-add anything and cannot disagree with the
 * Balance Sheet or the P&L.
 */
function balanceIndex(fs?: FinancialStatements): Map<number, number> {
  const m = new Map<number, number>();
  if (!fs) return m;
  const groups: (GroupSummary | undefined)[] = [
    fs.balanceSheet?.liabilities?.capitalAccount,
    fs.balanceSheet?.liabilities?.loans,
    fs.balanceSheet?.liabilities?.currentLiabilities,
    fs.balanceSheet?.assets?.fixedAssets,
    fs.balanceSheet?.assets?.currentAssets,
    fs.profitAndLoss?.expenses?.purchasesGroup,
    fs.profitAndLoss?.expenses?.directExpenses,
    fs.profitAndLoss?.expenses?.indirectExpenses,
    fs.profitAndLoss?.incomes?.salesGroup,
    fs.profitAndLoss?.incomes?.directIncomes,
    fs.profitAndLoss?.incomes?.indirectIncomes,
  ];
  const walk = (n: LedgerNode) => {
    m.set(n.id, n.balance ?? 0);
    n.children?.forEach(walk);
  };
  for (const g of groups) {
    if (!g) continue;
    if (g.id != null) m.set(g.id, g.total ?? 0);
    g.children?.forEach(walk);
  }
  return m;
}

/* ── flattening ─────────────────────────────────────────────────────────────── */
interface Row {
  node: ChartNode;
  depth: number;
  /**
   * A synthetic line for entries posted straight to `node` even though it has
   * accounts inside it — see flatten(). `amount` is that residue.
   */
  direct?: boolean;
  amount?: number;
}

/** ids matching the search, plus every ancestor needed to reach them. */
function searchScope(roots: ChartNode[], q: string) {
  const needle = q.trim().toLowerCase();
  if (!needle) return null;
  const visible = new Set<number>();
  const matched = new Set<number>();
  const openIds = new Set<number>();

  const walk = (node: ChartNode, ancestors: number[]): boolean => {
    const hit =
      node.name.toLowerCase().includes(needle) ||
      (node.code ?? '').toLowerCase().includes(needle);
    let anyChildHit = false;
    for (const c of node.children) if (walk(c, [...ancestors, node.id])) anyChildHit = true;

    if (hit || anyChildHit) {
      visible.add(node.id);
      for (const a of ancestors) { visible.add(a); openIds.add(a); }
      if (anyChildHit) openIds.add(node.id);
      if (hit) matched.add(node.id);
      return true;
    }
    return false;
  };
  roots.forEach((r) => walk(r, []));
  return { visible, matched, openIds };
}

/**
 * Only nodes that are actually on screen are materialised — a collapsed group
 * costs one row no matter how many ledgers it holds, so the chart stays flat in
 * cost as it grows.
 *
 * Some accounts are postable AND have accounts filed under them: "Cash" carries
 * entries made straight to it, from before per-location cash ledgers existed,
 * and also parents every location's cash account. Its balance is therefore not
 * the sum of its children, which reads as a broken total. Whenever the rows on
 * screen don't account for a parent's balance, the remainder is emitted as an
 * explicit "Direct entries" line — computed from the children actually
 * rendered, so what is displayed always adds up.
 */
function flatten(
  roots: ChartNode[],
  expanded: Set<number>,
  scope: ReturnType<typeof searchScope>,
  showInactive: boolean,
  balances: Map<number, number>,
): Row[] {
  const out: Row[] = [];
  const bal = (id: number) => balances.get(id) ?? 0;

  const walk = (node: ChartNode, depth: number): boolean => {
    if (scope && !scope.visible.has(node.id)) return false;
    if (!showInactive && !node.isActive && !node.isGroup && !node.isSystemGroup) return false;
    out.push({ node, depth });

    const isOpen = expanded.has(node.id) || (scope?.openIds.has(node.id) ?? false);
    if (isOpen && node.children.length > 0) {
      let shown = 0;
      for (const c of node.children) if (walk(c, depth + 1)) shown += bal(c.id);
      const own = bal(node.id) - shown;
      // While searching, the tree is deliberately partial, so a residue would be
      // an artefact of the filter rather than a fact about the books.
      if (!scope && Math.abs(own) > 0.005) out.push({ node, depth: depth + 1, direct: true, amount: own });
    }
    return true;
  };
  roots.forEach((r) => walk(r, 0));
  return out;
}

const collectIds = (nodes: ChartNode[], acc: Set<number> = new Set()) => {
  for (const n of nodes) {
    if (n.children.length > 0) { acc.add(n.id); collectIds(n.children, acc); }
  }
  return acc;
};

/* ── row ────────────────────────────────────────────────────────────────────── */
interface RowActions {
  onToggle: (id: number) => void;
  onViewStatement: (t: StatementTarget) => void;
  onAddChild: (parent: ChartNode) => void;
  onRename: (node: ChartNode) => void;
  onToggleActive: (node: ChartNode) => void;
  onDelete: (node: ChartNode) => void;
  onMove: (nodeId: number, parentId: number) => void;
}

const Highlight = ({ text, q }: { text: string; q: string }) => {
  const needle = q.trim();
  if (!needle) return <>{text}</>;
  const i = text.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="bg-amber-400/25 text-foreground rounded px-0.5">{text.slice(i, i + needle.length)}</mark>
      {text.slice(i + needle.length)}
    </>
  );
};

/** The residue line described in flatten() — informational, never actionable. */
function DirectRow({ row }: { row: Row }) {
  return (
    <div className="flex items-center gap-2 border-b border-border/25 border-l-2 border-l-transparent hover:bg-muted/10">
      <div className="flex items-center gap-1.5 min-w-0 flex-1 py-1.5" style={{ paddingLeft: 8 + row.depth * 18 }}>
        <span className="w-[18px] shrink-0" />
        <CornerDownRight className="w-3 h-3 text-muted-foreground/40 shrink-0 ml-0.5 mr-[3px]" />
        <span
          className="text-[11px] italic text-muted-foreground/80 truncate"
          title={`Entries posted straight to "${row.node.name}" rather than to one of the accounts inside it`}
        >
          Direct entries
        </span>
      </div>
      <div className="w-36 text-right pr-3 shrink-0">
        <BalTag balance={row.amount ?? 0} size="xs" natural={naturalSide(row.node.type)} />
      </div>
      <div className="w-[132px] shrink-0" />
    </div>
  );
}

const ChartRow = memo(function ChartRow({
  row, balance, expanded, manage, query, actions, renaming, onRenameSubmit, onRenameCancel, canDelete, canEdit, canAdd,
}: {
  row: Row; balance: number; expanded: boolean; manage: boolean; query: string;
  actions: RowActions; renaming: boolean;
  onRenameSubmit: (id: number, name: string) => void;
  onRenameCancel: () => void;
  canDelete: boolean; canEdit: boolean; canAdd: boolean;
}) {
  const { node, depth } = row;
  const isGroupish = node.isGroup || node.isSystemGroup;
  const hasKids = node.children.length > 0;
  const [draft, setDraft] = useState(node.name);

  const isRoot = depth === 0;
  const tone = isRoot
    ? 'bg-muted/40 hover:bg-muted/50'
    : depth === 1 && isGroupish
      ? 'bg-muted/[0.12] hover:bg-muted/25'
      : 'hover:bg-muted/20';
  const text = isRoot
    ? 'text-[13px] font-semibold tracking-tight'
    : isGroupish
      ? 'text-xs font-medium'
      : 'text-xs';

  return (
    <div
      className={`group/row flex items-center gap-2 border-b border-border/25 transition-colors ${tone}
        ${isRoot ? `border-l-2 ${ACCENT[node.type] ?? 'border-l-border'}` : 'border-l-2 border-l-transparent'}
        ${!node.isActive ? 'opacity-60' : ''}`}
      draggable={manage && canEdit && !node.isSystemGroup && !node.moduleManaged}
      onDragStart={(e) => { e.dataTransfer.setData('text/ledger-id', String(node.id)); e.dataTransfer.effectAllowed = 'move'; }}
      onDragOver={(e) => { if (manage && isGroupish) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } }}
      onDrop={(e) => {
        if (!manage || !isGroupish) return;
        e.preventDefault();
        const dragged = parseInt(e.dataTransfer.getData('text/ledger-id'), 10);
        if (Number.isFinite(dragged) && dragged !== node.id) actions.onMove(dragged, node.id);
      }}
      data-testid={`chart-row-${node.id}`}
    >
      {/* ── name ── */}
      <div className="flex items-center gap-1.5 min-w-0 flex-1 py-2" style={{ paddingLeft: 8 + depth * 18 }}>
        {hasKids ? (
          <button
            onClick={() => actions.onToggle(node.id)}
            className="p-0.5 rounded hover:bg-muted/60 text-muted-foreground shrink-0"
            aria-label={expanded ? 'Collapse' : 'Expand'}
            data-testid={`chart-toggle-${node.id}`}
          >
            {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
        ) : (
          <span className="w-[18px] shrink-0" />
        )}

        {isGroupish
          ? (expanded
              ? <FolderOpen className={`w-3.5 h-3.5 shrink-0 ${isRoot ? 'text-primary' : 'text-primary/60'}`} />
              : <Folder className={`w-3.5 h-3.5 shrink-0 ${isRoot ? 'text-primary' : 'text-primary/60'}`} />)
          : <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/30 shrink-0 ml-1 mr-[7px]" />}

        {renaming ? (
          <span className="flex items-center gap-1 min-w-0 flex-1">
            <Input
              autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onRenameSubmit(node.id, draft.trim());
                if (e.key === 'Escape') onRenameCancel();
              }}
              className="h-6 text-xs py-0 max-w-[260px]"
              data-testid={`chart-rename-input-${node.id}`}
            />
            <button onClick={() => onRenameSubmit(node.id, draft.trim())} className="p-1 rounded hover:bg-muted/60 text-emerald-500" aria-label="Save">
              <Check className="w-3.5 h-3.5" />
            </button>
            <button onClick={onRenameCancel} className="p-1 rounded hover:bg-muted/60 text-muted-foreground" aria-label="Cancel">
              <X className="w-3.5 h-3.5" />
            </button>
          </span>
        ) : (
          <span
            className={`truncate ${text} ${!node.isActive ? 'line-through' : ''}`}
            onDoubleClick={() => { if (manage && node.canRename && canEdit) actions.onRename(node); }}
            title={node.code ? `${node.name} · ${node.code}` : node.name}
          >
            <Highlight text={node.name} q={query} />
          </span>
        )}

        {node.isSystemGroup && (
          <span className="shrink-0" title="System group — protected">
            <ShieldCheck className="w-3 h-3 text-muted-foreground/40" />
          </span>
        )}
        {!node.isSystemGroup && node.code && (
          <span className="shrink-0" title={node.moduleManaged
            ? 'Managed from Accounts → Cash & Bank'
            : `Maintained by the system (${node.code})`}>
            <Lock className="w-3 h-3 text-muted-foreground/30" />
          </span>
        )}
        {node.moduleManaged && (
          <Badge variant="outline" className="h-4 px-1 text-[9px] font-normal text-muted-foreground shrink-0"
            title="Ledgers here mirror Cash & Bank accounts — manage them on that screen">
            Cash &amp; Bank
          </Badge>
        )}
        {!node.isActive && (
          <Badge variant="outline" className="h-4 px-1 text-[9px] font-normal text-muted-foreground shrink-0">Inactive</Badge>
        )}
        {isGroupish && hasKids && (
          <span className="text-[10px] text-muted-foreground/50 shrink-0 tabular-nums">
            {node.children.length}
          </span>
        )}
      </div>

      {/* ── balance ── */}
      <div className="w-36 text-right pr-3 shrink-0">
        <BalTag balance={balance} size={isRoot ? 'sm' : 'xs'} natural={naturalSide(node.type)} />
      </div>

      {/* ── actions ── */}
      <div className="w-[132px] shrink-0 flex items-center justify-end gap-0.5 pr-2">
        {!isGroupish && (
          <button
            onClick={() => actions.onViewStatement({ id: node.id, name: node.name, code: node.code })}
            className="p-1 rounded hover:bg-muted/60 text-muted-foreground opacity-0 group-hover/row:opacity-100 transition-opacity"
            title="View ledger statement"
            data-testid={`chart-statement-${node.id}`}
          >
            <ScrollText className="w-3.5 h-3.5" />
          </button>
        )}

        {manage && (
          <>
            {canAdd && (
              <button
                onClick={() => actions.onAddChild(node)}
                disabled={!!node.moduleManaged}
                className="p-1 rounded hover:bg-muted/60 text-muted-foreground hover:text-primary disabled:opacity-25 disabled:hover:bg-transparent"
                title={node.moduleManaged
                  ? 'Cash and bank ledgers are added from Accounts → Cash & Bank'
                  : isGroupish
                    ? 'Add a sub-group or ledger inside this group'
                    : 'Add a sub-ledger under this ledger'}
                data-testid={`chart-add-${node.id}`}
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            )}
            {canEdit && (
              <button
                onClick={() => actions.onRename(node)}
                disabled={!node.canRename}
                className="p-1 rounded hover:bg-muted/60 text-muted-foreground hover:text-foreground disabled:opacity-25 disabled:hover:bg-transparent"
                title={node.canRename ? 'Rename' : 'System accounts cannot be renamed'}
                data-testid={`chart-edit-${node.id}`}
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
            )}
            {canEdit && (
              <button
                onClick={() => actions.onToggleActive(node)}
                disabled={node.isSystemGroup || !!node.moduleManaged}
                className="p-1 rounded hover:bg-muted/60 text-muted-foreground hover:text-amber-500 disabled:opacity-25 disabled:hover:bg-transparent"
                title={node.isSystemGroup
                  ? 'System groups are always active'
                  : node.moduleManaged
                    ? 'Managed from Accounts → Cash & Bank'
                    : node.isActive ? 'Deactivate — keeps history, stops new entries' : 'Reactivate'}
                data-testid={`chart-active-${node.id}`}
              >
                {node.isActive ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            )}
            {canDelete && (
              <button
                onClick={() => actions.onDelete(node)}
                disabled={!!node.deleteBlockedReason}
                className="p-1 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-500 disabled:opacity-25 disabled:hover:bg-transparent"
                title={node.deleteBlockedReason ?? 'Delete'}
                data-testid={`chart-delete-${node.id}`}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
});

/* ── main ───────────────────────────────────────────────────────────────────── */
export function ChartHierarchy({
  statements, statementsLoading, onViewStatement, onStructureChanged, perm,
}: {
  statements?: FinancialStatements;
  statementsLoading: boolean;
  onViewStatement: (t: StatementTarget) => void;
  onStructureChanged: () => void;
  perm: { canAdd: boolean; canEdit: boolean; canDelete: boolean };
}) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [section, setSection] = useState('all');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [manage, setManage] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [addUnder, setAddUnder] = useState<ChartNode | null>(null);
  const [newName, setNewName] = useState('');
  // What kind of account the add dialog will create. When the parent is a group
  // the user picks group-vs-ledger; under a leaf ledger only a sub-ledger is
  // valid, so the choice is forced. The server re-validates the parent either
  // way — this is UX, not enforcement.
  const [newKind, setNewKind] = useState<'group' | 'ledger'>('group');

  const canManage = perm.canAdd || perm.canEdit || perm.canDelete;

  const { data: tree, isLoading, isError, error } = useQuery<ChartNode[]>({
    queryKey: ['chart-tree'],
    queryFn: () => customFetch('/api/accounts/chart'),
    staleTime: 30_000,
  });

  const balances = useMemo(() => balanceIndex(statements), [statements]);

  const roots = useMemo(() => {
    const all = tree ?? [];
    const wanted = SECTION_FILTERS.find((s) => s.key === section)?.codes;
    const picked = wanted ? all.filter((r) => r.code && wanted.includes(r.code)) : all;
    return [...picked].sort((a, b) => {
      const ia = ROOT_ORDER.indexOf(a.code ?? '');
      const ib = ROOT_ORDER.indexOf(b.code ?? '');
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.name.localeCompare(b.name);
    });
  }, [tree, section]);

  const scope = useMemo(() => searchScope(roots, query), [roots, query]);
  const rows = useMemo(
    () => flatten(roots, expanded, scope, showInactive, balances),
    [roots, expanded, scope, showInactive, balances],
  );

  const inactiveCount = useMemo(() => {
    let n = 0;
    const walk = (list: ChartNode[]) => list.forEach((x) => { if (!x.isActive) n++; walk(x.children); });
    walk(tree ?? []);
    return n;
  }, [tree]);

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['chart-tree'] });
    onStructureChanged();
  }, [queryClient, onStructureChanged]);

  const onToggle = useCallback((id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const expandAll = () => setExpanded(collectIds(roots));
  const collapseAll = () => setExpanded(new Set());

  const submitRename = async (id: number, name: string) => {
    if (!name || name.length < 2) { toast.error('Give the account a name of at least 2 characters'); return; }
    setRenamingId(null);
    try {
      await customFetch(`/api/accounts/chart/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
      toast.success('Renamed');
      refresh();
    } catch (e: any) {
      toast.error(e?.data?.error || e?.message || 'Could not rename');
    }
  };

  const toggleActive = async (node: ChartNode) => {
    const next = !node.isActive;
    if (!next && !window.confirm(
      `Deactivate "${node.name}"?\n\nIts history and every report stay exactly as they are — it simply stops being offered for new entries.`,
    )) return;
    try {
      await customFetch(`/api/accounts/chart/${node.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: next }) });
      toast.success(next ? `"${node.name}" reactivated` : `"${node.name}" deactivated`);
      refresh();
    } catch (e: any) {
      toast.error(e?.data?.error || e?.message || 'Could not update');
    }
  };

  const remove = async (node: ChartNode) => {
    if (node.deleteBlockedReason) { toast.error(node.deleteBlockedReason); return; }
    if (!window.confirm(`Delete "${node.name}"? This cannot be undone.`)) return;
    try {
      await customFetch(`/api/accounts/chart/${node.id}`, { method: 'DELETE' });
      toast.success(`"${node.name}" deleted`);
      refresh();
    } catch (e: any) {
      toast.error(e?.data?.error || e?.message || 'Could not delete');
    }
  };

  const move = async (nodeId: number, parentId: number) => {
    try {
      await customFetch(`/api/accounts/chart/${nodeId}/move`, { method: 'PATCH', body: JSON.stringify({ parentId }) });
      toast.success('Moved');
      setExpanded((prev) => new Set(prev).add(parentId));
      refresh();
    } catch (e: any) {
      toast.error(e?.data?.error || e?.message || 'Could not move');
    }
  };

  const createAccount = async () => {
    const name = newName.trim();
    if (!addUnder) return;
    const isGroup = newKind === 'group';
    const noun = isGroup ? 'group' : addUnder.isGroup || addUnder.isSystemGroup ? 'ledger' : 'sub-ledger';
    if (name.length < 2) { toast.error(`Give the ${noun} a name of at least 2 characters`); return; }
    try {
      await customFetch('/api/accounts/chart', {
        method: 'POST',
        body: JSON.stringify({ isGroup, name, parentId: addUnder.id }),
      });
      toast.success(`"${name}" added`);
      setExpanded((prev) => new Set(prev).add(addUnder.id));
      setAddUnder(null);
      setNewName('');
      refresh();
    } catch (e: any) {
      toast.error(e?.data?.error || e?.message || `Could not add the ${noun}`);
    }
  };

  const actions: RowActions = useMemo(() => ({
    onToggle,
    onViewStatement,
    onAddChild: (parent) => {
      setAddUnder(parent);
      setNewName('');
      // A leaf ledger can only take a sub-ledger; a group defaults to sub-group.
      setNewKind(parent.isGroup || parent.isSystemGroup ? 'group' : 'ledger');
    },
    onRename: (node) => setRenamingId(node.id),
    onToggleActive: toggleActive,
    onDelete: remove,
    onMove: move,
  }), [onToggle, onViewStatement]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-3">
      {/* ── toolbar ── */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-sm max-md:max-w-full">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search groups, ledgers, codes…"
            className="h-8 text-xs pl-8 pr-7"
            data-testid="chart-search"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={expandAll} className="h-8 px-2 text-xs gap-1" data-testid="chart-expand-all">
            <UnfoldVertical className="w-3.5 h-3.5" /> Expand
          </Button>
          <Button variant="ghost" size="sm" onClick={collapseAll} className="h-8 px-2 text-xs gap-1" data-testid="chart-collapse-all">
            <FoldVertical className="w-3.5 h-3.5" /> Collapse
          </Button>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {inactiveCount > 0 && (
            <Button
              variant={showInactive ? 'secondary' : 'ghost'} size="sm"
              onClick={() => setShowInactive((v) => !v)}
              className="h-8 px-2 text-xs gap-1.5"
              data-testid="chart-toggle-inactive"
            >
              {showInactive ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
              {inactiveCount} inactive
            </Button>
          )}
          {canManage && (
            <Button
              variant={manage ? 'default' : 'outline'} size="sm"
              onClick={() => { setManage((v) => !v); setRenamingId(null); }}
              className="h-8 text-xs gap-1.5"
              data-testid="chart-manage-toggle"
            >
              {manage ? <><Check className="w-3.5 h-3.5" /> Done</> : <><Settings2 className="w-3.5 h-3.5" /> Manage Chart of Accounts</>}
            </Button>
          )}
        </div>
      </div>

      {/* ── section chips ── */}
      <div className="flex flex-wrap items-center gap-1">
        {SECTION_FILTERS.map((s) => (
          <button
            key={s.key}
            onClick={() => setSection(s.key)}
            className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors
              ${section === s.key ? 'bg-primary text-primary-foreground shadow-sm' : 'bg-muted/25 text-muted-foreground hover:text-foreground hover:bg-muted/40'}`}
            data-testid={`chart-filter-${s.key}`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* ── management banner ── */}
      {manage && (
        <div className="rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 flex items-start gap-2">
          <Info className="w-3.5 h-3.5 text-primary mt-0.5 shrink-0" />
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            <span className="text-foreground font-medium">Structure mode.</span>{' '}
            Use <span className="text-foreground font-medium">+</span> to add a sub-group or ledger inside a group, or a sub-ledger under a ledger.
            You can also rename your own accounts, drag one into another group, or deactivate one you no longer use.
            System groups and ledgers, and any account that carries entries, are protected — hover a disabled action to see why.
            Ledgers for customers, vendors, employees and locations are still created automatically with their master record.
          </p>
        </div>
      )}

      {/* ── tree ── */}
      <div className="rounded-xl border border-border bg-card overflow-hidden shadow-sm">
        <div className="sticky top-0 z-10 flex items-center gap-2 px-2 py-2 bg-muted/60 backdrop-blur border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
          <span className="flex-1 pl-2">Account</span>
          <span className="w-36 text-right pr-3">Balance</span>
          <span className="w-[132px] pr-2 text-right">{manage ? 'Actions' : ''}</span>
        </div>

        {isLoading || statementsLoading ? (
          <div className="py-16 text-center text-muted-foreground text-sm animate-pulse">Loading the chart of accounts…</div>
        ) : isError ? (
          <div className="py-12 text-center space-y-1">
            <p className="text-red-400 text-sm font-medium">Could not load the chart of accounts</p>
            <p className="text-muted-foreground text-xs">{(error as any)?.message ?? 'Unknown error'}</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="py-16 text-center text-muted-foreground text-sm">
            {query ? <>Nothing matches “{query}”.</> : 'No accounts in this section.'}
          </div>
        ) : (
          rows.map((row) => row.direct ? (
            <DirectRow key={`direct-${row.node.id}`} row={row} />
          ) : (
            <ChartRow
              key={row.node.id}
              row={row}
              balance={balances.get(row.node.id) ?? 0}
              expanded={expanded.has(row.node.id) || (scope?.openIds.has(row.node.id) ?? false)}
              manage={manage}
              query={query}
              actions={actions}
              renaming={renamingId === row.node.id}
              onRenameSubmit={submitRename}
              onRenameCancel={() => setRenamingId(null)}
              canAdd={perm.canAdd}
              canEdit={perm.canEdit}
              canDelete={perm.canDelete}
            />
          ))
        )}
      </div>

      <p className="text-[11px] text-muted-foreground/70">
        {rows.length} row{rows.length === 1 ? '' : 's'} shown · balances are computed live from transactions, and every
        group equals the sum of the accounts inside it.
      </p>

      {/* ── add sub-group / ledger / sub-ledger ── */}
      <Dialog open={!!addUnder} onOpenChange={(v) => { if (!v) { setAddUnder(null); setNewName(''); } }}>
        <DialogContent className="sm:max-w-md">
          {(() => {
            const parentIsGroup = !!addUnder && (addUnder.isGroup || addUnder.isSystemGroup);
            const isGroup = newKind === 'group';
            const title = !parentIsGroup
              ? 'Add a sub-ledger'
              : isGroup ? 'Add a sub-group' : 'Add a ledger';
            return (
              <>
                <DialogHeader>
                  <DialogTitle className="text-base">{title}</DialogTitle>
                  <DialogDescription className="text-xs">
                    Inside <span className="text-foreground font-medium">{addUnder?.name}</span>.{' '}
                    {isGroup
                      ? 'A group holds other accounts and carries no entries of its own — its balance is always the total of what is inside it.'
                      : parentIsGroup
                        ? 'A ledger is a posting account: entries land on it directly and roll up into this group.'
                        : 'A sub-ledger is a posting account filed under this ledger — the same shape as a per-bank or per-till account.'}
                  </DialogDescription>
                </DialogHeader>

                {/* Only a group parent offers the group-vs-ledger choice; under a
                    ledger the only valid child is a sub-ledger. */}
                {parentIsGroup && (
                  <div className="flex items-center gap-1.5 rounded-md bg-muted/25 p-1">
                    <button
                      type="button"
                      onClick={() => setNewKind('group')}
                      className={`flex-1 px-2.5 py-1.5 rounded text-xs font-medium transition-colors
                        ${isGroup ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                      data-testid="chart-new-kind-group"
                    >
                      Sub-group
                    </button>
                    <button
                      type="button"
                      onClick={() => setNewKind('ledger')}
                      className={`flex-1 px-2.5 py-1.5 rounded text-xs font-medium transition-colors
                        ${!isGroup ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                      data-testid="chart-new-kind-ledger"
                    >
                      Ledger
                    </button>
                  </div>
                )}

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">
                    {isGroup ? 'Group name' : parentIsGroup ? 'Ledger name' : 'Sub-ledger name'}
                  </label>
                  <Input
                    autoFocus value={newName} onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') createAccount(); }}
                    placeholder={isGroup ? 'e.g. Utilities' : 'e.g. Electricity Charges'}
                    className="h-9 text-sm"
                    data-testid="chart-new-account-name"
                  />
                </div>

                <DialogFooter>
                  <Button variant="ghost" size="sm" onClick={() => { setAddUnder(null); setNewName(''); }}>Cancel</Button>
                  <Button size="sm" onClick={createAccount} data-testid="chart-new-account-save">
                    <Plus className="w-3.5 h-3.5 mr-1" /> {title.replace('Add a ', 'Add ').replace('Add an ', 'Add ')}
                  </Button>
                </DialogFooter>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export { fmt };
