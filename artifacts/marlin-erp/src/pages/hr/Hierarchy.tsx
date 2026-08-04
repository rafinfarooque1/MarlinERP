import { useState } from 'react';
import { useListHierarchies, useCreateHierarchy, useUpdateHierarchy, getListHierarchiesQueryKey } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Plus, Search, Network, Download, Eye, Pencil, ShieldOff, Crown } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';
import { usePermission } from '@/lib/usePermission';
import type { Hierarchy as Role } from '@workspace/api-client-react';

const schema = z.object({
  name: z.string().min(1, 'Name required'),
  reportsToId: z.coerce.number().int().positive('Choose who this role reports to'),
  description: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

/** The chain from a role up to the root, e.g. "Supervisor → Warehouse Manager → Management". */
function chainFor(role: Role, byId: Map<number, Role>): Role[] {
  const chain: Role[] = [];
  let cur: Role | undefined = role;
  const seen = new Set<number>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur);
    cur = cur.reportsToId != null ? byId.get(cur.reportsToId) : undefined;
  }
  return chain;
}

/** Every role at or below `id` in the reporting tree — these cannot become its manager. */
function subtreeIds(id: number, roles: Role[]): Set<number> {
  const ids = new Set<number>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of roles) {
      if (r.reportsToId != null && ids.has(r.reportsToId) && !ids.has(r.id)) { ids.add(r.id); grew = true; }
    }
  }
  return ids;
}

