/**
 * Asset Categories — the taxonomy asset purchases pick from.
 *
 * Ships with 12 seeded defaults (Building, Vehicle, …, Other). Categories are
 * never deleted — purchases reference them — so retiring one means marking it
 * inactive: it stays on old records but drops out of new-purchase pickers.
 */
import { useState } from 'react';
import { useAssetCategories, useCreateAssetCategory, useUpdateAssetCategory, type AssetCategory } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Plus, Search, Edit2, FolderTree } from 'lucide-react';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { usePermission } from '@/lib/usePermission';
import { toast } from 'sonner';
import { AssetsAccessDenied } from './shared';

export default function AssetCategories() {
  const perm = usePermission('page:/assets/categories');
  const { data: categories = [], isLoading } = useAssetCategories();
  const createCat = useCreateAssetCategory();
  const updateCat = useUpdateAssetCategory();

  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<AssetCategory | null>(null);
  const [name, setName] = useState('');
  const [status, setStatus] = useState<'active' | 'inactive'>('active');

  const q = search.trim().toLowerCase();
  const filtered = (categories as AssetCategory[]).filter(c => q === '' || c.name.toLowerCase().includes(q));
  const { sorted, sort } = useTableSort(filtered, {
    category: c => c.name,
    assets: c => Number(c.assetCount ?? 0),
    status: c => c.status,
  });

  const openAdd = () => { setEditTarget(null); setName(''); setStatus('active'); setIsOpen(true); };
  const openEdit = (c: AssetCategory) => { setEditTarget(c); setName(c.name); setStatus(c.status); setIsOpen(true); };

  const onSubmit = () => {
    const trimmed = name.trim();
    if (!trimmed) { toast.error('Name required'); return; }
    const opts = {
      onSuccess: () => { toast.success(editTarget ? 'Category updated' : 'Category added'); setIsOpen(false); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    };
    if (editTarget) updateCat.mutate({ id: editTarget.id, name: trimmed, status }, opts);
    else createCat.mutate({ name: trimmed }, opts);
  };

  if (!perm.isLoading && !perm.canView) return <AssetsAccessDenied />;

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><FolderTree className="w-6 h-6 text-primary" /> Asset Categories</h1>
            <p className="text-muted-foreground mt-1">Categories asset purchases are classified under. Inactive ones stay on old records but leave the pickers.</p>
          </div>
          {perm.canAdd && <Button onClick={openAdd}><Plus className="w-4 h-4 mr-2" /> Add Category</Button>}
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex items-center gap-2 bg-muted/20">
            <Search className="w-4 h-4 text-muted-foreground shrink-0" />
            <Input placeholder="Search categories..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0" />
          </div>
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <SortableHead k="category" sort={sort}>Category</SortableHead>
                <SortableHead k="assets" sort={sort} className="text-right">Assets</SortableHead>
                <SortableHead k="status" sort={sort}>Status</SortableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(5)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={4}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={4} className="text-center py-16 text-muted-foreground">
                  <FolderTree className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No categories found</p>
                </TableCell></TableRow>
              ) : sorted.map(c => (
                <TableRow key={c.id} className={`hover:bg-muted/10 ${c.status === 'active' ? '' : 'opacity-60'}`}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell className="text-right font-mono">{Number(c.assetCount ?? 0)}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={`text-xs ${c.status === 'active'
                      ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20'
                      : 'bg-muted text-muted-foreground border-border'}`}>
                      {c.status === 'active' ? 'Active' : 'Inactive'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {perm.canEdit && (
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => openEdit(c)}><Edit2 className="w-4 h-4" /></Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{editTarget ? 'Edit Category' : 'Add Category'}</DialogTitle></DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Name <span className="text-destructive">*</span></label>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Cold Room" autoFocus />
            </div>
            {editTarget && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Status</label>
                <Select value={status} onValueChange={v => setStatus(v as 'active' | 'inactive')}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active — offered on new purchases</SelectItem>
                    <SelectItem value="inactive">Inactive — kept on old records only</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsOpen(false)}>Cancel</Button>
            <Button onClick={onSubmit} disabled={createCat.isPending || updateCat.isPending}>
              {(createCat.isPending || updateCat.isPending) ? 'Saving…' : editTarget ? 'Save Changes' : 'Add Category'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
