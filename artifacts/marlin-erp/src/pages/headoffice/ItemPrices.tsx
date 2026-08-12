import { useMemo, useState } from 'react';
import { SearchableItemSelect } from '@/components/ui/searchable-item-select';
import { useListItemPrices, useSetItemPrice, useListItems, useListOutlets, useListWarehouses } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Plus, Search, Tag, Download, Edit2, Calendar, AlertTriangle, Building2, Store, Warehouse } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV } from '@/lib/download';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { usePermission } from '@/lib/usePermission';
import { activeProductsWithSelection } from '@/lib/productStatus';
import { useOutletsEnabled } from '@/lib/useFeatureFlags';
import { PageHeader } from '@/components/app/page-header';
import { SummaryCard, SummaryCardGrid } from '@/components/app/summary-card';
import { StatusBadge } from '@/components/app/status-badge';
import { EmptyState } from '@/components/app/empty-state';
import { TableSkeleton } from '@/components/app/loading-skeletons';
import { TablePager, useClientPage } from '@/components/ui/table-pager';
import { EntityCombobox } from '@/components/ui/entity-combobox';

type LocationType = 'headoffice' | 'warehouse' | 'outlet';

const LOCATION_TYPES: { value: LocationType; label: string; icon: React.ElementType; desc: string }[] = [
  { value: 'headoffice', label: 'Head Office', icon: Building2,  desc: 'Central head office pricing' },
  { value: 'warehouse',  label: 'Warehouse',   icon: Warehouse,  desc: 'Warehouse-specific pricing' },
  { value: 'outlet',     label: 'Outlet',      icon: Store,      desc: 'Retail outlet pricing' },
];

/** While outlets are retired no new outlet price can be set, but prices already
 *  recorded against an outlet stay listed so history reads correctly. */
const NON_OUTLET_LOCATION_TYPES = LOCATION_TYPES.filter(t => t.value !== 'outlet');

const schema = z.object({
  itemId:       z.coerce.number().min(1, 'Item required'),
  locationType: z.enum(['headoffice', 'warehouse', 'outlet']),
  locationId:   z.coerce.number().min(0),
  price:        z.coerce.number().min(0, 'Price ≥ 0'),
  validFrom:    z.string().optional(),
  validTo:      z.string().optional(),
}).refine(d => d.locationType === 'headoffice' || d.locationId > 0, {
  message: 'Please select a location',
  path: ['locationId'],
});
type FormValues = z.infer<typeof schema>;