export default function Hierarchy() {
  const perm = usePermission('page:/hr/hierarchy');
  const { data: hierarchies = [], isLoading } = useListHierarchies();
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [viewItem, setViewItem] = useState<Role | null>(null);
  // Editing UPDATES the same role record in place — employees keep pointing at
  // the same hierarchy id, so assignments and permission rows follow the edit
  // automatically. null = the dialog is in "Add" mode.
  const [editItem, setEditItem] = useState<Role | null>(null);
  const queryClient = useQueryClient();
  const createMutation = useCreateHierarchy();
  const updateMutation = useUpdateHierarchy();

  const roles = hierarchies as Role[];
  const byId = new Map(roles.map(r => [r.id, r]));
  const root = roles.find(r => r.reportsToId == null && r.level === 1) ?? roles.find(r => r.level === 1);
  const isRoot = (r: Role | null | undefined) => !!r && r.id === root?.id;

  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { name: '', reportsToId: undefined as unknown as number, description: '' } });

  const openEdit = (h: Role) => {
    setEditItem(h);
    form.reset({ name: h.name, reportsToId: h.reportsToId ?? (undefined as unknown as number), description: h.description ?? '' });
    setIsOpen(true);
  };

  const onSubmit = (data: FormValues) => {
    if (editItem) {
      // The root reports to nobody — never send reportsToId for it.
      const payload = isRoot(editItem)
        ? { name: data.name, description: data.description }
        : data;
      updateMutation.mutate({ id: editItem.id, data: payload }, {
        onSuccess: () => { toast.success('Role updated'); queryClient.invalidateQueries({ queryKey: getListHierarchiesQueryKey() }); setIsOpen(false); setEditItem(null); form.reset(); },
        onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
      });
      return;
    }
    createMutation.mutate({ data }, {
      onSuccess: () => { toast.success('Role created'); queryClient.invalidateQueries({ queryKey: getListHierarchiesQueryKey() }); setIsOpen(false); form.reset(); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  // Order by the chain: managers before their reports, alphabetical between
  // siblings — the org structure without showing anyone a raw number.
  const sorted = [...roles].sort((a, b) => (a.level - b.level) || a.name.localeCompare(b.name));
  const filtered = sorted.filter(h => h.name.toLowerCase().includes(search.toLowerCase()));

  // In "Edit" mode a role may not report to itself or anything below it.
  const invalidParents = editItem ? subtreeIds(editItem.id, roles) : new Set<number>();
  const parentOptions = roles.filter(r => !invalidParents.has(r.id));

  const reportsToName = (h: Role) => (h.reportsToId != null ? byId.get(h.reportsToId)?.name ?? '—' : null);

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
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><Network className="w-6 h-6 text-primary" /> Org Hierarchy</h1>
            <p className="text-muted-foreground mt-1">Roles and who they report to</p>
          </div>
          <div className="flex gap-2">
            {perm.canDownload && (
            <Button variant="outline" size="sm" onClick={() => downloadCSV('hierarchy.csv', filtered.map(h => ({ Name: h.name, 'Reports To': reportsToName(h) ?? '', Description: h.description || '' })))}>
              <Download className="w-4 h-4 mr-2" /> Export
            </Button>
            )}
            {perm.canAdd && <Button onClick={() => { setEditItem(null); form.reset({ name: '', reportsToId: root?.id ?? (undefined as unknown as number), description: '' }); setIsOpen(true); }}><Plus className="w-4 h-4 mr-2" /> Add Role</Button>}
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex items-center gap-2 bg-muted/20">
            <Search className="w-4 h-4 text-muted-foreground" />
            <Input placeholder="Search roles..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0 max-w-xs max-md:max-w-full" />
          </div>
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Role / Designation</TableHead>
                <TableHead>Reports To</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(3)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={4}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={4} className="text-center py-16 text-muted-foreground">
                  <Network className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No roles defined</p>
                </TableCell></TableRow>
              ) : filtered.map(h => (
                <TableRow key={h.id} className="hover:bg-muted/10">
                  <TableCell className="font-semibold">
                    <span className="flex items-center gap-2">
                      {h.name}
                      {isRoot(h) && (
                        <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20 gap-1">
                          <Crown className="w-3 h-3" /> Top level
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm">
                    {reportsToName(h) ?? <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">{h.description || '—'}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(h)}><Eye className="w-4 h-4" /></Button>
                    {perm.canEdit && (
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => openEdit(h)}><Pencil className="w-4 h-4" /></Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <Dialog open={isOpen} onOpenChange={v => { setIsOpen(v); if (!v) { setEditItem(null); form.reset(); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{editItem ? 'Edit Role' : 'Add Role'}</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem><FormLabel>Role Name <span className="text-destructive">*</span></FormLabel><FormControl><Input placeholder="e.g. Warehouse Manager" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              {isRoot(editItem) ? (
                <p className="text-xs text-muted-foreground">
                  Top-level administrative role — it reports to nobody and always has
                  full access. Its name and description can be changed.
                </p>
              ) : (
                <FormField control={form.control} name="reportsToId" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Reports To <span className="text-destructive">*</span></FormLabel>
                    <Select
                      value={field.value != null && !Number.isNaN(field.value) ? String(field.value) : undefined}
                      onValueChange={v => field.onChange(Number(v))}
                    >
                      <FormControl>
                        <SelectTrigger><SelectValue placeholder="Choose a role" /></SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {parentOptions.map(r => (
                          <SelectItem key={r.id} value={String(r.id)}>{r.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {/* Seniority is the chain itself: permissions stay with the
                        role's rows on the Permissions page regardless of where it
                        sits. Only the top-level role is the exception, and it is
                        locked server-side. */}
                    <p className="text-xs text-muted-foreground">
                      Where this role sits in the org chain. Changing it does not change
                      what the role can access — permissions are managed on the Permissions page.
                    </p>
                    <FormMessage />
                  </FormItem>
                )} />
              )}
              <FormField control={form.control} name="description" render={({ field }) => (
                <FormItem><FormLabel>Description</FormLabel><FormControl><Textarea placeholder="Role responsibilities..." rows={2} {...field} /></FormControl></FormItem>
              )} />
              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => setIsOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending}>
                  {(createMutation.isPending || updateMutation.isPending) ? 'Saving…' : 'Save'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Sheet open={!!viewItem} onOpenChange={v => !v && setViewItem(null)}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2"><Network className="w-5 h-5 text-primary" />{viewItem?.name}</SheetTitle>
            <SheetDescription>
              {viewItem && (isRoot(viewItem)
                ? 'Top-level administrative role'
                : `Reports to ${reportsToName(viewItem) ?? '—'}`)}
            </SheetDescription>
          </SheetHeader>
          {viewItem && (
            <div className="mt-6 space-y-4">
              <div className="flex flex-col gap-1 border-b border-border pb-3">
                <span className="text-xs text-muted-foreground uppercase tracking-wider">Reporting chain</span>
                <span className="font-medium">
                  {chainFor(viewItem, byId).map(r => r.name).join(' → ')}
                </span>
              </div>
              <div className="flex flex-col gap-1 border-b border-border pb-3">
                <span className="text-xs text-muted-foreground uppercase tracking-wider">Reports To</span>
                <span className="font-medium">{reportsToName(viewItem) ?? 'Nobody — top of the chain'}</span>
              </div>
              <div className="flex flex-col gap-1 border-b border-border pb-3">
                <span className="text-xs text-muted-foreground uppercase tracking-wider">Description</span>
                <span className="font-medium">{viewItem.description || '—'}</span>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </AppLayout>
  );
}
