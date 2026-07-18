import { useState } from 'react';
import { useListEmployees, useCreateEmployee, useListHierarchies, useListWarehouses, useListOutlets, getListEmployeesQueryKey } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Plus, Search, Users, Download, Eye } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';

const schema = z.object({
  name: z.string().min(1, 'Name required'),
  username: z.string().min(1, 'Username required'),
  email: z.string().email().optional().or(z.literal('')),
  phone: z.string().optional(),
  hierarchyId: z.coerce.number().min(1, 'Role required'),
  branchType: z.enum(['production', 'headoffice', 'warehouse', 'outlet']),
  branchId: z.coerce.number().min(0),
  salary: z.coerce.number().min(0),
  joinDate: z.string().min(1, 'Join date required'),
});
type FormValues = z.infer<typeof schema>;

export default function Employees() {
  const { data: employees = [], isLoading } = useListEmployees();
  const { data: hierarchies = [] } = useListHierarchies();
  const { data: warehouses = [] } = useListWarehouses();
  const { data: outlets = [] } = useListOutlets();
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [viewItem, setViewItem] = useState<any>(null);
  const queryClient = useQueryClient();
  const createMutation = useCreateEmployee();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', username: '', email: '', phone: '', hierarchyId: 0, branchType: 'headoffice', branchId: 0, salary: 0, joinDate: new Date().toISOString().split('T')[0] },
  });
  const watchBranchType = form.watch('branchType');

  const onSubmit = (data: FormValues) => {
    createMutation.mutate({ data }, {
      onSuccess: () => { toast.success('Employee added'); queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey() }); setIsOpen(false); form.reset(); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  const filtered = employees.filter(e => e.name.toLowerCase().includes(search.toLowerCase()) || e.username.toLowerCase().includes(search.toLowerCase()));

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><Users className="w-6 h-6 text-primary" /> Employee Directory</h1>
            <p className="text-muted-foreground mt-1">Personnel, roles, and branch assignments</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => downloadCSV('employees.csv', filtered.map(e => ({ Name: e.name, Username: e.username, Role: e.hierarchyName, Branch: e.branchName, Type: e.branchType, Salary: e.salary, Status: e.isActive ? 'Active' : 'Inactive' })))}>
              <Download className="w-4 h-4 mr-2" /> Export
            </Button>
            <Button onClick={() => { form.reset({ name: '', username: '', email: '', phone: '', hierarchyId: 0, branchType: 'headoffice', branchId: 0, salary: 0, joinDate: new Date().toISOString().split('T')[0] }); setIsOpen(true); }}>
              <Plus className="w-4 h-4 mr-2" /> Add Employee
            </Button>
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex items-center gap-2 bg-muted/20">
            <Search className="w-4 h-4 text-muted-foreground" />
            <Input placeholder="Search name or username..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0 max-w-xs" />
          </div>
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Employee</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Salary</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(4)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={6}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center py-16 text-muted-foreground">
                  <Users className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No employees found</p>
                </TableCell></TableRow>
              ) : filtered.map(emp => (
                <TableRow key={emp.id} className="hover:bg-muted/10">
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <Avatar className="h-9 w-9">
                        <AvatarFallback className="bg-primary/10 text-primary text-sm font-bold">{emp.name.charAt(0)}</AvatarFallback>
                      </Avatar>
                      <div>
                        <div className="font-semibold text-foreground">{emp.name}</div>
                        <div className="text-xs text-muted-foreground font-mono">@{emp.username}</div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-primary font-medium text-sm">{emp.hierarchyName}</TableCell>
                  <TableCell>
                    <div className="text-sm">{emp.branchName}</div>
                    <Badge variant="outline" className="text-[10px] capitalize">{emp.branchType}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-sm">₹{Number(emp.salary || 0).toLocaleString('en-IN')}</TableCell>
                  <TableCell>
                    <Badge variant={emp.isActive ? 'default' : 'secondary'} className={emp.isActive ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' : ''}>
                      {emp.isActive ? 'ACTIVE' : 'INACTIVE'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(emp)}><Eye className="w-4 h-4" /></Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <Dialog open={isOpen} onOpenChange={v => { setIsOpen(v); if (!v) form.reset(); }}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Add Employee</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="name" render={({ field }) => (
                  <FormItem><FormLabel>Full Name <span className="text-destructive">*</span></FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="username" render={({ field }) => (
                  <FormItem><FormLabel>Username <span className="text-destructive">*</span></FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="email" render={({ field }) => (
                  <FormItem><FormLabel>Email</FormLabel><FormControl><Input type="email" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="phone" render={({ field }) => (
                  <FormItem><FormLabel>Phone</FormLabel><FormControl><Input {...field} /></FormControl></FormItem>
                )} />
              </div>

              <div className="border-t border-border pt-4 grid grid-cols-2 gap-4">
                <FormField control={form.control} name="hierarchyId" render={({ field }) => (
                  <FormItem><FormLabel>Role <span className="text-destructive">*</span></FormLabel>
                    <Select onValueChange={v => field.onChange(Number(v))} value={field.value ? String(field.value) : ''}>
                      <FormControl><SelectTrigger><SelectValue placeholder="Select role" /></SelectTrigger></FormControl>
                      <SelectContent>{hierarchies.map(h => <SelectItem key={h.id} value={String(h.id)}>{h.name}</SelectItem>)}</SelectContent>
                    </Select><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="salary" render={({ field }) => (
                  <FormItem><FormLabel>Monthly Salary ₹</FormLabel><FormControl><Input type="number" min={0} {...field} /></FormControl></FormItem>
                )} />
                <FormField control={form.control} name="joinDate" render={({ field }) => (
                  <FormItem><FormLabel>Join Date <span className="text-destructive">*</span></FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
              </div>

              <div className="border-t border-border pt-4 grid grid-cols-2 gap-4">
                <FormField control={form.control} name="branchType" render={({ field }) => (
                  <FormItem><FormLabel>Location Type</FormLabel>
                    <Select onValueChange={v => { field.onChange(v); form.setValue('branchId', 0); }} value={field.value}>
                      <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="headoffice">Head Office</SelectItem>
                        <SelectItem value="production">Production Unit</SelectItem>
                        <SelectItem value="warehouse">Warehouse</SelectItem>
                        <SelectItem value="outlet">Retail Outlet</SelectItem>
                      </SelectContent>
                    </Select></FormItem>
                )} />
                <FormField control={form.control} name="branchId" render={({ field }) => (
                  <FormItem><FormLabel>Specific Location</FormLabel>
                    {(watchBranchType === 'headoffice' || watchBranchType === 'production') ? (
                      <Select value="0" onValueChange={() => field.onChange(0)}>
                        <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                        <SelectContent><SelectItem value="0">Central Hub</SelectItem></SelectContent>
                      </Select>
                    ) : (
                      <Select onValueChange={v => field.onChange(Number(v))} value={field.value ? String(field.value) : ''}>
                        <FormControl><SelectTrigger><SelectValue placeholder="Select location" /></SelectTrigger></FormControl>
                        <SelectContent>
                          {watchBranchType === 'warehouse' && warehouses.map(w => <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>)}
                          {watchBranchType === 'outlet' && outlets.map(o => <SelectItem key={o.id} value={String(o.id)}>{o.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    )}
                    <FormMessage /></FormItem>
                )} />
              </div>

              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => setIsOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createMutation.isPending}>{createMutation.isPending ? 'Saving…' : 'Save Employee'}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Sheet open={!!viewItem} onOpenChange={v => !v && setViewItem(null)}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle className="flex items-center gap-3">
              <Avatar className="h-10 w-10"><AvatarFallback className="bg-primary/10 text-primary font-bold">{viewItem?.name?.charAt(0)}</AvatarFallback></Avatar>
              {viewItem?.name}
            </SheetTitle>
            <SheetDescription>@{viewItem?.username} · {viewItem?.hierarchyName}</SheetDescription>
          </SheetHeader>
          {viewItem && (
            <div className="mt-6 space-y-4">
              {[['Role', viewItem.hierarchyName], ['Location', `${viewItem.branchName} (${viewItem.branchType})`], ['Email', viewItem.email || '—'], ['Phone', viewItem.phone || '—'], ['Salary', `₹${Number(viewItem.salary || 0).toLocaleString('en-IN')}/mo`], ['Join Date', viewItem.joinDate ? new Date(viewItem.joinDate).toLocaleDateString('en-IN') : '—'], ['Status', viewItem.isActive ? 'Active' : 'Inactive']].map(([k, v]) => (
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
