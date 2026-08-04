import { Fragment, useEffect, useRef, useState } from 'react';
import { SearchableItemSelect } from '@/components/ui/searchable-item-select';
import {
  usePaginatedPurchases, useCreatePurchase, useListVendors, useListMaterials, useListRawMaterials, useListItems,
  getListPurchasesQueryKey, useUpdatePurchase, useDeletePurchase, useGetCompanySettings,
  useListWarehouses, useListOutlets, usePartyAdvance,
} from '@workspace/api-client-react';
import { downloadPurchaseInvoicePDF } from '@/lib/purchasePdf';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Plus, Search, Trash2, ShoppingCart, Download, Eye, Calendar, FileDown, Edit2, AlertTriangle, X } from 'lucide-react';
import { toast } from 'sonner';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { usePermission } from '@/lib/usePermission';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { activeProductsWithSelection } from '@/lib/productStatus';
import { useActingLocations, decodeLocation, encodeLocation } from '@/lib/useActingLocation';
import { useDateRange, RangeBar } from '@/pages/reports/shared';
import { useLocationContext, locationFilterParams } from '@/lib/locationContext';
import { Separator } from '@/components/ui/separator';
// The same arithmetic the server posts with. Imported rather than re-typed so
// the preview in this form and the figures written to the books cannot drift.
import { calcPurchaseBill, calcPurchaseLine, type PriceMode } from '@workspace/purchase-pricing';
import { useQueryClient } from '@tanstack/react-query';
import { autoFocusFirst, useEntryShortcuts } from '@/lib/keyboard-entry';

const GST_RATES = [0, 5, 12, 18, 28] as const;

const lineSchema = z.object({
  materialType: z.enum(['material', 'raw_material', 'item']),
  materialId: z.coerce.number().min(1, 'Select item'),
  // HSN is TEXT, never a number: 08045020 must not become 8045020.
  hsnCode: z.string().trim().regex(/^(\d{4,8})?$/, 'HSN must be 4-8 digits').optional(),
  quantity: z.coerce.number().min(0.001, 'Qty > 0'),
  unitCost: z.coerce.number().min(0, 'Rate ≥ 0'),
  discount: z.coerce.number().min(0).max(100).default(0),
  gstRate: z.coerce.number().default(0),
  taxType: z.enum(['intra', 'inter']).default('intra'),
  /** Set only when the user changes the GST type away from the derived one. */
  taxTypeOverride: z.boolean().default(false),
  // Blank means "issue one on save" — the server allocates PUR-YYYYMMDD-NNNNN.
  batchNumber: z.string().optional(),
  mfgDate: z.string().min(1, 'Mfg date required'),
  expiryDate: z.string().min(1, 'Expiry date required'),
}).refine(l => !l.expiryDate || !l.mfgDate || l.expiryDate >= l.mfgDate, {
  message: 'Expiry cannot be before manufacture', path: ['expiryDate'],
});

