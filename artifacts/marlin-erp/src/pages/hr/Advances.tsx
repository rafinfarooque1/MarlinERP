import { useState } from 'react';
import { useListAdvances, useAddAdvance, useUpdateAdvance, useDeleteAdvance, useListEmployees, useCashBankLedgersFlat } from '@workspace/api-client-react';
import { usePermission } from '@/lib/usePermission';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { TransactionDialog, TransactionDialogContent } from '@/components/ui/transaction-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ShieldOff, Plus, Search, Wallet, Clock, CheckCircle2, Loader2, IndianRupee, FileDown, Pencil, Trash2, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadPDFFromEndpoint } from '@/lib/download';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { PageHeader } from '@/components/app/page-header';
import { SummaryCard, SummaryCardGrid } from '@/components/app/summary-card';
import { StatusBadge } from '@/components/app/status-badge';
import { EmptyState } from '@/components/app/empty-state';
import { TableSkeleton } from '@/components/app/loading-skeletons';
import { TablePager, useClientPage } from '@/components/ui/table-pager';
import { inr } from '@/lib/currency';

const fmt = inr;

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
    <TransactionDialog open dirty={employeeId !== '' || amount !== '' || note !== '' || payFrom !== 'auto' || date !== new Date().toISOString().split('T')[0]} onOpenChange={onClose}>
      <TransactionDialogContent className="sm:max-w-md">
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
            Posted as a payment voucher against the employee's Salary Payable ledger.
            The amount will be deducted from the next payroll run.
          </p>
        </div>

        <DialogFooter>
          <DialogClose asChild><Button variant="outline" disabled={saving}>Cancel</Button></DialogClose>
          <Button onClick={submit} disabled={saving}>
            {saving ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</> : 'Record Advance'}
          </Button>
        </DialogFooter>
      </TransactionDialogContent>
    </TransactionDialog>
  );
}

// The cash "Recover Advance" flow is retired (Aug 2026): an advance now lives
// as a debit on the employee's Salary Payable ledger and payroll settles it —
// one settlement path. Historical cash recoveries keep their badge below.

// ── Edit Advance Dialog ───────────────────────────────────────────────────────
/**
 * Fix a pending advance's amount, date or note. The server refuses advances a
 * payroll run has reserved or already settled, and keeps the journal entry it
 * posted in sync — so the books always match what's shown here.
 */
