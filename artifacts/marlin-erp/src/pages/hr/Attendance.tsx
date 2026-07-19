import { useState } from 'react';
import { useListAttendance, useCheckIn, useCheckOut, getListAttendanceQueryKey } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Search, Clock, Download, LogIn, LogOut, MapPin, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';

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
  const today = new Date().toISOString().split('T')[0];
  const [date, setDate] = useState(today);
  const [search, setSearch] = useState('');
  const [locLoading, setLocLoading] = useState<number | null>(null);

  const { data: attendance = [], isLoading } = useListAttendance({ date });
  const queryClient = useQueryClient();
  const checkInMutation = useCheckIn();
  const checkOutMutation = useCheckOut();

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

  const filtered = attendance.filter(a =>
    a.employeeName?.toLowerCase().includes(search.toLowerCase()),
  );

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
                  filtered.map(a => ({
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
                {date === today && <TableHead className="text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                [...Array(4)].map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={8}>
                      <div className="h-8 bg-muted/30 rounded animate-pulse" />
                    </TableCell>
                  </TableRow>
                ))
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-16 text-muted-foreground">
                    <Clock className="w-10 h-10 mx-auto mb-3 opacity-20" />
                    <p>No attendance records for this date</p>
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map(a => (
                  <TableRow key={a.id} className="hover:bg-muted/10">
                    <TableCell className="font-semibold">{a.employeeName}</TableCell>

                    {/* Check-In time */}
                    <TableCell className="font-mono text-sm text-emerald-500">
                      {a.checkIn
                        ? new Date(a.checkIn).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
                        : '—'}
                    </TableCell>

                    {/* Check-In location */}
                    <TableCell>
                      <MapLink
                        lat={a.checkInLat as number | null}
                        lng={a.checkInLng as number | null}
                        label="Map"
                      />
                    </TableCell>

                    {/* Check-Out time */}
                    <TableCell className="font-mono text-sm text-amber-500">
                      {a.checkOut
                        ? new Date(a.checkOut).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
                        : '—'}
                    </TableCell>

                    {/* Check-Out location */}
                    <TableCell>
                      <MapLink
                        lat={a.checkOutLat as number | null}
                        lng={a.checkOutLng as number | null}
                        label="Map"
                      />
                    </TableCell>

                    <TableCell className="font-mono text-sm">
                      {a.hoursWorked ? `${Number(a.hoursWorked).toFixed(1)}h` : '—'}
                    </TableCell>

                    <TableCell>
                      {!a.checkIn ? (
                        <Badge variant="outline" className="text-muted-foreground">Absent</Badge>
                      ) : !a.checkOut ? (
                        <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20">Present</Badge>
                      ) : (
                        <Badge variant="secondary">Left</Badge>
                      )}
                    </TableCell>

                    {date === today && (
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          {locLoading === a.employeeId ? (
                            <Button variant="outline" size="sm" className="h-7 text-xs" disabled>
                              <Loader2 className="w-3 h-3 mr-1 animate-spin" /> Locating…
                            </Button>
                          ) : (
                            <>
                              {!a.checkIn && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 text-xs text-emerald-500 border-emerald-500/30 hover:bg-emerald-500/10"
                                  onClick={() => handleMark(a.employeeId!, 'checkin')}
                                  disabled={checkInMutation.isPending}
                                >
                                  <LogIn className="w-3 h-3 mr-1" /> Check In
                                </Button>
                              )}
                              {a.checkIn && !a.checkOut && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 text-xs text-amber-500 border-amber-500/30 hover:bg-amber-500/10"
                                  onClick={() => handleMark(a.employeeId!, 'checkout')}
                                  disabled={checkOutMutation.isPending}
                                >
                                  <LogOut className="w-3 h-3 mr-1" /> Check Out
                                </Button>
                              )}
                            </>
                          )}
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        {date === today && (
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <MapPin className="w-3 h-3" />
            Check-in and check-out capture the device's GPS location. Allow location access when prompted.
          </p>
        )}
      </div>
    </AppLayout>
  );
}
