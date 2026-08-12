import { useMemo, useState } from 'react';
import {
  useListItems, useListMaterials, useListRawMaterials, useItemTracking,
} from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';
import { useTableSort, SortableHead } from '@/lib/tableSort';
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
  const { data, isLoading, isFetching } = useItemTracking(picked ? { materialType: picked.materialType, itemId: picked.itemId } : null);

  const purchases = data?.purchaseHistory ?? [];
  const sales = data?.salesHistory ?? [];
  const { sorted: sortedPurchases, sort: pSort } = useTableSort(purchases, {
    date: r => r.purchaseDate, vendor: r => r.vendorName, qty: r => r.quantity,
    rate: r => r.rate ?? 0, batch: r => r.batchNumber, location: r => r.location,
  });
  const { sorted: sortedSales, sort: sSort } = useTableSort(sales, {
    date: r => r.saleDate, customer: r => r.customerName, qty: r => r.quantity,
    rate: r => r.unitPrice, gst: r => r.gst, location: r => r.location,
  });

  const s = data?.summary;
  const unit = data?.item.unit ?? '';
  const isItem = data?.item.materialType === 'item';
  const showValue = data?.canViewValuation === true;

  const returnCount = (data?.salesReturns.length ?? 0) + (data?.purchaseReturns.length ?? 0);
  const emptyState = useMemo(() => (
    <EmptyState
      icon={PackageSearch}
      title="Pick a product to track"
      hint="Choose a product above to see its full history — purchases, sales, returns, transfers, production and stock counts."
    />
  ), []);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <ProductPicker value={picked} onPick={setPicked} />
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
            <p className="text-xs text-amber-600">Showing the latest 200 entries per section — older history is not included in the totals above.</p>
          ) : null}

          <Tabs defaultValue={isItem ? 'sales' : 'purchases'}>
            <TabsList className="flex-wrap h-auto">
              <TabsTrigger value="purchases"><ShoppingCart className="w-3.5 h-3.5 mr-1" />Purchases ({purchases.length})</TabsTrigger>
              {isItem ? <TabsTrigger value="sales"><Receipt className="w-3.5 h-3.5 mr-1" />Sales ({sales.length})</TabsTrigger> : null}
              <TabsTrigger value="returns"><Undo2 className="w-3.5 h-3.5 mr-1" />Returns ({returnCount})</TabsTrigger>
              <TabsTrigger value="transfers"><ArrowLeftRight className="w-3.5 h-3.5 mr-1" />Transfers ({data.transfers.length})</TabsTrigger>
              <TabsTrigger value="production"><Factory className="w-3.5 h-3.5 mr-1" />Production ({data.production.length})</TabsTrigger>
              {isItem ? <TabsTrigger value="adjustments"><ClipboardCheck className="w-3.5 h-3.5 mr-1" />Adjustments ({data.adjustments.length})</TabsTrigger> : null}
            </TabsList>

            <TabsContent value="purchases" className="mt-3">
              <div className="rounded-xl border border-border bg-card shadow-sm overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <SortableHead k="date" sort={pSort}>Date</SortableHead>
                      <TableHead>Invoice</TableHead>
                      <SortableHead k="vendor" sort={pSort}>Vendor</SortableHead>
                      <SortableHead k="batch" sort={pSort}>Batch</SortableHead>
                      <SortableHead k="qty" sort={pSort} className="text-right">Qty</SortableHead>
                      {showValue ? <SortableHead k="rate" sort={pSort} className="text-right">Rate</SortableHead> : null}
                      <SortableHead k="location" sort={pSort}>Location</SortableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedPurchases.length === 0 ? (
                      <TableRow><TableCell colSpan={showValue ? 7 : 6} className="text-center text-muted-foreground py-8">No purchases recorded.</TableCell></TableRow>
                    ) : sortedPurchases.map((r, i) => (
                      <TableRow key={`${r.purchaseId}-${i}`} className={r.cancelled ? 'opacity-50' : ''}>
                        <TableCell className="whitespace-nowrap">{dateIN(r.purchaseDate)}</TableCell>
                        <TableCell className="font-mono text-xs">{r.invoiceNumber || '—'}<RowFlags cancelled={r.cancelled} isBranchTransfer={r.isBranchTransfer} /></TableCell>
                        <TableCell>{r.vendorName || '—'}</TableCell>
                        <TableCell className="font-mono text-xs">{r.batchNumber || '—'}</TableCell>
                        <TableCell className="text-right font-mono">{qty3(r.quantity)}</TableCell>
                        {showValue ? <TableCell className="text-right font-mono">{r.rate != null ? money(r.rate) : '—'}</TableCell> : null}
                        <TableCell className="text-muted-foreground">{r.location}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>

            {isItem ? (
              <TabsContent value="sales" className="mt-3">
                <div className="rounded-xl border border-border bg-card shadow-sm overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <SortableHead k="date" sort={sSort}>Date</SortableHead>
                        <TableHead>Invoice</TableHead>
                        <SortableHead k="customer" sort={sSort}>Customer</SortableHead>
                        <SortableHead k="qty" sort={sSort} className="text-right">Qty</SortableHead>
                        <SortableHead k="rate" sort={sSort} className="text-right">Rate (incl. GST)</SortableHead>
                        <TableHead className="text-right">Discount</TableHead>
                        <SortableHead k="gst" sort={sSort} className="text-right">GST</SortableHead>
                        <SortableHead k="location" sort={sSort}>Location</SortableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sortedSales.length === 0 ? (
                        <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">No sales recorded.</TableCell></TableRow>
                      ) : sortedSales.map((r, i) => (
                        <TableRow key={`${r.saleId}-${i}`} className={r.cancelled ? 'opacity-50' : ''}>
                          <TableCell className="whitespace-nowrap">{dateIN(r.saleDate)}</TableCell>
                          <TableCell className="font-mono text-xs">{r.invoiceNumber}<RowFlags cancelled={r.cancelled} isBranchTransfer={r.isBranchTransfer} /></TableCell>
                          <TableCell>{r.customerName}</TableCell>
                          <TableCell className="text-right font-mono">{qty3(r.quantity)}</TableCell>
                          <TableCell className="text-right font-mono">{money(r.unitPrice)}</TableCell>
                          <TableCell className="text-right font-mono">{r.discount ? money(r.discount) : '—'}</TableCell>
                          <TableCell className="text-right font-mono">{money(r.gst)}</TableCell>
                          <TableCell className="text-muted-foreground">{r.location}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </TabsContent>
            ) : null}

            <TabsContent value="returns" className="mt-3 space-y-4">
              <div>
                <p className="text-sm font-medium mb-2">Sales Returns ({data.salesReturns.length})</p>
                <div className="rounded-xl border border-border bg-card shadow-sm overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead><TableHead>Return No.</TableHead><TableHead>Against Invoice</TableHead>
                        <TableHead>Customer</TableHead><TableHead className="text-right">Qty</TableHead>
                        <TableHead className="text-right">Amount</TableHead><TableHead>Location</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.salesReturns.length === 0 ? (
                        <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-6">No sales returns.</TableCell></TableRow>
                      ) : data.salesReturns.map((r, i) => (
                        <TableRow key={`${r.returnId}-${i}`}>
                          <TableCell className="whitespace-nowrap">{dateIN(r.returnDate)}</TableCell>
                          <TableCell className="font-mono text-xs">{r.returnNumber}</TableCell>
                          <TableCell className="font-mono text-xs">{r.againstInvoice}</TableCell>
                          <TableCell>{r.customerName}</TableCell>
                          <TableCell className="text-right font-mono">{qty3(r.quantity)}</TableCell>
                          <TableCell className="text-right font-mono">{money(r.amount)}</TableCell>
                          <TableCell className="text-muted-foreground">{r.location}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
              <div>
                <p className="text-sm font-medium mb-2">Purchase Returns ({data.purchaseReturns.length})</p>
                <div className="rounded-xl border border-border bg-card shadow-sm overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead><TableHead>Return No.</TableHead><TableHead>Against Invoice</TableHead>
                        <TableHead>Vendor</TableHead><TableHead className="text-right">Qty</TableHead><TableHead>Location</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.purchaseReturns.length === 0 ? (
                        <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-6">No purchase returns.</TableCell></TableRow>
                      ) : data.purchaseReturns.map((r, i) => (
                        <TableRow key={`${r.returnId}-${i}`}>
                          <TableCell className="whitespace-nowrap">{dateIN(r.returnDate)}</TableCell>
                          <TableCell className="font-mono text-xs">{r.returnNumber}</TableCell>
                          <TableCell className="font-mono text-xs">{r.againstInvoice || '—'}</TableCell>
                          <TableCell>{r.vendorName || '—'}</TableCell>
                          <TableCell className="text-right font-mono">{qty3(r.quantity)}</TableCell>
                          <TableCell className="text-muted-foreground">{r.location}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="transfers" className="mt-3">
              <div className="rounded-xl border border-border bg-card shadow-sm overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead><TableHead>Challan</TableHead><TableHead>From</TableHead>
                      <TableHead>To</TableHead><TableHead className="text-right">Qty</TableHead><TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.transfers.length === 0 ? (
                      <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">No transfers.</TableCell></TableRow>
                    ) : data.transfers.map((r, i) => (
                      <TableRow key={`${r.transferId}-${i}`} className={r.status === 'rejected' ? 'opacity-50' : ''}>
                        <TableCell className="whitespace-nowrap">{dateIN(r.transferDate)}</TableCell>
                        <TableCell className="font-mono text-xs">{r.challanNumber}</TableCell>
                        <TableCell>{r.from}</TableCell>
                        <TableCell>{r.to}</TableCell>
                        <TableCell className="text-right font-mono">{qty3(r.quantity)}</TableCell>
                        <TableCell>
                          <StatusBadge status={r.status} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>

            <TabsContent value="production" className="mt-3">
              <div className="rounded-xl border border-border bg-card shadow-sm overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead><TableHead>Batch</TableHead>
                      <TableHead className="text-right">{isItem ? 'Produced Qty' : 'Used Qty'}</TableHead>
                      {showValue && isItem ? <TableHead className="text-right">Cost / Unit</TableHead> : null}
                      <TableHead>Location</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.production.length === 0 ? (
                      <TableRow><TableCell colSpan={showValue && isItem ? 5 : 4} className="text-center text-muted-foreground py-8">No production records.</TableCell></TableRow>
                    ) : data.production.map((r, i) => (
                      <TableRow key={`${r.productionId}-${i}`}>
                        <TableCell className="whitespace-nowrap">{dateIN(r.productionDate)}</TableCell>
                        <TableCell className="font-mono text-xs">{r.batchNumber || '—'}</TableCell>
                        <TableCell className="text-right font-mono">{qty3(r.quantity)}</TableCell>
                        {showValue && isItem ? <TableCell className="text-right font-mono">{r.costPerUnit != null ? money(r.costPerUnit) : '—'}</TableCell> : null}
                        <TableCell className="text-muted-foreground">{r.location}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>

            {isItem ? (
              <TabsContent value="adjustments" className="mt-3">
                <div className="rounded-xl border border-border bg-card shadow-sm overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead><TableHead>Location</TableHead>
                        <TableHead className="text-right">Counted Qty</TableHead>
                        <TableHead className="text-right">Adjustment</TableHead>
                        <TableHead>Reason</TableHead><TableHead>By</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.adjustments.length === 0 ? (
                        <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">No stock-count adjustments.</TableCell></TableRow>
                      ) : data.adjustments.map((r, i) => (
                        <TableRow key={`${r.verificationId}-${i}`}>
                          <TableCell className="whitespace-nowrap">{dateIN(r.verifyDate)}</TableCell>
                          <TableCell>{r.location}</TableCell>
                          <TableCell className="text-right font-mono">{r.countedQty != null ? qty3(r.countedQty) : '—'}</TableCell>
                          <TableCell className={`text-right font-mono ${r.variance < 0 ? 'text-red-500' : 'text-emerald-600'}`}>
                            {r.variance > 0 ? '+' : ''}{qty3(r.variance)}
                          </TableCell>
                          <TableCell className="text-muted-foreground capitalize">{r.reason?.replace(/_/g, ' ') ?? '—'}</TableCell>
                          <TableCell className="text-muted-foreground">{r.createdBy ?? '—'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </TabsContent>
            ) : null}
          </Tabs>
        </>
      )}
    </div>
  );
}
