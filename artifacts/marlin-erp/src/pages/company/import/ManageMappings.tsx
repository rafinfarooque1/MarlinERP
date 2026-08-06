/**
 * Manage Mappings — the permanent old-ERP-name → record memory.
 *
 * Every decision made at the mapping step lands here. A mapping can be
 * re-pointed to a different record or deleted (the name will simply ask to be
 * mapped again on its next appearance). Mappings whose target was deleted
 * since are flagged.
 */
import { useMemo, useState } from 'react';
import {
  useImportMappings, useImportMappingCandidates, useUpdateImportMapping, useDeleteImportMapping,
  type ImportMappingKind, type ImportSavedMapping,
} from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from 'sonner';
import { Link2, Loader2, Pencil, Trash2, AlertTriangle } from 'lucide-react';
import { fmtTime } from './shared';

const KIND_LABEL: Record<ImportMappingKind, string> = {
  customer: 'Customer', vendor: 'Vendor', ledger: 'Ledger', product: 'Item',
};

export function ManageMappings({ canEdit, canDelete }: { canEdit: boolean; canDelete: boolean }) {
  const [kindFilter, setKindFilter] = useState<'all' | ImportMappingKind>('all');
  const [search, setSearch] = useState('');
  const [editTarget, setEditTarget] = useState<ImportSavedMapping | null>(null);
  const [editValue, setEditValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<ImportSavedMapping | null>(null);

  const { data, isLoading } = useImportMappings(kindFilter === 'all' ? undefined : kindFilter);
  const { data: candidates } = useImportMappingCandidates(editTarget?.kind ?? null);
  const updateMapping = useUpdateImportMapping();
  const deleteMapping = useDeleteImportMapping();

  const mappings = useMemo(() => {
    const all = data?.mappings ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((m) =>
      m.sourceName.toLowerCase().includes(q) || (m.targetName ?? '').toLowerCase().includes(q));
  }, [data, search]);

  const handleUpdate = async () => {
    if (!editTarget || !editValue) return;
    const [idStr, tk] = editValue.split('|');
    try {
      const r = await updateMapping.mutateAsync({ id: editTarget.id, targetId: Number(idStr), targetKind: tk || null });
      toast.success(`"${editTarget.sourceName}" now points to "${r.mapping.targetName}".`);
      setEditTarget(null);
    } catch (e: any) {
      toast.error(e?.message ?? 'The mapping could not be updated.');
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMapping.mutateAsync({ id: deleteTarget.id });
      toast.success(`Mapping for "${deleteTarget.sourceName}" deleted — the name will ask to be mapped again next time it appears.`);
      setDeleteTarget(null);
    } catch (e: any) {
      toast.error(e?.message ?? 'The mapping could not be deleted.');
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Link2 className="w-4 h-4 text-primary" />
          Saved mappings
        </CardTitle>
        <CardDescription>
          Every old-ERP name you have ever mapped, remembered permanently. Files with these names
          need no mapping step. Re-point a mapping if it links to the wrong record, or delete it
          to be asked again.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={kindFilter} onValueChange={(v) => setKindFilter(v as 'all' | ImportMappingKind)}>
            <SelectTrigger className="w-40 h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All kinds</SelectItem>
              <SelectItem value="customer">Customers</SelectItem>
              <SelectItem value="vendor">Vendors</SelectItem>
              <SelectItem value="ledger">Ledgers</SelectItem>
              <SelectItem value="product">Items</SelectItem>
            </SelectContent>
          </Select>
          <Input className="h-9 w-64" placeholder="Search names…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>

        {isLoading ? (
          <div className="py-10 text-center text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin inline" /></div>
        ) : mappings.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {search ? 'No mappings match your search.' : 'No mappings saved yet — they are created at the mapping step of an import.'}
          </p>
        ) : (
          <div className="rounded-lg border overflow-x-auto">
            <Table className="no-sticky-col">
              <TableHeader>
                <TableRow>
                  <TableHead>Kind</TableHead>
                  <TableHead>Old ERP name</TableHead>
                  <TableHead>Mapped to</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead>Last updated</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mappings.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell><Badge variant="outline">{KIND_LABEL[m.kind]}</Badge></TableCell>
                    <TableCell className="font-medium text-sm">{m.sourceName}</TableCell>
                    <TableCell className="text-sm">
                      {m.targetName ?? (
                        <span className="text-destructive flex items-center gap-1 text-xs">
                          <AlertTriangle className="w-3.5 h-3.5" />target deleted — re-point or delete
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{m.createdBy}</TableCell>
                    <TableCell className="text-sm text-muted-foreground whitespace-nowrap">{fmtTime(m.updatedAt)}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <Button variant="ghost" size="sm" disabled={!canEdit}
                        onClick={() => { setEditTarget(m); setEditValue(''); }}>
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" disabled={!canDelete}
                        onClick={() => setDeleteTarget(m)}>
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      {/* Re-point dialog */}
      <Dialog open={editTarget != null} onOpenChange={(open) => { if (!open) setEditTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Re-point "{editTarget?.sourceName}"</DialogTitle>
            <DialogDescription>
              Future imports will link this old-ERP name to the record you pick. Records already
              imported are not changed.
            </DialogDescription>
          </DialogHeader>
          <Select value={editValue} onValueChange={setEditValue}>
            <SelectTrigger><SelectValue placeholder={`Currently: ${editTarget?.targetName ?? 'target deleted'}`} /></SelectTrigger>
            <SelectContent>
              {(candidates?.candidates ?? []).map((c) => (
                <SelectItem key={`${c.id}|${c.targetKind ?? ''}`} value={`${c.id}|${c.targetKind ?? ''}`}>
                  {c.name}{c.targetKind && c.targetKind !== 'item' ? ` (${c.targetKind.replace('_', ' ')})` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}>Cancel</Button>
            <Button onClick={handleUpdate} disabled={!editValue || updateMapping.isPending}>
              {updateMapping.isPending && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={deleteTarget != null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this mapping?</DialogTitle>
            <DialogDescription>
              "{deleteTarget?.sourceName}" will no longer be linked to {deleteTarget?.targetName ?? 'its record'}.
              The next file containing this name will ask you to map it again. No imported records are touched.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteMapping.isPending}>
              {deleteMapping.isPending && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
              Delete mapping
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
