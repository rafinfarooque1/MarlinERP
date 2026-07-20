import { useState } from 'react';
import {
  useListPurchases, useCreatePurchase, useListVendors, useListMaterials, useListRawMaterials, useListItems,
  getListPurchasesQueryKey, useUpdatePurchase, useDeletePurchase,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Plus, Search, Trash2, ShoppingCart, Download, Eye, Calendar, FileDown, Edit2, AlertTriangle, X } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';
import { usePermission } from '@/lib/usePermission';
import { Separator } from '@/components/ui/separator';

const GST_RATES = [0, 5, 12, 18, 28] as const;

const lineSchema = z.object({
  materialType: z.enum(['material', 'raw_material', 'item']),
  materialId: z.coerce.number().min(1, 'Select item'),
  hsnCode: z.string().optional(),
  quantity: z.coerce.number().min(0.001, 'Qty > 0'),
  unitCost: z.coerce.number().min(0, 'Rate ≥ 0'),
  discount: z.coerce.number().min(0).max(100).default(0),
  gstRate: z.coerce.number().default(0),
  taxType: z.enum(['intra', 'inter']).default('intra'),
});

const schema = z.object({
  vendorId: z.coerce.number().min(1, 'Vendor required'),
  purchaseDate: z.string().min(1, 'Date required'),
  invoiceNumber: z.string().optional(),
  lineItems: z.array(lineSchema).min(1, 'Add at least one item'),
  notes: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

const editSchema = z.object({
  purchaseDate: z.string().min(1),
  invoiceNumber: z.string().optional(),
  notes: z.string().optional(),
});
type EditFormValues = z.infer<typeof editSchema>;

const defaultLine = { materialType: 'raw_material' as const, materialId: 0, hsnCode: '', quantity: 1, unitCost: 0, discount: 0, gstRate: 5, taxType: 'intra' as const };

function calcLine(q: number, rate: number, disc: number, gst: number, taxType: string) {
  const lineSubtotal = q * rate;
  const discountAmt = lineSubtotal * disc / 100;
  const taxableValue = lineSubtotal - discountAmt;
  const taxAmount = Math.round(taxableValue * gst / 100 * 100) / 100;
  const intra = taxType === 'intra';
  const cgst = intra ? Math.round(taxAmount / 2 * 100) / 100 : 0;
  const sgst = intra ? Math.round(taxAmount / 2 * 100) / 100 : 0;
  const igst = !intra ? taxAmount : 0;
  return { lineSubtotal, discountAmt, taxableValue, taxAmount, cgst, sgst, igst, lineTotal: taxableValue + taxAmount };
}

function fmt(n: number) { return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

export default function Purchases() {
  const perm = usePermission('Purchases');
  const { data: purchases = [], isLoading } = useListPurchases();
  const { data: vendors = [] } = useListVendors();
  const { data: materials = [] } = useListMaterials();
  const { data: rawMaterials = [] } = useListRawMaterials();
  const { data: finishedItems = [] } = useListItems();
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [editItem, setEditItem] = useState<any>(null);
  const [viewItem, setViewItem] = useState<any>(null);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const queryClient = useQueryClient();
  const createMutation = useCreatePurchase();
  const updateMutation = useUpdatePurchase();
  const deleteMutation = useDeletePurchase();

  const getMaterialName = (li: any) => {
    if (li.materialType === 'raw_material') return rawMaterials.find((m: any) => m.id === li.materialId)?.name || `Item #${li.materialId}`;
    if (li.materialType === 'item') return (finishedItems as any[]).find((m: any) => m.id === li.materialId)?.name || `Item #${li.materialId}`;
    return materials.find((m: any) => m.id === li.materialId)?.name || `Item #${li.materialId}`;
  };

  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { vendorId: 0, purchaseDate: new Date().toISOString().split('T')[0], invoiceNumber: '', lineItems: [defaultLine], notes: '' } });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'lineItems' });
  const watchLines = form.watch('lineItems');

  const editForm = useForm<EditFormValues>({ resolver: zodResolver(editSchema), defaultValues: { purchaseDate: '', invoiceNumber: '', notes: '' } });

  // Bill summary
  const billSummary = watchLines.reduce((acc, li) => {
    const calc = calcLine(Number(li.quantity) || 0, Number(li.unitCost) || 0, Number(li.discount) || 0, Number(li.gstRate) || 0, li.taxType);
    acc.subtotal += calc.lineSubtotal;
    acc.discountTotal += calc.discountAmt;
    acc.taxableTotal += calc.taxableValue;
    acc.cgstTotal += calc.cgst;
    acc.sgstTotal += calc.sgst;
    acc.igstTotal += calc.igst;
    acc.taxTotal += calc.taxAmount;
    return acc;
  }, { subtotal: 0, discountTotal: 0, taxableTotal: 0, cgstTotal: 0, sgstTotal: 0, igstTotal: 0, taxTotal: 0 });

  const rawTotal = billSummary.taxableTotal + billSummary.taxTotal;
  const roundOff = Math.round(rawTotal) - rawTotal;
  const grandTotal = Math.round(rawTotal);

  const onSubmit = (data: FormValues) => {
    createMutation.mutate({ data: data as any }, {
      onSuccess: () => {
        toast.success('Purchase bill created');
        queryClient.invalidateQueries({ queryKey: getListPurchasesQueryKey() });
        setIsOpen(false);
        form.reset({ vendorId: 0, purchaseDate: new Date().toISOString().split('T')[0], invoiceNumber: '', lineItems: [defaultLine], notes: '' });
      },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  const onEditSubmit = (data: EditFormValues) => {
    updateMutation.mutate({ id: editItem.id, data }, {
      onSuccess: () => { toast.success('Purchase bill updated'); setEditItem(null); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  const handleDelete = () => {
    if (!deleteTarget) return;
    deleteMutation.mutate(deleteTarget.id, {
      onSuccess: () => { toast.success(`Bill #${deleteTarget.id} deleted (stock reversed)`); setDeleteTarget(null); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Delete failed'),
    });
  };

  const filtered = purchases.filter(p =>
    p.vendorName?.toLowerCase().includes(search.toLowerCase()) ||
    p.invoiceNumber?.toLowerCase().includes(search.toLowerCase())
  );

  if (!perm.isLoading && !perm.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center py-32 text-muted-foreground gap-3">
          <AlertTriangle className="w-10 h-10 text-destructive/50" />
          <p className="text-lg font-medium">Access Denied</p>
          <p className="text-sm">You don't have permission to view Purchases.</p>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><ShoppingCart className="w-6 h-6 text-primary" /> Purchase Bills</h1>
            <p className="text-muted-foreground mt-1">Record purchases with GST, HSN code & discounts</p>
          </div>
          <div className="flex gap-2">
            {perm.canDownload && (
              <Button variant="outline" size="sm" onClick={() => downloadCSV('purchases.csv', filtered.map(p => ({
                'Bill #': p.id, Date: p.purchaseDate, Vendor: p.vendorName, Invoice: p.invoiceNumber || '',
                Items: (p.lineItems as any[])?.length || 0,
                'Taxable': Number((p as any).discountTotal ? Number(p.totalAmount) - Number((p as any).taxTotal || 0) : p.totalAmount),
                'Tax': Number((p as any).taxTotal || 0),
                'Total': Number(p.totalAmount),
              })))}>
                <Download className="w-4 h-4 mr-2" /> Export
              </Button>
            )}
            {perm.canAdd && (
              <Button onClick={() => { form.reset({ vendorId: 0, purchaseDate: new Date().toISOString().split('T')[0], invoiceNumber: '', lineItems: [defaultLine], notes: '' }); setIsOpen(true); }}>
                <Plus className="w-4 h-4 mr-2" /> New Purchase Bill
              </Button>
            )}
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex items-center gap-2 bg-muted/20">
            <Search className="w-4 h-4 text-muted-foreground shrink-0" />
            <Input placeholder="Search vendor or invoice..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0 max-w-sm" />
          </div>
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Bill #</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead>Invoice Ref</TableHead>
                <TableHead>Items</TableHead>
                <TableHead className="text-right">Tax</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(3)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={8}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={8} className="text-center py-16 text-muted-foreground">
                  <ShoppingCart className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No purchase bills yet</p>
                </TableCell></TableRow>
              ) : filtered.map(p => (
                <TableRow key={p.id} className="hover:bg-muted/10">
                  <TableCell className="font-mono text-primary font-bold text-sm">#{String(p.id).padStart(4, '0')}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    <div className="flex items-center gap-1"><Calendar className="w-3 h-3" />{new Date(p.purchaseDate).toLocaleDateString('en-IN')}</div>
                  </TableCell>
                  <TableCell className="font-medium">{p.vendorName}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">{p.invoiceNumber || '—'}</TableCell>
                  <TableCell><Badge variant="secondary">{(p.lineItems as any[])?.length || 0} items</Badge></TableCell>
                  <TableCell className="text-right font-mono text-xs text-muted-foreground">
                    {Number((p as any).taxTotal || 0) > 0 ? `₹${fmt(Number((p as any).taxTotal || 0))}` : '—'}
                  </TableCell>
                  <TableCell className="text-right font-mono font-bold text-primary">₹{fmt(Number(p.totalAmount))}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(p)}><Eye className="w-4 h-4" /></Button>
                      {perm.canEdit && (
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => { setEditItem(p); editForm.reset({ purchaseDate: p.purchaseDate, invoiceNumber: p.invoiceNumber || '', notes: (p as any).notes || '' }); }}>
                          <Edit2 className="w-4 h-4" />
                        </Button>
                      )}
                      {perm.canDelete && (
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-destructive" onClick={() => setDeleteTarget(p)}>
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* ── New Purchase Bill Dialog ── */}
      <Dialog open={isOpen} onOpenChange={v => { setIsOpen(v); if (!v) form.reset(); }}>
        <DialogContent className="sm:max-w-5xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New Purchase Bill</DialogTitle>
            <DialogDescription>Enter purchase details with HSN, GST rate and discount per item</DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6 pt-2">
              {/* Header */}
              <div className="grid grid-cols-3 gap-4">
                <FormField control={form.control} name="vendorId" render={({ field }) => (
                  <FormItem><FormLabel>Vendor <span className="text-destructive">*</span></FormLabel>
                    <Select onValueChange={v => field.onChange(Number(v))} value={field.value ? String(field.value) : ''}>
                      <FormControl><SelectTrigger><SelectValue placeholder="Select vendor" /></SelectTrigger></FormControl>
                      <SelectContent>{vendors.map((v: any) => <SelectItem key={v.id} value={String(v.id)}>{v.name}</SelectItem>)}</SelectContent>
                    </Select><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="purchaseDate" render={({ field }) => (
                  <FormItem><FormLabel>Date <span className="text-destructive">*</span></FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="invoiceNumber" render={({ field }) => (
                  <FormItem><FormLabel>Invoice Ref #</FormLabel><FormControl><Input placeholder="Vendor's invoice no." {...field} /></FormControl></FormItem>
                )} />
              </div>

              {/* Line Items */}
              <div>
                <div className="text-sm font-medium mb-2">Line Items</div>
                <div className="border border-border rounded-lg overflow-hidden">
                  <div className="grid bg-muted/30 text-xs font-medium text-muted-foreground uppercase tracking-wide px-3 py-2" style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1fr 1fr auto' }}>
                    <span>Item</span><span>HSN</span><span>Qty</span><span>Rate ₹</span><span>Disc %</span><span>GST %</span><span className="text-right">Total ₹</span><span />
                  </div>
                  {fields.map((field, index) => {
                    const li = watchLines[index] || {};
                    const calc = calcLine(Number(li.quantity) || 0, Number(li.unitCost) || 0, Number(li.discount) || 0, Number(li.gstRate) || 0, li.taxType || 'intra');
                    return (
                      <div key={field.id} className="grid items-center gap-2 px-3 py-2 border-t border-border" style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1fr 1fr auto' }}>
                        {/* Item type + item selector combined */}
                        <div className="flex gap-1">
                          <Select onValueChange={v => form.setValue(`lineItems.${index}.materialType`, v as any)} value={form.watch(`lineItems.${index}.materialType`)}>
                            <SelectTrigger className="w-[90px] text-xs h-8"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="raw_material">Raw</SelectItem>
                              <SelectItem value="material">Material</SelectItem>
                              <SelectItem value="item">Finished</SelectItem>
                            </SelectContent>
                          </Select>
                          <Select onValueChange={v => form.setValue(`lineItems.${index}.materialId`, Number(v))} value={form.watch(`lineItems.${index}.materialId`) ? String(form.watch(`lineItems.${index}.materialId`)) : ''}>
                            <SelectTrigger className="h-8 text-xs flex-1 min-w-0"><SelectValue placeholder="Select" /></SelectTrigger>
                            <SelectContent>
                              {(form.watch(`lineItems.${index}.materialType`) === 'raw_material' ? rawMaterials : form.watch(`lineItems.${index}.materialType`) === 'item' ? finishedItems : materials).map((m: any) => (
                                <SelectItem key={m.id} value={String(m.id)}>{m.name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <Input className="h-8 text-xs font-mono" placeholder="HSN" {...form.register(`lineItems.${index}.hsnCode`)} />
                        <Input className="h-8 text-xs text-right" type="number" min={0} step="0.001" {...form.register(`lineItems.${index}.quantity`)} />
                        <Input className="h-8 text-xs text-right" type="number" min={0} step="0.01" {...form.register(`lineItems.${index}.unitCost`)} />
                        <Input className="h-8 text-xs text-right" type="number" min={0} max={100} step="0.1" placeholder="0" {...form.register(`lineItems.${index}.discount`)} />
                        <div className="flex gap-1 items-center">
                          <Select onValueChange={v => form.setValue(`lineItems.${index}.gstRate`, Number(v))} value={String(form.watch(`lineItems.${index}.gstRate`) ?? 5)}>
                            <SelectTrigger className="h-8 text-xs w-[56px]"><SelectValue /></SelectTrigger>
                            <SelectContent>{GST_RATES.map(r => <SelectItem key={r} value={String(r)}>{r}%</SelectItem>)}</SelectContent>
                          </Select>
                          <Select onValueChange={v => form.setValue(`lineItems.${index}.taxType`, v as any)} value={form.watch(`lineItems.${index}.taxType`) || 'intra'}>
                            <SelectTrigger className="h-8 text-xs w-[52px]"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="intra">Intra</SelectItem>
                              <SelectItem value="inter">Inter</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="text-right text-sm font-mono font-medium">₹{fmt(calc.lineTotal)}</div>
                        <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => remove(index)} disabled={fields.length === 1}>
                          <X className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    );
                  })}
                </div>
                <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => append({ ...defaultLine })}>
                  <Plus className="w-3.5 h-3.5 mr-1" /> Add Line
                </Button>
              </div>

              {/* Bill Summary */}
              <div className="grid grid-cols-2 gap-6">
                <FormField control={form.control} name="notes" render={({ field }) => (
                  <FormItem><FormLabel>Notes</FormLabel><FormControl><Textarea rows={3} placeholder="Optional notes" {...field} /></FormControl></FormItem>
                )} />
                <div className="bg-muted/20 rounded-lg p-4 space-y-2 text-sm">
                  <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span className="font-mono">₹{fmt(billSummary.subtotal)}</span></div>
                  {billSummary.discountTotal > 0 && (
                    <div className="flex justify-between"><span className="text-muted-foreground">(-) Discount</span><span className="font-mono text-red-500">-₹{fmt(billSummary.discountTotal)}</span></div>
                  )}
                  <div className="flex justify-between"><span className="text-muted-foreground">Taxable Amount</span><span className="font-mono">₹{fmt(billSummary.taxableTotal)}</span></div>
                  <Separator />
                  {billSummary.cgstTotal > 0 && <div className="flex justify-between"><span className="text-muted-foreground">CGST</span><span className="font-mono">₹{fmt(billSummary.cgstTotal)}</span></div>}
                  {billSummary.sgstTotal > 0 && <div className="flex justify-between"><span className="text-muted-foreground">SGST</span><span className="font-mono">₹{fmt(billSummary.sgstTotal)}</span></div>}
                  {billSummary.igstTotal > 0 && <div className="flex justify-between"><span className="text-muted-foreground">IGST</span><span className="font-mono">₹{fmt(billSummary.igstTotal)}</span></div>}
                  {Math.abs(roundOff) > 0.001 && <div className="flex justify-between"><span className="text-muted-foreground">Round Off</span><span className="font-mono">{roundOff > 0 ? '+' : ''}₹{fmt(Math.abs(roundOff))}</span></div>}
                  <Separator />
                  <div className="flex justify-between font-bold text-base pt-1"><span>Grand Total</span><span className="font-mono text-primary">₹{grandTotal.toLocaleString('en-IN')}</span></div>
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => setIsOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createMutation.isPending}>{createMutation.isPending ? 'Saving…' : 'Save Purchase Bill'}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* ── View Bill Sheet ── */}
      <Sheet open={!!viewItem} onOpenChange={v => !v && setViewItem(null)}>
        <SheetContent className="sm:max-w-2xl overflow-y-auto">
          {viewItem && (
            <>
              <SheetHeader className="mb-4">
                <SheetTitle className="text-primary">Purchase Bill #{String(viewItem.id).padStart(4, '0')}</SheetTitle>
                <SheetDescription>
                  {viewItem.vendorName} · {new Date(viewItem.purchaseDate).toLocaleDateString('en-IN')}
                  {viewItem.invoiceNumber && ` · Ref: ${viewItem.invoiceNumber}`}
                </SheetDescription>
              </SheetHeader>

              {/* Line items table */}
              <div className="border border-border rounded-lg overflow-hidden mb-4">
                <table className="w-full text-xs">
                  <thead className="bg-muted/30">
                    <tr>
                      <th className="text-left px-3 py-2">Item</th>
                      <th className="text-left px-2 py-2">HSN</th>
                      <th className="text-right px-2 py-2">Qty</th>
                      <th className="text-right px-2 py-2">Rate</th>
                      <th className="text-right px-2 py-2">Disc%</th>
                      <th className="text-right px-2 py-2">Taxable</th>
                      <th className="text-right px-2 py-2">CGST</th>
                      <th className="text-right px-2 py-2">SGST</th>
                      <th className="text-right px-2 py-2">IGST</th>
                      <th className="text-right px-3 py-2">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(viewItem.lineItems as any[])?.map((li: any, i: number) => (
                      <tr key={i} className="border-t border-border hover:bg-muted/10">
                        <td className="px-3 py-2 font-medium">{getMaterialName(li)}</td>
                        <td className="px-2 py-2 font-mono text-muted-foreground">{li.hsnCode || '—'}</td>
                        <td className="text-right px-2 py-2">{li.quantity}</td>
                        <td className="text-right px-2 py-2 font-mono">₹{fmt(Number(li.unitCost))}</td>
                        <td className="text-right px-2 py-2">{Number(li.discount || 0) > 0 ? `${li.discount}%` : '—'}</td>
                        <td className="text-right px-2 py-2 font-mono">₹{fmt(Number(li.taxableValue || (li.quantity * li.unitCost)))}</td>
                        <td className="text-right px-2 py-2 font-mono">{Number(li.cgst || 0) > 0 ? `₹${fmt(Number(li.cgst))}` : '—'}</td>
                        <td className="text-right px-2 py-2 font-mono">{Number(li.sgst || 0) > 0 ? `₹${fmt(Number(li.sgst))}` : '—'}</td>
                        <td className="text-right px-2 py-2 font-mono">{Number(li.igst || 0) > 0 ? `₹${fmt(Number(li.igst))}` : '—'}</td>
                        <td className="text-right px-3 py-2 font-mono font-bold">₹{fmt(Number(li.lineTotal || li.quantity * li.unitCost))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Summary */}
              <div className="bg-muted/20 rounded-lg p-4 space-y-2 text-sm mb-4">
                {Number(viewItem.discountTotal || 0) > 0 && (
                  <div className="flex justify-between"><span className="text-muted-foreground">(-) Discount</span><span className="font-mono text-red-500">-₹{fmt(Number(viewItem.discountTotal))}</span></div>
                )}
                {Number(viewItem.taxTotal || 0) > 0 && (
                  <div className="flex justify-between"><span className="text-muted-foreground">Tax</span><span className="font-mono">₹{fmt(Number(viewItem.taxTotal))}</span></div>
                )}
                {Math.abs(Number(viewItem.roundOff || 0)) > 0.001 && (
                  <div className="flex justify-between"><span className="text-muted-foreground">Round Off</span><span className="font-mono">₹{fmt(Number(viewItem.roundOff))}</span></div>
                )}
                <Separator />
                <div className="flex justify-between font-bold text-base"><span>Grand Total</span><span className="font-mono text-primary">₹{fmt(Number(viewItem.totalAmount))}</span></div>
              </div>

              {viewItem.notes && <p className="text-sm text-muted-foreground italic mb-4">{viewItem.notes}</p>}
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* ── Edit Dialog ── */}
      <Dialog open={!!editItem} onOpenChange={v => !v && setEditItem(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Edit Purchase Bill #{editItem?.id}</DialogTitle></DialogHeader>
          <Form {...editForm}>
            <form onSubmit={editForm.handleSubmit(onEditSubmit)} className="space-y-4 pt-2">
              <FormField control={editForm.control} name="purchaseDate" render={({ field }) => (
                <FormItem><FormLabel>Date</FormLabel><FormControl><Input type="date" {...field} /></FormControl></FormItem>
              )} />
              <FormField control={editForm.control} name="invoiceNumber" render={({ field }) => (
                <FormItem><FormLabel>Invoice Ref</FormLabel><FormControl><Input {...field} /></FormControl></FormItem>
              )} />
              <FormField control={editForm.control} name="notes" render={({ field }) => (
                <FormItem><FormLabel>Notes</FormLabel><FormControl><Textarea rows={2} {...field} /></FormControl></FormItem>
              )} />
              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => setEditItem(null)}>Cancel</Button>
                <Button type="submit" disabled={updateMutation.isPending}>{updateMutation.isPending ? 'Saving…' : 'Save Changes'}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* ── Delete Confirm ── */}
      <Dialog open={!!deleteTarget} onOpenChange={v => !v && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle className="text-destructive flex items-center gap-2"><Trash2 className="w-5 h-5" />Delete Purchase Bill</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            Delete bill <span className="font-semibold text-foreground">#{deleteTarget?.id}</span> from <span className="font-semibold">{deleteTarget?.vendorName}</span>?
            <br /><span className="text-destructive text-xs font-medium mt-1 block">Stock additions from this bill will be reversed.</span>
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteMutation.isPending}>
              {deleteMutation.isPending ? 'Deleting…' : 'Delete & Reverse Stock'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
