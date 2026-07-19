import { useState } from 'react';
import {
  useListEmployees, useCreateEmployee, useUpdateEmployee, useListHierarchies, useListWarehouses, useListOutlets,
  getListEmployeesQueryKey, useGetPayComponents, useSetPayComponents, getPayComponentsQueryKey,
  type PayComponent, type PayComponents,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Plus, Search, Users, Download, Eye, Settings2, Trash2, UserX, UserCheck } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';

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

const ALLOWANCE_COMP_TYPES = [
  { value: 'fixed', label: 'Fixed ₹' },
  { value: 'percent_of_basic', label: '% of Basic' },
];
const DEDUCTION_COMP_TYPES = [
  { value: 'fixed', label: 'Fixed ₹' },
  { value: 'percent_of_basic', label: '% of Basic' },
  { value: 'percent_of_gross', label: '% of Gross' },
];

// ── Pay Structure Editor ────────────────────────────────────────────────────

function PayStructureEditor({ employee }: { employee: any }) {
  const queryClient = useQueryClient();
  const { data: pc, isLoading } = useGetPayComponents(employee.id);
  const setMutation = useSetPayComponents();

  const [workingDays, setWorkingDays] = useState<number | null>(null);
  const [allowances, setAllowances] = useState<PayComponent[] | null>(null);
  const [deductions, setDeductions] = useState<PayComponent[] | null>(null);

  const effectiveWD = workingDays ?? pc?.workingDaysPerMonth ?? 26;
  const effectiveAllowances = allowances ?? pc?.allowances ?? [];
  const effectiveDeductions = deductions ?? pc?.deductions ?? [];

  if (pc && allowances === null) setAllowances(pc.allowances);
  if (pc && deductions === null) setDeductions(pc.deductions);
  if (pc && workingDays === null) setWorkingDays(pc.workingDaysPerMonth);

  const handleSave = () => {
    setMutation.mutate(
      { employeeId: employee.id, data: { workingDaysPerMonth: effectiveWD, allowances: effectiveAllowances, deductions: effectiveDeductions } },
      {
        onSuccess: () => { toast.success('Pay structure saved'); queryClient.invalidateQueries({ queryKey: getPayComponentsQueryKey(employee.id) }); },
        onError: (e: any) => toast.error(e?.message || 'Failed to save'),
      },
    );
  };

  const addComp = (kind: 'allowances' | 'deductions') => {
    const newComp: PayComponent = { name: '', type: 'fixed', value: 0, enabled: true };
    if (kind === 'allowances') setAllowances([...effectiveAllowances, newComp]);
    else setDeductions([...effectiveDeductions, newComp]);
  };

  const updateComp = (kind: 'allowances' | 'deductions', idx: number, field: keyof PayComponent, val: any) => {
    const list = kind === 'allowances' ? [...effectiveAllowances] : [...effectiveDeductions];
    (list[idx] as any)[field] = val;
    if (kind === 'allowances') setAllowances(list);
    else setDeductions(list);
  };

  const removeComp = (kind: 'allowances' | 'deductions', idx: number) => {
    if (kind === 'allowances') setAllowances(effectiveAllowances.filter((_, i) => i !== idx));
    else setDeductions(effectiveDeductions.filter((_, i) => i !== idx));
  };

  const basicSalary = employee.salary;
  const perDay = basicSalary / effectiveWD;
  const grossWithAllowances = effectiveAllowances.reduce((sum, a) => {
    if (a.enabled === false) return sum;
    return sum + (a.type === 'fixed' ? a.value : basicSalary * a.value / 100);
  }, basicSalary);
  const totalDeductions = effectiveDeductions.reduce((sum, d) => {
    if (d.enabled === false) return sum;
    const base = d.type === 'percent_of_basic' ? basicSalary : d.type === 'percent_of_gross' ? grossWithAllowances : 0;
    return sum + (d.type === 'fixed' ? d.value : base * d.value / 100);
  }, 0);

  if (isLoading) return <div className="py-8 text-center text-muted-foreground text-sm">Loading pay structure…</div>;

  const CompList = ({ kind }: { kind: 'allowances' | 'deductions' }) => {
    const list = kind === 'allowances' ? effectiveAllowances : effectiveDeductions;
    const color = kind === 'allowances' ? 'text-emerald-600' : 'text-red-500';
    return (
      <div className="space-y-2">
        {list.map((comp, idx) => (
          <div key={idx} className="flex items-center gap-2 p-2 bg-muted/20 rounded-lg border border-border">
            <Switch checked={comp.enabled !== false} onCheckedChange={v => updateComp(kind, idx, 'enabled', v)} className="flex-shrink-0" />
            <Input placeholder="Component name" value={comp.name} onChange={e => updateComp(kind, idx, 'name', e.target.value)} className="h-7 text-xs flex-1" />
            <Select value={comp.type} onValueChange={v => updateComp(kind, idx, 'type', v)}>
              <SelectTrigger className="h-7 w-36 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(kind === 'allowances' ? ALLOWANCE_COMP_TYPES : DEDUCTION_COMP_TYPES).map(t => (
                  <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input type="number" min={0} step={0.01} value={comp.value} onChange={e => updateComp(kind, idx, 'value', Number(e.target.value))} className={`h-7 w-20 text-xs text-right font-mono ${color}`} />
            <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-destructive flex-shrink-0" onClick={() => removeComp(kind, idx)}><Trash2 className="w-3 h-3" /></Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" className="w-full h-7 text-xs border-dashed" onClick={() => addComp(kind)}>
          <Plus className="w-3 h-3 mr-1" /> Add {kind === 'allowances' ? 'Allowance' : 'Deduction'}
        </Button>
      </div>
    );
  };

  return (
    <div className="space-y-5 mt-2">
      <div className="flex items-center gap-3">
        <Label className="text-xs text-muted-foreground whitespace-nowrap">Working days/month</Label>
        <Input type="number" min={1} max={31} value={effectiveWD} onChange={e => setWorkingDays(Number(e.target.value))} className="h-7 w-20 text-sm text-right" />
      </div>
      <Tabs defaultValue="allowances">
        <TabsList className="w-full">
          <TabsTrigger value="allowances" className="flex-1">Allowances ({effectiveAllowances.filter(a => a.enabled !== false).length} active)</TabsTrigger>
          <TabsTrigger value="deductions" className="flex-1">Deductions ({effectiveDeductions.filter(d => d.enabled !== false).length} active)</TabsTrigger>
        </TabsList>
        <TabsContent value="allowances" className="mt-3"><CompList kind="allowances" /></TabsContent>
        <TabsContent value="deductions" className="mt-3"><CompList kind="deductions" /></TabsContent>
      </Tabs>
      <div className="p-3 bg-muted/30 rounded-lg text-xs space-y-1 border border-border">
        <p className="text-muted-foreground font-medium uppercase tracking-wider mb-2">Monthly Preview (full attendance)</p>
        <div className="flex justify-between"><span>Basic</span><span className="font-mono">₹{basicSalary.toLocaleString('en-IN')}</span></div>
        {effectiveAllowances.filter(a => a.enabled !== false).map((a, i) => {
          const amt = a.type === 'fixed' ? a.value : basicSalary * a.value / 100;
          return <div key={i} className="flex justify-between text-emerald-600"><span>+ {a.name}</span><span className="font-mono">₹{amt.toFixed(0)}</span></div>;
        })}
        <div className="flex justify-between font-semibold border-t border-border pt-1 mt-1"><span>Gross</span><span className="font-mono">₹{grossWithAllowances.toFixed(0)}</span></div>
        {effectiveDeductions.filter(d => d.enabled !== false).map((d, i) => {
          const base = d.type === 'percent_of_basic' ? basicSalary : d.type === 'percent_of_gross' ? grossWithAllowances : 0;
          const amt = d.type === 'fixed' ? d.value : base * d.value / 100;
          return <div key={i} className="flex justify-between text-red-500"><span>- {d.name}</span><span className="font-mono">₹{amt.toFixed(2)}</span></div>;
        })}
        <div className="flex justify-between font-bold border-t border-border pt-1 mt-1 text-sm text-primary"><span>Net Pay</span><span className="font-mono">₹{(grossWithAllowances - totalDeductions).toFixed(0)}</span></div>
        <p className="text-muted-foreground mt-1 pt-1 border-t border-border">Per day (LOP): ₹{perDay.toFixed(2)}</p>
      </div>
      <Button className="w-full" onClick={handleSave} disabled={setMutation.isPending}>
        {setMutation.isPending ? 'Saving…' : 'Save Pay Structure'}
      </Button>
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────────────────────

type StatusFilter = 'all' | 'active' | 'inactive';

export default function Employees() {
  const { data: employees = [], isLoading } = useListEmployees();
  const { data: hierarchies = [] } = useListHierarchies();
  const { data: warehouses = [] } = useListWarehouses();
  const { data: outlets = [] } = useListOutlets();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');
  const [isOpen, setIsOpen] = useState(false);
  const [viewItem, setViewItem] = useState<any>(null);
  const [payStructureEmp, setPayStructureEmp] = useState<any>(null);
  const [confirmResign, setConfirmResign] = useState<any>(null);
  const queryClient = useQueryClient();
  const createMutation = useCreateEmployee();
  const updateMutation = useUpdateEmployee();

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

  const toggleActive = (emp: any, active: boolean) => {
    updateMutation.mutate(
      { id: emp.id, data: { isActive: active } },
      {
        onSuccess: () => {
          toast.success(active ? `${emp.name} reactivated` : `${emp.name} marked as resigned`);
          queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey() });
          setConfirmResign(null);
          // Close detail sheet if open for this employee
          if (viewItem?.id === emp.id) setViewItem((prev: any) => ({ ...prev, isActive: active }));
        },
        onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
      },
    );
  };

  const filtered = employees.filter(e => {
    const matchSearch = e.name.toLowerCase().includes(search.toLowerCase()) || e.username.toLowerCase().includes(search.toLowerCase());
    const matchStatus = statusFilter === 'all' ? true : statusFilter === 'active' ? e.isActive : !e.isActive;
    return matchSearch && matchStatus;
  });

  const activeCount   = employees.filter(e => e.isActive).length;
  const inactiveCount = employees.filter(e => !e.isActive).length;

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><Users className="w-6 h-6 text-primary" /> Employee Directory</h1>
            <p className="text-muted-foreground mt-1">Personnel, roles, branch assignments, and pay structures</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => downloadCSV('employees.csv', filtered.map(e => ({ Name: e.name, Username: e.username, Role: e.hierarchyName, Branch: e.branchName, Type: e.branchType, Salary: e.salary, Status: e.isActive ? 'Active' : 'Resigned' })))}>
              <Download className="w-4 h-4 mr-2" /> Export
            </Button>
            <Button onClick={() => { form.reset({ name: '', username: '', email: '', phone: '', hierarchyId: 0, branchType: 'headoffice', branchId: 0, salary: 0, joinDate: new Date().toISOString().split('T')[0] }); setIsOpen(true); }}>
              <Plus className="w-4 h-4 mr-2" /> Add Employee
            </Button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
          <div className="flex items-center gap-1 p-1 bg-muted/30 rounded-lg border border-border">
            {(['all', 'active', 'inactive'] as StatusFilter[]).map(s => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${statusFilter === s ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {s === 'all' ? `All (${employees.length})` : s === 'active' ? `Active (${activeCount})` : `Resigned (${inactiveCount})`}
              </button>
            ))}
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
              {isLoading ? (
                [...Array(4)].map((_, i) => (
                  <TableRow key={i}><TableCell colSpan={6}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
                ))
              ) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center py-16 text-muted-foreground">
                  <Users className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No employees found</p>
                </TableCell></TableRow>
              ) : filtered.map(emp => (
                <TableRow key={emp.id} className={`hover:bg-muted/10 ${!emp.isActive ? 'opacity-60' : ''}`}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <Avatar className="h-9 w-9">
                        <AvatarFallback className={`text-sm font-bold ${emp.isActive ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
                          {emp.name.charAt(0)}
                        </AvatarFallback>
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
                    {emp.isActive ? (
                      <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20">Active</Badge>
                    ) : (
                      <Badge variant="outline" className="text-rose-400 border-rose-400/30 bg-rose-400/5">Resigned</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(emp)} title="View"><Eye className="w-4 h-4" /></Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setPayStructureEmp(emp)} title="Pay Structure"><Settings2 className="w-4 h-4" /></Button>
                      {emp.isActive ? (
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-rose-500" onClick={() => setConfirmResign(emp)} title="Mark as Resigned">
                          <UserX className="w-4 h-4" />
                        </Button>
                      ) : (
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-emerald-500" onClick={() => toggleActive(emp, true)} title="Reactivate" disabled={updateMutation.isPending}>
                          <UserCheck className="w-4 h-4" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Confirm Resignation Dialog */}
      <Dialog open={!!confirmResign} onOpenChange={v => !v && setConfirmResign(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-rose-500">
              <UserX className="w-5 h-5" /> Mark as Resigned
            </DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-2">
            <p className="text-sm text-muted-foreground">
              Are you sure you want to mark <span className="font-semibold text-foreground">{confirmResign?.name}</span> as resigned?
            </p>
            <p className="text-xs text-muted-foreground">
              The employee will be set to inactive and excluded from payroll generation. This can be reversed using the Reactivate button.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmResign(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => toggleActive(confirmResign, false)}
              disabled={updateMutation.isPending}
            >
              {updateMutation.isPending ? 'Saving…' : 'Mark as Resigned'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Employee Dialog */}
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
                  <FormItem><FormLabel>Monthly Basic Salary ₹</FormLabel><FormControl><Input type="number" min={0} {...field} /></FormControl></FormItem>
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

      {/* Employee detail sheet */}
      <Sheet open={!!viewItem} onOpenChange={v => !v && setViewItem(null)}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle className="flex items-center gap-3">
              <Avatar className="h-10 w-10">
                <AvatarFallback className={`font-bold ${viewItem?.isActive ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
                  {viewItem?.name?.charAt(0)}
                </AvatarFallback>
              </Avatar>
              {viewItem?.name}
            </SheetTitle>
            <SheetDescription>@{viewItem?.username} · {viewItem?.hierarchyName}</SheetDescription>
          </SheetHeader>
          {viewItem && (
            <div className="mt-6 space-y-4">
              {[
                ['Role', viewItem.hierarchyName],
                ['Location', `${viewItem.branchName} (${viewItem.branchType})`],
                ['Email', viewItem.email || '—'],
                ['Phone', viewItem.phone || '—'],
                ['Basic Salary', `₹${Number(viewItem.salary || 0).toLocaleString('en-IN')}/mo`],
                ['Join Date', viewItem.joinDate ? new Date(viewItem.joinDate).toLocaleDateString('en-IN') : '—'],
              ].map(([k, v]) => (
                <div key={k} className="flex flex-col gap-1 border-b border-border pb-3">
                  <span className="text-xs text-muted-foreground uppercase tracking-wider">{k}</span>
                  <span className="font-medium">{v}</span>
                </div>
              ))}

              {/* Status row with toggle */}
              <div className="flex flex-col gap-1 border-b border-border pb-3">
                <span className="text-xs text-muted-foreground uppercase tracking-wider">Status</span>
                <div className="flex items-center justify-between">
                  {viewItem.isActive ? (
                    <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20">Active</Badge>
                  ) : (
                    <Badge variant="outline" className="text-rose-400 border-rose-400/30 bg-rose-400/5">Resigned</Badge>
                  )}
                  {viewItem.isActive ? (
                    <Button variant="outline" size="sm" className="h-7 text-xs text-rose-500 border-rose-400/30 hover:bg-rose-500/10" onClick={() => { setViewItem(null); setConfirmResign(viewItem); }}>
                      <UserX className="w-3 h-3 mr-1" /> Mark Resigned
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" className="h-7 text-xs text-emerald-500 border-emerald-500/30 hover:bg-emerald-500/10" onClick={() => toggleActive(viewItem, true)} disabled={updateMutation.isPending}>
                      <UserCheck className="w-3 h-3 mr-1" /> Reactivate
                    </Button>
                  )}
                </div>
              </div>

              <Button variant="outline" className="w-full" onClick={() => { setViewItem(null); setPayStructureEmp(viewItem); }}>
                <Settings2 className="w-4 h-4 mr-2" /> Configure Pay Structure
              </Button>
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* Pay Structure Sheet */}
      <Sheet open={!!payStructureEmp} onOpenChange={v => !v && setPayStructureEmp(null)}>
        <SheetContent className="sm:max-w-md overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <Settings2 className="w-5 h-5 text-primary" /> Pay Structure
            </SheetTitle>
            <SheetDescription>
              {payStructureEmp?.name} · Basic ₹{Number(payStructureEmp?.salary || 0).toLocaleString('en-IN')}/mo
            </SheetDescription>
          </SheetHeader>
          {payStructureEmp && <PayStructureEditor employee={payStructureEmp} />}
        </SheetContent>
      </Sheet>
    </AppLayout>
  );
}
