import { useState } from 'react';
import { useListSales, useCreateSale, useListOutlets, useListCustomers, useListItems, useListItemPrices, getListSalesQueryKey, useListCoupons } from '@workspace/api-client-react';
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
import { Plus, Search, Trash2, CreditCard, Calendar, Receipt } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';

const saleLineItemSchema = z.object({
  itemId: z.coerce.number().min(1, 'Item is required'),
  quantity: z.coerce.number().min(1, 'Quantity must be at least 1'),
});

const schema = z.object({
  outletId: z.coerce.number().min(1, 'Outlet is required'),
  customerId: z.coerce.number().optional(),
  saleDate: z.string().min(1, 'Date is required'),
  paymentMode: z.string().min(1, 'Payment mode is required'),
  couponCode: z.string().optional(),
  lineItems: z.array(saleLineItemSchema).min(1, 'At least one item is required'),
});

export default function Sales() {
  const { data: outlets } = useListOutlets();
  const [selectedOutletFilter, setSelectedOutletFilter] = useState<string>('all');
  const { data: sales, isLoading } = useListSales(selectedOutletFilter !== 'all' ? { outletId: Number(selectedOutletFilter) } : undefined);
  const { data: customers } = useListCustomers();
  const { data: items } = useListItems();
  const { data: coupons } = useListCoupons();
  
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const createMutation = useCreateSale();

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { 
      outletId: 0, 
      saleDate: new Date().toISOString().split('T')[0], 
      paymentMode: 'cash',
      couponCode: '',
      lineItems: [{ itemId: 0, quantity: 1 }],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "lineItems"
  });

  // Watch outletId to fetch relevant item prices
  const watchOutletId = form.watch('outletId');
  const { data: outletPrices } = useListItemPrices({ outletId: watchOutletId }, { query: { enabled: !!watchOutletId } });

  const onSubmit = (data: z.infer<typeof schema>) => {
    createMutation.mutate({ data }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListSalesQueryKey() });
        setIsOpen(false);
        form.reset();
        toast({ title: 'Sale recorded successfully' });
      }
    });
  };

  const filtered = sales?.filter(s => s.invoiceNumber?.toLowerCase().includes(search.toLowerCase()) || s.customerName?.toLowerCase().includes(search.toLowerCase())) || [];

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <CreditCard className="w-6 h-6 text-primary" /> Point of Sale
            </h1>
            <p className="text-muted-foreground mt-1">Record and view retail transactions</p>
          </div>
          
          <Dialog open={isOpen} onOpenChange={setIsOpen}>
            <DialogTrigger asChild>
              <Button><Plus className="w-4 h-4 mr-2" /> New Sale</Button>
            </DialogTrigger>
            <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Record Sale</DialogTitle>
              </DialogHeader>
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                  <div className="grid grid-cols-2 gap-4">
                    <FormField control={form.control} name="outletId" render={({field}) => (
                      <FormItem>
                        <FormLabel>Outlet</FormLabel>
                        <Select onValueChange={(val) => field.onChange(Number(val))} value={field.value ? field.value.toString() : ''}>
                          <FormControl><SelectTrigger><SelectValue placeholder="Select outlet" /></SelectTrigger></FormControl>
                          <SelectContent>
                            {outlets?.map(o => <SelectItem key={o.id} value={o.id.toString()}>{o.name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={form.control} name="saleDate" render={({field}) => (
                      <FormItem>
                        <FormLabel>Date</FormLabel>
                        <FormControl><Input type="date" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={form.control} name="customerId" render={({field}) => (
                      <FormItem>
                        <FormLabel>Customer (Optional)</FormLabel>
                        <Select onValueChange={(val) => field.onChange(Number(val))} value={field.value ? field.value.toString() : ''}>
                          <FormControl><SelectTrigger><SelectValue placeholder="Walk-in customer" /></SelectTrigger></FormControl>
                          <SelectContent>
                            <SelectItem value="0">Walk-in Customer</SelectItem>
                            {customers?.map(c => <SelectItem key={c.id} value={c.id.toString()}>{c.name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={form.control} name="paymentMode" render={({field}) => (
                      <FormItem>
                        <FormLabel>Payment Mode</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                          <SelectContent>
                            <SelectItem value="cash">Cash</SelectItem>
                            <SelectItem value="card">Card</SelectItem>
                            <SelectItem value="upi">UPI / QR</SelectItem>
                            <SelectItem value="bank_transfer">Bank Transfer</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )} />
                  </div>

                  <div className="space-y-4">
                    <div className="flex justify-between items-center">
                      <h3 className="text-lg font-medium">Cart Items</h3>
                      <Button type="button" variant="outline" size="sm" onClick={() => append({ itemId: 0, quantity: 1 })}>
                        <Plus className="w-4 h-4 mr-2" /> Add Item
                      </Button>
                    </div>
                    
                    {!watchOutletId ? (
                      <div className="p-4 border border-dashed border-border rounded-md text-center text-muted-foreground">
                        Please select an outlet first to load prices
                      </div>
                    ) : (
                      fields.map((field, index) => (
                        <div key={field.id} className="grid grid-cols-12 gap-2 items-end border border-border p-4 rounded-md relative bg-muted/20">
                          <div className="col-span-6">
                            <FormField control={form.control} name={`lineItems.${index}.itemId`} render={({field: f}) => (
                              <FormItem>
                                <FormLabel>Item</FormLabel>
                                <Select onValueChange={(val) => f.onChange(Number(val))} value={f.value ? f.value.toString() : ''}>
                                  <FormControl><SelectTrigger><SelectValue placeholder="Select item" /></SelectTrigger></FormControl>
                                  <SelectContent>
                                    {items?.map(item => {
                                      const price = outletPrices?.find(p => p.itemId === item.id)?.price || 0;
                                      return (
                                        <SelectItem key={item.id} value={item.id.toString()}>
                                          {item.name} (₹{price})
                                        </SelectItem>
                                      );
                                    })}
                                  </SelectContent>
                                </Select>
                              </FormItem>
                            )} />
                          </div>
                          <div className="col-span-3">
                            <FormField control={form.control} name={`lineItems.${index}.quantity`} render={({field}) => (
                              <FormItem><FormLabel>Quantity</FormLabel><FormControl><Input type="number" {...field} /></FormControl></FormItem>
                            )} />
                          </div>
                          <div className="col-span-2 text-right pb-2 font-mono">
                            {(() => {
                              const itemId = form.watch(`lineItems.${index}.itemId`);
                              const qty = form.watch(`lineItems.${index}.quantity`);
                              const price = outletPrices?.find(p => p.itemId === itemId)?.price || 0;
                              return `₹${(price * qty).toLocaleString('en-IN')}`;
                            })()}
                          </div>
                          <div className="col-span-1 pb-2 flex justify-end">
                            <Button type="button" variant="ghost" size="icon" className="text-destructive" onClick={() => remove(index)} disabled={fields.length === 1}>
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>

                  <FormField control={form.control} name="couponCode" render={({field}) => (
                    <FormItem>
                      <FormLabel>Coupon Code (Optional)</FormLabel>
                      <FormControl><Input placeholder="Enter code..." className="uppercase" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />

                  <DialogFooter className="flex-row justify-between items-center w-full">
                    <div className="text-xl font-bold font-mono text-primary">
                      Total: ₹{
                        fields.reduce((acc, _, index) => {
                          const itemId = form.watch(`lineItems.${index}.itemId`);
                          const qty = form.watch(`lineItems.${index}.quantity`);
                          const price = outletPrices?.find(p => p.itemId === itemId)?.price || 0;
                          return acc + (price * qty);
                        }, 0).toLocaleString('en-IN')
                      }
                    </div>
                    <Button type="submit" disabled={createMutation.isPending || !watchOutletId}>Complete Sale</Button>
                  </DialogFooter>
                </form>
              </Form>
            </DialogContent>
          </Dialog>
        </div>

        <div className="bg-card border border-border rounded-md shadow-sm">
          <div className="p-4 border-b border-border grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="flex items-center gap-2 border border-input rounded-md px-3 bg-muted/50 focus-within:ring-1 focus-within:ring-ring">
              <Search className="w-4 h-4 text-muted-foreground" />
              <Input 
                placeholder="Search invoice or customer..." 
                value={search} 
                onChange={e => setSearch(e.target.value)}
                className="border-transparent bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 px-0"
              />
            </div>
            
            <Select value={selectedOutletFilter} onValueChange={setSelectedOutletFilter}>
              <SelectTrigger>
                <SelectValue placeholder="All Outlets" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Outlets</SelectItem>
                {outlets?.map(o => (
                  <SelectItem key={o.id} value={o.id.toString()}>{o.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Outlet</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Payment</TableHead>
                <TableHead className="text-right">Total Amount</TableHead>
                <TableHead className="text-right"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow>
              ) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">No sales found</TableCell></TableRow>
              ) : (
                filtered.map(sale => (
                  <TableRow key={sale.id}>
                    <TableCell className="font-medium font-mono text-primary">{sale.invoiceNumber}</TableCell>
                    <TableCell>
                      <div className="flex items-center text-sm">
                        <Calendar className="w-3 h-3 mr-1 text-muted-foreground" />
                        {new Date(sale.saleDate).toLocaleDateString()}
                      </div>
                    </TableCell>
                    <TableCell>{sale.outletName}</TableCell>
                    <TableCell>{sale.customerName || 'Walk-in'}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="uppercase text-xs">{sale.paymentMode?.replace('_', ' ')}</Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono font-medium text-emerald-500">
                      ₹{sale.totalAmount.toLocaleString('en-IN')}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" className="text-primary hover:text-primary">
                        <Receipt className="w-4 h-4" />
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