import { useState, useMemo, useEffect, Fragment } from 'react';
import {
  useListPayments, useCreatePayment, useDeletePayment, useUpdatePayment,
  useListReceipts, useCreateReceipt, useDeleteReceipt, useUpdateReceipt,
  useListJournalVouchers, useCreateJournalVoucher, useDeleteJournalVoucher, useUpdateJournalVoucher,
  useListAccountsFlat, useCashBankLedgersFlat,
  useListCustomers, useListVendors,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { TransactionDialog, TransactionDialogContent } from '@/components/ui/transaction-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Plus, Search, Trash2, ChevronDown, ChevronRight, Download, AlertTriangle,
  ArrowUpLeft, ArrowDownRight, BookOpen, ArrowLeftRight, FileMinus2, FilePlus2,
  ReceiptText, FileDown, Pencil, Lock,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip';

/** Shown when the server did not send a specific reason (older cached rows). */
const LOCKED_FALLBACK = 'This voucher was generated automatically by another module and cannot be edited here.';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { usePermission } from '@/lib/usePermission';
import { AccountCombobox } from '@/components/ui/account-combobox';
import { downloadCSV } from '@/lib/download';
import { useGetCompanySettings } from '@workspace/api-client-react';
import { downloadVoucherPDF } from '@/lib/pdfUtils';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { useVoucherLocationChoice, parseLocKey, LocationSelectField } from '@/lib/voucherLocation';
import { useIsAdmin } from '@/lib/useIsAdmin';
import { SystemReceiptDeleteDialog } from '@/components/accounts/SystemReceiptDeleteDialog';
import { PageHeader } from '@/components/app/page-header';
import { SummaryCard, SummaryCardGrid } from '@/components/app/summary-card';
import { EmptyState } from '@/components/app/empty-state';
import { TableSkeleton } from '@/components/app/loading-skeletons';
import { TablePager, useClientPage } from '@/components/ui/table-pager';
import { FileStack, Sigma } from 'lucide-react';

// ── Helpers ────────────────────────────────────────────────────────────────
const today = () => new Date().toISOString().split('T')[0];

import { isSystemLedger } from '@/lib/systemLedgers';
import { inr } from '@/lib/currency';

type VoucherType = 'payment' | 'receipt' | 'journal' | 'contra' | 'credit_note' | 'debit_note';

/** Types that can be created manually. Payment/Receipt are system-generated. */
const MANUAL_TYPES: VoucherType[] = ['journal', 'contra', 'credit_note', 'debit_note'];

const TYPE_META: Record<VoucherType, { label: string; short: string; icon: React.ElementType; color: string; bg: string }> = {
  payment:     { label: 'Payment',     short: 'PMT', icon: ArrowUpLeft,    color: 'text-red-600',    bg: 'bg-red-50 text-red-700 border-red-200' },
  receipt:     { label: 'Receipt',     short: 'REC', icon: ArrowDownRight, color: 'text-emerald-600', bg: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  journal:     { label: 'Journal',     short: 'JV',  icon: BookOpen,       color: 'text-blue-600',   bg: 'bg-blue-50 text-blue-700 border-blue-200' },
  contra:      { label: 'Contra',      short: 'CTR', icon: ArrowLeftRight, color: 'text-purple-600', bg: 'bg-purple-50 text-purple-700 border-purple-200' },
  credit_note: { label: 'Credit Note', short: 'CN',  icon: FileMinus2,     color: 'text-orange-600', bg: 'bg-orange-50 text-orange-700 border-orange-200' },
  debit_note:  { label: 'Debit Note',  short: 'DN',  icon: FilePlus2,      color: 'text-pink-600',   bg: 'bg-pink-50 text-pink-700 border-pink-200' },
};

interface UnifiedRow {
  key: string;
  id: number;
  type: VoucherType;
  voucherNumber: string;
  date: string;
  description: string;
  narration?: string;
  amount: number;
  raw: any;
}

function typeBadge(type: VoucherType) {
  const m = TYPE_META[type];
  return (
    <Badge variant="outline" className={`text-xs font-semibold ${m.bg}`}>
      {m.label}
    </Badge>
  );
}

// Voucher location choice — shared across every manual voucher entry form.
// Lives in lib/voucherLocation.tsx: which locations the caller may record
// under, the ledgers to hide for the selected one, and the picker field.

// ── Delete confirm ─────────────────────────────────────────────────────────
function DeleteConfirm({ row, onClose }: { row: UnifiedRow; onClose: () => void }) {
  const qc = useQueryClient();
  const delPayment = useDeletePayment();
  const delReceipt = useDeleteReceipt();
  const delJV      = useDeleteJournalVoucher();

  const handleDelete = () => {
    const onSuccess = () => { toast.success('Deleted'); qc.invalidateQueries(); onClose(); };
    const onError = (e: any) => toast.error(e?.data?.error || e.message || 'Failed');
    if (row.type === 'payment')  delPayment.mutate(row.id, { onSuccess, onError });
    else if (row.type === 'receipt') delReceipt.mutate(row.id, { onSuccess, onError });
    else delJV.mutate(row.id, { onSuccess, onError });
  };

  const isPending = delPayment.isPending || delReceipt.isPending || delJV.isPending;

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" /> Delete {TYPE_META[row.type].label}?
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          <strong>{row.voucherNumber}</strong> · {inr(row.amount)} · {row.date}<br />
          This will also reverse the accounting entry and cannot be undone.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" onClick={handleDelete} disabled={isPending}>Delete</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── New Voucher dialog ─────────────────────────────────────────────────────
function NewVoucherDialog({ onClose, defaultType }: { onClose: () => void; defaultType?: VoucherType }) {
  // Only manual types are allowed; fall back to journal if a system type is passed
  const safeDefault: VoucherType = defaultType && MANUAL_TYPES.includes(defaultType) ? defaultType : 'journal';
  const [type, setType] = useState<VoucherType>(safeDefault);
  const qc = useQueryClient();

  const { data: allAccounts = [] } = useListAccountsFlat();
  const { data: cashBank = [] }    = useCashBankLedgersFlat();
  const { data: customers = [] }   = useListCustomers();
  const { data: vendors = [] }     = useListVendors();

  // Mandatory location for the voucher; also narrows the account pickers to
  // ledgers the selected location may post through.
  const { locations, locKey, setLocKey, selLoc, foreignLedgerIds } = useVoucherLocationChoice();

  const allLedgers  = (allAccounts as any[]).filter(a =>
    !a.isGroup && !a.isSystemGroup && !isSystemLedger(a.code) && !foreignLedgerIds.has(a.id));
  const cashLedgers = (cashBank as any[]).filter(a =>
    !a.isGroup && !a.isSystemGroup && !isSystemLedger(a.code)
    && (!selLoc || selLoc.cashBankLedgerIds.includes(a.id)));

  const createPayment  = useCreatePayment();
  const createReceipt  = useCreateReceipt();
  const createJV       = useCreateJournalVoucher();

  // shared state
  const [date, setDate]       = useState(today());
  const [amount, setAmount]   = useState('');
  const [narration, setNarr]  = useState('');

  // payment / receipt
  const [fromId, setFromId]   = useState(0);
  const [toId, setToId]       = useState(0);

  // journal lines
  interface JLine { ledgerId: number; debit: string; credit: string }
  const [lines, setLines]     = useState<JLine[]>([{ ledgerId: 0, debit: '', credit: '' }, { ledgerId: 0, debit: '', credit: '' }]);
  const totalDr = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const totalCr = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  const balanced = Math.abs(totalDr - totalCr) < 0.005 && totalDr > 0;

  // credit/debit note
  const [partyId, setPartyId] = useState(0);
  const [counterLedgerId, setCtrId] = useState(0);
  const [reason, setReason]   = useState('');

  const invalidate = () => { qc.invalidateQueries(); onClose(); };
  const onErr = (e: any) => toast.error(e?.data?.error || e.message || 'Failed');

  const submit = () => {
    if (!date) { toast.error('Date required'); return; }
    const loc = parseLocKey(locKey);
    if (!loc) { toast.error('Please select a location.'); return; }

    if (type === 'payment') {
      if (!fromId || !toId) { toast.error('Select both accounts'); return; }
      if (!amount || Number(amount) <= 0) { toast.error('Enter amount'); return; }
      createPayment.mutate({ paymentDate: date, paidFromLedgerId: fromId, paidToLedgerId: toId, amount: Number(amount), narration, locationType: loc.locationType, locationId: loc.locationId } as any, {
        onSuccess: (v: any) => { toast.success(`Payment ${v.voucherNumber} recorded`); invalidate(); },
        onError: onErr,
      });
    } else if (type === 'receipt') {
      if (!fromId || !toId) { toast.error('Select both accounts'); return; }
      if (!amount || Number(amount) <= 0) { toast.error('Enter amount'); return; }
      createReceipt.mutate({ receiptDate: date, receivedFromLedgerId: fromId, receivedInLedgerId: toId, amount: Number(amount), narration, locationType: loc.locationType, locationId: loc.locationId } as any, {
        onSuccess: (v: any) => { toast.success(`Receipt ${v.voucherNumber} recorded`); invalidate(); },
        onError: onErr,
      });
    } else if (type === 'contra') {
      if (!fromId || !toId) { toast.error('Select both accounts'); return; }
      if (!amount || Number(amount) <= 0) { toast.error('Enter amount'); return; }
      // Backend derives the double-entry itself: Dr destination (toLedgerId),
      // Cr source (fromLedgerId). Send the contra contract, not journal lines.
      createJV.mutate({
        voucherType: 'contra', voucherDate: date, narration,
        fromLedgerId: fromId, toLedgerId: toId, amount: Number(amount),
        locationType: loc.locationType, locationId: loc.locationId,
      } as any, {
        onSuccess: (v: any) => { toast.success(`Contra ${v.voucherNumber} recorded`); invalidate(); },
        onError: onErr,
      });
    } else if (type === 'journal') {
      const clean = lines.filter(l => l.ledgerId > 0 || Number(l.debit) > 0 || Number(l.credit) > 0);
      if (clean.length < 2) { toast.error('Add at least two lines'); return; }
      if (clean.some(l => !l.ledgerId)) { toast.error('Every line needs a ledger'); return; }
      if (!balanced) { toast.error('Debits must equal credits'); return; }
      createJV.mutate({
        voucherType: 'journal', voucherDate: date, narration,
        lines: clean.map(l => ({ ledgerId: l.ledgerId, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0 })),
        locationType: loc.locationType, locationId: loc.locationId,
      } as any, {
        onSuccess: (v: any) => { toast.success(`Journal ${v.voucherNumber} recorded`); invalidate(); },
        onError: onErr,
      });
    } else {
      // credit_note / debit_note
      if (!partyId) { toast.error('Select party'); return; }
      if (!amount || Number(amount) <= 0) { toast.error('Enter amount'); return; }
      createJV.mutate({
        voucherType: type, voucherDate: date, narration,
        partyId, amount: Number(amount),
        counterLedgerId: counterLedgerId || undefined,
        reason,
        locationType: loc.locationType, locationId: loc.locationId,
      } as any, {
        onSuccess: (v: any) => { toast.success(`${TYPE_META[type].label} ${v.voucherNumber} recorded`); invalidate(); },
        onError: onErr,
      });
    }
  };

  const isPending = createPayment.isPending || createReceipt.isPending || createJV.isPending;

  const setLine = (i: number, patch: Partial<JLine>) =>
    setLines(prev => prev.map((l, idx) => {
      if (idx !== i) return l;
      const next = { ...l, ...patch };
      if (patch.debit !== undefined && Number(patch.debit) > 0) next.credit = '';
      if (patch.credit !== undefined && Number(patch.credit) > 0) next.debit = '';
      return next;
    }));

  // Anything typed that would be lost on close (type/location are choices,
  // not data entry — they don't count).
  const dirty = date !== today() || narration !== '' || amount !== '' || reason !== ''
    || fromId !== 0 || toId !== 0 || partyId !== 0 || counterLedgerId !== 0
    || lines.some(l => l.ledgerId > 0 || l.debit !== '' || l.credit !== '');

  return (
    <TransactionDialog open dirty={dirty} onOpenChange={o => { if (!o) onClose(); }}>
      <TransactionDialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ReceiptText className="h-5 w-5 text-primary" /> New Voucher
          </DialogTitle>
        </DialogHeader>

        {/* Type selector — only manually-creatable types */}
        <div className="space-y-1">
          <Label>Voucher Type</Label>
          <div className="flex flex-wrap gap-2">
            {MANUAL_TYPES.map(t => {
              const m = TYPE_META[t];
              const Icon = m.icon;
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => setType(t)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all ${
                    type === t ? m.bg + ' ring-1 ring-current' : 'border-border text-muted-foreground hover:border-primary/40'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>

        <Separator />

        {/* Location (always — every manual voucher belongs to one) */}
        <LocationSelectField locations={locations} locKey={locKey} setLocKey={setLocKey} />

        {/* Date (always) */}
        <div className="space-y-1">
          <Label>Date</Label>
          <Input type="date" value={date} onChange={e => setDate(e.target.value)} />
        </div>

        {/* Payment */}
        {type === 'payment' && (
          <>
            <div className="space-y-1">
              <Label>Paid From (Cash / Bank)</Label>
              <AccountCombobox options={cashLedgers} value={fromId} onChange={setFromId} placeholder="Select cash/bank account" />
            </div>
            <div className="space-y-1">
              <Label>Paid To</Label>
              <AccountCombobox options={allLedgers} value={toId} onChange={setToId} placeholder="Select ledger" />
            </div>
            <div className="space-y-1">
              <Label>Amount (₹)</Label>
              <Input type="number" min={0} value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" />
            </div>
          </>
        )}

        {/* Receipt */}
        {type === 'receipt' && (
          <>
            <div className="space-y-1">
              <Label>Received From</Label>
              <AccountCombobox options={allLedgers} value={fromId} onChange={setFromId} placeholder="Select ledger" />
            </div>
            <div className="space-y-1">
              <Label>Received In (Cash / Bank)</Label>
              <AccountCombobox options={cashLedgers} value={toId} onChange={setToId} placeholder="Select cash/bank account" />
            </div>
            <div className="space-y-1">
              <Label>Amount (₹)</Label>
              <Input type="number" min={0} value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" />
            </div>
          </>
        )}

        {/* Contra */}
        {type === 'contra' && (
          <>
            <div className="space-y-1">
              <Label>From Account</Label>
              <AccountCombobox options={cashLedgers} value={fromId} onChange={setFromId} placeholder="Select account" />
            </div>
            <div className="space-y-1">
              <Label>To Account</Label>
              <AccountCombobox options={cashLedgers} value={toId} onChange={v => { if (v !== fromId) setToId(v); }} placeholder="Select account" />
            </div>
            <div className="space-y-1">
              <Label>Amount (₹)</Label>
              <Input type="number" min={0} value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" />
            </div>
          </>
        )}

        {/* Journal */}
        {type === 'journal' && (
          <div className="space-y-3">
            <Label>Ledger Lines</Label>
            <div className="overflow-x-auto"><div className="space-y-2 min-w-[360px]">
              {lines.map((l, i) => (
                <div key={i} className="grid grid-cols-[1fr_100px_100px_24px] gap-2 items-center">
                  <AccountCombobox options={allLedgers} value={l.ledgerId} onChange={v => setLine(i, { ledgerId: v })} placeholder="Ledger" />
                  <Input type="number" min={0} placeholder="Dr" value={l.debit} onChange={e => setLine(i, { debit: e.target.value })} className="text-right" />
                  <Input type="number" min={0} placeholder="Cr" value={l.credit} onChange={e => setLine(i, { credit: e.target.value })} className="text-right" />
                  <button type="button" onClick={() => setLines(prev => prev.filter((_, idx) => idx !== i))} className="text-muted-foreground hover:text-destructive">×</button>
                </div>
              ))}
            </div></div>
            <Button type="button" variant="outline" size="sm" onClick={() => setLines(p => [...p, { ledgerId: 0, debit: '', credit: '' }])}>
              <Plus className="h-3 w-3 mr-1" />Add Line
            </Button>
            <div className={`text-xs text-right font-mono ${balanced ? 'text-emerald-600' : 'text-red-500'}`}>
              Dr {inr(totalDr)} | Cr {inr(totalCr)} {balanced ? '✓ Balanced' : '⚠ Unbalanced'}
            </div>
          </div>
        )}

        {/* Credit / Debit Note */}
        {(type === 'credit_note' || type === 'debit_note') && (
          <>
            <div className="space-y-1">
              <Label>{type === 'credit_note' ? 'Customer' : 'Vendor'}</Label>
              <Select value={String(partyId || '')} onValueChange={v => setPartyId(Number(v))}>
                <SelectTrigger><SelectValue placeholder="Select party" /></SelectTrigger>
                <SelectContent>
                  {((type === 'credit_note' ? customers : vendors) as any[]).map((p: any) => (
                    <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Amount (₹)</Label>
              <Input type="number" min={0} value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" />
            </div>
            <div className="space-y-1">
              <Label>Counter Ledger (optional)</Label>
              <AccountCombobox options={allLedgers} value={counterLedgerId} onChange={setCtrId} placeholder="Select ledger (optional)" />
            </div>
            <div className="space-y-1">
              <Label>Reason</Label>
              <Input value={reason} onChange={e => setReason(e.target.value)} placeholder="Return, discount, etc." />
            </div>
          </>
        )}

        {/* Narration (all types except journal which has its own) */}
        {type !== 'journal' && (
          <div className="space-y-1">
            <Label>Narration (optional)</Label>
            <Textarea value={narration} onChange={e => setNarr(e.target.value)} rows={2} placeholder="Add a note…" />
          </div>
        )}
        {type === 'journal' && (
          <div className="space-y-1">
            <Label>Narration (optional)</Label>
            <Textarea value={narration} onChange={e => setNarr(e.target.value)} rows={2} placeholder="Add a note…" />
          </div>
        )}

        <DialogFooter>
          <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
          <Button onClick={submit} disabled={isPending}>Save Voucher</Button>
        </DialogFooter>
      </TransactionDialogContent>
    </TransactionDialog>
  );
}

// ── Edit Voucher dialog (manually created vouchers only) ───────────────────
/**
 * Only ever opened for a voucher the SERVER marked editable. The same rule is
 * re-checked on save, so this dialog is a convenience, not the gate — a
 * system-generated voucher stays protected even if the button were forced.
 *
 * The voucher's type and number are fixed: the number is preserved so every
 * existing reference to it keeps pointing at the same entry, and the type is
 * implied by that number's prefix.
 */
function EditVoucherDialog({ row, onClose }: { row: UnifiedRow; onClose: () => void }) {
  const qc = useQueryClient();
  const v = row.raw ?? {};
  const type = row.type as 'journal' | 'contra' | 'credit_note' | 'debit_note';

  const { data: allAccounts = [] } = useListAccountsFlat();
  const { data: cashBank = [] }    = useCashBankLedgersFlat();
  const { data: customers = [] }   = useListCustomers();
  const { data: vendors = [] }     = useListVendors();

  // Prefilled with the voucher's stored location; changing it moves the
  // entry (and all its postings) between location books.
  const { locations, locKey, setLocKey, selLoc, foreignLedgerIds } = useVoucherLocationChoice({
    locationType: v.locationType, locationId: v.locationId,
  });

  const allLedgers  = (allAccounts as any[]).filter(a =>
    !a.isGroup && !a.isSystemGroup && !isSystemLedger(a.code) && !foreignLedgerIds.has(a.id));
  const cashLedgers = (cashBank as any[]).filter(a =>
    !a.isGroup && !a.isSystemGroup && !isSystemLedger(a.code)
    && (!selLoc || selLoc.cashBankLedgerIds.includes(a.id)));

  const updateJV = useUpdateJournalVoucher();

  const existing: any[] = v.lines ?? [];
  const drLine = existing.find((l: any) => Number(l.debit) > 0);
  const crLine = existing.find((l: any) => Number(l.credit) > 0);

  const [date, setDate]      = useState<string>((v.voucherDate ?? '').slice(0, 10));
  const [narration, setNarr] = useState<string>(v.narration ?? '');
  const [reason, setReason]  = useState<string>(v.reason ?? '');
  const [amount, setAmount]  = useState<string>(String(Number(v.totalAmount ?? 0) || ''));

  // contra
  const [fromId, setFromId] = useState<number>(crLine?.ledgerId ?? 0);
  const [toId, setToId]     = useState<number>(drLine?.ledgerId ?? 0);

  // journal lines, prefilled from the stored entry
  interface JLine { ledgerId: number; debit: string; credit: string }
  const [lines, setLines] = useState<JLine[]>(() =>
    existing.length
      ? existing.map((l: any) => ({
          ledgerId: l.ledgerId,
          debit:  Number(l.debit)  > 0 ? String(Number(l.debit))  : '',
          credit: Number(l.credit) > 0 ? String(Number(l.credit)) : '',
        }))
      : [{ ledgerId: 0, debit: '', credit: '' }, { ledgerId: 0, debit: '', credit: '' }],
  );
  const totalDr = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const totalCr = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  const balanced = Math.abs(totalDr - totalCr) < 0.005 && totalDr > 0;

  // credit / debit note. A credit note is Dr counter / Cr party; a debit note
  // is the mirror — so the counter ledger sits on the opposite side each time.
  const [partyId, setPartyId] = useState<number>(v.partyId ?? 0);
  const [counterLedgerId, setCtrId] = useState<number>(
    (type === 'credit_note' ? drLine?.ledgerId : crLine?.ledgerId) ?? 0,
  );

  const setLine = (i: number, patch: Partial<JLine>) =>
    setLines(prev => prev.map((l, idx) => {
      if (idx !== i) return l;
      const next = { ...l, ...patch };
      if (patch.debit !== undefined && Number(patch.debit) > 0) next.credit = '';
      if (patch.credit !== undefined && Number(patch.credit) > 0) next.debit = '';
      return next;
    }));

  const onErr = (e: any) => toast.error(e?.data?.error || e.message || 'Could not save the changes');
  const onOk = () => { toast.success(`${row.voucherNumber} updated`); qc.invalidateQueries(); onClose(); };

  const submit = () => {
    if (!date) { toast.error('Date required'); return; }
    if (!v.rev) { toast.error('Reload the page and try again'); return; }
    const loc = parseLocKey(locKey);
    if (!loc) { toast.error('Please select a location.'); return; }

    const base = {
      id: row.id, expectedRev: String(v.rev), voucherDate: date, narration,
      locationType: loc.locationType, locationId: loc.locationId,
    };

    if (type === 'journal') {
      const clean = lines.filter(l => l.ledgerId > 0 || Number(l.debit) > 0 || Number(l.credit) > 0);
      if (clean.length < 2) { toast.error('A journal needs at least two lines'); return; }
      if (clean.some(l => !l.ledgerId)) { toast.error('Every line needs a ledger'); return; }
      if (!balanced) { toast.error(`Debits must equal credits — Dr ${inr(totalDr)} vs Cr ${inr(totalCr)}`); return; }
      updateJV.mutate({
        ...base,
        lines: clean.map(l => ({ ledgerId: l.ledgerId, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0 })),
      } as any, { onSuccess: onOk, onError: onErr });
    } else if (type === 'contra') {
      if (!fromId || !toId) { toast.error('Select both accounts'); return; }
      if (fromId === toId) { toast.error('From and To must be different accounts'); return; }
      if (!(Number(amount) > 0)) { toast.error('Enter an amount'); return; }
      updateJV.mutate({ ...base, fromLedgerId: fromId, toLedgerId: toId, amount: Number(amount) } as any,
        { onSuccess: onOk, onError: onErr });
    } else {
      if (!partyId) { toast.error(`Select a ${type === 'credit_note' ? 'customer' : 'vendor'}`); return; }
      if (!(Number(amount) > 0)) { toast.error('Enter an amount'); return; }
      updateJV.mutate({
        ...base, partyId, amount: Number(amount),
        counterLedgerId: counterLedgerId || undefined, reason,
      } as any, { onSuccess: onOk, onError: onErr });
    }
  };

  const meta = TYPE_META[type];
  const Icon = meta.icon;

  // Compare every field with the value it was initialized from — the voucher
  // as stored. Only a real difference arms the unsaved-changes guard.
  const initialLines: JLine[] = existing.length
    ? existing.map((l: any) => ({
        ledgerId: l.ledgerId,
        debit:  Number(l.debit)  > 0 ? String(Number(l.debit))  : '',
        credit: Number(l.credit) > 0 ? String(Number(l.credit)) : '',
      }))
    : [{ ledgerId: 0, debit: '', credit: '' }, { ledgerId: 0, debit: '', credit: '' }];
  const dirty = date !== (v.voucherDate ?? '').slice(0, 10)
    || narration !== (v.narration ?? '')
    || reason !== (v.reason ?? '')
    || amount !== String(Number(v.totalAmount ?? 0) || '')
    || fromId !== (crLine?.ledgerId ?? 0)
    || toId !== (drLine?.ledgerId ?? 0)
    || partyId !== (v.partyId ?? 0)
    || counterLedgerId !== ((type === 'credit_note' ? drLine?.ledgerId : crLine?.ledgerId) ?? 0)
    || (v.locationType ? locKey !== `${v.locationType}:${v.locationId ?? 0}` : false)
    || JSON.stringify(lines) !== JSON.stringify(initialLines);

  return (
    <TransactionDialog open dirty={dirty} onOpenChange={o => { if (!o) onClose(); }}>
      <TransactionDialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="h-5 w-5 text-primary" /> Edit Voucher
          </DialogTitle>
        </DialogHeader>

        <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold ${meta.bg}`}>
          <Icon className="h-3.5 w-3.5" />
          {meta.label}
          <span className="font-mono ml-auto">{row.voucherNumber}</span>
        </div>
        <p className="text-xs text-muted-foreground -mt-1">
          The voucher number and type stay as they are — this updates the existing entry rather than
          creating a new one, so the books follow the change.
        </p>

        <Separator />

        <LocationSelectField locations={locations} locKey={locKey} setLocKey={setLocKey} />

        <div className="space-y-1">
          <Label>Date</Label>
          <Input type="date" value={date} onChange={e => setDate(e.target.value)} />
        </div>

        {type === 'contra' && (
          <>
            <div className="space-y-1">
              <Label>From Account</Label>
              <AccountCombobox options={cashLedgers} value={fromId} onChange={setFromId} placeholder="Select account" />
            </div>
            <div className="space-y-1">
              <Label>To Account</Label>
              <AccountCombobox options={cashLedgers} value={toId} onChange={val => { if (val !== fromId) setToId(val); }} placeholder="Select account" />
            </div>
            <div className="space-y-1">
              <Label>Amount (₹)</Label>
              <Input type="number" min={0} value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" />
            </div>
          </>
        )}

        {type === 'journal' && (
          <div className="space-y-3">
            <Label>Ledger Lines</Label>
            <div className="overflow-x-auto"><div className="space-y-2 min-w-[360px]">
              {lines.map((l, i) => (
                <div key={i} className="grid grid-cols-[1fr_100px_100px_24px] gap-2 items-center">
                  <AccountCombobox options={allLedgers} value={l.ledgerId} onChange={val => setLine(i, { ledgerId: val })} placeholder="Ledger" />
                  <Input type="number" min={0} placeholder="Dr" value={l.debit} onChange={e => setLine(i, { debit: e.target.value })} className="text-right" />
                  <Input type="number" min={0} placeholder="Cr" value={l.credit} onChange={e => setLine(i, { credit: e.target.value })} className="text-right" />
                  <button type="button" onClick={() => setLines(prev => prev.filter((_, idx) => idx !== i))} className="text-muted-foreground hover:text-destructive">×</button>
                </div>
              ))}
            </div></div>
            <Button type="button" variant="outline" size="sm" onClick={() => setLines(p => [...p, { ledgerId: 0, debit: '', credit: '' }])}>
              <Plus className="h-3 w-3 mr-1" />Add Line
            </Button>
            <div className={`text-xs text-right font-mono ${balanced ? 'text-emerald-600' : 'text-red-500'}`}>
              Dr {inr(totalDr)} | Cr {inr(totalCr)} {balanced ? '✓ Balanced' : '⚠ Unbalanced'}
            </div>
          </div>
        )}

        {(type === 'credit_note' || type === 'debit_note') && (
          <>
            <div className="space-y-1">
              <Label>{type === 'credit_note' ? 'Customer' : 'Vendor'}</Label>
              <Select value={String(partyId || '')} onValueChange={val => setPartyId(Number(val))}>
                <SelectTrigger><SelectValue placeholder="Select party" /></SelectTrigger>
                <SelectContent>
                  {((type === 'credit_note' ? customers : vendors) as any[]).map((p: any) => (
                    <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Amount (₹)</Label>
              <Input type="number" min={0} value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" />
            </div>
            <div className="space-y-1">
              <Label>Counter Ledger (optional)</Label>
              <AccountCombobox options={allLedgers} value={counterLedgerId} onChange={setCtrId} placeholder="Select ledger (optional)" />
            </div>
            <div className="space-y-1">
              <Label>Reason</Label>
              <Input value={reason} onChange={e => setReason(e.target.value)} placeholder="Return, discount, etc." />
            </div>
          </>
        )}

        <div className="space-y-1">
          <Label>Narration (optional)</Label>
          <Textarea value={narration} onChange={e => setNarr(e.target.value)} rows={2} placeholder="Add a note…" />
        </div>

        <DialogFooter>
          <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
          <Button
            onClick={submit}
            disabled={updateJV.isPending || (type === 'journal' && !balanced)}
          >
            {updateJV.isPending ? 'Saving…' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </TransactionDialogContent>
    </TransactionDialog>
  );
}

// ── Edit Payment / Receipt dialog ───────────────────────────────────────────
/**
 * Manual money vouchers only — like EditVoucherDialog, this is only reachable
 * for rows the SERVER marked `editable`, and the API re-checks the system
 * locks on save, so a sale-settlement receipt or an expense payment stays
 * protected even if the button were forced. The voucher number never changes.
 */
function EditMoneyVoucherDialog({ row, onClose }: { row: UnifiedRow; onClose: () => void }) {
  const qc = useQueryClient();
  const v = row.raw ?? {};
  const isPayment = row.type === 'payment';

  const { data: allAccounts = [] } = useListAccountsFlat();
  const { data: cashBank = [] }    = useCashBankLedgersFlat();

  // Prefilled with the voucher's stored location; changing it moves the money
  // entry between location books, and the pickers narrow to that location's
  // own cash/bank accounts — the same rule the server re-checks on save.
  const { locations, locKey, setLocKey, selLoc, foreignLedgerIds } = useVoucherLocationChoice({
    locationType: v.locationType, locationId: v.locationId,
  });

  const allLedgers  = (allAccounts as any[]).filter(a =>
    !a.isGroup && !a.isSystemGroup && !isSystemLedger(a.code) && !foreignLedgerIds.has(a.id));
  const cashLedgers = (cashBank as any[]).filter(a =>
    !a.isGroup && !a.isSystemGroup && !isSystemLedger(a.code)
    && (!selLoc || selLoc.cashBankLedgerIds.includes(a.id)));

  const updatePayment = useUpdatePayment();
  const updateReceipt = useUpdateReceipt();

  const [date, setDate]   = useState<string>(String((isPayment ? v.paymentDate : v.receiptDate) ?? '').slice(0, 10));
  const [fromId, setFromId] = useState<number>(isPayment ? (v.paidFromLedgerId ?? 0) : (v.receivedFromLedgerId ?? 0));
  const [toId, setToId]     = useState<number>(isPayment ? (v.paidToLedgerId ?? 0) : (v.receivedInLedgerId ?? 0));
  const [amount, setAmount] = useState<string>(String(Number(v.amount ?? 0) || ''));
  const [refNo, setRefNo]   = useState<string>(v.referenceNumber ?? '');
  const [narration, setNarr] = useState<string>(v.narration ?? '');

  // Compare with the stored voucher — only a real change arms the guard.
  const dirty = date !== String((isPayment ? v.paymentDate : v.receiptDate) ?? '').slice(0, 10)
    || fromId !== (isPayment ? (v.paidFromLedgerId ?? 0) : (v.receivedFromLedgerId ?? 0))
    || toId !== (isPayment ? (v.paidToLedgerId ?? 0) : (v.receivedInLedgerId ?? 0))
    || amount !== String(Number(v.amount ?? 0) || '')
    || refNo !== (v.referenceNumber ?? '')
    || narration !== (v.narration ?? '')
    || (v.locationType ? locKey !== `${v.locationType}:${v.locationId ?? 0}` : false);

  const onErr = (e: any) => toast.error(e?.data?.error || e.message || 'Could not save the changes');
  const onOk  = () => { toast.success(`${row.voucherNumber} updated`); qc.invalidateQueries(); onClose(); };

  const submit = () => {
    if (!date) { toast.error('Date required'); return; }
    if (!fromId || !toId) { toast.error('Select both accounts'); return; }
    if (fromId === toId) { toast.error('The two accounts must be different'); return; }
    if (!(Number(amount) > 0)) { toast.error('Enter an amount'); return; }
    const loc = parseLocKey(locKey);
    if (!loc) { toast.error('Please select a location.'); return; }

    if (isPayment) {
      updatePayment.mutate({
        id: row.id, paymentDate: date, paidFromLedgerId: fromId, paidToLedgerId: toId,
        amount: Number(amount),
        referenceNumber: refNo || null, narration,
        locationType: loc.locationType, locationId: loc.locationId,
      } as any, { onSuccess: onOk, onError: onErr });
    } else {
      updateReceipt.mutate({
        id: row.id, receiptDate: date, receivedFromLedgerId: fromId, receivedInLedgerId: toId,
        amount: Number(amount),
        referenceNumber: refNo || null, narration,
        locationType: loc.locationType, locationId: loc.locationId,
      } as any, { onSuccess: onOk, onError: onErr });
    }
  };

  const meta = TYPE_META[row.type];
  const Icon = meta.icon;
  const isPending = updatePayment.isPending || updateReceipt.isPending;

  return (
    <TransactionDialog open dirty={dirty} onOpenChange={o => { if (!o) onClose(); }}>
      <TransactionDialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="h-5 w-5 text-primary" /> Edit {meta.label} Voucher
          </DialogTitle>
        </DialogHeader>

        <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold ${meta.bg}`}>
          <Icon className="h-3.5 w-3.5" />
          {meta.label}
          <span className="font-mono ml-auto">{row.voucherNumber}</span>
        </div>
        <p className="text-xs text-muted-foreground -mt-1">
          The voucher number stays as it is — this updates the existing entry, and the books follow the change.
        </p>

        <Separator />

        <LocationSelectField locations={locations} locKey={locKey} setLocKey={setLocKey} />

        <div className="space-y-1">
          <Label>Date</Label>
          <Input type="date" value={date} onChange={e => setDate(e.target.value)} />
        </div>

        <div className="space-y-1">
          <Label>{isPayment ? 'Paid From (Cash / Bank)' : 'Received From'}</Label>
          <AccountCombobox
            options={isPayment ? cashLedgers : allLedgers}
            value={fromId} onChange={setFromId}
            placeholder={isPayment ? 'Select cash/bank account' : 'Select ledger'}
          />
        </div>
        <div className="space-y-1">
          <Label>{isPayment ? 'Paid To' : 'Received In (Cash / Bank)'}</Label>
          <AccountCombobox
            options={isPayment ? allLedgers : cashLedgers}
            value={toId} onChange={setToId}
            placeholder={isPayment ? 'Select ledger' : 'Select cash/bank account'}
          />
        </div>

        <div className="space-y-1">
          <Label>Amount (₹)</Label>
          <Input type="number" min={0} step="0.01" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" />
        </div>

        <div className="space-y-1">
          <Label>Reference #</Label>
          <Input value={refNo} onChange={e => setRefNo(e.target.value)} placeholder="Cheque / UTR / Txn no." />
        </div>

        <div className="space-y-1">
          <Label>Narration (optional)</Label>
          <Textarea value={narration} onChange={e => setNarr(e.target.value)} rows={2} placeholder="Add a note…" />
        </div>

        <DialogFooter>
          <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
          <Button onClick={submit} disabled={isPending}>
            {isPending ? 'Saving…' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </TransactionDialogContent>
    </TransactionDialog>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────
export default function Vouchers() {
  const perm       = usePermission('page:/accounts/vouchers');
  const permPay    = usePermission('page:/accounts/vouchers');

  const { data: payments = [],   isLoading: l1 } = useListPayments();
  const { data: receipts = [],   isLoading: l2 } = useListReceipts();
  const { data: journals = [],   isLoading: l3 } = useListJournalVouchers({ type: 'journal' });
  const { data: contras = [],    isLoading: l4 } = useListJournalVouchers({ type: 'contra' });
  const { data: creditNotes = [], isLoading: l5 } = useListJournalVouchers({ type: 'credit_note' });
  const { data: debitNotes = [],  isLoading: l6 } = useListJournalVouchers({ type: 'debit_note' });

  const isLoading = l1 || l2 || l3 || l4 || l5 || l6;

  const { data: cs } = useGetCompanySettings();

  const [search, setSearch]       = useState('');
  const [fromDate, setFromDate]   = useState('');
  const [toDate, setToDate]       = useState('');
  const [typeFilter, setTypeFilter] = useState<VoucherType | 'all'>('all');
  const [expanded, setExpanded]   = useState<string | null>(null);
  const [deleteRow, setDeleteRow] = useState<UnifiedRow | null>(null);
  const [editRow, setEditRow]     = useState<UnifiedRow | null>(null);
  // Admin-only system receipt deletion — server flags qualifying rows.
  const [sysDeleteId, setSysDeleteId] = useState<number | null>(null);
  const [newOpen, setNewOpen]     = useState(false);
  const [newType, setNewType]     = useState<VoucherType>('payment');

  // Merge all sources into a unified list
  const all = useMemo<UnifiedRow[]>(() => {
    const rows: UnifiedRow[] = [];

    for (const p of payments as any[]) rows.push({
      key: `pay-${p.id}`, id: p.id, type: 'payment',
      voucherNumber: p.voucherNumber || `PMT-${p.id}`,
      date: p.paymentDate?.split('T')[0] ?? p.paymentDate,
      description: `${p.paidFromName || '—'} → ${p.paidToName || '—'}`,
      narration: p.narration, amount: Number(p.amount), raw: p,
    });

    for (const r of receipts as any[]) rows.push({
      key: `rec-${r.id}`, id: r.id, type: 'receipt',
      voucherNumber: r.voucherNumber || `REC-${r.id}`,
      date: r.receiptDate?.split('T')[0] ?? r.receiptDate,
      description: `${r.receivedFromName || '—'} → ${r.receivedInName || '—'}`,
      narration: r.narration, amount: Number(r.amount), raw: r,
    });

    const jvSources: [any[], VoucherType][] = [
      [journals as any[], 'journal'],
      [contras as any[],  'contra'],
      [creditNotes as any[], 'credit_note'],
      [debitNotes as any[],  'debit_note'],
    ];
    for (const [list, t] of jvSources) {
      for (const v of list) {
        const lines: any[] = v.lines ?? [];
        const debits = lines.filter((l: any) => Number(l.debit) > 0).map((l: any) => l.ledgerName).join(', ');
        const credits = lines.filter((l: any) => Number(l.credit) > 0).map((l: any) => l.ledgerName).join(', ');
        rows.push({
          key: `jv-${t}-${v.id}`, id: v.id, type: t,
          voucherNumber: v.voucherNumber || `${TYPE_META[t].short}-${v.id}`,
          date: v.voucherDate?.split('T')[0] ?? v.voucherDate,
          description: debits && credits ? `${debits} / ${credits}` : (v.narration || '—'),
          narration: v.narration, amount: Number(v.totalAmount), raw: v,
        });
      }
    }

    return rows.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || b.id - a.id);
  }, [payments, receipts, journals, contras, creditNotes, debitNotes]);

  // Books drill-down: /accounts/vouchers?kind=<type>&view=<id> focuses that
  // voucher — the type filter narrows to its family, the search box pins its
  // number (the row IS the detail view here), and a JV expands its legs.
  const [drill, setDrill] = useState<{ kind: VoucherType; id: number } | null>(() => {
    const sp = new URLSearchParams(window.location.search);
    const kind = sp.get('kind') as VoucherType | null;
    const id = Number(sp.get('view'));
    const valid: VoucherType[] = ['payment', 'receipt', 'journal', 'contra', 'credit_note', 'debit_note'];
    return kind && valid.includes(kind) && Number.isFinite(id) && id > 0 ? { kind, id } : null;
  });
  useEffect(() => {
    if (!drill || isLoading) return;
    const row = all.find(r => r.type === drill.kind && r.id === drill.id);
    setDrill(null);
    window.history.replaceState({}, '', window.location.pathname);
    if (!row) {
      toast.error('Voucher not found — it may have been deleted');
      return;
    }
    setTypeFilter(drill.kind);
    setSearch(row.voucherNumber);
    if (!['payment', 'receipt'].includes(row.type) && (row.raw?.lines?.length ?? 0) > 0) {
      setExpanded(row.key);
    }
  }, [drill, isLoading, all]);

  const filtered = useMemo(() => {
    let list = typeFilter === 'all' ? all : all.filter(r => r.type === typeFilter);
    // Row dates are YYYY-MM-DD, so plain string comparison is date comparison.
    if (fromDate) list = list.filter(r => (r.date ?? '') >= fromDate);
    if (toDate)   list = list.filter(r => (r.date ?? '') <= toDate);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(r =>
        r.voucherNumber.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q) ||
        (r.narration ?? '').toLowerCase().includes(q)
      );
    }
    return list;
  }, [all, typeFilter, search, fromDate, toDate]);

  const { sorted, sort } = useTableSort(filtered, {
    type: r => TYPE_META[r.type].label,
    voucher: r => r.voucherNumber,
    date: r => r.date,
    description: r => r.description,
    narration: r => r.narration,
    amount: r => Number(r.amount),
  });

  const total = useMemo(() => filtered.reduce((s, r) => s + r.amount, 0), [filtered]);

  const { pageRows, pagerProps } = useClientPage(sorted);

  const canView = perm.canView || permPay.canView;
  const canAdd  = perm.canAdd  || permPay.canAdd;
  // Voucher deletion is Administrator-only (the API 403s everyone else);
  // view/edit/download/print keep the page's role permissions.
  const isAdmin = useIsAdmin();
  const canDel  = perm.canDelete || permPay.canDelete;
  const canEdit = perm.canEdit || permPay.canEdit;
  const canDownload = perm.canDownload || permPay.canDownload;

  const handleExport = () => {
    downloadCSV('vouchers.csv', filtered.map(r => ({
      Voucher: r.voucherNumber, Type: TYPE_META[r.type].label,
      Date: r.date, Description: r.description,
      Reference: r.raw?.referenceNumber || '',
      Narration: r.narration || '', Amount: r.amount,
    })));
    toast.success('Exported');
  };

  if (!perm.isLoading && !canView) {
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
      <div className="space-y-5">
        <PageHeader
          title="Vouchers"
          description="All accounting vouchers in one place"
          icon={ReceiptText}
          actions={
            <>
              {canDownload && (
                <Button variant="outline" size="sm" onClick={handleExport}>
                  <Download className="w-4 h-4 mr-1" /> Export
                </Button>
              )}
              {canAdd && (
                <Button onClick={() => { setNewType('payment'); setNewOpen(true); }}>
                  <Plus className="w-4 h-4 mr-1" /> New Voucher
                </Button>
              )}
            </>
          }
        />

        <SummaryCardGrid>
          <SummaryCard label="Vouchers" value={filtered.length.toLocaleString('en-IN')} icon={FileStack} tone="info" loading={isLoading} />
          <SummaryCard label="Total Amount" value={inr(total)} icon={Sigma} tone="default" loading={isLoading} />
        </SummaryCardGrid>

        {/* Type filter pills */}
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => setTypeFilter('all')}
            className={`px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all ${
              typeFilter === 'all'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'border-border text-muted-foreground hover:border-primary/40'
            }`}
          >
            All ({all.length})
          </button>
          {(Object.keys(TYPE_META) as VoucherType[]).map(t => {
            const m = TYPE_META[t];
            const Icon = m.icon;
            const count = all.filter(r => r.type === t).length;
            if (count === 0) return null;
            return (
              <button
                key={t}
                onClick={() => setTypeFilter(t)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all ${
                  typeFilter === t ? m.bg + ' ring-1 ring-current' : 'border-border text-muted-foreground hover:border-primary/40'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {m.label} ({count})
              </button>
            );
          })}
        </div>

        {/* Search + date range */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search voucher #, account, or narration…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <div className="flex items-center gap-1.5 sm:ml-auto">
            <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="h-9 w-[140px] text-xs" aria-label="From date" />
            <span className="text-xs text-muted-foreground">to</span>
            <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="h-9 w-[140px] text-xs" aria-label="To date" />
            {(fromDate || toDate) && (
              <Button variant="ghost" size="sm" className="h-9 px-2 text-xs" onClick={() => { setFromDate(''); setToDate(''); }}>
                Clear
              </Button>
            )}
          </div>
        </div>

        {/* Table */}
        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          {isLoading ? (
            <TableSkeleton rows={8} cols={8} />
          ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead className="w-8" />
                <SortableHead k="type" sort={sort}>Type</SortableHead>
                <SortableHead k="voucher" sort={sort}>Voucher #</SortableHead>
                <SortableHead k="date" sort={sort}>Date</SortableHead>
                <SortableHead k="description" sort={sort}>Description</SortableHead>
                <SortableHead k="narration" sort={sort}>Narration</SortableHead>
                <SortableHead k="amount" sort={sort} className="text-right">Amount</SortableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="p-0">
                    <EmptyState
                      icon={ReceiptText}
                      title={search || typeFilter !== 'all' ? 'No matching vouchers' : 'No vouchers yet'}
                      hint={search || typeFilter !== 'all' ? 'Try a different search or filter.' : 'All accounting vouchers appear here.'}
                      compact
                      action={canAdd && !search && typeFilter === 'all' ? (
                        <Button size="sm" onClick={() => setNewOpen(true)}>
                          <Plus className="w-4 h-4 mr-1" /> Create first voucher
                        </Button>
                      ) : undefined}
                    />
                  </TableCell>
                </TableRow>
              ) : pageRows.map(row => {
                const isJV = !['payment', 'receipt'].includes(row.type);
                const isExpanded = expanded === row.key;
                const jvLines: any[] = row.raw?.lines ?? [];

                return (
                  <Fragment key={row.key}>
                    <TableRow
                      className={`hover:bg-muted/10 ${isJV && jvLines.length > 0 ? 'cursor-pointer' : ''}`}
                      onClick={() => isJV && jvLines.length > 0 && setExpanded(isExpanded ? null : row.key)}
                    >
                      {/* Expand toggle for JV */}
                      <TableCell className="w-8 text-center">
                        {isJV && jvLines.length > 0 ? (
                          isExpanded
                            ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
                            : <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        ) : null}
                      </TableCell>

                      <TableCell>{typeBadge(row.type)}</TableCell>
                      <TableCell className="font-mono text-xs font-semibold whitespace-nowrap">
                        {row.voucherNumber}
                        {row.raw?.origin === 'system' && (
                          <Badge variant="secondary" className="ml-2 align-middle font-sans font-medium text-[10px] uppercase tracking-wide text-muted-foreground"
                            title="System generated — created by another module (sales, expenses, payroll). Manage it there.">
                            System generated
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">{row.date}</TableCell>
                      <TableCell className="max-w-[200px] truncate text-sm" title={row.description}>{row.description}</TableCell>
                      <TableCell className="max-w-[160px] truncate text-xs text-muted-foreground" title={row.narration}>{row.narration || '—'}</TableCell>
                      <TableCell className={`text-right font-mono font-semibold text-sm ${TYPE_META[row.type].color}`}>
                        {inr(row.amount)}
                      </TableCell>
                      <TableCell onClick={e => e.stopPropagation()}>
                        <div className="flex items-center gap-0.5 justify-end">
                          {canDownload && (
                          <Button
                            variant="ghost" size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-primary"
                            title="Download PDF"
                            onClick={() => downloadVoucherPDF(row, cs)}
                          >
                            <FileDown className="h-3.5 w-3.5" />
                          </Button>
                          )}
                          {/* Edit — manually created vouchers only. `editable`
                              is the server's own verdict for every type
                              (payments and receipts included), so the button
                              can never appear on an entry the API would refuse. */}
                          {canEdit && (
                            row.raw?.editable ? (
                              <Button
                                variant="ghost" size="icon"
                                className="h-7 w-7 text-muted-foreground hover:text-primary"
                                title="Edit voucher"
                                onClick={() => setEditRow(row)}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                            ) : (
                              // A real tooltip, not a native `title` — the reason
                              // a voucher is locked is the whole explanation, so
                              // it has to be readable, not hover-guesswork.
                              <TooltipProvider delayDuration={100}>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span
                                      role="note"
                                      tabIndex={0}
                                      aria-label={row.raw?.lockedReason || LOCKED_FALLBACK}
                                      title={row.raw?.lockedReason || LOCKED_FALLBACK}
                                      className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground/50 hover:text-muted-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                    >
                                      <Lock className="h-3.5 w-3.5" />
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent side="left" className="max-w-xs text-xs leading-relaxed">
                                    {row.raw?.lockedReason || LOCKED_FALLBACK}
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            )
                          )}
                          {/* Delete is hidden for vouchers another module owns —
                              the API refuses them, so offering the button would
                              only produce an error. It is also Administrator-only:
                              the API 403s every other hierarchy level. */}
                          {canDel && isAdmin && row.raw?.origin !== 'system' && (
                            <Button
                              variant="ghost" size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-destructive"
                              onClick={() => setDeleteRow(row)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {/* Admin-only system delete — only on rows the server
                              flagged (sale-generated receipts, level-1 admin).
                              Opens the full-impact warning dialog; the API
                              re-checks both admin level and eligibility. */}
                          {canDel && row.type === 'receipt' && row.raw?.systemDeletable && (
                            <Button
                              variant="ghost" size="icon"
                              className="h-7 w-7 text-destructive/70 hover:text-destructive"
                              title="Delete system voucher (Administrator)"
                              onClick={() => setSysDeleteId(row.id)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>

                    {/* Expanded JV lines */}
                    {isExpanded && jvLines.length > 0 && (
                      <TableRow className="bg-muted/5 hover:bg-muted/5">
                        <TableCell colSpan={8} className="py-0">
                          <div className="px-8 py-3">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="text-muted-foreground border-b">
                                  <th className="text-left font-medium pb-1">Ledger</th>
                                  <th className="text-right font-medium pb-1">Debit</th>
                                  <th className="text-right font-medium pb-1">Credit</th>
                                </tr>
                              </thead>
                              <tbody>
                                {jvLines.map((l: any, i: number) => (
                                  <tr key={i} className="border-b border-dashed last:border-0">
                                    <td className="py-1 font-medium">{l.ledgerName}</td>
                                    <td className="text-right py-1 text-blue-600">{Number(l.debit) > 0 ? inr(l.debit) : '—'}</td>
                                    <td className="text-right py-1 text-emerald-600">{Number(l.credit) > 0 ? inr(l.credit) : '—'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
          )}
        </div>
        <TablePager {...pagerProps} />
      </div>

      {/* Quick-create type buttons — manual types only */}
      {canAdd && all.length > 0 && (
        <div className="flex gap-2 flex-wrap pt-2">
          <span className="text-xs text-muted-foreground self-center mr-1">Quick add:</span>
          {MANUAL_TYPES.map(t => {
            const m = TYPE_META[t];
            const Icon = m.icon;
            return (
              <button
                key={t}
                onClick={() => { setNewType(t); setNewOpen(true); }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all ${m.bg} hover:opacity-80`}
              >
                <Icon className="h-3.5 w-3.5" />
                {m.label}
              </button>
            );
          })}
        </div>
      )}

      {newOpen && <NewVoucherDialog defaultType={newType} onClose={() => setNewOpen(false)} />}
      {editRow && (editRow.type === 'payment' || editRow.type === 'receipt'
        ? <EditMoneyVoucherDialog row={editRow} onClose={() => setEditRow(null)} />
        : <EditVoucherDialog row={editRow} onClose={() => setEditRow(null)} />)}
      {deleteRow && <DeleteConfirm row={deleteRow} onClose={() => setDeleteRow(null)} />}
      {sysDeleteId != null && <SystemReceiptDeleteDialog receiptId={sysDeleteId} onClose={() => setSysDeleteId(null)} />}
    </AppLayout>
  );
}
