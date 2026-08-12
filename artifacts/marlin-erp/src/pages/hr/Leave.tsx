import { useState, useMemo } from 'react';
import {
  useListLeaves, useApplyLeave, useApproveLeave, useCancelLeave, getListLeavesQueryKey,
  useListEmployees, useListWarehouses, useListOutlets, useGetMe, useAttendanceConfig,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import {
  Plus, Search, CalendarOff, Download, Eye, CheckCircle, XCircle, ShieldOff,
  Hourglass, CalendarCheck, CalendarX, Plane, CalendarClock,
} from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';
import { usePermission } from '@/lib/usePermission';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { useOutletsEnabled, useClearOutletSelection } from '@/lib/useFeatureFlags';
import { PageHeader } from '@/components/app/page-header';
import { SummaryCard, SummaryCardGrid } from '@/components/app/summary-card';
import { StatusBadge } from '@/components/app/status-badge';
import { EmptyState } from '@/components/app/empty-state';
import { FilterPanel } from '@/components/app/filter-panel';
import { EntityCombobox } from '@/components/ui/entity-combobox';
import { TablePager, useClientPage } from '@/components/ui/table-pager';

const schema = z.object({
  employeeId: z.coerce.number().min(1, 'Employee required'),
  leaveType: z.enum(['sick', 'casual', 'annual', 'other']),
  startDate: z.string().min(1, 'Start date required'),
  endDate: z.string().min(1, 'End date required'),
  reason: z.string().min(1, 'Reason required'),
});
type FormValues = z.infer<typeof schema>;

const LEAVE_TYPE_LABEL: Record<string, string> = {
  sick: 'Sick', casual: 'Casual', annual: 'Annual', other: 'Other',
};

/** Plain YYYY-MM-DD → local-safe display; ISO timestamps pass through. */
const fmtDate = (d?: string | null) => {
  if (!d) return '—';
  const dt = new Date(String(d).length === 10 ? d + 'T00:00:00' : d);
  return isNaN(dt.getTime()) ? '—' : dt.toLocaleDateString('en-IN');
};

/** Inclusive day count — prefers the server's figure. */
const leaveDays = (l: any) => {
  if (typeof l?.days === 'number' && l.days > 0) return String(l.days);
  if (!l?.fromDate || !l?.toDate) return '—';
  const from = new Date(String(l.fromDate).slice(0, 10) + 'T00:00:00Z');
  const to = new Date(String(l.toDate).slice(0, 10) + 'T00:00:00Z');
  if (isNaN(from.getTime()) || isNaN(to.getTime())) return '—';
  return String(Math.round((to.getTime() - from.getTime()) / 86400000) + 1);
};

export default function Leave() {
  const perm = usePermission('page:/hr/attendance');
  const { data: me } = useGetMe();
  const myId = (me as any)?.id as number | undefined;

  // ── Filters (server-side where the API supports them) ──────────────────────
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [employeeFilter, setEmployeeFilter] = useState<string>('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [branchTypeFilter, setBranchTypeFilter] = useState<string>('all');
  const [branchLocId, setBranchLocId] = useState<string>('all');
  const [search, setSearch] = useState('');
  useClearOutletSelection(branchTypeFilter === 'outlet', () => { setBranchTypeFilter('all'); setBranchLocId('all'); });

  const listParams = useMemo(() => {
    const p: any = {};
    if (statusFilter !== 'all') p.status = statusFilter;
    if (typeFilter !== 'all') p.leaveType = typeFilter;
    if (employeeFilter !== 'all') p.employeeId = Number(employeeFilter);
    // Partial dates (mid-typing) are dropped, not sent.
    if (/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) p.fromDate = fromDate;
    if (/^\d{4}-\d{2}-\d{2}$/.test(toDate)) p.toDate = toDate;
    if (branchTypeFilter !== 'all') p.branchType = branchTypeFilter;
    if (branchLocId !== 'all') p.branchId = Number(branchLocId);
    return Object.keys(p).length ? p : undefined;
  }, [statusFilter, typeFilter, employeeFilter, fromDate, toDate, branchTypeFilter, branchLocId]);

  const { data: leaves = [], isLoading } = useListLeaves(listParams);
  // Unfiltered list feeds the summary cards, so a filter never changes the
  // headline numbers. Scoping still happens server-side.
  const { data: allLeaves = [] } = useListLeaves();

  const [isOpen, setIsOpen] = useState(false);
  const [viewItem, setViewItem] = useState<any>(null);
  const [rejectItem, setRejectItem] = useState<any>(null);
  const [rejectReason, setRejectReason] = useState('');
  const queryClient = useQueryClient();
  const applyMutation = useApplyLeave();
  const approveMutation = useApproveLeave();
  const cancelMutation = useCancelLeave();
  const { data: employees = [] } = useListEmployees();
  const { data: warehouses = [] } = useListWarehouses();
  const { data: outlets = [] } = useListOutlets();
  const { outletsEnabled } = useOutletsEnabled();
  const { data: attCfg } = useAttendanceConfig();
  // "Today" is the company's operational day, not the browser's calendar.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: (attCfg as any)?.timeZone ?? 'Asia/Kolkata' });

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { employeeId: 0, leaveType: 'casual', startDate: '', endDate: '', reason: '' },
  });

  // ── Summary cards ───────────────────────────────────────────────────────────
  const cards = useMemo(() => {
    const all = allLeaves as any[];
    const decidedToday = (l: any) =>
      l.approvedAt && new Date(l.approvedAt).toLocaleDateString('en-CA', { timeZone: (attCfg as any)?.timeZone ?? 'Asia/Kolkata' }) === today;
    const dateOf = (d: any) => String(d).slice(0, 10);
    return {
      pending: all.filter(l => l.status === 'pending').length,
      approvedToday: all.filter(l => l.status === 'approved' && decidedToday(l)).length,
      rejectedToday: all.filter(l => l.status === 'rejected' && decidedToday(l)).length,
      onLeaveToday: new Set(all.filter(l => l.status === 'approved' && dateOf(l.fromDate) <= today && dateOf(l.toDate) >= today).map(l => l.employeeId)).size,
      upcoming: all.filter(l => l.status === 'approved' && dateOf(l.fromDate) > today).length,
    };
  }, [allLeaves, today, attCfg]);

  // ── Actions ─────────────────────────────────────────────────────────────────
  const refresh = () => queryClient.invalidateQueries({ queryKey: getListLeavesQueryKey() });

  const onSubmit = (data: FormValues) => {
    const { startDate, endDate, ...rest } = data;
    applyMutation.mutate({ data: { ...rest, fromDate: startDate, toDate: endDate } }, {
      onSuccess: () => { toast.success('Leave application submitted'); refresh(); setIsOpen(false); form.reset(); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  const handleApprove = (l: any) => {
    approveMutation.mutate({ id: l.id, data: { status: 'approved' } }, {
      onSuccess: () => {
        toast.success(`Leave approved — ${l.employeeName}'s ${leaveDays(l)} day(s) are now marked as paid leave`);
        refresh(); setViewItem(null);
      },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  const submitReject = () => {
    if (!rejectItem) return;
    const note = rejectReason.trim();
    if (!note) { toast.error('A reason is required to reject a leave request'); return; }
    approveMutation.mutate({ id: rejectItem.id, data: { status: 'rejected', note } }, {
      onSuccess: () => {
        toast.success('Leave request rejected');
        refresh(); setRejectItem(null); setRejectReason(''); setViewItem(null);
      },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  const handleCancel = (l: any) => {
    cancelMutation.mutate({ id: l.id }, {
      onSuccess: () => { toast.success('Leave request cancelled'); refresh(); setViewItem(null); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  // Approve/Reject appear only for pending rows, only with the Edit right, and
  // never on your own request — the server refuses all three anyway.
  const canDecide = (l: any) => perm.canEdit && l.status === 'pending' && l.employeeId !== myId;

  // Employee name/ID search stays client-side — it's a typeahead over the
  // already-scoped result set.
  const filtered = (leaves as any[]).filter(l => {
    const q = search.toLowerCase();
    return !q || l.employeeName?.toLowerCase().includes(q) || String(l.employeeId).includes(q);
  });

  const { sorted, sort } = useTableSort(filtered, {
    employee: (l: any) => l.employeeName,
    branch: (l: any) => l.branchName,
    role: (l: any) => l.roleName,
    type: (l: any) => LEAVE_TYPE_LABEL[l.leaveType] ?? l.leaveType,
    from: (l: any) => l.fromDate,
    to: (l: any) => l.toDate,
    days: (l: any) => { const d = leaveDays(l); return d === '—' ? null : Number(d); },
    appliedOn: (l: any) => l.createdAt,
    status: (l: any) => l.status || 'pending',
    approver: (l: any) => l.approverName,
  });

  const { pageRows, pagerProps } = useClientPage(sorted);

  // Non-default filter values (search stays outside the panel, so excluded).
  const activeFilterCount =
    (statusFilter !== 'all' ? 1 : 0) +
    (typeFilter !== 'all' ? 1 : 0) +
    (employeeFilter !== 'all' ? 1 : 0) +
    (branchTypeFilter !== 'all' ? 1 : 0) +
    (branchLocId !== 'all' ? 1 : 0) +
    (fromDate ? 1 : 0) +
    (toDate ? 1 : 0);
  const clearFilters = () => {
    setStatusFilter('all'); setTypeFilter('all'); setEmployeeFilter('all');
    setBranchTypeFilter('all'); setBranchLocId('all'); setFromDate(''); setToDate('');
  };

  if (!perm.isLoading && !perm.canView) {
    return (
      <AppLayout>
        <EmptyState
          icon={ShieldOff}
          title="Access Denied"
          hint="You don't have permission to view this page. Contact your administrator to request access."
          className="min-h-[60vh]"
        />
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-6">
        <PageHeader
          title="Leave Approvals"
          description="Review, approve and track employee leave requests"
          icon={CalendarOff}
          actions={
            <>
              {perm.canEdit && cards.pending > 0 && (
                <Badge className="bg-amber-500/15 text-amber-600 border-amber-500/30 mr-1">
                  {cards.pending} pending
                </Badge>
              )}
              {perm.canDownload && (
              <Button variant="outline" size="sm" onClick={() => downloadCSV('leaves.csv', filtered.map(l => ({
                Employee: l.employeeName, 'Employee ID': l.employeeId, Branch: l.branchName ?? '—', Role: l.roleName ?? '—',
                Type: l.leaveType, From: String(l.fromDate).slice(0, 10), To: String(l.toDate).slice(0, 10), Days: leaveDays(l),
                Reason: l.reason ?? '', 'Applied On': l.createdAt ? String(l.createdAt).slice(0, 10) : '',
                Status: l.status, Approver: l.approverName ?? '', 'Decided On': l.approvedAt ? String(l.approvedAt).slice(0, 10) : '',
              })))}>
                <Download className="w-4 h-4 mr-2" /> Export
              </Button>
              )}
              {perm.canAdd && <Button onClick={() => { form.reset({ employeeId: myId ?? 0, leaveType: 'casual', startDate: '', endDate: '', reason: '' }); setIsOpen(true); }}><Plus className="w-4 h-4 mr-2" /> Apply Leave</Button>}
            </>
          }
        />

        {/* Summary cards */}
        <SummaryCardGrid className="grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
          <SummaryCard icon={Hourglass}     label="Pending requests" value={cards.pending}       tone="warning"  loading={isLoading} />
          <SummaryCard icon={CalendarCheck} label="Approved today"   value={cards.approvedToday} tone="positive" loading={isLoading} />
          <SummaryCard icon={CalendarX}     label="Rejected today"   value={cards.rejectedToday} tone="negative" loading={isLoading} />
          <SummaryCard icon={Plane}         label="On leave today"   value={cards.onLeaveToday}  tone="info"     loading={isLoading} />
          <SummaryCard icon={CalendarClock} label="Upcoming leaves"  value={cards.upcoming}      tone="default"  loading={isLoading} />
        </SummaryCardGrid>

        {/* Toolbar: search left, filters right */}
        <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input placeholder="Search employee name or ID..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
          </div>
          <FilterPanel activeCount={activeFilterCount} onClear={clearFilters}>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Status</label>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="approved">Approved</SelectItem>
                  <SelectItem value="rejected">Rejected</SelectItem>
                  <SelectItem value="cancelled">Cancelled</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Type</label>
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="sick">Sick</SelectItem>
                  <SelectItem value="casual">Casual</SelectItem>
                  <SelectItem value="annual">Annual</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Employee</label>
              <EntityCombobox
                options={(employees as any[]).map(e => ({ id: e.id, label: e.name }))}
                value={employeeFilter === 'all' ? null : Number(employeeFilter)}
                onChange={id => setEmployeeFilter(id == null ? 'all' : String(id))}
                placeholder="All Employees"
                clearable
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Branch</label>
              <Select value={branchTypeFilter} onValueChange={v => { setBranchTypeFilter(v); setBranchLocId('all'); }}>
                <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="All Branches" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Branches</SelectItem>
                  <SelectItem value="headoffice">Head Office</SelectItem>
                  <SelectItem value="warehouse">Warehouse</SelectItem>
                  {outletsEnabled && <SelectItem value="outlet">Outlet</SelectItem>}
                </SelectContent>
              </Select>
            </div>
            {branchTypeFilter === 'warehouse' && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Warehouse</label>
                <Select value={branchLocId} onValueChange={setBranchLocId}>
                  <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="All Warehouses" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Warehouses</SelectItem>
                    {(warehouses as any[]).map(w => <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            {branchTypeFilter === 'outlet' && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Outlet</label>
                <Select value={branchLocId} onValueChange={setBranchLocId}>
                  <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="All Outlets" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Outlets</SelectItem>
                    {(outlets as any[]).map(o => <SelectItem key={o.id} value={String(o.id)}>{o.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">From date</label>
              <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="h-9 text-sm" title="From date" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">To date</label>
              <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="h-9 text-sm" title="To date" />
            </div>
          </FilterPanel>
        </div>

        {/* Table */}
        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <SortableHead k="employee" sort={sort}>Employee</SortableHead>
                <SortableHead k="branch" sort={sort}>Branch</SortableHead>
                <SortableHead k="role" sort={sort}>Role</SortableHead>
                <SortableHead k="type" sort={sort}>Type</SortableHead>
                <SortableHead k="from" sort={sort}>From</SortableHead>
                <SortableHead k="to" sort={sort}>To</SortableHead>
                <SortableHead k="days" sort={sort}>Days</SortableHead>
                <SortableHead k="appliedOn" sort={sort}>Applied On</SortableHead>
                <SortableHead k="status" sort={sort}>Status</SortableHead>
                <SortableHead k="approver" sort={sort}>Approver</SortableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(3)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={11}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={11} className="p-0">
                  <EmptyState icon={CalendarOff} title="No leave requests" hint="No leave requests match these filters." compact />
                </TableCell></TableRow>
              ) : pageRows.map(l => (
                <TableRow key={l.id} className="hover:bg-muted/10">
                  <TableCell>
                    <p className="font-semibold leading-tight">{l.employeeName}</p>
                    <p className="text-xs text-muted-foreground">#{l.employeeId}</p>
                  </TableCell>
                  <TableCell className="text-sm">{l.branchName ?? '—'}</TableCell>
                  <TableCell className="text-sm">{l.roleName ?? '—'}</TableCell>
                  <TableCell><Badge variant="outline" className="capitalize text-xs">{LEAVE_TYPE_LABEL[l.leaveType] ?? l.leaveType}</Badge></TableCell>
                  <TableCell className="text-sm whitespace-nowrap">{fmtDate(l.fromDate)}</TableCell>
                  <TableCell className="text-sm whitespace-nowrap">{fmtDate(l.toDate)}</TableCell>
                  <TableCell className="font-mono text-sm font-bold text-primary">{leaveDays(l)}</TableCell>
                  <TableCell className="text-sm whitespace-nowrap">{fmtDate(l.createdAt)}</TableCell>
                  <TableCell><StatusBadge status={l.status || 'pending'} /></TableCell>
                  <TableCell className="text-sm">
                    {l.approverName ? (
                      <>
                        <p className="leading-tight">{l.approverName}</p>
                        <p className="text-xs text-muted-foreground">{fmtDate(l.approvedAt)}</p>
                      </>
                    ) : '—'}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {canDecide(l) && (
                      <>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-500/10"
                          title="Approve" onClick={() => handleApprove(l)} disabled={approveMutation.isPending}>
                          <CheckCircle className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-red-600 hover:text-red-700 hover:bg-red-500/10"
                          title="Reject" onClick={() => { setRejectItem(l); setRejectReason(''); }} disabled={approveMutation.isPending}>
                          <XCircle className="w-4 h-4" />
                        </Button>
                      </>
                    )}
                    {l.status === 'pending' && l.employeeId === myId && (
                      <Button variant="ghost" size="sm" className="h-8 px-2 text-xs text-muted-foreground hover:text-destructive"
                        onClick={() => handleCancel(l)} disabled={cancelMutation.isPending}>
                        Cancel
                      </Button>
                    )}
                    <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(l)}><Eye className="w-4 h-4" /></Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          </div>
        </div>

        {filtered.length > 0 && <TablePager {...pagerProps} />}
      </div>

      {/* Apply dialog */}
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Apply for Leave</DialogTitle>
            <DialogDescription>The request stays pending — attendance and salary change only if it is approved.</DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">
              <FormField control={form.control} name="employeeId" render={({ field }) => (
                <FormItem><FormLabel>Employee <span className="text-destructive">*</span></FormLabel>
                  <Select onValueChange={v => field.onChange(Number(v))} value={field.value ? String(field.value) : undefined}>
                    <FormControl><SelectTrigger><SelectValue placeholder="Select employee" /></SelectTrigger></FormControl>
                    <SelectContent>
                      {(employees as any[]).map(e => (
                        <SelectItem key={e.id} value={String(e.id)}>{e.name}{e.id === myId ? ' (you)' : ''}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select><FormMessage /></FormItem>
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
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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

      {/* Reject dialog — a reason is mandatory, the server refuses without one */}
      <Dialog open={!!rejectItem} onOpenChange={v => { if (!v) { setRejectItem(null); setRejectReason(''); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reject Leave Request</DialogTitle>
            <DialogDescription>
              {rejectItem ? `${rejectItem.employeeName} · ${LEAVE_TYPE_LABEL[rejectItem.leaveType] ?? rejectItem.leaveType} · ${fmtDate(rejectItem.fromDate)} → ${fmtDate(rejectItem.toDate)} (${leaveDays(rejectItem)} days)` : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 pt-1">
            <div>
              <p className="text-sm font-medium mb-1.5">Reason <span className="text-destructive">*</span></p>
              <Textarea value={rejectReason} onChange={e => setRejectReason(e.target.value)}
                placeholder="Why is this request being rejected? The employee will see this." rows={3} autoFocus />
            </div>
            <DialogFooter>
              <Button variant="outline" type="button" onClick={() => { setRejectItem(null); setRejectReason(''); }}>Back</Button>
              <Button variant="destructive" onClick={submitReject} disabled={approveMutation.isPending || !rejectReason.trim()}>
                {approveMutation.isPending ? 'Rejecting…' : 'Reject Request'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      {/* Detail sheet */}
      <Sheet open={!!viewItem} onOpenChange={v => !v && setViewItem(null)}>
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{viewItem?.employeeName} <span className="text-muted-foreground font-normal text-sm">#{viewItem?.employeeId}</span></SheetTitle>
            <SheetDescription className="capitalize">{viewItem?.leaveType} Leave</SheetDescription>
          </SheetHeader>
          {viewItem && (
            <div className="mt-6 space-y-4">
              {[
                ['Branch', viewItem.branchName || '—'],
                ['Role', viewItem.roleName || '—'],
                ['From', fmtDate(viewItem.fromDate)],
                ['To', fmtDate(viewItem.toDate)],
                ['Days', leaveDays(viewItem)],
                ['Applied On', fmtDate(viewItem.createdAt)],
                ['Status', viewItem.status || 'pending'],
                ['Reason', viewItem.reason || '—'],
                ...(viewItem.status === 'approved' || viewItem.status === 'rejected' ? [
                  [viewItem.status === 'approved' ? 'Approved By' : 'Rejected By', viewItem.approverName || '—'],
                  [viewItem.status === 'approved' ? 'Approved On' : 'Rejected On', fmtDate(viewItem.approvedAt)],
                ] : []),
                ...(viewItem.status === 'rejected' ? [['Rejection Reason', viewItem.approvalNote || '—']]
                  : viewItem.approvalNote ? [['Approval Note', viewItem.approvalNote]] : []),
                ...(viewItem.status === 'cancelled' ? [['Cancelled On', fmtDate(viewItem.cancelledAt)]] : []),
              ].map(([k, v]) => (
                <div key={k} className="flex flex-col gap-1 border-b border-border pb-3">
                  <span className="text-xs text-muted-foreground uppercase tracking-wider">{k}</span>
                  <span className="font-medium capitalize">{v}</span>
                </div>
              ))}
              {canDecide(viewItem) && (
                <div className="flex gap-2 pt-2">
                  <Button className="flex-1 bg-emerald-600 hover:bg-emerald-700" onClick={() => handleApprove(viewItem)} disabled={approveMutation.isPending}>
                    <CheckCircle className="w-4 h-4 mr-2" /> Approve
                  </Button>
                  <Button variant="destructive" className="flex-1" onClick={() => { setRejectItem(viewItem); setRejectReason(''); }} disabled={approveMutation.isPending}>
                    <XCircle className="w-4 h-4 mr-2" /> Reject
                  </Button>
                </div>
              )}
              {viewItem.status === 'pending' && viewItem.employeeId === myId && (
                <div className="pt-2">
                  <Button variant="destructive" className="w-full" onClick={() => handleCancel(viewItem)} disabled={cancelMutation.isPending}>
                    <XCircle className="w-4 h-4 mr-2" /> {cancelMutation.isPending ? 'Cancelling…' : 'Cancel My Request'}
                  </Button>
                  <p className="text-xs text-muted-foreground mt-2">Withdraws this request before it is reviewed.</p>
                </div>
              )}
              {perm.canEdit && viewItem.status === 'pending' && viewItem.employeeId === myId && (
                <p className="text-xs text-muted-foreground bg-muted/40 border border-border rounded-lg p-3">
                  This is your own request — another approver must decide it.
                </p>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </AppLayout>
  );
}
