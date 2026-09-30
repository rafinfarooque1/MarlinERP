import './_group.css';
import { useMemo, useState, type FormEvent } from 'react';
import {
  ArrowDownLeft,
  CalendarDays,
  Check,
  ChevronDown,
  Download,
  FileDown,
  Landmark,
  LockKeyhole,
  Pencil,
  Printer,
  RotateCcw,
  Save,
  Search,
  Trash2,
  Wallet,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

type ReceiptRow = {
  no: string;
  date: string;
  isoDate: string;
  party: string;
  cash: string;
  location: string;
  ref: string;
  narration: string;
  by: string;
  amount: number;
};

const initialRows: ReceiptRow[] = [
  { no: 'REC-00241', date: '18 Jun 2025', isoDate: '2025-06-18', party: 'Acme Retail Pvt. Ltd.', cash: 'Main Cash', location: 'Head Office', ref: 'UPI-884193', narration: 'Being amount received towards June invoice', by: 'A. Sharma', amount: 48500 },
  { no: 'REC-00240', date: '17 Jun 2025', isoDate: '2025-06-17', party: 'Green Valley Foods', cash: 'HDFC Bank', location: 'Warehouse 1', ref: 'NEFT-01944', narration: 'Advance against purchase order', by: 'R. Kumar', amount: 125000 },
  { no: 'REC-00239', date: '15 Jun 2025', isoDate: '2025-06-15', party: 'Walk-in Customer', cash: 'Main Cash', location: 'Head Office', ref: '', narration: 'Counter sale collection', by: 'A. Sharma', amount: 8750 },
  { no: 'REC-00238', date: '13 Jun 2025', isoDate: '2025-06-13', party: 'Sunrise Supermart', cash: 'ICICI Bank', location: 'Outlet 2', ref: 'CHQ-77281', narration: 'Settlement of outstanding dues', by: 'M. Patel', amount: 76200 },
];

const partyOptions: Record<string, string[]> = {
  Customer: ['Acme Retail Pvt. Ltd.', 'Green Valley Foods', 'Sunrise Supermart', 'Walk-in Customer'],
  Vendor: ['Northfield Cold Chain', 'Arctic Harvest Trading'],
  Employee: ['A. Sharma', 'R. Kumar', 'M. Patel'],
  'Other Ledger': ['Security Deposit Ledger', 'Miscellaneous Receipts'],
};

const locations = ['Head Office', 'Warehouse 1', 'Outlet 2'];
const accounts = ['Main Cash', 'HDFC Bank', 'ICICI Bank'];
const users = ['A. Sharma', 'R. Kumar', 'M. Patel'];

const fieldClass =
  'mt-2 h-10 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground shadow-none outline-none transition focus-visible:ring-2 focus-visible:ring-ring/25 focus-visible:border-primary/60';

function Field({
  label,
  required,
  wide,
  children,
}: {
  label: string;
  required?: boolean;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={`block min-w-0 ${wide ? 'sm:col-span-2' : ''}`}>
      <span className="flex items-center gap-1 text-[12px] font-semibold tracking-[0.01em] text-foreground/80">
        {label}
        {required && <span className="text-primary">*</span>}
      </span>
      {children}
    </label>
  );
}

function money(amount: number) {
  return `₹${amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}

export function Refreshed() {
  const [rows, setRows] = useState(initialRows);
  const [search, setSearch] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [cashFilter, setCashFilter] = useState('all');
  const [byFilter, setByFilter] = useState('all');
  const [mode, setMode] = useState('cash');
  const [partyType, setPartyType] = useState('Customer');
  const [location, setLocation] = useState('Head Office');
  const [receivedInto, setReceivedInto] = useState('Main Cash');
  const [party, setParty] = useState('Acme Retail Pvt. Ltd.');
  const [date, setDate] = useState('2025-06-18');
  const [amount, setAmount] = useState('48500');
  const [reference, setReference] = useState('UPI-884193');
  const [narration, setNarration] = useState('Being amount received towards June invoice');
  const [billSelected, setBillSelected] = useState(true);
  const [editingNo, setEditingNo] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [saved, setSaved] = useState(false);

  const filtered = useMemo(() => rows.filter((row) => {
    const query = search.trim().toLowerCase();
    const matchesSearch = !query || [row.no, row.party, row.cash, row.ref, row.narration]
      .join(' ').toLowerCase().includes(query);
    return matchesSearch
      && (!fromDate || row.isoDate >= fromDate)
      && (!toDate || row.isoDate <= toDate)
      && (cashFilter === 'all' || row.cash === cashFilter)
      && (byFilter === 'all' || row.by === byFilter);
  }), [rows, search, fromDate, toDate, cashFilter, byFilter]);
  const total = filtered.reduce((sum, row) => sum + row.amount, 0);
  const hasFilters = !!(search || fromDate || toDate || cashFilter !== 'all' || byFilter !== 'all');

  const resetForm = () => {
    setMode('cash');
    setPartyType('Customer');
    setLocation('Head Office');
    setReceivedInto('Main Cash');
    setParty('Acme Retail Pvt. Ltd.');
    setDate('2025-06-18');
    setAmount('48500');
    setReference('UPI-884193');
    setNarration('Being amount received towards June invoice');
    setBillSelected(true);
    setEditingNo(null);
    setNotice('');
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const edited = editingNo ? rows.find((row) => row.no === editingNo) : undefined;
    if (edited) {
      setRows((current) => current.map((row) => row.no === editingNo
        ? { ...row, date: new Date(`${date}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }), isoDate: date, party, cash: mode === 'cash' ? receivedInto : mode === 'online' ? 'Online Platform' : 'Held for reconciliation', location, ref: reference, narration, amount: Number(amount) || 0 }
        : row));
      setNotice(`Voucher ${editingNo} updated in this preview.`);
      setEditingNo(null);
    } else {
      setSaved(true);
      setNotice('Receipt saved in this preview.');
    }
  };

  const startEdit = (row: ReceiptRow) => {
    setEditingNo(row.no);
    setDate(row.isoDate);
    setLocation(row.location);
    setParty(row.party);
    setPartyType('Customer');
    setMode(row.cash === 'Main Cash' ? 'cash' : 'bank');
    setReceivedInto(row.cash);
    setAmount(String(row.amount));
    setReference(row.ref);
    setNarration(row.narration);
    setNotice(`Editing ${row.no}`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const exportCsv = () => {
    const csv = [
      ['Voucher #', 'Date', 'Received From', 'Cash / Bank', 'Location', 'Reference', 'Narration', 'By', 'Amount'],
      ...filtered.map((row) => [row.no, row.date, row.party, row.cash, row.location, row.ref, row.narration, row.by, String(row.amount)]),
    ].map((line) => line.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'receipt-vouchers.csv';
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice('Receipt register exported.');
  };

  const clearFilters = () => {
    setSearch('');
    setFromDate('');
    setToDate('');
    setCashFilter('all');
    setByFilter('all');
  };

  const acknowledge = (action: string, row?: ReceiptRow) => {
    setNotice(`${action}${row ? ` · ${row.no}` : ''} — preview only`);
  };

  return (
    <main className="receipt-voucher-surface min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-[1500px] space-y-5 px-4 py-5 sm:px-7 sm:py-7">
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border/80 pb-5">
          <div className="flex items-start gap-4">
            <div className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
              <ArrowDownLeft className="h-5 w-5" strokeWidth={2.2} />
            </div>
            <div>
              <div className="mb-1 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.18em] text-primary">
                <span>Operations</span><span className="h-1 w-1 rounded-full bg-primary/50" /><span>Money In</span>
              </div>
              <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.035em] sm:text-[30px]">Receipt Vouchers</h1>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Record money received — customer dues, advances, deposits and other income</p>
            </div>
          </div>
          <Button variant="outline" onClick={exportCsv} className="h-9 gap-2 border-border bg-card px-3 text-xs font-semibold shadow-sm">
            <Download className="h-4 w-4 text-primary" /> Export CSV
          </Button>
        </header>

        <section className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border bg-muted/25 px-4 py-3 sm:px-5">
            <div className="flex items-center gap-3">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary"><Wallet className="h-4 w-4" /></span>
              <div>
                <h2 className="text-sm font-semibold">{editingNo ? 'Edit Receipt Voucher' : 'New Receipt Voucher'}</h2>
                <p className="text-[11px] text-muted-foreground">Entry details and accounting destination</p>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-md border border-border/70 bg-background/70 px-2.5 py-1.5">
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Voucher No</span>
              <span className="font-mono text-xs font-bold text-foreground">{editingNo ?? 'Auto (REC-…)'} </span>
            </div>
          </div>

          <form onSubmit={submit} className="space-y-4 p-4 sm:p-5">
            <div className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2 xl:grid-cols-4">
              <Field label="Location" required>
                <div className="relative">
                  <select className={`${fieldClass} appearance-none pr-9`} value={location} onChange={(event) => setLocation(event.target.value)}>
                    {locations.map((item) => <option key={item}>{item}</option>)}
                  </select><ChevronDown className="pointer-events-none absolute right-3 top-[22px] h-4 w-4 text-muted-foreground" />
                </div>
              </Field>
              <Field label="Date" required>
                <div className="relative"><Input type="date" value={date} onChange={(event) => setDate(event.target.value)} className={`${fieldClass} pr-3`} /><CalendarDays className="pointer-events-none absolute right-3 top-3 h-4 w-4 text-muted-foreground/70" /></div>
              </Field>
              <Field label="Payment Mode" required>
                <div className="relative">
                  <select className={`${fieldClass} appearance-none pr-9`} value={mode} onChange={(event) => setMode(event.target.value)}>
                    <option value="cash">Cash</option><option value="bank">Bank</option><option value="upi">UPI</option><option value="online">Online</option>
                  </select><ChevronDown className="pointer-events-none absolute right-3 top-[22px] h-4 w-4 text-muted-foreground" />
                </div>
              </Field>
              <Field label={mode === 'online' ? 'Online Platform' : 'Received Into (Cash / Bank)'} required={mode === 'cash' || mode === 'online'}>
                {mode === 'cash' || mode === 'online' ? (
                  <div className="relative">
                    <select className={`${fieldClass} appearance-none pr-9`} value={receivedInto} onChange={(event) => setReceivedInto(event.target.value)}>
                      {accounts.map((item) => <option key={item}>{item}</option>)}
                    </select><ChevronDown className="pointer-events-none absolute right-3 top-[22px] h-4 w-4 text-muted-foreground" />
                  </div>
                ) : (
                  <div className="mt-2 flex h-10 items-center gap-2 rounded-lg border border-dashed border-primary/30 bg-primary/5 px-3 text-xs text-muted-foreground">
                    <Landmark className="h-4 w-4 shrink-0 text-primary" />Held for reconciliation. Destination is selected during reconciliation.
                  </div>
                )}
              </Field>
              <Field label="Party Type">
                <div className="relative">
                  <select className={`${fieldClass} appearance-none pr-9`} value={partyType} onChange={(event) => { setPartyType(event.target.value); setParty(partyOptions[event.target.value][0]); }}>
                    <option>Customer</option><option>Vendor</option><option>Employee</option><option>Other Ledger</option>
                  </select><ChevronDown className="pointer-events-none absolute right-3 top-[22px] h-4 w-4 text-muted-foreground" />
                </div>
              </Field>
              <Field label="Received From" required wide>
                <div className="relative">
                  <select className={`${fieldClass} appearance-none pr-9`} value={party} onChange={(event) => setParty(event.target.value)}>
                    {partyOptions[partyType].map((item) => <option key={item}>{item}</option>)}
                  </select><ChevronDown className="pointer-events-none absolute right-3 top-[22px] h-4 w-4 text-muted-foreground" />
                </div>
              </Field>
              <Field label="Amount ₹" required>
                <div className="relative">
                  <span className="absolute left-3 top-[19px] font-mono text-sm font-bold text-primary">₹</span>
                  <Input type="number" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} className={`${fieldClass} pl-8 text-right font-mono text-[15px] font-bold tabular-nums`} />
                </div>
              </Field>
              <Field label="Reference #">
                <Input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Cheque / UTR / Txn no." className={fieldClass} />
              </Field>
            </div>

            <section className="overflow-hidden rounded-lg border border-border/80 bg-background/70">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 bg-muted/20 px-4 py-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-[13px] font-semibold">Bill-wise settlement</h3>
                    <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-primary">Customer</span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">Select open bills for this customer; any excess parks as an advance.</p>
                </div>
                <div className="flex items-center gap-2 rounded-md border border-primary/20 bg-primary/5 px-2.5 py-1.5">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">To allocate</span>
                  <span className="font-mono text-xs font-bold text-primary">₹48,500.00</span>
                </div>
              </div>
              <label className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-muted/20">
                <input type="checkbox" checked={billSelected} onChange={(event) => setBillSelected(event.target.checked)} className="h-4 w-4 accent-[hsl(var(--primary))]" />
                <span className="text-xs font-semibold">INV-1048</span>
                <span className="text-xs text-muted-foreground">30 May 2025</span>
                <span className="ml-auto font-mono text-xs font-bold tabular-nums">₹48,500.00</span>
              </label>
            </section>

            <Field label="Narration">
              <Textarea rows={2} value={narration} onChange={(event) => setNarration(event.target.value)} placeholder="Being amount received towards…" className="mt-2 min-h-[62px] resize-y rounded-lg border-input bg-card text-sm shadow-none focus-visible:ring-2 focus-visible:ring-ring/25" />
            </Field>

            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
              <Button type="submit" className="h-9 gap-2 px-4 text-xs font-semibold shadow-sm"><Save className="h-4 w-4" />{editingNo ? 'Update Voucher' : 'Save'}</Button>
              <Button type="button" variant="secondary" onClick={() => { setSaved(true); setNotice('Save & Print — preview only'); }} className="h-9 gap-2 px-3 text-xs font-semibold"><Printer className="h-4 w-4" />{editingNo ? 'Update & Print' : 'Save & Print'}</Button>
              <Button type="button" variant="outline" onClick={resetForm} className="h-9 gap-2 px-3 text-xs font-semibold"><RotateCcw className="h-4 w-4" />{editingNo ? 'Cancel Edit' : 'Reset'}</Button>
              <span className="ml-auto hidden items-center gap-1.5 text-[10px] text-muted-foreground sm:inline-flex"><LockKeyhole className="h-3 w-3" />Posting trail follows the selected location</span>
            </div>
          </form>
        </section>

        {(saved || notice) && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-primary/20 bg-primary/[0.06] px-4 py-3 text-xs">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-primary"><Check className="h-3.5 w-3.5" /></span>
            <span>{notice || <>Voucher <span className="font-mono font-bold text-primary">REC-00242</span> saved in this preview.</>}</span>
            {saved && <span className="font-mono font-bold text-primary">REC-00242</span>}
            <div className="ml-auto flex gap-1.5">
              <Button variant="outline" size="sm" onClick={() => acknowledge('Print')} className="h-7 gap-1.5 bg-card px-2.5 text-[11px]"><Printer className="h-3.5 w-3.5" />Print</Button>
              <Button variant="outline" size="sm" onClick={() => acknowledge('PDF')} className="h-7 gap-1.5 bg-card px-2.5 text-[11px]"><FileDown className="h-3.5 w-3.5" />PDF</Button>
              <Button variant="ghost" size="sm" onClick={() => { setSaved(false); setNotice(''); }} className="h-7 px-2.5 text-[11px]"><X className="mr-1 h-3.5 w-3.5" />Dismiss</Button>
            </div>
          </div>
        )}

        {filtered.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3 shadow-sm">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="font-mono text-sm font-bold text-foreground">{filtered.length}</span>
              <span>vouchers{hasFilters ? ' (filtered)' : ''}</span>
              <span className="mx-1 h-4 border-l border-border" />
              <span>Receipt register total</span>
            </div>
            <span className="font-mono text-xl font-bold tracking-tight text-emerald-700">{money(total)}</span>
          </div>
        )}

        <section className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <div className="border-b border-border bg-muted/20 p-4">
            <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 shadow-sm focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/10">
              <Search className="h-4 w-4 shrink-0 text-primary/80" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search voucher no, party, reference or narration…" className="h-10 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0" />
              {search && <Button type="button" variant="ghost" size="icon" title="Clear search" onClick={() => setSearch('')} className="h-7 w-7 text-muted-foreground"><X className="h-3.5 w-3.5" /></Button>}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="mr-1 inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground"><CalendarDays className="h-3.5 w-3.5" />Date range</span>
              <Input type="date" title="From date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} className="h-8 w-[150px] rounded-md bg-card px-2.5 text-[11px]" />
              <span className="text-[11px] text-muted-foreground">to</span>
              <Input type="date" title="To date" value={toDate} onChange={(event) => setToDate(event.target.value)} className="h-8 w-[150px] rounded-md bg-card px-2.5 text-[11px]" />
              <select aria-label="Cash or bank account filter" value={cashFilter} onChange={(event) => setCashFilter(event.target.value)} className="h-8 rounded-md border border-input bg-card px-2.5 text-[11px] text-foreground outline-none focus:ring-2 focus:ring-ring/25">
                <option value="all">All Cash / Bank accounts</option>{accounts.map((item) => <option key={item}>{item}</option>)}
              </select>
              <select aria-label="Created by filter" value={byFilter} onChange={(event) => setByFilter(event.target.value)} className="h-8 rounded-md border border-input bg-card px-2.5 text-[11px] text-foreground outline-none focus:ring-2 focus:ring-ring/25">
                <option value="all">All users</option>{users.map((item) => <option key={item}>{item}</option>)}
              </select>
              {hasFilters && <Button variant="ghost" size="sm" onClick={clearFilters} className="h-8 gap-1 px-2.5 text-[11px] text-muted-foreground"><RotateCcw className="h-3 w-3" />Clear</Button>}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[1140px] text-left text-xs">
              <thead>
                <tr className="border-b border-border bg-background/80 text-[10px] font-bold uppercase tracking-[0.1em] text-muted-foreground">
                  <th className="whitespace-nowrap px-4 py-3">Voucher #</th>
                  <th className="whitespace-nowrap px-3 py-3">Date</th>
                  <th className="whitespace-nowrap px-3 py-3">Received From</th>
                  <th className="whitespace-nowrap px-3 py-3">Cash / Bank</th>
                  <th className="whitespace-nowrap px-3 py-3">Location</th>
                  <th className="whitespace-nowrap px-3 py-3">Reference</th>
                  <th className="whitespace-nowrap px-3 py-3">Narration</th>
                  <th className="whitespace-nowrap px-3 py-3">By</th>
                  <th className="whitespace-nowrap px-3 py-3 text-right">Amount</th>
                  <th className="whitespace-nowrap px-3 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row, index) => (
                  <tr key={row.no} className={`group border-b border-border/70 transition-colors hover:bg-primary/[0.035] ${index % 2 === 1 ? 'bg-muted/[0.12]' : 'bg-card'}`}>
                    <td className="whitespace-nowrap px-4 py-3.5"><span className="font-mono text-[11px] font-bold text-primary">{row.no}</span></td>
                    <td className="whitespace-nowrap px-3 py-3.5 text-muted-foreground"><span className="flex items-center gap-1.5"><CalendarDays className="h-3 w-3 text-muted-foreground/70" />{row.date}</span></td>
                    <td className="whitespace-nowrap px-3 py-3.5 font-semibold text-foreground">{row.party}</td>
                    <td className="whitespace-nowrap px-3 py-3.5"><span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-[10px] font-medium text-foreground/80"><Wallet className="h-3 w-3 text-primary/70" />{row.cash}</span></td>
                    <td className="whitespace-nowrap px-3 py-3.5 text-muted-foreground">{row.location}</td>
                    <td className="whitespace-nowrap px-3 py-3.5 font-mono text-[10px] text-muted-foreground">{row.ref || '—'}</td>
                    <td className="max-w-[190px] truncate px-3 py-3.5 text-muted-foreground" title={row.narration}>{row.narration}</td>
                    <td className="whitespace-nowrap px-3 py-3.5 text-muted-foreground">{row.by}</td>
                    <td className="whitespace-nowrap px-3 py-3.5 text-right font-mono text-xs font-bold tabular-nums text-emerald-700">{money(row.amount)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right">
                      <div className="inline-flex items-center gap-0.5 opacity-80 transition-opacity group-hover:opacity-100">
                        <Button variant="ghost" size="icon" title="Print" onClick={() => acknowledge('Print', row)} className="h-7 w-7 text-muted-foreground hover:text-primary"><Printer className="h-3.5 w-3.5" /></Button>
                        <Button variant="ghost" size="icon" title="Download PDF" onClick={() => acknowledge('PDF', row)} className="h-7 w-7 text-muted-foreground hover:text-primary"><FileDown className="h-3.5 w-3.5" /></Button>
                        <Button variant="ghost" size="icon" title="Edit" onClick={() => startEdit(row)} className="h-7 w-7 text-muted-foreground hover:text-primary"><Pencil className="h-3.5 w-3.5" /></Button>
                        <Button variant="ghost" size="icon" title="Delete" onClick={() => { setRows((current) => current.filter((item) => item.no !== row.no)); setNotice(`${row.no} removed from this preview.`); }} className="h-7 w-7 text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></Button>
                      </div>
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr><td colSpan={10} className="px-4 py-14 text-center">
                    <div className="mx-auto flex max-w-sm flex-col items-center">
                      <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><Search className="h-5 w-5" /></span>
                      <p className="text-sm font-semibold">No vouchers match these filters</p>
                      <p className="mt-1 text-xs text-muted-foreground">Adjust the date range or clear filters to see the receipt register.</p>
                      {hasFilters && <Button variant="outline" size="sm" onClick={clearFilters} className="mt-4 h-8 gap-1.5 bg-card text-xs"><RotateCcw className="h-3.5 w-3.5" />Clear filters</Button>}
                    </div>
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
          <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-muted/[0.16] px-4 py-2.5 text-[10px] text-muted-foreground">
            <span>Showing {filtered.length} of {rows.length} receipt vouchers</span>
            <span className="inline-flex items-center gap-1.5"><LockKeyhole className="h-3 w-3" />Accounting trail retained</span>
          </footer>
        </section>
      </div>
    </main>
  );
}