export default function ItemPrices() {
  const perm = usePermission('page:/headoffice/item-price');
  const [search, setSearch]         = useState('');
  const [itemFilter, setItemFilter] = useState<string>('all');
  const [isOpen, setIsOpen]         = useState(false);
  const queryClient                 = useQueryClient();

  const { data: itemPrices = [], isLoading } = useListItemPrices();
  const { data: items      = [] }            = useListItems();
  const { data: outlets    = [] }            = useListOutlets();
  const { data: warehouses = [] }            = useListWarehouses();
  const upsertMutation                       = useSetItemPrice();

  const { outletsEnabled } = useOutletsEnabled();
  const locationTypeChoices = outletsEnabled ? LOCATION_TYPES : NON_OUTLET_LOCATION_TYPES;

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { itemId: 0, locationType: outletsEnabled ? 'outlet' : 'warehouse', locationId: 0, price: 0, validFrom: '', validTo: '' },
  });

  const watchedLocationType = form.watch('locationType');

  const openSet = (ip?: any) => {
    if (ip) {
      form.reset({
        itemId:       ip.itemId,
        locationType: ip.locationType ?? 'outlet',
        locationId:   ip.outletId ?? 0,
        price:        Number(ip.price),
        validFrom:    ip.validFrom  || '',
        validTo:      ip.validTo    || '',
      });
    } else {
      form.reset({ itemId: 0, locationType: outletsEnabled ? 'outlet' : 'warehouse', locationId: 0, price: 0, validFrom: '', validTo: '' });
    }
    setIsOpen(true);
  };

  const onSubmit = (data: FormValues) => {
    const payload: any = {
      itemId:       data.itemId,
      outletId:     data.locationType === 'headoffice' ? 0 : data.locationId,
      locationType: data.locationType,
      price:        Number(data.price),
      validFrom:    data.validFrom || undefined,
      validTo:      data.validTo   || undefined,
    };
    upsertMutation.mutate({ data: payload }, {
      onSuccess: () => {
        toast.success('Price updated');
        queryClient.invalidateQueries({ queryKey: ['/api/item-prices'] });
        setIsOpen(false);
      },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  const today = new Date().toISOString().split('T')[0];
  const isPriceActive = (ip: any) => {
    if (!ip.validFrom && !ip.validTo) return true;
    const fromOk = !ip.validFrom || ip.validFrom <= today;
    const toOk   = !ip.validTo   || ip.validTo   >= today;
    return fromOk && toOk;
  };

  // filters — build once so search/item filter stay upstream of sorting; merge
  // the computed active flag onto each row so the status accessor is row-local.
  const filtered = useMemo(() => {
    let rows = itemPrices.filter((ip: any) =>
      ip.itemName?.toLowerCase().includes(search.toLowerCase()) ||
      ip.outletName?.toLowerCase().includes(search.toLowerCase())
    );
    if (itemFilter !== 'all') rows = rows.filter((ip: any) => String(ip.itemId) === itemFilter);
    return rows.map((ip: any) => ({ ...ip, _active: isPriceActive(ip) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemPrices, search, itemFilter, today]);

  const { sorted, sort } = useTableSort(filtered, {
    itemName:  (ip: any) => ip.itemName,
    outletName:(ip: any) => ip.outletName,
    price:     (ip: any) => Number(ip.price),
    validFrom: (ip: any) => ip.validFrom || null,
    status:    (ip: any) => (ip._active ? 'Active' : 'Inactive'),
    updatedAt: (ip: any) => ip.updatedAt || null,
  });

  const { pageRows, pagerProps } = useClientPage(sorted);
  const activePriceCount = filtered.filter((ip: any) => ip._active).length;

  const locationTypeIcon = (lt: string) => {
    if (lt === 'warehouse')  return <Warehouse className="w-3.5 h-3.5 inline mr-1 text-blue-500"   />;
    if (lt === 'headoffice') return <Building2  className="w-3.5 h-3.5 inline mr-1 text-violet-500" />;
    return                          <Store      className="w-3.5 h-3.5 inline mr-1 text-green-500"  />;
  };

  if (!perm.isLoading && !perm.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center py-32 text-muted-foreground gap-3">
          <AlertTriangle className="w-10 h-10 text-destructive/50" />
          <p className="text-lg font-medium">Access Denied</p>
          <p className="text-sm">You don't have permission to view Item Prices.</p>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-6">
        <PageHeader
          title="Item Pricing"
          description="Set location-specific retail prices with optional validity periods"
          icon={Tag}
          actions={
            <>
              {perm.canDownload && (
                <Button variant="outline" size="sm" onClick={() => downloadCSV('item-prices.csv', filtered.map((ip: any) => ({
                  Item: ip.itemName, Location: ip.outletName, Type: ip.locationType,
                  'Price ₹': ip.price, 'Valid From': ip.validFrom || '', 'Valid To': ip.validTo || '',
                })))}>
                  <Download className="w-4 h-4 mr-2" /> Export
                </Button>
              )}
              {perm.canAdd && (
                <Button onClick={() => openSet()}><Plus className="w-4 h-4 mr-2" /> Set Price</Button>
              )}
            </>
          }
        />

        <SummaryCardGrid>
          <SummaryCard label="Price Rules" value={itemPrices.length.toLocaleString('en-IN')} icon={Tag} loading={isLoading} />
          <SummaryCard label="Active Now" value={activePriceCount.toLocaleString('en-IN')} icon={Calendar} tone="positive" loading={isLoading} />
        </SummaryCardGrid>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 flex-1 min-w-[200px]">
            <Search className="w-4 h-4 text-muted-foreground shrink-0" />
            <Input placeholder="Search item or location…" value={search} onChange={e => setSearch(e.target.value)} className="max-w-xs" />
          </div>
          {/* Every item, including discontinued ones, so historic prices stay
              reviewable. Id 0 is the "All Items" sentinel — real ids are positive. */}
          <SearchableItemSelect
            className="w-44"
            placeholder="All Items"
            items={[{ id: 0, name: 'All Items' }, ...items.map((i: any) => ({
              id: i.id, name: i.name, code: i.itemCode || null,
            }))]}
            value={itemFilter === 'all' ? 0 : Number(itemFilter)}
            onChange={id => setItemFilter(id === 0 ? 'all' : String(id))}
          />
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          {isLoading ? (
            <TableSkeleton rows={8} cols={perm.canEdit ? 7 : 6} />
          ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <SortableHead k="itemName" sort={sort}>Item</SortableHead>
                <SortableHead k="outletName" sort={sort}>Location</SortableHead>
                <SortableHead k="price" sort={sort} className="text-right">Price (₹)</SortableHead>
                <SortableHead k="validFrom" sort={sort}>Validity Period</SortableHead>
                <SortableHead k="status" sort={sort}>Status</SortableHead>
                <SortableHead k="updatedAt" sort={sort} className="text-right">Updated</SortableHead>
                {perm.canEdit && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="p-0">
                    <EmptyState icon={Tag} title="No prices configured yet" hint="Set a location-specific price to get started." compact />
                  </TableCell>
                </TableRow>
              ) : pageRows.map((ip: any, i: number) => {
                const active = ip._active;
                return (
                  <TableRow key={i} className="hover:bg-muted/10">
                    <TableCell className="font-semibold">{ip.itemName}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {locationTypeIcon(ip.locationType ?? 'outlet')}
                      {ip.outletName}
                    </TableCell>
                    <TableCell className="text-right font-mono font-bold text-primary text-lg">
                      ₹{Number(ip.price).toLocaleString('en-IN')}
                    </TableCell>
                    <TableCell>
                      {ip.validFrom || ip.validTo ? (
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Calendar className="w-3 h-3" />
                          <span>{ip.validFrom || '∞'} → {ip.validTo || '∞'}</span>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">Always valid</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={active ? 'active' : 'inactive'} label={active ? 'Active' : 'Inactive'} />
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {ip.updatedAt ? new Date(ip.updatedAt).toLocaleDateString('en-IN') : '—'}
                    </TableCell>
                    {perm.canEdit && (
                      <TableCell className="text-right">
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" title="Edit price" onClick={() => openSet(ip)}>
                          <Edit2 className="w-4 h-4" />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          )}
        </div>
        {!isLoading && filtered.length > 0 && <TablePager {...pagerProps} />}
      </div>

      {/* ── Set Price Dialog ── */}
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Set Item Price</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">

              {/* Item */}
              <FormField control={form.control} name="itemId" render={({ field }) => (
                <FormItem>
                  <FormLabel>Item <span className="text-destructive">*</span></FormLabel>
                  {/* Active only for new prices; an item already on the row
                      being edited stays listed. The filter dropdown above
                      still shows every item so old prices stay reviewable. */}
                  <FormControl><SearchableItemSelect
                    columns={['mrp']}
                    items={activeProductsWithSelection(items as any[], Number(field.value)).map((i: any) => ({
                      id: i.id,
                      name: i.name,
                      code: i.itemCode || null,
                      mrp: Number(i.mrp ?? 0),
                    }))}
                    value={field.value}
                    onChange={id => field.onChange(id)}
                  /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />

              {/* Location Type */}
              <FormField control={form.control} name="locationType" render={({ field }) => (
                <FormItem>
                  <FormLabel>Location Type <span className="text-destructive">*</span></FormLabel>
                  <div className="grid grid-cols-3 gap-2">
                    {locationTypeChoices.map(lt => {
                      const Icon = lt.icon;
                      const active = field.value === lt.value;
                      return (
                        <button
                          key={lt.value}
                          type="button"
                          onClick={() => {
                            field.onChange(lt.value);
                            form.setValue('locationId', 0);
                          }}
                          className={`flex flex-col items-center gap-1.5 p-3 rounded-lg border text-xs font-medium transition-all
                            ${active
                              ? 'border-primary bg-primary/10 text-primary'
                              : 'border-border bg-muted/20 text-muted-foreground hover:border-primary/40 hover:text-foreground'
                            }`}
                        >
                          <Icon className="w-5 h-5" />
                          {lt.label}
                        </button>
                      );
                    })}
                  </div>
                  <FormMessage />
                </FormItem>
              )} />

              {/* Location Selector — hidden for headoffice */}
              {watchedLocationType !== 'headoffice' && (
                <FormField control={form.control} name="locationId" render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      {watchedLocationType === 'warehouse' ? 'Warehouse' : 'Outlet'}
                      <span className="text-destructive"> *</span>
                    </FormLabel>
                    <FormControl>
                      <EntityCombobox
                        options={(watchedLocationType === 'warehouse' ? warehouses : outlets).map((l: any) => ({ id: l.id, label: l.name }))}
                        value={field.value || null}
                        onChange={id => field.onChange(id ?? 0)}
                        placeholder={`Select ${watchedLocationType === 'warehouse' ? 'warehouse' : 'outlet'}`}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              )}
              {watchedLocationType === 'headoffice' && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-violet-500/10 border border-violet-500/20 text-sm text-violet-700 dark:text-violet-300">
                  <Building2 className="w-4 h-4 shrink-0" />
                  <span>Price will apply to the Head Office</span>
                </div>
              )}

              {/* Price */}
              <FormField control={form.control} name="price" render={({ field }) => (
                <FormItem>
                  <FormLabel>Selling Price (₹) <span className="text-destructive">*</span></FormLabel>
                  <FormControl>
                    <Input type="number" step="0.01" min={0} placeholder="0.00" className="text-lg font-mono" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />

              {/* Validity period */}
              <div className="border-t border-border pt-3 space-y-3">
                <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Validity Period (optional)</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <FormField control={form.control} name="validFrom" render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs">Valid From</FormLabel>
                      <FormControl><Input type="date" {...field} value={field.value || ''} /></FormControl>
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="validTo" render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs">Valid To</FormLabel>
                      <FormControl><Input type="date" {...field} value={field.value || ''} /></FormControl>
                    </FormItem>
                  )} />
                </div>
                <p className="text-xs text-muted-foreground">Leave blank for the price to be always active</p>
              </div>

              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => setIsOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={upsertMutation.isPending}>
                  {upsertMutation.isPending ? 'Saving…' : 'Set Price'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
