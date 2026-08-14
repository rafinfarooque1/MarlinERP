import { useState, useMemo } from 'react';
import {
  useListEnrichedPayroll, getEnrichedPayrollQueryKey,
  useEditPayroll, useApprovePayroll, usePayPayroll,
  useListAdvances, useAddAdvance,
  useListEmployees, useListWarehouses, useListOutlets,
  useListSalaryAccruals, getSalaryAccrualsQueryKey,
  useUnclassifiedAbsences, getUnclassifiedAbsencesQueryKey,
  useCorrectAttendance,
  useCashBankLedgersFlat,
  EnrichedPayrollRecord,
  UnclassifiedAbsences,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { DialogClose, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { TransactionDialog, TransactionDialogContent } from '@/components/ui/transaction-dialog';
import { Separator } from '@/components/ui/separator';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DollarSign, Download, Eye, CheckCircle, RefreshCw, FileDown, AlertTriangle,
  ShieldOff, Pencil, PlusCircle, ChevronDown, ChevronUp, Wallet, Search, Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV, downloadPDFFromEndpoint } from '@/lib/download';
import { usePermission } from '@/lib/usePermission';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { useOutletsEnabled, useClearOutletSelection } from '@/lib/useFeatureFlags';
import { useGetMe } from '@workspace/api-client-react';
import { PageHeader } from '@/components/app/page-header';
import { SummaryCard, SummaryCardGrid } from '@/components/app/summary-card';
import { StatusBadge } from '@/components/app/status-badge';
import { EmptyState } from '@/components/app/empty-state';
import { TableSkeleton } from '@/components/app/loading-skeletons';
import { inr } from '@/lib/currency';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/**
 * Salary slip, rendered by the server from the stored payroll row.
 *
 * Deliberately not built in the browser: the slip is a statutory document, and
 * the stored row is what the books and the statutory returns were computed from.
 * Printing from the row also means a slip reprinted after a rate change still
 * shows the rates that were actually applied.
 */
async function downloadPayslip(p: { id: number; employeeName?: string; month?: number; year?: number }) {
  const name = (p.employeeName || 'payslip').replace(/[^A-Za-z0-9._-]+/g, '-');
  try {
    await downloadPDFFromEndpoint(
      '/api/pdf/payslip',
      { payrollId: p.id },
      `payslip-${name}-${MONTHS[(p.month ?? 1) - 1]}-${p.year ?? ''}.pdf`,
    );
  } catch (e: any) {
    toast.error(e?.message ?? 'Could not generate the payslip');
  }
}

function statusBadge(status: string, paidAmt: number, netPay: number) {
  if (status === 'paid') return <StatusBadge status="paid" />;
  if (status === 'approved' && paidAmt > 0 && paidAmt < netPay - 0.005)
    return <StatusBadge status="partial" />;
  if (status === 'approved') return <StatusBadge status="approved" />;
  return <StatusBadge status="draft" />;
}

const fmt = inr;

// ── Edit Extra Amount dialog ───────────────────────────────────────────────
function EditDialog({ item, onClose }: { item: EnrichedPayrollRecord; onClose: () => void }) {
  const [amount, setAmount] = useState(String(item.extraAmount ?? 0));
  const [note, setNote]     = useState(item.extraNote ?? '');
  const qc = useQueryClient();
  const now = new Date();
  const mutation = useEditPayroll();

  const save = () => {
    mutation.mutate({ id: item.id, extraAmount: Number(amount), extraNote: note }, {
      onSuccess: () => {
        toast.success('Payroll updated');
        qc.invalidateQueries({ queryKey: getEnrichedPayrollQueryKey({ year: item.year, month: item.month }) });
        onClose();
      },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  return (
    <TransactionDialog open dirty={amount !== String(item.extraAmount ?? 0) || note !== (item.extraNote ?? '')} onOpenChange={onClose}>
      <TransactionDialogContent>
        <DialogHeader>
          <DialogTitle>Edit Payroll — {item.employeeName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1">
            <Label>Additional Amount (₹)</Label>
            <Input type="number" min={0} value={amount} onChange={e => setAmount(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Note</Label>
            <Textarea value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Performance bonus, Arrears…" rows={2} />
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
          <Button onClick={save} disabled={mutation.isPending}>Save</Button>
        </DialogFooter>
      </TransactionDialogContent>
    </TransactionDialog>
  );
}

// ── Pay dialog ─────────────────────────────────────────────────────────────
function PayDialog({ item, onClose }: { item: EnrichedPayrollRecord; onClose: () => void }) {
  const totalNet  = (item.netPay ?? 0) + (item.extraAmount ?? 0);
  const remaining = Math.max(0, totalNet - (item.paidAmount ?? 0));
  const [amount, setAmount] = useState(String(remaining.toFixed(2)));
  const [mode, setMode]     = useState<string>('cash');
  // Which till or bank account the salary leaves from. 'auto' keeps the
  // standard Head Office Cash/Bank (by mode); branch users see only their own till.
  const [payFrom, setPayFrom] = useState<string>('auto');
  const { data: cashBank = [] } = useCashBankLedgersFlat();
  const qc = useQueryClient();
  const mutation = usePayPayroll();

  const pay = () => {
    mutation.mutate({
      id: item.id, amount: Number(amount), paymentMode: mode,
      payLedgerId: payFrom !== 'auto' ? Number(payFrom) : undefined,
    }, {
      onSuccess: (res) => {
        toast.success(res.status === 'paid' ? 'Salary paid' : 'Partial payment recorded');
        qc.invalidateQueries({ queryKey: getEnrichedPayrollQueryKey({ year: item.year, month: item.month }) });
        onClose();
      },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  return (
    <TransactionDialog open dirty={amount !== String(remaining.toFixed(2)) || mode !== 'cash' || payFrom !== 'auto'} onOpenChange={onClose}>
      <TransactionDialogContent>
        <DialogHeader>
          <DialogTitle>Pay Salary — {item.employeeName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Net Pay</span>
            <span className="font-medium">{fmt(totalNet)}</span>
          </div>
          {(item.paidAmount ?? 0) > 0 && (
            <div className="flex justify-between text-emerald-600">
              <span>Already Paid</span>
              <span>{fmt(item.paidAmount ?? 0)}</span>
            </div>
          )}
          <div className="flex justify-between font-semibold">
            <span>Remaining</span>
            <span>{fmt(remaining)}</span>
          </div>
          <Separator />
          <div className="space-y-1">
            <Label>Amount to Pay (₹)</Label>
            <Input type="number" min={0} max={remaining} value={amount} onChange={e => setAmount(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Payment Mode</Label>
            <Select value={mode} onValueChange={setMode}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="cash">Cash</SelectItem>
                <SelectItem value="bank">Bank Transfer</SelectItem>
                <SelectItem value="upi">UPI</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Paid From Account</Label>
            <Select value={payFrom} onValueChange={setPayFrom}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Default — Head Office {mode === 'bank' ? 'Bank' : 'Cash'}</SelectItem>
                {(cashBank as any[]).map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Pick a warehouse or outlet cash box to pay from that till.</p>
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
          <Button onClick={pay} disabled={mutation.isPending || Number(amount) <= 0}>Pay</Button>
        </DialogFooter>
      </TransactionDialogContent>
    </TransactionDialog>
  );
}

// ── Payslip detail sheet ───────────────────────────────────────────────────
function PayslipSheet({
  item, accrued, onClose, isAdmin, onApprove, onPay, canDownload,
}: {
  item: EnrichedPayrollRecord;
  /** Already charged to the P&L by daily accrual for this employee-month. */
  accrued: number;
  onClose: () => void;
  isAdmin: boolean;
  onApprove: () => void;
  onPay: () => void;
  canDownload: boolean;
}) {
  const totalNet = (item.netPay ?? 0) + (item.extraAmount ?? 0);
  const handleDownload = () => downloadPayslip(item);
  const pfEmployer = Number((item as any).pfEmployer ?? 0);
  const esiEmployer = Number((item as any).esiEmployer ?? 0);
  const employerCost = (item.grossPay ?? 0) + (item.extraAmount ?? 0) + pfEmployer + esiEmployer;

  return (
    <Sheet open onOpenChange={onClose}>
      <SheetContent className="sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Avatar className="h-8 w-8"><AvatarFallback>{(item.employeeName || '?').charAt(0)}</AvatarFallback></Avatar>
            {item.employeeName}
            <span className="ml-1">{statusBadge(item.status, item.paidAmount ?? 0, totalNet)}</span>
          </SheetTitle>
          <SheetDescription>{MONTHS[(item.month ?? 1) - 1]} {item.year} — {item.branchName || '—'}</SheetDescription>
        </SheetHeader>

        {/* Daily accrual — why the expense is already in the books */}
        {accrued > 0.004 && (
          <div className="mt-4 rounded-lg border bg-muted/40 p-3 text-xs space-y-1">
            <div className="flex justify-between font-medium text-sm">
              <span>Already accrued daily</span><span>{fmt(accrued)}</span>
            </div>
            <p className="text-muted-foreground">
              {item.status === 'draft'
                ? `This much salary is already an expense in the P&L, booked day by day as it was earned. Approving posts only the ${fmt(Math.abs((item.grossPay ?? 0) + (item.extraAmount ?? 0) - accrued))} difference${((item.grossPay ?? 0) + (item.extraAmount ?? 0)) < accrued ? ' back out' : ''} — not the salary again.`
                : 'Booked day by day as it was earned; approval posted only the difference up to the figure above.'}
            </p>
          </div>
        )}

        {/* Action buttons (admin) */}
        {isAdmin && (
          <div className="flex gap-2 flex-wrap mt-4">
            {item.status === 'draft' && (
              <Button size="sm" onClick={onApprove}><CheckCircle className="h-3 w-3 mr-1" />Approve</Button>
            )}
            {item.status === 'approved' && (
              <Button size="sm" onClick={onPay}><DollarSign className="h-3 w-3 mr-1" />Pay Salary</Button>
            )}
            {item.status === 'approved' && (item.paidAmount ?? 0) > 0 && (item.paidAmount ?? 0) < totalNet - 0.005 && (
              <Button size="sm" onClick={onPay}><Wallet className="h-3 w-3 mr-1" />Pay Remaining</Button>
            )}
            {canDownload && <Button size="sm" variant="outline" onClick={handleDownload}><FileDown className="h-3 w-3 mr-1" />PDF</Button>}
          </div>
        )}
        {!isAdmin && canDownload && (
          <Button size="sm" variant="outline" className="mt-4" onClick={handleDownload}><FileDown className="h-3 w-3 mr-1" />Download Payslip</Button>
        )}

        <Separator className="my-4" />

        {/* Attendance. Runs generated since the leave policy exists carry a
            paid-casual-leave snapshot; stored present days are the days PAID
            for (worked + paid leave), so Present shows worked days and the
            leave tile shows used/allowed. Older runs have no snapshot (null,
            not zero) and keep the original three tiles. */}
        {item.paidLeaveAllowed != null ? (
          /* Runs generated since the casual/sick split also carry a sick-leave
             snapshot (null on older runs — omitted, never shown as zero). */
          <div className={`grid ${item.sickLeaveAllowed != null ? 'grid-cols-2 sm:grid-cols-5' : 'grid-cols-4'} gap-3 text-sm mb-4`}>
            <div className="rounded-lg bg-muted/50 p-3 text-center">
              <p className="text-xs text-muted-foreground">Working Days</p>
              <p className="font-semibold text-base">{item.workingDays}</p>
            </div>
            <div className="rounded-lg bg-muted/50 p-3 text-center">
              <p className="text-xs text-muted-foreground">Present</p>
              <p className="font-semibold text-base">{(Number(item.presentDays ?? 0) - Number(item.paidLeaveUsed ?? 0) - Number(item.sickLeaveUsed ?? 0)).toFixed(1)}</p>
            </div>
            <div className="rounded-lg bg-muted/50 p-3 text-center">
              <p className="text-xs text-muted-foreground">Casual Leave</p>
              <p className="font-semibold text-base text-emerald-700">{Number(item.paidLeaveUsed ?? 0).toFixed(1)}<span className="text-xs text-muted-foreground font-normal"> / {Number(item.paidLeaveAllowed).toFixed(1)}</span></p>
            </div>
            {item.sickLeaveAllowed != null && (
              <div className="rounded-lg bg-muted/50 p-3 text-center">
                <p className="text-xs text-muted-foreground">Sick Leave</p>
                <p className="font-semibold text-base text-purple-700">{Number(item.sickLeaveUsed ?? 0).toFixed(1)}<span className="text-xs text-muted-foreground font-normal"> / {Number(item.sickLeaveAllowed).toFixed(1)}</span></p>
              </div>
            )}
            <div className="rounded-lg bg-muted/50 p-3 text-center">
              <p className="text-xs text-muted-foreground">LOP Days</p>
              <p className="font-semibold text-base text-red-600">{Number(item.lopDays ?? 0).toFixed(1)}</p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-3 text-sm mb-4">
            <div className="rounded-lg bg-muted/50 p-3 text-center">
              <p className="text-xs text-muted-foreground">Working Days</p>
              <p className="font-semibold text-base">{item.workingDays}</p>
            </div>
            <div className="rounded-lg bg-muted/50 p-3 text-center">
              <p className="text-xs text-muted-foreground">Present</p>
              <p className="font-semibold text-base">{Number(item.presentDays ?? 0).toFixed(1)}</p>
            </div>
            <div className="rounded-lg bg-muted/50 p-3 text-center">
              <p className="text-xs text-muted-foreground">LOP Days</p>
              <p className="font-semibold text-base text-red-600">{Number(item.lopDays ?? 0).toFixed(1)}</p>
            </div>
          </div>
        )}

        {/* Earnings */}
        <div className="space-y-1 mb-4">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Earnings</p>
          <div className="rounded-lg border divide-y text-sm">
            <div className="flex justify-between px-3 py-2"><span>Basic Salary</span><span>{fmt(item.baseSalary)}</span></div>
            {(item.lopDeduction ?? 0) > 0 && (
              <div className="flex justify-between px-3 py-2 text-red-600">
                <span>LOP Deduction ({Number(item.lopDays).toFixed(1)} days)</span>
                <span>−{fmt(item.lopDeduction)}</span>
              </div>
            )}
            {(item.allowancesBreakdown ?? []).map((a: any) => (
              <div key={a.name} className="flex justify-between px-3 py-2"><span>{a.name}</span><span>{fmt(a.amount)}</span></div>
            ))}
            {(item.extraAmount ?? 0) > 0 && (
              <div className="flex justify-between px-3 py-2 text-emerald-700">
                <span>{item.extraNote || 'Additional Amount'}</span>
                <span>{fmt(item.extraAmount)}</span>
              </div>
            )}
            <div className="flex justify-between px-3 py-2 font-semibold bg-muted/30">
              <span>Gross Pay</span><span>{fmt((item.grossPay ?? 0) + (item.extraAmount ?? 0))}</span>
            </div>
          </div>
        </div>

        {/* Deductions */}
        {((item.deductionsBreakdown ?? []).length > 0 || (item.advanceDeduction ?? 0) > 0) && (
          <div className="space-y-1 mb-4">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Deductions</p>
            <div className="rounded-lg border divide-y text-sm">
              {(item.deductionsBreakdown ?? []).map((d: any) => (
                <div key={d.name} className="flex justify-between px-3 py-2"><span>{d.name}</span><span>{fmt(d.amount)}</span></div>
              ))}
              {(item.advanceDeduction ?? 0) > 0 && (
                <div className="flex justify-between px-3 py-2 text-amber-700">
                  <span>Advance Recovery</span><span>{fmt(item.advanceDeduction)}</span>
                </div>
              )}
              <div className="flex justify-between px-3 py-2 font-semibold bg-muted/30">
                <span>Total Deductions</span><span>{fmt((item.deductions ?? 0) + (item.advanceDeduction ?? 0))}</span>
              </div>
            </div>
          </div>
        )}

        {/* Net Pay */}
        <div className="rounded-lg bg-teal-600 text-white px-4 py-3 flex justify-between items-center">
          <span className="font-semibold">Net Pay</span>
          <span className="text-xl font-bold">{fmt(totalNet)}</span>
        </div>

        {/* Employer statutory share — a real company cost that never appears in
            the employee's deductions, so it needs its own block or it looks as
            though salary is the whole cost of employing someone. */}
        {(pfEmployer > 0 || esiEmployer > 0) && (
          <div className="space-y-1 mt-4">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Employer Contribution — not deducted from the employee
            </p>
            <div className="rounded-lg border divide-y text-sm">
              {pfEmployer > 0 && (
                <div className="flex justify-between px-3 py-2"><span>PF — employer share</span><span>{fmt(pfEmployer)}</span></div>
              )}
              {esiEmployer > 0 && (
                <div className="flex justify-between px-3 py-2"><span>ESI — employer share</span><span>{fmt(esiEmployer)}</span></div>
              )}
              <div className="flex justify-between px-3 py-2 font-semibold bg-muted/30">
                <span>Cost to Company</span><span>{fmt(employerCost)}</span>
              </div>
            </div>
          </div>
        )}
        {(item.paidAmount ?? 0) > 0 && (
          <div className="text-xs text-muted-foreground mt-1 flex justify-between px-1">
            <span>Paid: {fmt(item.paidAmount ?? 0)} via {item.paymentMode ?? '—'}</span>
            {(item.paidAmount ?? 0) < totalNet - 0.005 && <span className="text-amber-600">Balance: {fmt(totalNet - (item.paidAmount ?? 0))}</span>}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ── New Advance dialog (with employee picker) ─────────────────────────────
function NewAdvanceDialog({ employees, onClose }: { employees: any[]; onClose: () => void }) {
  const [empId, setEmpId]   = useState(employees[0]?.id ? String(employees[0].id) : '');
  const [amount, setAmount] = useState('');
  const [note, setNote]     = useState('');
  const [date, setDate]     = useState(new Date().toISOString().split('T')[0]);
  const [payFrom, setPayFrom] = useState('auto');
  const { data: cashBank = [] } = useCashBankLedgersFlat();
  const qc = useQueryClient();
  const mutation = useAddAdvance();

  const save = () => {
    if (!empId) { toast.error('Select an employee'); return; }
    if (!amount || Number(amount) <= 0) { toast.error('Enter a valid amount'); return; }
    mutation.mutate({
      employeeId: Number(empId), amount: Number(amount), date, note: note || undefined,
      payLedgerId: payFrom !== 'auto' ? Number(payFrom) : undefined,
    }, {
      onSuccess: () => {
        toast.success('Advance recorded');
        qc.invalidateQueries({ queryKey: ['/api/hr/advances'] });
        onClose();
      },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  return (
    <TransactionDialog open dirty={empId !== (employees[0]?.id ? String(employees[0].id) : '') || amount !== '' || note !== '' || payFrom !== 'auto' || date !== new Date().toISOString().split('T')[0]} onOpenChange={onClose}>
      <TransactionDialogContent>
        <DialogHeader><DialogTitle>Record Employee Advance</DialogTitle></DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1">
            <Label>Employee</Label>
            <Select value={empId} onValueChange={setEmpId}>
              <SelectTrigger><SelectValue placeholder="Select employee" /></SelectTrigger>
              <SelectContent>
                {employees.map((e: any) => <SelectItem key={e.id} value={String(e.id)}>{e.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Amount (₹)</Label>
            <Input type="number" min={0} value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" />
          </div>
          <div className="space-y-1">
            <Label>Date</Label>
            <Input type="date" value={date} onChange={e => setDate(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Paid From Account</Label>
            <Select value={payFrom} onValueChange={setPayFrom}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Default — Head Office Cash</SelectItem>
                {(cashBank as any[]).map((a: any) => (
                  <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Pick a warehouse or outlet cash box to pay from that till.</p>
          </div>
          <div className="space-y-1">
            <Label>Note</Label>
            <Textarea value={note} onChange={e => setNote(e.target.value)} placeholder="Reason for advance…" rows={2} />
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
          <Button onClick={save} disabled={mutation.isPending}>Record</Button>
        </DialogFooter>
      </TransactionDialogContent>
    </TransactionDialog>
  );
}

// ── Absence classification dialog ─────────────────────────────────────────
//
// Days with no attendance row, no holiday and no weekly off price as loss of
// pay by omission. A manager decides each one here — casual/sick leave, paid
// off, or confirmed unpaid — through the same attendance-correction route the
// Fix Attendance flow uses, so the accruals and payroll refresh themselves.
const CLASSIFY_CHOICES = [
  { value: 'casual', label: 'Casual Leave' },
  { value: 'sick', label: 'Sick Leave' },
  { value: 'paid_off', label: 'Paid Off' },
  { value: 'absent', label: 'Absent (LOP)' },
] as const;

function classificationBody(choice: string): { status: 'leave' | 'weekly_off' | 'absent'; leaveType?: 'casual' | 'sick' } {
  if (choice === 'casual') return { status: 'leave', leaveType: 'casual' };
  if (choice === 'sick') return { status: 'leave', leaveType: 'sick' };
  if (choice === 'paid_off') return { status: 'weekly_off' };
  return { status: 'absent' };
}

function ClassifyAbsencesDialog({ emp, year, month, onClose }: {
  emp: UnclassifiedAbsences; year: number; month: number; onClose: () => void;
}) {
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const correct = useCorrectAttendance();
  const qc = useQueryClient();
  const chosen = Object.entries(choices).filter(([, v]) => !!v);

  const apply = async () => {
    if (chosen.length === 0) { onClose(); return; }
    setSaving(true);
    let done = 0;
    try {
      // Sequential on purpose: each correction re-prices the month under the
      // attendance lock, and the casual-leave allowance check depends on the
      // days already saved.
      for (const [date, choice] of chosen) {
        await correct.mutateAsync({ employeeId: emp.employeeId, date, ...classificationBody(choice) });
        done += 1;
      }
      toast.success(`Classified ${done} day(s) for ${emp.employeeName}`);
      onClose();
    } catch (e: any) {
      const msg = e?.data?.error || e?.message || 'Failed';
      toast.error(done > 0 ? `Saved ${done} day(s), then failed: ${msg}` : msg);
    } finally {
      setSaving(false);
      qc.invalidateQueries({ queryKey: getUnclassifiedAbsencesQueryKey({ year, month }) });
    }
  };

  return (
    <TransactionDialog open dirty={chosen.length > 0} onOpenChange={onClose}>
      <TransactionDialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Classify Absences — {emp.employeeName}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          These days have no attendance record, so they count as unpaid unless
          classified. Days left as “—” stay unclassified.
        </p>
        <div className="max-h-72 overflow-y-auto rounded-lg border divide-y text-sm">
          {emp.dates.map(date => (
            <div key={date} className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="font-medium">
                {new Date(date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}
              </span>
              <Select value={choices[date] ?? ''} onValueChange={v => setChoices(c => ({ ...c, [date]: v }))}>
                <SelectTrigger className="w-40"><SelectValue placeholder="—" /></SelectTrigger>
                <SelectContent>
                  {CLASSIFY_CHOICES.map(c => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
        <DialogFooter>
          <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
          <Button onClick={apply} disabled={saving || chosen.length === 0}>
            {saving ? 'Saving…' : `Save ${chosen.length || ''} day(s)`}
          </Button>
        </DialogFooter>
      </TransactionDialogContent>
    </TransactionDialog>
  );
}

// ── Advances section ───────────────────────────────────────────────────────
function AdvancesSection({ isAdmin, employees }: { isAdmin: boolean; employees: any[] }) {
  const { data: advances = [] } = useListAdvances();
  const [advOpen, setAdvOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const { sorted: sortedAdvances, sort } = useTableSort(advances as any[], {
    employee: (a: any) => a.employeeName,
    date: (a: any) => a.date,
    amount: (a: any) => Number(a.amount),
    note: (a: any) => a.note,
    status: (a: any) => (a.isDeducted ? 'Deducted' : 'Pending'),
  });

  const shown = showAll ? sortedAdvances : sortedAdvances.slice(0, 5);

  return (
    <div className="mt-8">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="font-semibold text-sm">Employee Advances</h2>
          <p className="text-xs text-muted-foreground">Cash advances disbursed; settled automatically against the month's payroll</p>
        </div>
        {isAdmin && (
          <Button size="sm" variant="outline" onClick={() => setAdvOpen(true)}>
            <PlusCircle className="h-4 w-4 mr-1" />New Advance
          </Button>
        )}
      </div>

      {(advances as any[]).length === 0 ? (
        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <EmptyState icon={Wallet} title="No advances recorded" hint="Cash advances appear here once disbursed." compact />
        </div>
      ) : (
        <>
          <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead k="employee" sort={sort}>Employee</SortableHead>
                  <SortableHead k="date" sort={sort}>Date</SortableHead>
                  <SortableHead k="amount" sort={sort}>Amount</SortableHead>
                  <SortableHead k="note" sort={sort}>Note</SortableHead>
                  <SortableHead k="status" sort={sort}>Status</SortableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((a: any) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-medium">{a.employeeName}</TableCell>
                    <TableCell className="text-muted-foreground">{a.date?.split?.('T')[0] ?? a.date}</TableCell>
                    <TableCell>{fmt(a.amount)}</TableCell>
                    <TableCell className="text-muted-foreground">{a.note ?? '—'}</TableCell>
                    <TableCell>
                      {a.isDeducted
                        ? <StatusBadge status="settled" label="Deducted" />
                        : <StatusBadge status="pending" label="Pending" />}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {(advances as any[]).length > 5 && (
            <Button variant="ghost" size="sm" className="mt-1" onClick={() => setShowAll(s => !s)}>
              {showAll ? <><ChevronUp className="h-3 w-3 mr-1" />Show less</> : <><ChevronDown className="h-3 w-3 mr-1" />Show all ({(advances as any[]).length})</>}
            </Button>
          )}
        </>
      )}

      {advOpen && <NewAdvanceDialog employees={employees} onClose={() => setAdvOpen(false)} />}
    </div>
  );
}

// ── Main Payroll page ──────────────────────────────────────────────────────
export default function Payroll() {
  const perm = usePermission('page:/hr/payroll');
  const { data: me } = useGetMe();
  const isAdmin = (me as any)?.branchType === 'headoffice';

  const now = new Date();
  const [year, setYear]   = useState(String(now.getFullYear()));
  const [month, setMonth] = useState(String(now.getMonth() + 1));
  const [search, setSearch]   = useState('');
  const [viewItem, setViewItem] = useState<EnrichedPayrollRecord | null>(null);
  const [payItem, setPayItem]   = useState<EnrichedPayrollRecord | null>(null);
  const [classifyEmp, setClassifyEmp] = useState<UnclassifiedAbsences | null>(null);
  // Approval refused because the month still has unclassified absent days —
  // holds the row and the dates so the manager can classify or confirm LOP.
  const [lopConfirm, setLopConfirm] = useState<{ item: EnrichedPayrollRecord; dates: string[] } | null>(null);
  const [branchTypeFilter, setBranchTypeFilter] = useState<string>('all');
  useClearOutletSelection(branchTypeFilter.startsWith('outlet-'), () => setBranchTypeFilter('all'));

  const { data: payroll = [], isLoading } = useListEnrichedPayroll({ year: Number(year), month: Number(month) });
  // What daily accrual has already charged to the P&L for this month. Approving
  // a payroll posts only the difference up to it, so it is shown beside the run.
  const { data: accruals = [] } = useListSalaryAccruals({ year: Number(year), month: Number(month) });
  const accruedByEmployee = useMemo(
    () => new Map(accruals.map(a => [a.employeeId, a])),
    [accruals],
  );
  const { data: employees = [] } = useListEmployees();
  const { data: warehouses = [] } = useListWarehouses();
  const { data: outlets = [] } = useListOutlets();
  const { outletsEnabled } = useOutletsEnabled();
  const qc = useQueryClient();
  const approveMutation  = useApprovePayroll();
  // Which employees still have absent-by-omission days this month. Feeds the
  // per-row badge; approval independently re-checks on the server.
  const { data: unclassified = [] } = useUnclassifiedAbsences(
    { year: Number(year), month: Number(month) },
    { query: { enabled: isAdmin } },
  );
  const unclassifiedByEmployee = useMemo(
    () => new Map(unclassified.map(u => [u.employeeId, u])),
    [unclassified],
  );

  const handleApprove = (item: EnrichedPayrollRecord, confirmLop = false) => {
    const already = accruedByEmployee.get(item.employeeId)?.accrued ?? 0;
    approveMutation.mutate({ id: item.id, confirmLop }, {
      onSuccess: () => {
        // Approval is a true-up, not the moment salary hits the books — say so,
        // otherwise the ledger looks like it double-counted the month.
        toast.success(
          already > 0.004
            ? `Approved ${item.employeeName} — ${fmt(already)} was already accrued daily, so only the difference was posted`
            : `Approved payroll for ${item.employeeName}`,
        );
        qc.invalidateQueries({ queryKey: getEnrichedPayrollQueryKey({ year: Number(year), month: Number(month) }) });
        qc.invalidateQueries({ queryKey: getSalaryAccrualsQueryKey({ year: Number(year), month: Number(month) }) });
        setViewItem(null);
        setLopConfirm(null);
      },
      onError: (e: any) => {
        // The server refuses months with unclassified absent days: they would
        // silently price as loss of pay. Offer the choice explicitly.
        if (e?.data?.code === 'UNCLASSIFIED_ABSENCES') {
          setViewItem(null);
          setLopConfirm({ item, dates: e.data.unclassifiedAbsences ?? [] });
          return;
        }
        if (e?.data?.code === 'MONTH_INCOMPLETE') {
          // Days of the pay period haven't occurred yet — approving would lock
          // them in as loss of pay, so the server refuses with no override.
          toast.error(e.data.error, { duration: 8000 });
          return;
        }
        toast.error(e?.data?.error || e.message || 'Failed');
      },
    });
  };

  // Build branch list for filter
  const branchOptions = useMemo(() => {
    const wOpts = (warehouses as any[]).map((w: any) => ({ label: w.name, value: `warehouse-${w.id}` }));
    const oOpts = outletsEnabled ? (outlets as any[]).map((o: any) => ({ label: o.name, value: `outlet-${o.id}` })) : [];
    return [{ label: 'Headoffice', value: 'headoffice' }, ...wOpts, ...oOpts];
  }, [warehouses, outlets, outletsEnabled]);

  const filtered = useMemo(() => {
    let list = payroll as EnrichedPayrollRecord[];
    if (search) list = list.filter(p => p.employeeName?.toLowerCase().includes(search.toLowerCase()));
    if (branchTypeFilter !== 'all') {
      if (branchTypeFilter === 'headoffice') list = list.filter(p => p.branchName === 'Headoffice' || !p.branchName);
      else {
        const [bt, bid] = branchTypeFilter.split('-');
        list = list.filter(p => {
          const emp = (employees as any[]).find((e: any) => e.id === p.employeeId);
          return emp?.branchType === bt && String(emp?.branchId) === bid;
        });
      }
    }
    return list;
  }, [payroll, search, branchTypeFilter, employees]);

  // Merge the daily-accrued figure (a lookup by employee) into each row so the
  // sort accessor reads only from the row, not outside state.
  const rowsForTable = useMemo(
    () => filtered.map(p => ({ ...p, _accrued: accruedByEmployee.get(p.employeeId)?.accrued ?? null })),
    [filtered, accruedByEmployee],
  );
  const { sorted, sort } = useTableSort(rowsForTable, {
    employee: (p: any) => p.employeeName,
    branch: (p: any) => p.branchName,
    days: (p: any) => Number(p.presentDays ?? 0),
    gross: (p: any) => Number(p.grossPay ?? 0) + Number(p.extraAmount ?? 0),
    deductions: (p: any) => Number(p.deductions ?? 0),
    advance: (p: any) => Number(p.advanceDeduction ?? 0),
    net: (p: any) => Number(p.netPay ?? 0) + Number(p.extraAmount ?? 0),
    status: (p: any) => p.status,
  });

  const totals = useMemo(() => filtered.reduce((acc, p) => ({
    net: acc.net + (p.netPay ?? 0) + (p.extraAmount ?? 0),
    paid: acc.paid + (p.paidAmount ?? 0),
    accrued: acc.accrued + (accruedByEmployee.get(p.employeeId)?.accrued ?? 0),
    count: acc.count + 1,
  }), { net: 0, paid: 0, accrued: 0, count: 0 }), [filtered, accruedByEmployee]);

  if (!perm.isLoading && !perm.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center h-64 text-muted-foreground gap-2">
          <ShieldOff className="h-10 w-10" /><p>You don't have permission to view payroll.</p>
        </div>
      </AppLayout>
    );
  }

  const handleExport = () => {
    const rows = filtered.map(p => ({
      Employee: p.employeeName, Branch: p.branchName, Month: MONTHS[(p.month ?? 1) - 1],
      Year: p.year, 'Working Days': p.workingDays, 'Present Days': p.presentDays,
      'Casual Leave Used': p.paidLeaveUsed ?? '', 'Casual Leave Allowed': p.paidLeaveAllowed ?? '',
      'Sick Leave Used': p.sickLeaveUsed ?? '', 'Sick Leave Allowed': p.sickLeaveAllowed ?? '',
      'LOP Days': p.lopDays, 'Basic Salary': p.baseSalary, 'Gross Pay': p.grossPay,
      Allowances: p.allowancesTotal, Deductions: p.deductions,
      'Advance Deduction': p.advanceDeduction ?? 0,
      'Extra Amount': p.extraAmount ?? 0,
      'Net Pay': (p.netPay ?? 0) + (p.extraAmount ?? 0),
      Status: p.status, 'Paid Amount': p.paidAmount ?? 0, 'Payment Mode': p.paymentMode ?? '',
    }));
    downloadCSV(`payroll-${year}-${month}.csv`, rows);
    toast.success('Exported');
  };

  return (
    <AppLayout>
      <div className="space-y-6 mb-6">
        <PageHeader
          title="Payroll"
          description="Computed automatically from attendance — review, approve and pay"
          icon={DollarSign}
          actions={
            perm.canDownload ? (
              <Button variant="outline" size="sm" onClick={handleExport}>
                <Download className="h-4 w-4 mr-1" />Export
              </Button>
            ) : undefined
          }
        />

        {/* Summary strip */}
        {filtered.length > 0 && (
          <SummaryCardGrid>
            <SummaryCard label="Total Employees" value={String(totals.count)} icon={Users} />
            <SummaryCard label="Total Net Pay" value={fmt(totals.net)} icon={DollarSign} />
            <SummaryCard label="Total Paid" value={fmt(totals.paid)} icon={Wallet} tone="positive" />
            <SummaryCard label="Already Accrued Daily" value={fmt(totals.accrued)} sub="In the P&L as it was attended" icon={RefreshCw} tone="info" />
          </SummaryCardGrid>
        )}

        {/* Toolbar: search left, filters right */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px] max-w-xs max-md:max-w-full">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search employee…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <div className="flex items-center gap-3 flex-wrap ml-auto">
            <Select value={month} onValueChange={setMonth}>
              <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
              <SelectContent>
                {MONTHS.map((m, i) => <SelectItem key={i} value={String(i + 1)}>{m}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={year} onValueChange={setYear}>
              <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
              <SelectContent>
                {[now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1].map(y =>
                  <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                )}
              </SelectContent>
            </Select>
            {isAdmin && (
              <Select value={branchTypeFilter} onValueChange={setBranchTypeFilter}>
                <SelectTrigger className="w-40"><SelectValue placeholder="All branches" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Branches</SelectItem>
                  {branchOptions.map(b => <SelectItem key={b.value} value={b.value}>{b.label}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
          </div>
        </div>
      </div>

      {/* Payroll table */}
      <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableHead k="employee" sort={sort}>Employee</SortableHead>
              {isAdmin && <SortableHead k="branch" sort={sort}>Branch</SortableHead>}
              <SortableHead k="days" sort={sort} className="text-center">Days</SortableHead>
              <SortableHead k="gross" sort={sort} className="text-right">Gross Pay</SortableHead>
              <SortableHead k="deductions" sort={sort} className="text-right">Deductions</SortableHead>
              <SortableHead k="advance" sort={sort} className="text-right">Advance Adj.</SortableHead>
              {isAdmin && <SortableHead k="net" sort={sort} className="text-right">Net Pay</SortableHead>}
              <SortableHead k="status" sort={sort}>Status</SortableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={9} className="p-0"><TableSkeleton rows={8} cols={9} /></TableCell></TableRow>
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="p-0">
                  <EmptyState
                    icon={DollarSign}
                    title="No payroll records"
                    hint={`No payroll for ${MONTHS[Number(month) - 1]} ${year}. Rows appear automatically once employees have salary or attendance in the month.`}
                    compact
                  />
                </TableCell>
              </TableRow>
            ) : sorted.map((p) => {
              const totalNet = (p.netPay ?? 0) + (p.extraAmount ?? 0);
              const unclass = p.status === 'draft' ? unclassifiedByEmployee.get(p.employeeId) : undefined;
              return (
                <TableRow key={p.id} className="cursor-pointer hover:bg-muted/30" onClick={() => setViewItem(p)}>
                  <TableCell className="font-medium">
                    {p.employeeName}
                    {isAdmin && unclass && (
                      <button
                        type="button"
                        className="ml-2 inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-800 px-2 py-0.5 text-[11px] font-medium hover:bg-amber-200"
                        title="Days with no attendance record — classify before approval or they count as loss of pay"
                        onClick={e => { e.stopPropagation(); setClassifyEmp(unclass); }}
                      >
                        <AlertTriangle className="h-3 w-3" />{unclass.dates.length} unclassified
                      </button>
                    )}
                  </TableCell>
                  {isAdmin && <TableCell className="text-muted-foreground text-xs">{p.branchName || '—'}</TableCell>}
                  <TableCell className="text-center text-sm">
                    <span className="text-emerald-600">{Number(p.presentDays ?? 0).toFixed(1)}</span>
                    <span className="text-muted-foreground">/{p.workingDays}</span>
                    {(p.lopDays ?? 0) > 0 && <span className="text-red-500 ml-1">({Number(p.lopDays).toFixed(1)} LOP)</span>}
                  </TableCell>
                  <TableCell className="text-right">{fmt((p.grossPay ?? 0) + (p.extraAmount ?? 0))}</TableCell>
                  <TableCell className="text-right text-red-600">{(p.deductions ?? 0) > 0 ? fmt(p.deductions ?? 0) : '—'}</TableCell>
                  <TableCell className="text-right text-amber-700">{(p.advanceDeduction ?? 0) > 0 ? fmt(p.advanceDeduction ?? 0) : '—'}</TableCell>
                  {isAdmin && <TableCell className="text-right font-semibold">{fmt(totalNet)}</TableCell>}
                  <TableCell onClick={e => e.stopPropagation()}>
                    {statusBadge(p.status, p.paidAmount ?? 0, totalNet)}
                  </TableCell>
                  <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                    <div className="flex gap-1 justify-end">
                      <Button size="sm" variant="ghost" onClick={() => setViewItem(p)} title="View">
                        <Eye className="h-4 w-4" />
                      </Button>
                      {isAdmin && p.status === 'draft' && perm.canEdit && (
                        <Button size="sm" variant="ghost" className="text-blue-600" onClick={() => handleApprove(p)} title="Approve">
                          <CheckCircle className="h-4 w-4" />
                        </Button>
                      )}
                      {isAdmin && p.status === 'approved' && perm.canEdit && (
                        <Button size="sm" variant="ghost" className="text-emerald-600" onClick={() => setPayItem(p)} title="Pay">
                          <DollarSign className="h-4 w-4" />
                        </Button>
                      )}
                      {perm.canDownload && (
                      <Button size="sm" variant="ghost" onClick={() => downloadPayslip(p)} title="Download payslip">
                        <FileDown className="h-4 w-4" />
                      </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* Advances section (admin only) */}
      {isAdmin && (
        <AdvancesSection isAdmin={isAdmin} employees={employees as any[]} />
      )}

      {/* Detail sheet */}
      {viewItem && (
        <PayslipSheet
          item={viewItem}
          accrued={accruedByEmployee.get(viewItem.employeeId)?.accrued ?? 0}
          onClose={() => setViewItem(null)}
          isAdmin={isAdmin}
          onApprove={() => handleApprove(viewItem)}
          onPay={() => { setPayItem(viewItem); setViewItem(null); }}
          canDownload={perm.canDownload}
        />
      )}

      {/* Dialogs */}
      {payItem && <PayDialog item={payItem} onClose={() => setPayItem(null)} />}
      {classifyEmp && (
        <ClassifyAbsencesDialog
          emp={classifyEmp}
          year={Number(year)}
          month={Number(month)}
          onClose={() => setClassifyEmp(null)}
        />
      )}

      {/* Approval refused: unclassified absent days. Classify them, or confirm
          they are loss of pay and approve anyway. */}
      {lopConfirm && (
        <TransactionDialog open dirty={false} onOpenChange={() => setLopConfirm(null)}>
          <TransactionDialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-amber-600">
                <AlertTriangle className="h-5 w-5" />Unclassified Absences — {lopConfirm.item.employeeName}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              <p className="text-muted-foreground">
                These days have no attendance record. Approving now treats every
                one of them as <span className="font-medium text-foreground">unpaid (Loss of Pay)</span>.
              </p>
              <div className="rounded-lg border bg-muted/30 px-3 py-2 max-h-40 overflow-y-auto">
                {lopConfirm.dates.map(d => (
                  <div key={d} className="py-0.5">
                    {new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}
                  </div>
                ))}
              </div>
            </div>
            <DialogFooter className="gap-2">
              <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
              <Button
                variant="outline"
                onClick={() => {
                  const u = unclassifiedByEmployee.get(lopConfirm.item.employeeId);
                  setClassifyEmp(u ?? { employeeId: lopConfirm.item.employeeId, employeeName: lopConfirm.item.employeeName, dates: lopConfirm.dates });
                  setLopConfirm(null);
                }}
              >
                Classify Days
              </Button>
              <Button
                variant="destructive"
                onClick={() => handleApprove(lopConfirm.item, true)}
                disabled={approveMutation.isPending}
              >
                Approve as LOP
              </Button>
            </DialogFooter>
          </TransactionDialogContent>
        </TransactionDialog>
      )}
    </AppLayout>
  );
}
