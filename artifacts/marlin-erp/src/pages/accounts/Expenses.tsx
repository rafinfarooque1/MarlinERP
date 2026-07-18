import { useState } from 'react';
import { useListExpenses, useCreateExpense, useListChartOfAccounts, useListCashBankAccounts, getListExpensesQueryKey } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Plus, Search, Receipt, Calendar } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';

const schema = z.object({
  ledgerAccountId: z.coerce.number().min(1, 'Expense category is required'),
  paymentAccountId: z.coerce.number().min(1, 'Payment account is required'),
  amount: z.coerce.number().min(1, 'Amount must be positive'),
  expenseDate: z.string().min(1, 'Date is required'),
  description: z.string().optional(),
});

export default function Expenses() {
  const { data: expenses, isLoading } = useListExpenses();
  const { data: chartOfAccounts } = useListChartOfAccounts();
  const { data: paymentAccounts } = useListCashBankAccounts();
  
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const createMutation = useCreateExpense();

  // Filter COA to only show expense accounts
  const expenseCategories = chartOfAccounts?.filter(a => a.type === 'expense') || [];

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { 
      ledgerAccountId: 0, 
      paymentAccountId: 0, 
      amount: 0, 
      expenseDate: new Date().toISOString().split('T')[0], 
      description: '' 
    },
  });

  const onSubmit = (data: z.infer<typeof schema>) => {
    createMutation.mutate({ data }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListExpensesQueryKey() });
        setIsOpen(false);
        form.reset();
        toast({ title: 'Expense recorded successfully' });
      }
    });
  };

  const filtered = expenses?.filter(e => e.description?.toLowerCase().includes(search.toLowerCase()) || e.ledgerAccountName?.toLowerCase().includes(search.toLowerCase())) || [];

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Receipt className="w-6 h-6 text-primary" /> Expenses
            </h1>
            <p className="text-muted-foreground mt-1">Record and track operational expenses</p>
          </div>
          
          <Dialog open={isOpen} onOpenChange={(open) => {
            setIsOpen(open);
            if (!open) form.reset();
          }}>
            <DialogTrigger asChild>
              <Button><Plus className="w-4 h-4 mr-2" /> Record Expense</Button>
            </DialogTrigger>
            <DialogContent className="max-w-xl">
              <DialogHeader>
                <DialogTitle>Record New Expense</DialogTitle>
              </DialogHeader>
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <FormField control={form.control} name="ledgerAccountId" render={({field}) => (
                      <FormItem>
                        <FormLabel>Expense Category</FormLabel>
                        <Select onValueChange={(val) => field.onChange(Number(val))} value={field.value ? field.value.toString() : ''}>
                          <FormControl><SelectTrigger><SelectValue placeholder="Select category" /></SelectTrigger></FormControl>
                          <SelectContent>
                            {expenseCategories.map(cat => <SelectItem key={cat.id} value={cat.id.toString()}>{cat.name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={form.control} name="expenseDate" render={({field}) => (
                      <FormItem><FormLabel>Date</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                  </div>
                  
                  <div className="grid grid-cols-2 gap-4 border-t border-border pt-4">
                    <FormField control={form.control} name="amount" render={({field}) => (
                      <FormItem><FormLabel>Amount (₹)</FormLabel><FormControl><Input type="number" step="0.01" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={form.control} name="paymentAccountId" render={({field}) => (
                      <FormItem>
                        <FormLabel>Paid From</FormLabel>
                        <Select onValueChange={(val) => field.onChange(Number(val))} value={field.value ? field.value.toString() : ''}>
                          <FormControl><SelectTrigger><SelectValue placeholder="Select payment account" /></SelectTrigger></FormControl>
                          <SelectContent>
                            {paymentAccounts?.map(acc => <SelectItem key={acc.id} value={acc.id.toString()}>{acc.name} ({acc.accountType})</SelectItem>)}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )} />
                  </div>
                  
                  <FormField control={form.control} name="description" render={({field}) => (
                    <FormItem className="pt-2"><FormLabel>Description / Narration</FormLabel><FormControl><Input placeholder="E.g., Office internet bill for August" {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                  <DialogFooter>
                    <Button type="submit" disabled={createMutation.isPending}>Record Expense</Button>
                  </DialogFooter>
                </form>
              </Form>
            </DialogContent>
          </Dialog>
        </div>

        <div className="bg-card border border-border rounded-md shadow-sm">
          <div className="p-4 border-b border-border flex items-center gap-2">
            <Search className="w-4 h-4 text-muted-foreground" />
            <Input 
              placeholder="Search expenses by description or category..." 
              value={search} 
              onChange={e => setSearch(e.target.value)}
              className="max-w-md border-transparent bg-muted/50 focus-visible:bg-transparent"
            />
          </div>
          
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Paid Via</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow>
              ) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">No expenses found</TableCell></TableRow>
              ) : (
                filtered.map(expense => (
                  <TableRow key={expense.id}>
                    <TableCell>
                      <div className="flex items-center text-sm">
                        <Calendar className="w-3 h-3 mr-1 text-muted-foreground" />
                        {new Date(expense.expenseDate).toLocaleDateString()}
                      </div>
                    </TableCell>
                    <TableCell className="font-medium text-foreground">{expense.ledgerAccountName}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">{expense.description || '-'}</TableCell>
                    <TableCell className="text-sm">{expense.paymentAccountName}</TableCell>
                    <TableCell className="text-right font-mono font-medium text-destructive">
                      ₹{expense.amount.toLocaleString('en-IN')}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </AppLayout>
  );
}