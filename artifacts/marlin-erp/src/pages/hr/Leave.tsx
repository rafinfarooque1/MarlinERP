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
import { useOutletsEnabled, useClearOutletSelection } from '@/lib/useFeatureFlags';

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

const statusColor = (s: string) =>
  s === 'approved' ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20'
  : s === 'rejected' ? 'bg-red-500/10 text-red-500 border-red-500/20'
  : s === 'cancelled' ? 'bg-muted text-muted-foreground border-border'
  : 'bg-amber-500/10 text-amber-500 border-amber-500/20';

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

function SummaryCard({ icon: Icon, label, value, tone }: {
  icon: any; label: string; value: number; tone: string;
}) {
  return (
    <div className="bg-card border border-border rounded-xl p-4 shadow-sm flex items-center gap-3">
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${tone}`}>
        <Icon className="w-5 h-5" />
      </div>
      <div className="min-w-0">
        <p className="text-2xl font-bold leading-tight">{value}</p>
        <p className="text-xs text-muted-foreground truncate">{label}</p>
      </div>
    </div>
  );
}

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
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <CalendarOff className="w-6 h-6 text-primary" /> Leave Approvals
              {perm.canEdit && cards.pending > 0 && (
                <Badge className="bg-amber-500/15 text-amber-600 border-amber-500/30 ml-1">
                  {cards.pending} pending
                </Badge>
              )}
            </h1>
            <p className="text-muted-foreground mt-1">Review, approve and track employee leave requests</p>
          </div>
          <div className="flex gap-2">
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
          </div>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <SummaryCard icon={Hourglass}     label="Pending requests" value={cards.pending}       tone="bg-amber-500/10 text-amber-600" />
          <SummaryCard icon={CalendarCheck} label="Approved today"   value={cards.approvedToday} tone="bg-emerald-500/10 text-emerald-600" />
          <SummaryCard icon={CalendarX}     label="Rejected today"   value={cards.rejectedToday} tone="bg-red-500/10 text-red-600" />
          <SummaryCard icon={Plane}         label="On leave today"   value={cards.onLeaveToday}  tone="bg-blue-500/10 text-blue-600" />
          <SummaryCard icon={CalendarClock} label="Upcoming leaves"  value={cards.upcoming}      tone="bg-violet-500/10 text-violet-600" />
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-2 items-center">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
            </SelectContent>
          </Select>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="h-8 w-32 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="sick">Sick</SelectItem>
              <SelectItem value="casual">Casual</SelectItem>
              <SelectItem value="annual">Annual</SelectItem>
              <SelectItem value="other">Other</SelectItem>
            </SelectContent>
          </Select>
          <Select value={employeeFilter} onValueChange={setEmployeeFilter}>
            <SelectTrigger className="h-8 w-44 text-xs"><SelectValue placeholder="All Employees" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Employees</SelectItem>
              {(employees as any[]).map(e => <SelectItem key={e.id} value={String(e.id)}>{e.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={branchTypeFilter} onValueChange={v => { setBranchTypeFilter(v); setBranchLocId('all'); }}>
            <SelectTrigger className="h-8 w-36 text-xs"><SelectValue placeholder="All Branches" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Branches</SelectItem>
              <SelectItem value="headoffice">Head Office</SelectItem>
              <SelectItem value="warehouse">Warehouse</SelectItem>
              {outletsEnabled && <SelectItem value="outlet">Outlet</SelectItem>}
            </SelectContent>
          </Select>
          {branchTypeFilter === 'warehouse' && (
            <Select value={branchLocId} onValueChange={setBranchLocId}>
              <SelectTrigger className="h-8 w-44 text-xs"><SelectValue placeholder="All Warehouses" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Warehouses</SelectItem>
                {(warehouses as any[]).map(w => <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
          {branchTypeFilter === 'outlet' && (
            <Select value={branchLocId} onValueChange={setBranchLocId}>
              <SelectTrigger className="h-8 w-44 text-xs"><SelectValue placeholder="All Outlets" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Outlets</SelectItem>
                {(outlets as any[]).map(o => <SelectItem key={o.id} value={String(o.id)}>{o.name}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
          <div className="flex items-center gap-1.5">
            <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="h-8 w-36 text-xs" title="From date" />
            <span className="text-xs text-muted-foreground">→</span>
            <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="h-8 w-36 text-xs" title="To date" />
            {(fromDate || toDate) && (
              <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={() => { setFromDate(''); setToDate(''); }}>Clear</Button>
            )}
          </div>
        </div>

        {/* Table */}
        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex flex-wrap gap-3 bg-muted/20">
            <div className="flex items-center gap-2 flex-1 min-w-[200px]">
              <Search className="w-4 h-4 text-muted-foreground" />
              <Input placeholder="Search employee name or ID..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0" />
            </div>
          </div>
          <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Employee</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>From</TableHead>
                <TableHead>To</TableHead>
                <TableHead>Days</TableHead>
                <TableHead>Applied On</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Approver</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(3)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={11}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={11} className="text-center py-16 text-muted-foreground">
                  <CalendarOff className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No leave requests match these filters</p>
                </TableCell></TableRow>
              ) : filtered.map(l => (
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
                  <TableCell className="font-mono font-bold text-primary">{leaveDays(l)}</TableCell>
                  <TableCell className="text-sm whitespace-nowrap">{fmtDate(l.createdAt)}</TableCell>
                  <TableCell><Badge variant="outline" className={`capitalize ${statusColor(l.status || 'pending')}`}>{l.status || 'pending'}</Badge></TableCell>
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
