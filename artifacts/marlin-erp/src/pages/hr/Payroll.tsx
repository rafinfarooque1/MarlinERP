import { useState } from 'react';
import { useListPayroll, useMarkPayrollPaid, getListPayrollQueryKey } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Banknote, CheckCircle2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June', 
  'July', 'August', 'September', 'October', 'November', 'December'
];

export default function Payroll() {
  const currentMonth = new Date().getMonth() + 1;
  const currentYear = new Date().getFullYear();
  
  const [selectedMonth, setSelectedMonth] = useState(currentMonth.toString());
  const [selectedYear, setSelectedYear] = useState(currentYear.toString());
  
  const { data: payrollRecords, isLoading } = useListPayroll({ 
    month: selectedMonth, 
    year: Number(selectedYear) 
  });
  
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const markPaidMutation = useMarkPayrollPaid();

  const handleMarkPaid = (id: number) => {
    markPaidMutation.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListPayrollQueryKey() });
        toast({ title: 'Payroll marked as paid' });
      }
    });
  };

  const totalPayroll = payrollRecords?.reduce((sum, r) => sum + r.totalAmount, 0) || 0;
  const totalPaid = payrollRecords?.filter(r => r.isPaid).reduce((sum, r) => sum + r.totalAmount, 0) || 0;
  const totalPending = totalPayroll - totalPaid;

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Banknote className="w-6 h-6 text-primary" /> Payroll Management
            </h1>
            <p className="text-muted-foreground mt-1">Review and process monthly salaries</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-card border border-border p-4 rounded-md shadow-sm">
            <div className="text-sm font-medium text-muted-foreground">Total Payroll ({MONTHS[Number(selectedMonth)-1]})</div>
            <div className="text-2xl font-bold font-mono mt-1">₹{totalPayroll.toLocaleString('en-IN')}</div>
          </div>
          <div className="bg-card border border-border p-4 rounded-md shadow-sm">
            <div className="text-sm font-medium text-muted-foreground">Processed (Paid)</div>
            <div className="text-2xl font-bold font-mono mt-1 text-emerald-500">₹{totalPaid.toLocaleString('en-IN')}</div>
          </div>
          <div className="bg-card border border-border p-4 rounded-md shadow-sm">
            <div className="text-sm font-medium text-muted-foreground">Pending Disbursal</div>
            <div className="text-2xl font-bold font-mono mt-1 text-primary">₹{totalPending.toLocaleString('en-IN')}</div>
          </div>
        </div>

        <div className="bg-card border border-border rounded-md shadow-sm">
          <div className="p-4 border-b border-border flex flex-col sm:flex-row gap-4 items-center">
            <Select value={selectedMonth} onValueChange={setSelectedMonth}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Select Month" />
              </SelectTrigger>
              <SelectContent>
                {MONTHS.map((m, i) => (
                  <SelectItem key={i+1} value={(i+1).toString()}>{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            
            <Select value={selectedYear} onValueChange={setSelectedYear}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Select Year" />
              </SelectTrigger>
              <SelectContent>
                {[currentYear - 1, currentYear, currentYear + 1].map(y => (
                  <SelectItem key={y} value={y.toString()}>{y}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead className="text-right">Base Salary</TableHead>
                <TableHead className="text-right">Deductions</TableHead>
                <TableHead className="text-right">Net Payable</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow>
              ) : !payrollRecords || payrollRecords.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">No payroll records for this month</TableCell></TableRow>
              ) : (
                payrollRecords.map(record => (
                  <TableRow key={record.id}>
                    <TableCell className="font-medium">{record.employeeName}</TableCell>
                    <TableCell className="text-muted-foreground">{record.branchName}</TableCell>
                    <TableCell className="text-right font-mono">₹{record.baseSalary.toLocaleString('en-IN')}</TableCell>
                    <TableCell className="text-right font-mono text-destructive">
                      {record.deductions ? `-₹${record.deductions.toLocaleString('en-IN')}` : '-'}
                    </TableCell>
                    <TableCell className="text-right font-mono font-bold text-primary">₹{record.totalAmount.toLocaleString('en-IN')}</TableCell>
                    <TableCell>
                      {record.isPaid ? (
                        <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20 hover:bg-emerald-500/20">PAID</Badge>
                      ) : (
                        <Badge variant="outline" className="text-muted-foreground border-border">PENDING</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {!record.isPaid && (
                        <Button 
                          size="sm" 
                          variant="outline" 
                          className="border-primary text-primary hover:bg-primary/10"
                          onClick={() => handleMarkPaid(record.id)}
                          disabled={markPaidMutation.isPending}
                        >
                          <CheckCircle2 className="w-4 h-4 mr-2" /> Mark Paid
                        </Button>
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