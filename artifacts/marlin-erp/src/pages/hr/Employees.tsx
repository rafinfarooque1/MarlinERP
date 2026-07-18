import { useState } from 'react';
import { useListEmployees, useCreateEmployee, useUpdateEmployee, useDeleteEmployee, useListHierarchies, useListWarehouses, useListOutlets, getListEmployeesQueryKey } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Plus, Search, Edit2, Trash2, Users } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';

const schema = z.object({
  name: z.string().min(1, 'Name is required'),
  username: z.string().min(1, 'Username is required'),
  email: z.string().email().optional().or(z.literal('')),
  phone: z.string().optional(),
  hierarchyId: z.coerce.number().min(1, 'Role is required'),
  branchType: z.enum(['production', 'headoffice', 'warehouse', 'outlet']),
  branchId: z.coerce.number().min(1, 'Location is required'),
  salary: z.coerce.number().min(0, 'Salary must be positive'),
  joinDate: z.string().min(1, 'Join date is required'),
});

export default function Employees() {
  const { data: employees, isLoading } = useListEmployees();
  const { data: hierarchies } = useListHierarchies();
  const { data: warehouses } = useListWarehouses();
  const { data: outlets } = useListOutlets();
  
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const createMutation = useCreateEmployee();
  const updateMutation = useUpdateEmployee();
  const deleteMutation = useDeleteEmployee();

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { 
      name: '', username: '', email: '', phone: '', hierarchyId: 0, branchType: 'headoffice', branchId: 1, salary: 0, joinDate: new Date().toISOString().split('T')[0]
    },
  });

  const watchBranchType = form.watch('branchType');

  const onSubmit = (data: z.infer<typeof schema>) => {
    if (editingId) {
      updateMutation.mutate({ id: editingId, data }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey() });
          setIsOpen(false);
          toast({ title: 'Employee updated' });
        }
      });
    } else {
      createMutation.mutate({ data }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey() });
          setIsOpen(false);
          toast({ title: 'Employee created' });
        }
      });
    }
  };

  const handleEdit = (emp: any) => {
    setEditingId(emp.id);
    form.reset({
      name: emp.name,
      username: emp.username,
      email: emp.email || '',
      phone: emp.phone || '',
      hierarchyId: emp.hierarchyId,
      branchType: emp.branchType,
      branchId: emp.branchId,
      salary: emp.salary || 0,
      joinDate: emp.joinDate ? emp.joinDate.split('T')[0] : new Date().toISOString().split('T')[0],
    });
    setIsOpen(true);
  };

  const handleDelete = (id: number) => {
    if (confirm('Are you sure you want to delete this employee?')) {
      deleteMutation.mutate({ id }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey() });
          toast({ title: 'Employee deleted' });
        }
      });
    }
  };

  const filtered = employees?.filter(e => e.name.toLowerCase().includes(search.toLowerCase()) || e.username.toLowerCase().includes(search.toLowerCase())) || [];

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Users className="w-6 h-6 text-primary" /> Employee Directory
            </h1>
            <p className="text-muted-foreground mt-1">Manage personnel, roles, and branch assignments</p>
          </div>
          
          <Dialog open={isOpen} onOpenChange={(open) => {
            setIsOpen(open);
            if (!open) { setEditingId(null); form.reset(); }
          }}>
            <DialogTrigger asChild>
              <Button><Plus className="w-4 h-4 mr-2" /> Add Employee</Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>{editingId ? 'Edit Employee' : 'Add Employee'}</DialogTitle>
              </DialogHeader>
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <FormField control={form.control} name="name" render={({field}) => (
                      <FormItem><FormLabel>Full Name</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={form.control} name="username" render={({field}) => (
                      <FormItem><FormLabel>System Username</FormLabel><FormControl><Input {...field} disabled={!!editingId} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={form.control} name="email" render={({field}) => (
                      <FormItem><FormLabel>Email</FormLabel><FormControl><Input type="email" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={form.control} name="phone" render={({field}) => (
                      <FormItem><FormLabel>Phone</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                  </div>

                  <div className="border-t border-border pt-4 mt-4 grid grid-cols-2 gap-4">
                    <FormField control={form.control} name="hierarchyId" render={({field}) => (
                      <FormItem>
                        <FormLabel>Role / Designation</FormLabel>
                        <Select onValueChange={(val) => field.onChange(Number(val))} value={field.value ? field.value.toString() : ''}>
                          <FormControl><SelectTrigger><SelectValue placeholder="Select role" /></SelectTrigger></FormControl>
                          <SelectContent>
                            {hierarchies?.map(h => <SelectItem key={h.id} value={h.id.toString()}>{h.name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={form.control} name="salary" render={({field}) => (
                      <FormItem><FormLabel>Monthly Salary (₹)</FormLabel><FormControl><Input type="number" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={form.control} name="joinDate" render={({field}) => (
                      <FormItem><FormLabel>Join Date</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                  </div>

                  <div className="border-t border-border pt-4 mt-4 grid grid-cols-2 gap-4">
                    <FormField control={form.control} name="branchType" render={({field}) => (
                      <FormItem>
                        <FormLabel>Location Type</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                          <SelectContent>
                            <SelectItem value="headoffice">Head Office</SelectItem>
                            <SelectItem value="production">Production Unit</SelectItem>
                            <SelectItem value="warehouse">Warehouse</SelectItem>
                            <SelectItem value="outlet">Retail Outlet</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={form.control} name="branchId" render={({field}) => (
                      <FormItem>
                        <FormLabel>Specific Location</FormLabel>
                        <Select onValueChange={(val) => field.onChange(Number(val))} value={field.value ? field.value.toString() : ''}>
                          <FormControl><SelectTrigger><SelectValue placeholder="Select location" /></SelectTrigger></FormControl>
                          <SelectContent>
                            {(watchBranchType === 'headoffice' || watchBranchType === 'production') && <SelectItem value="1">Central Hub</SelectItem>}
                            {watchBranchType === 'warehouse' && warehouses?.map(w => <SelectItem key={w.id} value={w.id.toString()}>{w.name}</SelectItem>)}
                            {watchBranchType === 'outlet' && outlets?.map(o => <SelectItem key={o.id} value={o.id.toString()}>{o.name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )} />
                  </div>

                  <DialogFooter>
                    <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending}>Save Employee</Button>
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
              placeholder="Search by name or username..." 
              value={search} 
              onChange={e => setSearch(e.target.value)}
              className="max-w-xs border-transparent bg-muted/50 focus-visible:bg-transparent"
            />
          </div>
          
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow>
              ) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">No employees found</TableCell></TableRow>
              ) : (
                filtered.map(emp => (
                  <TableRow key={emp.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Avatar className="h-8 w-8">
                          <AvatarImage src={emp.photoUrl || undefined} />
                          <AvatarFallback className="bg-primary/20 text-primary text-xs">{emp.name.charAt(0)}</AvatarFallback>
                        </Avatar>
                        <div>
                          <div className="font-medium text-foreground">{emp.name}</div>
                          <div className="text-xs text-muted-foreground font-mono">{emp.username}</div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="font-medium text-primary">{emp.hierarchyName}</TableCell>
                    <TableCell>
                      <div className="text-sm">{emp.branchName}</div>
                      <Badge variant="outline" className="uppercase text-[10px] mt-1">{emp.branchType}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm text-muted-foreground">{emp.phone || '-'}</div>
                      <div className="text-xs text-muted-foreground">{emp.email || '-'}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={emp.isActive ? 'default' : 'secondary'} className={emp.isActive ? 'bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 border-emerald-500/20' : ''}>
                        {emp.isActive ? 'ACTIVE' : 'INACTIVE'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button variant="ghost" size="icon" onClick={() => handleEdit(emp)}>
                          <Edit2 className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="icon" className="text-destructive hover:text-destructive" onClick={() => handleDelete(emp.id)}>
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