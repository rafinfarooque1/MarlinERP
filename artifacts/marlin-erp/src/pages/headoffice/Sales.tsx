import { useState, useMemo, useEffect } from 'react';
import {
  usePaginatedSales, useCreateSale, useListOutlets, useListCustomers, useCreateCustomer,
  useListItems, useListItemPrices, useListStock, useGetCompanySettings,
  getListCustomersQueryKey, useListCoupons,
  customFetch,
  useGetSalePayments, useCreateSalePayment, useUpdateSale,
} from '@workspace/api-client-react';
import { usePermission } from '@/lib/usePermission';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LocationFilter, parseLocationFilter } from '@/components/ui/LocationFilter';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem } from '@/components/ui/command';
import { Textarea } from '@/components/ui/textarea';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { INDIAN_STATES } from '@/lib/indianStates';
import {
  Plus, Search, Trash2, CreditCard, Calendar, Receipt,
  Download, Eye, PackageOpen, FileDown, AlertTriangle,
  UserPlus, Check, ChevronsUpDown, Banknote, IndianRupee, Pencil,
} from 'lucide-react';

// ── WhatsApp brand icon (inline SVG) ──────────────────────────────────────────
function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
    </svg>
  );
}
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { downloadCSV } from '@/lib/download';
import { Separator } from '@/components/ui/separator';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

// ── Types ──────────────────────────────────────────────────────────────────────

interface GstBreakdown {
  taxRate: number;
  taxType: 'cgst_sgst' | 'igst';
  lineGross: number;    // MRP × qty (GST-inclusive total for this line)
  lineSubtotal: number; // taxable amount (ex-GST, = lineGross / (1 + rate/100))
  cgst: number;
  sgst: number;
  igst: number;
  taxAmount: number;
}

// GST is INCLUSIVE in MRP. Back-calculate taxable from gross.
// `discount` is a flat ₹ amount off this line's gross (MRP × qty); GST is
// back-calculated from the discounted gross — matches the backend exactly.
function computeLineGst(
  qty: number, price: number, taxRate: number, isInterState: boolean, discount = 0
): GstBreakdown {
  const lineGross = Math.max(0, qty * price - discount); // MRP × qty − discount (inclusive)
  const lineSubtotal = taxRate > 0
    ? Math.round(lineGross / (1 + taxRate / 100) * 100) / 100
    : lineGross; // taxable (ex-GST)
  const rawTax = Math.round((lineGross - lineSubtotal) * 100) / 100;
  if (isInterState) {
    return { taxRate, taxType: 'igst', lineGross, lineSubtotal, cgst: 0, sgst: 0, igst: rawTax, taxAmount: rawTax };
  }
  const half = Math.round(rawTax / 2 * 100) / 100;
  return { taxRate, taxType: 'cgst_sgst', lineGross, lineSubtotal, cgst: half, sgst: half, igst: 0, taxAmount: rawTax };
}

// ── Form Schema ─────────────────────────────────────────────────────────────────

const saleLineSchema = z.object({
  itemId:    z.coerce.number().min(1, 'Item required'),
  quantity:  z.coerce.number().min(1, 'Qty ≥ 1'),
  unitPrice: z.coerce.number().min(0, 'Price required'),
  discount:  z.coerce.number().min(0, 'Discount ≥ 0').optional(),
}).refine(li => (li.discount ?? 0) <= li.quantity * li.unitPrice, {
  message: 'Discount exceeds line amount',
  path: ['discount'],
});
const schema = z.object({
  locationType: z.enum(['outlet', 'warehouse']).default('outlet'),
  locationId: z.coerce.number().min(1, 'Location required'),
  customerId: z.coerce.number().optional(),
  saleDate: z.string().min(1, 'Date required'),
  paymentMode: z.enum(['cash', 'credit']).default('cash'),
  couponCode: z.string().optional(),
  lineItems: z.array(saleLineSchema).min(1, 'Add at least one item'),
});
type FormValues = z.infer<typeof schema>;

// ── Customer quick-create schema (mirrors Customers page) ─────────────────────
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

const defaultFormValues: FormValues = {
  locationType: 'outlet',
  locationId: 0,
  saleDate: new Date().toISOString().split('T')[0],
  paymentMode: 'cash',
  couponCode: '',
  lineItems: [{ itemId: 0, quantity: 1, unitPrice: 0, discount: 0 }],
};

// ── Component ──────────────────────────────────────────────────────────────────

interface SalesProps {
  /** Override the permission module checked on this view. Defaults to 'Sales'.
   *  Pass 'Point of Sale' when rendering from the POS context so warehouse
   *  managers with POS permission don't see "Access Denied". */
  permissionModule?: string;
  /** When set, the POS form pre-selects this location and the list is filtered to it. */
  forceLocationType?: 'warehouse' | 'outlet';
  forceLocationId?: number;
  forceLocationName?: string;
  /** Additional outlet IDs to include in the list (used in warehouse mode to show child outlets). */
  forceChildOutletIds?: number[];
}

