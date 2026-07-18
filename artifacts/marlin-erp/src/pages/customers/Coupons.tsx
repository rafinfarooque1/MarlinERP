import { useState } from 'react';
import { useListCoupons, useCreateCoupon, useUpdateCoupon, useDeleteCoupon, getListCouponsQueryKey } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Plus, Search, Edit2, Trash2, TicketPercent } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';

const schema = z.object({
  code: z.string().min(1, 'Code is required'),
  discountType: z.enum(['percentage', 'fixed']),
  discountValue: z.coerce.number().min(0, 'Discount must be positive'),
  validDays: z.coerce.number().min(1, 'Valid days must be at least 1'),
});

const updateSchema = z.object({
  discountValue: z.coerce.number().min(0, 'Discount must be positive'),
  validDays: z.coerce.number().min(1, 'Valid days must be at least 1'),
  isActive: z.boolean(),
});

export default function Coupons() {
  const { data: coupons, isLoading } = useListCoupons();
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const createMutation = useCreateCoupon();
  const updateMutation = useUpdateCoupon();
  const deleteMutation = useDeleteCoupon();

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { code: '', discountType: 'percentage', discountValue: 0, validDays: 30 },
  });

  const updateForm = useForm<z.infer<typeof updateSchema>>({
    resolver: zodResolver(updateSchema),
    defaultValues: { discountValue: 0, validDays: 30, isActive: true },
  });

  const onSubmit = (data: z.infer<typeof schema>) => {
    createMutation.mutate({ data }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListCouponsQueryKey() });
        setIsOpen(false);
        form.reset();
        toast({ title: 'Coupon created' });
      }
    });
  };

  const onUpdate = (data: z.infer<typeof updateSchema>) => {
    if (!editingId) return;
    updateMutation.mutate({ id: editingId, data }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListCouponsQueryKey() });
        setIsOpen(false);
        toast({ title: 'Coupon updated' });
      }
    });
  };

  const handleEdit = (coupon: any) => {
    setEditingId(coupon.id);
    updateForm.reset({
      discountValue: coupon.discountValue,
      validDays: coupon.validDays,
      isActive: coupon.isActive,
    });
    setIsOpen(true);
  };

  const handleDelete = (id: number) => {
    if (confirm('Are you sure you want to delete this coupon?')) {
      deleteMutation.mutate({ id }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListCouponsQueryKey() });
          toast({ title: 'Coupon deleted' });
        }
      });
    }
  };

  const filtered = coupons?.filter(c => c.code.toLowerCase().includes(search.toLowerCase())) || [];

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <TicketPercent className="w-6 h-6 text-primary" /> Promotional Coupons
            </h1>
            <p className="text-muted-foreground mt-1">Manage discount codes for retail sales</p>
          </div>
          
          <Dialog open={isOpen} onOpenChange={(open) => {
            setIsOpen(open);
            if (!open) setEditingId(null);
          }}>
            <DialogTrigger asChild>
              <Button><Plus className="w-4 h-4 mr-2" /> Add Coupon</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{editingId ? 'Edit Coupon' : 'Create Coupon'}</DialogTitle>
              </DialogHeader>
              {editingId ? (
                <Form {...updateForm}>
                  <form onSubmit={updateForm.handleSubmit(onUpdate)} className="space-y-4">
                    <div className="p-3 bg-muted/50 rounded-md border border-border mb-4">
                      <span className="text-xs text-muted-foreground">Code</span>
                      <div className="font-mono font-bold text-lg">{coupons?.find(c => c.id === editingId)?.code}</div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <FormField control={updateForm.control} name="discountValue" render={({field}) => (
                        <FormItem><FormLabel>Discount Value</FormLabel><FormControl><Input type="number" {...field} /></FormControl><FormMessage /></FormItem>
                      )} />
                      <FormField control={updateForm.control} name="validDays" render={({field}) => (
                        <FormItem><FormLabel>Valid Days</FormLabel><FormControl><Input type="number" {...field} /></FormControl><FormMessage /></FormItem>
                      )} />
                    </div>
                    <FormField control={updateForm.control} name="isActive" render={({field}) => (
                      <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3 shadow-sm">
                        <div className="space-y-0.5">
                          <FormLabel>Active Status</FormLabel>
                          <div className="text-[0.8rem] text-muted-foreground">Enable or disable this coupon code</div>
                        </div>
                        <FormControl>
                          <Switch checked={field.value} onCheckedChange={field.onChange} />
                        </FormControl>
                      </FormItem>
                    )} />
                    <DialogFooter>
                      <Button type="submit" disabled={updateMutation.isPending}>Save Changes</Button>
                    </DialogFooter>
                  </form>
                </Form>
              ) : (
                <Form {...form}>
                  <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                    <FormField control={form.control} name="code" render={({field}) => (
                      <FormItem><FormLabel>Coupon Code</FormLabel><FormControl><Input {...field} className="uppercase font-mono" /></FormControl><FormMessage /></FormItem>
                    )} />
                    <div className="grid grid-cols-2 gap-4">
                      <FormField control={form.control} name="discountType" render={({field}) => (
                        <FormItem>
                          <FormLabel>Type</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value}>
                            <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                            <SelectContent>
                              <SelectItem value="percentage">Percentage (%)</SelectItem>
                              <SelectItem value="fixed">Fixed Amount (₹)</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={form.control} name="discountValue" render={({field}) => (
                        <FormItem><FormLabel>Value</FormLabel><FormControl><Input type="number" {...field} /></FormControl><FormMessage /></FormItem>
                      )} />
                    </div>
                    <FormField control={form.control} name="validDays" render={({field}) => (
                      <FormItem><FormLabel>Valid Duration (Days)</FormLabel><FormControl><Input type="number" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <DialogFooter>
                      <Button type="submit" disabled={createMutation.isPending}>Create Coupon</Button>
                    </DialogFooter>
                  </form>
                </Form>
              )}
            </DialogContent>
          </Dialog>
        </div>

        <div className="bg-card border border-border rounded-md shadow-sm">
          <div className="p-4 border-b border-border flex items-center gap-2">
            <Search className="w-4 h-4 text-muted-foreground" />
            <Input 
              placeholder="Search coupon codes..." 
              value={search} 
              onChange={e => setSearch(e.target.value)}
              className="max-w-xs border-transparent bg-muted/50 focus-visible:bg-transparent uppercase"
            />
          </div>
          
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Discount</TableHead>
                <TableHead>Validity</TableHead>
                <TableHead>Usage</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow>
              ) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">No coupons found</TableCell></TableRow>
              ) : (
                filtered.map(coupon => (
                  <TableRow key={coupon.id}>
                    <TableCell className="font-mono font-bold text-primary tracking-widest">{coupon.code}</TableCell>
                    <TableCell className="font-medium">
                      {coupon.discountType === 'percentage' ? `${coupon.discountValue}% OFF` : `₹${coupon.discountValue} OFF`}
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">{coupon.validDays} Days</div>
                      <div className="text-xs text-muted-foreground">
                        {coupon.expiryDate ? `Expires ${new Date(coupon.expiryDate).toLocaleDateString()}` : 'No expiry'}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono">{coupon.usageCount || 0} times</TableCell>
                    <TableCell>
                      <Badge variant={coupon.isActive ? 'default' : 'secondary'} className={coupon.isActive ? 'bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 border-emerald-500/20' : ''}>
                        {coupon.isActive ? 'ACTIVE' : 'DISABLED'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button variant="ghost" size="icon" onClick={() => handleEdit(coupon)}>
                          <Edit2 className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="icon" className="text-destructive hover:text-destructive" onClick={() => handleDelete(coupon.id)}>
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
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