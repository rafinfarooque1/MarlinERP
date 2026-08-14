import { useMemo, useState } from 'react';
import {
  useListItems, useListMaterials, useListRawMaterials, useItemTracking,
} from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { TablePager, useClientPage } from '@/components/ui/table-pager';
import {
  Check, ChevronsUpDown, PackageSearch, ShoppingCart, Receipt, Undo2, ArrowLeftRight, Factory, ClipboardCheck,
} from 'lucide-react';
import { SummaryCard, SummaryCardGrid } from '@/components/app/summary-card';
import { StatusBadge } from '@/components/app/status-badge';
import { EmptyState } from '@/components/app/empty-state';

const money = (n: number) => `₹${(Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qty3 = (n: number) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const dateIN = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-IN') : '—');

const KIND_LABELS: Record<string, string> = {
  item: 'Item Name (SKU)',
  material: 'Raw Material',
  raw_material: 'Packing Material',
};

interface PickedProduct {
  materialType: 'item' | 'material' | 'raw_material';
  itemId: number;
  name: string;
}

/** Searchable picker across all three product kinds. */
function ProductPicker({ value, onPick }: { value: PickedProduct | null; onPick: (p: PickedProduct) => void }) {
  const [open, setOpen] = useState(false);
  const { data: items = [] } = useListItems();
  const { data: materials = [] } = useListMaterials();
  const { data: rawMaterials = [] } = useListRawMaterials();

  const groups: Array<{ kind: PickedProduct['materialType']; label: string; rows: any[] }> = [
    { kind: 'item', label: KIND_LABELS.item, rows: items as any[] },
    { kind: 'material', label: KIND_LABELS.material, rows: materials as any[] },
    { kind: 'raw_material', label: KIND_LABELS.raw_material, rows: rawMaterials as any[] },
  ];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" aria-expanded={open} className="w-full sm:w-[380px] justify-between font-normal">
          {value ? (
            <span className="truncate">{value.name}</span>
          ) : (
            <span className="text-muted-foreground">Select a product to track…</span>
          )}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[380px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search by name or code…" />
          <CommandList className="max-h-[320px]">
            <CommandEmpty>No product found.</CommandEmpty>
            {groups.map(g => g.rows.length > 0 && (
              <CommandGroup key={g.kind} heading={g.label}>
                {g.rows.map((r: any) => {
                  const code = r.itemCode ?? r.item_code ?? r.materialCode ?? r.material_code ?? '';
                  const selected = value?.materialType === g.kind && value?.itemId === Number(r.id);
                  return (
                    <CommandItem
                      key={`${g.kind}-${r.id}`}
                      value={`${r.name} ${code} ${g.label}`}
                      onSelect={() => { onPick({ materialType: g.kind, itemId: Number(r.id), name: String(r.name) }); setOpen(false); }}
                    >
                      <Check className={`mr-2 h-4 w-4 ${selected ? 'opacity-100' : 'opacity-0'}`} />
                      <span className="truncate">{r.name}</span>
                      {code ? <span className="ml-auto text-xs text-muted-foreground">{code}</span> : null}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** One row of the unified, date-wise activity list. */
interface ActivityRow {
  key: string;
  kind: 'purchase' | 'sale' | 'sales_return' | 'purchase_return' | 'transfer' | 'production' | 'adjustment';
  date: string | null;
  /** Document id — tiebreak so same-day rows keep entry order. */
  docId: number;
  ref: string;
  detail: string;
  /** Muted secondary detail (batch no., against-invoice, reason…). */
  sub?: string;
  /** Signed stock effect: + into stock, − out of stock, null = movement (transfer). */
  qty: number | null;
  /** Unsigned quantity for transfers. */
  moveQty?: number;
  amount?: number | null;
  amountIsRate?: boolean;
  location: string;
  cancelled?: boolean;
  isBranchTransfer?: boolean;
  transferStatus?: string;
}

const TYPE_META: Record<ActivityRow['kind'], { label: string; icon: any; badge: string }> = {
  purchase:        { label: 'Purchase',        icon: ShoppingCart,   badge: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30' },
  sale:            { label: 'Sale',            icon: Receipt,        badge: 'bg-blue-500/10 text-blue-600 border-blue-500/30' },
  sales_return:    { label: 'Sales Return',    icon: Undo2,          badge: 'bg-amber-500/10 text-amber-600 border-amber-500/30' },
  purchase_return: { label: 'Purchase Return', icon: Undo2,          badge: 'bg-orange-500/10 text-orange-600 border-orange-500/30' },
  transfer:        { label: 'Transfer',        icon: ArrowLeftRight, badge: 'bg-sky-500/10 text-sky-600 border-sky-500/30' },
  production:      { label: 'Production',      icon: Factory,        badge: 'bg-violet-500/10 text-violet-600 border-violet-500/30' },
  adjustment:      { label: 'Adjustment',      icon: ClipboardCheck, badge: 'bg-slate-500/10 text-slate-600 border-slate-500/30' },
};

function TypeBadge({ kind }: { kind: ActivityRow['kind'] }) {
  const m = TYPE_META[kind];
  const Icon = m.icon;
  return (
    <Badge variant="outline" className={`font-normal whitespace-nowrap ${m.badge}`}>
      <Icon className="w-3 h-3 mr-1" />{m.label}
    </Badge>
  );
}

function RowFlags({ cancelled, isBranchTransfer }: { cancelled?: boolean; isBranchTransfer?: boolean }) {
  if (!cancelled && !isBranchTransfer) return null;
  return (
    <span className="inline-flex gap-1 ml-1">
      {cancelled ? <Badge variant="destructive" className="text-[10px]">Cancelled</Badge> : null}
      {isBranchTransfer ? <Badge variant="outline" className="text-[10px] text-sky-500 border-sky-500/30">Branch Transfer</Badge> : null}
    </span>
  );
}

export default function ItemTrackingTab() {
  const [picked, setPicked] = useState<PickedProduct | null>(null);
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const { data, isLoading, isFetching } = useItemTracking(picked ? { materialType: picked.materialType, itemId: picked.itemId } : null);

  const s = data?.summary;
  const unit = data?.item.unit ?? '';
  const isItem = data?.item.materialType === 'item';
  const showValue = data?.canViewValuation === true;

  // ── Merge every document family into ONE chronological list ────────────────
  const allRows = useMemo<ActivityRow[]>(() => {
    if (!data) return [];
    const rows: ActivityRow[] = [];
    for (const r of data.purchaseHistory ?? []) {
      rows.push({
        key: `pur-${r.purchaseId}-${rows.length}`, kind: 'purchase', date: r.purchaseDate, docId: r.purchaseId,
        ref: r.invoiceNumber || '—', detail: r.vendorName || '—',
        sub: r.batchNumber ? `Batch ${r.batchNumber}` : undefined,
        qty: Number(r.quantity), amount: (r as any).rate ?? null, amountIsRate: true,
        location: r.location, cancelled: r.cancelled, isBranchTransfer: r.isBranchTransfer,
      });
    }
    for (const r of data.salesHistory ?? []) {
      rows.push({
        key: `sal-${r.saleId}-${rows.length}`, kind: 'sale', date: r.saleDate, docId: r.saleId,
        ref: r.invoiceNumber, detail: r.customerName,
        qty: -Number(r.quantity), amount: r.unitPrice, amountIsRate: true,
        location: r.location, cancelled: r.cancelled, isBranchTransfer: r.isBranchTransfer,
      });
    }
    for (const r of data.salesReturns ?? []) {
      rows.push({
        key: `sr-${r.returnId}-${rows.length}`, kind: 'sales_return', date: r.returnDate, docId: r.returnId,
        ref: r.returnNumber, detail: r.customerName, sub: r.againstInvoice ? `against ${r.againstInvoice}` : undefined,
        qty: Number(r.quantity), amount: r.amount, location: r.location,
      });
    }
    for (const r of data.purchaseReturns ?? []) {
      rows.push({
        key: `pr-${r.returnId}-${rows.length}`, kind: 'purchase_return', date: r.returnDate, docId: r.returnId,
        ref: r.returnNumber, detail: r.vendorName || '—', sub: r.againstInvoice ? `against ${r.againstInvoice}` : undefined,
        qty: -Number(r.quantity), location: r.location,
      });
    }
    for (const r of data.transfers ?? []) {
      rows.push({
        key: `tr-${r.transferId}-${rows.length}`, kind: 'transfer', date: r.transferDate, docId: r.transferId,
        ref: r.challanNumber, detail: `${r.from} → ${r.to}`,
        qty: null, moveQty: Number(r.quantity), location: r.from, transferStatus: r.status,
      });
    }
    for (const r of data.production ?? []) {
      const consumed = (r as any).role === 'consumed';
      rows.push({
        key: `prod-${r.productionId}-${rows.length}`, kind: 'production', date: r.productionDate, docId: r.productionId,
        ref: r.batchNumber || '—', detail: consumed ? 'Used in production' : 'Produced',
        qty: consumed ? -Number(r.quantity) : Number(r.quantity),
        amount: (r as any).costPerUnit ?? null, amountIsRate: true, location: r.location,
      });
    }
    for (const r of data.adjustments ?? []) {
      rows.push({
        key: `adj-${r.verificationId}-${rows.length}`, kind: 'adjustment', date: r.verifyDate, docId: r.verificationId,
        ref: r.countedQty != null ? `Counted ${qty3(r.countedQty)}` : '—',
        detail: r.reason ? r.reason.replace(/_/g, ' ') : 'Stock count',
        sub: r.createdBy ? `by ${r.createdBy}` : undefined,
        qty: Number(r.variance), location: r.location,
      });
    }
    // Date-wise, newest first; same-day rows keep document order (newest doc first).
    rows.sort((a, b) => {
      const da = a.date ?? ''; const db = b.date ?? '';
      if (da !== db) return da < db ? 1 : -1;
      return b.docId - a.docId;
    });
    return rows;
  }, [data]);

  // ── Running stock balance per row ───────────────────────────────────────────
  // Walked BACKWARDS from the summary's current stock (the only trustworthy
  // anchor): the newest row's balance IS current stock, and each older row's
  // balance subtracts the effect of the row after it. Anchoring at the new end
  // means a truncated history never needs a fake "opening balance of zero" —
  // the oldest visible rows are simply where the visible walk stops.
  // Effects mirror the summary's exclusion rules: cancelled documents,
  // GST branch-transfer twins and rejected transfers count 0; accepted
  // transfers move stock BETWEEN locations, so the global balance is
  // unchanged (0) for them too.
  const balances = useMemo(() => {
    const m = new Map<string, number>();
    if (!data || !s) return m;
    let bal = Number(s.currentStock);
    for (const r of allRows) { // allRows is newest-first
      m.set(r.key, Math.round(bal * 1000) / 1000);
      const excluded = r.cancelled || r.isBranchTransfer || r.transferStatus === 'rejected';
      const effect = excluded || r.qty == null ? 0 : Number(r.qty);
      bal -= effect; // balance after the NEXT older row
    }
    return m;
  }, [allRows, data, s]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of allRows) c[r.kind] = (c[r.kind] ?? 0) + 1;
    return c;
  }, [allRows]);

  const filtered = useMemo(
    () => (typeFilter === 'all' ? allRows : allRows.filter(r => r.kind === typeFilter)),
    [allRows, typeFilter],
  );

  const { sorted, sort } = useTableSort(filtered, {
    date: r => r.date,
    type: r => TYPE_META[r.kind].label,
    ref: r => r.ref,
    detail: r => r.detail,
    qty: r => (r.qty ?? r.moveQty ?? 0),
    amount: r => r.amount ?? null,
    location: r => r.location,
  });
  const { pageRows, pagerProps } = useClientPage(sorted, 50);

  const emptyState = useMemo(() => (
    <EmptyState
      icon={PackageSearch}
      title="Pick a product to track"
      hint="Choose a product above to see its full history — purchases, sales, returns, transfers, production and stock counts — in one date-wise list."
    />
  ), []);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <ProductPicker value={picked} onPick={p => { setPicked(p); setTypeFilter('all'); pagerProps.onPageChange(1); }} />
        {picked && data ? (
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Badge variant="outline">{KIND_LABELS[data.item.materialType]}</Badge>
            {data.item.itemCode ? <span>Code: <span className="font-mono">{data.item.itemCode}</span></span> : null}
            {data.item.hsnCode ? <span>HSN: <span className="font-mono">{data.item.hsnCode}</span></span> : null}
            {data.item.mrp != null ? <span>MRP: {money(data.item.mrp)}</span> : null}
            {isFetching ? <span className="text-xs">Refreshing…</span> : null}
          </div>
        ) : null}
      </div>

      {!picked ? emptyState : isLoading ? (
        <p className="py-16 text-center text-sm text-muted-foreground">Loading history…</p>
      ) : !data ? null : (
        <>
          {/* Lifecycle summary */}
          <SummaryCardGrid>
            <SummaryCard label="Purchased" value={`${qty3(s!.purchasedQty)} ${unit}`} icon={ShoppingCart} />
            {isItem ? <SummaryCard label="Sold" value={`${qty3(s!.soldQty)} ${unit}`} icon={Receipt} /> : null}
            {isItem ? <SummaryCard label="Produced" value={`${qty3(s!.producedQty)} ${unit}`} icon={Factory} />
                    : <SummaryCard label="Used in Production" value={`${qty3(s!.consumedQty)} ${unit}`} icon={Factory} />}
            <SummaryCard label="Returns" value={`${qty3(s!.salesReturnQty)} / ${qty3(s!.purchaseReturnQty)}`} sub="sales / purchase" icon={Undo2} />
            <SummaryCard label="Transferred" value={`${qty3(s!.transferQty)} ${unit}`} icon={ArrowLeftRight} />
            <SummaryCard label="Adjustments" value={`${s!.adjustmentQty > 0 ? '+' : ''}${qty3(s!.adjustmentQty)} ${unit}`} sub="stock counts" icon={ClipboardCheck} />
            <SummaryCard label="Current Stock" value={`${qty3(s!.currentStock)} ${unit}`} icon={PackageSearch} tone="info" />
            {showValue && s!.avgCost != null ? <SummaryCard label="Avg Cost" value={money(s!.avgCost)} sub={`per ${unit || 'unit'}`} /> : null}
            {showValue && s!.currentValue != null ? <SummaryCard label="Stock Value" value={money(s!.currentValue)} sub="at avg cost" tone="positive" /> : null}
          </SummaryCardGrid>

          {/* Where it sits right now */}
          {data.stockByLocation.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">In stock at:</span>
              {data.stockByLocation.map(l => (
                <Badge key={`${l.branchType}-${l.branchId}`} variant="outline" className="font-normal">
                  {l.branchName}: <span className="font-mono font-semibold ml-1">{qty3(l.quantity)} {unit}</span>
                </Badge>
              ))}
            </div>
          ) : null}

          {s!.truncated ? (
            <p className="text-xs text-amber-600">
              Older history omitted — showing the latest 200 entries per activity type. The totals above cover
              only these entries. The Balance column is anchored to current stock and walked backwards, so it
              stays correct for the rows shown; the oldest visible balance is NOT an opening balance.
            </p>
          ) : null}

          {/* Unified date-wise activity list */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">All Activity ({filtered.length})</p>
            <Select value={typeFilter} onValueChange={v => { setTypeFilter(v); pagerProps.onPageChange(1); }}>
              <SelectTrigger className="w-[210px] h-9" aria-label="Filter by type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types ({allRows.length})</SelectItem>
                {(Object.keys(TYPE_META) as ActivityRow['kind'][])
                  .filter(k => (counts[k] ?? 0) > 0)
                  .map(k => (
                    <SelectItem key={k} value={k}>{TYPE_META[k].label}s ({counts[k]})</SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          <div className="rounded-xl border border-border bg-card shadow-sm overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead k="date" sort={sort}>Date</SortableHead>
                  <SortableHead k="type" sort={sort}>Type</SortableHead>
                  <SortableHead k="ref" sort={sort}>Reference</SortableHead>
                  <SortableHead k="detail" sort={sort}>Details</SortableHead>
                  <SortableHead k="qty" sort={sort} className="text-right">Qty</SortableHead>
                  <TableHead className="text-right" title="Total stock across all locations after this entry — walked backwards from current stock">
                    Balance
                  </TableHead>
                  <SortableHead k="amount" sort={sort} className="text-right">Rate / Amount</SortableHead>
                  <SortableHead k="location" sort={sort}>Location</SortableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageRows.length === 0 ? (
                  <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">No activity recorded.</TableCell></TableRow>
                ) : pageRows.map(r => (
                  <TableRow key={r.key} className={r.cancelled || r.transferStatus === 'rejected' ? 'opacity-50' : ''}>
                    <TableCell className="whitespace-nowrap">{dateIN(r.date)}</TableCell>
                    <TableCell>
                      <TypeBadge kind={r.kind} />
                      {r.transferStatus ? <span className="ml-1 inline-flex align-middle"><StatusBadge status={r.transferStatus} /></span> : null}
                    </TableCell>
                    <TableCell className="font-mono text-xs whitespace-nowrap">
                      {r.ref}<RowFlags cancelled={r.cancelled} isBranchTransfer={r.isBranchTransfer} />
                    </TableCell>
                    <TableCell>
                      <span>{r.detail}</span>
                      {r.sub ? <span className="ml-1.5 text-xs text-muted-foreground">{r.sub}</span> : null}
                    </TableCell>
                    <TableCell className={`text-right font-mono whitespace-nowrap ${
                      r.qty == null ? '' : r.qty < 0 ? 'text-red-500' : 'text-emerald-600'
                    }`}>
                      {r.qty == null ? qty3(r.moveQty ?? 0) : `${r.qty > 0 ? '+' : r.qty < 0 ? '−' : ''}${qty3(Math.abs(r.qty))}`}
                    </TableCell>
                    <TableCell className={`text-right font-mono whitespace-nowrap ${
                      r.cancelled || r.isBranchTransfer || r.transferStatus === 'rejected' || r.qty == null
                        ? 'text-muted-foreground' : ''
                    }`}>
                      {balances.has(r.key) ? qty3(balances.get(r.key)!) : '—'}
                    </TableCell>
                    <TableCell className="text-right font-mono whitespace-nowrap">
                      {r.amount != null ? money(r.amount) : '—'}
                      {r.amount != null && r.amountIsRate ? <span className="text-[10px] text-muted-foreground ml-0.5">/{unit || 'unit'}</span> : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground whitespace-nowrap">{r.location}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <TablePager {...pagerProps} isFetching={isFetching} />
        </>
      )}
    </div>
  );
}
