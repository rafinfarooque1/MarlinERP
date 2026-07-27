import { useState, useMemo } from 'react';
import { useListAttendance, useCheckIn, useCheckOut, getListAttendanceQueryKey, useListEmployees, useListWarehouses, useListOutlets } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Search, Clock, Download, LogIn, LogOut, MapPin, Loader2, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';
import { usePermission } from '@/lib/usePermission';

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
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-xs text-primary hover:underline font-mono"
      title={`${lat.toFixed(5)}, ${lng.toFixed(5)}`}
    >
      <MapPin className="w-3 h-3" />
      {label}
    </a>
  );
}

export default function Attendance() {
  const perm = usePermission('Attendance');
  const today = new Date().toISOString().split('T')[0];
  const [date, setDate] = useState(today);
  const [search, setSearch] = useState('');
  const [locLoading, setLocLoading] = useState<number | null>(null);
  const [branchTypeFilter, setBranchTypeFilter] = useState<string>('all');
  const [branchLocId, setBranchLocId] = useState<string>('all');

  const { data: attendance = [], isLoading } = useListAttendance({ date });
  const { data: employees = [] } = useListEmployees();
  const { data: warehouses = [] } = useListWarehouses();
  const { data: outlets = [] } = useListOutlets();
  const queryClient = useQueryClient();
  const checkInMutation = useCheckIn();
  const checkOutMutation = useCheckOut();

  // Build employee-id → branch map for filtering
  const empBranchMap = useMemo(() => {
    const m = new Map<number, { branchType: string; branchId: number }>();
    for (const e of employees as any[]) m.set(e.id, { branchType: e.branchType, branchId: e.branchId });
    return m;
  }, [employees]);

  const handleMark = async (employeeId: number, action: 'checkin' | 'checkout') => {
    setLocLoading(employeeId);
    const loc = await getLocation();
    setLocLoading(null);

    if (!loc) {
      toast.warning('Location unavailable — recording without coordinates');
    }

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

  const filtered = (attendance as any[]).filter(a => {
    const matchSearch = a.employeeName?.toLowerCase().includes(search.toLowerCase());
    const branch = empBranchMap.get(a.employeeId);
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
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Clock className="w-6 h-6 text-primary" /> Attendance
            </h1>
            <p className="text-muted-foreground mt-1">Daily check-in / check-out register with location</p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                downloadCSV(
                  'attendance.csv',
                  filtered.map((a: any) => ({
                    Employee: a.employeeName,
                    Date: a.date,
                    CheckIn: a.checkIn ? new Date(a.checkIn).toLocaleTimeString('en-IN') : '—',
                    CheckInLat: a.checkInLat ?? '—',
                    CheckInLng: a.checkInLng ?? '—',
                    CheckOut: a.checkOut ? new Date(a.checkOut).toLocaleTimeString('en-IN') : '—',
                    CheckOutLat: a.checkOutLat ?? '—',
                    CheckOutLng: a.checkOutLng ?? '—',
                    Hours: a.hoursWorked ? Number(a.hoursWorked).toFixed(1) : '—',
                  })),
                )
              }
            >
              <Download className="w-4 h-4 mr-2" /> Export
            </Button>
            <Input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              className="w-40 bg-card border-border"
            />
          </div>
        </div>

        {/* Branch filter */}
        <div className="flex flex-wrap gap-2 items-center">
          <Select value={branchTypeFilter} onValueChange={v => { setBranchTypeFilter(v); setBranchLocId('all'); }}>
            <SelectTrigger className="h-7 w-38 text-xs"><SelectValue placeholder="All Branches" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Branches</SelectItem>
              <SelectItem value="headoffice">Head Office</SelectItem>
              <SelectItem value="production">Production</SelectItem>
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
          <div className="p-4 border-b border-border flex items-center gap-2 bg-muted/20">
            <Search className="w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search employee..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="border-transparent bg-transparent focus-visible:ring-0 max-w-xs"
            />
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
                  <TableCell>
                    <MapLink lat={a.checkInLat} lng={a.checkInLng} label="Map" />
                  </TableCell>
                  <TableCell className="text-sm font-mono">
                    {a.checkOut ? new Date(a.checkOut).toLocaleTimeString('en-IN') : <span className="text-muted-foreground/50">—</span>}
                  </TableCell>
                  <TableCell>
                    <MapLink lat={a.checkOutLat} lng={a.checkOutLng} label="Map" />
                  </TableCell>
                  <TableCell className="font-mono text-sm">
                    {a.hoursWorked ? `${Number(a.hoursWorked).toFixed(1)}h` : '—'}
                  </TableCell>
                  <TableCell>
                    {a.status === 'present' ? (
                      <Badge className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20">Present</Badge>
                    ) : a.status === 'half_day' ? (
                      <Badge className="bg-amber-500/10 text-amber-600 border-amber-500/20">Half Day</Badge>
                    ) : (
                      <Badge className="bg-red-500/10 text-red-600 border-red-500/20">Absent</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="outline" size="sm" className="h-7 text-xs gap-1"
                        disabled={!!a.checkIn || locLoading === a.employeeId}
                        onClick={() => handleMark(a.employeeId, 'checkin')}
                      >
                        {locLoading === a.employeeId ? <Loader2 className="w-3 h-3 animate-spin" /> : <LogIn className="w-3 h-3" />}
                        In
                      </Button>
                      <Button
                        variant="outline" size="sm" className="h-7 text-xs gap-1"
                        disabled={!a.checkIn || !!a.checkOut || locLoading === a.employeeId}
                        onClick={() => handleMark(a.employeeId, 'checkout')}
                      >
                        {locLoading === a.employeeId ? <Loader2 className="w-3 h-3 animate-spin" /> : <LogOut className="w-3 h-3" />}
                        Out
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </AppLayout>
  );
}
