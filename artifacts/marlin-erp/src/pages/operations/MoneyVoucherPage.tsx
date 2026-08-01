/**
 * Full-page Receipt / Payment voucher module (Operations menu).
 *
 * A separate SURFACE over the exact same voucher engine as Accounts →
 * Vouchers: same endpoints, same numbering (REC-/PAT-), same postings, same
 * provenance locks. Nothing here posts on its own — the server owns the
 * double entry, so a voucher recorded on this page and one recorded from the
 * Accounts dialog are indistinguishable in the books.
 *
 * Layout follows the ERP's full-page modules (Sales, Expenses): an inline
 * entry form on top — no popup dialogs — and the voucher register below with
 * search, filters, print/PDF and edit/delete for manual vouchers.
 */
import { useMemo, useRef, useState } from 'react';
import {
  useListPayments, useCreatePayment, useUpdatePayment, useDeletePayment,
  useListReceipts, useCreateReceipt, useUpdateReceipt, useDeleteReceipt,
  useListAccountsFlat, useCashBankLedgersFlat,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import {
  ArrowDownLeft, ArrowUpRight, Download, Trash2, Search, Calendar,
  AlertTriangle, Lock, Printer, FileDown, Pencil, RotateCcw, Save, Paperclip, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Form, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { downloadCSV, downloadPDFFromEndpoint, printPDFFromEndpoint } from '@/lib/download';
import { Badge } from '@/components/ui/badge';
import { usePermission } from '@/lib/usePermission';
import { AccountCombobox } from '@/components/ui/account-combobox';
import { isSystemLedger } from '@/lib/systemLedgers';
import { VOUCHER_MODE_OPTIONS, voucherModeLabel } from '@/lib/voucherModes';
import { AttachmentField } from '@/components/AttachmentField';

// ── Per-kind wiring ───────────────────────────────────────────────────────────

type Kind = 'receipt' | 'payment';

const CONFIG = {
  receipt: {
    permKey: 'page:/operations/receipt-voucher',
    title: 'Receipt Voucher',
    subtitle: 'Record money received — customer dues, advances, deposits and other income',
    Icon: ArrowDownLeft,
    accent: 'text-green-600',
    numberHint: 'Auto (REC-…)',
    cashLabel: 'Received Into (Cash / Bank)',
    partyLabel: 'Received From',
    dateField: 'receiptDate',
    cashField: 'receivedInLedgerId',
    partyField: 'receivedFromLedgerId',
    cashNameField: 'receivedInName',
    partyNameField: 'receivedFromName',
    csvName: 'receipt-vouchers.csv',
  },
  payment: {
    permKey: 'page:/operations/payment-voucher',
    title: 'Payment Voucher',
    subtitle: 'Record money paid out — vendor dues, employee payments and other outflows',
    Icon: ArrowUpRight,
    accent: 'text-red-500',
    numberHint: 'Auto (PAT-…)',
    cashLabel: 'Paid From (Cash / Bank)',
    partyLabel: 'Paid To',
    dateField: 'paymentDate',
    cashField: 'paidFromLedgerId',
    partyField: 'paidToLedgerId',
    cashNameField: 'paidFromName',
    partyNameField: 'paidToName',
    csvName: 'payment-vouchers.csv',
  },
} as const;

// Party pickers filter the chart of accounts by ledger-code prefix — the
// prefixes the server stamps when it auto-provisions party ledgers.
const PARTY_TYPES = [
  { value: 'customer', label: 'Customer', match: (c: string) => c.startsWith('CUST-') },
  { value: 'vendor', label: 'Vendor', match: (c: string) => c.startsWith('VEND-') },
  { value: 'employee', label: 'Employee', match: (c: string) => c.startsWith('SAL-EMP-') || c.startsWith('ADV-EMP-') },
  { value: 'ledger', label: 'Other Ledger', match: (_c: string) => true },
] as const;

const schema = z.object({
  voucherDate: z.string().min(1, 'Date required'),
  cashBankLedgerId: z.coerce.number().min(1, 'Select the Cash / Bank account'),
  partyLedgerId: z.coerce.number().min(1, 'Select the party account'),
  amount: z.coerce.number().min(0.01, 'Amount must be greater than 0'),
  paymentMode: z.string().optional(),
  referenceNumber: z.string().max(100).optional(),
  narration: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

const today = () => new Date().toISOString().split('T')[0];
const EMPTY: FormValues = {
  voucherDate: today(), cashBankLedgerId: 0, partyLedgerId: 0,
  amount: 0, paymentMode: '', referenceNumber: '', narration: '',
};

/**
 * Stream the voucher PDF into a tab that was ALREADY opened inside the click
 * gesture. Save & Print must open its tab before the create round-trip, or
 * every popup blocker eats it.
 */
async function pdfIntoTab(tab: Window | null, kind: Kind, id: number) {
  try {
    const token = localStorage.getItem('marlin_auth_token');
    const resp = await fetch('/api/pdf/money-voucher', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      credentials: 'include',
      body: JSON.stringify({ kind, id }),
    });
    if (!resp.ok) {
      tab?.close();
      const err: any = await resp.json().catch(() => ({}));
      throw new Error(err?.error || `Print failed (${resp.status})`);
    }
    const url = URL.createObjectURL(await resp.blob());
    if (!tab || tab.closed) { window.open(url, '_blank'); return; }
    tab.location.replace(url);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e: any) {
    tab?.close();
    toast.error(e?.message ?? 'Could not generate the voucher PDF');
  }
}

export function MoneyVoucherPage({ kind }: { kind: Kind }) {
  const C = CONFIG[kind];
  const isReceipt = kind === 'receipt';
  const perm = usePermission(C.permKey);

  // `kind` is fixed for the lifetime of a mounted route, so hook order is
  // stable — exactly one list/create/update/delete quartet runs per mount.
  const listQ = (isReceipt ? useListReceipts : useListPayments)();
  const createM = (isReceipt ? useCreateReceipt : useCreatePayment)();
  const updateM = (isReceipt ? useUpdateReceipt : useUpdatePayment)();
  const deleteM = (isReceipt ? useDeleteReceipt : useDeletePayment)();
  const { data: allAccounts = [] } = useListAccountsFlat();
  const { data: cashBankAccounts = [] } = useCashBankLedgersFlat();

  const rows = (listQ.data ?? []) as any[];
  const isLoading = listQ.isLoading;

  // ── Form state ──────────────────────────────────────────────────────────────
  const [partyType, setPartyType] = useState<string>('customer');
  const [attachmentUrl, setAttachmentUrl] = useState<string | null>(null);
  const [editing, setEditing] = useState<any>(null);
  const [lastSaved, setLastSaved] = useState<{ id: number; voucherNumber: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const printTabRef = useRef<Window | null>(null);

  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: EMPTY });

  const codeOf = (id: number) => (allAccounts as any[]).find(a => a.id === id)?.code ?? '';
  const partyTypeDef = PARTY_TYPES.find(t => t.value === partyType) ?? PARTY_TYPES[3];
  const partyOptions = useMemo(
    () => (allAccounts as any[]).filter(a =>
      !a.isSystemGroup && !a.isGroup && !isSystemLedger(a.code) && partyTypeDef.match(a.code ?? '')),
    [allAccounts, partyTypeDef],
  );

  const resetForm = () => {
    form.reset({ ...EMPTY, voucherDate: today() });
    setAttachmentUrl(null);
    setEditing(null);
  };

  const startEdit = (row: any) => {
    const partyId = Number(row[C.partyField]);
    const code = codeOf(partyId);
    setPartyType((PARTY_TYPES.find(t => t.value !== 'ledger' && t.match(code)) ?? PARTY_TYPES[3]).value);
    form.reset({
      voucherDate: String(row[C.dateField]).split('T')[0],
      cashBankLedgerId: Number(row[C.cashField]),
      partyLedgerId: partyId,
      amount: Number(row.amount),
      paymentMode: row.paymentMode ?? '',
      referenceNumber: row.referenceNumber ?? '',
      narration: row.narration ?? '',
    });
    setAttachmentUrl(row.attachmentUrl ?? null);
    setEditing(row);
    setLastSaved(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const toBody = (v: FormValues) => ({
    [C.dateField]: v.voucherDate,
    [C.cashField]: v.cashBankLedgerId,
    [C.partyField]: v.partyLedgerId,
    amount: v.amount,
    paymentMode: v.paymentMode ?? '',
    referenceNumber: v.referenceNumber ?? '',
    narration: v.narration ?? '',
    attachmentUrl: attachmentUrl ?? '',
  });

  const submit = (values: FormValues) => {
    const printTab = printTabRef.current;
    printTabRef.current = null;
    if (editing) {
      updateM.mutate({ id: editing.id, ...toBody(values) } as any, {
        onSuccess: (r: any) => {
          toast.success(`${C.title} ${editing.voucherNumber} updated`);
          setLastSaved({ id: editing.id, voucherNumber: editing.voucherNumber });
          resetForm();
          if (printTab) void pdfIntoTab(printTab, kind, editing.id);
        },
        onError: (e: any) => { printTab?.close(); toast.error(e?.data?.error || e.message || 'Update failed'); },
      });
    } else {
      createM.mutate(toBody(values) as any, {
        onSuccess: (r: any) => {
          toast.success(`${C.title} ${r?.voucherNumber ?? ''} saved`);
          if (r?.id) setLastSaved({ id: r.id, voucherNumber: r.voucherNumber ?? String(r.id) });
          resetForm();
          if (printTab && r?.id) void pdfIntoTab(printTab, kind, r.id);
          else printTab?.close();
        },
        onError: (e: any) => { printTab?.close(); toast.error(e?.data?.error || e.message || 'Save failed'); },
      });
    }
  };

  const saveAndPrint = () => {
    // Open the tab NOW, inside the click gesture, before any await.
    printTabRef.current = window.open('about:blank', '_blank');
    void form.handleSubmit(submit, () => { printTabRef.current?.close(); printTabRef.current = null; })();
  };

  // ── Register filters ────────────────────────────────────────────────────────
  const [search, setSearch] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [modeFilter, setModeFilter] = useState('all');
  const [cashFilter, setCashFilter] = useState('all');
  const [byFilter, setByFilter] = useState('all');

  const createdBys = useMemo(
    () => Array.from(new Set(rows.map(r => r.createdBy).filter(Boolean))).sort() as string[],
    [rows],
  );

  const filtered = rows.filter(r => {
    const q = search.toLowerCase();
    if (q && !(
      r.voucherNumber?.toLowerCase().includes(q) ||
      r[C.partyNameField]?.toLowerCase().includes(q) ||
      r[C.cashNameField]?.toLowerCase().includes(q) ||
      r.referenceNumber?.toLowerCase().includes(q) ||
      r.narration?.toLowerCase().includes(q)
    )) return false;
    const d = String(r[C.dateField]).split('T')[0];
    if (fromDate && d < fromDate) return false;
    if (toDate && d > toDate) return false;
    if (modeFilter !== 'all' && (r.paymentMode ?? '') !== modeFilter) return false;
    if (cashFilter !== 'all' && Number(r[C.cashField]) !== Number(cashFilter)) return false;
    if (byFilter !== 'all' && (r.createdBy ?? '') !== byFilter) return false;
    return true;
  });

  const total = filtered.reduce((s, r) => s + Number(r.amount), 0);
  const hasFilters = search || fromDate || toDate || modeFilter !== 'all' || cashFilter !== 'all' || byFilter !== 'all';

  const exportCsv = () => downloadCSV(C.csvName, filtered.map(r => ({
    Voucher: r.voucherNumber,
    Date: String(r[C.dateField]).split('T')[0],
    [C.partyLabel]: r[C.partyNameField],
    'Cash / Bank': r[C.cashNameField],
    Amount: r.amount,
    Mode: voucherModeLabel(r.paymentMode),
    Reference: r.referenceNumber || '',
    Narration: r.narration || '',
    'Created By': r.createdBy || '',
  })));

  const printRow = (r: any) =>
    printPDFFromEndpoint('/api/pdf/money-voucher', { kind, id: r.id })
      .catch((e: any) => toast.error(e?.message ?? 'Print failed'));
  const pdfRow = (r: any) =>
    downloadPDFFromEndpoint('/api/pdf/money-voucher', { kind, id: r.id },
      `${(r.voucherNumber || r.id).toString().replace(/[^A-Za-z0-9._-]+/g, '-')}.pdf`)
      .catch((e: any) => toast.error(e?.message ?? 'PDF failed'));

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

  const busy = createM.isPending || updateM.isPending;

  return (
    <AppLayout>
      <div className="space-y-6">
        {/* ── Header ── */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <C.Icon className={`w-6 h-6 ${C.accent}`} /> {C.title}s
            </h1>
            <p className="text-muted-foreground mt-1">{C.subtitle}</p>
          </div>
          {perm.canDownload && (
            <Button variant="outline" size="sm" onClick={exportCsv}>
              <Download className="w-4 h-4 mr-2" /> Export CSV
            </Button>
          )}
        </div>

        {/* ── Entry form (inline, full-page — never a dialog) ── */}
        {(perm.canAdd || editing) && (
          <div className="bg-card border border-border rounded-xl shadow-sm">
            <div className="px-5 py-3 border-b border-border bg-muted/20 flex items-center justify-between">
              <h2 className="font-semibold text-sm">
                {editing ? <>Editing <span className="font-mono text-primary">{editing.voucherNumber}</span></> : `New ${C.title}`}
              </h2>
              <span className="text-xs text-muted-foreground font-mono">
                Voucher No: {editing ? editing.voucherNumber : C.numberHint}
              </span>
            </div>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(submit)} className="p-5 space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  <FormField control={form.control} name="voucherDate" render={({ field }) => (
                    <FormItem><FormLabel>Date <span className="text-destructive">*</span></FormLabel>
                      <Input type="date" {...field} />
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="cashBankLedgerId" render={({ field }) => (
                    <FormItem className="lg:col-span-2">
                      <FormLabel>{C.cashLabel} <span className="text-destructive">*</span></FormLabel>
                      <AccountCombobox options={cashBankAccounts as any[]} value={field.value}
                        onChange={field.onChange} placeholder="Head Office / branch cash or bank account" />
                      <FormMessage />
                    </FormItem>
                  )} />

                  {/* Plain label — not a react-hook-form field, so no FormItem/FormLabel
                      (those require a FormField context and crash without one). */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium leading-none">Party Type</label>
                    <Select value={partyType} onValueChange={v => { setPartyType(v); form.setValue('partyLedgerId', 0); }}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {PARTY_TYPES.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <FormField control={form.control} name="partyLedgerId" render={({ field }) => (
                    <FormItem className="lg:col-span-2">
                      <FormLabel>{C.partyLabel} <span className="text-destructive">*</span></FormLabel>
                      <AccountCombobox options={partyOptions} value={field.value}
                        onChange={field.onChange} placeholder={`Select ${partyTypeDef.label.toLowerCase()} account`} />
                      <FormMessage />
                    </FormItem>
                  )} />

                  <FormField control={form.control} name="amount" render={({ field }) => (
                    <FormItem><FormLabel>Amount ₹ <span className="text-destructive">*</span></FormLabel>
                      <Input type="number" min={0} step="0.01" {...field} />
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="paymentMode" render={({ field }) => (
                    <FormItem><FormLabel>Mode</FormLabel>
                      <Select value={field.value || ''} onValueChange={field.onChange}>
                        <SelectTrigger><SelectValue placeholder="Cash / UPI / Bank…" /></SelectTrigger>
                        <SelectContent>
                          {VOUCHER_MODE_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="referenceNumber" render={({ field }) => (
                    <FormItem><FormLabel>Reference #</FormLabel>
                      <Input placeholder="Cheque / UTR / Txn no." {...field} />
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>

                <FormField control={form.control} name="narration" render={({ field }) => (
                  <FormItem><FormLabel>Narration</FormLabel>
                    <Textarea rows={2} placeholder={isReceipt ? 'Being amount received towards…' : 'Being amount paid towards…'} {...field} />
                  </FormItem>
                )} />

                <div className="max-w-md space-y-2">
                  <label className="text-sm font-medium leading-none">Attachment</label>
                  <AttachmentField value={attachmentUrl} onChange={setAttachmentUrl} />
                </div>

                <div className="flex flex-wrap gap-2 pt-2 border-t border-border">
                  <Button type="submit" disabled={busy}>
                    <Save className="w-4 h-4 mr-2" />
                    {busy ? 'Saving…' : editing ? 'Update Voucher' : 'Save'}
                  </Button>
                  {perm.canDownload && (
                    <Button type="button" variant="secondary" disabled={busy} onClick={saveAndPrint}>
                      <Printer className="w-4 h-4 mr-2" /> {editing ? 'Update & Print' : 'Save & Print'}
                    </Button>
                  )}
                  <Button type="button" variant="outline" onClick={resetForm} disabled={busy}>
                    {editing ? <><X className="w-4 h-4 mr-2" /> Cancel Edit</> : <><RotateCcw className="w-4 h-4 mr-2" /> Reset</>}
                  </Button>
                </div>
              </form>
            </Form>
          </div>
        )}

        {/* ── Just-saved strip: Print / PDF for the voucher just recorded ── */}
        {lastSaved && perm.canDownload && (
          <div className="bg-primary/5 border border-primary/20 rounded-xl px-4 py-3 flex flex-wrap items-center gap-3">
            <span className="text-sm">
              Voucher <span className="font-mono font-bold text-primary">{lastSaved.voucherNumber}</span> saved.
            </span>
            <div className="flex gap-2 ml-auto">
              <Button size="sm" variant="outline" onClick={() => printPDFFromEndpoint('/api/pdf/money-voucher', { kind, id: lastSaved.id }).catch((e: any) => toast.error(e?.message ?? 'Print failed'))}>
                <Printer className="w-3.5 h-3.5 mr-1.5" /> Print
              </Button>
              <Button size="sm" variant="outline" onClick={() => downloadPDFFromEndpoint('/api/pdf/money-voucher', { kind, id: lastSaved.id }, `${lastSaved.voucherNumber}.pdf`).catch((e: any) => toast.error(e?.message ?? 'PDF failed'))}>
                <FileDown className="w-3.5 h-3.5 mr-1.5" /> PDF
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setLastSaved(null)}>Dismiss</Button>
            </div>
          </div>
        )}

        {/* ── Summary ── */}
        {filtered.length > 0 && (
          <div className="bg-card border border-border rounded-xl p-4 flex justify-between items-center">
            <span className="text-muted-foreground text-sm">
              {filtered.length} voucher{filtered.length === 1 ? '' : 's'}{hasFilters ? ' (filtered)' : ''}
            </span>
            <span className={`text-xl font-bold font-mono ${C.accent}`}>
              ₹{total.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
            </span>
          </div>
        )}

        {/* ── Register ── */}
        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border bg-muted/20 space-y-3">
            <div className="flex items-center gap-2">
              <Search className="w-4 h-4 text-muted-foreground shrink-0" />
              <Input placeholder="Search voucher no, party, reference or narration…" value={search}
                onChange={e => setSearch(e.target.value)}
                className="border-transparent bg-transparent focus-visible:ring-0 max-w-md" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="w-[150px] h-8 text-xs" title="From date" />
              <span className="text-xs text-muted-foreground">to</span>
              <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="w-[150px] h-8 text-xs" title="To date" />
              <Select value={cashFilter} onValueChange={setCashFilter}>
                <SelectTrigger className="w-[190px] h-8 text-xs"><SelectValue placeholder="Cash / Bank" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Cash / Bank accounts</SelectItem>
                  {(cashBankAccounts as any[]).map(a => <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={modeFilter} onValueChange={setModeFilter}>
                <SelectTrigger className="w-[130px] h-8 text-xs"><SelectValue placeholder="Mode" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All modes</SelectItem>
                  {VOUCHER_MODE_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={byFilter} onValueChange={setByFilter}>
                <SelectTrigger className="w-[150px] h-8 text-xs"><SelectValue placeholder="Created by" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All users</SelectItem>
                  {createdBys.map(u => <SelectItem key={u} value={u}>{u}</SelectItem>)}
                </SelectContent>
              </Select>
              {hasFilters && (
                <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => {
                  setSearch(''); setFromDate(''); setToDate(''); setModeFilter('all'); setCashFilter('all'); setByFilter('all');
                }}>Clear</Button>
              )}
            </div>
          </div>

          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Voucher #</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>{C.partyLabel}</TableHead>
                <TableHead>Cash / Bank</TableHead>
                <TableHead>Mode / Ref</TableHead>
                <TableHead>Narration</TableHead>
                <TableHead>By</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(3)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={9}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={9} className="text-center py-16 text-muted-foreground">
                  <C.Icon className="w-10 h-10 mx-auto mb-3 opacity-20" />
                  <p>{hasFilters ? 'No vouchers match the filters' : `No ${C.title.toLowerCase()}s yet`}</p>
                </TableCell></TableRow>
              ) : filtered.map(r => (
                <TableRow key={r.id} className="hover:bg-muted/10">
                  <TableCell className="font-mono text-primary font-bold text-sm whitespace-nowrap">
                    {r.voucherNumber}
                    {r.attachmentUrl && <Paperclip className="w-3 h-3 inline-block ml-1.5 text-muted-foreground" />}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                    <div className="flex items-center gap-1"><Calendar className="w-3 h-3" />{new Date(r[C.dateField]).toLocaleDateString('en-IN')}</div>
                  </TableCell>
                  <TableCell className="font-medium text-sm">{r[C.partyNameField]}</TableCell>
                  <TableCell><Badge variant="outline" className="text-xs">{r[C.cashNameField]}</Badge></TableCell>
                  <TableCell className="text-sm">
                    {r.paymentMode ? <Badge variant="secondary" className="text-xs">{voucherModeLabel(r.paymentMode)}</Badge> : <span className="text-muted-foreground">—</span>}
                    {r.referenceNumber && <div className="text-[11px] text-muted-foreground font-mono mt-0.5 max-w-[110px] truncate" title={r.referenceNumber}>{r.referenceNumber}</div>}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm max-w-[180px] truncate">{r.narration || '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{r.createdBy || '—'}</TableCell>
                  <TableCell className={`text-right font-mono font-bold ${C.accent}`}>
                    ₹{Number(r.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {perm.canDownload && (
                      <>
                        <Button variant="ghost" size="icon" className="h-8 w-8" title="Print" onClick={() => printRow(r)}>
                          <Printer className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8" title="Download PDF" onClick={() => pdfRow(r)}>
                          <FileDown className="w-4 h-4" />
                        </Button>
                      </>
                    )}
                    {r.origin === 'system' ? (
                      <span title="System voucher — created by another module (sales, expenses, payroll). Manage it there." className="inline-flex justify-center w-8">
                        <Lock className="w-3.5 h-3.5 text-muted-foreground/60" />
                      </span>
                    ) : (
                      <>
                        {perm.canEdit && (
                          <Button variant="ghost" size="icon" className="h-8 w-8" title="Edit" onClick={() => startEdit(r)}>
                            <Pencil className="w-4 h-4" />
                          </Button>
                        )}
                        {perm.canDelete && (
                          <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-destructive" title="Delete" onClick={() => setDeleteTarget(r)}>
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        )}
                      </>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* ── Delete confirmation ── */}
      <Dialog open={!!deleteTarget} onOpenChange={v => !v && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle className="text-destructive flex items-center gap-2"><Trash2 className="w-5 h-5" />Delete {C.title}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            Delete voucher <span className="font-semibold text-foreground">{deleteTarget?.voucherNumber}</span> of
            ₹{Number(deleteTarget?.amount || 0).toLocaleString('en-IN')}? The posting is removed from the books. This cannot be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" disabled={deleteM.isPending} onClick={() => deleteM.mutate(deleteTarget.id, {
              onSuccess: () => { toast.success('Voucher deleted'); setDeleteTarget(null); if (editing?.id === deleteTarget.id) resetForm(); },
              onError: (e: any) => toast.error(e?.data?.error || e.message || 'Delete failed'),
            })}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