function EditAdvanceDialog({ advance, onClose }: { advance: any; onClose: () => void }) {
  const qc = useQueryClient();
  const mutation = useUpdateAdvance();

  const [amount, setAmount] = useState(String(advance.amount ?? ''));
  const [date, setDate]     = useState((advance.date ?? '').split('T')[0]);
  const [note, setNote]     = useState(advance.note ?? '');

  const submit = () => {
    const amt = Number(amount);
    if (!amt || amt <= 0) { toast.error('Enter a valid amount'); return; }
    mutation.mutate(
      { id: advance.id, amount, date, note: note.trim() || null },
      {
        onSuccess: () => {
          toast.success('Advance updated');
          qc.invalidateQueries({ queryKey: ['/api/hr/advances'] });
          onClose();
        },
        onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed to update the advance'),
      },
    );
  };

  return (
    <TransactionDialog open dirty={amount !== String(advance.amount ?? '') || date !== (advance.date ?? '').split('T')[0] || note !== (advance.note ?? '')} onOpenChange={onClose}>
      <TransactionDialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="w-5 h-5 text-primary" /> Edit Advance
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="rounded-lg border bg-muted/30 px-4 py-3 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Employee</span><span className="font-medium">{advance.employeeName}</span></div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Amount (₹) <span className="text-destructive">*</span></Label>
              <Input type="number" min="1" value={amount} onChange={e => setAmount(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Date</Label>
              <Input type="date" value={date} onChange={e => setDate(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Reason / Note</Label>
            <Textarea value={note} onChange={e => setNote(e.target.value)} rows={2} />
          </div>

          <p className="text-xs text-muted-foreground bg-muted/40 rounded-lg px-3 py-2">
            The payment voucher posted for this advance is updated automatically to match.
          </p>
        </div>

        <DialogFooter>
          <DialogClose asChild><Button variant="outline" disabled={mutation.isPending}>Cancel</Button></DialogClose>
          <Button onClick={submit} disabled={mutation.isPending}>
            {mutation.isPending ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</> : 'Save Changes'}
          </Button>
        </DialogFooter>
      </TransactionDialogContent>
    </TransactionDialog>
  );
}

// ── Delete Advance Dialog ─────────────────────────────────────────────────────
/**
 * Remove an advance recorded in error. Pending and cash-recovered advances can
 * go — the journal entries they posted are removed with them. Advances settled
 * through a payroll run can't be deleted (the salary figures were built on them);
 * the server enforces this and the button is hidden for those rows.
 */
function DeleteAdvanceDialog({ advance, onClose }: { advance: any; onClose: () => void }) {
  const qc = useQueryClient();
  const mutation = useDeleteAdvance();

  const submit = () => {
    mutation.mutate(
      { id: advance.id },
      {
        onSuccess: () => {
          toast.success(`Advance of ${fmt(advance.amount)} deleted`);
          qc.invalidateQueries({ queryKey: ['/api/hr/advances'] });
          onClose();
        },
        onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed to delete the advance'),
      },
    );
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-destructive" /> Delete Advance?
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="rounded-lg border bg-muted/30 px-4 py-3 text-sm space-y-1">
            <div className="flex justify-between"><span className="text-muted-foreground">Employee</span><span className="font-medium">{advance.employeeName}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Date</span><span>{fmtDate(advance.date)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Amount</span><span className="font-bold font-mono">{fmt(advance.amount)}</span></div>
          </div>

          <p className="text-sm text-muted-foreground">
            {advance.isDeducted
              ? 'This advance was recovered in cash. Deleting it removes BOTH journal entries — the original payment out and the cash recovery — as if the advance never happened.'
              : 'Deleting removes the advance and the payment voucher posted when it was paid out, as if it never happened.'}
            {' '}This cannot be undone.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>Cancel</Button>
          <Button variant="destructive" onClick={submit} disabled={mutation.isPending}>
            {mutation.isPending ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Deleting…</> : 'Delete Advance'}
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
  const list = advances as any[];

  const [search,    setSearch]    = useState('');
  const [statusFilter, setStatus] = useState<'all' | 'pending' | 'deducted'>('all');
  const [showNew,   setShowNew]   = useState(false);
  const [editTarget,    setEditTarget]    = useState<any>(null);
  const [deleteTarget,  setDeleteTarget]  = useState<any>(null);

  if (!perm.isLoading && !perm.canView) {
    return (
      <AppLayout>
        <EmptyState
          icon={ShieldOff}
          title="Access Denied"
          hint="You don't have permission to view this page."
          className="min-h-[60vh]"
        />
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

  const { sorted, sort } = useTableSort(filtered, {
    employee: (a: any) => a.employeeName,
    date: (a: any) => a.date,
    amount: (a: any) => Number(a.amount),
    note: (a: any) => a.note,
    status: (a: any) =>
      a.isDeducted ? (a.deductedPayrollId ? 'Recovered (payroll)' : 'Recovered (cash)')
      : a.deductedPayrollId ? 'In payroll'
      : 'Pending',
  });

  const { pageRows, pagerProps } = useClientPage(sorted);

  return (
    <AppLayout>
      <div className="space-y-6 max-w-5xl">

        <PageHeader
          title="Employee Advances"
          description="Cash advances disbursed to employees against Salary Payable — deducted automatically from the next payroll."
          icon={Wallet}
          actions={perm.canAdd && (
            <Button onClick={() => setShowNew(true)}>
              <Plus className="w-4 h-4 mr-2" /> New Advance
            </Button>
          )}
        />

        {/* Summary cards */}
        <SummaryCardGrid className="lg:grid-cols-3">
          <SummaryCard
            label="Pending Recovery"
            value={fmt(totalPending)}
            sub={`${pendingCount} advance${pendingCount !== 1 ? 's' : ''}`}
            icon={Clock}
            tone="warning"
            loading={isLoading}
          />
          <SummaryCard
            label="Recovered"
            value={fmt(totalDeducted)}
            sub={`${list.filter(a => a.isDeducted).length} advance${list.filter(a => a.isDeducted).length !== 1 ? 's' : ''}`}
            icon={CheckCircle2}
            tone="positive"
            loading={isLoading}
          />
          <SummaryCard
            label="Total Disbursed"
            value={fmt(totalPending + totalDeducted)}
            sub={`${list.length} total`}
            icon={IndianRupee}
            tone="default"
            loading={isLoading}
          />
        </SummaryCardGrid>

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
        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          {isLoading ? (
            <TableSkeleton rows={8} cols={6} />
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={Wallet}
              title="No advances found"
              hint={list.length === 0 ? 'Record the first advance using the button above.' : 'Try adjusting the filters.'}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead k="employee" sort={sort}>Employee</SortableHead>
                  <SortableHead k="date" sort={sort}>Date</SortableHead>
                  <SortableHead k="amount" sort={sort} className="text-right">Amount</SortableHead>
                  <SortableHead k="note" sort={sort}>Note</SortableHead>
                  <SortableHead k="status" sort={sort}>Status</SortableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageRows.map((a: any) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-medium">{a.employeeName}</TableCell>
                    <TableCell className="text-muted-foreground">{fmtDate(a.date)}</TableCell>
                    <TableCell className="text-right font-mono text-sm font-semibold">{fmt(a.amount)}</TableCell>
                    <TableCell className="text-muted-foreground max-w-[220px] truncate">{a.note || '—'}</TableCell>
                    <TableCell>
                      {a.isDeducted ? (
                        // deductedPayrollId set = withheld from a salary run;
                        // null = the employee paid it back in cash/bank.
                        <StatusBadge status="recovered" label={a.deductedPayrollId ? 'Recovered (payroll)' : 'Recovered (cash)'} className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/25" />
                      ) : a.deductedPayrollId ? (
                        // Reserved by a draft/approved payroll run — recovery
                        // must happen through that run, so no cash button.
                        <StatusBadge status="in_transit" label="In payroll" />
                      ) : (
                        <StatusBadge status="pending" label="Pending" />
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1 justify-end">
                      {/* Legacy rows (no payment voucher — old advance-ledger flow) are
                          read-only: their balance was moved to Salary Payable by the
                          one-time migration, so the server locks edit/delete too. */}
                      {perm.canEdit && !a.isDeducted && !a.deductedPayrollId && a.paymentVoucherId != null && (
                        <Button
                          variant="ghost" size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-primary"
                          title="Edit advance"
                          onClick={() => setEditTarget(a)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {perm.canDownload && (
                      <Button
                        variant="ghost" size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-primary"
                        title="Download PDF"
                        onClick={async () => {
                          // Prints the advance's actual book entry (linked
                          // voucher) under the paying location's letterhead.
                          try {
                            await downloadPDFFromEndpoint('/api/pdf/advance-voucher', { id: a.id },
                              `Advance-${a.id}.pdf`);
                          } catch (e: any) { toast.error(e?.message || 'Could not generate the PDF'); }
                        }}
                      >
                        <FileDown className="h-3.5 w-3.5" />
                      </Button>
                      )}
                      {/* Delete: new-flow pending or cash-recovered rows only — an advance
                          a payroll run touched keeps its history, and pending legacy rows
                          are locked post-migration (server enforces both). */}
                      {perm.canDelete && !a.deductedPayrollId && (a.isDeducted || a.paymentVoucherId != null) && (
                        <Button
                          variant="ghost" size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          title="Delete advance"
                          onClick={() => setDeleteTarget(a)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
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

        {filtered.length > 0 && <TablePager {...pagerProps} />}
      </div>

      {showNew && <NewAdvanceDialog onClose={() => setShowNew(false)} />}
      {editTarget && <EditAdvanceDialog advance={editTarget} onClose={() => setEditTarget(null)} />}
      {deleteTarget && <DeleteAdvanceDialog advance={deleteTarget} onClose={() => setDeleteTarget(null)} />}
    </AppLayout>
  );
}
