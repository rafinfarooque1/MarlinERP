import { useMemo, useState } from 'react';
import {
  usePeriodLocks, usePeriodLockEvents, usePeriodSummary,
  useLockPeriod, useUnlockPeriod, PeriodLock,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Lock, LockOpen, ShieldAlert, History, ChevronLeft, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const inr = (n: number) =>
  `₹${Number(n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type Ym = { year: number; month: number };

/** The exact warning the spec requires before locking. */
const LOCK_WARNING =
  'You are about to lock this month. After locking, no invoices, purchases, payments, receipts, expenses or any other records of this month can be added, edited or deleted. Invoice numbers and B2B/B2C classification are frozen permanently. Only an Administrator can unlock it later, with a reason that is recorded.';

function SummaryRow({ label, value, count }: { label: string; value: string; count?: number }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-border/50 last:border-0 text-sm">
      <span className="text-muted-foreground">
        {label}{count != null ? <span className="ml-1 text-xs">({count})</span> : null}
      </span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

/** Month-close verification summary — shown before locking and on demand. */
function MonthSummary({ ym }: { ym: Ym }) {
  const { data: s, isLoading, error } = usePeriodSummary(ym.year, ym.month);
  if (isLoading) return <div className="py-6 text-center text-sm text-muted-foreground">Preparing the month's verification summary…</div>;
  if (error || !s) return <div className="py-6 text-center text-sm text-destructive">Could not load the month summary.</div>;
  return (
    <div className="grid gap-x-8 sm:grid-cols-2">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">This month</p>
        <SummaryRow label="Sales" value={inr(s.totals.sales)} count={s.totals.salesCount} />
        <SummaryRow label="Purchases" value={inr(s.totals.purchases)} count={s.totals.purchasesCount} />
        <SummaryRow label="Receipts" value={inr(s.totals.receipts)} count={s.totals.receiptsCount} />
        <SummaryRow label="Payments" value={inr(s.totals.payments)} count={s.totals.paymentsCount} />
        <SummaryRow label="Expenses" value={inr(s.totals.expenses)} />
        <SummaryRow label="GST on sales" value={inr(s.totals.gstOnSales)} />
        <SummaryRow label="B2B invoices" value={String(s.invoiceCounts.b2b)} />
        <SummaryRow label="B2C invoices" value={String(s.invoiceCounts.b2c)} />
        {s.invoiceCounts.other > 0 && (
          <SummaryRow label="Other invoices (legacy/transfer)" value={String(s.invoiceCounts.other)} />
        )}
      </div>
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1 mt-4 sm:mt-0">As of {s.toDate}</p>
        <SummaryRow label="Receivables" value={inr(s.asOfMonthEnd.receivables)} />
        <SummaryRow label="Payables" value={inr(s.asOfMonthEnd.payables)} />
        <SummaryRow label="Cash in hand" value={inr(s.asOfMonthEnd.cash)} />
        <SummaryRow label="Bank balance" value={inr(s.asOfMonthEnd.bank)} />
        <SummaryRow label="Inventory (current value)" value={inr(s.inventoryCurrentValue)} />
      </div>
    </div>
  );
}

export default function AccountingPeriods() {
  const { data: locks = [], isLoading } = usePeriodLocks();
  const { data: events = [] } = usePeriodLockEvents(100);
  const lockMutation = useLockPeriod();
  const unlockMutation = useUnlockPeriod();

  const now = new Date();
  const [fyStartYear, setFyStartYear] = useState(() =>
    now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1);

  const [lockTarget, setLockTarget] = useState<Ym | null>(null);
  const [unlockTarget, setUnlockTarget] = useState<Ym | null>(null);
  const [viewTarget, setViewTarget] = useState<Ym | null>(null);
  const [unlockReason, setUnlockReason] = useState('');

  const lockIndex = useMemo(() => {
    const m = new Map<string, PeriodLock>();
    for (const l of locks) m.set(`${l.year}-${l.month}`, l);
    return m;
  }, [locks]);

  // Indian FY: April (fyStartYear) → March (fyStartYear+1).
  const months: Ym[] = useMemo(() =>
    Array.from({ length: 12 }, (_, i) => {
      const m = 4 + i;
      return m <= 12 ? { year: fyStartYear, month: m } : { year: fyStartYear + 1, month: m - 12 };
    }), [fyStartYear]);

  const isFuture = (ym: Ym) =>
    ym.year > now.getFullYear() || (ym.year === now.getFullYear() && ym.month > now.getMonth() + 1);
  const isCurrent = (ym: Ym) =>
    ym.year === now.getFullYear() && ym.month === now.getMonth() + 1;

  const doLock = () => {
    if (!lockTarget) return;
    lockMutation.mutate(lockTarget, {
      onSuccess: () => {
        toast.success(`${MONTH_NAMES[lockTarget.month - 1]} ${lockTarget.year} is now locked.`);
        setLockTarget(null);
      },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed to lock the month'),
    });
  };

  const doUnlock = () => {
    if (!unlockTarget) return;
    const reason = unlockReason.trim();
    if (!reason) { toast.error('Please enter the reason for unlocking.'); return; }
    unlockMutation.mutate({ ...unlockTarget, reason }, {
      onSuccess: () => {
        toast.success(`${MONTH_NAMES[unlockTarget.month - 1]} ${unlockTarget.year} is unlocked. Remember to lock it again after corrections.`);
        setUnlockTarget(null); setUnlockReason('');
      },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed to unlock the month'),
    });
  };

  return (
    <AppLayout>
      <div className="space-y-6 max-w-5xl">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold">Month Locking</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Locking a month freezes it completely — nothing in that month can be added, changed or deleted,
              and invoice numbers and B2B/B2C classification stay exactly as reported.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setFyStartYear(y => y - 1)}>
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <span className="text-sm font-medium tabular-nums">FY {fyStartYear}-{String((fyStartYear + 1) % 100).padStart(2, '0')}</span>
            <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setFyStartYear(y => y + 1)}>
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {months.map((ym) => {
            const lock = lockIndex.get(`${ym.year}-${ym.month}`);
            const future = isFuture(ym);
            return (
              <div key={`${ym.year}-${ym.month}`}
                   className={`rounded-lg border p-4 ${lock ? 'bg-muted/40' : ''} ${future ? 'opacity-50' : ''}`}>
                <div className="flex items-center justify-between">
                  <span className="font-medium">{MONTH_NAMES[ym.month - 1]} {ym.year}</span>
                  {lock ? (
                    <Badge variant="secondary" className="gap-1"><Lock className="w-3 h-3" /> Locked</Badge>
                  ) : future ? (
                    <Badge variant="outline">Upcoming</Badge>
                  ) : (
                    <Badge variant="outline" className="gap-1 text-green-700 border-green-300">
                      <LockOpen className="w-3 h-3" /> Open{isCurrent(ym) ? ' · current' : ''}
                    </Badge>
                  )}
                </div>
                {lock && (
                  <p className="text-xs text-muted-foreground mt-2">
                    Locked by {lock.lockedBy} on {new Date(lock.lockedAt).toLocaleDateString('en-IN')}
                  </p>
                )}
                <div className="flex gap-2 mt-3">
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs"
                          disabled={future} onClick={() => setViewTarget(ym)}>
                    Summary
                  </Button>
                  {lock ? (
                    <Button variant="outline" size="sm" className="h-7 px-2 text-xs"
                            onClick={() => { setUnlockTarget(ym); setUnlockReason(''); }}>
                      <LockOpen className="w-3 h-3 mr-1" /> Unlock
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" className="h-7 px-2 text-xs"
                            disabled={future} onClick={() => setLockTarget(ym)}>
                      <Lock className="w-3 h-3 mr-1" /> Lock
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {isLoading && <p className="text-sm text-muted-foreground">Loading lock status…</p>}

        {/* History */}
        <div>
          <h2 className="font-semibold text-lg flex items-center gap-2 mb-3">
            <History className="w-4 h-4" /> Lock &amp; Unlock History
          </h2>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No months have been locked or unlocked yet.</p>
          ) : (
            <div className="rounded-lg border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Month</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>By</TableHead>
                    <TableHead>Reason</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {events.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="whitespace-nowrap text-sm">
                        {new Date(e.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{e.monthLabel}</TableCell>
                      <TableCell>
                        {e.action === 'lock'
                          ? <Badge variant="secondary" className="gap-1"><Lock className="w-3 h-3" /> Locked</Badge>
                          : <Badge variant="outline" className="gap-1"><LockOpen className="w-3 h-3" /> Unlocked</Badge>}
                      </TableCell>
                      <TableCell>{e.username}</TableCell>
                      <TableCell className="text-sm text-muted-foreground max-w-[28rem]">{e.reason ?? '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </div>

      {/* Summary viewer */}
      <Dialog open={!!viewTarget} onOpenChange={(o) => { if (!o) setViewTarget(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {viewTarget ? `${MONTH_NAMES[viewTarget.month - 1]} ${viewTarget.year} — Summary` : ''}
            </DialogTitle>
          </DialogHeader>
          {viewTarget && <MonthSummary ym={viewTarget} />}
        </DialogContent>
      </Dialog>

      {/* Lock confirmation — summary + explicit warning */}
      <Dialog open={!!lockTarget} onOpenChange={(o) => { if (!o) setLockTarget(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock className="w-4 h-4" />
              {lockTarget ? `Lock ${MONTH_NAMES[lockTarget.month - 1]} ${lockTarget.year}?` : ''}
            </DialogTitle>
            <DialogDescription>Check the month's figures before locking.</DialogDescription>
          </DialogHeader>
          {lockTarget && <MonthSummary ym={lockTarget} />}
          <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm text-amber-900 dark:text-amber-200">
            <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{LOCK_WARNING}</span>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLockTarget(null)}>Cancel</Button>
            <Button onClick={doLock} disabled={lockMutation.isPending}>
              {lockMutation.isPending ? 'Locking…' : 'Yes, lock this month'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Unlock — reason required */}
      <Dialog open={!!unlockTarget} onOpenChange={(o) => { if (!o) setUnlockTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <LockOpen className="w-4 h-4" />
              {unlockTarget ? `Unlock ${MONTH_NAMES[unlockTarget.month - 1]} ${unlockTarget.year}?` : ''}
            </DialogTitle>
            <DialogDescription>
              Unlocking lets records of this month be changed again. The reason is recorded permanently
              in the audit history. Lock the month again once corrections are done.
            </DialogDescription>
          </DialogHeader>
          <div>
            <label className="text-sm font-medium">Reason for unlocking</label>
            <Textarea
              className="mt-1"
              placeholder="e.g. Correcting a wrongly-entered purchase bill dated 12th"
              value={unlockReason}
              onChange={(e) => setUnlockReason(e.target.value)}
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUnlockTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={doUnlock}
                    disabled={unlockMutation.isPending || !unlockReason.trim()}>
              {unlockMutation.isPending ? 'Unlocking…' : 'Unlock month'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