const schema = z.object({
  vendorId: z.coerce.number().min(1, 'Vendor required'),
  purchaseDate: z.string().min(1, 'Date required'),
  invoiceNumber: z.string().optional(),
  location: z.string().min(1, 'Location required'),
  // Whether the rates below include GST. Recorded with the bill, never guessed
  // from the amounts: at 5%, a rate of 105 is a valid inclusive line and an
  // equally valid exclusive one.
  priceMode: z.enum(['exclusive', 'inclusive']).default('exclusive'),
  lineItems: z.array(lineSchema).min(1, 'Add at least one item'),
  notes: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

const defaultLine = { materialType: 'raw_material' as const, materialId: 0, hsnCode: '', quantity: 1, unitCost: 0, discount: 0, gstRate: 5, taxType: 'intra' as const, taxTypeOverride: false, batchNumber: '', mfgDate: '', expiryDate: '' };

/** One shared column template for the item grid header and every row, so the
 *  columns can never drift out of alignment. Item name gets the widest,
 *  flexible column; the numeric columns are fixed so nothing overlaps. */
const PURCHASE_GRID = 'minmax(230px,1fr) 100px 76px 96px 76px 84px 110px 32px';

function fmt(n: number) { return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

/** Two-letter state code out of a GSTIN, for the intra/inter hint. */
const gstinState = (g: unknown) => {
  const s = String(g ?? '').trim();
  return /^\d{2}[A-Za-z0-9]{13}$/.test(s) ? s.slice(0, 2) : null;
};
const plainState = (s: unknown) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
export default function Purchases() {
  const perm = usePermission('page:/production/purchase');
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
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [viewItem, setViewItem] = useState<any>(null);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const queryClient = useQueryClient();

  // Purchases change stock levels and dashboard KPIs — refresh them too.
  const invalidateStockDashboards = () =>
    queryClient.invalidateQueries({
      predicate: q => {
        const k = String(q.queryKey[0] ?? '');
        return k.startsWith('/api/dashboard') || k.startsWith('/api/stock')
          // A bill may have consumed the vendor's advance / changed their dues.
          || k.startsWith('/api/accounts/party-advance') || k.startsWith('/api/accounts/settlement-context');
      },
    });

  const createMutation = useCreatePurchase();
  const updateMutation = useUpdatePurchase();
  const deleteMutation = useDeletePurchase();

  const { data: companySettings } = useGetCompanySettings();
  // Branch registrations, for the intra/inter hint on the entry form.
  const { data: warehouses = [] } = useListWarehouses();
  const { data: outlets = [] } = useListOutlets();

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

  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { vendorId: 0, purchaseDate: new Date().toISOString().split('T')[0], invoiceNumber: '', location: 'headoffice:1', priceMode: 'exclusive', lineItems: [defaultLine], notes: '' } });

  // Advance adjustment: does the selected vendor hold money we paid beyond
  // their bills? Create only — edits never touch the advance.
  const watchVendorId = form.watch('vendorId');
  const { data: vendorAdvance } = usePartyAdvance('vendor', editingId !== null ? null : (Number(watchVendorId) || null));
  const [applyAdvance, setApplyAdvance] = useState(true);
  useEffect(() => { setApplyAdvance(true); }, [watchVendorId]);
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'lineItems' });
  const watchLines = form.watch('lineItems');
  const priceMode = (form.watch('priceMode') ?? 'exclusive') as PriceMode;
  // Bill-level GST type is a view over the lines: the selector writes every
  // line at once, so line 0 is the bill's value. The payload keeps carrying
  // taxType per line — the server posts exactly as before.
  const billTaxType = (watchLines?.[0]?.taxType ?? 'intra') as 'intra' | 'inter';
  const billTaxTypeOverridden = Boolean(watchLines?.some(l => l?.taxTypeOverride));
  // A bill saved under the old per-line control can carry BOTH types. The
  // selector must not silently pretend line 0 speaks for the whole bill, so a
  // mixed bill gets a visible warning until the user picks a type (which then
  // applies to every line). Until they do, the stored lines go back unchanged.
  const billTaxMixed = (watchLines ?? []).some(l => ((l?.taxType ?? 'intra') as string) !== billTaxType);

  // Bill summary — one shared calculation, so the footer is exactly what the
  // server will store: per-line rounding to paise, then whole-rupee round-off.
  const bill = calcPurchaseBill(
    (watchLines ?? []).map(li => ({
      quantity: li?.quantity, unitCost: li?.unitCost, discount: li?.discount,
      gstRate: li?.gstRate, taxType: li?.taxType,
    })),
    priceMode,
  );

  // ── Item Master defaults ───────────────────────────────────────────────────
  const masterFor = (kind: string, id: number): any => {
    const list = kind === 'raw_material' ? rawMaterials : kind === 'item' ? finishedItems : materials;
    return (list as any[]).find((m: any) => Number(m.id) === Number(id));
  };

  /** Choosing a product pulls its HSN and GST rate off the Item Master. Both
   *  stay editable: the master is only a default, and the bill keeps whatever
   *  was actually charged rather than following later master changes. */
  const applyMasterDefaults = (index: number, kind: string, id: number) => {
    const m = masterFor(kind, id);
    if (!m) return;
    const hsn = String(m.hsnCode ?? '').trim();
    if (hsn) form.setValue(`lineItems.${index}.hsnCode`, hsn, { shouldDirty: true });
    const rate = Number(m.taxRate);
    if (Number.isFinite(rate)) form.setValue(`lineItems.${index}.gstRate`, rate, { shouldDirty: true });
  };

  // ── Intra/inter hint ───────────────────────────────────────────────────────
  // A hint only. The server re-derives this from the vendor's and the receiving
  // location's registrations and its answer wins, so a stale value here cannot
  // decide which GST heads the input credit lands in.
  const selectedVendor = (vendors as any[]).find((v: any) => Number(v.id) === Number(form.watch('vendorId')));
  // Compared against the RECEIVING location's own registration, the way the
  // server does it — a branch in another state has its own GSTIN, and hinting
  // off the company's would show CGST+SGST on a bill the server posts as IGST.
  const watchedLocation = form.watch('location');
  const buyerRegistration = (() => {
    const picked = decodeLocation(locations.canChoose ? watchedLocation : locations.defaultValue);
    if (picked.locationType === 'warehouse') {
      const w = (warehouses as any[]).find((x: any) => Number(x.id) === Number(picked.locationId));
      if (w?.gstin || w?.gstNumber || w?.state) return { gstNumber: w.gstin ?? w.gstNumber, state: w.state };
    }
    if (picked.locationType === 'outlet') {
      const o = (outlets as any[]).find((x: any) => Number(x.id) === Number(picked.locationId));
      if (o?.gstin || o?.gstNumber || o?.state) return { gstNumber: o.gstin ?? o.gstNumber, state: o.state };
    }
    // Head Office, or a location with no registration of its own.
    return { gstNumber: (companySettings as any)?.gstNumber, state: (companySettings as any)?.state };
  })();
  const hintTaxType: 'intra' | 'inter' | null = (() => {
    if (!selectedVendor) return null;
    const vc = gstinState(selectedVendor.gstNumber), cc = gstinState(buyerRegistration.gstNumber);
    if (vc && cc) return vc === cc ? 'intra' : 'inter';
    const vs = plainState(selectedVendor.state), cs = plainState(buyerRegistration.state);
    if (vs && cs) return vs === cs ? 'intra' : 'inter';
    return null;
  })();

  useEffect(() => {
    if (!hintTaxType) return;
    (form.getValues('lineItems') ?? []).forEach((l: any, i: number) => {
      if (!l?.taxTypeOverride && l?.taxType !== hintTaxType) {
        form.setValue(`lineItems.${i}.taxType`, hintTaxType);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hintTaxType, fields.length]);

  const resetForm = () => form.reset({ vendorId: 0, purchaseDate: new Date().toISOString().split('T')[0], invoiceNumber: '', location: locations.defaultValue, priceMode: 'exclusive', lineItems: [defaultLine], notes: '' });

  /** data-testid of the ONE category trigger auto-opened by Add Line (null =
   *  none): when THAT select closes (Enter pick, re-pick of the default, or
   *  Escape), focus hops on to its row's Item picker. Row-scoped and set only
   *  after a VERIFIED open, so a failed open or a manual mouse edit of another
   *  row's category can never hijack focus. Cleared when the dialog closes. */
  const autoAdvanceCatRef = useRef<string | null>(null);
  useEffect(() => { if (!isOpen) autoAdvanceCatRef.current = null; }, [isOpen]);

  /** Radix triggers open on different gestures: the category <Select> listens
   *  for pointerdown, the item picker's Popover for click. Each helper sends
   *  exactly the one its target reacts to — sending both would toggle twice. */
  const openCategorySelect = (el?: HTMLButtonElement | null): boolean => {
    if (!el) return false;
    el.focus();
    // Radix versions differ in which gesture opens a Select trigger, so try
    // pointerdown → ArrowDown → click, checking aria-expanded between attempts
    // (discrete events flush synchronously) so nothing toggles twice.
    const isOpen = () => el.getAttribute('aria-expanded') === 'true';
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }));
    if (isOpen()) return true;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    if (isOpen()) return true;
    el.click();
    return isOpen();
  };
  const openItemPicker = (el?: HTMLButtonElement | null) => {
    if (!el) return;
    el.focus();
    el.click(); // opens the picker; its search box takes focus on open
  };

  /** Add Line for the keyboard workflow: append the row, then land focus on
   *  the new row's Item Category dropdown and open it — arrow keys + Enter
   *  pick the category, then focus flows on to the Item picker (see
   *  autoAdvanceCatRef). setTimeout(0) lets React commit the new row first;
   *  the appended row is always the LAST trigger in the dialog. */
  const addLine = () => {
    append({ ...defaultLine, taxType: billTaxType, taxTypeOverride: billTaxTypeOverridden });
    setTimeout(() => {
      const triggers = document.querySelectorAll<HTMLButtonElement>('[data-testid^="purchase-line-cat-"]');
      const el = triggers[triggers.length - 1];
      autoAdvanceCatRef.current = el && openCategorySelect(el) ? el.getAttribute('data-testid') : null;
    }, 0);
  };

  /** Enter inside a line-item text input must never fall through to the form's
   *  implicit submission (half-typed bills were one Enter away from saving).
   *  On the row's LAST field (Expiry) Enter acts as Add Line; on every other
   *  input it walks to the next field in the row's tab order, like Tab. Radix
   *  selects and the item picker handle Enter themselves and are left alone. */
  /** Delete a line for the keyboard workflow — mirrors the row X button, which
   *  is disabled while only one line remains, so the minimum-row rule holds. */
  const deleteLine = (index: number) => {
    if (fields.length <= 1) return;
    remove(index);
  };

  const handleLineKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Delete / Ctrl+Delete inside a [data-kbd-row] removes that line — the same
    // rule the shared machinery applies (plain Delete in a text field still
    // edits characters). Handled here so the container keeps its one keydown.
    if (e.key === 'Delete') {
      const t0 = e.target as HTMLElement;
      const inTextField = t0 instanceof HTMLInputElement || t0 instanceof HTMLTextAreaElement;
      if (!inTextField || e.ctrlKey) {
        const row = t0.closest<HTMLElement>('[data-kbd-row]');
        if (row) {
          e.preventDefault();
          deleteLine(Number(row.getAttribute('data-kbd-row')));
        }
      }
      return;
    }
    if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target as HTMLElement;
    if (!(t instanceof HTMLInputElement)) return;
    e.preventDefault();
    if (t.dataset.lastField === '1') { addLine(); return; }
    const container = e.currentTarget;
    const focusables = Array.from(
      container.querySelectorAll<HTMLElement>('input, button, [role="combobox"]'),
    ).filter(el => el.tabIndex >= 0 && !el.hasAttribute('disabled'));
    const i = focusables.indexOf(t);
    if (i >= 0) focusables[i + 1]?.focus();
  };

  // Document-level Ctrl+S / Ctrl+Enter (save) and F4 (Add Line) while the entry
  // dialog is open — same guarded submit/addLine used everywhere else.
  useEntryShortcuts(isOpen, {
    onSave: () => {
      if (createMutation.isPending || updateMutation.isPending) return;
      form.handleSubmit(onSubmit)();
    },
    onAddLine: addLine,
  });

  /** The server may correct the GST type or report anything else it changed —
   *  surfaced rather than swallowed, so a corrected bill is never a surprise. */
  const showWarnings = (resp: any) => {
    for (const w of (resp?.warnings ?? []) as string[]) toast.warning(w);
  };

  const onSubmit = (form0: FormValues) => {
    // Double-submit guard for the Enter key, which bypasses the disabled button.
    if (createMutation.isPending || updateMutation.isPending) return;
    const { location, ...rest } = form0;
    // A user who cannot choose is always pinned to their own location, even if
    // the picker had not resolved `me` yet when the dialog opened.
    const data = {
      ...rest,
      ...decodeLocation(locations.canChoose ? location : locations.defaultValue),
      // Advance adjustment — opt-in; the server caps at what the books hold.
      ...(editingId === null && applyAdvance && (vendorAdvance?.available ?? 0) > 0.004
        ? { useAdvance: true } : {}),
    };
    if (editingId !== null) {
      updateMutation.mutate({ id: editingId, data: data as any }, {
        onSuccess: (resp: any) => {
          toast.success('Purchase bill updated');
          showWarnings(resp);
          queryClient.invalidateQueries({ queryKey: getListPurchasesQueryKey() });
          invalidateStockDashboards();
          setIsOpen(false);
          setEditingId(null);
          resetForm();
        },
        onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
      });
    } else {
      createMutation.mutate({ data: data as any }, {
        onSuccess: (resp: any) => {
          const lots = ((resp?.lineItems ?? []) as any[]).map(l => l?.batchNumber).filter(Boolean);
          toast.success(lots.length ? `Purchase bill created · batch ${lots.join(', ')}` : 'Purchase bill created');
          showWarnings(resp);
          queryClient.invalidateQueries({ queryKey: getListPurchasesQueryKey() });
          invalidateStockDashboards();
          setIsOpen(false);
          resetForm();
        },
        onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
      });
    }
  };

  const openEdit = (p: any) => {
    setEditingId(p.id);
    form.reset({
      vendorId: p.vendorId,
      purchaseDate: (p.purchaseDate ?? '').substring(0, 10) || new Date().toISOString().split('T')[0],
      invoiceNumber: p.invoiceNumber || '',
      location: encodeLocation((p as any).locationType ?? 'headoffice', Number((p as any).locationId ?? 1)),
      // The bill's own rate mode, not a fresh default:
      // re-opening an inclusive bill as exclusive would
      // restate every figure on it.
      priceMode: ((p as any).priceMode === 'inclusive' ? 'inclusive' : 'exclusive'),
      notes: (p as any).notes || '',
      lineItems: ((p.lineItems as any[]) || []).map((li: any) => ({
        materialType: li.materialType || 'raw_material',
        materialId: li.materialId,
        hsnCode: li.hsnCode || '',
        quantity: Number(li.quantity),
        unitCost: Number(li.unitCost),
        discount: Number(li.discount || 0),
        gstRate: Number(li.gstRate || 0),
        taxType: li.taxType || 'intra',
        // An existing line keeps the GST type it was saved
        // with unless the user changes it again.
        taxTypeOverride: li.taxTypeSource === 'override',
        batchNumber: li.batchNumber || '',
        mfgDate: (li.mfgDate ?? '').substring(0, 10),
        expiryDate: (li.expiryDate ?? '').substring(0, 10),
      })),
    });
    setIsOpen(true);
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
    location: (p: any) => p.locationName ?? 'Head Office',
    items: (p: any) => (p.lineItems as any[])?.length || 0,
    tax: (p: any) => Number(p.taxTotal || 0) || null,
    total: (p: any) => Number(p.totalAmount),
  });

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
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><ShoppingCart className="w-6 h-6 text-primary" /> Purchase Bills</h1>
            <p className="text-muted-foreground mt-1">Record purchases with GST, HSN code & discounts</p>
          </div>
          <div className="flex gap-2">
            {perm.canDownload && (
              <Button variant="outline" size="sm" onClick={() => downloadCSV('purchases.csv', filtered.map(p => ({
                'Bill #': p.id, Date: p.purchaseDate, Vendor: p.vendorName, Invoice: p.invoiceNumber || '',
                Location: (p as any).locationName ?? '',
                Items: (p.lineItems as any[])?.length || 0,
                'Taxable': Number((p as any).discountTotal ? Number(p.totalAmount) - Number((p as any).taxTotal || 0) : p.totalAmount),
                'Tax': Number((p as any).taxTotal || 0),
                'Total': Number(p.totalAmount),
              })))}>
                <Download className="w-4 h-4 mr-2" /> Export
              </Button>
            )}
            {perm.canAdd && (
              <Button onClick={() => { setEditingId(null); resetForm(); setIsOpen(true); }}>
                <Plus className="w-4 h-4 mr-2" /> New Purchase Bill
              </Button>
            )}
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex flex-wrap items-center gap-2 bg-muted/20">
            <Search className="w-4 h-4 text-muted-foreground shrink-0" />
            <Input placeholder="Search vendor or invoice..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0 max-w-sm max-md:max-w-full" />
            <div className="ml-auto"><RangeBar range={range} /></div>
          </div>
          <div className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <SortableHead k="bill" sort={sort}>Bill #</SortableHead>
                <SortableHead k="date" sort={sort}>Date</SortableHead>
                <SortableHead k="vendor" sort={sort}>Vendor</SortableHead>
                <SortableHead k="invoice" sort={sort}>Invoice Ref</SortableHead>
                {locations.isHeadOffice && <SortableHead k="location" sort={sort}>Location</SortableHead>}
                <SortableHead k="items" sort={sort}>Items</SortableHead>
                <SortableHead k="tax" sort={sort} className="text-right">Tax</SortableHead>
                <SortableHead k="total" sort={sort} className="text-right">Total</SortableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(3)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={locations.isHeadOffice ? 9 : 8}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={locations.isHeadOffice ? 9 : 8} className="text-center py-16 text-muted-foreground">
                  <ShoppingCart className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No purchase bills yet</p>
                </TableCell></TableRow>
              ) : sorted.map(p => (
                <TableRow key={p.id} className="hover:bg-muted/10">
                  <TableCell className="font-mono text-primary font-bold text-sm">#{String(p.id).padStart(4, '0')}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    <div className="flex items-center gap-1"><Calendar className="w-3 h-3" />{new Date(p.purchaseDate).toLocaleDateString('en-IN')}</div>
                  </TableCell>
                  <TableCell className="font-medium">{p.vendorName}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">{p.invoiceNumber || '—'}</TableCell>
                  {locations.isHeadOffice && (
                    <TableCell className="text-muted-foreground text-sm">{(p as any).locationName ?? 'Head Office'}</TableCell>
                  )}
                  <TableCell><Badge variant="secondary">{(p.lineItems as any[])?.length || 0} items</Badge></TableCell>
                  <TableCell className="text-right font-mono text-xs text-muted-foreground">
                    {Number((p as any).taxTotal || 0) > 0 ? `₹${fmt(Number((p as any).taxTotal || 0))}` : '—'}
                  </TableCell>
                  <TableCell className="text-right font-mono font-bold text-primary">₹{fmt(Number(p.totalAmount))}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(p)}><Eye className="w-4 h-4" /></Button>
                      {perm.canEdit && (
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => openEdit(p)}>
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
          </div>

          {/* Mobile cards — same data, same handlers */}
          <div className="md:hidden">
            {isLoading ? (
              <div className="p-4 space-y-2">
                {[...Array(3)].map((_, i) => <div key={i} className="h-24 bg-muted/30 rounded-lg animate-pulse" />)}
              </div>
            ) : filtered.length === 0 ? (
              <div className="text-center py-16 text-muted-foreground">
                <ShoppingCart className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No purchase bills yet</p>
              </div>
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
                      {locations.isHeadOffice && (
                        <div className="text-muted-foreground truncate">Loc: {(p as any).locationName ?? 'Head Office'}</div>
                      )}
                      <div className="text-muted-foreground">
                        Tax: {Number((p as any).taxTotal || 0) > 0 ? `₹${fmt(Number((p as any).taxTotal || 0))}` : '—'}
                      </div>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <span className="font-mono font-bold text-primary text-sm">₹{fmt(Number(p.totalAmount))}</span>
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(p)}><Eye className="w-4 h-4" /></Button>
                        {perm.canEdit && (
                          <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => openEdit(p)}><Edit2 className="w-4 h-4" /></Button>
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

      {/* ── New / Edit Purchase Bill Dialog ── */}
      <Dialog open={isOpen} onOpenChange={v => { setIsOpen(v); if (!v) { setEditingId(null); resetForm(); } }}>
        <DialogContent className="sm:max-w-6xl max-h-[90vh] overflow-y-auto" onOpenAutoFocus={autoFocusFirst}>
          <DialogHeader>
            <DialogTitle>
              {editingId !== null ? `Edit Purchase Bill #${String(editingId).padStart(4, '0')}` : 'New Purchase Bill'}
            </DialogTitle>
            <DialogDescription>Enter purchase details with HSN, GST rate and discount per item</DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6 pt-2">
              {/* Header — Vendor · Date · Invoice Ref · Receiving Location in
                  ONE evenly-spaced row (stacks on small screens). */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 items-start">
                <FormField control={form.control} name="vendorId" render={({ field }) => (
                  <FormItem><FormLabel>Vendor <span className="text-destructive">*</span></FormLabel>
                    <Select onValueChange={v => field.onChange(Number(v))} value={field.value ? String(field.value) : ''}>
                      <FormControl><SelectTrigger><SelectValue placeholder="Select vendor" /></SelectTrigger></FormControl>
                      <SelectContent>{vendors.map((v: any) => <SelectItem key={v.id} value={String(v.id)}>{v.name}</SelectItem>)}</SelectContent>
                    </Select><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="purchaseDate" render={({ field }) => (
                  <FormItem><FormLabel>Date <span className="text-destructive">*</span></FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="invoiceNumber" render={({ field }) => (
                  <FormItem><FormLabel>Invoice Ref #</FormLabel><FormControl><Input placeholder="Vendor's invoice no." {...field} /></FormControl></FormItem>
                )} />
                {/* Receiving location. Changeable on edit too: the server
                    reverses stock at the old location and re-applies it (with
                    the payable and input GST) at the new one, in one
                    transaction — refused if the goods were already consumed. */}
                <FormField control={form.control} name="location" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Receiving Location <span className="text-destructive">*</span></FormLabel>
                    {locations.canChoose ? (
                      <>
                        <Select onValueChange={field.onChange} value={field.value || locations.defaultValue}>
                          <FormControl><SelectTrigger><SelectValue placeholder="Select location" /></SelectTrigger></FormControl>
                          <SelectContent>{locations.options.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
                        </Select>
                        <p className="text-[10px] text-muted-foreground">
                          {editingId !== null
                            ? 'Changing this moves the bill\u2019s stock, vendor payable and input GST to the new location.'
                            : 'Stock, input GST and the vendor payable are booked here.'}
                        </p>
                      </>
                    ) : (
                      <div className="h-9 flex items-center px-3 rounded-md border border-border bg-muted/30 text-sm font-medium">
                        {locations.labelFor(field.value)}
                      </div>
                    )}
                    <FormMessage />
                  </FormItem>
                )} />
                {/* Advance adjustment — a vendor holding money we paid beyond
                    their bills can have it auto-applied to this bill. */}
                {editingId === null && (vendorAdvance?.available ?? 0) > 0.004 && (
                  <label className="sm:col-span-2 lg:col-span-4 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm cursor-pointer">
                    <Checkbox checked={applyAdvance} onCheckedChange={v => setApplyAdvance(v === true)} />
                    <span>
                      Adjust available advance of <span className="font-mono font-semibold">₹{Number(vendorAdvance!.available).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span> against this bill
                    </span>
                  </label>
                )}
              </div>

              {/* Line Items */}
              <div>
                <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 mb-3">
                  <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
                    <div className="text-sm font-medium pb-2">Line Items</div>
                    {/* Bill-level rate mode. Stored with the bill and never
                        guessed from the amounts. */}
                    <FormField control={form.control} name="priceMode" render={({ field }) => (
                      <FormItem className="space-y-1">
                        <FormLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">GST Mode</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value || 'exclusive'}>
                          <FormControl><SelectTrigger className="h-8 text-xs w-[150px]"><SelectValue /></SelectTrigger></FormControl>
                          <SelectContent>
                            <SelectItem value="exclusive">GST exclusive</SelectItem>
                            <SelectItem value="inclusive">GST inclusive</SelectItem>
                          </SelectContent>
                        </Select>
                      </FormItem>
                    )} />
                    {/* Bill-level GST type. One choice for the whole bill —
                        applied to every line (the payload still carries it per
                        line, so the server posts exactly as before). Changing
                        it away from the state-derived hint marks the lines as
                        explicit overrides, which the server preserves. */}
                    <div className="space-y-1">
                      <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">GST Type</div>
                      <Select
                        onValueChange={v => {
                          (form.getValues('lineItems') ?? []).forEach((_l, i) => {
                            form.setValue(`lineItems.${i}.taxType`, v as 'intra' | 'inter');
                            form.setValue(`lineItems.${i}.taxTypeOverride`, hintTaxType !== null && v !== hintTaxType);
                          });
                        }}
                        value={billTaxType}
                      >
                        <SelectTrigger className={`h-8 text-xs w-[150px] ${billTaxMixed || billTaxTypeOverridden ? 'border-amber-500' : ''}`}><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="intra">Intra State (CGST+SGST)</SelectItem>
                          <SelectItem value="inter">Inter State (IGST)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {billTaxMixed ? (
                      <p className="text-[10px] text-amber-600 pb-2 max-w-[360px]">
                        This bill's lines carry different GST types (saved under the old per-line control).
                        They are kept as-is unless you pick a GST Type, which then applies to every line.
                      </p>
                    ) : billTaxTypeOverridden ? (
                      <p className="text-[10px] text-amber-600 pb-2">
                        Differs from the type suggested by the vendor's and receiving location's registrations.
                      </p>
                    ) : null}
                  </div>
                  <p className="text-[11px] text-muted-foreground pb-1">
                    {priceMode === 'inclusive'
                      ? 'Rates include GST — tax is worked back out of the rate.'
                      : 'GST is added on top of the rate.'}
                    {' '}Mfg and expiry dates are required; leave batch blank to have one issued.
                  </p>
                </div>
                <div className="border border-border rounded-lg overflow-x-auto">
                  {/* One Enter handler for every line input: next field, or Add
                      Line from the row's last field. See handleLineKeyDown. */}
                  <div className="min-w-[890px]" data-kbd-scope onKeyDown={handleLineKeyDown}>
                  <div className="grid gap-2 bg-muted/30 text-xs font-medium text-muted-foreground uppercase tracking-wide px-3 py-2.5 max-md:sticky max-md:top-0 max-md:z-10" style={{ gridTemplateColumns: PURCHASE_GRID }}>
                    <span>Item Name</span>
                    <span>HSN Code</span>
                    <span className="text-right">Qty</span>
                    <span className="text-right">Rate ₹</span>
                    <span className="text-right">Disc %</span>
                    <span className="text-center">GST %</span>
                    <span className="text-right">Total ₹</span>
                    <span />
                  </div>
                  {fields.map((field, index) => {
                    const li: any = watchLines[index] || {};
                    const calc = calcPurchaseLine(
                      { quantity: li.quantity, unitCost: li.unitCost, discount: li.discount, gstRate: li.gstRate, taxType: li.taxType },
                      priceMode,
                    );
                    return (
                      <Fragment key={field.id}>
                      <div data-kbd-row={index} className="grid items-center gap-2 px-3 py-2.5 border-t border-border" style={{ gridTemplateColumns: PURCHASE_GRID }}>
                        {/* Item type + item selector combined */}
                        <div className="flex gap-1 min-w-0">
                          <Select
                            onValueChange={v => form.setValue(`lineItems.${index}.materialType`, v as any)}
                            value={form.watch(`lineItems.${index}.materialType`)}
                          >
                            <SelectTrigger data-testid={`purchase-line-cat-${index}`} className="w-[92px] shrink-0 text-xs h-9"><SelectValue /></SelectTrigger>
                            {/* Closing an auto-opened category dropdown moves the
                                user on to this row's Item picker. Intercepted at
                                onCloseAutoFocus — Radix's own focus restoration —
                                because letting it refocus the trigger AFTER we
                                opened the picker made the picker dismiss itself
                                (focus-outside). Not onValueChange: re-picking the
                                already selected category fires no value change. */}
                            <SelectContent
                              onCloseAutoFocus={e => {
                                if (autoAdvanceCatRef.current === `purchase-line-cat-${index}`) {
                                  autoAdvanceCatRef.current = null;
                                  e.preventDefault();
                                  // Deferred one tick: when the close came from
                                  // Escape, opening the picker synchronously let
                                  // that same Escape reach the picker's dismiss
                                  // layer and shut it again.
                                  setTimeout(() => openItemPicker(document.querySelector<HTMLButtonElement>(`[data-testid="purchase-line-item-${index}"]`)), 0);
                                }
                              }}
                            >
                              <SelectItem value="raw_material">Packing Material</SelectItem>
                              <SelectItem value="material">Raw Material</SelectItem>
                              <SelectItem value="item">Item Name (SKU)</SelectItem>
                            </SelectContent>
                          </Select>
                          {/* Purchasing cares about the tax identity of the product, not
                              about MRP or what is currently in stock, so this picker shows
                              HSN and GST only. Active only for new picks; an already-chosen
                              product stays listed so editing an old bill can't blank the line. */}
                          <SearchableItemSelect
                            className="h-8 text-xs flex-1 min-w-0"
                            placeholder="Select"
                            advanceOnSelect
                            data-testid={`purchase-line-item-${index}`}
                            columns={['hsn', 'gst']}
                            items={activeProductsWithSelection(
                              (form.watch(`lineItems.${index}.materialType`) === 'raw_material' ? rawMaterials : form.watch(`lineItems.${index}.materialType`) === 'item' ? finishedItems : materials) as any[],
                              Number(form.watch(`lineItems.${index}.materialId`)),
                            ).map((m: any) => ({
                              id: m.id,
                              name: m.name,
                              code: m.itemCode || null,
                              hsn: m.hsnCode || null,
                              gstRate: m.taxRate == null ? null : Number(m.taxRate),
                            }))}
                            value={form.watch(`lineItems.${index}.materialId`)}
                            onChange={id => {
                              form.setValue(`lineItems.${index}.materialId`, id);
                              // HSN and GST% follow the product out of the Item Master.
                              applyMasterDefaults(index, form.getValues(`lineItems.${index}.materialType`), id);
                            }}
                          />
                        </div>
                        {/* HSN fills itself from the Item Master; it is out of
                            the tab order (still mouse-editable) so Tab goes
                            Item → Qty as billed. */}
                        <Input className="h-9 text-xs font-mono" placeholder="HSN" tabIndex={-1} {...form.register(`lineItems.${index}.hsnCode`)} />
                        <Input className="h-9 text-xs text-right" type="number" min={0} step="0.001" {...form.register(`lineItems.${index}.quantity`)} />
                        <Input className="h-9 text-xs text-right" type="number" min={0} step="0.01" {...form.register(`lineItems.${index}.unitCost`)} />
                        <Input className="h-9 text-xs text-right" type="number" min={0} max={100} step="0.1" placeholder="0" {...form.register(`lineItems.${index}.discount`)} />
                        {/* GST % only — the intra/inter choice is bill-level,
                            above the table. */}
                        <Select onValueChange={v => form.setValue(`lineItems.${index}.gstRate`, Number(v))} value={String(form.watch(`lineItems.${index}.gstRate`) ?? 5)}>
                          <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>{GST_RATES.map(r => <SelectItem key={r} value={String(r)}>{r}%</SelectItem>)}</SelectContent>
                        </Select>
                        <div className="text-right text-sm font-mono font-medium tabular-nums whitespace-nowrap">₹{fmt(calc.lineTotal)}</div>
                        <Button type="button" variant="ghost" size="icon" tabIndex={-1} className="h-8 w-8 text-destructive justify-self-end" onClick={() => remove(index)} disabled={fields.length === 1}>
                          <X className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                      {/* Batch identity. Frozen food cannot be traced or
                          expiry-checked without dates, so those stay required;
                          the number is issued by the server when left blank.
                          Fixed columns keep every row's batch fields lined up. */}
                      <div data-kbd-row={index} className="grid items-center gap-2 px-3 py-1.5 bg-emerald-500/[0.03]" style={{ gridTemplateColumns: '44px 220px 36px 150px 50px 150px minmax(0,1fr)' }}>
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Batch</span>
                        <Input className="h-8 text-xs font-mono" placeholder="Auto on save (or vendor lot no.)" {...form.register(`lineItems.${index}.batchNumber`)} />
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground text-right">
                          Mfg <span className="text-destructive">*</span>
                        </span>
                        <Input className="h-8 text-xs" type="date" {...form.register(`lineItems.${index}.mfgDate`)} />
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground text-right">
                          Expiry <span className="text-destructive">*</span>
                        </span>
                        <Input className="h-8 text-xs" type="date" data-last-field="1" {...form.register(`lineItems.${index}.expiryDate`)} />
                        {(form.formState.errors.lineItems?.[index] as any) ? (
                          <span className="text-[10px] text-destructive">
                            {(form.formState.errors.lineItems?.[index] as any)?.mfgDate?.message
                              ?? (form.formState.errors.lineItems?.[index] as any)?.expiryDate?.message
                              ?? (form.formState.errors.lineItems?.[index] as any)?.hsnCode?.message}
                          </span>
                        ) : <span />}
                      </div>
                      </Fragment>
                    );
                  })}
                  </div>
                </div>
                <Button type="button" variant="outline" size="sm" className="mt-2" onClick={addLine}>
                  <Plus className="w-3.5 h-3.5 mr-1" /> Add Line
                </Button>
              </div>

              {/* Bill Summary — right of the notes on wide screens, below on
                  small ones. */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <FormField control={form.control} name="notes" render={({ field }) => (
                  <FormItem><FormLabel>Notes</FormLabel><FormControl><Textarea rows={3} placeholder="Optional notes" {...field} /></FormControl></FormItem>
                )} />
                <div className="bg-muted/20 rounded-lg p-4 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Subtotal {priceMode === 'inclusive' ? '(GST incl.)' : ''}</span>
                    <span className="font-mono">₹{fmt(bill.subtotal)}</span>
                  </div>
                  {bill.discountTotal > 0 && (
                    <div className="flex justify-between"><span className="text-muted-foreground">(-) Discount</span><span className="font-mono text-red-500">-₹{fmt(bill.discountTotal)}</span></div>
                  )}
                  <div className="flex justify-between"><span className="text-muted-foreground">Taxable Amount</span><span className="font-mono">₹{fmt(bill.taxableTotal)}</span></div>
                  <Separator />
                  {bill.cgstTotal > 0 && <div className="flex justify-between"><span className="text-muted-foreground">CGST</span><span className="font-mono">₹{fmt(bill.cgstTotal)}</span></div>}
                  {bill.sgstTotal > 0 && <div className="flex justify-between"><span className="text-muted-foreground">SGST</span><span className="font-mono">₹{fmt(bill.sgstTotal)}</span></div>}
                  {bill.igstTotal > 0 && <div className="flex justify-between"><span className="text-muted-foreground">IGST</span><span className="font-mono">₹{fmt(bill.igstTotal)}</span></div>}
                  {Math.abs(bill.roundOff) > 0.001 && <div className="flex justify-between"><span className="text-muted-foreground">Round Off</span><span className="font-mono">{bill.roundOff > 0 ? '+' : ''}₹{fmt(Math.abs(bill.roundOff))}</span></div>}
                  <Separator />
                  <div className="flex justify-between font-bold text-base pt-1"><span>Grand Total</span><span className="font-mono text-primary">₹{bill.totalAmount.toLocaleString('en-IN')}</span></div>
                  {priceMode === 'inclusive' && (
                    <p className="text-[10px] text-muted-foreground pt-1">
                      GST is worked back out of the rates, so the total equals the rates you keyed in (plus round-off).
                    </p>
                  )}
                </div>
              </div>

              <DialogFooter className="max-md:sticky max-md:bottom-0 max-md:z-20 max-md:-mx-4 max-md:-mb-4 max-md:px-4 max-md:py-2 max-md:bg-background/95 max-md:backdrop-blur max-md:border-t max-md:border-border">
                <Button variant="outline" type="button" onClick={() => { setIsOpen(false); setEditingId(null); resetForm(); }}>Cancel</Button>
                <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending}>
                  {(createMutation.isPending || updateMutation.isPending) ? 'Saving…' : editingId !== null ? 'Save Changes' : 'Save Purchase Bill'}
                </Button>
                {/* Grand total kept in view alongside the action on mobile, so a
                    long line-item list never scrolls the figure off-screen.
                    Placed last so flex-col-reverse renders it at the top. */}
                <div className="flex md:hidden items-center justify-between w-full text-sm font-bold pb-1">
                  <span>Grand Total</span>
                  <span className="font-mono text-primary">₹{bill.totalAmount.toLocaleString('en-IN')}</span>
                </div>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

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
                        <td className="text-right px-2 py-2 font-mono">₹{fmt(Number(li.unitCost))}</td>
                        <td className="text-right px-2 py-2">{Number(li.discount || 0) > 0 ? `${li.discount}%` : '—'}</td>
                        <td className="text-right px-2 py-2 font-mono">₹{fmt(Number(li.taxableValue || (li.quantity * li.unitCost)))}</td>
                        <td className="text-right px-2 py-2 font-mono">{Number(li.cgst || 0) > 0 ? `₹${fmt(Number(li.cgst))}` : '—'}</td>
                        <td className="text-right px-2 py-2 font-mono">{Number(li.sgst || 0) > 0 ? `₹${fmt(Number(li.sgst))}` : '—'}</td>
                        <td className="text-right px-2 py-2 font-mono">{Number(li.igst || 0) > 0 ? `₹${fmt(Number(li.igst))}` : '—'}</td>
                        <td className="text-right px-3 py-2 font-mono font-bold">₹{fmt(Number(li.lineTotal || li.quantity * li.unitCost))}</td>
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
                {Number(viewItem.discountTotal || 0) > 0 && (
                  <div className="flex justify-between"><span className="text-muted-foreground">(-) Discount</span><span className="font-mono text-red-500">-₹{fmt(Number(viewItem.discountTotal))}</span></div>
                )}
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Taxable Amount</span>
                  <span className="font-mono">₹{fmt(((viewItem.lineItems as any[]) ?? []).reduce((s, l) => s + Number(l.taxableValue || 0), 0))}</span>
                </div>
                {Number(viewItem.taxTotal || 0) > 0 && (
                  <div className="flex justify-between"><span className="text-muted-foreground">Tax</span><span className="font-mono">₹{fmt(Number(viewItem.taxTotal))}</span></div>
                )}
                {Math.abs(Number(viewItem.roundOff || 0)) > 0.001 && (
                  <div className="flex justify-between"><span className="text-muted-foreground">Round Off</span><span className="font-mono">₹{fmt(Number(viewItem.roundOff))}</span></div>
                )}
                <Separator />
                <div className="flex justify-between font-bold text-base"><span>Grand Total</span><span className="font-mono text-primary">₹{fmt(Number(viewItem.totalAmount))}</span></div>
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