export default function Sales({ forceLocationType, forceLocationId, forceLocationName, permissionModule }: SalesProps = {}) {
  const perm = usePermission(permissionModule ?? 'Sales');
  const { data: outlets = [] } = useListOutlets();
  // 'all' | 'warehouse:<id>' | 'outlet:<id>'
  const [locationFilter, setLocationFilter] = useState<string>('all');
  const { type: locFilterType, id: locFilterId } = parseLocationFilter(locationFilter);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 25;

  // Debounce the search box — invoice/customer search runs server-side
  useEffect(() => {
    const t = setTimeout(() => { setDebouncedSearch(search.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  // Server-paginated list. A forced warehouse passes warehouseScope so the
  // server returns the warehouse plus its child outlets (replaces the old
  // client-side forceChildOutletIds filtering).
  const { data: salesPage, isLoading, isFetching } = usePaginatedSales({
    page,
    limit: PAGE_SIZE,
    q: debouncedSearch || undefined,
    ...(forceLocationType === 'warehouse' && forceLocationId
      ? { warehouseScope: forceLocationId }
      : forceLocationType === 'outlet' && forceLocationId
        ? { locationType: 'outlet' as const, locationId: forceLocationId }
        : locFilterType === 'warehouse' && locFilterId
          ? { warehouseScope: locFilterId }
          : locFilterType === 'outlet' && locFilterId
            ? { locationType: 'outlet' as const, locationId: locFilterId }
            : {}),
  });
  const sales = salesPage?.rows ?? [];
  const totalSales = salesPage?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalSales / PAGE_SIZE));

  // Clamp page when the result set shrinks (deletes, concurrent changes)
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);
  // When operating inside a specific location (Sales segment), scope customers to that location only
  const { data: customers = [] } = useQuery<any[]>({
    queryKey: ['customers', forceLocationType, forceLocationId],
    queryFn: () => forceLocationType && forceLocationId
      ? customFetch(`/api/customers?locationType=${forceLocationType}&locationId=${forceLocationId}`)
      : customFetch('/api/customers'),
  });
  const { data: items = [] } = useListItems();
  const { data: companySettings } = useGetCompanySettings();
  const [statusFilter, setStatusFilter] = useState<'all' | 'unpaid' | 'partially_paid' | 'paid'>('all');
  const [isOpen, setIsOpen] = useState(false);
  const [viewItem, setViewItem] = useState<any>(null);
  const [viewQrUrl, setViewQrUrl] = useState<string | null>(null);
  // Credit-limit override: holds the rejected payload + 409 details while the
  // manager decides whether to proceed anyway.
  const [creditWarning, setCreditWarning] = useState<{ payload: any; info: any } | null>(null);

  // Multi-method payment state — each row has its own method, amount and reference
  type PRow = { id: number; method: string; amount: string; ref: string };
  const [paymentRows, setPaymentRows] = useState<PRow[]>([{ id: 1, method: 'cash', amount: '', ref: '' }]);
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().split('T')[0]);
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  // Derived values used by the UPI QR effect below
  const upiRow = paymentRows.find(r => r.method === 'upi');
  const paymentMethod = upiRow ? 'upi' : (paymentRows[0]?.method ?? 'cash');
  const paymentAmount = upiRow?.amount ?? paymentRows[0]?.amount ?? '';

  // Generate UPI QR data URL whenever the invoice view opens or a UPI row's amount changes.
  useEffect(() => {
    if (!viewItem || !(viewItem as any).outletUpiId) { setViewQrUrl(null); return; }
    const upiId  = (viewItem as any).outletUpiId as string;
    const balanceDue = Number((viewItem as any).balanceDue ?? viewItem.totalAmount);
    const collectionAmount = paymentAmount && Number(paymentAmount) > 0
      ? Number(paymentAmount)
      : balanceDue;
    const amount = Math.max(0, collectionAmount).toFixed(2);
    const upiUri = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(viewItem.outletName || '')}&am=${amount}&cu=INR&tn=${encodeURIComponent(viewItem.invoiceNumber || '')}`;
    let cancelled = false;
    (import('qrcode') as Promise<any>).then(QR => {
      QR.toDataURL(upiUri, { width: 200, margin: 2 }).then((url: string) => { if (!cancelled) setViewQrUrl(url); });
    }).catch(() => { if (!cancelled) setViewQrUrl(null); });
    return () => { cancelled = true; };
  }, [viewItem, paymentRows]);
  const queryClient = useQueryClient();

  // Refresh every sales-derived view after a write: sales lists (legacy +
  // paginated), sales summary, dashboard analytics and stock levels.
  const invalidateSalesData = () =>
    queryClient.invalidateQueries({
      predicate: q => {
        const k = String(q.queryKey[0] ?? '');
        return k.startsWith('/api/sales') || k.startsWith('/api/dashboard') || k.startsWith('/api/stock');
      },
    });

  const createMutation = useCreateSale();
  const updateMutation = useUpdateSale();
  const createCustomerMutation = useCreateCustomer();

  // editItem holds the sale being edited; null means "create" mode
  const [editItem, setEditItem] = useState<any>(null);

  const openEdit = (sale: any) => {
    setEditItem(sale);
    form.reset({
      locationType: (sale.locationType ?? 'outlet') as 'outlet' | 'warehouse',
      locationId: sale.locationId ?? sale.outletId ?? 0,
      customerId: sale.customerId ?? undefined,
      saleDate: sale.saleDate,
      paymentMode: (['cash', 'credit'].includes(sale.paymentMode) ? sale.paymentMode : 'cash') as FormValues['paymentMode'],
      couponCode: sale.couponCode ?? '',
      lineItems: (sale.lineItems ?? []).map((li: any) => ({
        itemId: li.itemId,
        quantity: li.quantity,
        unitPrice: li.unitPrice,
        discount: Number(li.discount ?? 0),
      })),
    });
    setIsOpen(true);
  };

  const { data: viewItemPayments = [], isLoading: paymentsLoading } = useGetSalePayments(viewItem?.id ?? 0, { enabled: !!viewItem });
  const createPaymentMutation = useCreateSalePayment();

  const handleCollectPayment = async () => {
    if (!viewItem) return;
    const validRows = paymentRows.filter(r => Number(r.amount) > 0);
    if (validRows.length === 0) { toast.error('Enter at least one payment amount'); return; }
    const totalPaying = validRows.reduce((s, r) => s + Number(r.amount), 0);
    const balanceDue = Number((viewItem as any).balanceDue ?? 0);
    if (totalPaying > balanceDue + 0.001) {
      toast.error(`Total ₹${totalPaying.toFixed(2)} exceeds balance due ₹${balanceDue.toFixed(2)}`); return;
    }
    try {
      let lastResult: any;
      for (const row of validRows) {
        lastResult = await createPaymentMutation.mutateAsync({
          saleId: viewItem.id,
          data: { method: row.method, amount: Number(row.amount), referenceNumber: row.ref || undefined, paymentDate },
        });
      }
      const label = validRows.length > 1
        ? `${validRows.length} payments totalling ₹${totalPaying.toLocaleString('en-IN')}`
        : `₹${totalPaying.toLocaleString('en-IN')} via ${validRows[0].method}`;
      toast.success(`Payment collected — ${label}`);
      setViewItem((prev: any) => prev ? { ...prev, paymentStatus: lastResult.newPaymentStatus, amountPaid: lastResult.newAmountPaid, balanceDue: Math.max(0, prev.totalAmount - lastResult.newAmountPaid) } : null);
      invalidateSalesData();
      setPaymentRows([{ id: Date.now(), method: 'cash', amount: '', ref: '' }]);
      setShowPaymentForm(false);
    } catch (e: any) {
      toast.error(e?.data?.error || e?.message || 'Failed to collect payment');
    }
  };

  // Customer combobox + quick-create state
  const [customerOpen, setCustomerOpen] = useState(false);
  const [customerSearch, setCustomerSearch] = useState('');
  const [showNewCustomer, setShowNewCustomer] = useState(false);

  // Quick-create customer form (schema defined at module level)
  const custForm = useForm<CustForm>({
    resolver: zodResolver(custSchema),
    defaultValues: { name: '', phone: '', email: '', gstNumber: '', state: '', address: '', notes: '' },
  });

  // Fetch warehouses (for combined location picker)
  const { data: warehouses = [] } = useQuery<any[]>({
    queryKey: ['warehouses'],
    queryFn: () => customFetch('/api/warehouses'),
  });

  // When the Sales segment forces a specific location, override the default form values
  const effectiveDefaultValues: FormValues = useMemo(() => ({
    ...defaultFormValues,
    locationType: (forceLocationType ?? defaultFormValues.locationType) as 'outlet' | 'warehouse',
    locationId: forceLocationId ?? defaultFormValues.locationId,
  }), [forceLocationType, forceLocationId]);

  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: effectiveDefaultValues });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'lineItems' });
  const watchLocationType = form.watch('locationType');
  const watchLocationId = form.watch('locationId');
  const watchCustomerId = form.watch('customerId');

  const { data: outletPrices = [] } = useListItemPrices(
    { outletId: watchLocationId },
    { query: { enabled: watchLocationType === 'outlet' && !!watchLocationId && watchLocationId > 0 } as any }
  );
  const { data: locationStock = [] } = useListStock(
    { branchType: (watchLocationType ?? 'outlet') as any, branchId: watchLocationId },
    { query: { enabled: !!watchLocationId && watchLocationId > 0 } as any }
  );

  const stockMap = new Map<number, number>(locationStock.map(s => [s.itemId!, Number(s.quantity ?? 0)]));
  const availableItems = items.filter(it => (stockMap.get(it.id) ?? 0) > 0);

  // Price comes from item MRP (set in Item Master) — not outlet-specific
  const getPrice = (itemId: number) => Number((items.find(i => i.id === itemId) as any)?.mrp ?? 0);
  const getAvailableQty = (itemId: number) => stockMap.get(itemId) ?? 0;
  const getItem = (itemId: number) => items.find(i => i.id === itemId);

  // GST state determination
  const companyState = ((companySettings as any)?.state ?? '').trim().toLowerCase();
  const selectedCustomer = customers.find(c => c.id === watchCustomerId);
  const customerState = ((selectedCustomer as any)?.state ?? '').trim().toLowerCase();
  const isInterState = !!(companyState && customerState && companyState !== customerState);

  // Coupon validation
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

  // Edit mode: while the coupon code is unchanged, preserve the sale's STORED
  // bill discount instead of re-deriving it from the live coupon list — the
  // coupon may have expired or changed since the sale was created, and
  // re-deriving would silently rewrite the agreed invoice total.
  const preservedBillDiscount = useMemo(() => {
    if (!editItem) return null;
    const orig = String((editItem as any).couponCode ?? '').trim().toUpperCase();
    if (orig !== watchCouponCode) return null; // coupon changed → re-derive live
    return Math.max(0, Number((editItem as any).discountTotal ?? 0));
  }, [editItem, watchCouponCode]);

  // Compute aggregated GST totals for the cart (inclusive GST — MRP already includes tax)
  const computeCartTotals = () => {
    let grossTotal = 0, subtotal = 0, cgstTotal = 0, sgstTotal = 0, igstTotal = 0, taxTotal = 0, itemDiscountTotal = 0;
    fields.forEach((_, i) => {
      const itemId = form.watch(`lineItems.${i}.itemId`);
      const qty    = form.watch(`lineItems.${i}.quantity`);
      const price  = Number(form.watch(`lineItems.${i}.unitPrice`) ?? 0);
      const disc   = Math.max(0, Number(form.watch(`lineItems.${i}.discount`) ?? 0));
      if (!itemId || price <= 0) return;
      const taxRate = Number((getItem(itemId) as any)?.taxRate ?? 0);
      const gst     = computeLineGst(qty, price, taxRate, isInterState, disc);
      grossTotal += gst.lineGross;            // net of item discount (inclusive)
      itemDiscountTotal += Math.min(disc, qty * price);
      subtotal   += gst.lineSubtotal;
      cgstTotal  += gst.cgst;
      sgstTotal  += gst.sgst;
      igstTotal  += gst.igst;
      taxTotal   += gst.taxAmount;
    });
    const grandTotal = grossTotal; // MRP × qty − item discounts — inclusive
    const discountAmount = preservedBillDiscount !== null
      ? Math.min(preservedBillDiscount, grandTotal)
      : appliedCoupon
        ? appliedCoupon.discountType === 'percentage'
          ? Math.round(grandTotal * Number(appliedCoupon.discountValue) / 100 * 100) / 100
          : Math.min(Number(appliedCoupon.discountValue), grandTotal)
        : 0;
    return { grossTotal, subtotal, cgstTotal, sgstTotal, igstTotal, taxTotal, itemDiscountTotal, grandTotal, discountAmount, finalAmount: grandTotal - discountAmount };
  };

  const totals = computeCartTotals();
  // True when at least one item is selected
  const hasItems = fields.some((_, i) => (form.watch(`lineItems.${i}.itemId`) ?? 0) > 0);

  const onSubmit = (data: FormValues) => {
    if (data.paymentMode === 'credit' && !data.customerId) {
      toast.error('Credit sales need a registered customer — pick one or change the payment mode.');
      return;
    }
    const enrichedItems = data.lineItems.map(li => ({
      itemId: li.itemId,
      quantity: li.quantity,
      unitPrice: Number(li.unitPrice),
      discount: Math.max(0, Number(li.discount ?? 0)),
      taxAmount: 0, // backend recomputes authoritatively
    }));
    const { discountAmount } = computeCartTotals();
    const payload = {
      ...data,
      locationType: data.locationType,
      locationId: data.locationId,
      // backward compat: send outletId for outlet sales
      outletId: data.locationType === 'outlet' ? data.locationId : (outlets[0]?.id ?? 1),
      lineItems: enrichedItems,
      customerId: data.customerId || undefined,
      discountTotal: discountAmount,
    } as any;

    if (editItem) {
      // Edit mode — PUT to existing sale
      updateMutation.mutate({ saleId: editItem.id, data: payload }, {
        onSuccess: (updated: any) => {
          toast.success('Sale updated successfully');
          invalidateSalesData();
          // Refresh view sheet if the edited sale is currently open
          if (viewItem?.id === editItem.id) setViewItem({ ...viewItem, ...updated });
          setIsOpen(false);
          setEditItem(null);
          form.reset(effectiveDefaultValues);
        },
        onError: (e: any) => toast.error(e?.data?.error || e.message || 'Could not update sale'),
      });
    } else {
      // Create mode — POST new sale
      createMutation.mutate({ data: payload }, {
        onSuccess: () => {
          toast.success('Sale recorded successfully');
          invalidateSalesData();
          setIsOpen(false);
          form.reset(effectiveDefaultValues);
        },
        onError: (e: any) => {
          const info = e?.data;
          if (e?.status === 409 && info?.code === 'CREDIT_LIMIT_EXCEEDED') {
            if (perm.canEdit) {
              // Managers may override — show the warning dialog
              setCreditWarning({ payload, info });
            } else {
              toast.error(
                `Credit limit exceeded: outstanding ₹${Number(info.currentOutstanding ?? 0).toLocaleString('en-IN')} + this sale ₹${Number(info.saleAmount ?? 0).toLocaleString('en-IN')} would pass the ₹${Number(info.creditLimit ?? 0).toLocaleString('en-IN')} limit. Ask a manager to override or collect payment first.`,
                { duration: 8000 },
              );
            }
            return;
          }
          toast.error(e?.data?.error || e.message || 'Could not record sale');
        },
      });
    }
  };

  // Manager confirmed: retry the same sale with the credit-override flag set.
  const proceedDespiteCredit = () => {
    if (!creditWarning) return;
    createMutation.mutate({ data: { ...creditWarning.payload, creditOverride: true } }, {
      onSuccess: () => {
        toast.success('Sale recorded (credit limit overridden)');
        invalidateSalesData();
        setCreditWarning(null);
        setIsOpen(false);
        form.reset(effectiveDefaultValues);
      },
      onError: (e: any) => {
        setCreditWarning(null);
        toast.error(e?.data?.error || e.message || 'Could not record sale');
      },
    });
  };

  // ── Invoice PDF (canonical server-side renderer) ───────────────────────────
  // ONE renderer lives on the API server (services/invoicePdf.ts). Every
  // channel — preview, download, WhatsApp — uses the same endpoint via a
  // signed, time-limited share token:
  //   POST /api/sales/:id/share-token              → { token }   (authenticated)
  //   GET  /api/public/invoices/:token.pdf[?download=1]          (public, signed)
  // The PDF is served over HTTPS with proper application/pdf headers and a
  // sanitized ASCII filename, which keeps antivirus software happy (blob:
  // URLs with no HTTP provenance were what triggered false positives before).
  const requestInvoicePdfUrl = async (saleId: number, download: boolean): Promise<string> => {
    const { token } = await customFetch<{ token: string; expiresAt: string }>(
      `/api/sales/${saleId}/share-token`,
      { method: 'POST' },
    );
    return `${window.location.origin}/api/public/invoices/${token}.pdf${download ? '?download=1' : ''}`;
  };

  // Download: navigate to the attachment URL — the browser saves exactly one
  // file (Content-Disposition: attachment) and the page stays where it is.
  const handleDownloadPDF = async (sale: any) => {
    try {
      window.location.assign(await requestInvoicePdfUrl(sale.id, true));
    } catch {
      toast.error('Unable to prepare the invoice PDF. Please try again.');
    }
  };

  // Preview: open the tab synchronously (inside the click gesture) so popup
  // blockers allow it, then point it at the inline PDF once the URL is ready.
  const handlePreviewPDF = async (sale: any) => {
    const tab = window.open('', '_blank');
    try {
      const url = await requestInvoicePdfUrl(sale.id, false);
      if (tab) tab.location.replace(url);
      else window.open(url, '_blank');
    } catch {
      tab?.close();
      toast.error('Unable to open the invoice PDF. Please try again.');
    }
  };

  // ── WhatsApp invoice share ─────────────────────────────────────────────────
  // Opens wa.me directly to the customer's chat with a short message holding a
  // secure HTTPS link to the invoice PDF — the customer taps the link to
  // view/download it. No attachments, no extra tabs, nothing to re-upload.
  //
  // Popup-safety: the tab is opened synchronously inside the click gesture and
  // redirected once the link is ready. (The previous setTimeout-based
  // window.open lost the user gesture → popup blocked → "nothing happened".)
  const handleWhatsApp = async (sale: any) => {
    const raw = (sale.customerPhone ?? '').replace(/\D/g, '');
    if (!raw) {
      toast.error('WhatsApp number is not available for this customer. Please update Customer Details.');
      return;
    }

    // Normalise to Indian international format without leading + (91XXXXXXXXXX)
    let intl = raw;
    if (raw.startsWith('91') && raw.length === 12) {
      intl = raw;                        // already 91XXXXXXXXXX
    } else if (raw.startsWith('0') && raw.length === 11) {
      intl = `91${raw.slice(1)}`;        // 0XXXXXXXXXX → 91XXXXXXXXXX
    } else {
      intl = `91${raw}`;                 // bare 10-digit → 91XXXXXXXXXX
    }

    const waTab = window.open('', '_blank'); // sync open — popup-blocker safe

    try {
      const pdfUrl = await requestInvoicePdfUrl(sale.id, false);

      const cs      = companySettings as any;
      const company = cs?.companyName ?? cs?.name ?? 'Marlin Frozen Fruits';
      const date    = new Date(sale.saleDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
      const total   = Number(sale.totalAmount).toLocaleString('en-IN', { minimumFractionDigits: 2 });

      const message = [
        `Dear ${sale.customerName || 'Customer'},`,
        ``,
        `Thank you for your purchase! 🙏`,
        ``,
        `*Invoice No:* ${sale.invoiceNumber}`,
        `*Date:* ${date}`,
        `*Amount:* ₹${total}`,
        ``,
        `View / download your invoice PDF here:`,
        pdfUrl,
        ``,
        `— ${sale.outletName || company}`,
      ].join('\n');

      const waUrl = `https://wa.me/${intl}?text=${encodeURIComponent(message)}`;
      if (waTab) waTab.location.replace(waUrl);
      else window.open(waUrl, '_blank');   // fallback if the tab was blocked
    } catch {
      waTab?.close();
      toast.error('Unable to prepare the WhatsApp share. Please try again.');
    }
  };

  // Search runs server-side; the status pills filter the current page locally.
  const filtered = sales.filter(s => statusFilter === 'all' || ((s as any).paymentStatus ?? 'paid') === statusFilter);

  const itemsMap = new Map(items.map(i => [i.id, i]));

  if (!perm.isLoading && !perm.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center py-32 text-muted-foreground gap-3">
          <AlertTriangle className="w-10 h-10 text-destructive/50" />
          <p className="text-lg font-medium">Access Denied</p>
          <p className="text-sm">You don't have permission to view Sales.</p>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><CreditCard className="w-6 h-6 text-primary" /> Point of Sale</h1>
            <p className="text-muted-foreground mt-1">Record and view retail transactions</p>
          </div>
          <div className="flex gap-2">
            {perm.canDownload && (
              <Button variant="outline" size="sm" onClick={() => downloadCSV('sales.csv', filtered.map(s => ({
                Invoice: s.invoiceNumber, Date: s.saleDate, Outlet: s.outletName,
                Customer: s.customerName || 'Walk-in', Payment: s.paymentMode,
                Subtotal: s.subtotal, Tax: s.taxTotal,
                Discount: (Number((s as any).discountTotal ?? 0)
                  + (((s as any).lineItems as any[]) ?? []).reduce((acc: number, li: any) => acc + Number(li?.discount ?? 0), 0)).toFixed(2),
                Total: s.totalAmount,
              })))}>
                <Download className="w-4 h-4 mr-2" /> Export
              </Button>
            )}
            {perm.canAdd && (
              <Button onClick={() => { form.reset(effectiveDefaultValues); setIsOpen(true); }}>
                <Plus className="w-4 h-4 mr-2" /> New Sale
              </Button>
            )}
          </div>
        </div>

        {/* Sales Table */}
        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex flex-wrap gap-3 bg-muted/20">
            <div className="flex items-center gap-2 flex-1 min-w-[180px]">
              <Search className="w-4 h-4 text-muted-foreground" />
              <Input placeholder="Search invoice or customer..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0" />
            </div>
            {/* Location filter — hidden when a specific location is already forced (e.g. POS context) */}
            {!forceLocationType && (
              <LocationFilter
                value={locationFilter}
                onChange={v => { setLocationFilter(v); setPage(1); }}
                className="w-48"
              />
            )}
          </div>
          {/* Payment status filter pills */}
          <div className="px-4 py-2 border-b border-border flex flex-wrap gap-2">
            {([
              { key: 'all', label: 'All' },
              { key: 'unpaid', label: 'Unpaid' },
              { key: 'partially_paid', label: 'Partial' },
              { key: 'paid', label: 'Paid' },
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
                <TableHead>Invoice</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Tax</TableHead>
                <TableHead className="text-right">Discount</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(4)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={9}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={9} className="text-center py-16 text-muted-foreground">
                  <Receipt className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No sales recorded yet</p>
                </TableCell></TableRow>
              ) : filtered.map(sale => (
                <TableRow key={sale.id} className="hover:bg-muted/10">
                  <TableCell className="font-mono text-primary font-bold">{sale.invoiceNumber}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    <div className="flex items-center gap-1"><Calendar className="w-3 h-3" />{new Date(sale.saleDate).toLocaleDateString('en-IN')}</div>
                  </TableCell>
                  <TableCell className="text-sm">{sale.outletName}</TableCell>
                  <TableCell className="text-sm">{sale.customerName || 'Walk-in'}</TableCell>
                  <TableCell>
                    {(() => {
                      const ps = (sale as any).paymentStatus ?? 'paid';
                      if (ps === 'paid') return <Badge className="text-[10px] bg-emerald-500/10 text-emerald-600 border-emerald-500/20">Paid</Badge>;
                      if (ps === 'partially_paid') return <Badge className="text-[10px] bg-amber-500/10 text-amber-600 border-amber-500/20">Partial</Badge>;
                      return <Badge className="text-[10px] bg-red-500/10 text-red-600 border-red-500/20">Unpaid</Badge>;
                    })()}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs text-muted-foreground">
                    {Number(sale.taxTotal) > 0 ? `₹${Number(sale.taxTotal).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '—'}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {(() => {
                      const d = Number((sale as any).discountTotal ?? 0)
                        + (((sale as any).lineItems as any[]) ?? []).reduce((s: number, li: any) => s + Number(li?.discount ?? 0), 0);
                      return d > 0
                        ? <span className="text-amber-600">₹{d.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                        : <span className="text-muted-foreground">—</span>;
                    })()}
                  </TableCell>
                  <TableCell className="text-right">
                    <p className="font-mono font-bold text-emerald-500">₹{Number(sale.totalAmount).toLocaleString('en-IN')}</p>
                    {((sale as any).paymentStatus === 'partially_paid' || (sale as any).paymentStatus === 'unpaid') && (
                      <p className="text-[10px] text-red-500 font-mono">Due: ₹{Number((sale as any).balanceDue ?? 0).toLocaleString('en-IN')}</p>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(sale)} title="View"><Eye className="w-4 h-4" /></Button>
                      {perm.canEdit && <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-amber-500" onClick={() => openEdit(sale)} title="Edit sale"><Pencil className="w-4 h-4" /></Button>}
                      {perm.canDownload && <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-emerald-600" onClick={() => void handleDownloadPDF(sale)} title="Download PDF"><FileDown className="w-4 h-4" /></Button>}
                      {(sale as any).customerPhone && (
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-[#25D366] hover:text-[#128C7E] hover:bg-[#25D366]/10" onClick={() => void handleWhatsApp(sale)} title={`Send invoice to ${(sale as any).customerPhone} via WhatsApp`}>
                          <WhatsAppIcon className="w-4 h-4" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {totalSales > 0 && (
            <div className="p-3 border-t border-border flex flex-wrap items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground">
                Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, totalSales)} of {totalSales} sales
                {isFetching ? ' · refreshing…' : ''}
              </span>
              <div className="flex items-center gap-3">
                <span className="font-bold text-emerald-500">
                  Page total: ₹{filtered.reduce((s, r) => s + Number(r.totalAmount || 0), 0).toLocaleString('en-IN')}
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

      {/* Sale Dialog */}
      <Dialog open={isOpen} onOpenChange={v => { setIsOpen(v); if (!v) { setEditItem(null); form.reset(effectiveDefaultValues); } }}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{editItem ? `Edit Sale — ${editItem.invoiceNumber}` : 'Record Sale'}</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="locationId" render={({ field }) => (
                  <FormItem><FormLabel>Selling Location <span className="text-destructive">*</span></FormLabel>
                    <Select
                      onValueChange={v => {
                        const [type, idStr] = v.split(':');
                        field.onChange(Number(idStr));
                        form.setValue('locationType', type as 'outlet' | 'warehouse');
                        form.setValue('lineItems', [{ itemId: 0, quantity: 1, unitPrice: 0 }]);
                      }}
                      value={field.value && field.value > 0 ? `${form.watch('locationType')}:${field.value}` : ''}
                    >
                      <FormControl><SelectTrigger><SelectValue placeholder="Select outlet or warehouse" /></SelectTrigger></FormControl>
                      <SelectContent>
                        {(warehouses as any[]).length > 0 && (
                          <SelectGroup>
                            <SelectLabel>Warehouses</SelectLabel>
                            {(warehouses as any[]).map((w: any) => (
                              <SelectItem key={w.id} value={`warehouse:${w.id}`}>🏭 {w.name}</SelectItem>
                            ))}
                          </SelectGroup>
                        )}
                        {outlets.length > 0 && (
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
                <FormField control={form.control} name="saleDate" render={({ field }) => (
                  <FormItem><FormLabel>Date <span className="text-destructive">*</span></FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
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
                        <PopoverContent align="start" className="p-0" style={{ width: 'var(--radix-popover-trigger-width)', minWidth: '240px' }}>
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
                        <p className="text-xs text-amber-500 mt-1">Inter-state sale → IGST applies</p>
                      )}
                      {watchCustomerId && !isInterState && companyState && customerState && (
                        <p className="text-xs text-emerald-600 mt-1">Intra-state sale → CGST + SGST apply</p>
                      )}
                    </FormItem>
                  );
                }} />
                <FormField control={form.control} name="paymentMode" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Payment Mode <span className="text-destructive">*</span></FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger><SelectValue placeholder="Select mode" /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="cash">💵 Cash</SelectItem>
                        <SelectItem value="credit">🕒 Credit (pay later)</SelectItem>
                      </SelectContent>
                    </Select>
                    {field.value === 'credit' && !watchCustomerId && (
                      <p className="text-xs text-amber-500 mt-1">Credit sales need a registered customer</p>
                    )}
                    <FormMessage />
                  </FormItem>
                )} />
              </div>

              {/* Coupon code */}
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

              {/* Line items */}
              <div>
                {!watchLocationId || watchLocationId === 0 ? (
                  <div className="p-6 border border-dashed border-border rounded-lg text-center text-muted-foreground">Select a selling location above to load available stock</div>
                ) : availableItems.length === 0 ? (
                  <div className="p-6 border border-dashed border-amber-500/40 rounded-lg text-center text-amber-500 bg-amber-500/5 flex flex-col items-center gap-2">
                    <PackageOpen className="w-8 h-8 opacity-60" />
                    <p className="font-medium">No stock available at this outlet</p>
                    <p className="text-xs text-muted-foreground">Transfer stock to this outlet before recording a sale</p>
                  </div>
                ) : (
                  <>
                    <div className="flex justify-between items-center mb-3">
                      <p className="font-semibold">Cart Items <span className="text-xs text-muted-foreground font-normal ml-1">({availableItems.length} in stock)</span></p>
                      <Button type="button" variant="outline" size="sm" onClick={() => append({ itemId: 0, quantity: 1, unitPrice: 0, discount: 0 })}>
                        <Plus className="w-3 h-3 mr-1" /> Add Item
                      </Button>
                    </div>
                    <div className="space-y-2">
                      {fields.map((field, index) => {
                        const itemId   = form.watch(`lineItems.${index}.itemId`);
                        const qty      = form.watch(`lineItems.${index}.quantity`);
                        const unitPrice = Number(form.watch(`lineItems.${index}.unitPrice`) ?? 0);
                        const availQty = getAvailableQty(itemId);
                        const taxRate  = Number((getItem(itemId) as any)?.taxRate ?? 0);
                        const disc     = Math.max(0, Number(form.watch(`lineItems.${index}.discount`) ?? 0));
                        const gst      = computeLineGst(qty, unitPrice, taxRate, isInterState, disc);
                        const lineTotal = gst.lineGross; // MRP × qty − discount (inclusive of GST)

                        return (
                          <div key={field.id} className="p-3 bg-muted/20 rounded-lg border border-border space-y-2">
                            {/* Row 1: Item selector */}
                            <FormField control={form.control} name={`lineItems.${index}.itemId`} render={({ field: f }) => (
                              <FormItem>
                                <FormLabel className="text-xs">Item</FormLabel>
                                <Select
                                  onValueChange={v => {
                                    const id = Number(v);
                                    f.onChange(id);
                                    // Auto-fill from Item Master MRP — read-only in sale
                                    form.setValue(`lineItems.${index}.unitPrice`, getPrice(id));
                                  }}
                                  value={f.value ? String(f.value) : ''}
                                >
                                  <FormControl><SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Select item" /></SelectTrigger></FormControl>
                                  <SelectContent>
                                    {availableItems.map(it => {
                                      const avail = stockMap.get(it.id) ?? 0;
                                      const mrp   = getPrice(it.id);
                                      const r     = Number((it as any).taxRate ?? 0);
                                      return (
                                        <SelectItem key={it.id} value={String(it.id)}>
                                          {it.name} — {avail} avail
                                          {mrp > 0 ? ` · MRP ₹${mrp}` : ' · MRP not set'}
                                          {r > 0 ? ` · ${r}% GST` : ''}
                                        </SelectItem>
                                      );
                                    })}
                                  </SelectContent>
                                </Select>
                              </FormItem>
                            )} />

                            {/* Row 2: Qty + MRP display (read-only) + Discount + Line total */}
                            <div className="grid grid-cols-12 gap-2 items-end">
                              <div className="col-span-2">
                                <FormField control={form.control} name={`lineItems.${index}.quantity`} render={({ field: f }) => (
                                  <FormItem>
                                    <FormLabel className="text-xs">Qty {itemId > 0 && <span className="text-muted-foreground">(max {availQty})</span>}</FormLabel>
                                    <FormControl><Input type="number" min={1} max={itemId > 0 ? availQty : undefined} className="h-8 text-xs" {...f} /></FormControl>
                                  </FormItem>
                                )} />
                              </div>

                              {/* MRP — read-only, set in Item Master */}
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
                              </div>

                              {/* Line discount — flat ₹ off this line's MRP total */}
                              <div className="col-span-3">
                                <FormField control={form.control} name={`lineItems.${index}.discount`} render={({ field: f }) => (
                                  <FormItem>
                                    <FormLabel className="text-xs">Discount (₹)</FormLabel>
                                    <FormControl>
                                      <Input
                                        type="number" min={0} step="0.01"
                                        max={itemId > 0 ? qty * unitPrice : undefined}
                                        disabled={!itemId || unitPrice <= 0}
                                        placeholder="0"
                                        className="h-8 text-xs"
                                        {...f}
                                        value={(f.value as any) ?? ''}
                                      />
                                    </FormControl>
                                    <FormMessage className="text-[10px]" />
                                  </FormItem>
                                )} />
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
                                <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => remove(index)} disabled={fields.length === 1}><Trash2 className="w-3 h-3" /></Button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>

              {/* ── Tax Summary + Footer ── */}
              <DialogFooter className="flex-col gap-0 sm:flex-col w-full pt-2 border-t border-border">
                {hasItems && (
                  <div className="w-full mb-3 rounded-lg border border-border overflow-hidden text-sm">
                    {/* Header */}
                    <div className="px-3 py-1.5 bg-muted/30 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                      Invoice Summary
                    </div>
                    <div className="px-3 py-2 space-y-1.5">
                      {/* Item discounts — already netted into the figures below */}
                      {totals.itemDiscountTotal > 0 && (
                        <div className="flex justify-between text-emerald-600 font-medium">
                          <span>Item Discounts (off MRP)</span>
                          <span className="font-mono">−₹{totals.itemDiscountTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                        </div>
                      )}
                      {/* Subtotal */}
                      <div className="flex justify-between text-muted-foreground">
                        <span>Taxable Amount</span>
                        <span className="font-mono">₹{totals.subtotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                      </div>

                      {/* GST lines */}
                      {totals.taxTotal > 0 && (
                        <>
                          {isInterState ? (
                            <div className="flex justify-between">
                              <span className="flex items-center gap-1.5 text-amber-500">
                                IGST (inter-state)
                                <span className="text-[10px] text-muted-foreground/60 font-normal">→ Duty &amp; Tax</span>
                              </span>
                              <span className="font-mono text-amber-500">₹{totals.igstTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                            </div>
                          ) : (
                            <>
                              <div className="flex justify-between text-muted-foreground">
                                <span className="flex items-center gap-1.5">
                                  CGST
                                  <span className="text-[10px] text-muted-foreground/60 font-normal">→ Duty &amp; Tax</span>
                                </span>
                                <span className="font-mono">₹{totals.cgstTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                              </div>
                              <div className="flex justify-between text-muted-foreground">
                                <span className="flex items-center gap-1.5">
                                  SGST
                                  <span className="text-[10px] text-muted-foreground/60 font-normal">→ Duty &amp; Tax</span>
                                </span>
                                <span className="font-mono">₹{totals.sgstTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                              </div>
                            </>
                          )}
                          {/* Total tax callout */}
                          <div className="flex justify-between text-xs py-1 px-2 rounded bg-amber-500/8 text-amber-600 border border-amber-500/15">
                            <span className="font-medium">Total Output GST (to Duty &amp; Tax)</span>
                            <span className="font-mono font-semibold">₹{totals.taxTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                          </div>
                        </>
                      )}

                      {totals.taxTotal === 0 && totals.subtotal > 0 && (
                        <p className="text-xs text-muted-foreground/50 italic">No GST applicable on selected items</p>
                      )}

                      <Separator className="my-1" />

                      {/* Coupon discount line */}
                      {totals.discountAmount > 0 && (appliedCoupon || preservedBillDiscount !== null) && (
                        <div className="flex justify-between text-emerald-600 font-medium">
                          <span className="flex items-center gap-1">
                            <Check className="w-3.5 h-3.5" />
                            {watchCouponCode ? <>Coupon <span className="font-mono text-xs ml-1">{watchCouponCode}</span></> : 'Bill Discount'}
                            {appliedCoupon?.discountType === 'percentage' && <span className="text-xs text-muted-foreground ml-1">({appliedCoupon.discountValue}%)</span>}
                            {!appliedCoupon && preservedBillDiscount !== null && preservedBillDiscount > 0 && <span className="text-xs text-muted-foreground ml-1">(original)</span>}
                          </span>
                          <span className="font-mono">−₹{totals.discountAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                        </div>
                      )}

                      <div className="flex justify-between font-bold text-base">
                        <span>{totals.discountAmount > 0 ? 'Amount Payable' : 'Grand Total'}</span>
                        <span className="font-mono text-primary">₹{totals.finalAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                      </div>
                    </div>
                  </div>
                )}
                <div className="flex gap-2 justify-end w-full">
                  <Button variant="outline" type="button" onClick={() => { setIsOpen(false); setEditItem(null); form.reset(effectiveDefaultValues); }}>Cancel</Button>
                  <Button type="submit" disabled={(editItem ? updateMutation.isPending : createMutation.isPending) || !watchLocationId || availableItems.length === 0 || totals.finalAmount === 0}>
                    {editItem
                      ? (updateMutation.isPending ? 'Saving…' : 'Save Changes')
                      : (createMutation.isPending ? 'Processing…' : 'Complete Sale')}
                  </Button>
                </div>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* ── Quick Create Customer Dialog (full form, mirrors Customers page) ── */}
      <Dialog open={showNewCustomer} onOpenChange={v => { setShowNewCustomer(v); if (!v) custForm.reset(); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>Add Customer</DialogTitle></DialogHeader>
          <Form {...custForm}>
            <form onSubmit={custForm.handleSubmit((data: any) => {
              createCustomerMutation.mutate(
                { data: { name: data.name, phone: data.phone || undefined, email: data.email || undefined, gstNumber: data.gstNumber || undefined, state: data.state || undefined, address: data.address || undefined, notes: data.notes || undefined, ...(forceLocationType && forceLocationId ? { locationType: forceLocationType, locationId: forceLocationId } : {}) } as any },
                {
                  onSuccess: (created: any) => {
                    queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
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
              <div className="grid grid-cols-2 gap-4">
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
                    <Select onValueChange={field.onChange} value={field.value || ''}>
                      <FormControl><SelectTrigger><SelectValue placeholder="Select state" /></SelectTrigger></FormControl>
                      <SelectContent>{INDIAN_STATES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
                    </Select>
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

      {/* Invoice View Sheet */}
      <Sheet open={!!viewItem} onOpenChange={v => !v && setViewItem(null)}>
        <SheetContent className="overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <div className="flex items-start justify-between gap-2">
              <div>
                <SheetTitle className="flex items-center gap-2"><Receipt className="w-5 h-5 text-primary" />{viewItem?.invoiceNumber}</SheetTitle>
                <SheetDescription>{viewItem?.outletName} · {viewItem && new Date(viewItem.saleDate).toLocaleDateString('en-IN')}</SheetDescription>
              </div>
              {perm.canEdit && viewItem && (
                <Button variant="outline" size="sm" className="shrink-0 gap-1.5" onClick={() => { setViewItem(null); openEdit(viewItem); }}>
                  <Pencil className="w-3.5 h-3.5" /> Edit
                </Button>
              )}
            </div>
          </SheetHeader>
          {viewItem && (
            <div className="mt-6 space-y-5">
              <div className="grid grid-cols-2 gap-3">
                {[
                  ['Customer', viewItem.customerName || 'Walk-in'],
                  ['Coupon', viewItem.couponCode || '—'],
                ].map(([k, v]) => (
                  <div key={k} className="flex flex-col gap-1">
                    <span className="text-xs text-muted-foreground uppercase tracking-wider">{k}</span>
                    <span className="font-semibold">{v}</span>
                  </div>
                ))}
              </div>

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

              {/* Totals */}
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
                    <span>Bill Discount{viewItem.couponCode ? ` (${viewItem.couponCode})` : ''}</span>
                    <span className="font-mono">−₹{Number(viewItem.discountTotal).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                  </div>
                )}
                <Separator />
                <div className="flex justify-between font-bold text-base">
                  <span>Grand Total</span>
                  <span className="font-mono text-primary">₹{Number(viewItem.totalAmount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                </div>
              </div>

              {/* ── Payment Status ─────────────────────────────────────────── */}
              <div className={`p-3 rounded-lg border text-sm ${
                ((viewItem as any).paymentStatus === 'paid')
                  ? 'bg-emerald-500/5 border-emerald-500/20'
                  : ((viewItem as any).paymentStatus === 'partially_paid')
                  ? 'bg-amber-500/5 border-amber-500/20'
                  : 'bg-red-500/5 border-red-500/20'
              }`}>
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold flex items-center gap-1.5">
                    <Banknote className="w-4 h-4" /> Payment
                  </span>
                  {(() => {
                    const ps = (viewItem as any).paymentStatus ?? 'paid';
                    if (ps === 'paid') return <Badge className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20">Fully Paid</Badge>;
                    if (ps === 'partially_paid') return <Badge className="bg-amber-500/10 text-amber-600 border-amber-500/20">Partially Paid</Badge>;
                    return <Badge className="bg-red-500/10 text-red-600 border-red-500/20">Unpaid</Badge>;
                  })()}
                </div>
                <div className="space-y-1 text-xs text-muted-foreground">
                  <div className="flex justify-between">
                    <span>Total</span>
                    <span className="font-mono font-semibold text-foreground">₹{Number(viewItem.totalAmount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Paid</span>
                    <span className="font-mono text-emerald-600">₹{Number((viewItem as any).amountPaid ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                  </div>
                  {(Number((viewItem as any).balanceDue ?? 0) > 0) && (
                    <div className="flex justify-between font-semibold text-red-600">
                      <span>Balance Due</span>
                      <span className="font-mono">₹{Number((viewItem as any).balanceDue ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                    </div>
                  )}
                </div>

                {/* Payment history */}
                {viewItemPayments.length > 0 && (
                  <div className="mt-3 space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Payment History</p>
                    {viewItemPayments.map((p: any) => (
                      <div key={p.id} className="flex justify-between items-center text-xs bg-background/60 rounded px-2 py-1">
                        <div>
                          <span className="capitalize">{p.method.replace('_', ' ')}</span>
                          {p.referenceNumber && <span className="font-mono ml-1.5 text-muted-foreground text-[10px]">#{p.referenceNumber}</span>}
                          <span className="ml-1.5 text-muted-foreground">{p.paymentDate}</span>
                        </div>
                        <span className="font-mono font-semibold">₹{Number(p.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Collect payment — supports split payments across multiple methods */}
                {(viewItem as any).paymentStatus !== 'paid' && perm.canAdd && (
                  <div className="mt-3">
                    {!showPaymentForm ? (
                      <Button size="sm" className="w-full h-8" onClick={() => {
                        const bal = Number((viewItem as any).balanceDue ?? 0).toFixed(2);
                        setPaymentRows([{ id: Date.now(), method: 'cash', amount: bal, ref: '' }]);
                        setPaymentDate(new Date().toISOString().split('T')[0]);
                        setShowPaymentForm(true);
                      }}>
                        <IndianRupee className="w-3.5 h-3.5 mr-1" /> Collect Payment
                      </Button>
                    ) : (
                      <div className="space-y-2 bg-background/60 rounded-lg p-3">
                        <p className="text-xs font-semibold text-foreground">Collect Payment</p>

                        {/* One card per payment row */}
                        {paymentRows.map((row) => {
                          const balDue = Number((viewItem as any).balanceDue ?? 0);
                          const otherTotal = paymentRows.filter(r => r.id !== row.id).reduce((s, r) => s + (Number(r.amount) || 0), 0);
                          const maxForRow = Math.max(0, balDue - otherTotal);
                          return (
                            <div key={row.id} className="border border-border/60 rounded-lg p-2 bg-muted/10 space-y-1.5">
                              <div className="flex items-center gap-1.5">
                                <div className="flex-1 grid grid-cols-2 gap-1.5">
                                  <div>
                                    <p className="text-[10px] text-muted-foreground mb-1">Method</p>
                                    <Select value={row.method} onValueChange={v => setPaymentRows(rs => rs.map(r => r.id === row.id ? { ...r, method: v } : r))}>
                                      <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="cash">Cash</SelectItem>
                                        <SelectItem value="upi">UPI</SelectItem>
                                        <SelectItem value="card">Card</SelectItem>
                                        <SelectItem value="bank_transfer">Bank Transfer</SelectItem>
                                        <SelectItem value="other">Other</SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>
                                  <div>
                                    <p className="text-[10px] text-muted-foreground mb-1">Amount (₹)</p>
                                    <Input
                                      type="number" min={0.01} step={0.01} max={maxForRow}
                                      value={row.amount}
                                      onChange={e => setPaymentRows(rs => rs.map(r => r.id === row.id ? { ...r, amount: e.target.value } : r))}
                                      className="h-7 text-xs font-mono"
                                    />
                                  </div>
                                </div>
                                {paymentRows.length > 1 && (
                                  <button
                                    onClick={() => setPaymentRows(rs => rs.filter(r => r.id !== row.id))}
                                    className="mt-4 p-1 text-muted-foreground hover:text-destructive rounded"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>
                              {row.method !== 'cash' && (
                                <div>
                                  <p className="text-[10px] text-muted-foreground mb-1">Reference / UTR (optional)</p>
                                  <Input
                                    value={row.ref}
                                    onChange={e => setPaymentRows(rs => rs.map(r => r.id === row.id ? { ...r, ref: e.target.value } : r))}
                                    className="h-7 text-xs font-mono" placeholder="e.g. UPI ref, txn ID"
                                  />
                                </div>
                              )}
                            </div>
                          );
                        })}

                        {/* Add another method — only if balance remains */}
                        {(() => {
                          const bal = Number((viewItem as any).balanceDue ?? 0);
                          const total = paymentRows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
                          const remaining = bal - total;
                          return remaining > 0.001 ? (
                            <button
                              onClick={() => setPaymentRows(rs => [...rs, { id: Date.now(), method: 'upi', amount: remaining.toFixed(2), ref: '' }])}
                              className="flex items-center gap-1 text-xs text-primary hover:underline"
                            >
                              <Plus className="w-3 h-3" /> Add another payment method
                            </button>
                          ) : null;
                        })()}

                        {/* Running totals (shown when there are multiple rows) */}
                        {paymentRows.length > 1 && (() => {
                          const bal = Number((viewItem as any).balanceDue ?? 0);
                          const total = paymentRows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
                          const over = total - bal;
                          return (
                            <div className="text-xs border-t border-border pt-1.5 space-y-0.5">
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Total collecting</span>
                                <span className="font-mono font-semibold">₹{total.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                              </div>
                              {over > 0.001
                                ? <div className="flex justify-between text-red-600"><span>Exceeds balance by</span><span className="font-mono">₹{over.toFixed(2)}</span></div>
                                : total < bal - 0.001
                                ? <div className="flex justify-between text-amber-600"><span>Still due after</span><span className="font-mono">₹{(bal - total).toFixed(2)}</span></div>
                                : <div className="text-emerald-600 text-center text-[10px] font-semibold">Full balance collected ✓</div>
                              }
                            </div>
                          );
                        })()}

                        {/* Date + action buttons */}
                        <div>
                          <p className="text-[10px] text-muted-foreground mb-1">Payment Date</p>
                          <Input type="date" value={paymentDate} onChange={e => setPaymentDate(e.target.value)} className="h-7 text-xs" />
                        </div>
                        {paymentRows.some(r => r.method !== 'cash') && (
                          <div className="text-[10px] text-amber-600 bg-amber-500/5 rounded px-2 py-1">
                            Electronic payments appear in Reconciliation until matched to a bank settlement.
                          </div>
                        )}
                        <div className="flex gap-2">
                          <Button size="sm" className="flex-1 h-7 text-xs" onClick={handleCollectPayment} disabled={createPaymentMutation.isPending}>
                            {createPaymentMutation.isPending ? 'Processing…' : 'Confirm'}
                          </Button>
                          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setShowPaymentForm(false)}>Cancel</Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* ── UPI QR Payment section ──────────────────────────────────── */}
              {(viewItem as any).outletUpiId && paymentMethod === 'upi' && showPaymentForm ? (
                <div className="border border-teal-500/30 rounded-xl bg-teal-500/5 p-4 text-center">
                  <p className="text-xs font-bold text-teal-600 uppercase tracking-widest mb-3">⊡ Scan to Pay (UPI)</p>
                  {viewQrUrl ? (
                    <img src={viewQrUrl} alt="UPI QR Code" className="w-44 h-44 mx-auto rounded-lg border border-border shadow-sm" />
                  ) : (
                    <div className="w-44 h-44 mx-auto rounded-lg border border-border bg-muted/30 flex items-center justify-center">
                      <p className="text-xs text-muted-foreground">Generating QR…</p>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground mt-2 font-mono">{(viewItem as any).outletUpiId}</p>
                  <p className="text-base font-bold mt-0.5">₹{Number((viewItem as any).balanceDue ?? viewItem.totalAmount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</p>
                  <p className="text-xs text-muted-foreground">{viewItem.invoiceNumber}</p>
                </div>
              ) : !(viewItem as any).outletUpiId ? (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-400">
                  <p className="font-semibold">UPI payment QR not available</p>
                  <p className="mt-0.5 opacity-80">No UPI ID configured for <strong>{viewItem.outletName}</strong>. Update the outlet profile to enable QR payments on invoices.</p>
                </div>
              ) : null}

              <div className="flex flex-col gap-2">
                {/* WhatsApp — only when customer has a phone number */}
                {(viewItem as any)?.customerPhone && (
                  <Button
                    className="w-full bg-[#25D366] hover:bg-[#128C7E] text-white border-0"
                    onClick={() => void handleWhatsApp(viewItem)}
                  >
                    <WhatsAppIcon className="w-4 h-4 mr-2" />
                    Share Invoice on WhatsApp
                    <span className="ml-2 text-xs opacity-80 font-normal">{(viewItem as any).customerPhone}</span>
                  </Button>
                )}
                {perm.canDownload && (
                  <div className="grid grid-cols-2 gap-2">
                    <Button variant="outline" onClick={() => void handlePreviewPDF(viewItem)}>
                      <Eye className="w-4 h-4 mr-2" /> Preview PDF
                    </Button>
                    <Button variant="outline" onClick={() => void handleDownloadPDF(viewItem)}>
                      <FileDown className="w-4 h-4 mr-2" /> Download PDF
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* ── Credit-limit override confirmation ─────────────────────────────── */}
      <AlertDialog open={!!creditWarning} onOpenChange={v => { if (!v) setCreditWarning(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-amber-600">
              <AlertTriangle className="w-5 h-5" /> Credit limit exceeded
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm text-muted-foreground">
                <span className="block">
                  Recording this sale on credit would take the customer past their credit limit.
                </span>
                <div className="rounded-lg border border-border bg-muted/20 divide-y divide-border text-foreground">
                  {[
                    ['Credit limit', creditWarning?.info?.creditLimit],
                    ['Current outstanding', creditWarning?.info?.currentOutstanding],
                    ['This sale', creditWarning?.info?.saleAmount],
                    ['Projected outstanding', creditWarning?.info?.projectedOutstanding],
                  ].map(([k, v]) => (
                    <div key={k as string} className="flex justify-between px-3 py-1.5">
                      <span className="text-xs text-muted-foreground">{k}</span>
                      <span className={`font-mono text-xs font-semibold ${k === 'Projected outstanding' ? 'text-red-500' : ''}`}>
                        ₹{Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                      </span>
                    </div>
                  ))}
                </div>
                <span className="block">
                  You can proceed anyway (manager override), or cancel and collect payment first.
                </span>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={createMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-amber-600 text-white hover:bg-amber-700"
              onClick={e => { e.preventDefault(); proceedDespiteCredit(); }}
              disabled={createMutation.isPending}
            >
              {createMutation.isPending ? 'Recording…' : 'Proceed anyway'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
