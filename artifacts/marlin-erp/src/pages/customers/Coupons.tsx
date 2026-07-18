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
import { Plus, Search, Ticket, Download, Eye } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';

const schema = z.object({
  code: z.string().min(1, 'Code required'),
  discountType: z.enum(['percent', 'flat']),
  discountValue: z.coerce.number().min(0.01, 'Value > 0'),
  minPurchase: z.coerce.number().min(0),
  maxUses: z.coerce.number().min(1),
  validFrom: z.string().min(1),
  validTo: z.string().min(1),
});
type FormValues = z.infer<typeof schema>;

export default function Coupons() {
  const { data: coupons = [], isLoading } = useListCoupons();
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [viewItem, setViewItem] = useState<any>(null);
  const queryClient = useQueryClient();
  const createMutation = useCreateCoupon();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { code: '', discountType: 'percent', discountValue: 10, minPurchase: 0, maxUses: 100, validFrom: new Date().toISOString().split('T')[0], validTo: '' },
  });

  const onSubmit = (data: FormValues) => {
    const payload = { ...data, code: data.code.toUpperCase(), discountValue: String(data.discountValue), minPurchase: String(data.minPurchase) };
    createMutation.mutate({ data: payload as any }, {
      onSuccess: () => { toast.success('Coupon created'); queryClient.invalidateQueries({ queryKey: getListCouponsQueryKey() }); setIsOpen(false); form.reset(); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  const now = new Date();
  const isActive = (c: any) => new Date(c.validFrom) <= now && new Date(c.validTo) >= now && (c.usedCount || 0) < (c.maxUses || 999);
  const filtered = coupons.filter(c => c.code.toLowerCase().includes(search.toLowerCase()));

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><Ticket className="w-6 h-6 text-primary" /> Coupons</h1>
            <p className="text-muted-foreground mt-1">Discount codes and promotional offers</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => downloadCSV('coupons.csv', filtered.map(c => ({ Code: c.code, Type: c.discountType, Value: c.discountValue, MinPurchase: c.minPurchase || 0, MaxUses: c.maxUses, Used: c.usedCount || 0, ValidFrom: c.validFrom, ValidTo: c.validTo })))}>
              <Download className="w-4 h-4 mr-2" /> Export
            </Button>
            <Button onClick={() => { form.reset({ code: '', discountType: 'percent', discountValue: 10, minPurchase: 0, maxUses: 100, validFrom: new Date().toISOString().split('T')[0], validTo: '' }); setIsOpen(true); }}>
              <Plus className="w-4 h-4 mr-2" /> Create Coupon
            </Button>
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex items-center gap-2 bg-muted/20">
            <Search className="w-4 h-4 text-muted-foreground" />
            <Input placeholder="Search coupon code..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0 max-w-xs" />
          </div>
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Code</TableHead>
                <TableHead>Discount</TableHead>
                <TableHead>Min Purchase</TableHead>
                <TableHead>Uses</TableHead>
                <TableHead>Valid Until</TableHead>
                <TableHead>Status</TableHead>
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
              ) : filtered.map(c => (
                <TableRow key={c.id} className="hover:bg-muted/10">
                  <TableCell className="font-mono font-bold text-primary tracking-wider">{c.code}</TableCell>
                  <TableCell className="font-bold text-emerald-500">
                    {c.discountType === 'percent' ? `${c.discountValue}% OFF` : `₹${c.discountValue} OFF`}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">₹{Number(c.minPurchase || 0).toLocaleString()}</TableCell>
                  <TableCell className="text-sm">{c.usedCount || 0} / {c.maxUses}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{c.validTo ? new Date(c.validTo).toLocaleDateString('en-IN') : '—'}</TableCell>
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
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="discountType" render={({ field }) => (
                  <FormItem><FormLabel>Type</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent><SelectItem value="percent">Percentage (%)</SelectItem><SelectItem value="flat">Flat (₹)</SelectItem></SelectContent>
                    </Select></FormItem>
                )} />
                <FormField control={form.control} name="discountValue" render={({ field }) => (
                  <FormItem><FormLabel>Value <span className="text-destructive">*</span></FormLabel><FormControl><Input type="number" step="0.01" min={0.01} {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="minPurchase" render={({ field }) => (
                  <FormItem><FormLabel>Min Purchase ₹</FormLabel><FormControl><Input type="number" min={0} {...field} /></FormControl></FormItem>
                )} />
                <FormField control={form.control} name="maxUses" render={({ field }) => (
                  <FormItem><FormLabel>Max Uses</FormLabel><FormControl><Input type="number" min={1} {...field} /></FormControl></FormItem>
                )} />
                <FormField control={form.control} name="validFrom" render={({ field }) => (
                  <FormItem><FormLabel>Valid From</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="validTo" render={({ field }) => (
                  <FormItem><FormLabel>Valid To</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
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
            <SheetDescription>{viewItem?.discountType === 'percent' ? `${viewItem?.discountValue}% discount` : `₹${viewItem?.discountValue} flat off`}</SheetDescription>
          </SheetHeader>
          {viewItem && (
            <div className="mt-6 space-y-4">
              {[['Type', viewItem.discountType === 'percent' ? 'Percentage' : 'Flat'], ['Value', viewItem.discountType === 'percent' ? `${viewItem.discountValue}%` : `₹${viewItem.discountValue}`], ['Min Purchase', `₹${Number(viewItem.minPurchase || 0).toLocaleString()}`], ['Max Uses', String(viewItem.maxUses)], ['Used', String(viewItem.usedCount || 0)], ['Valid From', viewItem.validFrom ? new Date(viewItem.validFrom).toLocaleDateString('en-IN') : '—'], ['Valid To', viewItem.validTo ? new Date(viewItem.validTo).toLocaleDateString('en-IN') : '—'], ['Status', isActive(viewItem) ? 'Active' : 'Expired']].map(([k, v]) => (
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
