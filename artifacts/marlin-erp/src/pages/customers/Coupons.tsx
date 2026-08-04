import { useState } from 'react';
import { useListCoupons, useCreateCoupon, getListCouponsQueryKey } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Plus, Search, Ticket, Download, Eye, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';
import { usePermission } from '@/lib/usePermission';
import { useTableSort, SortableHead } from '@/lib/tableSort';

// Mirrors the coupons table: code, discount_type, discount_value, valid_days.
// The server derives expiry_date from valid_days at creation time.
const schema = z.object({
  code: z.string().min(1, 'Code required'),
  discountType: z.enum(['percentage', 'fixed']),
  discountValue: z.coerce.number().min(0.01, 'Value > 0'),
  validDays: z.coerce.number().int().min(1, 'Valid for at least 1 day'),
});
type FormValues = z.infer<typeof schema>;

export default function Coupons() {
  const perm = usePermission('page:/coupons');
  const { data: coupons = [], isLoading } = useListCoupons();
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [viewItem, setViewItem] = useState<any>(null);
  const queryClient = useQueryClient();
  const createMutation = useCreateCoupon();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { code: '', discountType: 'percentage', discountValue: 10, validDays: 30 },
  });

  const onSubmit = (data: FormValues) => {
    createMutation.mutate({
      data: {
        code: data.code.toUpperCase(),
        discountType: data.discountType,
        discountValue: Number(data.discountValue),
        validDays: Number(data.validDays),
      },
    }, {
      onSuccess: () => { toast.success('Coupon created'); queryClient.invalidateQueries({ queryKey: getListCouponsQueryKey() }); setIsOpen(false); form.reset(); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  const now = new Date();
  const isActive = (c: any) => c.isActive !== false && (!c.expiryDate || new Date(c.expiryDate) >= now);
  const filtered = coupons.filter(c => c.code.toLowerCase().includes(search.toLowerCase()));
  const { sorted, sort } = useTableSort(filtered, {
    code: c => (c as any).code,
    discount: c => Number((c as any).discountValue),
    validDays: c => Number((c as any).validDays) || null,
    used: c => Number((c as any).usageCount ?? 0),
    expires: c => (c as any).expiryDate,
    status: c => (isActive(c) ? 'Active' : 'Expired'),
  });

  if (!perm.isLoading && !perm.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center">
          <div className="w-16 h-16 rounded-2xl bg-destructive/10 flex items-center justify-center">
            <ShieldOff className="w-8 h-8 text-destructive" />
          </div>
          <div>
            <h2 className="text-xl font-bold">Access Denied</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              You don't have permission to view this page.<br />
              Contact your administrator to request access.
            </p>
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><Ticket className="w-6 h-6 text-primary" /> Coupons</h1>
            <p className="text-muted-foreground mt-1">Discount codes and promotional offers</p>
          </div>
          <div className="flex gap-2">
            {perm.canDownload && (
            <Button variant="outline" size="sm" onClick={() => downloadCSV('coupons.csv', (filtered as any[]).map(c => ({ Code: c.code, Type: c.discountType, Value: c.discountValue, ValidDays: c.validDays, Used: c.usageCount ?? 0, ExpiresOn: c.expiryDate ?? '' })))}>
              <Download className="w-4 h-4 mr-2" /> Export
            </Button>
            )}
            {perm.canAdd && (
            <Button onClick={() => { form.reset({ code: '', discountType: 'percentage', discountValue: 10, validDays: 30 }); setIsOpen(true); }}>
              <Plus className="w-4 h-4 mr-2" /> Create Coupon
            </Button>
            )}
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex items-center gap-2 bg-muted/20">
            <Search className="w-4 h-4 text-muted-foreground" />
            <Input placeholder="Search coupon code..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0 max-w-xs max-md:max-w-full" />
          </div>
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <SortableHead k="code" sort={sort}>Code</SortableHead>
                <SortableHead k="discount" sort={sort}>Discount</SortableHead>
                <SortableHead k="validDays" sort={sort}>Valid For</SortableHead>
                <SortableHead k="used" sort={sort}>Used</SortableHead>
                <SortableHead k="expires" sort={sort}>Expires On</SortableHead>
                <SortableHead k="status" sort={sort}>Status</SortableHead>
                <TableHead className="text-right">View</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(3)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={7}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="text-center py-16 text-muted-foreground">
                  <Ticket className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No coupons created</p>
                </TableCell></TableRow>
              ) : sorted.map(c => (
                <TableRow key={c.id} className="hover:bg-muted/10">
                  <TableCell className="font-mono font-bold text-primary tracking-wider">{c.code}</TableCell>
                  <TableCell className="font-bold text-emerald-500">
                    {(c as any).discountType === 'percentage' ? `${(c as any).discountValue}% OFF` : `₹${(c as any).discountValue} OFF`}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{(c as any).validDays ?? '—'} days</TableCell>
                  <TableCell className="text-sm">{(c as any).usageCount ?? 0}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{(c as any).expiryDate ? new Date((c as any).expiryDate).toLocaleDateString('en-IN') : '—'}</TableCell>
                  <TableCell>
                    {isActive(c)
                      ? <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20">Active</Badge>
                      : <Badge variant="secondary">Expired</Badge>}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(c)}><Eye className="w-4 h-4" /></Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <Dialog open={isOpen} onOpenChange={v => { setIsOpen(v); if (!v) form.reset(); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>Create Coupon</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">
              <FormField control={form.control} name="code" render={({ field }) => (
                <FormItem><FormLabel>Coupon Code <span className="text-destructive">*</span></FormLabel><FormControl><Input className="uppercase font-mono font-bold tracking-widest" placeholder="SUMMER20" {...field} onChange={e => field.onChange(e.target.value.toUpperCase())} /></FormControl><FormMessage /></FormItem>
              )} />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FormField control={form.control} name="discountType" render={({ field }) => (
                  <FormItem><FormLabel>Type</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent><SelectItem value="percentage">Percentage (%)</SelectItem><SelectItem value="fixed">Fixed (₹)</SelectItem></SelectContent>
                    </Select></FormItem>
                )} />
                <FormField control={form.control} name="discountValue" render={({ field }) => (
                  <FormItem><FormLabel>Value <span className="text-destructive">*</span></FormLabel><FormControl><Input type="number" step="0.01" min={0.01} {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="validDays" render={({ field }) => (
                  <FormItem className="col-span-2">
                    <FormLabel>Valid For (days) <span className="text-destructive">*</span></FormLabel>
                    <FormControl><Input type="number" min={1} step={1} {...field} /></FormControl>
                    <p className="text-xs text-muted-foreground">Expiry date is calculated from today plus this many days.</p>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => setIsOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createMutation.isPending}>{createMutation.isPending ? 'Saving…' : 'Save Coupon'}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Sheet open={!!viewItem} onOpenChange={v => !v && setViewItem(null)}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle className="font-mono text-primary tracking-widest">{viewItem?.code}</SheetTitle>
            <SheetDescription>{viewItem?.discountType === 'percentage' ? `${viewItem?.discountValue}% discount` : `₹${viewItem?.discountValue} off`}</SheetDescription>
          </SheetHeader>
          {viewItem && (
            <div className="mt-6 space-y-4">
              {[['Type', viewItem.discountType === 'percentage' ? 'Percentage' : 'Fixed'], ['Value', viewItem.discountType === 'percentage' ? `${viewItem.discountValue}%` : `₹${viewItem.discountValue}`], ['Valid For', `${viewItem.validDays ?? '—'} days`], ['Used', String(viewItem.usageCount ?? 0)], ['Expires On', viewItem.expiryDate ? new Date(viewItem.expiryDate).toLocaleDateString('en-IN') : '—'], ['Status', isActive(viewItem) ? 'Active' : 'Expired']].map(([k, v]) => (
                <div key={k} className="flex justify-between items-center border-b border-border pb-3">
                  <span className="text-xs text-muted-foreground uppercase tracking-wider">{k}</span>
                  <span className="font-semibold">{v}</span>
                </div>
              ))}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </AppLayout>
  );
}
