import { useState } from 'react';
import {
  useListBomTemplates,
  useCreateBomTemplate,
  useUpdateBomTemplate,
  useDeleteBomTemplate,
  useListItems,
  useListMaterials,
  useListRawMaterials,
  type BomTemplate,
  type BomLine,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter,
} from '@/components/ui/sheet';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Plus, Trash2, ClipboardList, Edit2, Search } from 'lucide-react';
import { toast } from 'sonner';

interface LineFormState {
  materialType: 'material' | 'raw_material';
  materialId: number;
  quantity: number;
}

export default function BomTemplates() {
  const { data: templates = [], isLoading } = useListBomTemplates();
  const { data: items = [] } = useListItems();
  const { data: materials = [] } = useListMaterials();
  const { data: rawMaterials = [] } = useListRawMaterials();

  const createMutation = useCreateBomTemplate();
  const updateMutation = useUpdateBomTemplate();
  const deleteMutation = useDeleteBomTemplate();

  const [search, setSearch] = useState('');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<BomTemplate | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BomTemplate | null>(null);

  // Sheet form state
  const [selectedItemId, setSelectedItemId] = useState<number>(0);
  const [lines, setLines] = useState<LineFormState[]>([{ materialType: 'raw_material', materialId: 0, quantity: 1 }]);
  const [notes, setNotes] = useState('');

  const filtered = templates.filter(t =>
    t.itemName?.toLowerCase().includes(search.toLowerCase())
  );

  // Items that don't already have a template (for create mode)
  const takenItemIds = new Set(templates.map(t => t.itemId));
  const availableItems = editTarget
    ? items // when editing, show all items (the item is already chosen)
    : items.filter(i => !takenItemIds.has(i.id));

  function openCreate() {
    setEditTarget(null);
    setSelectedItemId(0);
    setLines([{ materialType: 'raw_material', materialId: 0, quantity: 1 }]);
    setNotes('');
    setSheetOpen(true);
  }

  function openEdit(t: BomTemplate) {
    setEditTarget(t);
    setSelectedItemId(t.itemId);
    setLines(
      t.lines.length > 0
        ? t.lines.map(l => ({ materialType: l.materialType, materialId: l.materialId, quantity: l.quantity }))
        : [{ materialType: 'raw_material', materialId: 0, quantity: 1 }]
    );
    setNotes(t.notes ?? '');
    setSheetOpen(true);
  }

  function addLine() {
    setLines(prev => [...prev, { materialType: 'raw_material', materialId: 0, quantity: 1 }]);
  }

  function removeLine(i: number) {
    setLines(prev => prev.filter((_, idx) => idx !== i));
  }

  function updateLine<K extends keyof LineFormState>(i: number, key: K, val: LineFormState[K]) {
    setLines(prev => prev.map((l, idx) => idx === i ? { ...l, [key]: val } : l));
  }

  function validate(): string | null {
    if (!selectedItemId) return 'Select a finished item.';
    if (lines.length === 0) return 'Add at least one material line.';
    for (const l of lines) {
      if (!l.materialId) return 'Select a material for each line.';
      if (l.quantity <= 0) return 'All quantities must be greater than 0.';
    }
    return null;
  }

  async function handleSave() {
    const err = validate();
    if (err) { toast.error(err); return; }

    const payload: BomLine[] = lines.map(l => ({
      materialType: l.materialType,
      materialId: l.materialId,
      quantity: l.quantity,
    }));

    if (editTarget) {
      updateMutation.mutate(
        { id: editTarget.id, data: { lines: payload, notes: notes || undefined } },
        {
          onSuccess: () => { toast.success('BOM template updated'); setSheetOpen(false); },
          onError: () => toast.error('Failed to update template'),
        }
      );
    } else {
      createMutation.mutate(
        { itemId: selectedItemId, lines: payload, notes: notes || undefined },
        {
          onSuccess: () => { toast.success('BOM template created'); setSheetOpen(false); },
          onError: () => toast.error('Failed to create template'),
        }
      );
    }
  }

  function handleDelete() {
    if (!deleteTarget) return;
    deleteMutation.mutate(deleteTarget.id, {
      onSuccess: () => { toast.success('BOM template deleted'); setDeleteTarget(null); },
      onError: () => toast.error('Failed to delete template'),
    });
  }

  const isSaving = createMutation.isPending || updateMutation.isPending;

  return (
    <AppLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <ClipboardList className="w-6 h-6 text-primary" /> BOM Templates
            </h1>
            <p className="text-muted-foreground mt-1">
              Define the standard material recipe for each finished item
            </p>
          </div>
          <Button onClick={openCreate} disabled={availableItems.length === 0 && !editTarget}>
            <Plus className="w-4 h-4 mr-2" /> New Template
          </Button>
        </div>

        {/* Table */}
        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex items-center gap-2 bg-muted/20">
            <Search className="w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search by item…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="border-transparent bg-transparent focus-visible:ring-0 max-w-xs"
            />
          </div>
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Finished Item</TableHead>
                <TableHead>Material Lines</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead>Last Updated</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                [...Array(3)].map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={5}>
                      <div className="h-8 bg-muted/30 rounded animate-pulse" />
                    </TableCell>
                  </TableRow>
                ))
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-16 text-muted-foreground">
                    <ClipboardList className="w-10 h-10 mx-auto mb-3 opacity-20" />
                    <p>No BOM templates yet</p>
                    <p className="text-xs mt-1">Create a template to auto-fill production runs</p>
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map(t => (
                  <TableRow key={t.id} className="hover:bg-muted/10">
                    <TableCell className="font-medium">{t.itemName}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{t.lines.length} materials</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm max-w-[200px] truncate">
                      {t.notes || '—'}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {t.updatedAt ? new Date(t.updatedAt).toLocaleDateString('en-IN') : '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost" size="icon" className="h-8 w-8 hover:text-primary"
                          onClick={() => openEdit(t)}
                        >
                          <Edit2 className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost" size="icon" className="h-8 w-8 hover:text-destructive"
                          onClick={() => setDeleteTarget(t)}
                        >
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

      {/* Create / Edit Sheet */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{editTarget ? 'Edit BOM Template' : 'New BOM Template'}</SheetTitle>
            <SheetDescription>
              Define the standard materials consumed to produce one batch of this item.
            </SheetDescription>
          </SheetHeader>

          <div className="mt-6 space-y-6">
            {/* Item selector */}
            <div className="space-y-2">
              <Label>Finished Item <span className="text-destructive">*</span></Label>
              <Select
                value={selectedItemId ? String(selectedItemId) : ''}
                onValueChange={v => setSelectedItemId(Number(v))}
                disabled={!!editTarget}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select item…" />
                </SelectTrigger>
                <SelectContent>
                  {(editTarget ? items : availableItems).map(i => (
                    <SelectItem key={i.id} value={String(i.id)}>{i.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!editTarget && availableItems.length === 0 && (
                <p className="text-xs text-amber-500">All items already have BOM templates.</p>
              )}
            </div>

            {/* Material lines */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>Material Lines <span className="text-destructive">*</span></Label>
                <Button type="button" variant="outline" size="sm" onClick={addLine}>
                  <Plus className="w-3 h-3 mr-1" /> Add Line
                </Button>
              </div>

              {lines.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-4 border border-dashed rounded-lg">
                  No lines yet — click "Add Line" to start.
                </p>
              )}

              {lines.map((line, i) => {
                const opts = line.materialType === 'raw_material' ? rawMaterials : materials;
                return (
                  <div key={i} className="grid grid-cols-11 gap-2 items-end p-3 bg-muted/20 rounded-lg border border-border">
                    {/* Type */}
                    <div className="col-span-3">
                      <Label className="text-xs mb-1 block">Type</Label>
                      <Select
                        value={line.materialType}
                        onValueChange={v => {
                          updateLine(i, 'materialType', v as 'material' | 'raw_material');
                          updateLine(i, 'materialId', 0);
                        }}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="raw_material">Raw Material</SelectItem>
                          <SelectItem value="material">Packaging</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Material */}
                    <div className="col-span-5">
                      <Label className="text-xs mb-1 block">Material</Label>
                      <Select
                        value={line.materialId ? String(line.materialId) : ''}
                        onValueChange={v => updateLine(i, 'materialId', Number(v))}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder="Select…" />
                        </SelectTrigger>
                        <SelectContent>
                          {(opts as any[]).map(o => (
                            <SelectItem key={o.id} value={String(o.id)}>{o.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Quantity */}
                    <div className="col-span-2">
                      <Label className="text-xs mb-1 block">Qty</Label>
                      <Input
                        type="number"
                        step="0.01"
                        min="0.01"
                        className="h-8 text-xs"
                        value={line.quantity}
                        onChange={e => updateLine(i, 'quantity', parseFloat(e.target.value) || 0)}
                      />
                    </div>

                    {/* Remove */}
                    <div className="col-span-1 pb-0.5 flex justify-end">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={() => removeLine(i)}
                        disabled={lines.length === 1}
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Notes */}
            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea
                placeholder="Optional notes about this BOM…"
                rows={2}
                value={notes}
                onChange={e => setNotes(e.target.value)}
              />
            </div>
          </div>

          <SheetFooter className="mt-6 flex gap-2 justify-end">
            <Button variant="outline" onClick={() => setSheetOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving ? 'Saving…' : editTarget ? 'Update Template' : 'Create Template'}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* Delete confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={v => !v && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete BOM Template?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the BOM template for <strong>{deleteTarget?.itemName}</strong>.
              Existing production records are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
