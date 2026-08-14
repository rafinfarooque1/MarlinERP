import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import {
  usePaginatedPurchases, useListVendors, useListMaterials, useListRawMaterials, useListItems,
  getListPurchasesQueryKey, useDeletePurchase, useGetCompanySettings, useGetPurchase,
} from '@workspace/api-client-react';
import { downloadPurchaseInvoicePDF } from '@/lib/purchasePdf';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Plus, Search, Trash2, ShoppingCart, Download, Eye, Calendar, FileDown, Edit2, AlertTriangle, FileText, Wallet, Receipt } from 'lucide-react';
import { toast } from 'sonner';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';
import { usePermission } from '@/lib/usePermission';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { useActingLocations } from '@/lib/useActingLocation';
import { useDateRange, RangeBar } from '@/pages/reports/shared';
import { useLocationContext, locationFilterParams } from '@/lib/locationContext';
import { Separator } from '@/components/ui/separator';
import { useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/app/page-header';
import { SummaryCard, SummaryCardGrid } from '@/components/app/summary-card';
import { EmptyState } from '@/components/app/empty-state';
import { TableSkeleton } from '@/components/app/loading-skeletons';
import { inr } from '@/lib/currency';

/** Bill entry lives on its own full page (new/edit routes) — this page is the
 *  register: list, filters, view sheet, PDF and delete. */
export default function Purchases() {
  const perm = usePermission('page:/production/purchase');
  const [, navigate] = useLocation();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 25;
  const range = useDateRange('all');
  const { locationState } = useLocationContext();
  const locParams = locationFilterParams(locationState);

  // Debounce the search box — vendor/invoice search runs server-side
  useEffect(() => {
    const t = setTimeout(() => { setDebouncedSearch(search.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  // A narrowed date range or location changes the whole result set — back to
  // page 1 so the user isn't stranded on a page that no longer exists.
  useEffect(() => {
    setPage(1);
  }, [range.from, range.to, locParams.locationType, locParams.locationId]);

  const { data: purchasePage, isLoading, isFetching } = usePaginatedPurchases({
    page, limit: PAGE_SIZE, q: debouncedSearch || undefined,
    from: range.from || undefined, to: range.to || undefined, ...locParams,
  });
  const purchases = purchasePage?.rows ?? [];
  const totalPurchases = purchasePage?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalPurchases / PAGE_SIZE));

  // Clamp page when the result set shrinks (deletes, concurrent changes)
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);
  const { data: vendors = [] } = useListVendors();
  const { data: materials = [] } = useListMaterials();
  const { data: rawMaterials = [] } = useListRawMaterials();
  const { data: finishedItems = [] } = useListItems();
  const locations = useActingLocations();
  const [viewItem, setViewItem] = useState<any>(null);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);

  // Books drill-down: /production/purchase?view=<id> opens that bill's view
  // sheet directly (ledger statement / day book rows navigate here). Fetched
  // by id — the bill may be outside the current list page.
  const [drillBillId, setDrillBillId] = useState<number | null>(() => {
    const n = Number(new URLSearchParams(window.location.search).get('view'));
    return Number.isFinite(n) && n > 0 ? n : null;
  });
  const { data: drillBill, error: drillError } = useGetPurchase(drillBillId ?? 0, { query: { enabled: !!drillBillId } } as any);
  useEffect(() => {
    if (!drillBillId) return;
    if (drillBill) {
      setViewItem(drillBill);
      setDrillBillId(null);
      window.history.replaceState({}, '', window.location.pathname);
    } else if (drillError) {
      toast.error('Purchase bill not found — it may have been deleted or belong to another location');
      setDrillBillId(null);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [drillBillId, drillBill, drillError]);
  const queryClient = useQueryClient();

  // Purchases change stock levels and dashboard KPIs — refresh them too.
  const invalidateStockDashboards = () =>
    queryClient.invalidateQueries({
      predicate: q => {
        const k = String(q.queryKey[0] ?? '');
        return k.startsWith('/api/dashboard') || k.startsWith('/api/stock')
          // A deleted bill may have consumed the vendor's advance / changed their dues.
          || k.startsWith('/api/accounts/party-advance') || k.startsWith('/api/accounts/settlement-context');
      },
    });

  const deleteMutation = useDeletePurchase();
  const { data: companySettings } = useGetCompanySettings();

  const getMaterialName = (li: any) => {
    if (li.materialName) return li.materialName; // server-enriched
    if (li.materialType === 'raw_material') return rawMaterials.find((m: any) => m.id === li.materialId)?.name || `Item #${li.materialId}`;
    if (li.materialType === 'item') return (finishedItems as any[]).find((m: any) => m.id === li.materialId)?.name || `Item #${li.materialId}`;
    return materials.find((m: any) => m.id === li.materialId)?.name || `Item #${li.materialId}`;
  };

  const handleDownloadPO = async (p: any) => {
    try {
      // The stored line already carries its name and unit; the client maps are
      // only a fallback for a bill saved before that enrichment existed.
      const lineItems = (p.lineItems ?? []).map((li: any) => ({
        ...li,
        materialName: li.materialName || getMaterialName(li),
      }));
      const vendor = (vendors as any[]).find((v: any) => v.id === p.vendorId);
      await downloadPurchaseInvoicePDF({ ...p, lineItems }, companySettings ?? {}, vendor);
    } catch {
      toast.error('Could not generate the purchase invoice PDF');
    }
  };

  const handleDelete = () => {
    if (!deleteTarget) return;
    deleteMutation.mutate(deleteTarget.id, {
      onSuccess: () => { toast.success(`Bill #${deleteTarget.id} deleted (stock reversed)`); queryClient.invalidateQueries({ queryKey: getListPurchasesQueryKey() }); invalidateStockDashboards(); setDeleteTarget(null); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Delete failed'),
    });
  };

  // Rows already match the server-side search — no client filtering needed
  const filtered = purchases;
  const { sorted, sort } = useTableSort(filtered, {
    bill: (p: any) => p.id,
    date: (p: any) => p.purchaseDate,
    vendor: (p: any) => p.vendorName,
    invoice: (p: any) => p.invoiceNumber,
    invDate: (p: any) => p.vendorInvoiceDate ?? null,
    location: (p: any) => p.locationName ?? 'Head Office',
    items: (p: any) => (p.lineItems as any[])?.length || 0,
    tax: (p: any) => Number(p.taxTotal || 0) || null,
    total: (p: any) => Number(p.totalAmount) + Number(p.otherChargesTotal || 0),
  });

  // Summary over the current page's already-fetched rows (server-paged list).
  const pageTaxTotal = filtered.reduce((s, p: any) => s + (Number((p as any).taxTotal) || 0), 0);
  const pagePayableTotal = filtered.reduce((s, p: any) => s + Number(p.totalAmount) + Number((p as any).otherChargesTotal || 0), 0);

  if (!perm.isLoading && !perm.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center py-32 text-muted-foreground gap-3">
          <AlertTriangle className="w-10 h-10 text-destructive/50" />
          <p className="text-lg font-medium">Access Denied</p>
          <p className="text-sm">You don't have permission to view Purchases.</p>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-6">
        <PageHeader
          title="Purchase Bills"
          description="Record purchases with GST, HSN code & discounts"
          icon={ShoppingCart}
          actions={<>
            {perm.canDownload && (
              <Button variant="outline" size="sm" onClick={() => downloadCSV('purchases.csv', filtered.map(p => ({
                'Bill #': p.id, Date: p.purchaseDate, Vendor: p.vendorName, Invoice: p.invoiceNumber || '',
                // Absent on historical bills — exported blank, never a fake date.
                'Vendor Inv Date': (p as any).vendorInvoiceDate || '',
                Location: (p as any).locationName ?? '',
                Items: (p.lineItems as any[])?.length || 0,
                'Taxable': Number((p as any).discountTotal ? Number(p.totalAmount) - Number((p as any).taxTotal || 0) : p.totalAmount),
                'Tax': Number((p as any).taxTotal || 0),
                'Total': Number(p.totalAmount),
                'Other Charges': Number((p as any).otherChargesTotal || 0),
                'Total Payable': Number(p.totalAmount) + Number((p as any).otherChargesTotal || 0),
              })))}>
                <Download className="w-4 h-4 mr-2" /> Export
              </Button>
            )}
            {perm.canAdd && (
              <Button onClick={() => navigate('/production/purchase/new')} data-testid="button-new-purchase">
                <Plus className="w-4 h-4 mr-2" /> New Purchase Bill
              </Button>
            )}
          </>}
        />

        <SummaryCardGrid>
          <SummaryCard label="Bills (this page)" value={filtered.length.toLocaleString('en-IN')} sub={`${totalPurchases.toLocaleString('en-IN')} total`} icon={FileText} tone="info" loading={isLoading} />
          <SummaryCard label="Vendors (this page)" value={new Set(filtered.map((p: any) => p.vendorId)).size.toLocaleString('en-IN')} icon={Receipt} loading={isLoading} />
          <SummaryCard label="Tax (this page)" value={`${inr(pageTaxTotal)}`} icon={Receipt} tone="warning" loading={isLoading} />
          <SummaryCard label="Payable (this page)" value={`${inr(pagePayableTotal)}`} icon={Wallet} tone="default" loading={isLoading} />
        </SummaryCardGrid>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex flex-wrap items-center gap-2 bg-muted/20">
            <Search className="w-4 h-4 text-muted-foreground shrink-0" />
            <Input placeholder="Search vendor or invoice..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0 max-w-sm max-md:max-w-full" />
            <div className="ml-auto"><RangeBar range={range} /></div>
          </div>
          <div className="hidden md:block">
          {isLoading ? (
            <TableSkeleton rows={6} cols={locations.isHeadOffice ? 10 : 9} />
          ) : filtered.length === 0 ? (
            <EmptyState icon={ShoppingCart} title="No purchase bills yet" hint="Record your first vendor bill." />
          ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <SortableHead k="bill" sort={sort}>Bill #</SortableHead>
                <SortableHead k="date" sort={sort}>Date</SortableHead>
                <SortableHead k="vendor" sort={sort}>Vendor</SortableHead>
                <SortableHead k="invoice" sort={sort}>Invoice Ref</SortableHead>
                <SortableHead k="invDate" sort={sort}>Vendor Inv Date</SortableHead>
                {locations.isHeadOffice && <SortableHead k="location" sort={sort}>Location</SortableHead>}
                <SortableHead k="items" sort={sort}>Items</SortableHead>
                <SortableHead k="tax" sort={sort} className="text-right">Tax</SortableHead>
                <SortableHead k="total" sort={sort} className="text-right">Total</SortableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map(p => (
                <TableRow key={p.id} className="hover:bg-muted/10">
                  <TableCell className="font-mono text-primary font-bold text-sm">#{String(p.id).padStart(4, '0')}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    <div className="flex items-center gap-1"><Calendar className="w-3 h-3" />{new Date(p.purchaseDate).toLocaleDateString('en-IN')}</div>
                  </TableCell>
                  <TableCell className="font-medium">{p.vendorName}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">{p.invoiceNumber || '—'}</TableCell>
                  {/* Legacy bills have no vendor invoice date — show a dash, never a fabricated date. */}
                  <TableCell className="text-muted-foreground text-sm">
                    {(p as any).vendorInvoiceDate ? new Date((p as any).vendorInvoiceDate).toLocaleDateString('en-IN') : '—'}
                  </TableCell>
                  {locations.isHeadOffice && (
                    <TableCell className="text-muted-foreground text-sm">{(p as any).locationName ?? 'Head Office'}</TableCell>
                  )}
                  <TableCell><Badge variant="secondary">{(p.lineItems as any[])?.length || 0} items</Badge></TableCell>
                  <TableCell className="text-right font-mono text-xs text-muted-foreground">
                    {Number((p as any).taxTotal || 0) > 0 ? `${inr(Number((p as any).taxTotal || 0))}` : '—'}
                  </TableCell>
                  <TableCell className="text-right font-mono font-bold text-primary">{inr(Number(p.totalAmount) + Number((p as any).otherChargesTotal || 0))}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(p)}><Eye className="w-4 h-4" /></Button>
                      {perm.canEdit && (
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => navigate(`/production/purchase/${p.id}/edit`)}>
                          <Edit2 className="w-4 h-4" />
                        </Button>
                      )}
                      {perm.canDelete && (
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-destructive" onClick={() => setDeleteTarget(p)}>
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          )}
          </div>

          {/* Mobile cards — same data, same handlers */}
          <div className="md:hidden">
            {isLoading ? (
              <div className="p-4 space-y-2">
                {[...Array(3)].map((_, i) => <div key={i} className="h-24 bg-muted/30 rounded-lg animate-pulse" />)}
              </div>
            ) : filtered.length === 0 ? (
              <EmptyState icon={ShoppingCart} title="No purchase bills yet" hint="Record your first vendor bill." compact />
            ) : (
              <div className="p-3 space-y-2">
                {sorted.map(p => (
                  <div key={p.id} className="border border-border rounded-lg p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-mono text-primary font-bold text-sm">#{String(p.id).padStart(4, '0')}</p>
                        <p className="font-medium text-sm truncate">{p.vendorName}</p>
                      </div>
                      <Badge variant="secondary" className="shrink-0">{(p.lineItems as any[])?.length || 0} items</Badge>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                      <div className="flex items-center gap-1 text-muted-foreground">
                        <Calendar className="w-3 h-3" />{new Date(p.purchaseDate).toLocaleDateString('en-IN')}
                      </div>
                      <div className="text-muted-foreground truncate">Ref: {p.invoiceNumber || '—'}</div>
                      <div className="text-muted-foreground truncate">
                        Inv Date: {(p as any).vendorInvoiceDate ? new Date((p as any).vendorInvoiceDate).toLocaleDateString('en-IN') : '—'}
                      </div>
                      {locations.isHeadOffice && (
                        <div className="text-muted-foreground truncate">Loc: {(p as any).locationName ?? 'Head Office'}</div>
                      )}
                      <div className="text-muted-foreground">
                        Tax: {Number((p as any).taxTotal || 0) > 0 ? `${inr(Number((p as any).taxTotal || 0))}` : '—'}
                      </div>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <span className="font-mono font-bold text-primary text-sm">{inr(Number(p.totalAmount) + Number((p as any).otherChargesTotal || 0))}</span>
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(p)}><Eye className="w-4 h-4" /></Button>
                        {perm.canEdit && (
                          <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => navigate(`/production/purchase/${p.id}/edit`)}><Edit2 className="w-4 h-4" /></Button>
                        )}
                        {perm.canDelete && (
                          <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-destructive" onClick={() => setDeleteTarget(p)}><Trash2 className="w-4 h-4" /></Button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {totalPurchases > 0 && (
            <div className="p-3 border-t border-border flex flex-wrap items-center justify-between gap-2">
              <span className="text-muted-foreground text-xs">
                Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, totalPurchases)} of {totalPurchases} bills
                {isFetching ? ' · refreshing…' : ''}
              </span>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Prev</Button>
                <span className="px-1 text-xs text-muted-foreground">Page {page}/{totalPages}</span>
                <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next</Button>
              </div>
            </div>
          )}
        </div>

      </div>

      {/* ── View Bill Sheet ── */}
      <Sheet open={!!viewItem} onOpenChange={v => !v && setViewItem(null)}>
        <SheetContent className="sm:max-w-2xl overflow-y-auto">
          {viewItem && (
            <>
              <SheetHeader className="mb-4">
                <SheetTitle className="text-primary">Purchase Bill #{String(viewItem.id).padStart(4, '0')}</SheetTitle>
                <SheetDescription>
                  {viewItem.vendorName} · {new Date(viewItem.purchaseDate).toLocaleDateString('en-IN')}
                  {viewItem.invoiceNumber && ` · Ref: ${viewItem.invoiceNumber}`}
                  {(viewItem as any).vendorInvoiceDate && ` · Vendor inv. dt: ${new Date((viewItem as any).vendorInvoiceDate).toLocaleDateString('en-IN')}`}
                  {` · received at ${(viewItem as any).locationName ?? 'Head Office'}`}
                </SheetDescription>
              </SheetHeader>

              {perm.canDownload && (
                <div className="flex justify-end mb-4">
                  <Button variant="outline" size="sm" onClick={() => handleDownloadPO(viewItem)}>
                    <FileDown className="w-4 h-4 mr-2" /> Download Invoice PDF
                  </Button>
                </div>
              )}

              {/* Line items table */}
              <div className="border border-border rounded-lg overflow-hidden mb-4">
                <table className="w-full text-xs">
                  <thead className="bg-muted/30">
                    <tr>
                      <th className="text-left px-3 py-2">Item</th>
                      <th className="text-left px-2 py-2">HSN</th>
                      <th className="text-right px-2 py-2">Qty</th>
                      <th className="text-right px-2 py-2">Rate</th>
                      <th className="text-right px-2 py-2">Disc%</th>
                      <th className="text-right px-2 py-2">Taxable</th>
                      <th className="text-right px-2 py-2">CGST</th>
                      <th className="text-right px-2 py-2">SGST</th>
                      <th className="text-right px-2 py-2">IGST</th>
                      <th className="text-right px-3 py-2">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(viewItem.lineItems as any[])?.map((li: any, i: number) => (
                      <tr key={i} className="border-t border-border hover:bg-muted/10">
                        <td className="px-3 py-2 font-medium">
                          {getMaterialName(li)}
                          {li.batchNumber && <span className="block text-[10px] font-mono text-muted-foreground">Lot {li.batchNumber}{li.expiryDate ? ` · exp ${new Date(li.expiryDate).toLocaleDateString('en-IN')}` : ''}</span>}
                        </td>
                        <td className="px-2 py-2 font-mono text-muted-foreground">{li.hsnCode || '—'}</td>
                        <td className="text-right px-2 py-2">{li.quantity}</td>
                        <td className="text-right px-2 py-2 font-mono">{inr(Number(li.unitCost))}</td>
                        <td className="text-right px-2 py-2">{Number(li.discount || 0) > 0 ? `${li.discount}%` : '—'}</td>
                        <td className="text-right px-2 py-2 font-mono">{inr(Number(li.taxableValue || (li.quantity * li.unitCost)))}</td>
                        <td className="text-right px-2 py-2 font-mono">{Number(li.cgst || 0) > 0 ? `${inr(Number(li.cgst))}` : '—'}</td>
                        <td className="text-right px-2 py-2 font-mono">{Number(li.sgst || 0) > 0 ? `${inr(Number(li.sgst))}` : '—'}</td>
                        <td className="text-right px-2 py-2 font-mono">{Number(li.igst || 0) > 0 ? `${inr(Number(li.igst))}` : '—'}</td>
                        <td className="text-right px-3 py-2 font-mono font-bold">{inr(Number(li.lineTotal || li.quantity * li.unitCost))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Summary — server figures, shown as stored. */}
              <div className="bg-muted/20 rounded-lg p-4 space-y-2 text-sm mb-4">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Rates entered</span>
                  <span className="font-medium">{(viewItem as any).priceMode === 'inclusive' ? 'GST inclusive' : 'GST exclusive'}</span>
                </div>
                {/* Absent on historical bills — the row simply doesn't show. */}
                {(viewItem as any).vendorInvoiceDate && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Vendor Invoice Date</span>
                    <span className="font-medium">{new Date((viewItem as any).vendorInvoiceDate).toLocaleDateString('en-IN')}</span>
                  </div>
                )}
                {Number(viewItem.discountTotal || 0) > 0 && (
                  <div className="flex justify-between"><span className="text-muted-foreground">(-) Discount</span><span className="font-mono text-red-500">-{inr(Number(viewItem.discountTotal))}</span></div>
                )}
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Taxable Amount</span>
                  <span className="font-mono">{inr(((viewItem.lineItems as any[]) ?? []).reduce((s, l) => s + Number(l.taxableValue || 0), 0))}</span>
                </div>
                {Number(viewItem.taxTotal || 0) > 0 && (
                  <div className="flex justify-between"><span className="text-muted-foreground">Tax</span><span className="font-mono">{inr(Number(viewItem.taxTotal))}</span></div>
                )}
                {Math.abs(Number(viewItem.roundOff || 0)) > 0.001 && (
                  <div className="flex justify-between"><span className="text-muted-foreground">Round Off</span><span className="font-mono">{inr(Number(viewItem.roundOff))}</span></div>
                )}
                <Separator />
                <div className="flex justify-between font-bold text-base"><span>{(((viewItem as any).otherCharges as any[]) ?? []).length > 0 ? 'Goods Total' : 'Grand Total'}</span><span className="font-mono text-primary">{inr(Number(viewItem.totalAmount))}</span></div>
                {(((viewItem as any).otherCharges as any[]) ?? []).length > 0 && (
                  <>
                    {(((viewItem as any).otherCharges as any[]) ?? []).map((c: any, i: number) => (
                      <div key={i} className="flex justify-between"><span className="text-muted-foreground">(+) {c.ledgerName || `Ledger #${c.ledgerId}`}</span><span className="font-mono">{inr(Number(c.amount))}</span></div>
                    ))}
                    <Separator />
                    <div className="flex justify-between font-bold text-base"><span>Total Payable</span><span className="font-mono text-primary">{inr(Number(viewItem.totalAmount) + Number((viewItem as any).otherChargesTotal ?? 0))}</span></div>
                  </>
                )}
              </div>

              {viewItem.notes && <p className="text-sm text-muted-foreground italic mb-4">{viewItem.notes}</p>}
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* ── Delete Confirm ── */}
      <Dialog open={!!deleteTarget} onOpenChange={v => !v && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle className="text-destructive flex items-center gap-2"><Trash2 className="w-5 h-5" />Delete Purchase Bill</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            Delete bill <span className="font-semibold text-foreground">#{deleteTarget?.id}</span> from <span className="font-semibold">{deleteTarget?.vendorName}</span>?
            <br /><span className="text-destructive text-xs font-medium mt-1 block">Stock additions from this bill will be reversed.</span>
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteMutation.isPending}>
              {deleteMutation.isPending ? 'Deleting…' : 'Delete & Reverse Stock'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
