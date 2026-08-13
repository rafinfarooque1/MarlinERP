import { useState, useRef, useMemo, Fragment } from 'react';
import {
  useListJournalVouchers, useCreateJournalVoucher, useDeleteJournalVoucher,
  useListAccountsFlat, type JournalVoucher,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { TransactionDialog, TransactionDialogContent } from '@/components/ui/transaction-dialog';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Plus, BookOpen, Trash2, Search, Calendar, AlertTriangle, ChevronDown, ChevronRight, Download, X, Sigma, FileStack,
} from 'lucide-react';
import { toast } from 'sonner';
import { downloadCSV } from '@/lib/download';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { usePermission } from '@/lib/usePermission';
import { AccountCombobox } from '@/components/ui/account-combobox';
import { entryScopeKeyDown, autoFocusFirst, focusField, focusAndOpen, useEntryShortcuts } from '@/lib/keyboard-entry';
import { useVoucherLocationChoice, parseLocKey, LocationSelectField } from '@/lib/voucherLocation';
import { PageHeader } from '@/components/app/page-header';
import { SummaryCard, SummaryCardGrid } from '@/components/app/summary-card';
import { EmptyState } from '@/components/app/empty-state';
import { TableSkeleton } from '@/components/app/loading-skeletons';
import { TablePager, useClientPage } from '@/components/ui/table-pager';
import { inr } from '@/lib/currency';

interface LineDraft { ledgerId: number; debit: string; credit: string }

const today = () => new Date().toISOString().split('T')[0];
const EMPTY_LINE: LineDraft = { ledgerId: 0, debit: '', credit: '' };

