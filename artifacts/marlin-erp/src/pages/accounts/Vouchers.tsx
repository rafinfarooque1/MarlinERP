import { useState, useMemo, Fragment } from 'react';
import {
  useListPayments, useCreatePayment, useDeletePayment,
  useListReceipts, useCreateReceipt, useDeleteReceipt,
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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
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

// ── Helpers ────────────────────────────────────────────────────────────────
const inr = (n: number) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const today = () => new Date().toISOString().split('T')[0];

/**
 * Returns true for ledgers that are auto-provisioned by the system and should
 * never appear in manual voucher account pickers.
 * Covers: payroll (SAL-EMP-*, SAL-PAY-*, ADV-EMP-*), GST accounts (GST-*),
 * inter-branch stock transfer ledgers (STD-BRANCH-*), and any remaining SYS-* nodes.
 */
function isSystemLedger(code?: string | null): boolean {
  if (!code) return false;
  const c = code.toUpperCase();
  return (
    c.startsWith('SYS-') ||
    c.startsWith('SAL-EMP-') ||
    c.startsWith('SAL-PAY-') ||
    c.startsWith('ADV-EMP-') ||
    c.startsWith('GST-') ||
    c.startsWith('STD-BRANCH-')
  );
}

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

  const allLedgers  = (allAccounts as any[]).filter(a => !a.isGroup && !a.isSystemGroup && !isSystemLedger(a.code));
  const cashLedgers = (cashBank as any[]).filter(a => !a.isGroup && !a.isSystemGroup && !isSystemLedger(a.code));

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

    if (type === 'payment') {
      if (!fromId || !toId) { toast.error('Select both accounts'); return; }
      if (!amount || Number(amount) <= 0) { toast.error('Enter amount'); return; }
      createPayment.mutate({ paymentDate: date, paidFromLedgerId: fromId, paidToLedgerId: toId, amount: Number(amount), narration } as any, {
        onSuccess: (v: any) => { toast.success(`Payment ${v.voucherNumber} recorded`); invalidate(); },
        onError: onErr,
      });
    } else if (type === 'receipt') {
      if (!fromId || !toId) { toast.error('Select both accounts'); return; }
      if (!amount || Number(amount) <= 0) { toast.error('Enter amount'); return; }
      createReceipt.mutate({ receiptDate: date, receivedFromLedgerId: fromId, receivedInLedgerId: toId, amount: Number(amount), narration } as any, {
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

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
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
            <div className="space-y-2">
              {lines.map((l, i) => (
                <div key={i} className="grid grid-cols-[1fr_100px_100px_24px] gap-2 items-center">
                  <AccountCombobox options={allLedgers} value={l.ledgerId} onChange={v => setLine(i, { ledgerId: v })} placeholder="Ledger" />
                  <Input type="number" min={0} placeholder="Dr" value={l.debit} onChange={e => setLine(i, { debit: e.target.value })} className="text-right" />
                  <Input type="number" min={0} placeholder="Cr" value={l.credit} onChange={e => setLine(i, { credit: e.target.value })} className="text-right" />
                  <button type="button" onClick={() => setLines(prev => prev.filter((_, idx) => idx !== i))} className="text-muted-foreground hover:text-destructive">×</button>
                </div>
              ))}
            </div>
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
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={isPending}>Save Voucher</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

  const allLedgers  = (allAccounts as any[]).filter(a => !a.isGroup && !a.isSystemGroup && !isSystemLedger(a.code));
  const cashLedgers = (cashBank as any[]).filter(a => !a.isGroup && !a.isSystemGroup && !isSystemLedger(a.code));

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

    const base = { id: row.id, expectedRev: String(v.rev), voucherDate: date, narration };

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

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
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
            <div className="space-y-2">
              {lines.map((l, i) => (
                <div key={i} className="grid grid-cols-[1fr_100px_100px_24px] gap-2 items-center">
                  <AccountCombobox options={allLedgers} value={l.ledgerId} onChange={val => setLine(i, { ledgerId: val })} placeholder="Ledger" />
                  <Input type="number" min={0} placeholder="Dr" value={l.debit} onChange={e => setLine(i, { debit: e.target.value })} className="text-right" />
                  <Input type="number" min={0} placeholder="Cr" value={l.credit} onChange={e => setLine(i, { credit: e.target.value })} className="text-right" />
                  <button type="button" onClick={() => setLines(prev => prev.filter((_, idx) => idx !== i))} className="text-muted-foreground hover:text-destructive">×</button>
                </div>
              ))}
            </div>
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
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            onClick={submit}
            disabled={updateJV.isPending || (type === 'journal' && !balanced)}
          >
            {updateJV.isPending ? 'Saving…' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const [typeFilter, setTypeFilter] = useState<VoucherType | 'all'>('all');
  const [expanded, setExpanded]   = useState<string | null>(null);
  const [deleteRow, setDeleteRow] = useState<UnifiedRow | null>(null);
  const [editRow, setEditRow]     = useState<UnifiedRow | null>(null);
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

  const filtered = useMemo(() => {
    let list = typeFilter === 'all' ? all : all.filter(r => r.type === typeFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(r =>
        r.voucherNumber.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q) ||
        (r.narration ?? '').toLowerCase().includes(q)
      );
    }
    return list;
  }, [all, typeFilter, search]);

  const total = useMemo(() => filtered.reduce((s, r) => s + r.amount, 0), [filtered]);

  const canView = perm.canView || permPay.canView;
  const canAdd  = perm.canAdd  || permPay.canAdd;
  const canDel  = perm.canDelete || permPay.canDelete;
  const canEdit = perm.canEdit || permPay.canEdit;
  const canDownload = perm.canDownload || permPay.canDownload;

  const handleExport = () => {
    downloadCSV('vouchers.csv', filtered.map(r => ({
      Voucher: r.voucherNumber, Type: TYPE_META[r.type].label,
      Date: r.date, Description: r.description,
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
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <ReceiptText className="w-6 h-6 text-primary" /> Vouchers
            </h1>
            <p className="text-muted-foreground mt-0.5 text-sm">All accounting vouchers in one place</p>
          </div>
          <div className="flex gap-2">
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
          </div>
        </div>

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

        {/* Summary bar */}
        {filtered.length > 0 && (
          <div className="bg-card border rounded-xl p-4 flex justify-between items-center">
            <span className="text-muted-foreground text-sm">{filtered.length} voucher{filtered.length !== 1 ? 's' : ''}</span>
            <span className="text-xl font-bold font-mono">{inr(total)}</span>
          </div>
        )}

        {/* Table */}
        <div className="bg-card border rounded-xl shadow-sm overflow-hidden">
          {/* Search bar */}
          <div className="p-3 border-b flex items-center gap-2 bg-muted/20">
            <Search className="w-4 h-4 text-muted-foreground shrink-0" />
            <Input
              placeholder="Search voucher #, account, or narration…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="border-transparent bg-transparent focus-visible:ring-0 max-w-sm"
            />
          </div>

          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead className="w-8" />
                <TableHead>Type</TableHead>
                <TableHead>Voucher #</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Narration</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                [...Array(5)].map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={8}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell>
                  </TableRow>
                ))
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-16 text-muted-foreground">
                    <ReceiptText className="w-10 h-10 mx-auto mb-3 opacity-20" />
                    <p>{search || typeFilter !== 'all' ? 'No matching vouchers' : 'No vouchers yet'}</p>
                    {canAdd && !search && typeFilter === 'all' && (
                      <Button className="mt-4" size="sm" onClick={() => setNewOpen(true)}>
                        <Plus className="w-4 h-4 mr-1" /> Create first voucher
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ) : filtered.map(row => {
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
                      <TableCell className="font-mono text-xs font-semibold">{row.voucherNumber}</TableCell>
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
                              is the server's own verdict, so the button can
                              never appear on an entry the API would refuse. */}
                          {canEdit && isJV && (
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
                              only produce an error. Payments/receipts and older
                              rows without recorded provenance are unaffected. */}
                          {canDel && row.raw?.origin !== 'system' && (
                            <Button
                              variant="ghost" size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-destructive"
                              onClick={() => setDeleteRow(row)}
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
        </div>
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
      {editRow && <EditVoucherDialog row={editRow} onClose={() => setEditRow(null)} />}
      {deleteRow && <DeleteConfirm row={deleteRow} onClose={() => setDeleteRow(null)} />}
    </AppLayout>
  );
}
