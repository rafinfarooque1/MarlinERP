import { useState, useMemo } from 'react';
import {
  useListAttendance, useCheckIn, useCheckOut, getListAttendanceQueryKey,
  useListEmployees, useListWarehouses, useListOutlets,
  useListLeaves, useApplyLeave, useApproveLeave, getListLeavesQueryKey,
  useGetMe,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Search, Clock, Download, LogIn, LogOut, MapPin, Loader2, ShieldOff, CalendarDays, Plus, Eye, CheckCircle, XCircle } from 'lucide-react';
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
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
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

  const today = new Date().toISOString().split('T')[0];
  const [date, setDate] = useState(today);
  const [search, setSearch] = useState('');
  const [locLoading, setLocLoading] = useState<number | null>(null);
  const [branchTypeFilter, setBranchTypeFilter] = useState<string>('all');
  const [branchLocId, setBranchLocId] = useState<string>('all');
  useClearOutletSelection(branchTypeFilter === 'outlet', () => { setBranchTypeFilter('all'); setBranchLocId('all'); });
  const [applyLeaveOpen, setApplyLeaveOpen] = useState(false);
  const [viewLeave, setViewLeave] = useState<any>(null);

  const { data: attendance = [], isLoading } = useListAttendance({ date });
  const { data: employees = [] } = useListEmployees();
  const { data: warehouses = [] } = useListWarehouses();
  const { data: outlets = [] } = useListOutlets();
  const { outletsEnabled } = useOutletsEnabled();
  const queryClient = useQueryClient();
  const checkInMutation  = useCheckIn();
  const checkOutMutation = useCheckOut();
  const applyMutation    = useApplyLeave();
  const approveMutation  = useApproveLeave();

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

  // Admin: filtered employee list
  const filtered = (attendance as any[]).filter(a => {
    const matchSearch = a.employeeName?.toLowerCase().includes(search.toLowerCase());
    const branch = empBranchMap.get(a.employeeId);
    const matchBranchType = branchTypeFilter === 'all' || branch?.branchType === branchTypeFilter;
    const matchBranchLoc = branchLocId === 'all' || String(branch?.branchId) === branchLocId;
    return matchSearch && matchBranchType && matchBranchLoc;
  });

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
            <div className="flex gap-2">
              {perm.canDownload && (
              <Button variant="outline" size="sm" onClick={() =>
                downloadCSV('attendance.csv', filtered.map((a: any) => ({
                  Employee: a.employeeName, Date: a.date,
                  CheckIn: a.checkIn ? new Date(a.checkIn).toLocaleTimeString('en-IN') : '—',
                  CheckInLat: a.checkInLat ?? '—', CheckInLng: a.checkInLng ?? '—',
                  CheckOut: a.checkOut ? new Date(a.checkOut).toLocaleTimeString('en-IN') : '—',
                  CheckOutLat: a.checkOutLat ?? '—', CheckOutLng: a.checkOutLng ?? '—',
                  Hours: a.hoursWorked ? Number(a.hoursWorked).toFixed(1) : '—',
                })))}>
                <Download className="w-4 h-4 mr-2" /> Export
              </Button>
              )}
              <Input type="date" value={date} onChange={e => setDate(e.target.value)} className="w-40 bg-card border-border" />
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

          {/* Table */}
          <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
            <div className="p-4 border-b border-border flex items-center gap-2 bg-muted/20">
              <Search className="w-4 h-4 text-muted-foreground" />
              <Input placeholder="Search employee..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0 max-w-xs" />
            </div>
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/10">
                  <TableHead>Employee</TableHead>
                  <TableHead>Check-In</TableHead>
                  <TableHead>Check-In Location</TableHead>
                  <TableHead>Check-Out</TableHead>
                  <TableHead>Check-Out Location</TableHead>
                  <TableHead>Hours</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  [...Array(4)].map((_, i) => (
                    <TableRow key={i}><TableCell colSpan={8}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
                  ))
                ) : filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-16 text-muted-foreground">
                      <Clock className="w-10 h-10 mx-auto mb-3 opacity-20" />
                      <p>No attendance records for {date}</p>
                    </TableCell>
                  </TableRow>
                ) : filtered.map((a: any) => (
                  <TableRow key={a.employeeId} className="hover:bg-muted/10">
                    <TableCell className="font-semibold">{a.employeeName}</TableCell>
                    <TableCell className="text-sm font-mono">
                      {a.checkIn ? new Date(a.checkIn).toLocaleTimeString('en-IN') : <span className="text-muted-foreground/50">—</span>}
                    </TableCell>
                    <TableCell><MapLink lat={a.checkInLat} lng={a.checkInLng} label="Map" /></TableCell>
                    <TableCell className="text-sm font-mono">
                      {a.checkOut ? new Date(a.checkOut).toLocaleTimeString('en-IN') : <span className="text-muted-foreground/50">—</span>}
                    </TableCell>
                    <TableCell><MapLink lat={a.checkOutLat} lng={a.checkOutLng} label="Map" /></TableCell>
                    <TableCell className="font-mono text-sm">{a.hoursWorked ? `${Number(a.hoursWorked).toFixed(1)}h` : '—'}</TableCell>
                    <TableCell><StatusBadge status={a.status} /></TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        {perm.canAdd && (
                        <Button variant="outline" size="sm" className="h-7 text-xs gap-1"
                          disabled={!!a.checkIn || locLoading === a.employeeId || a.status === 'leave'}
                          onClick={() => handleMark(a.employeeId, 'checkin')}>
                          {locLoading === a.employeeId ? <Loader2 className="w-3 h-3 animate-spin" /> : <LogIn className="w-3 h-3" />} In
                        </Button>
                        )}
                        {perm.canAdd && (
                        <Button variant="outline" size="sm" className="h-7 text-xs gap-1"
                          disabled={!a.checkIn || !!a.checkOut || locLoading === a.employeeId}
                          onClick={() => handleMark(a.employeeId, 'checkout')}>
                          {locLoading === a.employeeId ? <Loader2 className="w-3 h-3 animate-spin" /> : <LogOut className="w-3 h-3" />} Out
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
        {applyLeaveDialog}
        {leaveSheet}
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
          <div className="flex gap-2">
            {perm.canAdd && (
            <Button onClick={() => { leaveForm.reset(); setApplyLeaveOpen(true); }}>
              <Plus className="w-4 h-4 mr-2" /> Apply Leave
            </Button>
            )}
            <Input type="date" value={date} onChange={e => setDate(e.target.value)} className="w-40 bg-card border-border" />
          </div>
        </div>

        {/* Today's attendance card */}
        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border bg-muted/20 flex items-center gap-2">
            <Clock className="w-4 h-4 text-muted-foreground" />
            <span className="font-medium text-sm">Attendance for {new Date(date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</span>
          </div>
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Check-In</TableHead>
                <TableHead>Check-In Location</TableHead>
                <TableHead>Check-Out</TableHead>
                <TableHead>Check-Out Location</TableHead>
                <TableHead>Hours</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={7}><div className="h-10 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              ) : !myRow ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-10 text-muted-foreground">
                    <Clock className="w-8 h-8 mx-auto mb-2 opacity-20" />
                    <p className="text-sm">No record for this date</p>
                  </TableCell>
                </TableRow>
              ) : (
                <TableRow className="hover:bg-muted/10">
                  <TableCell className="text-sm font-mono">
                    {myRow.checkIn ? new Date(myRow.checkIn).toLocaleTimeString('en-IN') : <span className="text-muted-foreground/50">—</span>}
                  </TableCell>
                  <TableCell><MapLink lat={myRow.checkInLat} lng={myRow.checkInLng} label="Map" /></TableCell>
                  <TableCell className="text-sm font-mono">
                    {myRow.checkOut ? new Date(myRow.checkOut).toLocaleTimeString('en-IN') : <span className="text-muted-foreground/50">—</span>}
                  </TableCell>
                  <TableCell><MapLink lat={myRow.checkOutLat} lng={myRow.checkOutLng} label="Map" /></TableCell>
                  <TableCell className="font-mono text-sm">{myRow.hoursWorked ? `${Number(myRow.hoursWorked).toFixed(1)}h` : '—'}</TableCell>
                  <TableCell><StatusBadge status={myRow.status} /></TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {perm.canAdd && (
                      <Button variant="outline" size="sm" className="h-7 text-xs gap-1"
                        disabled={!!myRow.checkIn || locLoading === myRow.employeeId || myRow.status === 'leave'}
                        onClick={() => myId && handleMark(myId, 'checkin')}>
                        {locLoading === myRow.employeeId ? <Loader2 className="w-3 h-3 animate-spin" /> : <LogIn className="w-3 h-3" />} Check In
                      </Button>
                      )}
                      {perm.canAdd && (
                      <Button variant="outline" size="sm" className="h-7 text-xs gap-1"
                        disabled={!myRow.checkIn || !!myRow.checkOut || locLoading === myRow.employeeId}
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
