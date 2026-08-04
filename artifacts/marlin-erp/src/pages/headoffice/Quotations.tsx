/**
 * Quotations — quote customers without touching stock or books.
 *
 * Deliberately a near-clone of the Sales Entry experience: same location /
 * customer / discount / GST arithmetic (the preview mirrors the server's
 * buildSaleLines paise-for-paise), but the record is only an OFFER. Creating,
 * editing or deleting a quotation never moves stock, posts to the ledgers, or
 * shows up in GST or the dashboard. "Convert to Sale" opens the Sales Entry
 * form prefilled — only completing THAT sale deducts stock and posts books.
 */
import { useState, useMemo, useEffect, useRef } from 'react';
import { useLocation } from 'wouter';
import { SearchableItemSelect, type ItemOption } from '@/components/ui/searchable-item-select';
import { entryScopeKeyDown, autoFocusFirst, focusAndOpen, useEntryShortcuts } from '@/lib/keyboard-entry';
import { Checkbox } from '@/components/ui/checkbox';
import {
  usePaginatedQuotations, useCreateQuotation, useUpdateQuotation, useDeleteQuotation,
  useSetQuotationStatus, useCreateCustomer, useListItems, useListStock,
  useGetCompanySettings, getListCustomersQueryKey, useListCoupons, customFetch,
  ensureQuotationShareLink, absoluteShareUrl, checkQuotationStock, requestQuotationPdfUrl,
  type QuotationListRow, type QuotationStockShortfall,
} from '@workspace/api-client-react';
import { usePermission } from '@/lib/usePermission';
import { isActiveProduct } from '@/lib/productStatus';
import { useOutletsEnabled, useFeatureFlags } from '@/lib/useFeatureFlags';
import { useEnabledOutlets } from '@/lib/locationStructure';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useDateRange, RangeBar } from '@/pages/reports/shared';
import { useLocationContext } from '@/lib/locationContext';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem } from '@/components/ui/command';
import { Textarea } from '@/components/ui/textarea';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { StateCombobox } from '@/components/ui/state-combobox';
import {
  normaliseWhatsAppNumber, composeQuotationMessage, activeInvoiceShareChannel,
} from '@/lib/invoiceShare';
import {
  Plus, Search, Trash2, Calendar, FileText,
  Download, Eye, FileDown, AlertTriangle,
  UserPlus, Check, ChevronsUpDown, Pencil, Printer, ArrowRightLeft,
} from 'lucide-react';
import { WhatsAppIcon } from '@/components/ui/WhatsAppIcon';
import { NO_PHONE_MESSAGE } from '@/components/sales/InvoiceShareLinkPanel';
import { QuotationShareLinkPanel } from '@/components/sales/QuotationShareLinkPanel';
import { cn } from '@/lib/utils';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { toast } from 'sonner';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { downloadCSV } from '@/lib/download';
import { Separator } from '@/components/ui/separator';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

// ── GST math (mirror of Sales.tsx / server buildSaleLines) ────────────────────

interface GstBreakdown {
  taxRate: number;
  taxType: 'cgst_sgst' | 'igst';
  lineGross: number;
  lineSubtotal: number;
  cgst: number;
  sgst: number;
  igst: number;
  taxAmount: number;
}

// Two pricing modes per line, mirroring the backend exactly (see Sales.tsx).
function computeLineGst(
  qty: number, price: number, taxRate: number, isInterState: boolean, discount = 0, taxableBase = false
): GstBreakdown {
  const base = Math.max(0, qty * price - discount);
  let lineGross: number, lineSubtotal: number, rawTax: number;
  if (taxableBase) {
    lineSubtotal = Math.round(base * 100) / 100;
    rawTax = Math.round(lineSubtotal * taxRate / 100 * 100) / 100;
    lineGross = Math.round((lineSubtotal + rawTax) * 100) / 100;
  } else {
    lineGross = base;
    lineSubtotal = taxRate > 0
      ? Math.round(base / (1 + taxRate / 100) * 100) / 100
      : base;
    rawTax = Math.round((lineGross - lineSubtotal) * 100) / 100;
  }
  if (isInterState) {
    return { taxRate, taxType: 'igst', lineGross, lineSubtotal, cgst: 0, sgst: 0, igst: rawTax, taxAmount: rawTax };
  }
  // Round one half, give the exact remainder to the other (odd paise).
  const half = Math.round(rawTax / 2 * 100) / 100;
  const rest = Math.round((rawTax - half) * 100) / 100;
  return { taxRate, taxType: 'cgst_sgst', lineGross, lineSubtotal, cgst: half, sgst: rest, igst: 0, taxAmount: rawTax };
}

// ── Form schema ───────────────────────────────────────────────────────────────

const quoteLineSchema = z.object({
  itemId:    z.coerce.number().min(1, 'Item required'),
  quantity:  z.coerce.number().min(1, 'Qty ≥ 1'),
  unitPrice: z.coerce.number().min(0, 'Price required'),
  unitDiscount: z.coerce.number().min(0, 'Discount ≥ 0').optional(),
  taxable:        z.boolean().optional(),
  taxableTouched: z.boolean().optional(),
}).refine(li => (li.unitDiscount ?? 0) <= li.unitPrice, {
  message: 'Cannot exceed the unit price',
  path: ['unitDiscount'],
});

const schema = z.object({
  locationType: z.enum(['outlet', 'warehouse']).default('outlet'),
  locationId: z.coerce.number().min(1, 'Location required'),
  customerId: z.coerce.number().optional(),
  quoteDate: z.string().min(1, 'Date required'),
  validTill: z.string().optional(),
  status: z.enum(['draft', 'sent', 'accepted', 'rejected', 'expired']).default('draft'),
  couponCode: z.string().optional(),
  billDiscount: z.coerce.number().min(0, 'Discount ≥ 0').optional(),
  paymentTerms: z.string().optional(),
  billingAddress: z.string().optional(),
  shippingAddress: z.string().optional(),
  placeOfSupply: z.string().optional(),
  salesperson: z.string().optional(),
  notes: z.string().optional(),
  termsConditions: z.string().optional(),
  lineItems: z.array(quoteLineSchema).min(1, 'Add at least one item'),
});
type FormValues = z.infer<typeof schema>;

const custSchema = z.object({
  name:      z.string().min(1, 'Name is required'),
  phone:     z.string().optional(),
  email:     z.string().email().optional().or(z.literal('')),
  gstNumber: z.string().optional(),
  state:     z.string().optional(),
  address:   z.string().optional(),
  notes:     z.string().optional(),
});
type CustForm = z.infer<typeof custSchema>;

/** Default validity: 30 days out — editable, and blank is allowed. */
const defaultValidTill = () => {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d.toISOString().split('T')[0];
};

const defaultFormValues: FormValues = {
  locationType: 'outlet',
  locationId: 0,
  quoteDate: new Date().toISOString().split('T')[0],
  validTill: defaultValidTill(),
  status: 'draft',
  couponCode: '',
  billDiscount: 0,
  paymentTerms: '',
  billingAddress: '',
  shippingAddress: '',
  placeOfSupply: '',
  salesperson: '',
  notes: '',
  termsConditions: '',
  lineItems: [{ itemId: 0, quantity: 1, unitPrice: 0, unitDiscount: 0, taxable: false, taxableTouched: false }],
};

// ── Status presentation ───────────────────────────────────────────────────────

type QStatus = 'draft' | 'sent' | 'accepted' | 'rejected' | 'expired' | 'converted';

const STATUS_LABEL: Record<QStatus, string> = {
  draft: 'Draft', sent: 'Sent', accepted: 'Accepted',
  rejected: 'Rejected', expired: 'Expired', converted: 'Converted',
};

