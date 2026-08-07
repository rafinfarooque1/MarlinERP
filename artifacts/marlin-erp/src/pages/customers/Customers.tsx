import { useState, useMemo } from 'react';
import { useListCustomers, useGetCustomerLedger } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Plus, Search, UserCheck, Download, Eye, BookOpen, Pencil, ShieldOff, HandCoins } from 'lucide-react';
import { downloadCSV } from '@/lib/download';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { usePermission } from '@/lib/usePermission';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { PartyBalance } from '@/lib/partyBalance';
import { CollectPaymentDialog } from './CollectPaymentDialog';
import { CustomerFormDialog } from '@/components/customers/CustomerFormDialog';
import { usePartyLocations, rowMatchesLocation } from '@/lib/usePartyLocations';

function CustomerLedger({ customerId }: { customerId: number }) {
  const { data, isLoading } = useGetCustomerLedger(customerId);
  const entries = data?.entries ?? [];

  if (isLoading) return (
    <div className="space-y-2 mt-4">
      {[...Array(4)].map((_, i) => <div key={i} className="h-8 bg-muted/30 rounded animate-pulse" />)}
    </div>
  );

  return (
    <div className="mt-4 space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-muted/20 rounded-lg p-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Total Billed</p>
          <p className="font-bold font-mono text-sm text-foreground mt-0.5">
            ₹{Number(data?.totalBilled ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
          </p>
        </div>
        <div className="bg-muted/20 rounded-lg p-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Amount Paid</p>
          <p className="font-bold font-mono text-sm text-emerald-500 mt-0.5">
            ₹{Number(data?.totalPaid ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
          </p>
        </div>
        <div className="bg-muted/20 rounded-lg p-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Outstanding</p>
          <p className={`font-bold font-mono text-sm mt-0.5 ${(data?.balance ?? 0) > 0 ? 'text-red-500' : 'text-emerald-500'}`}>
            ₹{Number(data?.balance ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
          </p>
        </div>
      </div>

      {/* Transaction table */}
      {entries.length === 0 ? (
        <div className="text-center py-10 text-muted-foreground">
          <BookOpen className="w-8 h-8 mx-auto mb-2 opacity-20" />
          <p className="text-sm">No transactions yet</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead className="text-xs">Date</TableHead>
                <TableHead className="text-xs">Particulars</TableHead>
                <TableHead className="text-xs">Voucher</TableHead>
                <TableHead className="text-right text-xs">Debit</TableHead>
                <TableHead className="text-right text-xs">Credit</TableHead>
                <TableHead className="text-right text-xs">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...entries].reverse().map((e, i) => (
                <TableRow key={i} className="hover:bg-muted/10">
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(e.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                  </TableCell>
                  <TableCell className="text-xs">{e.description}</TableCell>
                  <TableCell className="text-xs font-mono text-muted-foreground whitespace-nowrap">{e.voucherNumber ?? '—'}</TableCell>
                  <TableCell className="text-right text-xs font-mono">
                    {e.debit > 0 ? <span className="text-red-500">₹{Number(e.debit).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span> : '—'}
                  </TableCell>
                  <TableCell className="text-right text-xs font-mono">
                    {e.credit > 0 ? <span className="text-emerald-600">₹{Number(e.credit).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span> : '—'}
                  </TableCell>
                  <TableCell className="text-right text-xs font-mono font-bold">
                    ₹{Number(e.balance).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

export default function Customers() {
  const perm = usePermission('page:/customers');
  const { data: customers = [], isLoading } = useListCustomers();
  const loc = usePartyLocations();
  const [locFilter, setLocFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [editItem, setEditItem] = useState<any>(null);
  const [viewItem, setViewItem] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<'details' | 'ledger'>('details');
  const [collectFor, setCollectFor] = useState<{ id: number; name: string } | null>(null);

  const openEdit = (c: any) => { setEditItem(c); setIsOpen(true); };

  const filtered = useMemo(() => customers.filter(c =>
    (c.name.toLowerCase().includes(search.toLowerCase()) ||
     c.phone?.includes(search) ||
     c.email?.toLowerCase().includes(search.toLowerCase())) &&
    rowMatchesLocation(locFilter, (c as any).locationType ?? (c as any).location_type, (c as any).locationId ?? (c as any).location_id)
  ).map(c => ({
    ...c,
    _locationName: loc.nameOf((c as any).locationType ?? (c as any).location_type, (c as any).locationId ?? (c as any).location_id),
  })), [customers, search, locFilter, loc]);

  const { sorted, sort } = useTableSort(filtered, {
    name: c => c.name,
    phone: c => c.phone,
    state: c => (c as any).state,
    gst: c => c.gstNumber,
    location: c => (c as any)._locationName,
    balance: c => Number((c as any).outstandingBalance) || null,
  });

  if (!perm.isLoading && !perm.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center">
          <div className="w-16 h-16 rounded-2xl bg-destructive/10 flex items-center justify-center">
            <ShieldOff className="w-8 h-8 text-destructive" />
          </div>
          <div>
            <h2 className="text-xl font-bold">Access Denied</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              You don't have permission to view this page.<br />
              Contact your administrator to request access.
            </p>
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><UserCheck className="w-6 h-6 text-primary" /> Customers</h1>
            <p className="text-muted-foreground mt-1">Registered customer accounts</p>
          </div>
          <div className="flex gap-2">
            {perm.canDownload && (
            <Button variant="outline" size="sm" onClick={() => downloadCSV('customers.csv', filtered.map(c => ({ Name: c.name, Phone: c.phone || '', Email: c.email || '', State: (c as any).state || '', GST: c.gstNumber || '', Location: loc.nameOf((c as any).locationType ?? (c as any).location_type, (c as any).locationId ?? (c as any).location_id), Address: c.address || '', Balance: c.totalPurchases || 0 })))}>
              <Download className="w-4 h-4 mr-2" /> Export
            </Button>
            )}
            {perm.canAdd && (
            <Button onClick={() => { setEditItem(null); setIsOpen(true); }}><Plus className="w-4 h-4 mr-2" /> Add Customer</Button>
            )}
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex flex-col sm:flex-row sm:items-center gap-2 bg-muted/20">
            <div className="flex items-center gap-2 flex-1">
              <Search className="w-4 h-4 text-muted-foreground" />
              <Input placeholder="Search name, phone, or email..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0 max-w-sm max-md:max-w-full" />
            </div>
            <Select value={locFilter} onValueChange={setLocFilter}>
              <SelectTrigger className="w-full sm:w-52 h-9 bg-background" data-testid="select-customer-location-filter">
                <SelectValue placeholder="All Locations" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Locations</SelectItem>
                {loc.filterOptions.map(o => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <SortableHead k="name" sort={sort}>Name</SortableHead>
                <SortableHead k="phone" sort={sort}>Phone</SortableHead>
                <SortableHead k="state" sort={sort}>State</SortableHead>
                <SortableHead k="gst" sort={sort}>GST No.</SortableHead>
                <SortableHead k="location" sort={sort}>Location</SortableHead>
                <SortableHead k="balance" sort={sort} className="text-right">Balance</SortableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(3)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={7}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="text-center py-16 text-muted-foreground">
                  <UserCheck className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>{customers.length === 0 ? 'No customers yet' : 'No customers match this search or location'}</p>
                </TableCell></TableRow>
              ) : sorted.map(c => (
                <TableRow key={c.id} className="hover:bg-muted/10">
                  <TableCell className="font-semibold">{c.name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{c.phone || '—'}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{(c as any).state || '—'}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{c.gstNumber || '—'}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{loc.nameOf((c as any).locationType ?? (c as any).location_type, (c as any).locationId ?? (c as any).location_id)}</TableCell>
                  <TableCell className="text-right">
                    <PartyBalance kind="customer" balance={(c as any).outstandingBalance} className="text-sm" />
                  </TableCell>
                  <TableCell className="text-right flex items-center justify-end gap-1">
                    {perm.canAdd && Number((c as any).outstandingBalance ?? 0) > 0.009 && (
                    <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" title="Collect payment" onClick={() => setCollectFor({ id: c.id, name: c.name })}><HandCoins className="w-4 h-4" /></Button>
                    )}
                    {perm.canEdit && (
                    <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => openEdit(c)}><Pencil className="w-4 h-4" /></Button>
                    )}
                    <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => { setViewItem(c); setActiveTab('details'); }}><Eye className="w-4 h-4" /></Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden p-3 space-y-2">
            {isLoading ? [...Array(3)].map((_, i) => (
              <div key={i} className="h-20 bg-muted/30 rounded-lg animate-pulse" />
            )) : filtered.length === 0 ? (
              <div className="text-center py-16 text-muted-foreground">
                <UserCheck className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>{customers.length === 0 ? 'No customers yet' : 'No customers match this search or location'}</p>
              </div>
            ) : sorted.map(c => (
              <div key={c.id} className="border border-border rounded-lg p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-sm truncate">{c.name}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{c.phone || '—'}</p>
                  </div>
                  <PartyBalance kind="customer" balance={(c as any).outstandingBalance} className="text-sm shrink-0" />
                </div>
                <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>State: <span className="text-foreground">{(c as any).state || '—'}</span></span>
                  <span className="truncate">GST: <span className="text-foreground font-mono">{c.gstNumber || '—'}</span></span>
                  <span className="col-span-2 truncate">Location: <span className="text-foreground">{loc.nameOf((c as any).locationType ?? (c as any).location_type, (c as any).locationId ?? (c as any).location_id)}</span></span>
                </div>
                <div className="mt-2 flex items-center justify-end gap-1">
                  {perm.canAdd && Number((c as any).outstandingBalance ?? 0) > 0.009 && (
                  <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" title="Collect payment" onClick={() => setCollectFor({ id: c.id, name: c.name })}><HandCoins className="w-4 h-4" /></Button>
                  )}
                  {perm.canEdit && (
                  <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => openEdit(c)}><Pencil className="w-4 h-4" /></Button>
                  )}
                  <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => { setViewItem(c); setActiveTab('details'); }}><Eye className="w-4 h-4" /></Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Add / Edit Customer — THE shared form (also used by POS & Quotations) */}
      <CustomerFormDialog
        open={isOpen}
        onOpenChange={v => { setIsOpen(v); if (!v) setEditItem(null); }}
        editItem={editItem}
      />

      {/* View Sheet */}
      <Sheet open={!!viewItem} onOpenChange={v => !v && setViewItem(null)}>
        <SheetContent className="sm:max-w-2xl overflow-y-auto">
          <SheetHeader className="pb-4">
            <SheetTitle className="flex items-center gap-2">
              <UserCheck className="w-5 h-5 text-primary" />
              {viewItem?.name}
            </SheetTitle>
            <div className="flex gap-1 mt-3">
              <button
                onClick={() => setActiveTab('details')}
                className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors ${activeTab === 'details' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted/40'}`}
              >Details</button>
              <button
                onClick={() => setActiveTab('ledger')}
                className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors flex items-center gap-1.5 ${activeTab === 'ledger' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted/40'}`}
              ><BookOpen className="w-3.5 h-3.5" />Ledger</button>
            </div>
          </SheetHeader>

          {viewItem && activeTab === 'details' && (
            <div className="space-y-4">
              {/* Balance highlight */}
              <div className="bg-primary/5 border border-primary/20 rounded-xl p-4 flex items-center justify-between">
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">Outstanding Balance</p>
                  <PartyBalance kind="customer" balance={(viewItem as any).outstandingBalance} className="text-2xl mt-0.5 block" />
                </div>
                <div className="flex flex-col items-end gap-2">
                  {perm.canAdd && Number((viewItem as any).outstandingBalance ?? 0) > 0.009 && (
                    <Button size="sm" variant="outline" className="h-8" onClick={() => setCollectFor({ id: viewItem.id, name: viewItem.name })}>
                      <HandCoins className="w-3.5 h-3.5 mr-1.5" /> Collect Payment
                    </Button>
                  )}
                  <button onClick={() => setActiveTab('ledger')} className="text-xs text-primary underline">View ledger →</button>
                </div>
              </div>
              <Separator />
              {[['Phone', viewItem.phone || '—'], ['Email', viewItem.email || '—'], ['State', (viewItem as any).state || '—'], ['GSTIN', viewItem.gstNumber || '—'], ['Location', loc.nameOf((viewItem as any).locationType ?? (viewItem as any).location_type, (viewItem as any).locationId ?? (viewItem as any).location_id)], ['Credit Limit', Number((viewItem as any).creditLimit ?? 0) > 0 ? `₹${Number((viewItem as any).creditLimit).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : 'No limit'], ['Credit Days', String(Number((viewItem as any).creditDays ?? 0) || '—')], ['Address', viewItem.address || '—'], ['Notes', viewItem.notes || '—']].map(([k, v]) => (
                <div key={k} className="flex flex-col gap-1 border-b border-border pb-3">
                  <span className="text-xs text-muted-foreground uppercase tracking-wider">{k}</span>
                  <span className="font-medium">{v}</span>
                </div>
              ))}
            </div>
          )}

          {viewItem && activeTab === 'ledger' && (
            <div>
              <p className="text-xs text-muted-foreground mb-1">Account: <span className="font-mono">CUST-{viewItem.id}</span> · Current Asset — Sundry Debtors</p>
              <CustomerLedger customerId={viewItem.id} />
            </div>
          )}
        </SheetContent>
      </Sheet>

      <CollectPaymentDialog
        customerId={collectFor?.id ?? null}
        customerName={collectFor?.name}
        onOpenChange={v => { if (!v) setCollectFor(null); }}
      />
    </AppLayout>
  );
}
