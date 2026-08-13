import { useEffect, useMemo, useState } from 'react';
import {
  useListWarehouses,
  useStorageLocations,
  useStorageStock,
  useCreateStorageLocation,
  useUpdateStorageLocation,
  useDeleteStorageLocation,
  useMoveStorageStock,
  type StorageLocation,
  type StorageStockRow,
} from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { TransactionDialog, TransactionDialogContent } from '@/components/ui/transaction-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { SummaryCard, SummaryCardGrid } from '@/components/app/summary-card';
import { EmptyState } from '@/components/app/empty-state';
import { toast } from 'sonner';
import {
  Search, Plus, Pencil, Trash2, Snowflake, MoveRight, AlertTriangle, Ban, CircleCheck,
  Warehouse as WarehouseIcon, MoreVertical, Boxes, PackageOpen, Scale, CornerDownRight,
} from 'lucide-react';

const MAT_TYPE_LABELS: Record<string, string> = {
  item: 'Item Name (SKU)',
  material: 'Raw Material',
  raw_material: 'Packing Material',
};

const qty3 = (n: number) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 3 });

interface Perm {
  canAdd: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

export default function StorageLocationsTab({ perm }: { perm: Perm }) {
  const { data: warehouses = [] } = useListWarehouses();
  const [warehouseId, setWarehouseId] = useState<number | null>(null);
  useEffect(() => {
    if (warehouseId == null && warehouses.length > 0) setWarehouseId(Number((warehouses[0] as any).id));
  }, [warehouses, warehouseId]);

  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [materialType, setMaterialType] = useState('all');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const { data: locations = [], isLoading: locsLoading } = useStorageLocations(warehouseId ?? undefined);
  const { data: stockData, isLoading: stockLoading } = useStorageStock(
    warehouseId != null
      ? { warehouseId, q: debounced || undefined, materialType: materialType !== 'all' ? materialType : undefined }
      : null,
  );
  const rows = stockData?.rows ?? [];

  // Hierarchy: roots in list order, children grouped under their parent
  const roots = useMemo(() => locations.filter(l => l.parentId == null), [locations]);
  const childrenOf = useMemo(() => {
    const m = new Map<number, StorageLocation[]>();
    for (const l of locations) {
      if (l.parentId == null) continue;
      if (!m.has(l.parentId)) m.set(l.parentId, []);
      m.get(l.parentId)!.push(l);
    }
    return m;
  }, [locations]);

  // ── Location management dialogs ────────────────────────────────────────────
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState('');
  const [addParent, setAddParent] = useState<StorageLocation | null>(null);
  const [editLoc, setEditLoc] = useState<StorageLocation | null>(null);
  const [editName, setEditName] = useState('');
  const [deleteLoc, setDeleteLoc] = useState<StorageLocation | null>(null);

  const createLoc = useCreateStorageLocation();
  const updateLoc = useUpdateStorageLocation();
  const removeLoc = useDeleteStorageLocation();
  const moveStock = useMoveStorageStock();

  const errMsg = (e: unknown) =>
    (e as any)?.data?.error ?? (e as any)?.body?.error ?? (e as any)?.message ?? 'Something went wrong';

  const openAdd = (parent: StorageLocation | null) => {
    setAddParent(parent);
    setAddName('');
    setAddOpen(true);
  };

  const submitAdd = async () => {
    if (!warehouseId || !addName.trim()) return;
    try {
      await createLoc.mutateAsync({ warehouseId, name: addName.trim(), parentId: addParent?.id ?? null });
      toast.success(addParent ? `Added "${addName.trim()}" inside ${addParent.name}` : `Added "${addName.trim()}"`);
      setAddOpen(false);
      setAddName('');
      setAddParent(null);
    } catch (e) { toast.error(errMsg(e)); }
  };

  const submitRename = async () => {
    if (!editLoc || !editName.trim()) return;
    try {
      await updateLoc.mutateAsync({ id: editLoc.id, name: editName.trim() });
      toast.success('Storage location renamed');
      setEditLoc(null);
    } catch (e) { toast.error(errMsg(e)); }
  };

  const toggleDisabled = async (loc: StorageLocation) => {
    try {
      await updateLoc.mutateAsync({ id: loc.id, isDisabled: !loc.isDisabled });
      toast.success(loc.isDisabled ? `"${loc.name}" enabled` : `"${loc.name}" disabled`);
    } catch (e) { toast.error(errMsg(e)); }
  };

  const submitDelete = async () => {
    if (!deleteLoc) return;
    try {
      await removeLoc.mutateAsync(deleteLoc.id);
      toast.success(`Deleted "${deleteLoc.name}"`);
      setDeleteLoc(null);
    } catch (e) { toast.error(errMsg(e)); }
  };

  // ── Move dialog ─────────────────────────────────────────────────────────────
  const [moveRow, setMoveRow] = useState<StorageStockRow | null>(null);
  const [moveFrom, setMoveFrom] = useState<string>('unassigned');
  const [moveTo, setMoveTo] = useState<string>('');
  const [moveQty, setMoveQty] = useState('');

  const openMove = (row: StorageStockRow) => {
    setMoveRow(row);
    setMoveFrom(row.unassignedQty > 0 || row.placements.length === 0 ? 'unassigned' : String(row.placements[0].storageLocationId));
    setMoveTo('');
    setMoveQty('');
  };

  const fromOptions = useMemo(() => {
    if (!moveRow) return [] as { value: string; label: string; max: number }[];
    const opts: { value: string; label: string; max: number }[] = [
      { value: 'unassigned', label: `Unassigned (${qty3(moveRow.unassignedQty)})`, max: moveRow.unassignedQty },
    ];
    for (const p of moveRow.placements) {
      opts.push({ value: String(p.storageLocationId), label: `${p.name} (${qty3(p.quantity)})`, max: p.quantity });
    }
    return opts;
  }, [moveRow]);

  const toOptions = useMemo(() => {
    const active = locations
      .filter(l => !l.effectiveDisabled)
      .map(l => ({ value: String(l.id), label: l.pathLabel }));
    return [...active, { value: 'unassigned', label: 'Unassigned (remove from storage location)' }];
  }, [locations]);

  const moveMax = fromOptions.find(o => o.value === moveFrom)?.max ?? 0;

  const submitMove = async () => {
    if (!moveRow || warehouseId == null) return;
    const qty = Number(moveQty);
    if (!Number.isFinite(qty) || qty <= 0) { toast.error('Enter a quantity greater than zero'); return; }
    if (!moveTo) { toast.error('Pick a destination'); return; }
    if (moveFrom === moveTo) { toast.error('Source and destination are the same'); return; }
    try {
      await moveStock.mutateAsync({
        warehouseId,
        materialType: moveRow.materialType,
        itemId: moveRow.itemId,
        fromStorageLocationId: moveFrom === 'unassigned' ? null : Number(moveFrom),
        toStorageLocationId: moveTo === 'unassigned' ? null : Number(moveTo),
        quantity: qty,
      });
      toast.success(`Moved ${qty3(qty)} ${moveRow.unit} of ${moveRow.itemName}`);
      setMoveRow(null);
    } catch (e) { toast.error(errMsg(e)); }
  };

  const { sorted, sort } = useTableSort(rows as StorageStockRow[], {
    itemName: (r: StorageStockRow) => r.itemName,
    materialType: (r: StorageStockRow) => MAT_TYPE_LABELS[r.materialType] ?? r.materialType,
    totalQty: (r: StorageStockRow) => r.totalQty,
    placedQty: (r: StorageStockRow) => r.placedQty,
    unassignedQty: (r: StorageStockRow) => r.unassignedQty,
  });

  const totals = useMemo(() => ({
    total: rows.reduce((s, r) => s + r.totalQty, 0),
    placed: rows.reduce((s, r) => s + r.placedQty, 0),
    unassigned: rows.reduce((s, r) => s + r.unassignedQty, 0),
    overAssigned: rows.filter(r => r.overAssignedQty > 0).length,
  }), [rows]);

  const reconciles = totals.overAssigned === 0;

  // ── One storage-location card (root + its sub-locations) ───────────────────
  const LocationCard = ({ loc }: { loc: StorageLocation }) => {
    const kids = childrenOf.get(loc.id) ?? [];
    const rollup = loc.placedQty + loc.childPlacedQty;
    return (
      <div className={`rounded-xl border bg-card shadow-sm flex flex-col ${loc.isDisabled ? 'border-border opacity-70' : 'border-sky-500/25'}`}>
        <div className="p-4 flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${loc.isDisabled ? 'bg-muted text-muted-foreground' : 'bg-sky-500/10 text-sky-500'}`}>
              <Snowflake className="h-4.5 w-4.5" />
            </span>
            <div className="min-w-0">
              <p className="font-semibold truncate">{loc.name}</p>
              <p className="text-xs text-muted-foreground">
                {rollup > 0 ? `${qty3(rollup)} qty placed` : 'Empty'}
                {kids.length > 0 && ` · ${kids.length} sub-location${kids.length === 1 ? '' : 's'}`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {loc.isDisabled && <Badge variant="outline" className="text-[10px]">Disabled</Badge>}
            {(perm.canEdit || perm.canDelete || perm.canAdd) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-7 w-7"><MoreVertical className="h-4 w-4" /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {perm.canAdd && !loc.isDisabled && (
                    <DropdownMenuItem onClick={() => openAdd(loc)}>
                      <Plus className="h-3.5 w-3.5 mr-2" /> Add sub-location
                    </DropdownMenuItem>
                  )}
                  {perm.canEdit && (
                    <>
                      <DropdownMenuItem onClick={() => { setEditLoc(loc); setEditName(loc.name); }}>
                        <Pencil className="h-3.5 w-3.5 mr-2" /> Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => toggleDisabled(loc)}>
                        {loc.isDisabled
                          ? <><CircleCheck className="h-3.5 w-3.5 mr-2" /> Enable</>
                          : <><Ban className="h-3.5 w-3.5 mr-2" /> Disable</>}
                      </DropdownMenuItem>
                    </>
                  )}
                  {perm.canDelete && (
                    <DropdownMenuItem className="text-destructive" onClick={() => setDeleteLoc(loc)}>
                      <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>

        {/* Sub-locations */}
        {kids.length > 0 && (
          <div className="px-4 pb-3 space-y-1">
            {kids.map(kid => (
              <div key={kid.id} className={`flex items-center justify-between gap-2 rounded-md border border-border/70 bg-muted/20 px-2.5 py-1.5 ${kid.isDisabled ? 'opacity-60' : ''}`}>
                <div className="flex items-center gap-1.5 min-w-0 text-sm">
                  <CornerDownRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="font-medium truncate">{kid.name}</span>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {kid.placedQty > 0 ? `${qty3(kid.placedQty)} qty` : 'empty'}
                  </span>
                  {kid.isDisabled && <Badge variant="outline" className="text-[10px] shrink-0">Disabled</Badge>}
                </div>
                {(perm.canEdit || perm.canDelete) && (
                  <span className="flex items-center gap-0.5 shrink-0">
                    {perm.canEdit && (
                      <>
                        <Button variant="ghost" size="icon" className="h-6 w-6" title="Rename"
                          onClick={() => { setEditLoc(kid); setEditName(kid.name); }}>
                          <Pencil className="w-3 h-3" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-6 w-6" title={kid.isDisabled ? 'Enable' : 'Disable'}
                          onClick={() => toggleDisabled(kid)}>
                          {kid.isDisabled ? <CircleCheck className="w-3 h-3" /> : <Ban className="w-3 h-3" />}
                        </Button>
                      </>
                    )}
                    {perm.canDelete && (
                      <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" title="Delete"
                        onClick={() => setDeleteLoc(kid)}>
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    )}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        {perm.canAdd && !loc.isDisabled && kids.length === 0 && (
          <button
            onClick={() => openAdd(loc)}
            className="mx-4 mb-3 rounded-md border border-dashed border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors text-left"
          >
            + Add sub-location (rack / shelf)
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Warehouse picker + add */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <WarehouseIcon className="w-4 h-4 text-muted-foreground" />
          <Select value={warehouseId != null ? String(warehouseId) : ''} onValueChange={v => setWarehouseId(Number(v))}>
            <SelectTrigger className="w-56"><SelectValue placeholder="Pick a warehouse" /></SelectTrigger>
            <SelectContent>
              {warehouses.map((w: any) => (
                <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {perm.canAdd && (
          <Button size="sm" onClick={() => openAdd(null)} disabled={warehouseId == null}>
            <Plus className="w-4 h-4 mr-1" /> Add Storage Location
          </Button>
        )}
      </div>

      {/* Summary + reconciliation indicator */}
      <SummaryCardGrid>
        <SummaryCard label="Warehouse Total" value={qty3(totals.total)} icon={Boxes} loading={stockLoading} />
        <SummaryCard label="In Storage Locations" value={qty3(totals.placed)} icon={Snowflake} tone="info" loading={stockLoading} />
        <SummaryCard label="Unassigned" value={qty3(totals.unassigned)} icon={PackageOpen} tone={totals.unassigned > 0 ? 'warning' : 'default'} loading={stockLoading} />
        <SummaryCard
          label="Reconciliation"
          value={reconciles ? 'Balanced' : `${totals.overAssigned} to fix`}
          sub={reconciles ? 'Total = placed + unassigned' : 'Placements exceed stock'}
          icon={reconciles ? Scale : AlertTriangle}
          tone={reconciles ? 'positive' : 'negative'}
          loading={stockLoading}
        />
      </SummaryCardGrid>

      {/* Location cards */}
      {locsLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[...Array(3)].map((_, i) => <div key={i} className="h-28 rounded-xl border border-border bg-muted/20 animate-pulse" />)}
        </div>
      ) : roots.length === 0 ? (
        <EmptyState
          icon={Snowflake}
          title="No storage locations yet"
          hint="Add freezers or cold rooms to map where stock sits inside this warehouse — then add racks or shelves inside each one."
          action={perm.canAdd ? (
            <Button size="sm" onClick={() => openAdd(null)}><Plus className="w-4 h-4 mr-1" /> Add Storage Location</Button>
          ) : undefined}
          compact
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {roots.map(loc => <LocationCard key={loc.id} loc={loc} />)}
        </div>
      )}

      {/* Placement matrix */}
      <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
        <div className="p-4 border-b border-border flex flex-wrap gap-3 bg-muted/20">
          <div className="flex items-center gap-2 flex-1 min-w-[180px]">
            <Search className="w-4 h-4 text-muted-foreground shrink-0" />
            <Input
              placeholder="Search product..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="border-transparent bg-transparent focus-visible:ring-0"
            />
          </div>
          <Select value={materialType} onValueChange={setMaterialType}>
            <SelectTrigger className="w-44"><SelectValue placeholder="All Types" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Item Types</SelectItem>
              <SelectItem value="item">Item Name (SKU)</SelectItem>
              <SelectItem value="material">Raw Material</SelectItem>
              <SelectItem value="raw_material">Packing Material</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Table>
          <TableHeader>
            <TableRow className="bg-muted/10">
              <SortableHead k="itemName" sort={sort}>Item</SortableHead>
              <SortableHead k="materialType" sort={sort}>Item Type</SortableHead>
              <SortableHead k="totalQty" sort={sort} className="text-right">Warehouse Total</SortableHead>
              <TableHead>Storage Locations</TableHead>
              <SortableHead k="unassignedQty" sort={sort} className="text-right">Unassigned</SortableHead>
              {perm.canEdit && <TableHead className="text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {stockLoading ? (
              [...Array(5)].map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={perm.canEdit ? 6 : 5}>
                    <div className="h-8 bg-muted/30 rounded animate-pulse" />
                  </TableCell>
                </TableRow>
              ))
            ) : sorted.length === 0 ? (
              <TableRow>
                <TableCell colSpan={perm.canEdit ? 6 : 5} className="p-0">
                  <EmptyState icon={Snowflake} title="No stock at this warehouse" compact />
                </TableCell>
              </TableRow>
            ) : sorted.map(r => (
              <TableRow key={`${r.materialType}:${r.itemId}`} className="hover:bg-muted/10">
                <TableCell className="font-semibold">
                  {r.itemName}
                  {r.overAssignedQty > 0 && (
                    <Badge variant="destructive" className="ml-2 text-[10px] gap-1">
                      <AlertTriangle className="w-3 h-3" /> Over-assigned by {qty3(r.overAssignedQty)}
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">{MAT_TYPE_LABELS[r.materialType] ?? r.materialType}</TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {qty3(r.totalQty)} <span className="text-xs font-normal text-muted-foreground">{r.unit}</span>
                </TableCell>
                <TableCell>
                  {r.placements.length === 0 ? (
                    <span className="text-xs text-muted-foreground">—</span>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {r.placements.map(p => (
                        <Badge
                          key={p.storageLocationId}
                          variant="outline"
                          className={`text-xs font-normal gap-1 ${p.isDisabled ? 'opacity-60' : 'border-sky-500/30'}`}
                        >
                          <Snowflake className="w-3 h-3 text-sky-500" />
                          {p.name}: <span className="font-mono font-semibold">{qty3(p.quantity)}</span>
                        </Badge>
                      ))}
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {r.unassignedQty > 0
                    ? qty3(r.unassignedQty)
                    : <span className="text-muted-foreground">—</span>}
                </TableCell>
                {perm.canEdit && (
                  <TableCell className="text-right">
                    <Button variant="outline" size="sm" onClick={() => openMove(r)} disabled={locations.filter(l => !l.effectiveDisabled).length === 0 && r.placements.length === 0}>
                      <MoveRight className="w-3.5 h-3.5 mr-1" /> Move
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {rows.length > 0 && (
          <div className="p-3 border-t border-border text-xs text-muted-foreground flex flex-wrap items-center justify-between gap-2">
            <span>
              {rows.length} {rows.length === 1 ? 'product' : 'products'} · Warehouse total {qty3(totals.total)} = In storage locations {qty3(totals.placed)} + Unassigned {qty3(totals.unassigned)}
            </span>
            {totals.overAssigned > 0 && (
              <span className="text-red-500 font-medium flex items-center gap-1">
                <AlertTriangle className="w-3.5 h-3.5" />
                {totals.overAssigned} {totals.overAssigned === 1 ? 'product needs' : 'products need'} re-assignment (stock left since placement)
              </span>
            )}
          </div>
        )}
      </div>

      {/* Add dialog (root or sub-location) */}
      <Dialog open={addOpen} onOpenChange={o => { if (!o) { setAddOpen(false); setAddParent(null); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{addParent ? `Add Sub-location in "${addParent.name}"` : 'Add Storage Location'}</DialogTitle>
            <DialogDescription>
              {addParent
                ? 'A rack, shelf or section inside this storage location.'
                : 'A freezer or cold room inside this warehouse.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-sm font-medium">Name</label>
            <Input value={addName} onChange={e => setAddName(e.target.value)} placeholder={addParent ? 'e.g. Rack 1' : 'e.g. Freezer 1'}
              onKeyDown={e => { if (e.key === 'Enter') submitAdd(); }} autoFocus />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setAddOpen(false); setAddParent(null); }}>Cancel</Button>
            <Button onClick={submitAdd} disabled={!addName.trim() || createLoc.isPending}>
              {createLoc.isPending ? 'Adding…' : 'Add'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename dialog */}
      <Dialog open={editLoc != null} onOpenChange={o => { if (!o) setEditLoc(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename {editLoc?.parentId != null ? 'Sub-location' : 'Storage Location'}</DialogTitle>
            {editLoc?.parentName && <DialogDescription>Inside {editLoc.parentName}</DialogDescription>}
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-sm font-medium">Name</label>
            <Input value={editName} onChange={e => setEditName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submitRename(); }} autoFocus />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditLoc(null)}>Cancel</Button>
            <Button onClick={submitRename} disabled={!editName.trim() || updateLoc.isPending}>
              {updateLoc.isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete dialog */}
      <Dialog open={deleteLoc != null} onOpenChange={o => { if (!o) setDeleteLoc(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete "{deleteLoc?.name}"?</DialogTitle>
            <DialogDescription>
              {deleteLoc?.parentId == null && (deleteLoc as any)?.childCount > 0
                ? 'This storage location has sub-locations — delete those first.'
                : 'Only empty locations can be deleted. Stock placed here must be moved out first.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteLoc(null)}>Cancel</Button>
            <Button variant="destructive" onClick={submitDelete} disabled={removeLoc.isPending}>
              {removeLoc.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Move dialog */}
      <TransactionDialog open={moveRow != null} dirty={moveTo !== '' || moveQty !== ''} onOpenChange={o => { if (!o) setMoveRow(null); }}>
        <TransactionDialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Move Stock — {moveRow?.itemName}</DialogTitle>
            <DialogDescription>
              Warehouse total stays unchanged; this only records where the stock sits.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">From</label>
              <Select value={moveFrom} onValueChange={setMoveFrom}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {fromOptions.map(o => (
                    <SelectItem key={o.value} value={o.value} disabled={o.max <= 0}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">To</label>
              <Select value={moveTo} onValueChange={setMoveTo}>
                <SelectTrigger><SelectValue placeholder="Pick a destination" /></SelectTrigger>
                <SelectContent>
                  {toOptions.filter(o => o.value !== moveFrom).map(o => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">
                Quantity {moveRow ? <span className="text-muted-foreground font-normal">(up to {qty3(moveMax)} {moveRow.unit})</span> : null}
              </label>
              <Input
                type="number" min="0" step="any" value={moveQty}
                onChange={e => setMoveQty(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') submitMove(); }}
                placeholder="0"
              />
              {Number(moveQty) > moveMax && (
                <p className="text-xs text-red-500">Only {qty3(moveMax)} available in the selected source.</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
            <Button onClick={submitMove}
              disabled={moveStock.isPending || !moveTo || !(Number(moveQty) > 0) || Number(moveQty) > moveMax}>
              {moveStock.isPending ? 'Moving…' : 'Move'}
            </Button>
          </DialogFooter>
        </TransactionDialogContent>
      </TransactionDialog>
    </div>
  );
}
