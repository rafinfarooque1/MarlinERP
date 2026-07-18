import { useState } from 'react';
import { useListAttendance, useCheckIn, useCheckOut, getListAttendanceQueryKey } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Clock, MapPin, Search } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';

export default function Attendance() {
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [search, setSearch] = useState('');
  
  const { data: attendanceRecords, isLoading } = useListAttendance({ date });
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const checkInMutation = useCheckIn();
  const checkOutMutation = useCheckOut();

  const handleSimulateCheckIn = (employeeId: number) => {
    checkInMutation.mutate({ data: { employeeId, lat: 28.6139, lng: 77.2090 } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListAttendanceQueryKey() });
        toast({ title: 'Checked in successfully' });
      }
    });
  };

  const handleSimulateCheckOut = (employeeId: number) => {
    checkOutMutation.mutate({ data: { employeeId, lat: 28.6139, lng: 77.2090 } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListAttendanceQueryKey() });
        toast({ title: 'Checked out successfully' });
      }
    });
  };

  const filtered = attendanceRecords?.filter(a => a.employeeName?.toLowerCase().includes(search.toLowerCase())) || [];

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Clock className="w-6 h-6 text-primary" /> Daily Attendance
            </h1>
            <p className="text-muted-foreground mt-1">Monitor employee check-ins and locations</p>
          </div>
        </div>

        <div className="bg-card border border-border rounded-md shadow-sm">
          <div className="p-4 border-b border-border flex flex-col sm:flex-row gap-4 items-center">
            <div className="flex items-center gap-2 border border-input rounded-md px-3 bg-muted/50 focus-within:ring-1 focus-within:ring-ring w-full max-w-xs">
              <Search className="w-4 h-4 text-muted-foreground" />
              <Input 
                placeholder="Search employee..." 
                value={search} 
                onChange={e => setSearch(e.target.value)}
                className="border-transparent bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 px-0"
              />
            </div>
            <Input 
              type="date" 
              value={date} 
              onChange={e => setDate(e.target.value)}
              className="max-w-[180px]"
            />
          </div>
          
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Check In</TableHead>
                <TableHead>Check Out</TableHead>
                <TableHead>Location</TableHead>
                <TableHead className="text-right">Simulate Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow>
              ) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">No attendance records for this date</TableCell></TableRow>
              ) : (
                filtered.map(record => (
                  <TableRow key={record.id}>
                    <TableCell className="font-medium">{record.employeeName}</TableCell>
                    <TableCell>
                      <Badge variant={
                        record.status === 'present' ? 'default' : 
                        record.status === 'absent' ? 'destructive' : 
                        record.status === 'leave' ? 'secondary' : 'outline'
                      } className={record.status === 'present' ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' : ''}>
                        {record.status?.replace('_', ' ').toUpperCase()}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-muted-foreground">
                      {record.checkIn ? new Date(record.checkIn).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '-'}
                    </TableCell>
                    <TableCell className="font-mono text-muted-foreground">
                      {record.checkOut ? new Date(record.checkOut).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '-'}
                    </TableCell>
                    <TableCell>
                      {record.checkInLat ? (
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <MapPin className="w-3 h-3 text-primary" /> {record.checkInLat.toFixed(4)}, {record.checkInLng?.toFixed(4)}
                        </span>
                      ) : '-'}
                    </TableCell>
                    <TableCell className="text-right">
                      {!record.checkIn ? (
                        <Button size="sm" variant="outline" onClick={() => handleSimulateCheckIn(record.employeeId)} disabled={checkInMutation.isPending}>
                          Check In
                        </Button>
                      ) : !record.checkOut ? (
                        <Button size="sm" variant="outline" onClick={() => handleSimulateCheckOut(record.employeeId)} disabled={checkOutMutation.isPending}>
                          Check Out
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">Completed</span>
                      )}
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