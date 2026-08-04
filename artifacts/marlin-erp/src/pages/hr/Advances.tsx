import { useState } from 'react';
import { useListAdvances, useAddAdvance, useRecoverAdvance, useListEmployees, useGetCompanySettings, useCashBankLedgersFlat } from '@workspace/api-client-react';
import { usePermission } from '@/lib/usePermission';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ShieldOff, Plus, Search, Wallet, Clock, CheckCircle2, Loader2, IndianRupee, FileDown, HandCoins } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadAdvancePDF } from '@/lib/pdfUtils';

const fmt = (n: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n);

const fmtDate = (s?: string | null) =>
  s ? new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

// ── New Advance Dialog ────────────────────────────────────────────────────────
function NewAdvanceDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: employees = [] } = useListEmployees();
  const mutation = useAddAdvance();

  const [employeeId, setEmployeeId] = useState('');
  const [amount, setAmount]       = useState('');
  const [date, setDate]           = useState(new Date().toISOString().split('T')[0]);
  const [note, setNote]           = useState('');
  const [payFrom, setPayFrom]     = useState('auto');
  const [saving, setSaving]       = useState(false);
  const { data: cashBank = [] } = useCashBankLedgersFlat();

  const submit = async () => {
    if (!employeeId) { toast.error('Select an employee'); return; }
    const amt = Number(amount);
    if (!amt || amt <= 0) { toast.error('Enter a valid amount'); return; }
    setSaving(true);
    try {
      await mutation.mutateAsync({
        employeeId: Number(employeeId), amount: amt, date, note: note || undefined,
        payLedgerId: payFrom !== 'auto' ? Number(payFrom) : undefined,
      });
      toast.success('Advance recorded');
      qc.invalidateQueries({ queryKey: ['/api/hr/advances'] });
      onClose();
    } catch {
      toast.error('Failed to record advance');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wallet className="w-5 h-5 text-primary" /> Record Advance Payment
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Employee <span className="text-destructive">*</span></Label>
            <Select value={employeeId} onValueChange={setEmployeeId}>
              <SelectTrigger>
                <SelectValue placeholder="Select employee…" />
              </SelectTrigger>
              <SelectContent>
                {(employees as any[]).map((e: any) => (
                  <SelectItem key={e.id} value={String(e.id)}>{e.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Amount (₹) <span className="text-destructive">*</span></Label>
              <Input
                type="number"
                min="1"
                placeholder="0.00"
                value={amount}
                onChange={e => setAmount(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Date</Label>
              <Input type="date" value={date} onChange={e => setDate(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1.5">
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

          <div className="space-y-1.5">
            <Label>Reason / Note</Label>
            <Textarea
              placeholder="Optional reason for the advance…"
              value={note}
              onChange={e => setNote(e.target.value)}
              rows={2}
            />
          </div>

          <p className="text-xs text-muted-foreground bg-muted/40 rounded-lg px-3 py-2">
            A journal entry (Dr Advance-to-Employee / Cr Cash) will be posted automatically.
            The amount will be deducted from the next payroll run.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</> : 'Record Advance'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Recover Advance Dialog ────────────────────────────────────────────────────
/**
 * Records the employee paying an advance back in cash, outside payroll. The
 * whole remaining amount is recovered in one go — the same all-or-nothing rule
 * payroll deduction uses — and the server refuses advances a payroll run has
 * already reserved.
 */
function RecoverAdvanceDialog({ advance, onClose }: { advance: any; onClose: () => void }) {
  const qc = useQueryClient();
  const mutation = useRecoverAdvance();
  const { data: cashBank = [] } = useCashBankLedgersFlat();
  const [receiveIn, setReceiveIn] = useState('auto');

  const submit = () => {
    mutation.mutate(
      { id: advance.id, receiveLedgerId: receiveIn !== 'auto' ? Number(receiveIn) : undefined },
      {
        onSuccess: () => {
          toast.success(`Advance of ${fmt(advance.amount)} recovered from ${advance.employeeName}`);
          qc.invalidateQueries({ queryKey: ['/api/hr/advances'] });
          onClose();
        },
        onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed to recover the advance'),
      },
    );
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HandCoins className="w-5 h-5 text-primary" /> Recover Advance in Cash
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="rounded-lg border bg-muted/30 px-4 py-3 text-sm space-y-1">
            <div className="flex justify-between"><span className="text-muted-foreground">Employee</span><span className="font-medium">{advance.employeeName}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Advance date</span><span>{fmtDate(advance.date)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Amount to recover</span><span className="font-bold font-mono">{fmt(advance.amount)}</span></div>
          </div>

          <div className="space-y-1.5">
            <Label>Received Into</Label>
            <Select value={receiveIn} onValueChange={setReceiveIn}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Default — your branch till</SelectItem>
                {(cashBank as any[]).map((a: any) => (
                  <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Pick the cash box or bank account the money went into.</p>
          </div>

          <p className="text-xs text-muted-foreground bg-muted/40 rounded-lg px-3 py-2">
            The full amount is settled at once and a journal entry is posted automatically.
            The advance will no longer be deducted from payroll.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>Cancel</Button>
          <Button onClick={submit} disabled={mutation.isPending}>
            {mutation.isPending ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Recording…</> : 'Record Recovery'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function Advances() {
  const perm = usePermission('page:/hr/advances');
  const { data: advances = [], isLoading } = useListAdvances();
  const { data: cs } = useGetCompanySettings();
  const list = advances as any[];

  const [search,    setSearch]    = useState('');
  const [statusFilter, setStatus] = useState<'all' | 'pending' | 'deducted'>('all');
  const [showNew,   setShowNew]   = useState(false);
  const [recoverTarget, setRecoverTarget] = useState<any>(null);

  if (!perm.isLoading && !perm.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center">
          <div className="w-16 h-16 rounded-2xl bg-destructive/10 flex items-center justify-center">
            <ShieldOff className="w-8 h-8 text-destructive" />
          </div>
          <div>
            <h2 className="text-xl font-bold">Access Denied</h2>
            <p className="text-muted-foreground mt-1 text-sm">You don't have permission to view this page.</p>
          </div>
        </div>
      </AppLayout>
    );
  }

  // ── Derived stats ───────────────────────────────────────────────────────────
  const totalPending   = list.filter(a => !a.isDeducted).reduce((s, a) => s + a.amount, 0);
  const totalDeducted  = list.filter(a =>  a.isDeducted).reduce((s, a) => s + a.amount, 0);
  const pendingCount   = list.filter(a => !a.isDeducted).length;

  // ── Filtered list ───────────────────────────────────────────────────────────
  const filtered = list.filter(a => {
    const matchSearch = !search || a.employeeName?.toLowerCase().includes(search.toLowerCase());
    const matchStatus =
      statusFilter === 'all'      ? true :
      statusFilter === 'pending'  ? !a.isDeducted :
                                     a.isDeducted;
    return matchSearch && matchStatus;
  });

  return (
    <AppLayout>
      <div className="space-y-6 max-w-5xl">

        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Wallet className="w-6 h-6 text-primary" /> Employee Advances
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Cash advances disbursed to employees — recovered automatically during payroll, or in cash any time.
            </p>
          </div>
          {perm.canAdd && (
            <Button onClick={() => setShowNew(true)}>
              <Plus className="w-4 h-4 mr-2" /> New Advance
            </Button>
          )}
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-card border border-border rounded-xl p-4 flex items-center gap-4">
            <div className="w-10 h-10 rounded-lg bg-amber-500/10 flex items-center justify-center shrink-0">
              <Clock className="w-5 h-5 text-amber-500" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Pending Recovery</p>
              <p className="text-lg font-bold">{fmt(totalPending)}</p>
              <p className="text-xs text-muted-foreground">{pendingCount} advance{pendingCount !== 1 ? 's' : ''}</p>
            </div>
          </div>

          <div className="bg-card border border-border rounded-xl p-4 flex items-center gap-4">
            <div className="w-10 h-10 rounded-lg bg-green-500/10 flex items-center justify-center shrink-0">
              <CheckCircle2 className="w-5 h-5 text-green-500" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Recovered</p>
              <p className="text-lg font-bold">{fmt(totalDeducted)}</p>
              <p className="text-xs text-muted-foreground">{list.filter(a => a.isDeducted).length} advance{list.filter(a => a.isDeducted).length !== 1 ? 's' : ''}</p>
            </div>
          </div>

          <div className="bg-card border border-border rounded-xl p-4 flex items-center gap-4">
            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <IndianRupee className="w-5 h-5 text-primary" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Total Disbursed</p>
              <p className="text-lg font-bold">{fmt(totalPending + totalDeducted)}</p>
              <p className="text-xs text-muted-foreground">{list.length} total</p>
            </div>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search employee…"
              className="pl-9"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <Select value={statusFilter} onValueChange={v => setStatus(v as any)}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Advances</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="deducted">Recovered</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Table */}
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          {isLoading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-16 text-center text-muted-foreground">
              <Wallet className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="font-medium">No advances found</p>
              <p className="text-sm mt-1">
                {list.length === 0 ? 'Record the first advance using the button above.' : 'Try adjusting the filters.'}
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Note</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((a: any) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-medium">{a.employeeName}</TableCell>
                    <TableCell className="text-muted-foreground">{fmtDate(a.date)}</TableCell>
                    <TableCell className="text-right font-mono font-semibold">{fmt(a.amount)}</TableCell>
                    <TableCell className="text-muted-foreground max-w-[220px] truncate">{a.note || '—'}</TableCell>
                    <TableCell>
                      {a.isDeducted ? (
                        // deductedPayrollId set = withheld from a salary run;
                        // null = the employee paid it back in cash/bank.
                        <Badge variant="outline" className="text-green-600 border-green-200 bg-green-50 dark:bg-green-950/20">
                          <CheckCircle2 className="w-3 h-3 mr-1" /> {a.deductedPayrollId ? 'Recovered (payroll)' : 'Recovered (cash)'}
                        </Badge>
                      ) : a.deductedPayrollId ? (
                        // Reserved by a draft/approved payroll run — recovery
                        // must happen through that run, so no cash button.
                        <Badge variant="outline" className="text-blue-600 border-blue-200 bg-blue-50 dark:bg-blue-950/20">
                          <Clock className="w-3 h-3 mr-1" /> In payroll
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-amber-600 border-amber-200 bg-amber-50 dark:bg-amber-950/20">
                          <Clock className="w-3 h-3 mr-1" /> Pending
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1 justify-end">
                      {perm.canEdit && !a.isDeducted && !a.deductedPayrollId && (
                        <Button
                          variant="ghost" size="sm"
                          className="h-7 px-2 text-xs text-muted-foreground hover:text-primary"
                          title="Employee paid this back in cash"
                          onClick={() => setRecoverTarget(a)}
                        >
                          <HandCoins className="h-3.5 w-3.5 mr-1" /> Recover
                        </Button>
                      )}
                      {perm.canDownload && (
                      <Button
                        variant="ghost" size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-primary"
                        title="Download PDF"
                        onClick={() => downloadAdvancePDF({
                          id: a.id,
                          employeeName: a.employeeName,
                          amount: a.amount,
                          date: a.date?.split('T')[0] ?? a.date,
                          note: a.note,
                          isDeducted: a.isDeducted,
                        }, cs)}
                      >
                        <FileDown className="h-3.5 w-3.5" />
                      </Button>
                      )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        {filtered.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Showing {filtered.length} of {list.length} advance{list.length !== 1 ? 's' : ''}
          </p>
        )}
      </div>

      {showNew && <NewAdvanceDialog onClose={() => setShowNew(false)} />}
      {recoverTarget && <RecoverAdvanceDialog advance={recoverTarget} onClose={() => setRecoverTarget(null)} />}
    </AppLayout>
  );
}
