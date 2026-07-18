import { useState } from 'react';
import { useListChartOfAccounts, useCreateAccountLedger, useUpdateAccountLedger, getListChartOfAccountsQueryKey } from '@workspace/api-client-react';
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
import { Plus, Search, Edit2, Network, BookOpen } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';

const schema = z.object({
  name: z.string().min(1, 'Name is required'),
  type: z.enum(['asset', 'liability', 'income', 'expense', 'equity']),
  parentId: z.coerce.number().optional().or(z.literal(0)),
  description: z.string().optional(),
});

export default function ChartOfAccounts() {
  const { data: accounts, isLoading } = useListChartOfAccounts();
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const createMutation = useCreateAccountLedger();
  const updateMutation = useUpdateAccountLedger();

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', type: 'expense', parentId: 0, description: '' },
  });

  const watchType = form.watch('type');
  const possibleParents = accounts?.filter(a => a.type === watchType) || [];

  const onSubmit = (data: z.infer<typeof schema>) => {
    // If parentId is 0, omit it from the payload
    const payload = {
      ...data,
      parentId: data.parentId === 0 ? undefined : data.parentId
    };

    if (editingId) {
      // For updates, we only send what's allowed by the schema (name, description)
      updateMutation.mutate({ id: editingId, data: { name: payload.name, description: payload.description } }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListChartOfAccountsQueryKey() });
          setIsOpen(false);
          toast({ title: 'Account updated' });
        }
      });
    } else {
      createMutation.mutate({ data: payload }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListChartOfAccountsQueryKey() });
          setIsOpen(false);
          toast({ title: 'Account created' });
        }
      });
    }
  };

  const handleEdit = (account: any) => {
    setEditingId(account.id);
    form.reset({
      name: account.name,
      type: account.type,
      parentId: account.parentId || 0,
      description: account.description || '',
    });
    setIsOpen(true);
  };

  const filtered = accounts?.filter(a => a.name.toLowerCase().includes(search.toLowerCase())) || [];

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Network className="w-6 h-6 text-primary" /> Chart of Accounts
            </h1>
            <p className="text-muted-foreground mt-1">Manage general ledger accounts structure</p>
          </div>
          
          <Dialog open={isOpen} onOpenChange={(open) => {
            setIsOpen(open);
            if (!open) { setEditingId(null); form.reset({ name: '', type: 'expense', parentId: 0, description: '' }); }
          }}>
            <DialogTrigger asChild>
              <Button><Plus className="w-4 h-4 mr-2" /> Add Account</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{editingId ? 'Edit Account' : 'Create Account'}</DialogTitle>
              </DialogHeader>
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                  <FormField control={form.control} name="name" render={({field}) => (
                    <FormItem><FormLabel>Account Name</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                  <div className="grid grid-cols-2 gap-4">
                    <FormField control={form.control} name="type" render={({field}) => (
                      <FormItem>
                        <FormLabel>Account Type</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value} disabled={!!editingId}>
                          <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                          <SelectContent>
                            <SelectItem value="asset">Asset</SelectItem>
                            <SelectItem value="liability">Liability</SelectItem>
                            <SelectItem value="income">Income</SelectItem>
                            <SelectItem value="expense">Expense</SelectItem>
                            <SelectItem value="equity">Equity</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={form.control} name="parentId" render={({field}) => (
                      <FormItem>
                        <FormLabel>Parent Account (Optional)</FormLabel>
                        <Select onValueChange={(val) => field.onChange(Number(val))} value={field.value ? field.value.toString() : '0'} disabled={!!editingId}>
                          <FormControl><SelectTrigger><SelectValue placeholder="Root Account" /></SelectTrigger></FormControl>
                          <SelectContent>
                            <SelectItem value="0">None (Root Level)</SelectItem>
                            {possibleParents.map(a => (
                              <SelectItem key={a.id} value={a.id.toString()} disabled={a.id === editingId}>{a.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )} />
                  </div>
                  <FormField control={form.control} name="description" render={({field}) => (
                    <FormItem><FormLabel>Description</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                  <DialogFooter>
                    <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending}>Save Account</Button>
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
              placeholder="Search accounts..." 
              value={search} 
              onChange={e => setSearch(e.target.value)}
              className="max-w-xs border-transparent bg-muted/50 focus-visible:bg-transparent"
            />
          </div>
          
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Parent</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow>
              ) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">No accounts found</TableCell></TableRow>
              ) : (
                filtered.sort((a,b) => a.type.localeCompare(b.type)).map(account => (
                  <TableRow key={account.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <BookOpen className="w-4 h-4 text-muted-foreground" />
                        <span className="font-medium">{account.name}</span>
                      </div>
                      {account.description && <div className="text-xs text-muted-foreground mt-1 ml-6">{account.description}</div>}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize text-[10px]">{account.type}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">{account.parentName || '-'}</TableCell>
                    <TableCell className={`text-right font-mono font-medium ${account.type === 'income' || account.type === 'asset' ? 'text-emerald-500' : 'text-primary'}`}>
                      ₹{account.balance?.toLocaleString('en-IN') || 0}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon" onClick={() => handleEdit(account)}>
                        <Edit2 className="w-4 h-4" />
                      </Button>
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