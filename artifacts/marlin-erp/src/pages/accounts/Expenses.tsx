import { useState } from 'react';
import { useListExpenses, useCreateExpense, getListExpensesQueryKey, useListChartOfAccounts } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Plus, Search, Receipt, Download, Eye, Calendar } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';

const schema = z.object({
  title: z.string().min(1, 'Title required'),
  amount: z.coerce.number().min(0.01, 'Amount > 0'),
  category: z.string().min(1, 'Category required'),
  expenseDate: z.string().min(1, 'Date required'),
  ledgerAccountId: z.coerce.number().optional(),
  notes: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

const CATEGORIES = ['Salaries', 'Rent', 'Utilities', 'Logistics', 'Marketing', 'Maintenance', 'Raw Materials', 'Packaging', 'Travel', 'Other'];

export default function Expenses() {
  const { data: expenses = [], isLoading } = useListExpenses();
  const { data: accounts = [] } = useListChartOfAccounts();
  const expenseAccounts = accounts.filter(a => a.type === 'expense');
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [viewItem, setViewItem] = useState<any>(null);
  const queryClient = useQueryClient();
  const createMutation = useCreateExpense();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { title: '', amount: 0, category: '', expenseDate: new Date().toISOString().split('T')[0], notes: '' },
  });

  const onSubmit = (data: FormValues) => {
    createMutation.mutate({ data: { ...data, amount: String(data.amount) } as any }, {
      onSuccess: () => { toast.success('Expense recorded'); queryClient.invalidateQueries({ queryKey: getListExpensesQueryKey() }); setIsOpen(false); form.reset(); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  const filtered = expenses.filter(e => e.title?.toLowerCase().includes(search.toLowerCase()) || e.category?.toLowerCase().includes(search.toLowerCase()));
  const total = filtered.reduce((s, e) => s + Number(e.amount || 0), 0);

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><Receipt className="w-6 h-6 text-primary" /> Expenses</h1>
            <p className="text-muted-foreground mt-1">Business expenditure tracking</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => downloadCSV('expenses.csv', filtered.map(e => ({ Title: e.title, Amount: e.amount, Category: e.category, Date: e.expenseDate })))}>
              <Download className="w-4 h-4 mr-2" /> Export
            </Button>
            <Button onClick={() => { form.reset({ title: '', amount: 0, category: '', expenseDate: new Date().toISOString().split('T')[0], notes: '' }); setIsOpen(true); }}>
              <Plus className="w-4 h-4 mr-2" /> Add Expense
            </Button>
          </div>
        </div>

        {filtered.length > 0 && (
          <div className="bg-card border border-border rounded-xl p-4 flex justify-between items-center">
            <span className="text-muted-foreground text-sm">{filtered.length} expense entries</span>
            <span className="text-xl font-bold text-red-500 font-mono">₹{total.toLocaleString('en-IN')}</span>
          </div>
        )}

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex items-center gap-2 bg-muted/20">
            <Search className="w-4 h-4 text-muted-foreground" />
            <Input placeholder="Search expenses..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0 max-w-sm" />
          </div>
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Date</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(4)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={5}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="text-center py-16 text-muted-foreground">
                  <Receipt className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No expenses recorded</p>
                </TableCell></TableRow>
              ) : filtered.map(e => (
                <TableRow key={e.id} className="hover:bg-muted/10">
                  <TableCell className="text-sm text-muted-foreground"><div className="flex items-center gap-1"><Calendar className="w-3 h-3" />{new Date(e.expenseDate).toLocaleDateString('en-IN')}</div></TableCell>
                  <TableCell className="font-semibold">{e.title}</TableCell>
                  <TableCell><Badge variant="outline" className="text-xs">{e.category}</Badge></TableCell>
                  <TableCell className="text-right font-mono font-bold text-red-500">₹{Number(e.amount).toLocaleString('en-IN')}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(e)}><Eye className="w-4 h-4" /></Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Record Expense</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">
              <FormField control={form.control} name="title" render={({ field }) => (
                <FormItem><FormLabel>Title <span className="text-destructive">*</span></FormLabel><FormControl><Input placeholder="e.g. Office rent - July" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="amount" render={({ field }) => (
                  <FormItem><FormLabel>Amount ₹ <span className="text-destructive">*</span></FormLabel><FormControl><Input type="number" step="0.01" min={0} {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="expenseDate" render={({ field }) => (
                  <FormItem><FormLabel>Date</FormLabel><FormControl><Input type="date" {...field} /></FormControl></FormItem>
                )} />
              </div>
              <FormField control={form.control} name="category" render={({ field }) => (
                <FormItem><FormLabel>Category <span className="text-destructive">*</span></FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl><SelectTrigger><SelectValue placeholder="Select category" /></SelectTrigger></FormControl>
                    <SelectContent>{CATEGORIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
                  </Select><FormMessage /></FormItem>
              )} />
              {expenseAccounts.length > 0 && (
                <FormField control={form.control} name="ledgerAccountId" render={({ field }) => (
                  <FormItem><FormLabel>Ledger Account</FormLabel>
                    <Select onValueChange={v => field.onChange(Number(v))} value={field.value ? String(field.value) : ''}>
                      <FormControl><SelectTrigger><SelectValue placeholder="Optional" /></SelectTrigger></FormControl>
                      <SelectContent>{expenseAccounts.map(a => <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>)}</SelectContent>
                    </Select></FormItem>
                )} />
              )}
              <FormField control={form.control} name="notes" render={({ field }) => (
                <FormItem><FormLabel>Notes</FormLabel><FormControl><Textarea rows={2} {...field} /></FormControl></FormItem>
              )} />
              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => setIsOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createMutation.isPending}>{createMutation.isPending ? 'Saving…' : 'Record Expense'}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Sheet open={!!viewItem} onOpenChange={v => !v && setViewItem(null)}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{viewItem?.title}</SheetTitle>
            <SheetDescription>{viewItem?.category}</SheetDescription>
          </SheetHeader>
          {viewItem && (
            <div className="mt-6 space-y-4">
              {[['Amount', `₹${Number(viewItem.amount).toLocaleString('en-IN')}`], ['Date', new Date(viewItem.expenseDate).toLocaleDateString('en-IN')], ['Category', viewItem.category], ['Notes', viewItem.notes || '—']].map(([k, v]) => (
                <div key={k} className="flex flex-col gap-1 border-b border-border pb-3">
                  <span className="text-xs text-muted-foreground uppercase tracking-wider">{k}</span>
                  <span className="font-medium">{v}</span>
                </div>
              ))}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </AppLayout>
  );
}
