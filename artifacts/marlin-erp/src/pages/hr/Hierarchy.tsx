import { useState } from 'react';
import { useListHierarchies, useCreateHierarchy, useUpdateHierarchy, useDeleteHierarchy, getListHierarchiesQueryKey } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Plus, Search, Edit2, Trash2, Network } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';

const schema = z.object({
  name: z.string().min(1, 'Name is required'),
  level: z.coerce.number().min(1, 'Level must be at least 1'),
  description: z.string().optional(),
});

export default function Hierarchy() {
  const { data: hierarchies, isLoading } = useListHierarchies();
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const createMutation = useCreateHierarchy();
  const updateMutation = useUpdateHierarchy();
  const deleteMutation = useDeleteHierarchy();

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', level: 1, description: '' },
  });

  const onSubmit = (data: z.infer<typeof schema>) => {
    if (editingId) {
      updateMutation.mutate({ id: editingId, data }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListHierarchiesQueryKey() });
          setIsOpen(false);
          toast({ title: 'Hierarchy updated' });
        }
      });
    } else {
      createMutation.mutate({ data }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListHierarchiesQueryKey() });
          setIsOpen(false);
          toast({ title: 'Hierarchy created' });
        }
      });
    }
  };

  const handleEdit = (hierarchy: any) => {
    setEditingId(hierarchy.id);
    form.reset({
      name: hierarchy.name,
      level: hierarchy.level,
      description: hierarchy.description || '',
    });
    setIsOpen(true);
  };

  const handleDelete = (id: number) => {
    if (confirm('Are you sure you want to delete this hierarchy level?')) {
      deleteMutation.mutate({ id }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListHierarchiesQueryKey() });
          toast({ title: 'Hierarchy deleted' });
        }
      });
    }
  };

  const filtered = hierarchies?.filter(h => h.name.toLowerCase().includes(search.toLowerCase())) || [];

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Network className="w-6 h-6 text-primary" /> Roles & Hierarchy
            </h1>
            <p className="text-muted-foreground mt-1">Manage employee designations and access levels</p>
          </div>
          
          <Dialog open={isOpen} onOpenChange={(open) => {
            setIsOpen(open);
            if (!open) { setEditingId(null); form.reset({ name: '', level: 1, description: '' }); }
          }}>
            <DialogTrigger asChild>
              <Button><Plus className="w-4 h-4 mr-2" /> Add Role</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{editingId ? 'Edit Role' : 'Add Role'}</DialogTitle>
              </DialogHeader>
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                  <FormField control={form.control} name="name" render={({field}) => (
                    <FormItem><FormLabel>Role Name</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={form.control} name="level" render={({field}) => (
                    <FormItem><FormLabel>Level (1 is highest)</FormLabel><FormControl><Input type="number" {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={form.control} name="description" render={({field}) => (
                    <FormItem><FormLabel>Description</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                  <DialogFooter>
                    <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending}>Save</Button>
                  </DialogFooter>
                </form>
              </Form>
            </DialogContent>
          </Dialog>
        </div>

        <div className="bg-card border border-border rounded-md shadow-sm">
          <div className="p-4 border-b border-border flex items-center gap-2">
            <Search className="w-4 h-4 text-muted-foreground" />
            <Input 
              placeholder="Search roles..." 
              value={search} 
              onChange={e => setSearch(e.target.value)}
              className="max-w-xs border-transparent bg-muted/50 focus-visible:bg-transparent"
            />
          </div>
          
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Level</TableHead>
                <TableHead>Role Name</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow>
              ) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">No roles found</TableCell></TableRow>
              ) : (
                filtered.sort((a,b) => a.level - b.level).map(role => (
                  <TableRow key={role.id}>
                    <TableCell className="font-mono text-primary font-bold">L{role.level}</TableCell>
                    <TableCell className="font-medium">{role.name}</TableCell>
                    <TableCell className="text-muted-foreground">{role.description || '-'}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button variant="ghost" size="icon" onClick={() => handleEdit(role)}>
                          <Edit2 className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="icon" className="text-destructive hover:text-destructive" onClick={() => handleDelete(role.id)}>
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
    </AppLayout>
  );
}