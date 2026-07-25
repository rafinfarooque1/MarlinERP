import { useState } from 'react';
import {
  useListProductions, useCreateProduction, useListItems, useListRawMaterials,
  useListMaterials, getListProductionsQueryKey,
  useUpdateProduction, useDeleteProduction,
  useGetBomTemplateByItem, useGetCompanySettings,
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
import { Plus, Search, Factory, Download, Eye, Calendar, Trash2, Edit2, AlertTriangle, Recycle, ClipboardList } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';
import { usePermission } from '@/lib/usePermission';

const schema = z.object({
  itemId: z.coerce.number().min(1, 'Item required'),
  producedQuantity: z.coerce.number().min(1, 'Quantity > 0'),
  productionDate: z.string().min(1, 'Date required'),
  batchNumber: z.string().optional(),
  mfgDate: z.string().optional(),
  expiryDate: z.string().optional(),
  materialUsed: z.array(z.object({
    materialType: z.enum(['material', 'raw_material']),
    materialId: z.coerce.number().min(1, 'Select material'),
    usedQuantity: z.coerce.number().min(0.01, 'Qty > 0'),
  })).min(1, 'Add at least one material'),
  overheadPercent: z.coerce.number().min(0, 'Min 0%').max(100, 'Max 100%').optional(),
  wastage: z.array(z.object({
    quantity: z.coerce.number().min(0.001, 'Qty > 0'),
    reason: z.string().min(1, 'Reason required'),
  })).optional(),
  notes: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

const editSchema = z.object({
  productionDate: z.string().min(1, 'Date required'),
  notes: z.string().optional(),
});
type EditFormValues = z.infer<typeof editSchema>;

const defaultLine = { materialType: 'raw_material' as const, materialId: 0, usedQuantity: 1 };
const defaultValues: FormValues = {
  itemId: 0,
  producedQuantity: 1,
  productionDate: new Date().toISOString().split('T')[0],
  batchNumber: '',
  mfgDate: '',
  expiryDate: '',
  materialUsed: [defaultLine],
  overheadPercent: 0,
  wastage: [],
  notes: '',
};

const inr = (n: number | null | undefined, dashWhenNull = true) =>
  n === null || n === undefined
    ? (dashWhenNull ? '—' : '₹0.00')
    : `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const fmtQty = (n: number) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 3 });

export default function ProductionList() {
  const perm = usePermission('Production');
  const { data: productions = [], isLoading } = useListProductions();
  const { data: items = [] } = useListItems();
  const { data: rawMaterials = [] } = useListRawMaterials();
  const { data: materials = [] } = useListMaterials();
  const { data: companySettings } = useGetCompanySettings();
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [editItem, setEditItem] = useState<any>(null);
  const [viewItem, setViewItem] = useState<any>(null);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const queryClient = useQueryClient();
  const createMutation = useCreateProduction();
  const updateMutation = useUpdateProduction();
  const deleteMutation = useDeleteProduction();

  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues });
  const { fields, append, remove, replace } = useFieldArray({ control: form.control, name: 'materialUsed' });
  const { fields: wastageFields, append: appendWastage, remove: removeWastage } = useFieldArray({ control: form.control, name: 'wastage' });

  const editForm = useForm<EditFormValues>({
    resolver: zodResolver(editSchema),
    defaultValues: { productionDate: '', notes: '' },
  });

  // ── Live costing & BOM comparison (create dialog) ─────────────────────────
  const wItemId = Number(form.watch('itemId')) || 0;
  const wProduced = Number(form.watch('producedQuantity')) || 0;
  const wMaterials = form.watch('materialUsed');
  const wWastage = form.watch('wastage');
  const wOverhead = Number(form.watch('overheadPercent')) || 0;

  const { data: bomTemplate } = useGetBomTemplateByItem(wItemId, { enabled: isOpen && wItemId > 0 });

  const matInfo = (type: string | undefined, id: number) => {
    const list = type === 'raw_material' ? rawMaterials : materials;
    return (list as any[]).find(m => m.id === id);
  };
  const matName = (type: string, id: number) => matInfo(type, id)?.name ?? `#${id}`;

  const wastageQty = (wWastage ?? []).reduce((s, w) => s + (Number(w?.quantity) || 0), 0);
  const grossOut = wProduced + wastageQty;

  const estMaterialCost = (wMaterials ?? []).reduce((s, l) => {
    const info = matInfo(l?.materialType, Number(l?.materialId));
    return s + (Number(l?.usedQuantity) || 0) * Math.max(0, Number(info?.cost ?? 0));
  }, 0);
  const estOverhead = estMaterialCost * wOverhead / 100;
  const estTotal = estMaterialCost + estOverhead;
  const estPerUnit = wProduced > 0 ? estTotal / wProduced : 0;

  // Over-consumption vs BOM (allowed = per-unit qty × gross output incl. wastage)
  const bomOver: Array<{ name: string; used: number; allowed: number; unit: string }> = [];
  const bomExtra: Array<{ name: string; used: number }> = [];
  if (bomTemplate?.lines?.length && grossOut > 0) {
    for (const bl of bomTemplate.lines) {
      const used = (wMaterials ?? [])
        .filter(l => l?.materialType === bl.materialType && Number(l?.materialId) === bl.materialId)
        .reduce((s, l) => s + (Number(l?.usedQuantity) || 0), 0);
      const allowed = bl.quantity * grossOut;
      if (used > allowed + 1e-9) {
        bomOver.push({ name: matName(bl.materialType, bl.materialId), used, allowed, unit: matInfo(bl.materialType, bl.materialId)?.unit ?? '' });
      }
    }
    const extraMap = new Map<string, { name: string; used: number }>();
    for (const l of wMaterials ?? []) {
      const id = Number(l?.materialId);
      if (!id) continue;
      if (!bomTemplate.lines.some(bl => bl.materialType === l.materialType && bl.materialId === id)) {
        const key = `${l.materialType}:${id}`;
        const cur = extraMap.get(key) ?? { name: matName(l.materialType!, id), used: 0 };
        cur.used += Number(l?.usedQuantity) || 0;
        extraMap.set(key, cur);
      }
    }
    for (const e of extraMap.values()) if (e.used > 0) bomExtra.push(e);
  }

  const loadFromBom = () => {
    if (!bomTemplate?.lines?.length) return;
    const scale = grossOut > 0 ? grossOut : 1;
    replace(bomTemplate.lines.map(l => ({
      materialType: l.materialType,
      materialId: l.materialId,
      usedQuantity: Math.round(l.quantity * scale * 1000) / 1000,
    })));
    toast.info(`Materials loaded from BOM for ${fmtQty(scale)} units`);
  };

  const openCreate = () => {
    form.reset({
      ...defaultValues,
      productionDate: new Date().toISOString().split('T')[0],
      overheadPercent: Number((companySettings as any)?.productionOverheadPercent ?? 0),
    });
    setIsOpen(true);
  };

  const onSubmit = (data: FormValues) => {
    const payload = {
      ...data,
      wastage: (data.wastage ?? []).filter(w => Number(w.quantity) > 0),
    };
    createMutation.mutate({ data: payload as any }, {
      onSuccess: () => {
        toast.success('Production batch recorded');
        queryClient.invalidateQueries({ queryKey: getListProductionsQueryKey() });
        setIsOpen(false);
        form.reset(defaultValues);
      },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  const onEditSubmit = (data: EditFormValues) => {
    updateMutation.mutate({ id: editItem.id, data }, {
      onSuccess: () => {
        toast.success('Batch updated');
        setEditItem(null);
      },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  const handleDelete = () => {
    if (!deleteTarget) return;
    deleteMutation.mutate(deleteTarget.id, {
      onSuccess: () => {
        toast.success(`Batch B-${String(deleteTarget.id).padStart(4, '0')} deleted`);
        setDeleteTarget(null);
      },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Delete failed'),
    });
  };

  const filtered = productions.filter(p => p.itemName?.toLowerCase().includes(search.toLowerCase()));

  if (!perm.isLoading && !perm.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center py-32 text-muted-foreground gap-3">
          <AlertTriangle className="w-10 h-10 text-destructive/50" />
          <p className="text-lg font-medium">Access Denied</p>
          <p className="text-sm">You don't have permission to view Production.</p>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Factory className="w-6 h-6 text-primary" /> Production Batches
            </h1>
            <p className="text-muted-foreground mt-1">Record finished goods production runs</p>
          </div>
          <div className="flex gap-2">
            {perm.canDownload && (
              <Button variant="outline" size="sm" onClick={() => downloadCSV('production.csv', filtered.map(p => ({
                Batch: (p as any).batchNumber || `B-${String(p.id).padStart(4, '0')}`,
                Date: p.productionDate, Item: p.itemName, Qty: p.producedQuantity,
                'Wastage Qty': (p as any).wastageQty || 0,
                'Material Cost': (p as any).materialCost ?? '',
                'Overhead': (p as any).overheadAmount ?? '',
                'Total Cost': (p as any).totalCost ?? '',
                'Cost/Unit': (p as any).costPerUnit ?? '',
                Materials: p.materialUsed?.length || 0,
              })))}>
                <Download className="w-4 h-4 mr-2" /> Export
              </Button>
            )}
            {perm.canAdd && (
              <Button onClick={openCreate}>
                <Plus className="w-4 h-4 mr-2" /> New Batch
              </Button>
            )}
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex items-center gap-2 bg-muted/20">
            <Search className="w-4 h-4 text-muted-foreground" />
            <Input placeholder="Search by item..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0 max-w-xs" />
          </div>
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Batch</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>Qty Produced</TableHead>
                <TableHead className="text-right">Cost/Unit</TableHead>
                <TableHead className="text-right">Wastage</TableHead>
                <TableHead>Expiry</TableHead>
                <TableHead>Materials Used</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(3)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={9}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={9} className="text-center py-16 text-muted-foreground">
                  <Factory className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No production batches yet</p>
                </TableCell></TableRow>
              ) : filtered.map(p => (
                <TableRow key={p.id} className="hover:bg-muted/10">
                  <TableCell className="font-mono text-primary font-bold">{(p as any).batchNumber || `B-${String(p.id).padStart(4, '0')}`}</TableCell>
                  <TableCell className="text-sm text-muted-foreground flex items-center gap-1">
                    <Calendar className="w-3 h-3" />{new Date(p.productionDate).toLocaleDateString('en-IN')}
                  </TableCell>
                  <TableCell className="font-medium">{p.itemName}</TableCell>
                  <TableCell className="font-mono font-bold text-emerald-500">{Number(p.producedQuantity).toLocaleString()}</TableCell>
                  <TableCell className="text-right font-mono">
                    {(p as any).costPerUnit != null
                      ? <span className="font-bold">{inr((p as any).costPerUnit)}</span>
                      : <span className="text-xs text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {Number((p as any).wastageQty) > 0
                      ? <span className="text-destructive font-semibold">{fmtQty(Number((p as any).wastageQty))}</span>
                      : <span className="text-xs text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell>{(() => {
                    const e = (p as any).expiryDate;
                    if (!e) return <span className="text-xs text-muted-foreground">—</span>;
                    const days = Math.ceil((new Date(e).getTime() - Date.now()) / 86400000);
                    if (days < 0) return <Badge variant="destructive" className="text-[10px]">Expired {new Date(e).toLocaleDateString('en-IN')}</Badge>;
                    if (days <= 30) return <Badge className="text-[10px] bg-amber-500/10 text-amber-600 border-amber-500/20">{new Date(e).toLocaleDateString('en-IN')} · {days}d</Badge>;
                    return <span className="text-xs text-muted-foreground">{new Date(e).toLocaleDateString('en-IN')}</span>;
                  })()}</TableCell>
                  <TableCell><Badge variant="secondary">{p.materialUsed?.length || 0} materials</Badge></TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(p)}><Eye className="w-4 h-4" /></Button>
                      {perm.canEdit && (
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" title="Edit" onClick={() => {
                          setEditItem(p);
                          editForm.reset({ productionDate: p.productionDate, notes: p.notes || '' });
                        }}><Edit2 className="w-4 h-4" /></Button>
                      )}
                      {perm.canDelete && (
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-destructive" title="Delete" onClick={() => setDeleteTarget(p)}>
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

      {/* Create Dialog */}
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Record Production Batch</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="itemId" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Finished Item <span className="text-destructive">*</span></FormLabel>
                    <Select onValueChange={v => field.onChange(Number(v))} value={field.value ? String(field.value) : ''}>
                      <FormControl><SelectTrigger><SelectValue placeholder="Select item" /></SelectTrigger></FormControl>
                      <SelectContent>{items.map(i => <SelectItem key={i.id} value={String(i.id)}>{i.name}</SelectItem>)}</SelectContent>
                    </Select><FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="producedQuantity" render={({ field }) => (
                  <FormItem><FormLabel>Quantity Produced <span className="text-destructive">*</span></FormLabel><FormControl><Input type="number" min={1} {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="productionDate" render={({ field }) => (
                  <FormItem><FormLabel>Production Date <span className="text-destructive">*</span></FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="batchNumber" render={({ field }) => (
                  <FormItem><FormLabel>Batch # <span className="text-[10px] font-normal text-muted-foreground">(auto if blank)</span></FormLabel><FormControl><Input placeholder="e.g. LOT-A1" className="font-mono" {...field} /></FormControl></FormItem>
                )} />
                <FormField control={form.control} name="mfgDate" render={({ field }) => (
                  <FormItem><FormLabel>Mfg Date <span className="text-[10px] font-normal text-muted-foreground">(defaults to production date)</span></FormLabel><FormControl><Input type="date" {...field} /></FormControl></FormItem>
                )} />
                <FormField control={form.control} name="expiryDate" render={({ field }) => (
                  <FormItem><FormLabel>Expiry Date <span className="text-[10px] font-normal text-amber-500">drives FEFO &amp; expiry alerts</span></FormLabel><FormControl><Input type="date" {...field} /></FormControl></FormItem>
                )} />
              </div>

              <div>
                <div className="flex justify-between items-center mb-3">
                  <p className="font-semibold text-sm">Materials Consumed</p>
                  <div className="flex gap-2">
                    {bomTemplate && bomTemplate.lines?.length > 0 && (
                      <Button type="button" variant="outline" size="sm" onClick={loadFromBom} title="Fill lines from the item's BOM template scaled to output">
                        <ClipboardList className="w-3 h-3 mr-1" /> Load from BOM
                      </Button>
                    )}
                    <Button type="button" variant="outline" size="sm" onClick={() => append(defaultLine)}><Plus className="w-3 h-3 mr-1" /> Add</Button>
                  </div>
                </div>
                <div className="space-y-2">
                  {fields.map((field, i) => {
                    const matType = form.watch(`materialUsed.${i}.materialType`);
                    const opts = matType === 'raw_material' ? rawMaterials : materials;
                    return (
                      <div key={field.id} className="grid grid-cols-11 gap-2 items-end p-3 bg-muted/20 rounded-lg border border-border">
                        <div className="col-span-3">
                          <FormField control={form.control} name={`materialUsed.${i}.materialType`} render={({ field: f }) => (
                            <FormItem><FormLabel className="text-xs">Type</FormLabel>
                              <Select onValueChange={f.onChange} value={f.value}>
                                <FormControl><SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger></FormControl>
                                <SelectContent><SelectItem value="raw_material">Raw Material</SelectItem><SelectItem value="material">Packaging</SelectItem></SelectContent>
                              </Select></FormItem>
                          )} />
                        </div>
                        <div className="col-span-5">
                          <FormField control={form.control} name={`materialUsed.${i}.materialId`} render={({ field: f }) => (
                            <FormItem><FormLabel className="text-xs">Material</FormLabel>
                              <Select onValueChange={v => f.onChange(Number(v))} value={f.value ? String(f.value) : ''}>
                                <FormControl><SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Select" /></SelectTrigger></FormControl>
                                <SelectContent>{(opts as any[]).map(o => <SelectItem key={o.id} value={String(o.id)}>{o.name}</SelectItem>)}</SelectContent>
                              </Select></FormItem>
                          )} />
                        </div>
                        <div className="col-span-2">
                          <FormField control={form.control} name={`materialUsed.${i}.usedQuantity`} render={({ field: f }) => (
                            <FormItem><FormLabel className="text-xs">Qty</FormLabel><FormControl><Input type="number" step="0.01" className="h-8 text-xs" {...f} /></FormControl></FormItem>
                          )} />
                        </div>
                        <div className="col-span-1 pb-1 flex justify-end">
                          <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => remove(i)} disabled={fields.length === 1}><Trash2 className="w-3 h-3" /></Button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* BOM over-consumption warning (non-blocking) */}
                {(bomOver.length > 0 || bomExtra.length > 0) && (
                  <div className="mt-3 p-3 rounded-lg border border-amber-500/40 bg-amber-500/10 space-y-1.5">
                    <p className="text-sm font-semibold text-amber-600 flex items-center gap-1.5">
                      <AlertTriangle className="w-4 h-4" /> Consumption exceeds the BOM template
                    </p>
                    <p className="text-xs text-muted-foreground">
                      BOM allows the following for {fmtQty(grossOut)} units (incl. wastage). You can still record the batch — this is a warning, not a block.
                    </p>
                    <ul className="text-xs space-y-0.5 text-amber-700 dark:text-amber-400">
                      {bomOver.map((w, i) => (
                        <li key={`over-${i}`} className="font-mono">
                          {w.name}: using {fmtQty(w.used)}, BOM allows {fmtQty(w.allowed)} (+{fmtQty(w.used - w.allowed)} over)
                        </li>
                      ))}
                      {bomExtra.map((w, i) => (
                        <li key={`extra-${i}`} className="font-mono">{w.name}: {fmtQty(w.used)} used — not in BOM</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {/* Wastage lines */}
              <div>
                <div className="flex justify-between items-center mb-3">
                  <p className="font-semibold text-sm flex items-center gap-1.5"><Recycle className="w-4 h-4 text-muted-foreground" /> Wastage <span className="text-xs font-normal text-muted-foreground">(optional — scrapped units that never reach stock)</span></p>
                  <Button type="button" variant="outline" size="sm" onClick={() => appendWastage({ quantity: 1, reason: '' })}><Plus className="w-3 h-3 mr-1" /> Add</Button>
                </div>
                {wastageFields.length > 0 && (
                  <div className="space-y-2">
                    {wastageFields.map((field, i) => (
                      <div key={field.id} className="grid grid-cols-11 gap-2 items-end p-3 bg-destructive/5 rounded-lg border border-destructive/20">
                        <div className="col-span-3">
                          <FormField control={form.control} name={`wastage.${i}.quantity`} render={({ field: f }) => (
                            <FormItem><FormLabel className="text-xs">Qty wasted</FormLabel><FormControl><Input type="number" step="0.001" className="h-8 text-xs" {...f} /></FormControl><FormMessage /></FormItem>
                          )} />
                        </div>
                        <div className="col-span-7">
                          <FormField control={form.control} name={`wastage.${i}.reason`} render={({ field: f }) => (
                            <FormItem><FormLabel className="text-xs">Reason</FormLabel><FormControl><Input placeholder="e.g. Damaged in freezing, spillage, QC reject…" className="h-8 text-xs" {...f} /></FormControl><FormMessage /></FormItem>
                          )} />
                        </div>
                        <div className="col-span-1 pb-1 flex justify-end">
                          <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => removeWastage(i)}><Trash2 className="w-3 h-3" /></Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Overhead + live cost estimate */}
              <div className="grid grid-cols-2 gap-4 items-start">
                <FormField control={form.control} name="overheadPercent" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Overhead % <span className="text-[10px] font-normal text-muted-foreground">(power, labor, rent — default from Settings)</span></FormLabel>
                    <FormControl><Input type="number" min={0} max={100} step="0.5" className="font-mono" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <div className="rounded-lg border border-border bg-muted/20 p-3 text-sm space-y-1">
                  <div className="flex justify-between"><span className="text-muted-foreground text-xs">Material cost</span><span className="font-mono">{inr(estMaterialCost, false)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground text-xs">Overhead ({wOverhead}%)</span><span className="font-mono">{inr(estOverhead, false)}</span></div>
                  <div className="flex justify-between border-t border-border pt-1"><span className="text-xs font-semibold">Batch cost</span><span className="font-mono font-bold">{inr(estTotal, false)}</span></div>
                  <div className="flex justify-between"><span className="text-xs font-semibold text-primary">Cost / unit</span><span className="font-mono font-bold text-primary">{inr(estPerUnit, false)}</span></div>
                  {estMaterialCost === 0 && <p className="text-[10px] text-muted-foreground pt-1">Set purchase costs on materials to get batch costing.</p>}
                </div>
              </div>

              <FormField control={form.control} name="notes" render={({ field }) => (
                <FormItem><FormLabel>Notes</FormLabel><FormControl><Textarea placeholder="Optional batch notes..." rows={2} {...field} /></FormControl></FormItem>
              )} />

              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => setIsOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createMutation.isPending}>{createMutation.isPending ? 'Recording…' : 'Record Batch'}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={!!editItem} onOpenChange={v => !v && setEditItem(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Batch B-{editItem && String(editItem.id).padStart(4, '0')}</DialogTitle>
            <DialogDescription>Update the production date or notes. Line items cannot be changed.</DialogDescription>
          </DialogHeader>
          <Form {...editForm}>
            <form onSubmit={editForm.handleSubmit(onEditSubmit)} className="space-y-4 pt-2">
              <FormField control={editForm.control} name="productionDate" render={({ field }) => (
                <FormItem><FormLabel>Production Date</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={editForm.control} name="notes" render={({ field }) => (
                <FormItem><FormLabel>Notes</FormLabel><FormControl><Textarea placeholder="Optional notes..." rows={3} {...field} /></FormControl></FormItem>
              )} />
              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => setEditItem(null)}>Cancel</Button>
                <Button type="submit" disabled={updateMutation.isPending}>{updateMutation.isPending ? 'Saving…' : 'Save Changes'}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <Dialog open={!!deleteTarget} onOpenChange={v => !v && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="w-5 h-5" /> Delete Batch
            </DialogTitle>
            <DialogDescription>
              Delete B-{deleteTarget && String(deleteTarget.id).padStart(4, '0')} ({deleteTarget?.itemName}, {deleteTarget?.producedQuantity} units)?
              <br /><span className="text-destructive font-medium">All material stock will be reversed. This cannot be undone.</span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteMutation.isPending}>
              {deleteMutation.isPending ? 'Deleting…' : 'Delete & Reverse Stock'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* View Sheet */}
      <Sheet open={!!viewItem} onOpenChange={v => !v && setViewItem(null)}>
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{viewItem && ((viewItem as any).batchNumber || `B-${String(viewItem.id).padStart(4, '0')}`)}</SheetTitle>
            <SheetDescription>Production batch details</SheetDescription>
          </SheetHeader>
          {viewItem && (
            <div className="mt-6 space-y-5">
              <div className="grid grid-cols-2 gap-4">
                {[
                  ['Item', viewItem.itemName],
                  ['Date', new Date(viewItem.productionDate).toLocaleDateString('en-IN')],
                  ['Qty Produced', viewItem.producedQuantity],
                  ['Batch #', (viewItem as any).batchNumber || `B-${String(viewItem.id).padStart(4, '0')}`],
                  ['Mfg Date', (viewItem as any).mfgDate ? new Date((viewItem as any).mfgDate).toLocaleDateString('en-IN') : '—'],
                  ['Expiry Date', (viewItem as any).expiryDate ? new Date((viewItem as any).expiryDate).toLocaleDateString('en-IN') : '—'],
                ].map(([k, v]) => (
                  <div key={String(k)} className="flex flex-col gap-1">
                    <span className="text-xs text-muted-foreground uppercase tracking-wider">{k}</span>
                    <span className="font-semibold">{String(v)}</span>
                  </div>
                ))}
              </div>

              {/* Batch costing */}
              <div>
                <p className="text-sm font-semibold mb-2">Batch Costing</p>
                {(viewItem as any).totalCost != null ? (
                  <div className="rounded-lg border border-border bg-muted/20 p-3 text-sm space-y-1.5">
                    <div className="flex justify-between"><span className="text-muted-foreground">Material cost</span><span className="font-mono">{inr((viewItem as any).materialCost)}</span></div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Overhead{(viewItem as any).overheadPercent != null ? ` (${Number((viewItem as any).overheadPercent)}%)` : ''}</span>
                      <span className="font-mono">{inr((viewItem as any).overheadAmount)}</span>
                    </div>
                    <div className="flex justify-between border-t border-border pt-1.5"><span className="font-semibold">Total batch cost</span><span className="font-mono font-bold">{inr((viewItem as any).totalCost)}</span></div>
                    <div className="flex justify-between"><span className="font-semibold text-primary">Cost per unit</span><span className="font-mono font-bold text-primary">{inr((viewItem as any).costPerUnit)}</span></div>
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
                    Not costed — this batch was recorded before batch costing was introduced.
                  </div>
                )}
              </div>

              <div>
                <p className="text-sm font-semibold mb-2">Materials Consumed</p>
                <div className="space-y-2">
                  {(viewItem.materialUsed || []).map((m: any, i: number) => (
                    <div key={i} className="flex justify-between items-center p-3 bg-muted/20 rounded-lg text-sm">
                      <div>
                        <Badge variant="secondary" className="text-xs mr-2">{m.materialType === 'raw_material' ? 'Raw' : 'Pkg'}</Badge>
                        {m.materialName ?? matName(m.materialType, m.materialId)}
                      </div>
                      <div className="text-right">
                        <span className="font-bold">{fmtQty(Number(m.usedQuantity))} {m.unit || 'units'}</span>
                        {m.lineCost != null && <span className="block text-xs text-muted-foreground font-mono">{inr(Number(m.lineCost))}{m.unitCost != null ? ` @ ${inr(Number(m.unitCost))}` : ''}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Wastage */}
              {Number((viewItem as any).wastageQty) > 0 && (
                <div>
                  <p className="text-sm font-semibold mb-2 flex items-center gap-1.5"><Recycle className="w-4 h-4 text-destructive" /> Wastage</p>
                  <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm space-y-1.5">
                    {(((viewItem as any).wastage || []) as any[]).map((w, i) => (
                      <div key={i} className="flex justify-between gap-3">
                        <span className="text-muted-foreground">{w.reason}</span>
                        <span className="font-mono font-semibold text-destructive shrink-0">{fmtQty(Number(w.quantity))}</span>
                      </div>
                    ))}
                    <div className="flex justify-between border-t border-destructive/20 pt-1.5">
                      <span className="font-semibold">Total wasted · value lost</span>
                      <span className="font-mono font-bold text-destructive">{fmtQty(Number((viewItem as any).wastageQty))} · {inr((viewItem as any).wastageValue)}</span>
                    </div>
                  </div>
                </div>
              )}

              {viewItem.notes && <div><span className="text-xs text-muted-foreground">Notes</span><p className="mt-1">{viewItem.notes}</p></div>}
              {perm.canEdit && (
                <Button className="w-full" variant="outline" onClick={() => { setViewItem(null); setEditItem(viewItem); editForm.reset({ productionDate: viewItem.productionDate, notes: viewItem.notes || '' }); }}>
                  <Edit2 className="w-4 h-4 mr-2" /> Edit Batch
                </Button>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </AppLayout>
  );
}