function StatusBadge({ status }: { status: string }) {
  switch (status as QStatus) {
    case 'draft':     return <Badge variant="outline" className="text-[10px] text-muted-foreground">Draft</Badge>;
    case 'sent':      return <Badge className="text-[10px] bg-sky-500/10 text-sky-600 border-sky-500/20">Sent</Badge>;
    case 'accepted':  return <Badge className="text-[10px] bg-emerald-500/10 text-emerald-600 border-emerald-500/20">Accepted</Badge>;
    case 'rejected':  return <Badge className="text-[10px] bg-red-500/10 text-red-600 border-red-500/20">Rejected</Badge>;
    case 'expired':   return <Badge className="text-[10px] bg-amber-500/10 text-amber-600 border-amber-500/20">Expired</Badge>;
    case 'converted': return <Badge className="text-[10px] bg-violet-500/10 text-violet-600 border-violet-500/20">Converted</Badge>;
    default:          return <Badge variant="outline" className="text-[10px]">{status}</Badge>;
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function Quotations() {
  const perm = usePermission('page:/sales/quotations');
  const [, setLocation] = useLocation();
  const { data: outlets = [] } = useEnabledOutlets();
  const { outletsEnabled } = useOutletsEnabled();
  const { flags: featureFlags } = useFeatureFlags();
  const discountsEnabled = featureFlags.posDiscountsEnabled;
  const couponsEnabled = featureFlags.posCouponsEnabled;

  // Location narrowing from the ONE shared header context (same as Sales).
  const { locationState } = useLocationContext();
  const locFilterType =
    (locationState.locationType === 'warehouse' || locationState.locationType === 'outlet') &&
    locationState.locationId
      ? locationState.locationType
      : null;
  const locFilterId = locFilterType ? locationState.locationId! : 0;

  const range = useDateRange('all');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | QStatus>('all');
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 25;

  useEffect(() => {
    const t = setTimeout(() => { setDebouncedSearch(search.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => { setPage(1); }, [range.from, range.to, statusFilter]);
  useEffect(() => { setPage(1); }, [locationState.locationType, locationState.locationId]);

  const { data: quotesPage, isLoading, isFetching } = usePaginatedQuotations(page, PAGE_SIZE, {
    q: debouncedSearch || undefined,
    from: range.from || undefined,
    to: range.to || undefined,
    status: statusFilter === 'all' ? undefined : statusFilter,
    ...(locFilterType && locFilterId
      ? { locationType: locFilterType, locationId: locFilterId }
      : {}),
  });
  const quotes = quotesPage?.rows ?? [];
  const { sorted, sort } = useTableSort(quotes, {
    quotation: q => q.quotationNumber,
    date: q => q.quoteDate,
    customer: q => q.customerName || 'Walk-in',
    location: q => q.locationName,
    status: q => q.status,
    total: q => Number(q.totalAmount) || null,
    validTill: q => q.validTill,
    salesperson: q => q.salesperson,
  });
  const totalQuotes = quotesPage?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalQuotes / PAGE_SIZE));
  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [page, totalPages]);

  const { data: customers = [] } = useQuery<any[]>({
    queryKey: ['customers'],
    queryFn: () => customFetch('/api/customers'),
  });
  const { data: items = [] } = useListItems();
  const { data: companySettings } = useGetCompanySettings();
  const { data: warehouses = [] } = useQuery<any[]>({
    queryKey: ['warehouses'],
    queryFn: () => customFetch('/api/warehouses'),
  });

  const [isOpen, setIsOpen] = useState(false);
  const [editItem, setEditItem] = useState<QuotationListRow | null>(null);
  const [viewItem, setViewItem] = useState<QuotationListRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<QuotationListRow | null>(null);
  // Soft insufficient-stock warning before Convert to Sale — warns, never blocks.
  const [convertWarning, setConvertWarning] = useState<{ quotation: QuotationListRow; shortfalls: QuotationStockShortfall[] } | null>(null);
  const [convertBusyId, setConvertBusyId] = useState<number | null>(null);

  const queryClient = useQueryClient();
  const invalidateQuotations = () =>
    queryClient.invalidateQueries({
      predicate: q => String(q.queryKey[0] ?? '').startsWith('/api/quotations'),
    });

  const createMutation = useCreateQuotation();
  const updateMutation = useUpdateQuotation();
  const deleteMutation = useDeleteQuotation();
  const statusMutation = useSetQuotationStatus();
  const createCustomerMutation = useCreateCustomer();

  // Customer combobox + quick-create state
  const [customerOpen, setCustomerOpen] = useState(false);
  const [customerSearch, setCustomerSearch] = useState('');
  const [showNewCustomer, setShowNewCustomer] = useState(false);
  const custForm = useForm<CustForm>({
    resolver: zodResolver(custSchema),
    defaultValues: { name: '', phone: '', email: '', gstNumber: '', state: '', address: '', notes: '' },
  });

  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: defaultFormValues });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'lineItems' });

  // ── Keyboard Entry Mode ──
  const scopeRef = useRef<HTMLFormElement>(null);
  // Blocks a second submit fired before React Query flips isPending (Ctrl+S race).
  const submitLockRef = useRef(false);
  /** Append a line and drop the cursor straight into the new row's item picker. */
  const kbdAddLine = () => {
    const nextIndex = fields.length;
    append({ itemId: 0, quantity: 1, unitPrice: 0, unitDiscount: 0, taxable: customerHasGstin, taxableTouched: false });
    window.setTimeout(() => {
      focusAndOpen(scopeRef.current?.querySelector<HTMLElement>(`[data-testid="input-line-item-${nextIndex}"]`));
    }, 0);
  };
  const kbdDeleteLine = (i: number) => { if (fields.length > 1) remove(i); };
  /** Ctrl+S / Ctrl+Enter → the existing submit, guarded by isPending. */
  const kbdSave = () => {
    if (editItem ? updateMutation.isPending : createMutation.isPending) return;
    form.handleSubmit(onSubmit)();
  };
  useEntryShortcuts(isOpen, { onSave: kbdSave, onComplete: kbdSave, onAddLine: kbdAddLine });

  const watchLocationType = form.watch('locationType');
  const watchLocationId = form.watch('locationId');
  const watchCustomerId = form.watch('customerId');

  const openEdit = (q: QuotationListRow) => {
    if (q.convertedSaleId) {
      toast.error(`${q.quotationNumber} was converted to ${q.convertedInvoiceNumber ?? 'a sale'} and can no longer be edited.`);
      return;
    }
    setEditItem(q);
    form.reset({
      locationType: (q.locationType ?? 'outlet') as 'outlet' | 'warehouse',
      locationId: q.locationId ?? 0,
      customerId: q.customerId ?? undefined,
      quoteDate: q.quoteDate,
      validTill: q.validTill ?? '',
      status: (q.status === 'converted' ? 'draft' : q.status) as FormValues['status'],
      couponCode: q.couponCode ?? '',
      billDiscount: Number(q.billDiscount ?? 0),
      paymentTerms: q.paymentTerms ?? '',
      billingAddress: q.billingAddress ?? '',
      shippingAddress: q.shippingAddress ?? '',
      placeOfSupply: q.placeOfSupply ?? '',
      salesperson: q.salesperson ?? '',
      notes: q.notes ?? '',
      termsConditions: q.termsConditions ?? '',
      lineItems: (q.lineItems ?? []).map((li: any) => ({
        itemId: li.itemId,
        quantity: li.quantity,
        unitPrice: li.unitPrice,
        // Same reconstruction rule as Sales: per-unit when stored, else derive
        // from the line-total at FULL precision so a resave cannot drift.
        unitDiscount: li.unitDiscount != null
          ? Number(li.unitDiscount)
          : Number(li.quantity) > 0
            ? Math.max(0, Number(li.discount ?? 0) - Number(li.billDiscountShare ?? 0)) / Number(li.quantity)
            : 0,
        taxable: li.priceMode === 'exclusive',
        taxableTouched: true,
      })),
    });
    setIsOpen(true);
  };

  // Stock is INFORMATIONAL on a quotation: the picker shows availability but
  // any active item can be quoted, in any quantity — nothing is reserved.
  const { data: locationStock = [] } = useListStock(
    { branchType: (watchLocationType ?? 'outlet') as any, branchId: watchLocationId },
    { query: { enabled: !!watchLocationId && watchLocationId > 0 } as any }
  );
  const stockMap = useMemo(
    () => new Map<number, number>(locationStock.map(s => [s.itemId!, Number(s.quantity ?? 0)])),
    [locationStock],
  );
  const activeItems = useMemo(() => items.filter(it => isActiveProduct(it)), [items]);
  const toItemOption = (it: any): ItemOption => ({
    id: it.id,
    name: it.name,
    code: it.itemCode || null,
    hsn: it.hsnCode || null,
    uom: it.unit || null,
    available: stockMap.get(it.id) ?? 0,
    mrp: Number(it.mrp ?? 0),
    gstRate: Number(it.taxRate ?? 0),
  });
  const activeOptions = useMemo(() => activeItems.map(toItemOption), [activeItems, stockMap]);
  // Editing an old quotation must never blank a line pointing at an item that
  // has since gone inactive — it stays selectable for THAT line.
  const lineItemOptions = (selectedId: number): ItemOption[] => {
    const id = Number(selectedId);
    if (!id || activeItems.some(it => it.id === id)) return activeOptions;
    const selected = items.find(it => it.id === id);
    return selected ? [...activeOptions, toItemOption(selected)] : activeOptions;
  };
  const getPrice = (itemId: number) => Number((items.find(i => i.id === itemId) as any)?.mrp ?? 0);
  const getItem = (itemId: number) => items.find(i => i.id === itemId);

  // GST state determination (same as Sales)
  const companyState = ((companySettings as any)?.state ?? '').trim().toLowerCase();
  const selectedCustomer = customers.find(c => c.id === watchCustomerId);
  const customerState = ((selectedCustomer as any)?.state ?? '').trim().toLowerCase();
  const isInterState = !!(companyState && customerState && companyState !== customerState);
  const customerHasGstin = !!String(
    (selectedCustomer as any)?.gstNumber ?? (selectedCustomer as any)?.gst_number ?? ''
  ).trim();
  useEffect(() => {
    (form.getValues('lineItems') ?? []).forEach((l: any, i: number) => {
      if (!l?.taxableTouched && !!l?.taxable !== customerHasGstin) {
        form.setValue(`lineItems.${i}.taxable`, customerHasGstin);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerHasGstin, watchCustomerId]);

  // Coupon validation (same rules as Sales)
  const { data: coupons = [] } = useListCoupons();
  const watchCouponCode = (form.watch('couponCode') ?? '').trim().toUpperCase();
  const appliedCoupon = useMemo(() => {
    if (!watchCouponCode) return null;
    const c = (coupons as any[]).find(
      (c: any) => (c.code ?? '').toUpperCase() === watchCouponCode && c.isActive
    );
    if (!c) return null;
    if (c.expiryDate && new Date(c.expiryDate) < new Date()) return null;
    return c;
  }, [coupons, watchCouponCode]);

  // Edit mode: while the coupon code is unchanged, preserve the STORED coupon
  // deduction instead of re-deriving from the live coupon list.
  const preservedBillDiscount = useMemo(() => {
    if (!editItem) return null;
    const orig = String(editItem.couponCode ?? '').trim().toUpperCase();
    if (orig !== watchCouponCode) return null;
    return Math.max(0, Number(editItem.discountTotal ?? 0));
  }, [editItem, watchCouponCode]);

  // Cart totals — the same 3-pass, paise-exact preview as Sales.tsx.
  const computeCartTotals = () => {
    const prepared: Array<{ qty: number; price: number; taxRate: number; itemDisc: number; basis: number; taxable: boolean }> = [];
    let grossItemValue = 0, itemDiscountTotal = 0;
    fields.forEach((_, i) => {
      const itemId = form.watch(`lineItems.${i}.itemId`);
      const qty    = Number(form.watch(`lineItems.${i}.quantity`) ?? 0);
      const price  = Number(form.watch(`lineItems.${i}.unitPrice`) ?? 0);
      const unitDisc = Math.min(Math.max(0, Number(form.watch(`lineItems.${i}.unitDiscount`) ?? 0)), price);
      if (!itemId || price <= 0) return;
      const taxRate  = Number((getItem(itemId) as any)?.taxRate ?? 0);
      const taxable  = !!form.watch(`lineItems.${i}.taxable`);
      const itemDisc = Math.round(unitDisc * qty * 100) / 100;
      grossItemValue    += Math.round(qty * price * 100) / 100;
      itemDiscountTotal += itemDisc;
      prepared.push({ qty, price, taxRate, itemDisc, basis: Math.max(0, Math.round((qty * price - itemDisc) * 100) / 100), taxable });
    });

    const basisSum = Math.round(prepared.reduce((s, p) => s + p.basis, 0) * 100) / 100;
    const billDiscount = Math.min(Math.max(0, Math.round(Number(form.watch('billDiscount') ?? 0) * 100) / 100), basisSum);
    const basePaise = prepared.map(p => Math.max(0, Math.round(p.basis * 100)));
    const weightSum = basePaise.reduce((s, b) => s + b, 0);
    const totalPaise = Math.round(billDiscount * 100);
    let shares = prepared.map(() => 0);
    if (totalPaise > 0 && weightSum > 0) {
      const raw    = basePaise.map(b => (totalPaise * b) / weightSum);
      const floors = raw.map(Math.floor);
      let rem = totalPaise - floors.reduce((s, f) => s + f, 0);
      const order = raw.map((r, idx) => ({ idx, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.idx - b.idx);
      for (const { idx } of order) { if (rem <= 0) break; if (floors[idx] < basePaise[idx]) { floors[idx] += 1; rem -= 1; } }
      shares = floors.map(f => f / 100);
    }

    let grossTotal = 0, subtotal = 0, cgstTotal = 0, sgstTotal = 0, igstTotal = 0, taxTotal = 0;
    prepared.forEach((p, k) => {
      const adjusted = Math.round((p.basis - shares[k]) * 100) / 100;
      const gst = computeLineGst(1, adjusted, p.taxRate, isInterState, 0, p.taxable);
      grossTotal += gst.lineGross;
      subtotal   += gst.lineSubtotal;
      cgstTotal  += gst.cgst;
      sgstTotal  += gst.sgst;
      igstTotal  += gst.igst;
      taxTotal   += gst.taxAmount;
    });
    const grandTotal = grossTotal;
    const discountAmount = preservedBillDiscount !== null
      ? Math.min(preservedBillDiscount, grandTotal)
      : appliedCoupon
        ? appliedCoupon.discountType === 'percentage'
          ? Math.round(grandTotal * Number(appliedCoupon.discountValue) / 100 * 100) / 100
          : Math.min(Number(appliedCoupon.discountValue), grandTotal)
        : 0;
    return { grossItemValue, grossTotal, subtotal, cgstTotal, sgstTotal, igstTotal, taxTotal, itemDiscountTotal, billDiscount, grandTotal, discountAmount, finalAmount: grandTotal - discountAmount };
  };

  const totals = computeCartTotals();
  const hasItems = fields.some((_, i) => (form.watch(`lineItems.${i}.itemId`) ?? 0) > 0);

  const onSubmit = (data: FormValues) => {
    // Synchronous re-entrancy lock: two rapid Ctrl+S / Enter submits can both
    // pass an isPending check before React Query publishes the pending state.
    // Released in onSettled (success or error).
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    const enrichedItems = data.lineItems.map(li => ({
      itemId: li.itemId,
      quantity: li.quantity,
      unitPrice: Number(li.unitPrice),
      unitDiscount: Math.max(0, Number(li.unitDiscount ?? 0)),
      priceMode: (li.taxable ? 'exclusive' : 'inclusive') as 'exclusive' | 'inclusive',
      taxAmount: 0, // server recomputes authoritatively
    }));
    const { discountAmount } = computeCartTotals();
    const payload: any = {
      locationType: data.locationType,
      locationId: data.locationId,
      customerId: data.customerId || undefined,
      quoteDate: data.quoteDate,
      validTill: data.validTill || undefined,
      status: data.status,
      lineItems: enrichedItems,
      couponCode: data.couponCode || undefined,
      billDiscount: Math.max(0, Number(data.billDiscount ?? 0)),
      discountTotal: discountAmount,
      billingAddress: data.billingAddress || undefined,
      shippingAddress: data.shippingAddress || undefined,
      paymentTerms: data.paymentTerms || undefined,
      placeOfSupply: data.placeOfSupply || undefined,
      salesperson: data.salesperson || undefined,
      notes: data.notes || undefined,
      termsConditions: data.termsConditions || undefined,
    };

    if (editItem) {
      updateMutation.mutate({ id: editItem.id, data: payload }, {
        onSuccess: (updated: any) => {
          toast.success('Quotation updated');
          invalidateQuotations();
          if (viewItem?.id === editItem.id) setViewItem({ ...viewItem, ...updated });
          setIsOpen(false);
          setEditItem(null);
          form.reset(defaultFormValues);
        },
        onError: (e: any) => {
          if (e?.status === 409) {
            toast.error(e?.data?.error || 'This quotation was already converted to a sale and can no longer change.');
            invalidateQuotations();
            return;
          }
          toast.error(e?.data?.error || e.message || 'Could not update quotation');
        },
        onSettled: () => { submitLockRef.current = false; },
      });
    } else {
      createMutation.mutate({ data: payload }, {
        onSuccess: (created: any) => {
          toast.success(`Quotation ${created?.quotationNumber ?? ''} saved`);
          invalidateQuotations();
          setIsOpen(false);
          form.reset(defaultFormValues);
        },
        onError: (e: any) => toast.error(e?.data?.error || e.message || 'Could not save quotation'),
        onSettled: () => { submitLockRef.current = false; },
      });
    }
  };

  // ── Quotation PDF (same canonical server renderer, quotation variant) ──────
  const handleDownloadPDF = async (q: QuotationListRow) => {
    try {
      window.location.assign(await requestQuotationPdfUrl(q.id, { download: true }));
    } catch {
      toast.error('Unable to prepare the quotation PDF. Please try again.');
    }
  };

  const handlePreviewPDF = async (q: QuotationListRow) => {
    const tab = window.open('', '_blank');
    try {
      const url = await requestQuotationPdfUrl(q.id);
      if (tab) tab.location.replace(url);
      else window.open(url, '_blank');
    } catch {
      tab?.close();
      toast.error('Unable to open the quotation PDF. Please try again.');
    }
  };

  const handlePrintPDF = async (q: QuotationListRow) => {
    const tab = window.open('', '_blank');
    try {
      const url = await requestQuotationPdfUrl(q.id);
      if (!tab) { window.open(url, '_blank'); return; }
      tab.location.replace(url);
      tab.addEventListener?.('load', () => { try { tab.print(); } catch { /* viewer declined */ } });
    } catch {
      tab?.close();
      toast.error('Unable to open the quotation for printing. Please try again.');
    }
  };

  // ── WhatsApp share — mirrors the invoice flow, quotation wording ───────────
  const handleWhatsApp = async (q: QuotationListRow) => {
    const phone = normaliseWhatsAppNumber(q.customerPhone);
    if (!phone) {
      toast.error(NO_PHONE_MESSAGE);
      return;
    }
    const waTab = window.open('', '_blank'); // sync open — popup-blocker safe
    try {
      const { link } = await ensureQuotationShareLink(q.id, 'whatsapp');
      if (!link.path) throw new Error('share link is not active');
      const pdfUrl = absoluteShareUrl(link.path);
      const cs = companySettings as any;
      const message = composeQuotationMessage({
        quotation: q,
        pdfUrl,
        companyName: cs?.companyName ?? cs?.name ?? 'Marlin Frozen Fruits',
        resolveItemName: id => itemsMap.get(id)?.name,
        linkValidDays: link.validForDays,
      });
      const target = await activeInvoiceShareChannel().deliver({
        phone, message, pdfUrl, saleId: q.id,
      });
      if (!target) { waTab?.close(); toast.success('Quotation sent on WhatsApp'); return; }
      if (waTab) waTab.location.replace(target);
      else window.open(target, '_blank');
    } catch {
      waTab?.close();
      toast.error('Unable to prepare the WhatsApp share. Please try again.');
    }
  };

  // ── Convert to Sale ─────────────────────────────────────────────────────────
  // The check is a soft warning: quoting never reserved anything, so a short
  // shelf never blocks — the operator decides. Completing the SALE is the only
  // step that deducts stock, posts books and assigns an invoice number.
  const goConvert = (q: QuotationListRow) => {
    try {
      sessionStorage.setItem('marlin_convert_quotation', JSON.stringify(q));
    } catch { /* storage full/blocked — the sales page just opens blank */ }
    setLocation(`/headoffice/sales?fromQuotation=${q.id}`);
  };

  const handleConvert = async (q: QuotationListRow) => {
    if (q.convertedSaleId) {
      toast.error(`${q.quotationNumber} was already converted to ${q.convertedInvoiceNumber ?? 'a sale'}.`);
      return;
    }
    setConvertBusyId(q.id);
    try {
      const check = await checkQuotationStock(q.id);
      if (!check.ok) {
        setConvertWarning({ quotation: q, shortfalls: check.shortfalls });
        return;
      }
      goConvert(q);
    } catch (e: any) {
      toast.error(e?.data?.error || 'Could not check stock for this quotation.');
    } finally {
      setConvertBusyId(null);
    }
  };

  // ── Status change (view sheet) ─────────────────────────────────────────────
  const handleStatusChange = (q: QuotationListRow, status: string) => {
    statusMutation.mutate({ id: q.id, data: { status } as any }, {
      onSuccess: (updated: any) => {
        toast.success(`Marked as ${STATUS_LABEL[status as QStatus] ?? status}`);
        invalidateQuotations();
        if (viewItem?.id === q.id) setViewItem({ ...viewItem, ...updated });
      },
      onError: (e: any) => toast.error(e?.data?.error || 'Could not change status'),
    });
  };

  // ── Delete ─────────────────────────────────────────────────────────────────
  const handleDelete = () => {
    if (!deleteTarget) return;
    deleteMutation.mutate({ id: deleteTarget.id }, {
      onSuccess: () => {
        toast.success(`Quotation ${deleteTarget.quotationNumber} deleted`);
        invalidateQuotations();
        if (viewItem?.id === deleteTarget.id) setViewItem(null);
        setDeleteTarget(null);
      },
      onError: (e: any) => {
        setDeleteTarget(null);
        if (e?.status === 409) {
          toast.error(e?.data?.error || 'A converted quotation is part of the audit trail and cannot be deleted.');
          invalidateQuotations();
          return;
        }
        toast.error(e?.data?.error || 'Could not delete quotation');
      },
    });
  };

  const itemsMap = new Map(items.map(i => [i.id, i]));
  const fmtDay = (d?: string | null) => (d ? new Date(d).toLocaleDateString('en-IN') : '—');

  if (!perm.isLoading && !perm.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center py-32 text-muted-foreground gap-3">
          <AlertTriangle className="w-10 h-10 text-destructive/50" />
          <p className="text-lg font-medium">Access Denied</p>
          <p className="text-sm">You don't have permission to view Quotations.</p>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><FileText className="w-6 h-6 text-primary" /> Quotations</h1>
            <p className="text-muted-foreground mt-1">Quote customers — nothing moves in stock or books until a quote becomes a sale</p>
          </div>
          <div className="flex gap-2">
            {perm.canDownload && (
              <Button variant="outline" size="sm" onClick={() => downloadCSV('quotations.csv', quotes.map(q => ({
                Quotation: q.quotationNumber, Date: q.quoteDate, Location: q.locationName,
                Customer: q.customerName || 'Walk-in', Status: STATUS_LABEL[q.status as QStatus] ?? q.status,
                'Valid Till': q.validTill ?? '', Salesperson: q.salesperson ?? '',
                Subtotal: q.subtotal, Tax: q.taxTotal,
                Discount: (Number(q.discountTotal ?? 0)
                  + ((q.lineItems as any[]) ?? []).reduce((acc: number, li: any) => acc + Number(li?.discount ?? 0), 0)).toFixed(2),
                Total: q.totalAmount,
                'Converted To': q.convertedInvoiceNumber ?? '',
              })))}>
                <Download className="w-4 h-4 mr-2" /> Export
              </Button>
            )}
            {perm.canAdd && (
              <Button onClick={() => { setEditItem(null); form.reset({ ...defaultFormValues, quoteDate: new Date().toISOString().split('T')[0], validTill: defaultValidTill() }); setIsOpen(true); }}>
                <Plus className="w-4 h-4 mr-2" /> New Quotation
              </Button>
            )}
          </div>
        </div>

        {/* Quotations table */}
        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex flex-wrap gap-3 bg-muted/20">
            <div className="flex items-center gap-2 w-64">
              <Search className="w-4 h-4 text-muted-foreground" />
              <Input placeholder="Search quotation or customer..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0" />
            </div>
            <RangeBar range={range} />
          </div>
          {/* Status filter pills — server-side filter */}
          <div className="px-4 py-2 border-b border-border flex flex-wrap gap-2">
            {([
              { key: 'all', label: 'All' },
              { key: 'draft', label: 'Draft' },
              { key: 'sent', label: 'Sent' },
              { key: 'accepted', label: 'Accepted' },
              { key: 'rejected', label: 'Rejected' },
              { key: 'expired', label: 'Expired' },
              { key: 'converted', label: 'Converted' },
            ] as const).map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setStatusFilter(key)}
                className={cn(
                  'px-3 py-1 rounded-full text-xs font-medium border transition-colors',
                  statusFilter === key
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-transparent text-muted-foreground border-border hover:border-primary/50 hover:text-foreground'
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <SortableHead k="quotation" sort={sort}>Quotation</SortableHead>
                <SortableHead k="date" sort={sort}>Date</SortableHead>
                <SortableHead k="customer" sort={sort}>Customer</SortableHead>
                <SortableHead k="location" sort={sort}>Location</SortableHead>
                <SortableHead k="status" sort={sort}>Status</SortableHead>
                <SortableHead k="total" sort={sort} className="text-right">Total</SortableHead>
                <SortableHead k="validTill" sort={sort}>Valid Till</SortableHead>
                <SortableHead k="salesperson" sort={sort}>Salesperson</SortableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(4)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={9}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : quotes.length === 0 ? (
                <TableRow><TableCell colSpan={9} className="text-center py-16 text-muted-foreground">
                  <FileText className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No quotations yet</p>
                </TableCell></TableRow>
              ) : sorted.map(q => (
                <TableRow key={q.id} className="hover:bg-muted/10">
                  <TableCell className="font-mono text-primary font-bold">
                    {q.quotationNumber}
                    {q.convertedInvoiceNumber && (
                      <p className="text-[10px] font-sans font-normal text-violet-600">→ {q.convertedInvoiceNumber}</p>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    <div className="flex items-center gap-1"><Calendar className="w-3 h-3" />{fmtDay(q.quoteDate)}</div>
                  </TableCell>
                  <TableCell className="text-sm">{q.customerName || 'Walk-in'}</TableCell>
                  <TableCell className="text-sm">{q.locationName}</TableCell>
                  <TableCell><StatusBadge status={q.status} /></TableCell>
                  <TableCell className="text-right">
                    <p className="font-mono font-bold text-primary">₹{Number(q.totalAmount).toLocaleString('en-IN')}</p>
                  </TableCell>
                  <TableCell className={cn('text-sm', q.status === 'expired' ? 'text-amber-600' : 'text-muted-foreground')}>{fmtDay(q.validTill)}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{q.salesperson || '—'}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(q)} title="View"><Eye className="w-4 h-4" /></Button>
                      {perm.canEdit && (
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-amber-500"
                          disabled={!!q.convertedSaleId}
                          onClick={() => openEdit(q)}
                          title={q.convertedSaleId ? 'Converted quotations can no longer be edited' : 'Edit quotation'}>
                          <Pencil className="w-4 h-4" />
                        </Button>
                      )}
                      {perm.canAdd && !q.convertedSaleId && (
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-violet-600"
                          disabled={convertBusyId === q.id}
                          onClick={() => void handleConvert(q)} title="Convert to Sale">
                          <ArrowRightLeft className="w-4 h-4" />
                        </Button>
                      )}
                      {perm.canDownload && <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-foreground" onClick={() => void handlePrintPDF(q)} title="Print"><Printer className="w-4 h-4" /></Button>}
                      {perm.canDownload && <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-emerald-600" onClick={() => void handleDownloadPDF(q)} title="Download PDF"><FileDown className="w-4 h-4" /></Button>}
                      {perm.canDownload && (
                        <Button
                          variant="ghost" size="icon"
                          className="h-8 w-8 text-[#25D366] hover:text-[#128C7E] hover:bg-[#25D366]/10"
                          disabled={!q.customerPhone}
                          onClick={() => void handleWhatsApp(q)}
                          title={q.customerPhone
                            ? `Send quotation to ${q.customerPhone} via WhatsApp`
                            : NO_PHONE_MESSAGE}
                        >
                          <WhatsAppIcon className="w-4 h-4" />
                        </Button>
                      )}
                      {perm.canDelete && (
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-destructive"
                          disabled={!!q.convertedSaleId}
                          onClick={() => setDeleteTarget(q)}
                          title={q.convertedSaleId ? 'A converted quotation cannot be deleted' : 'Delete quotation'}>
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {totalQuotes > 0 && (
            <div className="p-3 border-t border-border flex flex-wrap items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground">
                Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, totalQuotes)} of {totalQuotes} quotations
                {isFetching ? ' · refreshing…' : ''}
              </span>
              <div className="flex items-center gap-3">
                <span className="font-bold text-primary">
                  Page total: ₹{quotes.reduce((s, r) => s + Number(r.totalAmount || 0), 0).toLocaleString('en-IN')}
                </span>
                <div className="flex items-center gap-1">
                  <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Prev</Button>
                  <span className="px-1 text-xs text-muted-foreground">Page {page}/{totalPages}</span>
                  <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next</Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Quotation Dialog */}
      <Dialog open={isOpen} onOpenChange={v => { setIsOpen(v); if (!v) { setEditItem(null); form.reset(defaultFormValues); } }}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto" onOpenAutoFocus={autoFocusFirst}>
          <DialogHeader><DialogTitle>{editItem ? `Edit Quotation — ${editItem.quotationNumber}` : 'New Quotation'}</DialogTitle></DialogHeader>
          <Form {...form}>
            <form
              ref={scopeRef}
              data-kbd-scope
              onKeyDown={entryScopeKeyDown({ onSave: kbdSave, onComplete: kbdSave, onAddLine: kbdAddLine, onDeleteLine: kbdDeleteLine })}
              onSubmit={form.handleSubmit(onSubmit)}
              className="space-y-5"
            >
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FormField control={form.control} name="locationId" render={({ field }) => (
                  <FormItem><FormLabel>Selling Location <span className="text-destructive">*</span></FormLabel>
                    <Select
                      onValueChange={v => {
                        const [type, idStr] = v.split(':');
                        field.onChange(Number(idStr));
                        form.setValue('locationType', type as 'outlet' | 'warehouse');
                      }}
                      value={field.value && field.value > 0 ? `${form.watch('locationType')}:${field.value}` : ''}
                    >
                      <FormControl><SelectTrigger><SelectValue placeholder={outletsEnabled ? 'Select outlet or warehouse' : 'Select warehouse'} /></SelectTrigger></FormControl>
                      <SelectContent>
                        {(warehouses as any[]).length > 0 && (
                          <SelectGroup>
                            <SelectLabel>Warehouses</SelectLabel>
                            {(warehouses as any[]).map((w: any) => (
                              <SelectItem key={w.id} value={`warehouse:${w.id}`}>🏭 {w.name}</SelectItem>
                            ))}
                          </SelectGroup>
                        )}
                        {outletsEnabled && outlets.length > 0 && (
                          <SelectGroup>
                            <SelectLabel>Outlets</SelectLabel>
                            {outlets.map(o => (
                              <SelectItem key={o.id} value={`outlet:${o.id}`}>🏪 {o.name}</SelectItem>
                            ))}
                          </SelectGroup>
                        )}
                      </SelectContent>
                    </Select><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="customerId" render={({ field }) => {
                  const filteredCustomers = customers.filter(c =>
                    c.name.toLowerCase().includes(customerSearch.toLowerCase()) ||
                    ((c as any).phone ?? '').includes(customerSearch)
                  );
                  const selected = customers.find(c => c.id === field.value);
                  return (
                    <FormItem>
                      <div className="flex items-center justify-between">
                        <FormLabel>Customer</FormLabel>
                        <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs text-primary gap-1"
                          onClick={() => { custForm.reset(); setShowNewCustomer(true); }}>
                          <UserPlus className="w-3 h-3" /> New
                        </Button>
                      </div>
                      <Popover open={customerOpen} onOpenChange={v => { setCustomerOpen(v); if (!v) setCustomerSearch(''); }}>
                        <PopoverTrigger asChild>
                          <Button type="button" variant="outline" role="combobox"
                            className={cn('w-full justify-between font-normal h-10 px-3', !selected && 'text-muted-foreground')}>
                            <span className="truncate">{selected ? `${selected.name}${(selected as any).state ? ` (${(selected as any).state})` : ''}` : 'Walk-in Customer'}</span>
                            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent align="start" className="p-0" style={{ width: 'var(--radix-popover-trigger-width)', minWidth: '240px' }} data-kbd-ignore>
                          <Command shouldFilter={false}>
                            <CommandInput placeholder="Search customer…" value={customerSearch} onValueChange={setCustomerSearch} />
                            <CommandEmpty>No customers found. <button type="button" className="text-primary underline ml-1" onClick={() => { setCustomerOpen(false); custForm.reset(); custForm.setValue('name', customerSearch); setCustomerSearch(''); setShowNewCustomer(true); }}>Create "{customerSearch}"?</button></CommandEmpty>
                            <CommandGroup className="max-h-52 overflow-auto">
                              <CommandItem value="0" onSelect={() => { field.onChange(undefined); setCustomerOpen(false); setCustomerSearch(''); }}>
                                <Check className={cn('mr-2 h-4 w-4 shrink-0', !field.value ? 'opacity-100' : 'opacity-0')} />
                                Walk-in Customer
                              </CommandItem>
                              {filteredCustomers.map(c => (
                                <CommandItem key={c.id} value={String(c.id)} onSelect={() => { field.onChange(c.id); setCustomerOpen(false); setCustomerSearch(''); }}>
                                  <Check className={cn('mr-2 h-4 w-4 shrink-0', field.value === c.id ? 'opacity-100' : 'opacity-0')} />
                                  {c.name}{(c as any).state ? ` (${(c as any).state})` : ''}
                                  {(c as any).phone ? <span className="ml-2 text-xs text-muted-foreground">{(c as any).phone}</span> : null}
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          </Command>
                        </PopoverContent>
                      </Popover>
                      {watchCustomerId && isInterState && (
                        <p className="text-xs text-amber-500 mt-1">Inter-state supply → IGST applies</p>
                      )}
                      {watchCustomerId && !isInterState && companyState && customerState && (
                        <p className="text-xs text-emerald-600 mt-1">Intra-state supply → CGST + SGST apply</p>
                      )}
                      {customerHasGstin && (
                        <p className="text-xs text-muted-foreground mt-1 font-mono">
                          GSTIN: {String((selectedCustomer as any)?.gstNumber ?? (selectedCustomer as any)?.gst_number ?? '')}
                        </p>
                      )}
                    </FormItem>
                  );
                }} />
                <FormField control={form.control} name="quoteDate" render={({ field }) => (
                  <FormItem><FormLabel>Date <span className="text-destructive">*</span></FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="validTill" render={({ field }) => (
                  <FormItem><FormLabel>Valid Till</FormLabel><FormControl><Input type="date" {...field} value={field.value ?? ''} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="paymentTerms" render={({ field }) => (
                  <FormItem><FormLabel>Payment Terms</FormLabel><FormControl><Input placeholder="e.g. 50% advance, balance on delivery" {...field} value={field.value ?? ''} /></FormControl></FormItem>
                )} />
                <FormField control={form.control} name="salesperson" render={({ field }) => (
                  <FormItem><FormLabel>Salesperson</FormLabel><FormControl><Input placeholder="Who is quoting" {...field} value={field.value ?? ''} /></FormControl></FormItem>
                )} />
                <FormField control={form.control} name="placeOfSupply" render={({ field }) => (
                  <FormItem><FormLabel>Place of Supply</FormLabel>
                    <FormControl><StateCombobox value={field.value || ''} onChange={field.onChange} data-testid="select-place-of-supply" /></FormControl>
                  </FormItem>
                )} />
                <FormField control={form.control} name="status" render={({ field }) => (
                  <FormItem><FormLabel>Status</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        {/* A new quotation starts as Draft or Sent; the rest are reached later. */}
                        {(editItem ? (['draft', 'sent', 'accepted', 'rejected', 'expired'] as const) : (['draft', 'sent'] as const)).map(s => (
                          <SelectItem key={s} value={s}>{STATUS_LABEL[s]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )} />
              </div>

              {/* Coupon code — same Settings gating as Sales */}
              {!couponsEnabled && watchCouponCode ? (
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-medium">Coupon Code</span>
                  <span className="font-mono uppercase tracking-wider text-sm text-muted-foreground">
                    {watchCouponCode} <span className="normal-case font-sans">(applied when this quotation was created — coupon entry is turned off in Settings)</span>
                  </span>
                </div>
              ) : null}
              {couponsEnabled && (
              <div className="flex gap-2 items-end">
                <FormField control={form.control} name="couponCode" render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel className="text-sm">Coupon Code <span className="text-xs text-muted-foreground font-normal">(optional)</span></FormLabel>
                    <FormControl>
                      <Input
                        placeholder="e.g. SUMMER10"
                        className="uppercase font-mono tracking-wider"
                        {...field}
                        onChange={e => field.onChange(e.target.value.toUpperCase())}
                      />
                    </FormControl>
                  </FormItem>
                )} />
                <div className="pb-1">
                  {watchCouponCode && appliedCoupon && (
                    <div className="flex items-center gap-1.5 px-3 py-2 rounded-md bg-emerald-500/10 border border-emerald-500/30 text-emerald-600 text-sm font-medium">
                      <Check className="w-4 h-4" />
                      {appliedCoupon.discountType === 'percentage'
                        ? `${appliedCoupon.discountValue}% off`
                        : `₹${Number(appliedCoupon.discountValue).toLocaleString('en-IN')} off`}
                    </div>
                  )}
                  {watchCouponCode && !appliedCoupon && (
                    preservedBillDiscount !== null && preservedBillDiscount > 0 ? (
                      <div className="flex items-center gap-1.5 px-3 py-2 rounded-md bg-amber-500/10 border border-amber-500/30 text-amber-600 text-sm">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        Coupon no longer active — keeping the original ₹{preservedBillDiscount.toLocaleString('en-IN')} discount
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 px-3 py-2 rounded-md bg-destructive/10 border border-destructive/20 text-destructive text-sm">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        Invalid / expired
                      </div>
                    )
                  )}
                </div>
              </div>
              )}

              {/* Line items — stock shown for information; quoting never blocks on it */}
              <div>
                {!watchLocationId || watchLocationId === 0 ? (
                  <div className="p-6 border border-dashed border-border rounded-lg text-center text-muted-foreground">Select a selling location above to start quoting</div>
                ) : (
                  <>
                    <div className="flex justify-between items-center mb-3">
                      <p className="font-semibold">Quoted Items <span className="text-xs text-muted-foreground font-normal ml-1">(stock shown for reference — nothing is reserved)</span></p>
                      <Button type="button" variant="outline" size="sm" onClick={() => append({ itemId: 0, quantity: 1, unitPrice: 0, unitDiscount: 0, taxable: customerHasGstin, taxableTouched: false })}>
                        <Plus className="w-3 h-3 mr-1" /> Add Item
                      </Button>
                    </div>
                    <div className="overflow-x-auto"><div className="min-w-[720px] space-y-2">
                      {fields.map((field, index) => {
                        const itemId   = form.watch(`lineItems.${index}.itemId`);
                        const qty      = form.watch(`lineItems.${index}.quantity`);
                        const unitPrice = Number(form.watch(`lineItems.${index}.unitPrice`) ?? 0);
                        const taxRate  = Number((getItem(itemId) as any)?.taxRate ?? 0);
                        const unitDisc = Math.min(Math.max(0, Number(form.watch(`lineItems.${index}.unitDiscount`) ?? 0)), unitPrice);
                        const disc     = Math.round(unitDisc * qty * 100) / 100;
                        const taxable  = !!form.watch(`lineItems.${index}.taxable`);
                        const gst      = computeLineGst(1, Math.max(0, Math.round((qty * unitPrice - disc) * 100) / 100), taxRate, isInterState, 0, taxable);
                        const lineTotal = gst.lineGross;
                        const available = stockMap.get(Number(itemId)) ?? 0;

                        return (
                          <div key={field.id} data-kbd-row={index} className="p-3 bg-muted/20 rounded-lg border border-border space-y-2">
                            <FormField control={form.control} name={`lineItems.${index}.itemId`} render={({ field: f }) => (
                              <FormItem>
                                <FormLabel className="text-xs">Item</FormLabel>
                                <FormControl><SearchableItemSelect
                                  className="h-8 text-xs"
                                  columns={['available', 'mrp', 'gst']}
                                  advanceOnSelect
                                  data-testid={`input-line-item-${index}`}
                                  items={lineItemOptions(Number(f.value))}
                                  value={f.value}
                                  onChange={id => {
                                    f.onChange(id);
                                    form.setValue(`lineItems.${index}.unitPrice`, getPrice(id));
                                  }}
                                /></FormControl>
                              </FormItem>
                            )} />

                            <div className="grid grid-cols-12 gap-2 items-end">
                              <div className="col-span-2">
                                <FormField control={form.control} name={`lineItems.${index}.quantity`} render={({ field: f }) => (
                                  <FormItem>
                                    <FormLabel className="text-xs">Qty</FormLabel>
                                    <FormControl><Input type="number" min={1} className="h-8 text-xs" data-last-field={!discountsEnabled && index === fields.length - 1 ? "1" : undefined} {...f} /></FormControl>
                                  </FormItem>
                                )} />
                                {itemId > 0 && qty > available && (
                                  <p className="text-[10px] text-amber-500 mt-0.5">Only {available} in stock</p>
                                )}
                              </div>

                              <div className="col-span-3">
                                <p className="text-xs font-medium mb-1.5 text-foreground/80">
                                  MRP (₹) <span className="text-[10px] text-muted-foreground font-normal">from Item Master</span>
                                </p>
                                <div className={`h-8 flex items-center px-3 rounded-md border text-xs font-mono select-none cursor-default ${
                                  unitPrice > 0
                                    ? 'border-border bg-muted/40 text-foreground'
                                    : 'border-amber-500/40 bg-amber-500/5 text-amber-500 text-[10px]'
                                }`}>
                                  {unitPrice > 0
                                    ? `₹${unitPrice.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
                                    : 'Set MRP in Item Master'}
                                </div>
                                <FormField control={form.control} name={`lineItems.${index}.taxable`} render={({ field: f }) => (
                                  <label
                                    className="mt-1 flex items-center gap-1.5 cursor-pointer select-none w-fit"
                                    title={f.value
                                      ? 'Price is the taxable base — GST will be added on top'
                                      : 'Price includes GST — tax is extracted from it'}
                                  >
                                    <Checkbox
                                      className="h-3.5 w-3.5"
                                      checked={!!f.value}
                                      onCheckedChange={(v) => {
                                        f.onChange(v === true);
                                        form.setValue(`lineItems.${index}.taxableTouched`, true);
                                      }}
                                    />
                                    <span className="text-[10px] text-muted-foreground">
                                      Taxable{taxRate > 0 ? (f.value ? ' (+GST on top)' : ' (GST incl.)') : ''}
                                    </span>
                                  </label>
                                )} />
                              </div>

                              <div className="col-span-3">
                                {!discountsEnabled ? (
                                  unitDisc > 0 ? (
                                    <div className="pt-5">
                                      <p className="text-[10px] text-muted-foreground font-medium">
                                        Disc ₹{unitDisc.toLocaleString('en-IN', { minimumFractionDigits: 2 })}/unit (existing)
                                      </p>
                                    </div>
                                  ) : null
                                ) : (
                                <FormField control={form.control} name={`lineItems.${index}.unitDiscount`} render={({ field: f }) => (
                                  <FormItem>
                                    <FormLabel className="text-xs">Disc / Unit (₹)</FormLabel>
                                    <FormControl>
                                      <Input
                                        type="number" min={0} step="0.01"
                                        max={itemId > 0 ? unitPrice : undefined}
                                        disabled={!itemId || unitPrice <= 0}
                                        placeholder="0"
                                        className="h-8 text-xs"
                                        data-last-field={index === fields.length - 1 ? '1' : undefined}
                                        {...f}
                                        value={(f.value as any) ?? ''}
                                      />
                                    </FormControl>
                                    <FormMessage className="text-[10px]" />
                                    {unitDisc > 0 && unitPrice > 0 && (
                                      <p className="text-[10px] text-emerald-600 font-medium mt-0.5">
                                        Effective ₹{Math.max(0, unitPrice - unitDisc).toLocaleString('en-IN', { minimumFractionDigits: 2 })}/unit
                                      </p>
                                    )}
                                  </FormItem>
                                )} />
                                )}
                              </div>

                              <div className="col-span-3 text-right pb-0.5 space-y-0.5">
                                {itemId > 0 ? (
                                  unitPrice > 0 ? (
                                    <>
                                      <p className="text-xs text-muted-foreground">Subtotal ₹{gst.lineSubtotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</p>
                                      {taxRate > 0 && (
                                        <p className="text-xs text-amber-500 font-medium">
                                          {isInterState ? 'IGST' : 'CGST+SGST'} ({taxRate}%) = ₹{gst.taxAmount.toFixed(2)}
                                        </p>
                                      )}
                                      {taxRate === 0 && <p className="text-xs text-muted-foreground/50">No GST</p>}
                                      {disc > 0 && (
                                        <p className="text-xs text-emerald-600 font-medium">Disc −₹{Math.min(disc, qty * unitPrice).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</p>
                                      )}
                                      <p className="font-mono font-bold text-primary text-sm">₹{lineTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</p>
                                    </>
                                  ) : (
                                    <p className="text-xs text-amber-400 italic">No MRP</p>
                                  )
                                ) : (
                                  <p className="text-muted-foreground text-xs">—</p>
                                )}
                              </div>
                              <div className="col-span-1 pb-0.5 flex justify-end">
                                <Button type="button" variant="ghost" size="icon" tabIndex={-1} className="h-7 w-7 text-destructive" onClick={() => remove(index)} disabled={fields.length === 1}><Trash2 className="w-3 h-3" /></Button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div></div>
                  </>
                )}
              </div>

              {/* ── Tax Summary + Footer (identical arithmetic to Sales) ── */}
              <DialogFooter className="flex-col gap-0 sm:flex-col w-full pt-2 border-t border-border">
                {hasItems && (
                  <div className="w-full mb-3 rounded-lg border border-border overflow-hidden text-sm">
                    <div className="px-3 py-1.5 bg-muted/30 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                      Quotation Summary
                    </div>
                    <div className="px-3 py-2 space-y-1.5">
                      {(totals.itemDiscountTotal > 0 || totals.billDiscount > 0) && (
                        <div className="flex justify-between text-muted-foreground">
                          <span>Gross Item Value</span>
                          <span className="font-mono">₹{totals.grossItemValue.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                        </div>
                      )}
                      {totals.itemDiscountTotal > 0 && (
                        <div className="flex justify-between text-emerald-600 font-medium">
                          <span>Item Discounts (off MRP)</span>
                          <span className="font-mono">−₹{totals.itemDiscountTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                        </div>
                      )}
                      {discountsEnabled ? (
                      <div className="flex justify-between items-center gap-2">
                        <span className="text-emerald-600 font-medium">Bill Discount (pre-tax)</span>
                        <FormField control={form.control} name="billDiscount" render={({ field: f }) => (
                          <FormItem className="space-y-0">
                            <FormControl>
                              <Input
                                type="number" min={0} step="0.01"
                                placeholder="0"
                                className="h-7 w-28 text-xs text-right font-mono"
                                {...f}
                                value={(f.value as any) ?? ''}
                              />
                            </FormControl>
                          </FormItem>
                        )} />
                      </div>
                      ) : Number(form.watch('billDiscount') ?? 0) > 0 ? (
                        <div className="flex justify-between items-center gap-2">
                          <span className="text-emerald-600 font-medium">Bill Discount (pre-tax, existing)</span>
                          <span className="font-mono text-xs">−₹{Number(form.watch('billDiscount') ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                        </div>
                      ) : null}
                      <div className="flex justify-between text-muted-foreground">
                        <span>Taxable Amount</span>
                        <span className="font-mono">₹{totals.subtotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                      </div>

                      {totals.taxTotal > 0 && (
                        <>
                          {isInterState ? (
                            <div className="flex justify-between">
                              <span className="text-amber-500">IGST (inter-state)</span>
                              <span className="font-mono text-amber-500">₹{totals.igstTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                            </div>
                          ) : (
                            <>
                              <div className="flex justify-between text-muted-foreground">
                                <span>CGST</span>
                                <span className="font-mono">₹{totals.cgstTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                              </div>
                              <div className="flex justify-between text-muted-foreground">
                                <span>SGST</span>
                                <span className="font-mono">₹{totals.sgstTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                              </div>
                            </>
                          )}
                          <div className="flex justify-between text-xs py-1 px-2 rounded bg-amber-500/8 text-amber-600 border border-amber-500/15">
                            <span className="font-medium">Total GST (indicative — posted only when a sale is made)</span>
                            <span className="font-mono font-semibold">₹{totals.taxTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                          </div>
                        </>
                      )}

                      {totals.taxTotal === 0 && totals.subtotal > 0 && (
                        <p className="text-xs text-muted-foreground/50 italic">No GST applicable on selected items</p>
                      )}

                      <Separator className="my-1" />

                      {totals.discountAmount > 0 && (appliedCoupon || preservedBillDiscount !== null) && (
                        <div className="flex justify-between text-emerald-600 font-medium">
                          <span className="flex items-center gap-1">
                            <Check className="w-3.5 h-3.5" />
                            {watchCouponCode ? <>Coupon <span className="font-mono text-xs ml-1">{watchCouponCode}</span></> : 'Flat Discount (post-tax)'}
                            {appliedCoupon?.discountType === 'percentage' && <span className="text-xs text-muted-foreground ml-1">({appliedCoupon.discountValue}%)</span>}
                            {!appliedCoupon && preservedBillDiscount !== null && preservedBillDiscount > 0 && <span className="text-xs text-muted-foreground ml-1">(original)</span>}
                          </span>
                          <span className="font-mono">−₹{totals.discountAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                        </div>
                      )}

                      <div className="flex justify-between font-bold text-base">
                        <span>Quoted Total</span>
                        <span className="font-mono text-primary">₹{totals.finalAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                      </div>
                    </div>
                  </div>
                )}
                <div className="flex gap-2 justify-end w-full">
                  <Button variant="outline" type="button" onClick={() => { setIsOpen(false); setEditItem(null); form.reset(defaultFormValues); }}>Cancel</Button>
                  <Button type="submit" disabled={(editItem ? updateMutation.isPending : createMutation.isPending) || !watchLocationId || totals.finalAmount === 0}>
                    {editItem
                      ? (updateMutation.isPending ? 'Saving…' : 'Save Changes')
                      : (createMutation.isPending ? 'Saving…' : 'Save Quotation')}
                  </Button>
                </div>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* ── Quick Create Customer Dialog (mirrors Sales) ── */}
      <Dialog open={showNewCustomer} onOpenChange={v => { setShowNewCustomer(v); if (!v) custForm.reset(); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>Add Customer</DialogTitle></DialogHeader>
          <Form {...custForm}>
            <form onSubmit={custForm.handleSubmit((data: any) => {
              createCustomerMutation.mutate(
                { data: { name: data.name, phone: data.phone || undefined, email: data.email || undefined, gstNumber: data.gstNumber || undefined, state: data.state || undefined, address: data.address || undefined, notes: data.notes || undefined } as any },
                {
                  onSuccess: (created: any) => {
                    queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
                    queryClient.invalidateQueries({ queryKey: ['customers'] });
                    form.setValue('customerId', created.id);
                    toast.success(`Customer "${created.name}" created`);
                    setShowNewCustomer(false);
                    custForm.reset();
                  },
                  onError: (e: any) => toast.error(e?.data?.error || 'Could not create customer'),
                }
              );
            })} className="space-y-4 pt-2">
              <FormField control={custForm.control} name="name" render={({ field }) => (
                <FormItem><FormLabel>Name <span className="text-destructive">*</span></FormLabel><FormControl><Input placeholder="Full name / company name" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FormField control={custForm.control} name="phone" render={({ field }) => (
                  <FormItem><FormLabel>Phone</FormLabel><FormControl><Input {...field} /></FormControl></FormItem>
                )} />
                <FormField control={custForm.control} name="email" render={({ field }) => (
                  <FormItem><FormLabel>Email</FormLabel><FormControl><Input type="email" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={custForm.control} name="gstNumber" render={({ field }) => (
                  <FormItem><FormLabel>GST Number (GSTIN)</FormLabel><FormControl><Input placeholder="15-char GSTIN" className="font-mono" {...field} /></FormControl></FormItem>
                )} />
                <FormField control={custForm.control} name="state" render={({ field }) => (
                  <FormItem><FormLabel>State</FormLabel>
                    <FormControl><StateCombobox value={field.value || ''} onChange={field.onChange} data-testid="select-quick-customer-state" /></FormControl>
                  </FormItem>
                )} />
              </div>
              <FormField control={custForm.control} name="address" render={({ field }) => (
                <FormItem><FormLabel>Address</FormLabel><FormControl><Textarea rows={2} {...field} /></FormControl></FormItem>
              )} />
              <FormField control={custForm.control} name="notes" render={({ field }) => (
                <FormItem><FormLabel>Notes</FormLabel><FormControl><Textarea rows={2} {...field} /></FormControl></FormItem>
              )} />
              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => { setShowNewCustomer(false); custForm.reset(); }}>Cancel</Button>
                <Button type="submit" disabled={createCustomerMutation.isPending}>{createCustomerMutation.isPending ? 'Saving…' : 'Save'}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Quotation View Sheet */}
      <Sheet open={!!viewItem} onOpenChange={v => !v && setViewItem(null)}>
        <SheetContent className="overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <div className="flex items-start justify-between gap-2">
              <div>
                <SheetTitle className="flex items-center gap-2"><FileText className="w-5 h-5 text-primary" />{viewItem?.quotationNumber}</SheetTitle>
                <SheetDescription>{viewItem?.locationName} · {viewItem && fmtDay(viewItem.quoteDate)}</SheetDescription>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {perm.canDownload && viewItem && (
                  <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void handleDownloadPDF(viewItem)} title="Download PDF">
                    <FileDown className="w-3.5 h-3.5" /> PDF
                  </Button>
                )}
                {perm.canDownload && viewItem && (
                  <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void handlePrintPDF(viewItem)} title="Print quotation">
                    <Printer className="w-3.5 h-3.5" /> Print
                  </Button>
                )}
                {perm.canEdit && viewItem && !viewItem.convertedSaleId && (
                  <Button variant="outline" size="sm" className="gap-1.5" onClick={() => { const q = viewItem; setViewItem(null); openEdit(q); }}>
                    <Pencil className="w-3.5 h-3.5" /> Edit
                  </Button>
                )}
              </div>
            </div>
          </SheetHeader>
          {viewItem && (
            <div className="mt-6 space-y-5">
              {/* Status + conversion banner */}
              <div className="flex items-center justify-between gap-2">
                <StatusBadge status={viewItem.status} />
                {!viewItem.convertedSaleId && perm.canEdit && (
                  <Select
                    value={viewItem.status === 'converted' ? '' : viewItem.status}
                    onValueChange={s => handleStatusChange(viewItem, s)}
                  >
                    <SelectTrigger className="h-7 w-36 text-xs"><SelectValue placeholder="Change status" /></SelectTrigger>
                    <SelectContent>
                      {(['draft', 'sent', 'accepted', 'rejected', 'expired'] as const).map(s => (
                        <SelectItem key={s} value={s}>{STATUS_LABEL[s]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              {viewItem.convertedInvoiceNumber && (
                <div className="rounded-lg border border-violet-500/30 bg-violet-500/5 p-3 text-sm">
                  <p className="font-semibold text-violet-600 flex items-center gap-1.5">
                    <ArrowRightLeft className="w-4 h-4" /> Converted To: {viewItem.convertedInvoiceNumber}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">This quotation became a sales invoice — it can no longer be edited or deleted.</p>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {[
                  ['Customer', viewItem.customerName || 'Walk-in'],
                  ['Valid Till', fmtDay(viewItem.validTill)],
                  ['Salesperson', viewItem.salesperson || '—'],
                  ['Payment Terms', viewItem.paymentTerms || '—'],
                  ['Place of Supply', viewItem.placeOfSupply || '—'],
                  ['Coupon', viewItem.couponCode || '—'],
                ].map(([k, v]) => (
                  <div key={k} className="flex flex-col gap-1">
                    <span className="text-xs text-muted-foreground uppercase tracking-wider">{k}</span>
                    <span className="font-semibold">{v}</span>
                  </div>
                ))}
              </div>

              {(viewItem.billingAddress || viewItem.shippingAddress) && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                  {viewItem.billingAddress && (
                    <div>
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Billing Address</p>
                      <p className="whitespace-pre-line">{viewItem.billingAddress}</p>
                    </div>
                  )}
                  {viewItem.shippingAddress && (
                    <div>
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Shipping Address</p>
                      <p className="whitespace-pre-line">{viewItem.shippingAddress}</p>
                    </div>
                  )}
                </div>
              )}

              {/* Line items */}
              <div>
                <p className="text-sm font-semibold mb-2">Items</p>
                <div className="space-y-2">
                  {(viewItem.lineItems || []).map((li: any, i: number) => {
                    const itemInfo = itemsMap.get(li.itemId);
                    const itemName = li.itemName || itemInfo?.name || `Item #${li.itemId}`;
                    const hsnCode = li.hsnCode || (itemInfo as any)?.hsnCode || '';
                    const lineSubtotal = li.lineSubtotal ?? (li.quantity * li.unitPrice);
                    return (
                      <div key={i} className="p-3 bg-muted/20 rounded-lg text-sm border border-border">
                        <div className="flex justify-between items-start">
                          <div>
                            <p className="font-medium">{itemName}</p>
                            {hsnCode && <p className="text-xs text-muted-foreground">HSN: {hsnCode}</p>}
                          </div>
                          <Badge variant="secondary" className="text-xs">{li.taxRate ?? 0}% GST</Badge>
                        </div>
                        <div className="mt-2 flex justify-between text-xs text-muted-foreground">
                          <span>
                            {li.quantity} × ₹{Number(li.unitPrice).toFixed(2)}
                            {Number(li.discount ?? 0) > 0 && (
                              <span className="text-emerald-600"> − ₹{Number(li.discount).toFixed(2)} disc</span>
                            )}
                          </span>
                          <span>Taxable: ₹{Number(lineSubtotal).toFixed(2)}</span>
                        </div>
                        {(li.taxAmount ?? 0) > 0 && (
                          <div className="mt-1 flex justify-between text-xs text-amber-600">
                            <span>{li.taxType === 'igst' ? `IGST ${li.taxRate}%` : `CGST ${(li.taxRate ?? 0) / 2}% + SGST ${(li.taxRate ?? 0) / 2}%`}</span>
                            <span>₹{Number(li.taxAmount).toFixed(2)}</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Totals — a quotation has no payment status, receipts or dues */}
              <div className="p-3 bg-muted/30 rounded-lg space-y-1.5 text-sm">
                {(() => {
                  const itemDisc = ((viewItem.lineItems as any[]) ?? []).reduce((s: number, li: any) => s + Number(li?.discount ?? 0), 0);
                  return itemDisc > 0 ? (
                    <div className="flex justify-between text-emerald-600">
                      <span>Item Discounts (off MRP)</span>
                      <span className="font-mono">−₹{itemDisc.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                    </div>
                  ) : null;
                })()}
                <div className="flex justify-between text-muted-foreground">
                  <span>Subtotal</span>
                  <span className="font-mono">₹{Number(viewItem.subtotal ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                </div>
                {Number(viewItem.taxTotal) > 0 && (
                  <div className="flex justify-between text-amber-600">
                    <span>Total Tax</span>
                    <span className="font-mono">₹{Number(viewItem.taxTotal).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                  </div>
                )}
                {Number(viewItem.discountTotal ?? 0) > 0 && (
                  <div className="flex justify-between text-emerald-600">
                    <span>Discount{viewItem.couponCode ? ` (${viewItem.couponCode})` : ''}</span>
                    <span className="font-mono">−₹{Number(viewItem.discountTotal).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                  </div>
                )}
                <Separator />
                <div className="flex justify-between font-bold text-base">
                  <span>Quoted Total</span>
                  <span className="font-mono text-primary">₹{Number(viewItem.totalAmount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                </div>
                {viewItem.validTill && (
                  <p className="text-xs text-muted-foreground pt-1">This quotation is valid until {fmtDay(viewItem.validTill)}.</p>
                )}
              </div>

              {(viewItem.notes || viewItem.termsConditions) && (
                <div className="space-y-3 text-sm">
                  {viewItem.notes && (
                    <div>
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Notes</p>
                      <p className="whitespace-pre-line">{viewItem.notes}</p>
                    </div>
                  )}
                  {viewItem.termsConditions && (
                    <div>
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Terms &amp; Conditions</p>
                      <p className="whitespace-pre-line">{viewItem.termsConditions}</p>
                    </div>
                  )}
                </div>
              )}

              {/* Convert */}
              {perm.canAdd && !viewItem.convertedSaleId && (
                <Button className="w-full gap-2" disabled={convertBusyId === viewItem.id} onClick={() => void handleConvert(viewItem)}>
                  <ArrowRightLeft className="w-4 h-4" />
                  {convertBusyId === viewItem.id ? 'Checking stock…' : 'Convert to Sale'}
                </Button>
              )}

              <div className="flex flex-col gap-3">
                <QuotationShareLinkPanel
                  quotationId={viewItem.id}
                  canShare={perm.canDownload}
                  customerPhone={viewItem.customerPhone}
                  onShareWhatsApp={() => handleWhatsApp(viewItem)}
                />
                {perm.canDownload && (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <Button variant="outline" onClick={() => void handlePreviewPDF(viewItem)}>
                      <Eye className="w-4 h-4 mr-2" /> Preview
                    </Button>
                    <Button variant="outline" onClick={() => void handleDownloadPDF(viewItem)}>
                      <FileDown className="w-4 h-4 mr-2" /> Download
                    </Button>
                    <Button variant="outline" onClick={() => void handlePrintPDF(viewItem)}>
                      <Printer className="w-4 h-4 mr-2" /> Print
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* ── Insufficient-stock warning (soft — never blocks conversion) ──────── */}
      <AlertDialog open={!!convertWarning} onOpenChange={v => { if (!v) setConvertWarning(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-amber-600">
              <AlertTriangle className="w-5 h-5" /> Not enough stock for some items
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm text-muted-foreground">
                <span className="block">
                  The quoted quantities exceed what is currently on the shelf at {convertWarning?.quotation.locationName}.
                  You can still proceed — adjust quantities on the sale form, or transfer stock first.
                </span>
                <div className="rounded-lg border border-border bg-muted/20 divide-y divide-border text-foreground">
                  {(convertWarning?.shortfalls ?? []).map(sf => (
                    <div key={sf.itemId} className="flex justify-between px-3 py-1.5">
                      <span className="text-xs">{sf.itemName}</span>
                      <span className="font-mono text-xs">
                        need {sf.requested} · have <span className="text-red-500 font-semibold">{sf.available}</span>
                      </span>
                    </div>
                  ))}
                </div>
                <span className="block">
                  The sale itself will still refuse quantities beyond available stock when it is completed.
                </span>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-amber-600 text-white hover:bg-amber-700"
              onClick={e => { e.preventDefault(); if (convertWarning) { const q = convertWarning.quotation; setConvertWarning(null); goConvert(q); } }}
            >
              Continue to Sale
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Delete confirmation ──────────────────────────────────────────────── */}
      <AlertDialog open={!!deleteTarget} onOpenChange={v => { if (!v) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?.quotationNumber}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the quotation and its share links. Nothing else is affected — quotations
              never touched stock or the books. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={e => { e.preventDefault(); handleDelete(); }}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
