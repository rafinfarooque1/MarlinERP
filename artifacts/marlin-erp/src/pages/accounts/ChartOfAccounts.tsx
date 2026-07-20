import { useState } from 'react';
import {
  useListChartOfAccounts, useCreateAccountLedger, getListChartOfAccountsQueryKey,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Plus, BookOpen, ChevronRight, ChevronDown, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';

const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
const TYPE_COLORS: Record<string, string> = {
  asset: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
  liability: 'bg-red-500/10 text-red-500 border-red-500/20',
  equity: 'bg-primary/10 text-primary border-primary/20',
  income: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
  expense: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
};

const schema = z.object({
  name: z.string().min(1, 'Name required'),
  code: z.string().optional(),
  type: z.enum(ACCOUNT_TYPES),
  parentId: z.number().optional(),
  description: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

function AccountNode({ node, depth, onAddChild }: { node: any; depth: number; onAddChild: (parent: any) => void }) {
  const [open, setOpen] = useState(depth === 0);
  const hasChildren = node.children && node.children.length > 0;

  return (
    <div>
      <div
        className={`flex items-center gap-2 px-3 py-2 hover:bg-muted/10 rounded-md group transition-colors ${depth === 0 ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}
        style={{ paddingLeft: `${12 + depth * 24}px` }}
      >
        <button
          onClick={() => setOpen(o => !o)}
          className="w-5 h-5 flex items-center justify-center shrink-0 text-muted-foreground"
        >
          {hasChildren
            ? (open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />)
            : <span className="w-3.5 h-3.5 border-l-2 border-b-2 border-muted-foreground/20 rounded-bl-sm ml-1 mt-1 block" />
          }
        </button>

        <span className="flex-1 text-sm">{node.name}</span>

        {node.code && (
          <span className="text-xs font-mono text-muted-foreground/60 mr-2">{node.code}</span>
        )}
        <Badge variant="outline" className={`text-xs capitalize hidden group-hover:flex ${TYPE_COLORS[node.type] || ''}`}>
          {node.type}
        </Badge>

        <Button
          variant="ghost" size="icon"
          className="h-6 w-6 opacity-0 group-hover:opacity-100 shrink-0 text-primary hover:text-primary"
          onClick={() => onAddChild(node)}
          title={`Add sub-account under ${node.name}`}
        >
          <Plus className="w-3.5 h-3.5" />
        </Button>
      </div>

      {open && hasChildren && (
        <div>
          {node.children.map((child: any) => (
            <AccountNode key={child.id} node={child} depth={depth + 1} onAddChild={onAddChild} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function ChartOfAccounts() {
  const { data: tree = [], isLoading } = useListChartOfAccounts();
  const [isOpen, setIsOpen] = useState(false);
  const [parentCtx, setParentCtx] = useState<any>(null);
  const queryClient = useQueryClient();
  const createMutation = useCreateAccountLedger();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', code: '', type: 'expense', description: '' },
  });

  const openAdd = (parent?: any) => {
    setParentCtx(parent ?? null);
    form.reset({
      name: '',
      code: '',
      type: parent?.type ?? 'expense',
      parentId: parent?.id,
      description: '',
    });
    setIsOpen(true);
  };

  const onSubmit = (data: FormValues) => {
    const payload: any = {
      name: data.name,
      type: data.type,
      description: data.description,
      parentId: parentCtx?.id ?? data.parentId ?? undefined,
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

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <BookOpen className="w-6 h-6 text-primary" /> Chart of Accounts
            </h1>
            <p className="text-muted-foreground mt-1">Account groups and sub-ledgers</p>
          </div>
          <Button onClick={() => openAdd()}>
            <Plus className="w-4 h-4 mr-2" /> Add Account Group
          </Button>
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          {/* Header */}
          <div className="px-4 py-3 border-b border-border bg-muted/20 flex items-center gap-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            <span className="flex-1">Account Name</span>
            <span className="w-20 text-right mr-10">Code</span>
          </div>

          {isLoading ? (
            <div className="p-8 flex items-center justify-center text-muted-foreground">Loading accounts…</div>
          ) : (tree as any[]).length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <BookOpen className="w-10 h-10 mx-auto mb-3 opacity-20" />
              <p>No accounts yet. Add your first account group.</p>
            </div>
          ) : (
            <div className="py-2">
              {(tree as any[]).map((node: any) => (
                <div key={node.id}>
                  <AccountNode node={node} depth={0} onAddChild={openAdd} />
                  {/* "Add sub-account" row always visible under each group */}
                  <button
                    onClick={() => openAdd(node)}
                    className="flex items-center gap-2 text-xs text-muted-foreground hover:text-primary transition-colors py-1"
                    style={{ paddingLeft: `${12 + 24}px` }}
                  >
                    <Plus className="w-3 h-3" /> Add sub-account under {node.name}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <Dialog open={isOpen} onOpenChange={v => { setIsOpen(v); if (!v) setParentCtx(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {parentCtx ? `Add Sub-Account under "${parentCtx.name}"` : 'Add Account Group'}
            </DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="name" render={({ field }) => (
                  <FormItem className="col-span-2">
                    <FormLabel>Account Name <span className="text-destructive">*</span></FormLabel>
                    <FormControl><Input placeholder="e.g. Cash in Hand" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="code" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Code</FormLabel>
                    <FormControl><Input className="font-mono" placeholder="e.g. CASH-01" {...field} /></FormControl>
                  </FormItem>
                )} />
                <FormField control={form.control} name="type" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Type</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        {ACCOUNT_TYPES.map(t => <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )} />
              </div>
              <FormField control={form.control} name="description" render={({ field }) => (
                <FormItem><FormLabel>Description</FormLabel><FormControl><Textarea rows={2} {...field} /></FormControl></FormItem>
              )} />
              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => setIsOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createMutation.isPending}>
                  {createMutation.isPending ? 'Creating…' : 'Create Account'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
