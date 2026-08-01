import { useState, useMemo, useEffect } from 'react';
import {
  useListAttendance, useCheckIn, useCheckOut, getListAttendanceQueryKey,
  useListEmployees, useListWarehouses, useListOutlets,
  useListLeaves, useApplyLeave, useApproveLeave, getListLeavesQueryKey,
  useGetMe, useCorrectAttendance, useAttendanceRange,
  useAttendanceMonth, useAttendanceConfig, type AttendancePunch,
} from '@workspace/api-client-react';
import { useDateRange, RangeBar } from '@/pages/reports/shared';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Search, Clock, Download, LogIn, LogOut, MapPin, Loader2, ShieldOff, CalendarDays, Plus, Eye, CheckCircle, XCircle, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';
import { usePermission } from '@/lib/usePermission';
import { useOutletsEnabled, useClearOutletSelection } from '@/lib/useFeatureFlags';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getLocation(): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(null); return; }
    // getCurrentPosition's own `timeout` only starts once permission is
    // granted; a permission prompt left unanswered calls NEITHER callback, so
    // without this hard deadline the check-in button stays stuck on its
    // spinner forever.
    const deadline = setTimeout(() => resolve(null), 10_000);
    navigator.geolocation.getCurrentPosition(
      (pos) => { clearTimeout(deadline); resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }); },
      () => { clearTimeout(deadline); resolve(null); },
      { timeout: 8000, maximumAge: 0 },
    );
  });
}

function MapLink({ lat, lng, label }: { lat: number | null; lng: number | null; label: string }) {
  if (!lat || !lng) return <span className="text-muted-foreground/40 text-xs">—</span>;
  const url = `https://www.google.com/maps?q=${lat},${lng}`;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-xs text-primary hover:underline font-mono"
      title={`${lat.toFixed(5)}, ${lng.toFixed(5)}`}>
      <MapPin className="w-3 h-3" />{label}
    </a>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'present')   return <Badge className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20">Present</Badge>;
  if (status === 'half_day')  return <Badge className="bg-amber-500/10 text-amber-600 border-amber-500/20">Half Day</Badge>;
  if (status === 'leave')     return <Badge className="bg-blue-500/10 text-blue-600 border-blue-500/20">On Leave</Badge>;
  return <Badge className="bg-red-500/10 text-red-600 border-red-500/20">Absent</Badge>;
}

function leaveStatusColor(s: string) {
  if (s === 'approved') return 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20';
  if (s === 'rejected') return 'bg-red-500/10 text-red-500 border-red-500/20';
  return 'bg-amber-500/10 text-amber-500 border-amber-500/20';
}

const fmtTime = (ts: string | null | undefined) =>
  ts ? new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }) : '—';

/** The day's punch sessions, one per line. Open session shows a live "now". */
function SessionsCell({ punches }: { punches?: AttendancePunch[] }) {
  if (!punches?.length) return <span className="text-muted-foreground/40 text-xs">—</span>;
  return (
    <div className="flex flex-col gap-0.5">
      {punches.map((p) => (
        <span key={p.id} className="text-xs font-mono whitespace-nowrap">
          {fmtTime(p.punchIn)} → {p.punchOut ? fmtTime(p.punchOut) : <span className="text-emerald-600 font-semibold">now</span>}
        </span>
      ))}
    </div>
  );
}

/** Live working duration while a session is open — closed hours + the running session. */
function LiveDuration({ openPunchIn, closedHours }: { openPunchIn: string; closedHours: number }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const hrs = closedHours + Math.max(0, (Date.now() - new Date(openPunchIn).getTime()) / 3_600_000);
  const h = Math.floor(hrs);
  const m = Math.floor((hrs - h) * 60);
  return (
    <span className="font-mono text-sm text-emerald-600 font-semibold" title="Currently checked in">
      {h}h {String(m).padStart(2, '0')}m
      <span className="ml-1 inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse align-middle" />
    </span>
  );
}

/** Hours cell: live figure while checked in, otherwise the settled workingHours. */
function HoursCell({ row }: { row: any }) {
  if (row.openPunchIn) {
    const closed = (row.punches ?? []).reduce((s: number, p: any) =>
      p.punchOut ? s + (new Date(p.punchOut).getTime() - new Date(p.punchIn).getTime()) / 3_600_000 : s, 0);
    return <LiveDuration openPunchIn={row.openPunchIn} closedHours={closed} />;
  }
  return <span className="font-mono text-sm">{row.hoursWorked != null ? `${Number(row.hoursWorked).toFixed(1)}h` : '—'}</span>;
}

function LateBadge({ minutes }: { minutes: number | null | undefined }) {
  if (minutes == null) return <span className="text-muted-foreground/40 text-xs">—</span>;
  if (minutes <= 0) return <span className="text-xs text-emerald-600">On time</span>;
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return (
    <span className="text-xs text-amber-600 font-medium">
      {h > 0 ? `${h}h ${m}m` : `${m}m`} late
    </span>
  );
}

// ─── Leave form schema ────────────────────────────────────────────────────────

const leaveSchema = z.object({
  fromDate: z.string().min(1, 'From date required'),
  toDate:   z.string().min(1, 'To date required'),
  leaveType: z.enum(['sick', 'casual', 'annual', 'other']),
  reason: z.string().optional(),
});
type LeaveFormValues = z.infer<typeof leaveSchema>;

