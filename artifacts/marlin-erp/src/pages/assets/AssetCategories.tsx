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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Plus, Search, Edit2, FolderTree, CheckCircle2 } from 'lucide-react';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { usePermission } from '@/lib/usePermission';
import { toast } from 'sonner';
import { TablePager, useClientPage } from '@/components/ui/table-pager';
import { PageHeader } from '@/components/app/page-header';
import { SummaryCard, SummaryCardGrid } from '@/components/app/summary-card';
import { StatusBadge } from '@/components/app/status-badge';
import { EmptyState } from '@/components/app/empty-state';
import { TableSkeleton } from '@/components/app/loading-skeletons';
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

  const { pageRows, pagerProps } = useClientPage(sorted);

  const allCategories = categories as AssetCategory[];
  const activeCount = allCategories.filter(c => c.status === 'active').length;

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
        <PageHeader
          title="Asset Categories"
          description="Categories asset purchases are classified under. Inactive ones stay on old records but leave the pickers."
          icon={FolderTree}
          actions={perm.canAdd && <Button onClick={openAdd}><Plus className="w-4 h-4 mr-2" /> Add Category</Button>}
        />

        <SummaryCardGrid>
          <SummaryCard label="Categories" value={String(allCategories.length)} icon={FolderTree} tone="default" loading={isLoading} />
          <SummaryCard label="Active" value={String(activeCount)} icon={CheckCircle2} tone="positive" loading={isLoading} />
        </SummaryCardGrid>

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
              {isLoading ? (
                <TableRow><TableCell colSpan={4} className="p-0"><TableSkeleton rows={8} cols={4} /></TableCell></TableRow>
              ) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={4} className="p-0">
                  <EmptyState icon={FolderTree} title="No categories found" hint="Add a category to classify asset purchases." compact />
                </TableCell></TableRow>
              ) : pageRows.map(c => (
                <TableRow key={c.id} className={`hover:bg-muted/10 ${c.status === 'active' ? '' : 'opacity-60'}`}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell className="text-right font-mono">{Number(c.assetCount ?? 0)}</TableCell>
                  <TableCell>
                    <StatusBadge status={c.status} />
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
          <div className="px-4 py-2 border-t border-border">
            <TablePager {...pagerProps} />
          </div>
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
