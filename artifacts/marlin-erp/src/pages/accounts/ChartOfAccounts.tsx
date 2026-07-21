import { useState } from 'react';
import {
  useListChartOfAccounts, useCreateAccountLedger, getListChartOfAccountsQueryKey,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import {
  Plus, BookOpen, ChevronRight, ChevronDown, Trash2, Shield,
  Landmark, TrendingDown, TrendingUp, BarChart3,
} from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { customFetch } from '@workspace/api-client-react';

/* ── types ─────────────────────────────────────────────────────────────────── */
interface AccountNode {
  id: number;
  name: string;
  type: string;
  parentId: number | null;
  code: string | null;
  section: string | null;       // 'balance_sheet' | 'profit_loss' | null
  isSystemGroup: boolean;
  description: string | null;
  children: AccountNode[];
}

/* ── form schema ────────────────────────────────────────────────────────────── */
const schema = z.object({
  name: z.string().min(1, 'Name is required'),
  code: z.string().optional(),
  description: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

/* ── sub-ledger tree node ────────────────────────────────────────────────────── */
function LedgerNode({
  node,
  depth,
  onAdd,
  onDelete,
}: {
  node: AccountNode;
  depth: number;          // 1 = ledger, 2 = sub-ledger
  onAdd: (parent: AccountNode) => void;
  onDelete: (node: AccountNode) => void;
}) {
  const [open, setOpen] = useState(true);
  const hasChildren = node.children.length > 0;
  const canAddChild = depth < 2; // max depth: group → ledger → sub-ledger

  return (
    <div>
      <div
        className="flex items-center gap-1.5 py-1.5 px-2 rounded hover:bg-muted/10 group transition-colors"
        style={{ paddingLeft: `${8 + depth * 20}px` }}
      >
        <button
          onClick={() => setOpen(o => !o)}
          className="w-4 h-4 flex items-center justify-center shrink-0 text-muted-foreground"
        >
          {hasChildren
            ? (open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />)
            : <span className="w-2 h-2 rounded-full bg-muted-foreground/20 block mx-auto" />
          }
        </button>

        <span className={`flex-1 text-sm ${depth === 1 ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
          {node.name}
        </span>

        {node.code && (
          <span className="text-[10px] font-mono text-muted-foreground/50 hidden group-hover:inline">{node.code}</span>
        )}

        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {canAddChild && (
            <Button
              variant="ghost" size="icon"
              className="h-5 w-5 text-primary hover:text-primary hover:bg-primary/10"
              onClick={() => onAdd(node)}
              title={`Add sub-ledger under ${node.name}`}
            >
              <Plus className="w-3 h-3" />
            </Button>
          )}
          <Button
            variant="ghost" size="icon"
            className="h-5 w-5 text-destructive hover:text-destructive hover:bg-destructive/10"
            onClick={() => onDelete(node)}
            title="Delete"
          >
            <Trash2 className="w-3 h-3" />
          </Button>
        </div>
      </div>

      {open && hasChildren && (
        <div>
          {node.children.map(child => (
            <LedgerNode key={child.id} node={child} depth={depth + 1} onAdd={onAdd} onDelete={onDelete} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── system group card ──────────────────────────────────────────────────────── */
function GroupCard({
  node,
  accentClass,
  onAddLedger,
  onDelete,
}: {
  node: AccountNode;
  accentClass: string;
  onAddLedger: (parent: AccountNode) => void;
  onDelete: (node: AccountNode) => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div className="rounded-lg border border-border overflow-hidden mb-3">
      {/* Group header */}
      <div
        className={`flex items-center gap-2 px-3 py-2.5 cursor-pointer select-none ${accentClass}`}
        onClick={() => setOpen(o => !o)}
      >
        <span className="w-4 h-4 flex items-center justify-center shrink-0 text-inherit">
          {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </span>
        <Shield className="w-3.5 h-3.5 opacity-60 shrink-0" />
        <span className="flex-1 text-sm font-semibold tracking-wide">{node.name}</span>
        <span className="text-[10px] opacity-50 font-mono">{node.code}</span>
        <Button
          variant="ghost" size="sm"
          className="h-6 px-2 text-xs opacity-80 hover:opacity-100 ml-2"
          onClick={e => { e.stopPropagation(); onAddLedger(node); }}
        >
          <Plus className="w-3 h-3 mr-1" /> Add Ledger
        </Button>
      </div>

      {/* Ledgers */}
      {open && (
        <div className="bg-card">
          {node.children.length === 0 ? (
            <div className="text-xs text-muted-foreground/50 px-8 py-2.5 italic">No ledgers yet</div>
          ) : (
            <div className="py-1">
              {node.children.map(ledger => (
                <LedgerNode key={ledger.id} node={ledger} depth={1} onAdd={onAddLedger} onDelete={onDelete} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── main page ──────────────────────────────────────────────────────────────── */
export default function ChartOfAccounts() {
  const { data: rawTree = [], isLoading } = useListChartOfAccounts();
  const tree = rawTree as unknown as AccountNode[];

  const [isOpen, setIsOpen] = useState(false);
  const [parentCtx, setParentCtx] = useState<AccountNode | null>(null);
  const queryClient = useQueryClient();
  const createMutation = useCreateAccountLedger();

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      customFetch(`/accounts/chart/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Account deleted');
      queryClient.invalidateQueries({ queryKey: getListChartOfAccountsQueryKey() });
    },
    onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed to delete'),
  });

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', code: '', description: '' },
  });

  /* Walk up tree to find root type */
  const resolveRootType = (node: AccountNode): string => {
    if (!node.parentId) return node.type;
    const findById = (nodes: AccountNode[], id: number): AccountNode | undefined => {
      for (const n of nodes) {
        if (n.id === id) return n;
        const found = findById(n.children, id);
        if (found) return found;
      }
    };
    const parent = findById(tree, node.parentId);
    return parent ? resolveRootType(parent) : node.type;
  };

  const openAdd = (parent: AccountNode) => {
    setParentCtx(parent);
    form.reset({ name: '', code: '', description: '' });
    setIsOpen(true);
  };

  const onSubmit = (data: FormValues) => {
    if (!parentCtx) return;
    const payload: any = {
      name: data.name,
      type: resolveRootType(parentCtx),
      description: data.description || undefined,
      parentId: parentCtx.id,
    };
    if (data.code) payload.code = data.code;
    createMutation.mutate({ data: payload }, {
      onSuccess: () => {
        toast.success('Account created');
        queryClient.invalidateQueries({ queryKey: getListChartOfAccountsQueryKey() });
        setIsOpen(false);
      },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  const handleDelete = (node: AccountNode) => {
    if (!confirm(`Delete "${node.name}"? This cannot be undone.`)) return;
    deleteMutation.mutate(node.id);
  };

  /* ── split tree ──────────────────────────────────────────────────────────── */
  const systemGroups = tree.filter(n => n.isSystemGroup);
  const otherRoots   = tree.filter(n => !n.isSystemGroup && n.parentId === null);

  const bsLiabilities = systemGroups.filter(n => n.section === 'balance_sheet' && (n.type === 'equity' || n.type === 'liability'));
  const bsAssets      = systemGroups.filter(n => n.section === 'balance_sheet' && n.type === 'asset');
  const plExpenses    = systemGroups.filter(n => n.section === 'profit_loss' && n.type === 'expense');
  const plIncomes     = systemGroups.filter(n => n.section === 'profit_loss' && n.type === 'income');

  /* ── accent colours per group ─────────────────────────────────────────────── */
  const groupAccent = (code: string | null): string => {
    switch (code) {
      case 'SYS-CAP':    return 'bg-violet-500/10 text-violet-400 border-b border-violet-500/20';
      case 'SYS-LOAN':   return 'bg-red-500/10 text-red-400 border-b border-red-500/20';
      case 'SYS-CURL':   return 'bg-orange-500/10 text-orange-400 border-b border-orange-500/20';
      case 'SYS-FIXD':   return 'bg-emerald-500/10 text-emerald-400 border-b border-emerald-500/20';
      case 'SYS-CURA':   return 'bg-teal-500/10 text-teal-400 border-b border-teal-500/20';
      case 'SYS-PUR':    return 'bg-red-500/10 text-red-400 border-b border-red-500/20';
      case 'SYS-DIREXP': return 'bg-orange-500/10 text-orange-400 border-b border-orange-500/20';
      case 'SYS-INDEXP': return 'bg-amber-500/10 text-amber-400 border-b border-amber-500/20';
      case 'SYS-SAL':    return 'bg-emerald-500/10 text-emerald-400 border-b border-emerald-500/20';
      case 'SYS-DIRINC': return 'bg-teal-500/10 text-teal-400 border-b border-teal-500/20';
      case 'SYS-INDINC': return 'bg-blue-500/10 text-blue-400 border-b border-blue-500/20';
      default:           return 'bg-muted/30 text-foreground border-b border-border';
    }
  };

  /* ── section header ────────────────────────────────────────────────────────── */
  const SideHeader = ({ label, icon: Icon, className }: { label: string; icon: React.ElementType; className: string }) => (
    <div className={`flex items-center gap-2 px-4 py-2 border-b border-border text-xs font-semibold uppercase tracking-widest ${className}`}>
      <Icon className="w-3.5 h-3.5" />
      {label}
    </div>
  );

  return (
    <AppLayout>
      <div className="space-y-6">
        {/* Page title */}
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <BookOpen className="w-6 h-6 text-primary" /> Chart of Accounts
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Tally-style account heads · Create ledgers and sub-ledgers under each group
          </p>
        </div>

        {isLoading ? (
          <div className="p-12 text-center text-muted-foreground">Loading accounts…</div>
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

            {/* ── Balance Sheet Tab ───────────────────────────────────────────── */}
            <TabsContent value="balance_sheet" className="mt-0">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Liabilities column */}
                <div className="bg-card border border-border rounded-xl overflow-hidden shadow-sm">
                  <SideHeader label="Liabilities" icon={TrendingDown} className="text-red-400 bg-red-500/5" />
                  <div className="p-3">
                    {bsLiabilities.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-6">No liability groups found</p>
                    ) : bsLiabilities.map(g => (
                      <GroupCard key={g.id} node={g} accentClass={groupAccent(g.code)} onAddLedger={openAdd} onDelete={handleDelete} />
                    ))}
                  </div>
                </div>

                {/* Assets column */}
                <div className="bg-card border border-border rounded-xl overflow-hidden shadow-sm">
                  <SideHeader label="Assets" icon={TrendingUp} className="text-emerald-400 bg-emerald-500/5" />
                  <div className="p-3">
                    {bsAssets.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-6">No asset groups found</p>
                    ) : bsAssets.map(g => (
                      <GroupCard key={g.id} node={g} accentClass={groupAccent(g.code)} onAddLedger={openAdd} onDelete={handleDelete} />
                    ))}
                  </div>
                </div>
              </div>

              {/* Legacy / other root accounts */}
              {otherRoots.filter(n => n.type === 'asset' || n.type === 'liability' || n.type === 'equity').length > 0 && (
                <div className="mt-4 bg-muted/5 border border-dashed border-border rounded-xl p-4">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Other / Unclassified Accounts</p>
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
                    {otherRoots
                      .filter(n => n.type === 'asset' || n.type === 'liability' || n.type === 'equity')
                      .map(g => (
                        <GroupCard key={g.id} node={g} accentClass="bg-muted/20 text-muted-foreground border-b border-border" onAddLedger={openAdd} onDelete={handleDelete} />
                      ))}
                  </div>
                </div>
              )}
            </TabsContent>

            {/* ── P&L Tab ────────────────────────────────────────────────────── */}
            <TabsContent value="profit_loss" className="mt-0">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Expenses / Debit column */}
                <div className="bg-card border border-border rounded-xl overflow-hidden shadow-sm">
                  <SideHeader label="Expenses (Debit)" icon={TrendingDown} className="text-red-400 bg-red-500/5" />
                  <div className="p-3">
                    {plExpenses.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-6">No expense groups found</p>
                    ) : plExpenses.map(g => (
                      <GroupCard key={g.id} node={g} accentClass={groupAccent(g.code)} onAddLedger={openAdd} onDelete={handleDelete} />
                    ))}
                  </div>
                </div>

                {/* Incomes / Credit column */}
                <div className="bg-card border border-border rounded-xl overflow-hidden shadow-sm">
                  <SideHeader label="Incomes (Credit)" icon={TrendingUp} className="text-emerald-400 bg-emerald-500/5" />
                  <div className="p-3">
                    {plIncomes.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-6">No income groups found</p>
                    ) : plIncomes.map(g => (
                      <GroupCard key={g.id} node={g} accentClass={groupAccent(g.code)} onAddLedger={openAdd} onDelete={handleDelete} />
                    ))}
                  </div>
                </div>
              </div>

              {/* Legacy / other root accounts for P&L */}
              {otherRoots.filter(n => n.type === 'income' || n.type === 'expense').length > 0 && (
                <div className="mt-4 bg-muted/5 border border-dashed border-border rounded-xl p-4">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Other / Unclassified Accounts</p>
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
                    {otherRoots
                      .filter(n => n.type === 'income' || n.type === 'expense')
                      .map(g => (
                        <GroupCard key={g.id} node={g} accentClass="bg-muted/20 text-muted-foreground border-b border-border" onAddLedger={openAdd} onDelete={handleDelete} />
                      ))}
                  </div>
                </div>
              )}
            </TabsContent>
          </Tabs>
        )}
      </div>

      {/* ── Create Ledger / Sub-Ledger Dialog ────────────────────────────────── */}
      <Dialog open={isOpen} onOpenChange={v => { setIsOpen(v); if (!v) setParentCtx(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {parentCtx?.isSystemGroup
                ? `Add Ledger under "${parentCtx?.name}"`
                : `Add Sub-Ledger under "${parentCtx?.name}"`}
            </DialogTitle>
          </DialogHeader>

          {parentCtx && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-muted/20 text-xs text-muted-foreground mb-1">
              <Shield className="w-3 h-3 shrink-0" />
              <span>
                Type <strong className="capitalize text-foreground">{resolveRootType(parentCtx)}</strong> is inherited from the parent group
              </span>
            </div>
          )}

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-1">
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem>
                  <FormLabel>Name <span className="text-destructive">*</span></FormLabel>
                  <FormControl>
                    <Input placeholder={parentCtx?.isSystemGroup ? 'e.g. Cash in Hand' : 'e.g. Petty Cash'} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />

              <FormField control={form.control} name="code" render={({ field }) => (
                <FormItem>
                  <FormLabel>Code <span className="text-muted-foreground text-xs">(optional)</span></FormLabel>
                  <FormControl>
                    <Input className="font-mono" placeholder="e.g. CASH-01" {...field} />
                  </FormControl>
                </FormItem>
              )} />

              <FormField control={form.control} name="description" render={({ field }) => (
                <FormItem>
                  <FormLabel>Description <span className="text-muted-foreground text-xs">(optional)</span></FormLabel>
                  <FormControl><Textarea rows={2} placeholder="Short description…" {...field} /></FormControl>
                </FormItem>
              )} />

              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => setIsOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createMutation.isPending}>
                  {createMutation.isPending ? 'Creating…' : 'Create'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