// ─── Main component ───────────────────────────────────────────────────────────

export default function Attendance() {
  const perm = usePermission('page:/hr/attendance');
  const { data: user } = useGetMe();
  const isAdmin = (user as any)?.branchType === 'headoffice';

  // "Today" is the COMPANY's operational day (IST by default), not the
  // browser's calendar: it gates the In/Out buttons, and the server files
  // punches under the company day, so any other clock disagrees with it
  // around midnight.
  const { data: attCfg } = useAttendanceConfig();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: attCfg?.timeZone ?? 'Asia/Kolkata' });
  const [date, setDate] = useState(today);
  // 'day' = the operational check-in/out register; 'range' = a read-only
  // period view over the same records (corrections/check-ins stay in day mode,
  // they act on ONE date); 'calendar' = a month-at-a-glance company view.
  const [viewMode, setViewMode] = useState<'day' | 'range' | 'calendar'>('day');
  const now = new Date();
  const [calYear, setCalYear] = useState(now.getFullYear());
  const [calMonth, setCalMonth] = useState(now.getMonth() + 1); // 1-based
  const range = useDateRange('month');
  const [search, setSearch] = useState('');
  const [locLoading, setLocLoading] = useState<number | null>(null);
  const [branchTypeFilter, setBranchTypeFilter] = useState<string>('all');
  const [branchLocId, setBranchLocId] = useState<string>('all');
  useClearOutletSelection(branchTypeFilter === 'outlet', () => { setBranchTypeFilter('all'); setBranchLocId('all'); });
  const [applyLeaveOpen, setApplyLeaveOpen] = useState(false);
  const [viewLeave, setViewLeave] = useState<any>(null);
  // The row being corrected, plus the status being set on it.
  const [correcting, setCorrecting] = useState<any>(null);
  const [correctStatus, setCorrectStatus] = useState<string>('present');

  const { data: attendance = [], isLoading } = useListAttendance({ date });
  // Range rows: the server scopes non-HO callers to their own records, so this
  // is safe for both views. Disabled until a bounded range is chosen (the hook
  // skips the fetch when both bounds are empty, e.g. the "All time" preset).
  const { data: rangeRows = [], isLoading: rangeLoading } = useAttendanceRange(
    viewMode === 'range' ? { from: range.from || undefined, to: range.to || undefined } : {},
  );
  const { data: monthRows = [], isLoading: calLoading } = useAttendanceMonth(
    calYear, calMonth, { enabled: viewMode === 'calendar' },
  );
  const { data: employees = [] } = useListEmployees();
  const { data: warehouses = [] } = useListWarehouses();
  const { data: outlets = [] } = useListOutlets();
  const { outletsEnabled } = useOutletsEnabled();
  const queryClient = useQueryClient();
  const checkInMutation  = useCheckIn();
  const checkOutMutation = useCheckOut();
  const applyMutation    = useApplyLeave();
  const approveMutation  = useApproveLeave();
  const correctMutation  = useCorrectAttendance();

  // Employee view: own leave history
  const myId = (user as any)?.id as number | undefined;
  const { data: myLeaves = [], isLoading: leavesLoading } = useListLeaves(
    myId ? { employeeId: myId } : undefined,
    { query: { enabled: !isAdmin && !!myId } } as any,
  );

  // Build employee-id → branch map (admin view filter)
  const empBranchMap = useMemo(() => {
    const m = new Map<number, { branchType: string; branchId: number }>();
    for (const e of employees as any[]) m.set(e.id, { branchType: e.branchType, branchId: e.branchId });
    return m;
  }, [employees]);

  // Leave form
  const leaveForm = useForm<LeaveFormValues>({
    resolver: zodResolver(leaveSchema),
    defaultValues: { fromDate: '', toDate: '', leaveType: 'casual', reason: '' },
  });

  const handleMark = async (employeeId: number, action: 'checkin' | 'checkout') => {
    setLocLoading(employeeId);
    const loc = await getLocation();
    setLocLoading(null);
    if (!loc) toast.warning('Location unavailable — recording without coordinates');

    const mutation = action === 'checkin' ? checkInMutation : checkOutMutation;
    mutation.mutate(
      { data: { employeeId, timestamp: new Date().toISOString(), lat: loc?.lat ?? 0, lng: loc?.lng ?? 0 } as any },
      {
        onSuccess: () => {
          toast.success(
            action === 'checkin'
              ? loc ? `Checked in ✓  (${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)})` : 'Checked in (no location)'
              : loc ? `Checked out ✓  (${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)})` : 'Checked out (no location)',
          );
          queryClient.invalidateQueries({ queryKey: getListAttendanceQueryKey() });
        },
        onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
      },
    );
  };

  const onApplyLeave = (data: LeaveFormValues) => {
    if (!myId) return;
    applyMutation.mutate(
      { data: { ...data, employeeId: myId } as any },
      {
        onSuccess: () => {
          toast.success('Leave application submitted');
          queryClient.invalidateQueries({ queryKey: getListLeavesQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListAttendanceQueryKey() });
          setApplyLeaveOpen(false);
          leaveForm.reset();
        },
        onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
      },
    );
  };

  const handleApproveLeave = (id: number, approved: boolean) => {
    approveMutation.mutate(
      { id, data: { approved, remarks: approved ? 'Approved' : 'Rejected' } as any },
      {
        onSuccess: () => {
          toast.success(approved ? 'Leave approved' : 'Leave rejected');
          queryClient.invalidateQueries({ queryKey: getListLeavesQueryKey() });
          setViewLeave(null);
        },
        onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
      },
    );
  };

  const openCorrection = (row: any) => {
    setCorrecting(row);
    setCorrectStatus(row.status ?? 'present');
  };

  const submitCorrection = () => {
    if (!correcting) return;
    // Times are cleared explicitly so the chosen status alone decides what the
    // day earns — the server's contract is that recorded hours (including punch
    // sessions) outvote the status label unless they are cleared with it.
    correctMutation.mutate(
      { employeeId: correcting.employeeId, date, status: correctStatus as any, checkIn: null, checkOut: null },
      {
        onSuccess: () => {
          toast.success(`Attendance corrected — salary for ${date} has been re-calculated`);
          setCorrecting(null);
        },
        // The server refuses a signed-off month with the reason in the message,
        // so show it rather than a generic failure.
        onError: (e: any) => toast.error(e?.data?.error || e.message || 'Correction failed'),
      },
    );
  };

  // Admin: filtered employee list
  const filtered = (attendance as any[]).filter(a => {
    const matchSearch = a.employeeName?.toLowerCase().includes(search.toLowerCase());
    const branch = empBranchMap.get(a.employeeId);
    const matchBranchType = branchTypeFilter === 'all' || branch?.branchType === branchTypeFilter;
    const matchBranchLoc = branchLocId === 'all' || String(branch?.branchId) === branchLocId;
    return matchSearch && matchBranchType && matchBranchLoc;
  });

  // Range rows carry only employeeId — resolve names from the employee master.
  const empNameMap = useMemo(() => {
    const m = new Map<number, string>();
    for (const e of employees as any[]) m.set(e.id, e.name);
    return m;
  }, [employees]);

  // Day-register summary cards, over the same filtered rows the table shows.
  const daySummary = useMemo(() => {
    const s = { present: 0, half_day: 0, leave: 0, absent: 0, late: 0, otHours: 0, checkedIn: 0 };
    for (const a of filtered as any[]) {
      if (a.status === 'present') s.present++;
      else if (a.status === 'half_day') s.half_day++;
      else if (a.status === 'leave') s.leave++;
      else s.absent++;
      if ((a.lateMinutes ?? 0) > 0) s.late++;
      if (a.overtimeHours) s.otHours += Number(a.overtimeHours);
      if (a.openPunchIn) s.checkedIn++;
    }
    return s;
  }, [filtered]);

  // Calendar: per-day status counts for the month; absent = active employees
  // with no row that day (same synthesis rule as the day register).
  const calDays = useMemo(() => {
    const byDate = new Map<string, { present: number; half_day: number; leave: number; recorded: number }>();
    for (const r of monthRows as any[]) {
      const d = String(r.date).slice(0, 10);
      const c = byDate.get(d) ?? { present: 0, half_day: 0, leave: 0, recorded: 0 };
      c.recorded++;
      if (r.status === 'present') c.present++;
      else if (r.status === 'half_day') c.half_day++;
      else if (r.status === 'leave') c.leave++;
      byDate.set(d, c);
    }
    return byDate;
  }, [monthRows]);
  const activeEmployeeCount = (employees as any[]).filter((e) => e.isActive !== false).length;

  // Same search/branch filters, applied to the period view; newest day first.
  const filteredRange = (rangeRows as any[])
    .filter(a => {
      const name = empNameMap.get(a.employeeId) ?? '';
      const matchSearch = name.toLowerCase().includes(search.toLowerCase());
      const branch = empBranchMap.get(a.employeeId);
      const matchBranchType = branchTypeFilter === 'all' || branch?.branchType === branchTypeFilter;
      const matchBranchLoc = branchLocId === 'all' || String(branch?.branchId) === branchLocId;
      return matchSearch && matchBranchType && matchBranchLoc;
    })
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || (empNameMap.get(a.employeeId) ?? '').localeCompare(empNameMap.get(b.employeeId) ?? ''));
  const rangeUnbounded = !range.from && !range.to;

  // ── Access denied ───────────────────────────────────────────────────────────
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

  // ── Apply Leave dialog (shared by both views) ───────────────────────────────
  const applyLeaveDialog = (
    <Dialog open={applyLeaveOpen} onOpenChange={setApplyLeaveOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Apply for Leave</DialogTitle></DialogHeader>
        <Form {...leaveForm}>
          <form onSubmit={leaveForm.handleSubmit(onApplyLeave)} className="space-y-4 pt-2">
            <FormField control={leaveForm.control} name="leaveType" render={({ field }) => (
              <FormItem><FormLabel>Leave Type</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                  <SelectContent>
                    <SelectItem value="sick">Sick Leave</SelectItem>
                    <SelectItem value="casual">Casual Leave</SelectItem>
                    <SelectItem value="annual">Annual Leave</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </FormItem>
            )} />
            <div className="grid grid-cols-2 gap-4">
              <FormField control={leaveForm.control} name="fromDate" render={({ field }) => (
                <FormItem><FormLabel>From <span className="text-destructive">*</span></FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={leaveForm.control} name="toDate" render={({ field }) => (
                <FormItem><FormLabel>To <span className="text-destructive">*</span></FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
            </div>
            <FormField control={leaveForm.control} name="reason" render={({ field }) => (
              <FormItem><FormLabel>Reason</FormLabel><FormControl><Textarea placeholder="Reason for leave..." rows={3} {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <DialogFooter>
              <Button variant="outline" type="button" onClick={() => setApplyLeaveOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={applyMutation.isPending}>{applyMutation.isPending ? 'Submitting…' : 'Submit'}</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );

  // ── Attendance correction ───────────────────────────────────────────────────
  // Salary is earned per attended day, so this dialog edits money as much as it
  // edits a status. It says so, rather than looking like a harmless status flip.
  const correctionDialog = (
    <Dialog open={!!correcting} onOpenChange={v => !v && setCorrecting(null)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Correct Attendance</DialogTitle></DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-muted-foreground text-xs">Employee</p>
              <p className="font-semibold">{correcting?.employeeName}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">Date</p>
              <p className="font-semibold font-mono">{date}</p>
            </div>
          </div>
          <div>
            <p className="text-sm font-medium mb-1.5">Status</p>
            <Select value={correctStatus} onValueChange={setCorrectStatus}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="present">Present — earns a full day</SelectItem>
                <SelectItem value="half_day">Half Day — earns half a day</SelectItem>
                <SelectItem value="leave">On Leave — earns a full day</SelectItem>
                <SelectItem value="absent">Absent — earns nothing</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground bg-muted/40 border border-border rounded-lg p-3">
            Saving replaces the day's recorded check-in/out sessions with this status and
            re-calculates this employee's salary for the month straight away.
            A month whose payroll is already approved or paid cannot be changed here —
            post a journal adjustment instead.
          </p>
          <DialogFooter>
            <Button variant="outline" type="button" onClick={() => setCorrecting(null)}>Cancel</Button>
            <Button type="button" onClick={submitCorrection} disabled={correctMutation.isPending}>
              {correctMutation.isPending ? 'Saving…' : 'Save Correction'}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );

  // ── Leave detail sheet ──────────────────────────────────────────────────────
  const leaveSheet = (
    <Sheet open={!!viewLeave} onOpenChange={v => !v && setViewLeave(null)}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{viewLeave?.employeeName}</SheetTitle>
          <SheetDescription className="capitalize">{viewLeave?.leaveType} Leave</SheetDescription>
        </SheetHeader>
        {viewLeave && (
          <div className="mt-6 space-y-4">
            {[
              ['From', new Date(viewLeave.fromDate).toLocaleDateString('en-IN')],
              ['To',   new Date(viewLeave.toDate).toLocaleDateString('en-IN')],
              ['Status', viewLeave.status || 'pending'],
              ['Reason', viewLeave.reason || '—'],
              ['Approval Note', viewLeave.approvalNote || '—'],
            ].map(([k, v]) => (
              <div key={k} className="flex flex-col gap-1 border-b border-border pb-3">
                <span className="text-xs text-muted-foreground uppercase tracking-wider">{k}</span>
                <span className="font-medium">{v}</span>
              </div>
            ))}
            {isAdmin && perm.canEdit && (viewLeave.status === 'pending' || !viewLeave.status) && (
              <div className="flex gap-2 pt-2">
                <Button className="flex-1 bg-emerald-600 hover:bg-emerald-700" onClick={() => handleApproveLeave(viewLeave.id, true)} disabled={approveMutation.isPending}>
                  <CheckCircle className="w-4 h-4 mr-2" /> Approve
                </Button>
                <Button variant="destructive" className="flex-1" onClick={() => handleApproveLeave(viewLeave.id, false)} disabled={approveMutation.isPending}>
                  <XCircle className="w-4 h-4 mr-2" /> Reject
                </Button>
              </div>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // ADMIN VIEW — all employees, branch filter, check-in/out
  // ═══════════════════════════════════════════════════════════════════════════
  if (isAdmin) {
    return (
      <AppLayout>
        <div className="space-y-6">
          {/* Header */}
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
            <div>
              <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
                <Clock className="w-6 h-6 text-primary" /> Attendance
              </h1>
              <p className="text-muted-foreground mt-1">Daily check-in / check-out register with location</p>
            </div>
            <div className="flex gap-2 items-center">
              {perm.canDownload && (
              <Button variant="outline" size="sm" onClick={() =>
                viewMode === 'day'
                  ? downloadCSV('attendance.csv', filtered.map((a: any) => ({
                      Employee: a.employeeName, Date: a.date,
                      Sessions: (a.punches ?? []).map((p: any) =>
                        `${p.punchIn ? new Date(p.punchIn).toLocaleTimeString('en-IN') : ''}-${p.punchOut ? new Date(p.punchOut).toLocaleTimeString('en-IN') : 'open'}`).join(' | ') || '—',
                      FirstIn: a.checkIn ? new Date(a.checkIn).toLocaleTimeString('en-IN') : '—',
                      CheckInLat: a.checkInLat ?? '—', CheckInLng: a.checkInLng ?? '—',
                      LastOut: a.checkOut ? new Date(a.checkOut).toLocaleTimeString('en-IN') : '—',
                      CheckOutLat: a.checkOutLat ?? '—', CheckOutLng: a.checkOutLng ?? '—',
                      Hours: a.hoursWorked != null ? Number(a.hoursWorked).toFixed(2) : '—',
                      LateMinutes: a.lateMinutes ?? '—',
                      OvertimeHours: a.overtimeHours ?? '—',
                      Status: a.status,
                    })))
                  : downloadCSV(`attendance_${range.from || 'start'}_${range.to || 'today'}.csv`, filteredRange.map((a: any) => ({
                      Date: a.date, Employee: empNameMap.get(a.employeeId) ?? a.employeeId,
                      CheckIn: a.checkIn ? new Date(a.checkIn).toLocaleTimeString('en-IN') : '—',
                      CheckOut: a.checkOut ? new Date(a.checkOut).toLocaleTimeString('en-IN') : '—',
                      Hours: a.hoursWorked ? Number(a.hoursWorked).toFixed(1) : '—',
                      Status: a.status,
                    })))}>
                <Download className="w-4 h-4 mr-2" /> Export
              </Button>
              )}
              <div className="flex rounded-md border border-border overflow-hidden">
                <Button variant={viewMode === 'day' ? 'secondary' : 'ghost'} size="sm" className="h-9 rounded-none text-xs px-3"
                  onClick={() => setViewMode('day')}>Day</Button>
                <Button variant={viewMode === 'calendar' ? 'secondary' : 'ghost'} size="sm" className="h-9 rounded-none text-xs px-3"
                  onClick={() => setViewMode('calendar')}>Calendar</Button>
                <Button variant={viewMode === 'range' ? 'secondary' : 'ghost'} size="sm" className="h-9 rounded-none text-xs px-3"
                  onClick={() => setViewMode('range')}>Range</Button>
              </div>
              {viewMode === 'day' && (
                <Input type="date" value={date} onChange={e => setDate(e.target.value)} className="w-40 bg-card border-border" />
              )}
            </div>
          </div>

          {viewMode === 'range' && <RangeBar range={range} />}

          {/* Day summary cards */}
          {viewMode === 'day' && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              {[
                { label: 'Present', value: daySummary.present, cls: 'text-emerald-600' },
                { label: 'Half Day', value: daySummary.half_day, cls: 'text-amber-600' },
                { label: 'On Leave', value: daySummary.leave, cls: 'text-blue-600' },
                { label: 'Absent', value: daySummary.absent, cls: 'text-red-600' },
                { label: 'Late Arrivals', value: daySummary.late, cls: 'text-amber-600' },
                { label: 'Overtime', value: `${daySummary.otHours.toFixed(1)}h`, cls: 'text-primary' },
              ].map((c) => (
                <div key={c.label} className="bg-card border border-border rounded-xl px-4 py-3">
                  <p className="text-xs text-muted-foreground">{c.label}</p>
                  <p className={`text-xl font-bold mt-0.5 ${c.cls}`}>{c.value}</p>
                </div>
              ))}
            </div>
          )}

          {/* Branch filter */}
          <div className="flex flex-wrap gap-2 items-center">
            <Select value={branchTypeFilter} onValueChange={v => { setBranchTypeFilter(v); setBranchLocId('all'); }}>
              <SelectTrigger className="h-7 w-38 text-xs"><SelectValue placeholder="All Branches" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Branches</SelectItem>
                <SelectItem value="headoffice">Head Office</SelectItem>
                <SelectItem value="warehouse">Warehouse</SelectItem>
                {outletsEnabled && <SelectItem value="outlet">Outlet</SelectItem>}
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

          {/* Calendar — month at a glance; click a day to open its register */}
          {viewMode === 'calendar' && (
            <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
              <div className="p-4 border-b border-border bg-muted/20 flex items-center justify-between">
                <Button variant="ghost" size="sm" onClick={() => {
                  if (calMonth === 1) { setCalMonth(12); setCalYear(y => y - 1); } else setCalMonth(m => m - 1);
                }}>←</Button>
                <span className="font-semibold">
                  {new Date(calYear, calMonth - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}
                </span>
                <Button variant="ghost" size="sm" onClick={() => {
                  if (calMonth === 12) { setCalMonth(1); setCalYear(y => y + 1); } else setCalMonth(m => m + 1);
                }}>→</Button>
              </div>
              {calLoading ? (
                <div className="p-8 text-center text-muted-foreground text-sm">Loading…</div>
              ) : (
                <div className="p-3">
                  <div className="grid grid-cols-7 mb-1">
                    {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => (
                      <div key={d} className="text-center text-xs text-muted-foreground font-medium py-1">{d}</div>
                    ))}
                  </div>
                  <div className="grid grid-cols-7 gap-1">
                    {(() => {
                      const firstDow = new Date(calYear, calMonth - 1, 1).getDay();
                      const daysInMonth = new Date(calYear, calMonth, 0).getDate();
                      const cells: Array<number | null> = [
                        ...Array(firstDow).fill(null),
                        ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
                      ];
                      while (cells.length % 7 !== 0) cells.push(null);
                      return cells.map((d, i) => {
                        if (!d) return <div key={i} className="min-h-20" />;
                        const ds = `${calYear}-${String(calMonth).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                        const c = calDays.get(ds);
                        const absent = c ? Math.max(0, activeEmployeeCount - c.recorded) + (c.recorded - c.present - c.half_day - c.leave) : null;
                        const isFuture = ds > today;
                        return (
                          <button key={i} type="button"
                            onClick={() => { setDate(ds); setViewMode('day'); }}
                            className={`min-h-20 rounded-lg border text-left p-1.5 transition-colors hover:border-primary/50 hover:bg-muted/30
                              ${ds === today ? 'border-primary/60 bg-primary/5' : 'border-border/60'}
                              ${ds === date ? 'ring-1 ring-primary' : ''}`}>
                            <span className={`text-xs font-semibold ${ds === today ? 'text-primary' : ''}`}>{d}</span>
                            {!isFuture && c && (
                              <div className="mt-1 space-y-0.5">
                                {c.present > 0 && <div className="text-[10px] leading-tight text-emerald-600 font-medium">{c.present} present</div>}
                                {c.half_day > 0 && <div className="text-[10px] leading-tight text-amber-600 font-medium">{c.half_day} half</div>}
                                {c.leave > 0 && <div className="text-[10px] leading-tight text-blue-600 font-medium">{c.leave} leave</div>}
                                {absent != null && absent > 0 && <div className="text-[10px] leading-tight text-red-500/80">{absent} absent</div>}
                              </div>
                            )}
                            {!isFuture && !c && (
                              <div className="mt-1 text-[10px] leading-tight text-muted-foreground/50">no records</div>
                            )}
                          </button>
                        );
                      });
                    })()}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Range view — read-only period register (check-in/out and Fix act
              on ONE date, so they live in the Day view only) */}
          {viewMode === 'calendar' ? null : viewMode === 'range' ? (
          <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
            <div className="p-4 border-b border-border flex items-center gap-2 bg-muted/20">
              <Search className="w-4 h-4 text-muted-foreground" />
              <Input placeholder="Search employee..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0 max-w-xs" />
            </div>
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/10">
                  <TableHead>Date</TableHead>
                  <TableHead>Employee</TableHead>
                  <TableHead>Check-In</TableHead>
                  <TableHead>Check-Out</TableHead>
                  <TableHead>Hours</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rangeUnbounded ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-16 text-muted-foreground">
                      <CalendarDays className="w-10 h-10 mx-auto mb-3 opacity-20" />
                      <p>Pick a bounded period — "All time" is not available for the attendance register</p>
                    </TableCell>
                  </TableRow>
                ) : rangeLoading ? (
                  [...Array(4)].map((_, i) => (
                    <TableRow key={i}><TableCell colSpan={6}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
                  ))
                ) : filteredRange.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-16 text-muted-foreground">
                      <Clock className="w-10 h-10 mx-auto mb-3 opacity-20" />
                      <p>No attendance records in this period</p>
                    </TableCell>
                  </TableRow>
                ) : filteredRange.map((a: any) => (
                  <TableRow key={`${a.date}:${a.employeeId}`} className="hover:bg-muted/10">
                    <TableCell className="text-sm font-mono">{a.date}</TableCell>
                    <TableCell className="font-semibold">{empNameMap.get(a.employeeId) ?? `#${a.employeeId}`}</TableCell>
                    <TableCell className="text-sm font-mono">
                      {a.checkIn ? new Date(a.checkIn).toLocaleTimeString('en-IN') : <span className="text-muted-foreground/50">—</span>}
                    </TableCell>
                    <TableCell className="text-sm font-mono">
                      {a.checkOut ? new Date(a.checkOut).toLocaleTimeString('en-IN') : <span className="text-muted-foreground/50">—</span>}
                    </TableCell>
                    <TableCell className="font-mono text-sm">{a.hoursWorked ? `${Number(a.hoursWorked).toFixed(1)}h` : '—'}</TableCell>
                    <TableCell><StatusBadge status={a.status} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          ) : (
          <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
            <div className="p-4 border-b border-border flex items-center gap-2 bg-muted/20">
              <Search className="w-4 h-4 text-muted-foreground" />
              <Input placeholder="Search employee..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0 max-w-xs" />
            </div>
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/10">
                  <TableHead>Employee</TableHead>
                  <TableHead>Sessions</TableHead>
                  <TableHead>First In</TableHead>
                  <TableHead>Last Out</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Hours</TableHead>
                  <TableHead>Late</TableHead>
                  <TableHead>OT</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  [...Array(4)].map((_, i) => (
                    <TableRow key={i}><TableCell colSpan={10}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
                  ))
                ) : filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center py-16 text-muted-foreground">
                      <Clock className="w-10 h-10 mx-auto mb-3 opacity-20" />
                      <p>No attendance records for {date}</p>
                    </TableCell>
                  </TableRow>
                ) : filtered.map((a: any) => (
                  <TableRow key={a.employeeId} className="hover:bg-muted/10">
                    <TableCell className="font-semibold">{a.employeeName}</TableCell>
                    <TableCell><SessionsCell punches={a.punches} /></TableCell>
                    <TableCell className="text-sm font-mono">
                      {a.checkIn ? fmtTime(a.checkIn) : <span className="text-muted-foreground/50">—</span>}
                    </TableCell>
                    <TableCell className="text-sm font-mono">
                      {a.openPunchIn
                        ? <span className="text-emerald-600 text-xs font-semibold">working…</span>
                        : a.checkOut ? fmtTime(a.checkOut) : <span className="text-muted-foreground/50">—</span>}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <MapLink lat={a.checkInLat} lng={a.checkInLng} label="In" />
                        <MapLink lat={a.checkOutLat} lng={a.checkOutLng} label="Out" />
                      </div>
                    </TableCell>
                    <TableCell><HoursCell row={a} /></TableCell>
                    <TableCell><LateBadge minutes={a.checkIn ? a.lateMinutes : null} /></TableCell>
                    <TableCell className="font-mono text-sm">
                      {a.overtimeHours ? <span className="text-primary font-semibold">+{Number(a.overtimeHours).toFixed(1)}h</span> : <span className="text-muted-foreground/40 text-xs">—</span>}
                    </TableCell>
                    <TableCell><StatusBadge status={a.status} /></TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        {perm.canAdd && (
                        <Button variant="outline" size="sm" className="h-7 text-xs gap-1"
                          disabled={!!a.openPunchIn || locLoading === a.employeeId || a.status === 'leave' || date !== today}
                          onClick={() => handleMark(a.employeeId, 'checkin')}>
                          {locLoading === a.employeeId ? <Loader2 className="w-3 h-3 animate-spin" /> : <LogIn className="w-3 h-3" />} In
                        </Button>
                        )}
                        {perm.canAdd && (
                        <Button variant="outline" size="sm" className="h-7 text-xs gap-1"
                          disabled={(!a.openPunchIn && !(a.checkIn && !a.checkOut)) || locLoading === a.employeeId || date !== today}
                          onClick={() => handleMark(a.employeeId, 'checkout')}>
                          {locLoading === a.employeeId ? <Loader2 className="w-3 h-3 animate-spin" /> : <LogOut className="w-3 h-3" />} Out
                        </Button>
                        )}
                        {/* Attendance decides what the day earns, so a wrong row
                            is a wrong figure in the books. Head Office only. */}
                        {isAdmin && perm.canEdit && (
                        <Button variant="ghost" size="sm" className="h-7 text-xs gap-1"
                          onClick={() => openCorrection(a)} title="Correct this day's attendance">
                          <Pencil className="w-3 h-3" /> Fix
                        </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          )}
        </div>
        {applyLeaveDialog}
        {leaveSheet}
        {correctionDialog}
      </AppLayout>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EMPLOYEE VIEW — own attendance only + leave management
  // ═══════════════════════════════════════════════════════════════════════════
  const myRow = (attendance as any[])[0]; // backend returns only this employee's row

  return (
    <AppLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Clock className="w-6 h-6 text-primary" /> My Attendance
            </h1>
            <p className="text-muted-foreground mt-1">Your daily attendance and leave records</p>
          </div>
          <div className="flex gap-2 items-center">
            {perm.canAdd && (
            <Button onClick={() => { leaveForm.reset(); setApplyLeaveOpen(true); }}>
              <Plus className="w-4 h-4 mr-2" /> Apply Leave
            </Button>
            )}
            <div className="flex rounded-md border border-border overflow-hidden">
              <Button variant={viewMode === 'day' ? 'secondary' : 'ghost'} size="sm" className="h-9 rounded-none text-xs px-3"
                onClick={() => setViewMode('day')}>Day</Button>
              <Button variant={viewMode === 'range' ? 'secondary' : 'ghost'} size="sm" className="h-9 rounded-none text-xs px-3"
                onClick={() => setViewMode('range')}>Range</Button>
            </div>
            {viewMode === 'day' && (
              <Input type="date" value={date} onChange={e => setDate(e.target.value)} className="w-40 bg-card border-border" />
            )}
          </div>
        </div>

        {viewMode === 'range' && <RangeBar range={range} />}

        {/* Period view — the server already limits range rows to this employee */}
        {viewMode === 'range' ? (
        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border bg-muted/20 flex items-center gap-2">
            <CalendarDays className="w-4 h-4 text-muted-foreground" />
            <span className="font-medium text-sm">My Attendance — selected period</span>
          </div>
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Date</TableHead>
                <TableHead>Check-In</TableHead>
                <TableHead>Check-Out</TableHead>
                <TableHead>Hours</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rangeUnbounded ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-12 text-muted-foreground">
                    <CalendarDays className="w-8 h-8 mx-auto mb-2 opacity-20" />
                    <p className="text-sm">Pick a bounded period to see your records</p>
                  </TableCell>
                </TableRow>
              ) : rangeLoading ? (
                [...Array(3)].map((_, i) => (
                  <TableRow key={i}><TableCell colSpan={5}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
                ))
              ) : (rangeRows as any[]).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-12 text-muted-foreground">
                    <Clock className="w-8 h-8 mx-auto mb-2 opacity-20" />
                    <p className="text-sm">No records in this period</p>
                  </TableCell>
                </TableRow>
              ) : (rangeRows as any[])
                  .slice()
                  .sort((a, b) => String(b.date).localeCompare(String(a.date)))
                  .map((a: any) => (
                <TableRow key={`${a.date}:${a.employeeId}`} className="hover:bg-muted/10">
                  <TableCell className="text-sm font-mono">{a.date}</TableCell>
                  <TableCell className="text-sm font-mono">
                    {a.checkIn ? new Date(a.checkIn).toLocaleTimeString('en-IN') : <span className="text-muted-foreground/50">—</span>}
                  </TableCell>
                  <TableCell className="text-sm font-mono">
                    {a.checkOut ? new Date(a.checkOut).toLocaleTimeString('en-IN') : <span className="text-muted-foreground/50">—</span>}
                  </TableCell>
                  <TableCell className="font-mono text-sm">{a.hoursWorked ? `${Number(a.hoursWorked).toFixed(1)}h` : '—'}</TableCell>
                  <TableCell><StatusBadge status={a.status} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        ) : (
        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border bg-muted/20 flex items-center gap-2">
            <Clock className="w-4 h-4 text-muted-foreground" />
            <span className="font-medium text-sm">Attendance for {new Date(date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</span>
          </div>
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Sessions</TableHead>
                <TableHead>First In</TableHead>
                <TableHead>Last Out</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Hours</TableHead>
                <TableHead>Late</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={8}><div className="h-10 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              ) : !myRow ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-6 text-muted-foreground">
                    <Clock className="w-8 h-8 mx-auto mb-2 opacity-20" />
                    <p className="text-sm">No record for this date</p>
                  </TableCell>
                  <TableCell className="text-right align-middle">
                    {perm.canAdd && date === today && (
                    <Button variant="outline" size="sm" className="h-7 text-xs gap-1"
                      disabled={locLoading != null}
                      onClick={() => myId && handleMark(myId, 'checkin')}>
                      {locLoading != null ? <Loader2 className="w-3 h-3 animate-spin" /> : <LogIn className="w-3 h-3" />} Check In
                    </Button>
                    )}
                  </TableCell>
                </TableRow>
              ) : (
                <TableRow className="hover:bg-muted/10">
                  <TableCell><SessionsCell punches={myRow.punches} /></TableCell>
                  <TableCell className="text-sm font-mono">
                    {myRow.checkIn ? fmtTime(myRow.checkIn) : <span className="text-muted-foreground/50">—</span>}
                  </TableCell>
                  <TableCell className="text-sm font-mono">
                    {myRow.openPunchIn
                      ? <span className="text-emerald-600 text-xs font-semibold">working…</span>
                      : myRow.checkOut ? fmtTime(myRow.checkOut) : <span className="text-muted-foreground/50">—</span>}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-2">
                      <MapLink lat={myRow.checkInLat} lng={myRow.checkInLng} label="In" />
                      <MapLink lat={myRow.checkOutLat} lng={myRow.checkOutLng} label="Out" />
                    </div>
                  </TableCell>
                  <TableCell><HoursCell row={myRow} /></TableCell>
                  <TableCell><LateBadge minutes={myRow.checkIn ? myRow.lateMinutes : null} /></TableCell>
                  <TableCell><StatusBadge status={myRow.status} /></TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {perm.canAdd && (
                      <Button variant="outline" size="sm" className="h-7 text-xs gap-1"
                        disabled={!!myRow.openPunchIn || locLoading === myRow.employeeId || myRow.status === 'leave' || date !== today}
                        onClick={() => myId && handleMark(myId, 'checkin')}>
                        {locLoading === myRow.employeeId ? <Loader2 className="w-3 h-3 animate-spin" /> : <LogIn className="w-3 h-3" />} Check In
                      </Button>
                      )}
                      {perm.canAdd && (
                      <Button variant="outline" size="sm" className="h-7 text-xs gap-1"
                        disabled={(!myRow.openPunchIn && !(myRow.checkIn && !myRow.checkOut)) || locLoading === myRow.employeeId || date !== today}
                        onClick={() => myId && handleMark(myId, 'checkout')}>
                        {locLoading === myRow.employeeId ? <Loader2 className="w-3 h-3 animate-spin" /> : <LogOut className="w-3 h-3" />} Check Out
                      </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        )}

        {/* Leave history */}
        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border bg-muted/20 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CalendarDays className="w-4 h-4 text-muted-foreground" />
              <span className="font-medium text-sm">My Leave History</span>
            </div>
          </div>
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Type</TableHead>
                <TableHead>From</TableHead>
                <TableHead>To</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {leavesLoading ? (
                [...Array(2)].map((_, i) => (
                  <TableRow key={i}><TableCell colSpan={6}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
                ))
              ) : (myLeaves as any[]).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-12 text-muted-foreground">
                    <CalendarDays className="w-8 h-8 mx-auto mb-2 opacity-20" />
                    <p className="text-sm">No leave applications yet</p>
                  </TableCell>
                </TableRow>
              ) : (myLeaves as any[]).map(l => (
                <TableRow key={l.id} className="hover:bg-muted/10">
                  <TableCell><Badge variant="outline" className="capitalize text-xs">{l.leaveType}</Badge></TableCell>
                  <TableCell className="text-sm">{new Date(l.fromDate + 'T00:00:00').toLocaleDateString('en-IN')}</TableCell>
                  <TableCell className="text-sm">{new Date(l.toDate + 'T00:00:00').toLocaleDateString('en-IN')}</TableCell>
                  <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">{l.reason || '—'}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={leaveStatusColor(l.status || 'pending')}>
                      {l.status || 'pending'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewLeave(l)}>
                      <Eye className="w-4 h-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {applyLeaveDialog}
      {leaveSheet}
    </AppLayout>
  );
}
