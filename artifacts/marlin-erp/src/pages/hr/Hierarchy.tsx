import { useState } from 'react';
import { useListHierarchies, useCreateHierarchy, getListHierarchiesQueryKey } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Plus, Search, Network, Download, Eye } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';

const schema = z.object({
  name: z.string().min(1, 'Name required'),
  level: z.coerce.number().min(1).max(10),
  description: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

export default function Hierarchy() {
  const { data: hierarchies = [], isLoading } = useListHierarchies();
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [viewItem, setViewItem] = useState<any>(null);
  const queryClient = useQueryClient();
  const createMutation = useCreateHierarchy();

  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { name: '', level: 3, description: '' } });

  const onSubmit = (data: FormValues) => {
    createMutation.mutate({ data }, {
      onSuccess: () => { toast.success('Role created'); queryClient.invalidateQueries({ queryKey: getListHierarchiesQueryKey() }); setIsOpen(false); form.reset(); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  const sorted = [...hierarchies].sort((a, b) => a.level - b.level);
  const filtered = sorted.filter(h => h.name.toLowerCase().includes(search.toLowerCase()));

  const levelLabel = (l: number) => l <= 2 ? 'Senior' : l <= 4 ? 'Mid' : 'Junior';
  const levelColor = (l: number) => l <= 2 ? 'bg-primary/10 text-primary border-primary/20' : l <= 4 ? 'bg-amber-500/10 text-amber-500 border-amber-500/20' : 'bg-muted text-muted-foreground';

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><Network className="w-6 h-6 text-primary" /> Org Hierarchy</h1>
            <p className="text-muted-foreground mt-1">Roles and designations structure</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => downloadCSV('hierarchy.csv', filtered.map(h => ({ Name: h.name, Level: h.level, Description: h.description || '' })))}>
              <Download className="w-4 h-4 mr-2" /> Export
            </Button>
            <Button onClick={() => { form.reset(); setIsOpen(true); }}><Plus className="w-4 h-4 mr-2" /> Add Role</Button>
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex items-center gap-2 bg-muted/20">
            <Search className="w-4 h-4 text-muted-foreground" />
            <Input placeholder="Search roles..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0 max-w-xs" />
          </div>
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Role / Designation</TableHead>
                <TableHead>Level</TableHead>
                <TableHead>Grade</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(3)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={5}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="text-center py-16 text-muted-foreground">
                  <Network className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No roles defined</p>
                </TableCell></TableRow>
              ) : filtered.map(h => (
                <TableRow key={h.id} className="hover:bg-muted/10">
                  <TableCell className="font-semibold">{h.name}</TableCell>
                  <TableCell><Badge variant="outline" className="font-mono">L{h.level}</Badge></TableCell>
                  <TableCell><Badge variant="outline" className={levelColor(h.level)}>{levelLabel(h.level)}</Badge></TableCell>
                  <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">{h.description || '—'}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(h)}><Eye className="w-4 h-4" /></Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <Dialog open={isOpen} onOpenChange={v => { setIsOpen(v); if (!v) form.reset(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Add Role</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem><FormLabel>Role Name <span className="text-destructive">*</span></FormLabel><FormControl><Input placeholder="e.g. Production Manager" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="level" render={({ field }) => (
                <FormItem><FormLabel>Hierarchy Level (1 = highest)</FormLabel><FormControl><Input type="number" min={1} max={10} {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="description" render={({ field }) => (
                <FormItem><FormLabel>Description</FormLabel><FormControl><Textarea placeholder="Role responsibilities..." rows={2} {...field} /></FormControl></FormItem>
              )} />
              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => setIsOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createMutation.isPending}>{createMutation.isPending ? 'Saving…' : 'Save'}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Sheet open={!!viewItem} onOpenChange={v => !v && setViewItem(null)}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2"><Network className="w-5 h-5 text-primary" />{viewItem?.name}</SheetTitle>
            <SheetDescription>Level {viewItem?.level} — {viewItem && levelLabel(viewItem.level)}</SheetDescription>
          </SheetHeader>
          {viewItem && (
            <div className="mt-6 space-y-4">
              {[['Level', `L${viewItem.level}`], ['Grade', levelLabel(viewItem.level)], ['Description', viewItem.description || '—']].map(([k, v]) => (
                <div key={k} className="flex flex-col gap-1 border-b border-border pb-3">
                  <span className="text-xs text-muted-foreground uppercase tracking-wider">{k}</span>
                  <span className="font-medium">{v}</span>
                </div>
              ))}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </AppLayout>
  );
}
