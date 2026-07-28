import { useState, useMemo } from 'react';
import { useListLeaves, useApplyLeave, useApproveLeave, getListLeavesQueryKey, useListEmployees, useListWarehouses, useListOutlets } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Plus, Search, CalendarOff, Download, Eye, CheckCircle, XCircle, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';
import { usePermission } from '@/lib/usePermission';

const schema = z.object({
  employeeId: z.coerce.number().min(1, 'Employee required'),
  leaveType: z.enum(['sick', 'casual', 'annual', 'other']),
  startDate: z.string().min(1, 'Start date required'),
  endDate: z.string().min(1, 'End date required'),
  reason: z.string().min(1, 'Reason required'),
});
type FormValues = z.infer<typeof schema>;

export default function Leave() {
  const perm = usePermission('page:/hr/attendance');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const { data: leaves = [], isLoading } = useListLeaves(statusFilter !== 'all' ? { status: statusFilter as any } : undefined);
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [viewItem, setViewItem] = useState<any>(null);
  const [branchTypeFilter, setBranchTypeFilter] = useState<string>('all');
  const [branchLocId, setBranchLocId] = useState<string>('all');
  const queryClient = useQueryClient();
  const applyMutation = useApplyLeave();
  const approveMutation = useApproveLeave();
  const { data: employees = [] } = useListEmployees();
  const { data: warehouses = [] } = useListWarehouses();
  const { data: outlets = [] } = useListOutlets();

  const empBranchMap = useMemo(() => {
    const m = new Map<number, { branchType: string; branchId: number }>();
    for (const e of employees as any[]) m.set(e.id, { branchType: e.branchType, branchId: e.branchId });
    return m;
  }, [employees]);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { employeeId: 0, leaveType: 'casual', startDate: '', endDate: '', reason: '' },
  });

  const onSubmit = (data: FormValues) => {
    // API contract uses fromDate/toDate; the form collects startDate/endDate.
    const { startDate, endDate, ...rest } = data;
    applyMutation.mutate({ data: { ...rest, fromDate: startDate, toDate: endDate } }, {
      onSuccess: () => { toast.success('Leave application submitted'); queryClient.invalidateQueries({ queryKey: getListLeavesQueryKey() }); setIsOpen(false); form.reset(); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  const handleApprove = (id: number, approved: boolean) => {
    approveMutation.mutate({ id, data: { status: approved ? 'approved' : 'rejected', note: approved ? 'Approved' : 'Rejected' } }, {
      onSuccess: () => { toast.success(approved ? 'Leave approved' : 'Leave rejected'); queryClient.invalidateQueries({ queryKey: getListLeavesQueryKey() }); setViewItem(null); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  // The API exposes fromDate/toDate only; the day count is derived (inclusive).
  const leaveDays = (l: any) => {
    if (!l?.fromDate || !l?.toDate) return '—';
    const from = new Date(l.fromDate), to = new Date(l.toDate);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) return '—';
    return String(Math.floor((to.getTime() - from.getTime()) / 86400000) + 1);
  };
  const fmtDate = (d?: string | null) => {
    if (!d) return '—';
    const dt = new Date(d);
    return isNaN(dt.getTime()) ? '—' : dt.toLocaleDateString('en-IN');
  };

  const statusColor = (s: string) => s === 'approved' ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' : s === 'rejected' ? 'bg-red-500/10 text-red-500 border-red-500/20' : 'bg-amber-500/10 text-amber-500 border-amber-500/20';
  const filtered = (leaves as any[]).filter(l => {
    const matchSearch = l.employeeName?.toLowerCase().includes(search.toLowerCase());
    const branch = empBranchMap.get(l.employeeId);
    const matchBranchType = branchTypeFilter === 'all' || branch?.branchType === branchTypeFilter;
    const matchBranchLoc = branchLocId === 'all' || String(branch?.branchId) === branchLocId;
    return matchSearch && matchBranchType && matchBranchLoc;
  });

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
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><CalendarOff className="w-6 h-6 text-primary" /> Leave Management</h1>
            <p className="text-muted-foreground mt-1">Apply, approve, and track employee leaves</p>
          </div>
          <div className="flex gap-2">
            {perm.canDownload && (
            <Button variant="outline" size="sm" onClick={() => downloadCSV('leaves.csv', filtered.map(l => ({ Employee: l.employeeName, Type: l.leaveType, From: l.fromDate, To: l.toDate, Days: leaveDays(l), Status: l.status })))}>
              <Download className="w-4 h-4 mr-2" /> Export
            </Button>
            )}
            {perm.canAdd && <Button onClick={() => { form.reset(); setIsOpen(true); }}><Plus className="w-4 h-4 mr-2" /> Apply Leave</Button>}
          </div>
        </div>

        {/* Branch filter */}
        <div className="flex flex-wrap gap-2 items-center">
          <Select value={branchTypeFilter} onValueChange={v => { setBranchTypeFilter(v); setBranchLocId('all'); }}>
            <SelectTrigger className="h-7 w-38 text-xs"><SelectValue placeholder="All Branches" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Branches</SelectItem>
              <SelectItem value="headoffice">Head Office</SelectItem>
              <SelectItem value="warehouse">Warehouse</SelectItem>
              <SelectItem value="outlet">Outlet</SelectItem>
            </SelectContent>
          </Select>
          {branchTypeFilter === 'warehouse' && (
            <Select value={branchLocId} onValueChange={setBranchLocId}>
              <SelectTrigger className="h-7 w-44 text-xs"><SelectValue placeholder="All Warehouses" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Warehouses</SelectItem>
                {(warehouses as any[]).map(w => <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
          {branchTypeFilter === 'outlet' && (
            <Select value={branchLocId} onValueChange={setBranchLocId}>
              <SelectTrigger className="h-7 w-44 text-xs"><SelectValue placeholder="All Outlets" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Outlets</SelectItem>
                {(outlets as any[]).map(o => <SelectItem key={o.id} value={String(o.id)}>{o.name}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex flex-wrap gap-3 bg-muted/20">
            <div className="flex items-center gap-2 flex-1">
              <Search className="w-4 h-4 text-muted-foreground" />
              <Input placeholder="Search employee..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0" />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="approved">Approved</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Employee</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>From</TableHead>
                <TableHead>To</TableHead>
                <TableHead>Days</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(3)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={7}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="text-center py-16 text-muted-foreground">
                  <CalendarOff className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No leave applications</p>
                </TableCell></TableRow>
              ) : filtered.map(l => (
                <TableRow key={l.id} className="hover:bg-muted/10">
                  <TableCell className="font-semibold">{l.employeeName}</TableCell>
                  <TableCell><Badge variant="outline" className="capitalize text-xs">{l.leaveType}</Badge></TableCell>
                  <TableCell className="text-sm">{fmtDate(l.fromDate)}</TableCell>
                  <TableCell className="text-sm">{fmtDate(l.toDate)}</TableCell>
                  <TableCell className="font-mono font-bold text-primary">{leaveDays(l)}</TableCell>
                  <TableCell><Badge variant="outline" className={statusColor(l.status || 'pending')}>{l.status || 'pending'}</Badge></TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(l)}><Eye className="w-4 h-4" /></Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Apply for Leave</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">
              <FormField control={form.control} name="employeeId" render={({ field }) => (
                <FormItem><FormLabel>Employee ID <span className="text-destructive">*</span></FormLabel><FormControl><Input type="number" placeholder="Enter employee ID" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="leaveType" render={({ field }) => (
                <FormItem><FormLabel>Leave Type</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value="sick">Sick Leave</SelectItem>
                      <SelectItem value="casual">Casual Leave</SelectItem>
                      <SelectItem value="annual">Annual Leave</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select></FormItem>
              )} />
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="startDate" render={({ field }) => (
                  <FormItem><FormLabel>From <span className="text-destructive">*</span></FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="endDate" render={({ field }) => (
                  <FormItem><FormLabel>To <span className="text-destructive">*</span></FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
              </div>
              <FormField control={form.control} name="reason" render={({ field }) => (
                <FormItem><FormLabel>Reason <span className="text-destructive">*</span></FormLabel><FormControl><Textarea placeholder="Reason for leave..." rows={3} {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => setIsOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={applyMutation.isPending}>{applyMutation.isPending ? 'Submitting…' : 'Submit'}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Sheet open={!!viewItem} onOpenChange={v => !v && setViewItem(null)}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{viewItem?.employeeName}</SheetTitle>
            <SheetDescription className="capitalize">{viewItem?.leaveType} Leave</SheetDescription>
          </SheetHeader>
          {viewItem && (
            <div className="mt-6 space-y-4">
              {[['From', fmtDate(viewItem.fromDate)], ['To', fmtDate(viewItem.toDate)], ['Days', leaveDays(viewItem)], ['Status', viewItem.status || 'pending'], ['Reason', viewItem.reason || '—'], ['Remarks', viewItem.approvalNote || '—']].map(([k, v]) => (
                <div key={k} className="flex flex-col gap-1 border-b border-border pb-3">
                  <span className="text-xs text-muted-foreground uppercase tracking-wider">{k}</span>
                  <span className="font-medium">{v}</span>
                </div>
              ))}
              {perm.canEdit && (viewItem.status === 'pending' || !viewItem.status) && (
                <div className="flex gap-2 pt-2">
                  <Button className="flex-1 bg-emerald-600 hover:bg-emerald-700" onClick={() => handleApprove(viewItem.id, true)} disabled={approveMutation.isPending}>
                    <CheckCircle className="w-4 h-4 mr-2" /> Approve
                  </Button>
                  <Button variant="destructive" className="flex-1" onClick={() => handleApprove(viewItem.id, false)} disabled={approveMutation.isPending}>
                    <XCircle className="w-4 h-4 mr-2" /> Reject
                  </Button>
                </div>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </AppLayout>
  );
}
