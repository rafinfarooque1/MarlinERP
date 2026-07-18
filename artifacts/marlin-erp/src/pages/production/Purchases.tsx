import { useState } from 'react';
import { useListPurchases, useCreatePurchase, useListVendors, useListMaterials, useListRawMaterials, getListPurchasesQueryKey } from '@workspace/api-client-react';
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
import { Plus, Search, Trash2, ShoppingCart, Calendar } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';

const purchaseLineItemSchema = z.object({
  materialType: z.enum(['material', 'raw_material']),
  materialId: z.coerce.number().min(1, 'Material is required'),
  quantity: z.coerce.number().min(1, 'Quantity must be at least 1'),
  unitCost: z.coerce.number().min(0, 'Cost must be positive'),
});

const schema = z.object({
  vendorId: z.coerce.number().min(1, 'Vendor is required'),
  purchaseDate: z.string().min(1, 'Date is required'),
  invoiceNumber: z.string().optional(),
  lineItems: z.array(purchaseLineItemSchema).min(1, 'At least one item is required'),
  notes: z.string().optional(),
});

export default function Purchases() {
  const { data: purchases, isLoading } = useListPurchases();
  const { data: vendors } = useListVendors();
  const { data: materials } = useListMaterials();
  const { data: rawMaterials } = useListRawMaterials();
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const createMutation = useCreatePurchase();

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { 
      vendorId: 0, 
      purchaseDate: new Date().toISOString().split('T')[0], 
      invoiceNumber: '', 
      lineItems: [{ materialType: 'raw_material', materialId: 0, quantity: 1, unitCost: 0 }],
      notes: ''
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "lineItems"
  });

  const onSubmit = (data: z.infer<typeof schema>) => {
    createMutation.mutate({ data }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListPurchasesQueryKey() });
        setIsOpen(false);
        form.reset();
        toast({ title: 'Purchase order created' });
      }
    });
  };

  const filtered = purchases?.filter(p => p.vendorName?.toLowerCase().includes(search.toLowerCase()) || p.invoiceNumber?.toLowerCase().includes(search.toLowerCase())) || [];

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <ShoppingCart className="w-6 h-6 text-primary" /> Purchase Orders
            </h1>
            <p className="text-muted-foreground mt-1">Manage incoming materials from vendors</p>
          </div>
          
          <Dialog open={isOpen} onOpenChange={setIsOpen}>
            <DialogTrigger asChild>
              <Button><Plus className="w-4 h-4 mr-2" /> New Purchase</Button>
            </DialogTrigger>
            <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Create Purchase Order</DialogTitle>
              </DialogHeader>
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                  <div className="grid grid-cols-2 gap-4">
                    <FormField control={form.control} name="vendorId" render={({field}) => (
                      <FormItem>
                        <FormLabel>Vendor</FormLabel>
                        <Select onValueChange={(val) => field.onChange(Number(val))} value={field.value ? field.value.toString() : ''}>
                          <FormControl><SelectTrigger><SelectValue placeholder="Select vendor" /></SelectTrigger></FormControl>
                          <SelectContent>
                            {vendors?.map(v => <SelectItem key={v.id} value={v.id.toString()}>{v.name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={form.control} name="purchaseDate" render={({field}) => (
                      <FormItem>
                        <FormLabel>Date</FormLabel>
                        <FormControl><Input type="date" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={form.control} name="invoiceNumber" render={({field}) => (
                      <FormItem>
                        <FormLabel>Invoice Number</FormLabel>
                        <FormControl><Input placeholder="Optional" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                  </div>

                  <div className="space-y-4">
                    <div className="flex justify-between items-center">
                      <h3 className="text-lg font-medium">Line Items</h3>
                      <Button type="button" variant="outline" size="sm" onClick={() => append({ materialType: 'raw_material', materialId: 0, quantity: 1, unitCost: 0 })}>
                        <Plus className="w-4 h-4 mr-2" /> Add Item
                      </Button>
                    </div>
                    
                    {fields.map((field, index) => (
                      <div key={field.id} className="grid grid-cols-12 gap-2 items-end border border-border p-4 rounded-md relative bg-muted/20">
                        <div className="col-span-3">
                          <FormField control={form.control} name={`lineItems.${index}.materialType`} render={({field}) => (
                            <FormItem>
                              <FormLabel>Type</FormLabel>
                              <Select onValueChange={field.onChange} defaultValue={field.value}>
                                <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                                <SelectContent>
                                  <SelectItem value="raw_material">Raw Material</SelectItem>
                                  <SelectItem value="material">Material</SelectItem>
                                </SelectContent>
                              </Select>
                            </FormItem>
                          )} />
                        </div>
                        <div className="col-span-4">
                          <FormField control={form.control} name={`lineItems.${index}.materialId`} render={({field: f}) => {
                            const matType = form.watch(`lineItems.${index}.materialType`);
                            const options = matType === 'raw_material' ? rawMaterials : materials;
                            return (
                              <FormItem>
                                <FormLabel>Item</FormLabel>
                                <Select onValueChange={(val) => f.onChange(Number(val))} value={f.value ? f.value.toString() : ''}>
                                  <FormControl><SelectTrigger><SelectValue placeholder="Select item" /></SelectTrigger></FormControl>
                                  <SelectContent>
                                    {options?.map((o: any) => <SelectItem key={o.id} value={o.id.toString()}>{o.name}</SelectItem>)}
                                  </SelectContent>
                                </Select>
                              </FormItem>
                            );
                          }} />
                        </div>
                        <div className="col-span-2">
                          <FormField control={form.control} name={`lineItems.${index}.quantity`} render={({field}) => (
                            <FormItem><FormLabel>Qty</FormLabel><FormControl><Input type="number" {...field} /></FormControl></FormItem>
                          )} />
                        </div>
                        <div className="col-span-2">
                          <FormField control={form.control} name={`lineItems.${index}.unitCost`} render={({field}) => (
                            <FormItem><FormLabel>Unit Cost</FormLabel><FormControl><Input type="number" step="0.01" {...field} /></FormControl></FormItem>
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
                    <Button type="submit" disabled={createMutation.isPending}>Create Purchase</Button>
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
              placeholder="Search purchases by vendor or invoice..." 
              value={search} 
              onChange={e => setSearch(e.target.value)}
              className="max-w-sm border-transparent bg-muted/50 focus-visible:bg-transparent"
            />
          </div>
          
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>PO Number</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead>Invoice</TableHead>
                <TableHead>Items</TableHead>
                <TableHead className="text-right">Total Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow>
              ) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">No purchase orders found</TableCell></TableRow>
              ) : (
                filtered.map(purchase => (
                  <TableRow key={purchase.id}>
                    <TableCell className="font-medium font-mono text-primary">PO-{purchase.id.toString().padStart(4, '0')}</TableCell>
                    <TableCell>
                      <div className="flex items-center text-sm">
                        <Calendar className="w-3 h-3 mr-1 text-muted-foreground" />
                        {new Date(purchase.purchaseDate).toLocaleDateString()}
                      </div>
                    </TableCell>
                    <TableCell>{purchase.vendorName}</TableCell>
                    <TableCell className="text-muted-foreground">{purchase.invoiceNumber || '-'}</TableCell>
                    <TableCell>{purchase.lineItems?.length || 0} items</TableCell>
                    <TableCell className="text-right font-mono font-medium text-emerald-500">
                      ₹{purchase.totalAmount.toLocaleString('en-IN')}
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