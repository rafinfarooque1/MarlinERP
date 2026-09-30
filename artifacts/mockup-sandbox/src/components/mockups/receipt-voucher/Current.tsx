import './_group.css';
import { ArrowDownLeft, Calendar, Download, FileDown, Lock, Pencil, Printer, RotateCcw, Save, Search, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';

const rows = [
  { no: 'REC-00241', date: '18 Jun 2025', party: 'Acme Retail Pvt. Ltd.', cash: 'Main Cash', location: 'Head Office', ref: 'UPI-884193', narration: 'Being amount received towards June invoice', by: 'A. Sharma', amount: 48500 },
  { no: 'REC-00240', date: '17 Jun 2025', party: 'Green Valley Foods', cash: 'HDFC Bank', location: 'Warehouse 1', ref: 'NEFT-01944', narration: 'Advance against purchase order', by: 'R. Kumar', amount: 125000 },
  { no: 'REC-00239', date: '15 Jun 2025', party: 'Walk-in Customer', cash: 'Main Cash', location: 'Head Office', ref: '', narration: 'Counter sale collection', by: 'A. Sharma', amount: 8750 },
  { no: 'REC-00238', date: '13 Jun 2025', party: 'Sunrise Supermart', cash: 'ICICI Bank', location: 'Outlet 2', ref: 'CHQ-77281', narration: 'Settlement of outstanding dues', by: 'M. Patel', amount: 76200 },
];
const Field = ({ label, children, wide = false }: { label: string; children: React.ReactNode; wide?: boolean }) => (
  <label className={`space-y-2 ${wide ? 'lg:col-span-2' : ''}`}><span className="text-sm font-medium leading-none">{label}</span>{children}</label>
);
const input = 'h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm outline-none focus:ring-2 focus:ring-ring/30';
const Button = ({ children, variant = 'primary', onClick }: { children: React.ReactNode; variant?: string; onClick?: () => void }) => (
  <button onClick={onClick} className={`inline-flex h-9 items-center justify-center rounded-md px-3 text-sm font-medium transition-colors ${variant === 'primary' ? 'bg-primary text-primary-foreground hover:opacity-90' : variant === 'secondary' ? 'bg-secondary text-secondary-foreground' : 'border border-input bg-background hover:bg-muted'}`}>{children}</button>
);

export function Current() {
  const [search, setSearch] = useState('');
  const [saved, setSaved] = useState(false);
  const filtered = useMemo(() => rows.filter(r => !search || Object.values(r).join(' ').toLowerCase().includes(search.toLowerCase())), [search]);
  const total = filtered.reduce((s, r) => s + r.amount, 0);
  return <main className="receipt-voucher-surface min-h-screen bg-background p-6 text-foreground sm:p-8">
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div><h1 className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight"><span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary"><ArrowDownLeft className="h-5 w-5" /></span>Receipt Vouchers</h1><p className="mt-1 max-w-2xl text-sm text-muted-foreground">Record money received — customer dues, advances, deposits and other income</p></div>
        <Button variant="outline"><Download className="mr-2 h-4 w-4" />Export CSV</Button>
      </header>
      <section className="rounded-xl border border-border bg-card shadow-sm">
        <div className="flex items-center justify-between border-b border-border bg-muted/20 px-5 py-3"><h2 className="text-sm font-semibold">New Receipt Voucher</h2><span className="font-mono text-xs text-muted-foreground">Voucher No: Auto (REC-…)</span></div>
        <form className="space-y-4 p-5" onSubmit={e => { e.preventDefault(); setSaved(true); }}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Location *"><select className={input} defaultValue="Head Office"><option>Head Office</option><option>Warehouse 1</option><option>Outlet 2</option></select></Field>
            <Field label="Date *"><input className={input} type="date" defaultValue="2025-06-18" /></Field>
            <Field label="Payment Mode *"><select className={input} defaultValue="cash"><option value="cash">Cash</option><option>Bank</option><option>UPI</option><option>Online</option></select></Field>
            <Field label="Received Into (Cash / Bank)"><select className={input} defaultValue="Main Cash"><option>Main Cash</option><option>HDFC Bank</option><option>ICICI Bank</option></select></Field>
            <Field label="Party Type"><select className={input} defaultValue="customer"><option>Customer</option><option>Vendor</option><option>Employee</option><option>Other Ledger</option></select></Field>
            <Field label="Received From *" wide><select className={input} defaultValue="Acme Retail Pvt. Ltd."><option>Acme Retail Pvt. Ltd.</option><option>Green Valley Foods</option><option>Sunrise Supermart</option></select></Field>
            <Field label="Amount ₹ *"><input className={input} type="number" defaultValue="48500" /></Field>
            <Field label="Reference #"><input className={input} placeholder="Cheque / UTR / Txn no." defaultValue="UPI-884193" /></Field>
          </div>
          <div className="rounded-lg border border-border bg-muted/20 p-4"><div className="mb-3 flex items-center justify-between"><div><h3 className="text-sm font-semibold">Bill-wise settlement</h3><p className="text-xs text-muted-foreground">Select open bills for this customer; any excess parks as an advance.</p></div><span className="rounded-full border border-primary/20 bg-primary/5 px-2 py-1 font-mono text-xs text-primary">₹48,500.00 to allocate</span></div><div className="flex items-center gap-3 text-sm"><input type="checkbox" defaultChecked className="h-4 w-4 accent-primary" /><span>INV-1048 · 30 May 2025</span><span className="ml-auto font-mono">₹48,500.00</span></div></div>
          <Field label="Narration"><textarea className={`${input} h-auto py-2`} rows={2} placeholder="Being amount received towards…" defaultValue="Being amount received towards June invoice" /></Field>
          <div className="flex flex-wrap gap-2 border-t border-border pt-2"><Button><Save className="mr-2 h-4 w-4" />Save</Button><Button variant="secondary"><Printer className="mr-2 h-4 w-4" />Save &amp; Print</Button><Button variant="outline"><RotateCcw className="mr-2 h-4 w-4" />Reset</Button></div>
        </form>
      </section>
      {saved && <div className="flex flex-wrap items-center gap-3 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm">Voucher <span className="font-mono font-bold text-primary">REC-00242</span> saved.<div className="ml-auto flex gap-2"><Button variant="outline"><Printer className="mr-1.5 h-3.5 w-3.5" />Print</Button><Button variant="outline"><FileDown className="mr-1.5 h-3.5 w-3.5" />PDF</Button><Button variant="outline" onClick={() => setSaved(false)}>Dismiss</Button></div></div>}
      <div className="flex items-center justify-between rounded-xl border border-border bg-card p-4"><span className="text-sm text-muted-foreground">{filtered.length} vouchers</span><span className="font-mono text-xl font-bold text-green-600">₹{total.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span></div>
      <section className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="space-y-3 border-b border-border bg-muted/20 p-4"><div className="flex items-center gap-2"><Search className="h-4 w-4 text-muted-foreground" /><input className="h-9 max-w-md flex-1 border-transparent bg-transparent text-sm outline-none focus:ring-0" placeholder="Search voucher no, party, reference or narration…" value={search} onChange={e => setSearch(e.target.value)} /></div><div className="flex flex-wrap items-center gap-2"><input className={`${input} w-[150px] h-8 text-xs`} type="date" /><span className="text-xs text-muted-foreground">to</span><input className={`${input} w-[150px] h-8 text-xs`} type="date" /><select className={`${input} h-8 w-[190px] text-xs`}><option>All Cash / Bank accounts</option><option>Main Cash</option><option>HDFC Bank</option></select><select className={`${input} h-8 w-[150px] text-xs`}><option>All users</option><option>A. Sharma</option><option>R. Kumar</option></select></div></div>
        <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="bg-muted/10 text-left"><th className="whitespace-nowrap p-3 font-medium">Voucher #</th><th className="whitespace-nowrap p-3 font-medium">Date</th><th className="whitespace-nowrap p-3 font-medium">Received From</th><th className="whitespace-nowrap p-3 font-medium">Cash / Bank</th><th className="whitespace-nowrap p-3 font-medium">Location</th><th className="whitespace-nowrap p-3 font-medium">Reference</th><th className="whitespace-nowrap p-3 font-medium">Narration</th><th className="whitespace-nowrap p-3 font-medium">By</th><th className="p-3 text-right font-medium">Amount</th><th className="p-3 text-right font-medium">Actions</th></tr></thead><tbody>{filtered.map(r => <tr key={r.no} className="border-t border-border hover:bg-muted/10"><td className="whitespace-nowrap p-3 font-mono text-sm font-bold text-primary">{r.no}</td><td className="whitespace-nowrap p-3 text-muted-foreground"><span className="flex items-center gap-1"><Calendar className="h-3 w-3" />{r.date}</span></td><td className="p-3 font-medium">{r.party}</td><td className="p-3"><span className="rounded-md border border-border px-2 py-1 text-xs">{r.cash}</span></td><td className="whitespace-nowrap p-3 text-muted-foreground">{r.location}</td><td className="p-3 font-mono text-[11px] text-muted-foreground">{r.ref || '—'}</td><td className="max-w-[180px] truncate p-3 text-muted-foreground">{r.narration}</td><td className="p-3 text-xs text-muted-foreground">{r.by}</td><td className="p-3 text-right font-mono font-bold text-green-600">₹{r.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td><td className="whitespace-nowrap p-3 text-right"><button className="mr-1 p-1.5 text-muted-foreground"><Printer className="h-4 w-4" /></button><button className="mr-1 p-1.5 text-muted-foreground"><FileDown className="h-4 w-4" /></button><button className="p-1.5 text-muted-foreground"><Pencil className="h-4 w-4" /></button></td></tr>)}</tbody></table></div>
      </section>
    </div>
  </main>;
}