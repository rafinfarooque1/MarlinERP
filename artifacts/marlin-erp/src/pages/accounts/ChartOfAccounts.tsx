import { useState } from 'react';
import { useListChartOfAccounts, useCreateAccountLedger, getListChartOfAccountsQueryKey } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Plus, Search, BookOpen, Download } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV } from '@/lib/download';
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
  code: z.string().min(1, 'Code required'),
  type: z.enum(ACCOUNT_TYPES),
  description: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

export default function ChartOfAccounts() {
  const { data: accounts = [], isLoading } = useListChartOfAccounts();
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [isOpen, setIsOpen] = useState(false);
  const queryClient = useQueryClient();
  const createMutation = useCreateAccountLedger();

  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { name: '', code: '', type: 'asset', description: '' } });

  const onSubmit = (data: FormValues) => {
    createMutation.mutate({ data }, {
      onSuccess: () => { toast.success('Account created'); queryClient.invalidateQueries({ queryKey: getListChartOfAccountsQueryKey() }); setIsOpen(false); form.reset(); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  const filtered = accounts.filter(a =>
    (typeFilter === 'all' || a.type === typeFilter) &&
    (a.name.toLowerCase().includes(search.toLowerCase()) || a.code?.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><BookOpen className="w-6 h-6 text-primary" /> Chart of Accounts</h1>
            <p className="text-muted-foreground mt-1">General ledger account structure</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => downloadCSV('chart-of-accounts.csv', filtered.map(a => ({ Code: a.code, Name: a.name, Type: a.type, Balance: a.balance || 0 })))}>
              <Download className="w-4 h-4 mr-2" /> Export
            </Button>
            <Button onClick={() => { form.reset(); setIsOpen(true); }}><Plus className="w-4 h-4 mr-2" /> Add Account</Button>
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex flex-wrap gap-3 bg-muted/20">
            <div className="flex items-center gap-2 flex-1">
              <Search className="w-4 h-4 text-muted-foreground" />
              <Input placeholder="Search account..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0" />
            </div>
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                {ACCOUNT_TYPES.map(t => <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Code</TableHead>
                <TableHead>Account Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Balance (₹)</TableHead>
                <TableHead>Description</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(5)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={5}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="text-center py-16 text-muted-foreground">
                  <BookOpen className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No accounts found</p>
                </TableCell></TableRow>
              ) : filtered.map(a => (
                <TableRow key={a.id} className="hover:bg-muted/10">
                  <TableCell className="font-mono text-xs font-bold text-muted-foreground">{a.code}</TableCell>
                  <TableCell className="font-semibold">{a.name}</TableCell>
                  <TableCell><Badge variant="outline" className={`capitalize ${TYPE_COLORS[a.type] || ''}`}>{a.type}</Badge></TableCell>
                  <TableCell className="text-right font-mono font-bold">{Number(a.balance || 0) >= 0 ? <span className="text-emerald-500">₹{Number(a.balance || 0).toLocaleString('en-IN')}</span> : <span className="text-red-500">-₹{Math.abs(Number(a.balance || 0)).toLocaleString('en-IN')}</span>}</TableCell>
                  <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">{a.description || '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Add Account</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="code" render={({ field }) => (
                  <FormItem><FormLabel>Account Code <span className="text-destructive">*</span></FormLabel><FormControl><Input className="font-mono" placeholder="1001" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="type" render={({ field }) => (
                  <FormItem><FormLabel>Type</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>{ACCOUNT_TYPES.map(t => <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>)}</SelectContent>
                    </Select></FormItem>
                )} />
              </div>
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem><FormLabel>Account Name <span className="text-destructive">*</span></FormLabel><FormControl><Input placeholder="e.g. Trade Receivables" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="description" render={({ field }) => (
                <FormItem><FormLabel>Description</FormLabel><FormControl><Textarea rows={2} {...field} /></FormControl></FormItem>
              )} />
              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => setIsOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createMutation.isPending}>{createMutation.isPending ? 'Creating…' : 'Create Account'}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