export default function Journal() {
  const perm = usePermission('page:/accounts/vouchers');
  const { data: vouchers = [], isLoading } = useListJournalVouchers({ type: 'journal' });
  const { data: allAccounts = [] } = useListAccountsFlat();
  const createMutation = useCreateJournalVoucher();
  const deleteMutation = useDeleteJournalVoucher();

  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<JournalVoucher | null>(null);

  // Entry form state (dynamic lines — react-hook-form is a poor fit here)
  const [voucherDate, setVoucherDate] = useState(today());
  const [narration, setNarration] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([{ ...EMPTY_LINE }, { ...EMPTY_LINE }]);

  // The selected location OWNS the voucher's accounting — an Admin recording
  // on behalf of a branch produces a branch voucher. Defaults to the global
  // location selector; ledgers owned by other locations are hidden.
  const { locations, locKey, setLocKey, foreignLedgerIds } = useVoucherLocationChoice();

  const ledgerOptions = (allAccounts as any[]).filter(a =>
    !a.isSystemGroup && !a.isGroup && !foreignLedgerIds.has(a.id));

  const totalDr = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const totalCr = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  const balanced = Math.abs(totalDr - totalCr) < 0.005 && totalDr > 0;

  // Anything typed into the entry dialog that would be lost on close.
  const entryDirty = narration !== '' || voucherDate !== today()
    || lines.length !== 2
    || lines.some(l => l.ledgerId > 0 || l.debit !== '' || l.credit !== '');

  const setLine = (i: number, patch: Partial<LineDraft>) =>
    setLines(prev => prev.map((l, idx) => {
      if (idx !== i) return l;
      const next = { ...l, ...patch };
      // A line is either debit or credit — typing one clears the other
      if (patch.debit !== undefined && Number(patch.debit) > 0) next.credit = '';
      if (patch.credit !== undefined && Number(patch.credit) > 0) next.debit = '';
      return next;
    }));

  const resetForm = () => {
    setVoucherDate(today());
    setNarration('');
    setLines([{ ...EMPTY_LINE }, { ...EMPTY_LINE }]);
  };

  // ── Keyboard Entry Mode ──
  const scopeRef = useRef<HTMLDivElement>(null);

  /** Append a row and drop the operator straight into its ledger search. */
  const addLine = () => {
    setLines(prev => {
      const nextIndex = prev.length;
      window.setTimeout(() => {
        focusAndOpen(scopeRef.current?.querySelector<HTMLElement>(
          `[data-testid="journal-line-ledger-${nextIndex}"]`,
        ));
      }, 0);
      return [...prev, { ...EMPTY_LINE }];
    });
  };

  const deleteLine = (i: number) => {
    if (lines.length <= 2) return; // a journal needs two legs
    setLines(prev => prev.filter((_, idx) => idx !== i));
  };

  // Catch Ctrl+S / Ctrl+Enter / F4 even when focus has wandered outside the form
  useEntryShortcuts(isOpen, {
    onSave: () => { if (!createMutation.isPending) submit(); },
    onAddLine: addLine,
  });

  const submit = () => {
    if (!voucherDate) { toast.error('Date is required'); focusField('voucherDate', scopeRef.current); return; }
    const clean = lines.filter(l => l.ledgerId > 0 || Number(l.debit) > 0 || Number(l.credit) > 0);
    if (clean.length < 2) {
      toast.error('Add at least two lines');
      focusField('journal-line-ledger-0', scopeRef.current);
      return;
    }
    const missingLedger = lines.findIndex(l => (Number(l.debit) > 0 || Number(l.credit) > 0) && !l.ledgerId);
    if (clean.some(l => !l.ledgerId)) {
      toast.error('Every line needs a ledger');
      focusField(`journal-line-ledger-${Math.max(missingLedger, 0)}`, scopeRef.current);
      return;
    }
    if (!balanced) {
      toast.error('Debits must equal credits');
      focusField('journal-line-debit-0', scopeRef.current);
      return;
    }
    const loc = parseLocKey(locKey);
    if (!loc) { toast.error('Please select a location.'); return; }
    createMutation.mutate({
      voucherType: 'journal',
      voucherDate,
      narration: narration.trim() || undefined,
      lines: clean.map(l => ({ ledgerId: l.ledgerId, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0 })),
      locationType: loc.locationType, locationId: loc.locationId,
    } as any, {
      onSuccess: (v) => { toast.success(`Journal ${v.voucherNumber} recorded`); setIsOpen(false); resetForm(); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  const handleDelete = () => {
    if (!deleteTarget) return;
    deleteMutation.mutate(deleteTarget.id, {
      onSuccess: () => { toast.success('Voucher deleted'); setDeleteTarget(null); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  const filtered = useMemo(() => (vouchers as JournalVoucher[]).filter(v =>
    v.voucherNumber?.toLowerCase().includes(search.toLowerCase()) ||
    v.narration?.toLowerCase().includes(search.toLowerCase()) ||
    v.lines.some(l => l.ledgerName.toLowerCase().includes(search.toLowerCase()))
  ), [vouchers, search]);

  const { sorted, sort } = useTableSort(filtered, {
    voucher: v => v.voucherNumber,
    date: v => v.voucherDate,
    narration: v => v.narration,
    amount: v => Number(v.totalAmount),
  });

  const total = useMemo(() => filtered.reduce((s, v) => s + Number(v.totalAmount), 0), [filtered]);

  const { pageRows, pagerProps } = useClientPage(sorted);

  if (!perm.isLoading && !perm.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center py-32 text-muted-foreground gap-3">
          <AlertTriangle className="w-10 h-10 text-destructive/50" />
          <p className="text-lg font-medium">Access Denied</p>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-6">
        <PageHeader
          title="Journal Vouchers"
          description="Adjustments, accruals and non-cash entries"
          icon={BookOpen}
          actions={
            <>
              {perm.canDownload && (
                <Button variant="outline" size="sm" onClick={() => downloadCSV('journal-vouchers.csv', filtered.flatMap(v => v.lines.map(l => ({
                  Voucher: v.voucherNumber, Date: v.voucherDate, Ledger: l.ledgerName,
                  Debit: l.debit, Credit: l.credit, Narration: v.narration || '',
                }))))}>
                  <Download className="w-4 h-4 mr-2" /> Export
                </Button>
              )}
              {perm.canAdd && (
                <Button onClick={() => { resetForm(); setIsOpen(true); }}>
                  <Plus className="w-4 h-4 mr-2" /> New Journal
                </Button>
              )}
            </>
          }
        />

        <SummaryCardGrid>
          <SummaryCard label="Journal Vouchers" value={filtered.length.toLocaleString('en-IN')} icon={FileStack} tone="info" loading={isLoading} />
          <SummaryCard label="Total Amount" value={inr(total)} icon={Sigma} tone="default" loading={isLoading} />
        </SummaryCardGrid>

        <div className="relative w-full sm:max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <Input placeholder="Search voucher, ledger or narration..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          {isLoading ? (
            <TableSkeleton rows={8} cols={6} />
          ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead className="w-8" />
                <SortableHead k="voucher" sort={sort}>Voucher #</SortableHead>
                <SortableHead k="date" sort={sort}>Date</SortableHead>
                <SortableHead k="narration" sort={sort}>Narration</SortableHead>
                <SortableHead k="amount" sort={sort} className="text-right">Amount</SortableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="p-0">
                  <EmptyState icon={BookOpen} title="No journal vouchers yet" hint="Adjustments, accruals and non-cash entries appear here." compact />
                </TableCell></TableRow>
              ) : pageRows.map(v => (
                <Fragment key={v.id}>
                  <TableRow className="hover:bg-muted/10 cursor-pointer" onClick={() => setExpanded(expanded === v.id ? null : v.id)}>
                    <TableCell className="pr-0">
                      {expanded === v.id ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
                    </TableCell>
                    <TableCell className="font-mono text-primary font-bold text-sm">{v.voucherNumber}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      <div className="flex items-center gap-1"><Calendar className="w-3 h-3" />{new Date(v.voucherDate).toLocaleDateString('en-IN')}</div>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm max-w-[280px] truncate">{v.narration || '—'}</TableCell>
                    <TableCell className="text-right font-mono font-bold">{inr(v.totalAmount)}</TableCell>
                    <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                      {perm.canDelete && (
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-destructive" onClick={() => setDeleteTarget(v)}>
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                  {expanded === v.id && (
                    <TableRow className="bg-muted/5 hover:bg-muted/5">
                      <TableCell colSpan={6} className="py-3">
                        <div className="ml-10 border border-border rounded-lg overflow-hidden max-w-2xl">
                          <table className="w-full text-sm">
                            <thead className="bg-muted/20 text-muted-foreground">
                              <tr>
                                <th className="text-left px-3 py-1.5 font-medium">Ledger</th>
                                <th className="text-right px-3 py-1.5 font-medium w-32">Debit</th>
                                <th className="text-right px-3 py-1.5 font-medium w-32">Credit</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                              {v.lines.map(l => (
                                <tr key={l.id}>
                                  <td className="px-3 py-1.5">{l.ledgerName}</td>
                                  <td className="px-3 py-1.5 text-right font-mono">{l.debit > 0 ? inr(l.debit) : ''}</td>
                                  <td className="px-3 py-1.5 text-right font-mono">{l.credit > 0 ? inr(l.credit) : ''}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
          )}
        </div>
        <TablePager {...pagerProps} />
      </div>

      {/* ── New Journal Dialog ── */}
      <TransactionDialog open={isOpen} dirty={entryDirty} onOpenChange={v => { setIsOpen(v); if (!v) resetForm(); }}>
        <TransactionDialogContent className="sm:max-w-2xl" onOpenAutoFocus={autoFocusFirst}>
          <DialogHeader><DialogTitle>New Journal Voucher</DialogTitle></DialogHeader>
          <div
            ref={scopeRef}
            data-kbd-scope
            onKeyDown={entryScopeKeyDown({
              onSave: () => { if (!createMutation.isPending) submit(); },
              onAddLine: addLine,
              onDeleteLine: deleteLine,
            })}
            className="space-y-4 pt-2"
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <LocationSelectField locations={locations} locKey={locKey} setLocKey={setLocKey} />
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Date <span className="text-destructive">*</span></label>
                <Input type="date" data-field="voucherDate" value={voucherDate} onChange={e => setVoucherDate(e.target.value)} />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Entries <span className="text-destructive">*</span></label>
              <div className="border border-border rounded-lg overflow-x-auto">
                <table className="w-full text-sm min-w-[480px]">
                  <thead className="bg-muted/20 text-muted-foreground">
                    <tr>
                      <th className="text-left px-2 py-1.5 font-medium">Ledger</th>
                      <th className="text-right px-2 py-1.5 font-medium w-28">Debit ₹</th>
                      <th className="text-right px-2 py-1.5 font-medium w-28">Credit ₹</th>
                      <th className="w-8" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {lines.map((l, i) => (
                      <tr key={i} data-kbd-row={i}>
                        <td className="px-2 py-1.5">
                          <AccountCombobox
                            options={ledgerOptions}
                            value={l.ledgerId}
                            onChange={id => setLine(i, { ledgerId: id })}
                            placeholder="Select ledger"
                            className="h-9"
                            advanceOnSelect
                            data-testid={`journal-line-ledger-${i}`}
                            data-field={`journal-line-ledger-${i}`}
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <Input type="number" min={0} step="0.01" className="h-9 text-right font-mono" value={l.debit}
                            data-field={`journal-line-debit-${i}`}
                            onChange={e => setLine(i, { debit: e.target.value })} />
                        </td>
                        <td className="px-2 py-1.5">
                          <Input type="number" min={0} step="0.01" className="h-9 text-right font-mono" value={l.credit}
                            data-last-field={i === lines.length - 1 ? '1' : undefined}
                            onChange={e => setLine(i, { credit: e.target.value })} />
                        </td>
                        <td className="px-1">
                          {lines.length > 2 && (
                            <Button variant="ghost" size="icon" tabIndex={-1} className="h-7 w-7 text-muted-foreground hover:text-destructive"
                              onClick={() => deleteLine(i)}>
                              <X className="w-3.5 h-3.5" />
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-muted/10 border-t border-border">
                    <tr className="font-mono text-sm">
                      <td className="px-3 py-2 font-sans font-medium text-muted-foreground">Totals</td>
                      <td className="px-2 py-2 text-right font-bold">{inr(totalDr)}</td>
                      <td className="px-2 py-2 text-right font-bold">{inr(totalCr)}</td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
              <div className="flex items-center justify-between">
                <Button variant="outline" size="sm" type="button" onClick={addLine} title="F4">
                  <Plus className="w-3.5 h-3.5 mr-1.5" /> Add Line
                </Button>
                {totalDr > 0 || totalCr > 0 ? (
                  balanced
                    ? <Badge className="bg-green-500/15 text-green-600 hover:bg-green-500/15 border-0">Balanced</Badge>
                    : <Badge variant="outline" className="text-destructive border-destructive/40">Difference: {inr(Math.abs(totalDr - totalCr))}</Badge>
                ) : null}
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium">Narration</label>
              <Textarea rows={2} placeholder="Why is this entry being made?" value={narration} onChange={e => setNarration(e.target.value)} />
            </div>

            <DialogFooter className="max-md:sticky max-md:bottom-0 max-md:z-20 max-md:-mx-4 max-md:px-4 max-md:py-2 max-md:bg-background/95 max-md:backdrop-blur max-md:border-t max-md:border-border">
              <DialogClose asChild><Button variant="outline" type="button">Cancel</Button></DialogClose>
              <Button onClick={submit} disabled={createMutation.isPending || !balanced}>
                {createMutation.isPending ? 'Recording…' : 'Record Journal'}
              </Button>
            </DialogFooter>
          </div>
        </TransactionDialogContent>
      </TransactionDialog>

      {/* ── Delete Confirmation ── */}
      <Dialog open={!!deleteTarget} onOpenChange={v => !v && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle className="text-destructive flex items-center gap-2"><Trash2 className="w-5 h-5" />Delete Journal Voucher</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground py-2">Delete voucher <span className="font-semibold text-foreground">{deleteTarget?.voucherNumber}</span> of {inr(Number(deleteTarget?.totalAmount || 0))}? This cannot be undone.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteMutation.isPending}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
