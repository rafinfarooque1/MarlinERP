import { useState } from 'react';
import { useListStockTransfers, useCreateStockTransfer, useListItems, useListWarehouses, useListOutlets, getListStockTransfersQueryKey } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Plus, Search, Trash2, ArrowRightLeft, Calendar, FileText } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';

const transferLineSchema = z.object({
  itemId: z.coerce.number().min(1, 'Item is required'),
  quantity: z.coerce.number().min(1, 'Quantity must be positive'),
});

const schema = z.object({
  fromType: z.enum(['production', 'warehouse', 'outlet']),
  fromId: z.coerce.number().min(1, 'Source is required'),
  toType: z.enum(['headoffice', 'warehouse', 'outlet']),
  toId: z.coerce.number().min(1, 'Destination is required'),
  transferDate: z.string().min(1, 'Date is required'),
  lineItems: z.array(transferLineSchema).min(1, 'At least one item is required'),
  notes: z.string().optional(),
});

export default function HoTransfers() {
  const { data: transfers, isLoading } = useListStockTransfers();
  const { data: items } = useListItems();
  const { data: warehouses } = useListWarehouses();
  const { data: outlets } = useListOutlets();
  
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const createMutation = useCreateStockTransfer();

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { 
      fromType: 'warehouse',
      fromId: 0,
      toType: 'outlet',
      toId: 0,
      transferDate: new Date().toISOString().split('T')[0], 
      lineItems: [{ itemId: 0, quantity: 1 }],
      notes: ''
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "lineItems"
  });

  const watchFromType = form.watch('fromType');
  const watchToType = form.watch('toType');

  const onSubmit = (data: z.infer<typeof schema>) => {
    createMutation.mutate({ data }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListStockTransfersQueryKey() });
        setIsOpen(false);
        form.reset();
        toast({ title: 'Stock transfer created' });
      }
    });
  };

  const filtered = transfers?.filter(t => t.challanNumber?.toLowerCase().includes(search.toLowerCase()) || t.fromName?.toLowerCase().includes(search.toLowerCase()) || t.toName?.toLowerCase().includes(search.toLowerCase())) || [];

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <ArrowRightLeft className="w-6 h-6 text-primary" /> Stock Transfers
            </h1>
            <p className="text-muted-foreground mt-1">Manage global inventory movement</p>
          </div>
          
          <Dialog open={isOpen} onOpenChange={setIsOpen}>
            <DialogTrigger asChild>
              <Button><Plus className="w-4 h-4 mr-2" /> New Transfer</Button>
            </DialogTrigger>
            <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Create Stock Transfer</DialogTitle>
              </DialogHeader>
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-4">
                      <FormField control={form.control} name="fromType" render={({field}) => (
                        <FormItem>
                          <FormLabel>Source Type</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value}>
                            <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                            <SelectContent>
                              <SelectItem value="production">Production Unit</SelectItem>
                              <SelectItem value="warehouse">Warehouse</SelectItem>
                              <SelectItem value="outlet">Outlet</SelectItem>
                            </SelectContent>
                          </Select>
                        </FormItem>
                      )} />
                      <FormField control={form.control} name="fromId" render={({field}) => (
                        <FormItem>
                          <FormLabel>Source Location</FormLabel>
                          <Select onValueChange={(val) => field.onChange(Number(val))} value={field.value ? field.value.toString() : ''}>
                            <FormControl><SelectTrigger><SelectValue placeholder="Select source" /></SelectTrigger></FormControl>
                            <SelectContent>
                              {watchFromType === 'production' && <SelectItem value="1">Main Production Unit</SelectItem>}
                              {watchFromType === 'warehouse' && warehouses?.map(w => <SelectItem key={w.id} value={w.id.toString()}>{w.name}</SelectItem>)}
                              {watchFromType === 'outlet' && outlets?.map(o => <SelectItem key={o.id} value={o.id.toString()}>{o.name}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </FormItem>
                      )} />
                    </div>
                    
                    <div className="space-y-4">
                      <FormField control={form.control} name="toType" render={({field}) => (
                        <FormItem>
                          <FormLabel>Destination Type</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value}>
                            <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                            <SelectContent>
                              <SelectItem value="headoffice">Head Office</SelectItem>
                              <SelectItem value="warehouse">Warehouse</SelectItem>
                              <SelectItem value="outlet">Outlet</SelectItem>
                            </SelectContent>
                          </Select>
                        </FormItem>
                      )} />
                      <FormField control={form.control} name="toId" render={({field}) => (
                        <FormItem>
                          <FormLabel>Destination Location</FormLabel>
                          <Select onValueChange={(val) => field.onChange(Number(val))} value={field.value ? field.value.toString() : ''}>
                            <FormControl><SelectTrigger><SelectValue placeholder="Select destination" /></SelectTrigger></FormControl>
                            <SelectContent>
                              {watchToType === 'headoffice' && <SelectItem value="1">Central Head Office</SelectItem>}
                              {watchToType === 'warehouse' && warehouses?.map(w => <SelectItem key={w.id} value={w.id.toString()}>{w.name}</SelectItem>)}
                              {watchToType === 'outlet' && outlets?.map(o => <SelectItem key={o.id} value={o.id.toString()}>{o.name}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </FormItem>
                      )} />
                    </div>
                  </div>

                  <FormField control={form.control} name="transferDate" render={({field}) => (
                    <FormItem>
                      <FormLabel>Transfer Date</FormLabel>
                      <FormControl><Input type="date" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />

                  <div className="space-y-4">
                    <div className="flex justify-between items-center">
                      <h3 className="text-lg font-medium">Items</h3>
                      <Button type="button" variant="outline" size="sm" onClick={() => append({ itemId: 0, quantity: 1 })}>
                        <Plus className="w-4 h-4 mr-2" /> Add Item
                      </Button>
                    </div>
                    
                    {fields.map((field, index) => (
                      <div key={field.id} className="grid grid-cols-12 gap-2 items-end border border-border p-4 rounded-md relative bg-muted/20">
                        <div className="col-span-7">
                          <FormField control={form.control} name={`lineItems.${index}.itemId`} render={({field: f}) => (
                            <FormItem>
                              <FormLabel>Item</FormLabel>
                              <Select onValueChange={(val) => f.onChange(Number(val))} value={f.value ? f.value.toString() : ''}>
                                <FormControl><SelectTrigger><SelectValue placeholder="Select item" /></SelectTrigger></FormControl>
                                <SelectContent>
                                  {items?.map(item => <SelectItem key={item.id} value={item.id.toString()}>{item.name}</SelectItem>)}
                                </SelectContent>
                              </Select>
                            </FormItem>
                          )} />
                        </div>
                        <div className="col-span-4">
                          <FormField control={form.control} name={`lineItems.${index}.quantity`} render={({field}) => (
                            <FormItem><FormLabel>Qty</FormLabel><FormControl><Input type="number" {...field} /></FormControl></FormItem>
                          )} />
                        </div>
                        <div className="col-span-1 pb-2">
                          <Button type="button" variant="ghost" size="icon" className="text-destructive" onClick={() => remove(index)} disabled={fields.length === 1}>
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>

                  <FormField control={form.control} name="notes" render={({field}) => (
                    <FormItem><FormLabel>Notes</FormLabel><FormControl><Input placeholder="Optional" {...field} /></FormControl><FormMessage /></FormItem>
                  )} />

                  <DialogFooter>
                    <Button type="submit" disabled={createMutation.isPending}>Initiate Transfer</Button>
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
              placeholder="Search challan number, source, or destination..." 
              value={search} 
              onChange={e => setSearch(e.target.value)}
              className="max-w-md border-transparent bg-muted/50 focus-visible:bg-transparent"
            />
          </div>
          
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Challan No</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>From</TableHead>
                <TableHead>To</TableHead>
                <TableHead>Items</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow>
              ) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">No transfers found</TableCell></TableRow>
              ) : (
                filtered.map(transfer => (
                  <TableRow key={transfer.id}>
                    <TableCell className="font-medium font-mono text-primary">{transfer.challanNumber}</TableCell>
                    <TableCell>
                      <div className="flex items-center text-sm">
                        <Calendar className="w-3 h-3 mr-1 text-muted-foreground" />
                        {new Date(transfer.transferDate).toLocaleDateString()}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{transfer.fromName}</div>
                      <div className="text-xs text-muted-foreground capitalize">{transfer.fromType}</div>
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{transfer.toName}</div>
                      <div className="text-xs text-muted-foreground capitalize">{transfer.toType}</div>
                    </TableCell>
                    <TableCell>{transfer.lineItems?.length || 0} items</TableCell>
                    <TableCell>
                      <Badge variant={transfer.status === 'completed' ? 'default' : transfer.status === 'cancelled' ? 'destructive' : 'secondary'} 
                             className={transfer.status === 'completed' ? 'bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 border-emerald-500/20' : ''}>
                        {transfer.status?.toUpperCase()}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" className="text-primary hover:text-primary">
                        <FileText className="w-4 h-4 mr-2" /> Challan
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