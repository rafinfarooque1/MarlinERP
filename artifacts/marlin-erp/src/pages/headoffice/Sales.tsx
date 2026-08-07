import { useState, useMemo, useEffect, useRef } from 'react';
import { SearchableItemSelect, type ItemOption } from '@/components/ui/searchable-item-select';
import { entryScopeKeyDown, autoFocusFirst, focusAndOpen, focusField, useEntryShortcuts } from '@/lib/keyboard-entry';
import { Checkbox } from '@/components/ui/checkbox';
import {
  useInfiniteSales, useCreateSale, useListCustomers, useGetMe,
  useListItems, useListItemPrices, useListStock, useGetCompanySettings,
  useListCoupons,
  customFetch,
  useGetSalePayments, useCreateSalePayment, useUpdateSale,
  ensureInvoiceShareLink, absoluteShareUrl,
  usePartyAdvance, getPartyAdvanceQueryKey,
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
import { CustomerFormDialog } from '@/components/customers/CustomerFormDialog';
import { locationValueOf } from '@/lib/usePartyLocations';
import {
  STORED_SALE_MODES, PAYMENT_MODE_OPTIONS, CREATE_PAYMENT_MODE_OPTIONS,
  paymentModeLabel, storedSaleMode,
} from '@/lib/paymentModes';
import { ReceiveIntoSelect, useReceiveIntoOptions, isCashOption } from '@/components/receive-into-select';
import {
  normaliseWhatsAppNumber, composeInvoiceMessage, activeInvoiceShareChannel,
} from '@/lib/invoiceShare';
import {
  Plus, Search, Trash2, CreditCard, Calendar, Receipt,
  Download, Eye, PackageOpen, FileDown, AlertTriangle,
  UserPlus, Check, ChevronsUpDown, Banknote, IndianRupee, Pencil, Printer,
} from 'lucide-react';

// ── WhatsApp brand icon (inline SVG) ──────────────────────────────────────────
import { WhatsAppIcon } from '@/components/ui/WhatsAppIcon';
import { InvoiceShareLinkPanel, NO_PHONE_MESSAGE } from '@/components/sales/InvoiceShareLinkPanel';
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

// ── Types ──────────────────────────────────────────────────────────────────────

interface GstBreakdown {
  taxRate: number;
  taxType: 'cgst_sgst' | 'igst';
  lineGross: number;    // FINAL line total (GST-inclusive), whichever pricing mode
  lineSubtotal: number; // taxable amount (ex-GST)
  cgst: number;
  sgst: number;
  igst: number;
  taxAmount: number;
}

// Two pricing modes per line, mirroring the backend exactly:
//   taxableBase=false (default, historical behaviour): the MRP is the FINAL
//     GST-inclusive price — taxable = gross / (1 + rate/100), tax extracted.
//     (Never gross − rate%; that under-extracts the included GST.)
//   taxableBase=true ("Taxable" checked): the MRP is the taxable BASE —
//     GST is added on top, final = base + tax.
// `discount` is a flat ₹ amount off qty × MRP, applied BEFORE the mode math,
// so it is never applied twice.
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
  // Odd-paise tax: rounding both halves independently would make
  // cgst + sgst ≠ taxAmount (e.g. 0.05 → 0.03 + 0.03). Round one half and
  // give the remainder to the other so the heads always sum exactly.
  const half = Math.round(rawTax / 2 * 100) / 100;
  const rest = Math.round((rawTax - half) * 100) / 100;
  return { taxRate, taxType: 'cgst_sgst', lineGross, lineSubtotal, cgst: half, sgst: rest, igst: 0, taxAmount: rawTax };
}

// Shown whenever a typed sale-line MRP falls below the enforced floor. The
// server rejects the same case with the same message.
const MRP_FLOOR_MESSAGE = 'MRP cannot be lower than the Item Master MRP. Use Discount if you want to reduce the selling price.';

// ── Form Schema ─────────────────────────────────────────────────────────────────

const saleLineSchema = z.object({
  itemId:    z.coerce.number().min(1, 'Item required'),
  quantity:  z.coerce.number().min(1, 'Qty ≥ 1'),
  unitPrice: z.coerce.number().min(0, 'Price required'),
  // Discount per UNIT off the MRP — ₹10 here on qty 10 means ₹100 off the
  // line ((MRP − 10) × 10), never ₹10 off the line total.
  unitDiscount: z.coerce.number().min(0, 'Discount ≥ 0').optional(),
  // "Taxable" checked → MRP is the taxable base, GST added on top.
  // Unchecked (default) → MRP is the final GST-inclusive price.
  taxable:        z.boolean().optional(),
  // Set once the user flips the box by hand — a later customer change must
  // not stomp a deliberate override.
  taxableTouched: z.boolean().optional(),
}).refine(li => (li.unitDiscount ?? 0) <= li.unitPrice, {
  message: 'Cannot exceed the unit price',
  path: ['unitDiscount'],
});
const schema = z.object({
  locationType: z.enum(['outlet', 'warehouse', 'headoffice']).default('outlet'),
  locationId: z.coerce.number().min(1, 'Location required'),
  customerId: z.coerce.number().optional(),
  saleDate: z.string().min(1, 'Date required'),
  paymentMode: z.enum(STORED_SALE_MODES).default('cash'),
  couponCode: z.string().optional(),
  // ONE pre-tax discount on the whole invoice, allocated across lines by the
  // server (proportional to each line's post-item-discount value). Separate
  // from the coupon, which is a post-tax deduction off the grand total.
  billDiscount: z.coerce.number().min(0, 'Discount ≥ 0').optional(),
  lineItems: z.array(saleLineSchema).min(1, 'Add at least one item'),
});
type FormValues = z.infer<typeof schema>;

const defaultFormValues: FormValues = {
  locationType: 'outlet',
  locationId: 0,
  saleDate: new Date().toISOString().split('T')[0],
  paymentMode: 'cash',
  couponCode: '',
  billDiscount: 0,
  lineItems: [{ itemId: 0, quantity: 1, unitPrice: 0, unitDiscount: 0, taxable: false, taxableTouched: false }],
};

// ── Component ──────────────────────────────────────────────────────────────────

interface SalesProps {
  /** Override the permission module checked on this view. Defaults to 'Sales'.
   *  Pass 'Point of Sale' when rendering from the POS context so warehouse
   *  managers with POS permission don't see "Access Denied". */
  permissionModule?: string;
  /** When set, the POS form pre-selects this location and the list is filtered to it. */
  forceLocationType?: 'warehouse' | 'outlet' | 'headoffice';
  forceLocationId?: number;
  forceLocationName?: string;
  /** Additional outlet IDs to include in the list (used in warehouse mode to show child outlets). */
  forceChildOutletIds?: number[];
}

export default function Sales({ forceLocationType, forceLocationId, forceLocationName, permissionModule }: SalesProps = {}) {
  const perm = usePermission(permissionModule ?? 'page:/sales/pos');
  // Head Office as a selling location is offered only to HO/admin users —
  // branch staff sell from their own location (the server enforces this too).
  const { data: me } = useGetMe();
  const isHOUser = !(me as any)?.branchType || (me as any)?.branchType === 'headoffice';
  // Outlet enablement is a Company Settings toggle; go through the shared helper
  // so this page honours it too — an empty list while Outlet Management is off.
  const { data: outlets = [] } = useEnabledOutlets();
  const { outletsEnabled } = useOutletsEnabled();
  // POS entry availability. Settings-driven, UI-availability ONLY: hiding a
  // control never clears the form value behind it, so editing a historical
  // discounted/couponed sale keeps its stored amounts intact and resubmits
  // them unchanged — which the server explicitly allows while the flag is off.
  const { flags: featureFlags, isLoading: flagsLoading } = useFeatureFlags();
  const discountsEnabled = featureFlags.posDiscountsEnabled;
  const couponsEnabled = featureFlags.posCouponsEnabled;
  // Location narrowing comes from the ONE shared header context — this page
  // deliberately has no location picker of its own, so the header selection
  // can never disagree with what the list shows. Locked employees
  // (forceLocationType set) have forced params that take precedence.
  const { locationState } = useLocationContext();
  const locFilterType =
    !forceLocationType &&
    (locationState.locationType === 'warehouse' || locationState.locationType === 'outlet' || locationState.locationType === 'headoffice') &&
    locationState.locationId
      ? locationState.locationType
      : null;
  const locFilterId = locFilterType ? locationState.locationId! : 0;
  // Transaction lists default to 'all' dates so existing users see the same rows
  // until they narrow. Filtering happens server-side (from/to on /sales).
  const range = useDateRange('all');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const PAGE_SIZE = 25;

  // Debounce the search box — invoice/customer search runs server-side
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Infinite (load-more) list, fetched in server-side batches of PAGE_SIZE.
  // Changing any filter (search, dates, location) changes the query key, which
  // resets the accumulation to the first batch automatically. A forced
  // warehouse passes warehouseScope so the server returns the warehouse plus
  // its child outlets (replaces the old client-side forceChildOutletIds
  // filtering).
  const {
    data: salesPages, isLoading, isFetching,
    fetchNextPage, hasNextPage, isFetchingNextPage,
  } = useInfiniteSales({
    limit: PAGE_SIZE,
    q: debouncedSearch || undefined,
    from: range.from || undefined,
    to: range.to || undefined,
    ...(forceLocationType === 'headoffice'
      ? { locationType: 'headoffice' as const }
      : forceLocationType === 'warehouse' && forceLocationId
      ? { warehouseScope: forceLocationId }
      : forceLocationType === 'outlet' && forceLocationId
        ? { locationType: 'outlet' as const, locationId: forceLocationId }
        : locFilterType === 'headoffice'
          ? { locationType: 'headoffice' as const }
          : locFilterType === 'warehouse' && locFilterId
          ? { warehouseScope: locFilterId }
          : locFilterType === 'outlet' && locFilterId
            ? { locationType: 'outlet' as const, locationId: locFilterId }
            : {}),
  });
  const sales = useMemo(
    () => (salesPages?.pages ?? []).flatMap(p => p.rows),
    [salesPages],
  );
  // The freshest page's total — the count shifts under concurrent deletes.
  const totalSales = salesPages?.pages[salesPages.pages.length - 1]?.total ?? 0;

  // Auto-load the next batch while the list's footer is in view — infinite
  // scrolling, with the Load More button kept as an explicit fallback.
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = loadMoreRef.current;
    if (!el || !hasNextPage) return;
    const obs = new IntersectionObserver(
      entries => { if (entries[0]?.isIntersecting && !isFetchingNextPage) void fetchNextPage(); },
      { rootMargin: '300px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
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
  type PRow = { id: number; ledgerId: number; amount: string; ref: string };
  const [paymentRows, setPaymentRows] = useState<PRow[]>([{ id: 1, ledgerId: 0, amount: '', ref: '' }]);
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().split('T')[0]);
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  // Real Cash & Bank accounts of the SALE's location — the destinations the
  // collect form offers. The server re-validates and derives cash/bank/UPI
  // from the picked account, so no method dropdown exists anywhere.
  const { options: receiveOptions } = useReceiveIntoOptions(
    (viewItem as any)?.locationType, (viewItem as any)?.locationId);
  const optionFor = (ledgerId: number) => receiveOptions.find(o => o.id === ledgerId);
  // Derived values used by the UPI QR effect below
  const upiRow = paymentRows.find(r => optionFor(r.ledgerId)?.accountType === 'upi');
  const paymentMethod = upiRow ? 'upi' : 'cash';
  const paymentAmount = upiRow?.amount ?? paymentRows[0]?.amount ?? '';

  // QR shown next to the collect-payment form, for a PART amount (below).
  const [collectQrUrl, setCollectQrUrl] = useState<string | null>(null);

  // The invoice QR renders the request the SERVER built: exactly what this sale
  // still owes — and nothing at all once it is settled or cancelled, or when UPI
  // is switched off in settings. The page does no payment arithmetic of its own,
  // so the amount scanned here cannot drift from the amount the invoice prints.
  useEffect(() => {
    const uri = (viewItem as any)?.upiQrUri as string | null | undefined;
    if (!viewItem || !uri) { setViewQrUrl(null); return; }
    let cancelled = false;
    (import('qrcode') as Promise<any>).then(QR => {
      QR.toDataURL(uri, { width: 200, margin: 2 }).then((url: string) => { if (!cancelled) setViewQrUrl(url); });
    }).catch(() => { if (!cancelled) setViewQrUrl(null); });
    return () => { cancelled = true; };
  }, [viewItem]);

  // A SECOND, deliberately separate QR for the collect-payment form: this one
  // carries the part amount the operator typed, capped at what is owed. Keeping
  // it distinct from the invoice QR above means a part collection can never be
  // mistaken for the bill's outstanding balance.
  useEffect(() => {
    const upiId = (viewItem as any)?.outletUpiId as string | undefined;
    const typed = Number(upiRow?.amount ?? 0);
    const balanceDue = Number((viewItem as any)?.balanceDue ?? 0);
    // Only when a UPI account is actually picked as the destination — a cash
    // or bank collection must never flash a scannable QR at the customer.
    if (!viewItem || !upiId || !upiRow || !showPaymentForm || !(typed > 0) || !(balanceDue > 0)) {
      setCollectQrUrl(null); return;
    }
    const amount = Math.min(typed, balanceDue).toFixed(2);
    const uri = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(viewItem.outletName || '')}&am=${amount}&cu=INR&tn=${encodeURIComponent(viewItem.invoiceNumber || '')}`;
    let cancelled = false;
    (import('qrcode') as Promise<any>).then(QR => {
      QR.toDataURL(uri, { width: 160, margin: 2 }).then((url: string) => { if (!cancelled) setCollectQrUrl(url); });
    }).catch(() => { if (!cancelled) setCollectQrUrl(null); });
    return () => { cancelled = true; };
  }, [viewItem, paymentRows, showPaymentForm, paymentAmount]);
  const queryClient = useQueryClient();

  // Refresh every sales-derived view after a write: sales lists (legacy +
  // paginated), sales summary, dashboard analytics and stock levels.
  const invalidateSalesData = () =>
    queryClient.invalidateQueries({
      predicate: q => {
        const k = String(q.queryKey[0] ?? '');
        return k.startsWith('/api/sales') || k.startsWith('/api/dashboard') || k.startsWith('/api/stock')
          // A sale may have consumed the customer's advance / changed their dues.
          || k.startsWith('/api/accounts/party-advance') || k.startsWith('/api/accounts/settlement-context');
      },
    });

  const createMutation = useCreateSale();
  const updateMutation = useUpdateSale();

  // editItem holds the sale being edited; null means "create" mode
  const [editItem, setEditItem] = useState<any>(null);

  // Convert-from-quotation: set when the Quotations page opened this form
  // prefilled. The id rides on the create payload so the server can stamp
  // both documents inside the sale transaction — exactly one sale per quote.
  const [convertFrom, setConvertFrom] = useState<{
    id: number; quotationNumber: string; couponCode: string; discountTotal: number;
  } | null>(null);

  const openEdit = (sale: any) => {
    setEditItem(sale);
    form.reset({
      locationType: (sale.locationType ?? 'outlet') as 'outlet' | 'warehouse' | 'headoffice',
      locationId: sale.locationId ?? sale.outletId ?? 0,
      customerId: sale.customerId ?? undefined,
      saleDate: sale.saleDate,
      // Carry the stored mode through untouched — legacy 'card'/'bank_transfer'
      // included. They are shown as "Bank", but submitting 'bank' in their place
      // would rewrite a value reconciliation points at, and the API would read
      // it as changing the sale's mode and refuse the edit.
      paymentMode: storedSaleMode(sale.paymentMode) as FormValues['paymentMode'],
      couponCode: sale.couponCode ?? '',
      billDiscount: Number((sale as any).billDiscount ?? 0),
      lineItems: (sale.lineItems ?? []).map((li: any) => ({
        itemId: li.itemId,
        quantity: li.quantity,
        unitPrice: li.unitPrice,
        // New-format lines store the per-unit discount explicitly. Historical
        // lines stored one line-TOTAL amount: convert ÷ qty at FULL precision
        // (never pre-rounded) so unitDiscount × qty rounds back to the exact
        // recorded amount and an untouched save cannot drift by a paisa.
        unitDiscount: li.unitDiscount != null
          ? Number(li.unitDiscount)
          : Number(li.quantity) > 0
            ? Math.max(0, Number(li.discount ?? 0) - Number(li.billDiscountShare ?? 0)) / Number(li.quantity)
            : 0,
        // Load the SAVED pricing mode — never re-derive from the customer's
        // GSTIN here. Historical lines without the field were priced
        // inclusive, so absent → unchecked. touched=true pins it against the
        // customer-default effect.
        taxable: li.priceMode === 'exclusive',
        taxableTouched: true,
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
    if (validRows.some(r => !r.ledgerId)) { toast.error('Pick the Cash / Bank account for each payment'); return; }
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
          data: { receivedInLedgerId: row.ledgerId, amount: Number(row.amount), referenceNumber: row.ref || undefined, paymentDate },
        });
      }
      const label = validRows.length > 1
        ? `${validRows.length} payments totalling ₹${totalPaying.toLocaleString('en-IN')}`
        : `₹${totalPaying.toLocaleString('en-IN')} into ${optionFor(validRows[0].ledgerId)?.name ?? 'the selected account'}`;
      toast.success(`Payment collected — ${label}`);
      // Re-read the sale rather than patching the panel by hand: the server owns
      // the outstanding figure (credit notes included) and the QR built from it,
      // and recomputing either here would be a second, drifting definition.
      try {
        const fresh = await customFetch(`/api/sales/${viewItem.id}`) as any;
        setViewItem((prev: any) => (prev && fresh && prev.id === fresh.id ? { ...prev, ...fresh } : prev));
      } catch {
        // Refresh failed — fall back to closing the stale figures out of view.
        setViewItem((prev: any) => prev ? { ...prev, paymentStatus: lastResult.newPaymentStatus, amountPaid: lastResult.newAmountPaid } : null);
      }
      invalidateSalesData();
      setPaymentRows([{ id: Date.now(), ledgerId: 0, amount: '', ref: '' }]);
      setShowPaymentForm(false);
    } catch (e: any) {
      toast.error(e?.data?.error || e?.message || 'Failed to collect payment');
    }
  };

  // Customer combobox + quick-create state (the form itself is the shared
  // CustomerFormDialog — identical to the Customers module by construction)
  const [customerOpen, setCustomerOpen] = useState(false);
  const [customerSearch, setCustomerSearch] = useState('');
  const [showNewCustomer, setShowNewCustomer] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState('');

  // Fetch warehouses (for combined location picker)
  const { data: warehouses = [] } = useQuery<any[]>({
    queryKey: ['warehouses'],
    queryFn: () => customFetch('/api/warehouses'),
  });

  // When the Sales segment forces a specific location, override the default form values.
  // The opening payment mode is a Company Setting (Default Sales Payment Mode,
  // credit unless changed) — it applies to NEW sales only; openEdit always
  // carries the stored mode through untouched.
  // Branch staff have no location choice at all — their login decides it, the
  // same way the server (`resolveActingLocation`) will resolve it on save. The
  // dropdown is replaced by a read-only label further down, so the defaults
  // must already carry their pinned location.
  const myBranchType = ((me as any)?.branchType ?? 'headoffice') as 'outlet' | 'warehouse' | 'headoffice';
  const myBranchId = Number((me as any)?.branchId) || 0;
  const pinnedLocation = !isHOUser && myBranchId > 0
    ? { locationType: myBranchType, locationId: myBranchId }
    : null;
  const effectiveDefaultValues: FormValues = useMemo(() => ({
    ...defaultFormValues,
    paymentMode: featureFlags.defaultSalesPaymentMode,
    locationType: (forceLocationType ?? pinnedLocation?.locationType ?? defaultFormValues.locationType) as 'outlet' | 'warehouse' | 'headoffice',
    locationId: forceLocationId ?? pinnedLocation?.locationId ?? defaultFormValues.locationId,
  }), [forceLocationType, forceLocationId, featureFlags.defaultSalesPaymentMode, pinnedLocation?.locationType, pinnedLocation?.locationId]);

  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: effectiveDefaultValues });
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
  /** Ctrl+S / Ctrl+Enter → the existing "Complete Sale" submit, guarded by isPending. */
  const kbdSave = () => {
    if (editItem ? updateMutation.isPending : createMutation.isPending) return;
    form.handleSubmit(onSubmit)();
  };
  useEntryShortcuts(isOpen, { onSave: kbdSave, onComplete: kbdSave, onAddLine: kbdAddLine });

  // Cold-load guard: a create form opened (or a quotation converted) before the
  // company settings arrived captured the fallback opening mode. Once the
  // settings resolve, correct the field — but only on a CREATE form the cashier
  // hasn't touched. Edits always keep the sale's stored mode, and a deliberate
  // selection (dirty field) is never overridden.
  useEffect(() => {
    if (flagsLoading || editItem || !isOpen) return;
    if (form.getFieldState('paymentMode').isDirty) return;
    if (form.getValues('paymentMode') !== featureFlags.defaultSalesPaymentMode) {
      form.setValue('paymentMode', featureFlags.defaultSalesPaymentMode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flagsLoading, isOpen, editItem, featureFlags.defaultSalesPaymentMode]);

  // Cold-load guard for the pinned location: a branch user's create form opened
  // before /api/me resolved would still hold the module defaults. Once the
  // session arrives, pin the location — CREATE forms only; edits and quotation
  // conversions keep their document's stored location (still within the user's
  // scope — a warehouse user may edit a child outlet's sale).
  useEffect(() => {
    if (!pinnedLocation || editItem || convertFrom || !isOpen) return;
    if (form.getValues('locationId') !== pinnedLocation.locationId ||
        form.getValues('locationType') !== pinnedLocation.locationType) {
      form.setValue('locationType', pinnedLocation.locationType);
      form.setValue('locationId', pinnedLocation.locationId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinnedLocation?.locationType, pinnedLocation?.locationId, editItem, convertFrom, isOpen]);

  // ── Convert-to-Sale handoff from the Quotations page ─────────────────────
  // The quotation travels via sessionStorage (survives the navigation, never
  // the URL) with a ?fromQuotation marker. Read once on mount, prefill the
  // create form and open it — fully editable, exactly like a hand-typed sale.
  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem('marlin_convert_quotation');
      if (raw) sessionStorage.removeItem('marlin_convert_quotation');
    } catch { /* storage unavailable */ }
    if (!raw) return;
    try {
      const q = JSON.parse(raw);
      if (!q?.id || q.convertedSaleId) return;
      setConvertFrom({
        id: Number(q.id),
        quotationNumber: String(q.quotationNumber ?? `#${q.id}`),
        couponCode: String(q.couponCode ?? '').trim().toUpperCase(),
        discountTotal: Math.max(0, Number(q.discountTotal ?? 0)),
      });
      setEditItem(null);
      form.reset({
        ...effectiveDefaultValues,
        locationType: (q.locationType ?? 'outlet') as 'outlet' | 'warehouse' | 'headoffice',
        locationId: Number(q.locationId ?? 0),
        customerId: q.customerId ?? undefined,
        saleDate: new Date().toISOString().split('T')[0],
        // A converted quotation is a NEW sale — it opens on the company's
        // default payment mode (already in effectiveDefaultValues) like any other.
        couponCode: q.couponCode ?? '',
        billDiscount: Number(q.billDiscount ?? 0),
        lineItems: (Array.isArray(q.lineItems) && q.lineItems.length > 0 ? q.lineItems : []).map((li: any) => ({
          itemId: Number(li.itemId),
          quantity: Number(li.quantity),
          unitPrice: Number(li.unitPrice),
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
    } catch { /* malformed handoff — open nothing */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const watchLocationType = form.watch('locationType');
  const watchLocationId = form.watch('locationId');
  const watchCustomerId = form.watch('customerId');
  const watchPaymentMode = form.watch('paymentMode');

  // Advance adjustment: does the selected customer have money parked with us?
  // Only queried for registered customers; walk-ins have no advance ledger.
  const { data: customerAdvance } = usePartyAdvance('customer', editItem ? null : (watchCustomerId || null));
  const [applyAdvance, setApplyAdvance] = useState(true);
  // Default ON whenever a customer with an advance is picked.
  useEffect(() => { setApplyAdvance(true); }, [watchCustomerId]);

  // A new sale may only be Cash or Credit — Bank/UPI are collected later, never
  // set at sale time (the API rejects them on create). Editing an existing
  // bank/upi sale must not blank its mode, so that stored value stays selectable
  // (but the API refuses to CHANGE any sale into bank/upi). Mirrors the
  // "keep the current pick valid" rule used by lineItemOptions above.
  const paymentModeOptions = useMemo(() => {
    const current = watchPaymentMode;
    if (current && !CREATE_PAYMENT_MODE_OPTIONS.some(o => o.value === current)) {
      const known = PAYMENT_MODE_OPTIONS.find(o => o.value === current);
      // A stored legacy spelling ('card'/'bank_transfer') has no option of its
      // own; give it one under the Bank label so the select can hold the exact
      // stored value instead of silently swapping it for 'bank'.
      const option = known ?? { value: current, label: `🏦 ${paymentModeLabel(current)}` };
      return [...CREATE_PAYMENT_MODE_OPTIONS, option];
    }
    return CREATE_PAYMENT_MODE_OPTIONS;
  }, [watchPaymentMode]);

  const { data: outletPrices = [] } = useListItemPrices(
    { outletId: watchLocationId },
    { query: { enabled: watchLocationType === 'outlet' && !!watchLocationId && watchLocationId > 0 } as any }
  );
  const { data: locationStock = [] } = useListStock(
    { branchType: (watchLocationType ?? 'outlet') as any, branchId: watchLocationId },
    { query: { enabled: !!watchLocationId && watchLocationId > 0 } as any }
  );

  const stockMap = useMemo(
    () => new Map<number, number>(locationStock.map(s => [s.itemId!, Number(s.quantity ?? 0)])),
    [locationStock],
  );
  // Discontinued items can't be billed — the server rejects them on create, so
  // they never reach the picker here either.
  const availableItems = useMemo(
    () => items.filter(it => isActiveProduct(it) && (stockMap.get(it.id) ?? 0) > 0),
    [items, stockMap],
  );

  // Item Master row → picker row. `available` is this LOCATION's sellable stock
  // (the same figure the qty validator uses), never a company-wide total.
  // Nothing cost-bearing is mapped: no cost, avg cost, valuation or margin.
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
  const availableOptions = useMemo(
    () => availableItems.map(toItemOption),
    [availableItems, stockMap],
  );

  // Editing an old bill must never blank a line: whatever that line already
  // points at stays selectable even if the item has since gone inactive or run
  // out of stock. New picks are still limited to availableItems.
  const lineItemOptions = (selectedId: number): ItemOption[] => {
    const id = Number(selectedId);
    if (!id || availableItems.some(it => it.id === id)) return availableOptions;
    const selected = items.find(it => it.id === id);
    return selected ? [...availableOptions, toItemOption(selected)] : availableOptions;
  };

  // Price comes from item MRP (set in Item Master) — not outlet-specific
  const getPrice = (itemId: number) => Number((items.find(i => i.id === itemId) as any)?.mrp ?? 0);
  const getAvailableQty = (itemId: number) => stockMap.get(itemId) ?? 0;

  // ── MRP floor ───────────────────────────────────────────────────────────────
  // A sale line's price may EQUAL or EXCEED the Item Master MRP, never go
  // below it — reductions go through the Discount field so reports keep MRP,
  // selling price and discount separate. On EDIT, a line saved before a later
  // master-MRP increase stays editable at its saved price (but may not be
  // reduced further): floor = min(master MRP, lowest saved price for the item).
  // The server enforces the same rule; this is the immediate-feedback copy.
  const savedPriceByItem = useMemo(() => {
    const m = new Map<number, number>();
    for (const li of ((editItem?.lineItems ?? []) as any[])) {
      const iid = Number(li?.itemId); const p = Number(li?.unitPrice);
      if (!iid || !Number.isFinite(p) || p <= 0) continue;
      const prev = m.get(iid);
      m.set(iid, prev === undefined ? p : Math.min(prev, p));
    }
    return m;
  }, [editItem]);
  const getMrpFloor = (itemId: number) => {
    const master = getPrice(itemId);
    const saved = savedPriceByItem.get(Number(itemId));
    return saved !== undefined ? Math.min(master, saved) : master;
  };

  // Quantities on the sale being EDITED were already taken out of stock when
  // the sale was first saved. The server credits them back before validating an
  // edit, so the true ceiling for an edited line is (available now + what this
  // sale already holds) — not today's shelf count. Without this, a bill of 60
  // with 6 left in stock can't even have its discount changed: the browser
  // blocks submit with "Value must be less than or equal to 6".
  // The credit applies only at the sale's own location — moving the sale to a
  // different location gets no allowance there (mirrors the server).
  const editHeldQty = useMemo(() => {
    const held = new Map<number, number>();
    if (!editItem) return held;
    const sameLocation =
      String(editItem.locationType ?? 'outlet') === String(watchLocationType ?? 'outlet') &&
      Number(editItem.locationId ?? editItem.outletId ?? 0) === Number(watchLocationId ?? 0);
    if (!sameLocation) return held;
    for (const li of editItem.lineItems ?? []) {
      const itemId = Number(li.itemId);
      held.set(itemId, (held.get(itemId) ?? 0) + Number(li.quantity ?? 0));
    }
    return held;
  }, [editItem, watchLocationType, watchLocationId]);
  /** Editable ceiling for a qty input: shelf stock plus this sale's own allocation. */
  const getMaxQty = (itemId: number) => getAvailableQty(itemId) + (editHeldQty.get(itemId) ?? 0);
  const getItem = (itemId: number) => items.find(i => i.id === itemId);

  // GST state determination
  const companyState = ((companySettings as any)?.state ?? '').trim().toLowerCase();
  const selectedCustomer = customers.find(c => c.id === watchCustomerId);
  const customerState = ((selectedCustomer as any)?.state ?? '').trim().toLowerCase();
  const isInterState = !!(companyState && customerState && companyState !== customerState);

  // Default for the per-line "Taxable" box: a GSTIN-registered customer
  // usually bills B2B (price = taxable base, GST on top); walk-in / no-GSTIN
  // customers get MRP-inclusive pricing. Only a DEFAULT — the cashier can
  // flip any line, and a flipped line is never overwritten by a later
  // customer change (taxableTouched). Edit mode rehydrates from the saved
  // sale with every line marked touched, so this effect leaves it alone.
  // The customers LIST endpoint returns snake_case gst_number; single-customer
  // reads return camelCase gstNumber. Check both.
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
    if (editItem) {
      const orig = String((editItem as any).couponCode ?? '').trim().toUpperCase();
      if (orig !== watchCouponCode) return null; // coupon changed → re-derive live
      return Math.max(0, Number((editItem as any).discountTotal ?? 0));
    }
    // Converting a quotation: honour the discount AGREED on the quote while its
    // coupon code is unchanged, even if that coupon has since expired.
    if (convertFrom && convertFrom.couponCode === watchCouponCode && convertFrom.discountTotal > 0) {
      return convertFrom.discountTotal;
    }
    return null;
  }, [editItem, convertFrom, watchCouponCode]);

  // Compute aggregated GST totals for the cart (inclusive GST — MRP already includes tax)
  const computeCartTotals = () => {
    // Pass 1 — per-line ITEM discounts (₹/unit off the MRP) and each line's
    // pre-bill-discount value ("basis").
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

    // Pass 2 — allocate the BILL discount paise-exactly across lines in
    // proportion to their bases (largest remainder), mirroring the server's
    // allocation so the preview and the stored invoice agree to the paisa.
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

    // Pass 3 — GST from each line's post-discount value, per its own rate and
    // inclusive/exclusive treatment. The summary therefore shows the FINAL
    // taxable/GST figures, never pre-discount intermediates.
    // The adjusted amount is rounded to the paisa BEFORE the tax math — the
    // server taxes round2(basis − share), and with fractional quantities
    // (kg goods) an unrounded qty×price−disc base would keep sub-paisa
    // fractions and drift the preview off the persisted invoice.
    let grossTotal = 0, subtotal = 0, cgstTotal = 0, sgstTotal = 0, igstTotal = 0, taxTotal = 0;
    prepared.forEach((p, k) => {
      const adjusted = Math.round((p.basis - shares[k]) * 100) / 100;
      const gst = computeLineGst(1, adjusted, p.taxRate, isInterState, 0, p.taxable);
      grossTotal += gst.lineGross;            // FINAL line total, either mode
      subtotal   += gst.lineSubtotal;
      cgstTotal  += gst.cgst;
      sgstTotal  += gst.sgst;
      igstTotal  += gst.igst;
      taxTotal   += gst.taxAmount;
    });
    const grandTotal = grossTotal;
    // Coupon: post-tax flat deduction off the grand total — unchanged.
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
  // True when at least one item is selected
  const hasItems = fields.some((_, i) => (form.watch(`lineItems.${i}.itemId`) ?? 0) > 0);

  const onSubmit = (data: FormValues) => {
    if (data.paymentMode === 'credit' && !data.customerId) {
      toast.error('Credit sales need a registered customer — pick one or change the payment mode.');
      focusField('customerId', scopeRef.current);
      return;
    }
    // MRP floor — catches an Enter-key submit that skipped the field's blur
    // reset. The server enforces the same rule authoritatively.
    for (let i = 0; i < data.lineItems.length; i++) {
      const li = data.lineItems[i];
      const floor = getMrpFloor(li.itemId);
      if (floor > 0 && Number(li.unitPrice) < floor) {
        toast.error(MRP_FLOOR_MESSAGE);
        focusField(`line-mrp-${i}`, scopeRef.current);
        return;
      }
    }
    const enrichedItems = data.lineItems.map(li => ({
      itemId: li.itemId,
      quantity: li.quantity,
      unitPrice: Number(li.unitPrice),
      // Per-unit discount — the server derives the line total (× qty) and the
      // bill-discount share; never send a pre-multiplied line amount here.
      unitDiscount: Math.max(0, Number(li.unitDiscount ?? 0)),
      priceMode: (li.taxable ? 'exclusive' : 'inclusive') as 'exclusive' | 'inclusive',
      taxAmount: 0, // backend recomputes authoritatively
    }));
    // Synchronous re-entrancy lock: two rapid Ctrl+S / Enter submits can both
    // pass an isPending check before React Query publishes the pending state.
    // The ref flips immediately, so only the first ever reaches mutate().
    // Placed AFTER the validation early-returns so a failed validation never
    // leaves the lock stuck. Released in onSettled (success or error).
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    const { discountAmount, billDiscount } = computeCartTotals();
    const payload = {
      ...data,
      locationType: data.locationType,
      locationId: data.locationId,
      // backward compat: send outletId for outlet sales
      outletId: data.locationType === 'outlet' ? data.locationId : (outlets[0]?.id ?? 1),
      lineItems: enrichedItems,
      customerId: data.customerId || undefined,
      discountTotal: discountAmount,
      // Conversion marker — the server locks the quotation, refuses a second
      // conversion, and stamps the invoice number back onto the quotation.
      ...(convertFrom && !editItem ? { quotationId: convertFrom.id } : {}),
      // Advance adjustment — opt-in; the server caps at what the books hold.
      ...(!editItem && applyAdvance && (customerAdvance?.available ?? 0) > 0.004
        ? { useAdvance: true } : {}),
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
        onSettled: () => { submitLockRef.current = false; },
      });
    } else {
      // Create mode — POST new sale
      createMutation.mutate({ data: payload }, {
        onSuccess: (created: any) => {
          toast.success(convertFrom
            ? `Quotation ${convertFrom.quotationNumber} converted — invoice ${created?.invoiceNumber ?? ''} recorded`
            : 'Sale recorded successfully');
          invalidateSalesData();
          if (convertFrom) {
            queryClient.invalidateQueries({
              predicate: q => String(q.queryKey[0] ?? '').startsWith('/api/quotations'),
            });
            setConvertFrom(null);
          }
          setIsOpen(false);
          form.reset(effectiveDefaultValues);
        },
        onError: (e: any) => {
          if (e?.status === 409 && e?.data?.code === 'QUOTATION_ALREADY_CONVERTED') {
            toast.error(
              `${convertFrom?.quotationNumber ?? 'This quotation'} was already converted to ${e?.data?.convertedInvoiceNumber ?? 'a sale'} — a quotation can only become one invoice.`,
              { duration: 8000 },
            );
            queryClient.invalidateQueries({
              predicate: q => String(q.queryKey[0] ?? '').startsWith('/api/quotations'),
            });
            setConvertFrom(null);
            setIsOpen(false);
            form.reset(effectiveDefaultValues);
            return;
          }
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
        onSettled: () => { submitLockRef.current = false; },
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
  //
  // The intent travels with the request because the token is the document: the
  // server grants a download link to a role with Download, a print link to a
  // role with Print, and refuses the rest. Sending the wrong intent would ask
  // for the wrong right, so each caller names what its button actually does.
  const requestInvoicePdfUrl = async (
    saleId: number,
    intent: 'download' | 'print' | 'preview',
  ): Promise<string> => {
    const { token } = await customFetch<{ token: string; expiresAt: string }>(
      `/api/sales/${saleId}/share-token`,
      { method: 'POST', body: JSON.stringify({ intent }), headers: { 'Content-Type': 'application/json' } },
    );
    return `${window.location.origin}/api/public/invoices/${token}.pdf${intent === 'download' ? '?download=1' : ''}`;
  };

  // The View sheet shows the invoice details directly — no embedded PDF
  // preview. The document itself is one click away via the PDF / Print
  // actions, which render the exact same server-side PDF; dropping the inline
  // iframe also saves a full PDF render on every open of the sheet.

  // Download: navigate to the attachment URL — the browser saves exactly one
  // file (Content-Disposition: attachment) and the page stays where it is.
  const handleDownloadPDF = async (sale: any) => {
    try {
      window.location.assign(await requestInvoicePdfUrl(sale.id, 'download'));
    } catch {
      toast.error('Unable to prepare the invoice PDF. Please try again.');
    }
  };

  // Preview: open the tab synchronously (inside the click gesture) so popup
  // blockers allow it, then point it at the inline PDF once the URL is ready.
  const handlePreviewPDF = async (sale: any) => {
    const tab = window.open('', '_blank');
    try {
      const url = await requestInvoicePdfUrl(sale.id, 'preview');
      if (tab) tab.location.replace(url);
      else window.open(url, '_blank');
    } catch {
      tab?.close();
      toast.error('Unable to open the invoice PDF. Please try again.');
    }
  };

  // Print: same PDF, opened in a tab that asks to print itself. The tab is
  // opened synchronously (click gesture) and then navigated, like Preview.
  const handlePrintPDF = async (sale: any) => {
    const tab = window.open('', '_blank');
    try {
      const url = await requestInvoicePdfUrl(sale.id, 'print');
      if (!tab) { window.open(url, '_blank'); return; }
      tab.location.replace(url);
      // Same-origin PDF, so the print dialog can be triggered once it loads.
      // If the viewer blocks it the invoice is still on screen to print by hand.
      tab.addEventListener?.('load', () => { try { tab.print(); } catch { /* viewer declined */ } });
    } catch {
      tab?.close();
      toast.error('Unable to open the invoice for printing. Please try again.');
    }
  };

  // ── WhatsApp invoice share ─────────────────────────────────────────────────
  // Hands the customer's chat a short message holding a secure HTTPS link to
  // the invoice PDF — they tap the link to view/download it. The message text
  // and the delivery channel both live in lib/invoiceShare.ts, so a WhatsApp
  // Business API path (which would attach the PDF instead of linking it) plugs
  // in there without touching this page or the invoice renderer.
  //
  // Popup-safety: the tab is opened synchronously inside the click gesture and
  // redirected once the link is ready. (The previous setTimeout-based
  // window.open lost the user gesture → popup blocked → "nothing happened".)
  const handleWhatsApp = async (sale: any) => {
    const phone = normaliseWhatsAppNumber(sale.customerPhone);
    if (!phone) {
      toast.error(NO_PHONE_MESSAGE);
      return;
    }

    const waTab = window.open('', '_blank'); // sync open — popup-blocker safe

    try {
      // The customer gets a managed share link, not a signed one-off URL: it can be
      // revoked later, and it reveals nothing about the sale. Reuses the invoice's
      // active link so re-sending does not silently invalidate the first message.
      const { link } = await ensureInvoiceShareLink(sale.id, 'whatsapp');
      if (!link.path) throw new Error('share link is not active');
      const pdfUrl = absoluteShareUrl(link.path);
      const cs = companySettings as any;
      const message = composeInvoiceMessage({
        sale,
        pdfUrl,
        companyName: cs?.companyName ?? cs?.name ?? 'Marlin Frozen Fruits',
        resolveItemName: id => itemsMap.get(id)?.name,
        linkValidDays: link.validForDays,
      });

      const target = await activeInvoiceShareChannel().deliver({
        phone, message, pdfUrl, saleId: sale.id,
      });
      if (!target) { waTab?.close(); toast.success('Invoice sent on WhatsApp'); return; }
      if (waTab) waTab.location.replace(target);
      else window.open(target, '_blank');   // fallback if the tab was blocked
    } catch {
      waTab?.close();
      toast.error('Unable to prepare the WhatsApp share. Please try again.');
    }
  };

  // Search runs server-side; the status pills filter the loaded rows locally
  // (scrolling keeps loading further batches, so a narrow filter simply fills
  // in as more arrive).
  // Merge the computed discount total into each row so sorting can key on it.
  const filtered = useMemo(
    () => sales
      .filter(s => statusFilter === 'all' || ((s as any).paymentStatus ?? 'paid') === statusFilter)
      .map(s => ({
        ...s,
        _discountTotal: Number((s as any).discountTotal ?? 0)
          + (((s as any).lineItems as any[]) ?? []).reduce((acc: number, li: any) => acc + Number(li?.discount ?? 0), 0),
      })),
    [sales, statusFilter],
  );

  const { sorted, sort } = useTableSort(filtered, {
    invoice: s => s.invoiceNumber,
    date: s => (s as any).saleDate,
    location: s => s.outletName,
    customer: s => s.customerName || 'Walk-in',
    status: s => (s as any).paymentStatus ?? 'paid',
    tax: s => Number((s as any).taxTotal) || null,
    discount: s => (s as any)._discountTotal || null,
    total: s => Number((s as any).totalAmount) || null,
  });

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
                Customer: s.customerName || 'Walk-in', Payment: paymentModeLabel(s.paymentMode),
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
            <div className="flex items-center gap-2 w-64 max-md:w-full">
              <Search className="w-4 h-4 text-muted-foreground" />
              <Input placeholder="Search invoice or customer..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0" />
            </div>
            {/* Location narrowing lives in the header's global selector — no
                page-local picker, so the two can never disagree. */}
            <RangeBar range={range} />
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
          <Table className="hidden md:table">
            <TableHeader>
              <TableRow className="bg-muted/10">
                <SortableHead k="invoice" sort={sort}>Invoice</SortableHead>
                <SortableHead k="date" sort={sort}>Date</SortableHead>
                <SortableHead k="location" sort={sort}>Location</SortableHead>
                <SortableHead k="customer" sort={sort}>Customer</SortableHead>
                <SortableHead k="status" sort={sort}>Status</SortableHead>
                <SortableHead k="tax" sort={sort} className="text-right">Tax</SortableHead>
                <SortableHead k="discount" sort={sort} className="text-right">Discount</SortableHead>
                <SortableHead k="total" sort={sort} className="text-right">Total</SortableHead>
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
              ) : sorted.map(sale => (
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
                      if (ps === 'cancelled') return <Badge variant="outline" className="text-[10px] text-muted-foreground">Cancelled</Badge>;
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
                    {Number((sale as any).balanceDue ?? 0) > 0.004 && (
                      <p className="text-[10px] text-red-500 font-mono">Due: ₹{Number((sale as any).balanceDue ?? 0).toLocaleString('en-IN')}</p>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(sale)} title="View"><Eye className="w-4 h-4" /></Button>
                      {perm.canEdit && <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-amber-500" onClick={() => openEdit(sale)} title="Edit sale"><Pencil className="w-4 h-4" /></Button>}
                      {perm.canDownload && <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-emerald-600" onClick={() => void handleDownloadPDF(sale)} title="Download PDF"><FileDown className="w-4 h-4" /></Button>}
                      {perm.canDownload && (
                        <Button
                          variant="ghost" size="icon"
                          className="h-8 w-8 text-[#25D366] hover:text-[#128C7E] hover:bg-[#25D366]/10"
                          disabled={!(sale as any).customerPhone}
                          onClick={() => void handleWhatsApp(sale)}
                          title={(sale as any).customerPhone
                            ? `Send invoice to ${(sale as any).customerPhone} via WhatsApp`
                            : NO_PHONE_MESSAGE}
                        >
                          <WhatsAppIcon className="w-4 h-4" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {/* Mobile card list — mirrors the desktop table above */}
          <div className="md:hidden">
            {isLoading ? (
              <div className="space-y-2 p-3">
                {[...Array(4)].map((_, i) => <div key={i} className="h-24 bg-muted/30 rounded-lg animate-pulse" />)}
              </div>
            ) : filtered.length === 0 ? (
              <div className="text-center py-16 text-muted-foreground">
                <Receipt className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No sales recorded yet</p>
              </div>
            ) : (
              <div className="space-y-2 p-3">
                {sorted.map(sale => {
                  const ps = (sale as any).paymentStatus ?? 'paid';
                  const statusBadge = ps === 'cancelled'
                    ? <Badge variant="outline" className="text-[10px] text-muted-foreground">Cancelled</Badge>
                    : ps === 'paid'
                      ? <Badge className="text-[10px] bg-emerald-500/10 text-emerald-600 border-emerald-500/20">Paid</Badge>
                      : ps === 'partially_paid'
                        ? <Badge className="text-[10px] bg-amber-500/10 text-amber-600 border-amber-500/20">Partial</Badge>
                        : <Badge className="text-[10px] bg-red-500/10 text-red-600 border-red-500/20">Unpaid</Badge>;
                  const balanceDue = Number((sale as any).balanceDue ?? 0);
                  return (
                    <div key={sale.id} className="border border-border rounded-lg p-3 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-mono text-primary font-bold text-sm">{sale.invoiceNumber}</p>
                          <p className="text-xs text-muted-foreground flex items-center gap-1">
                            <Calendar className="w-3 h-3" />{new Date(sale.saleDate).toLocaleDateString('en-IN')}
                          </p>
                        </div>
                        {statusBadge}
                      </div>
                      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                        <p className="text-muted-foreground">Location: <span className="text-foreground">{sale.outletName}</span></p>
                        <p className="text-muted-foreground">Customer: <span className="text-foreground">{sale.customerName || 'Walk-in'}</span></p>
                      </div>
                      <div className="flex items-end justify-between gap-2 pt-1">
                        <div>
                          <p className="font-mono font-bold text-emerald-500 text-sm">₹{Number(sale.totalAmount).toLocaleString('en-IN')}</p>
                          {balanceDue > 0.004 && (
                            <p className="text-[10px] text-red-500 font-mono">Due: ₹{balanceDue.toLocaleString('en-IN')}</p>
                          )}
                        </div>
                        <div className="flex gap-1">
                          <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(sale)} title="View"><Eye className="w-4 h-4" /></Button>
                          {perm.canEdit && <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-amber-500" onClick={() => openEdit(sale)} title="Edit sale"><Pencil className="w-4 h-4" /></Button>}
                          {perm.canDownload && <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-emerald-600" onClick={() => void handleDownloadPDF(sale)} title="Download PDF"><FileDown className="w-4 h-4" /></Button>}
                          {perm.canDownload && (
                            <Button
                              variant="ghost" size="icon"
                              className="h-8 w-8 text-[#25D366] hover:text-[#128C7E] hover:bg-[#25D366]/10"
                              disabled={!(sale as any).customerPhone}
                              onClick={() => void handleWhatsApp(sale)}
                              title={(sale as any).customerPhone
                                ? `Send invoice to ${(sale as any).customerPhone} via WhatsApp`
                                : NO_PHONE_MESSAGE}
                            >
                              <WhatsAppIcon className="w-4 h-4" />
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {totalSales > 0 && (
            <div ref={loadMoreRef} className="p-3 border-t border-border flex flex-wrap items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground">
                Showing {Math.min(sales.length, totalSales)} of {totalSales} sales
                {isFetching && !isFetchingNextPage ? ' · refreshing…' : ''}
              </span>
              <div className="flex items-center gap-3">
                <span className="font-bold text-emerald-500">
                  Loaded total: ₹{filtered.reduce((s, r) => s + Number(r.totalAmount || 0), 0).toLocaleString('en-IN')}
                </span>
                {hasNextPage && (
                  <Button variant="outline" size="sm" className="h-7 px-3 text-xs" disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>
                    {isFetchingNextPage ? 'Loading…' : 'Load More'}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Sale Dialog */}
      <Dialog open={isOpen} onOpenChange={v => { setIsOpen(v); if (!v) { setEditItem(null); setConvertFrom(null); form.reset(effectiveDefaultValues); } }}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto" onOpenAutoFocus={autoFocusFirst}>
          <DialogHeader><DialogTitle>{editItem
            ? `Edit Sale — ${editItem.invoiceNumber}`
            : convertFrom
              ? `Convert ${convertFrom.quotationNumber} to Sale`
              : 'Record Sale'}</DialogTitle></DialogHeader>
          {convertFrom && !editItem && (
            <div className="rounded-lg border border-violet-500/30 bg-violet-500/5 px-3 py-2 text-sm text-violet-600">
              Prefilled from quotation <span className="font-mono font-semibold">{convertFrom.quotationNumber}</span> — everything
              is editable. Stock is deducted and books are posted only when this sale is saved.
            </div>
          )}
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
                    {/* Branch staff never choose — their login decides the
                        location (server enforces the same rule), so the
                        dropdown is replaced by a read-only fact and other
                        locations are never listed. */}
                    {!isHOUser ? (
                      <div className="h-9 flex items-center px-3 rounded-md border border-border bg-muted/30 text-sm font-medium">
                        {(() => {
                          const lt = form.watch('locationType');
                          const hit = lt === 'warehouse'
                            ? (warehouses as any[]).find((w: any) => Number(w.id) === Number(field.value))
                            : outlets.find(o => Number(o.id) === Number(field.value));
                          return hit?.name || (me as any)?.branchName || forceLocationName || '—';
                        })()}
                      </div>
                    ) : (
                    <Select
                      onValueChange={v => {
                        const [type, idStr] = v.split(':');
                        field.onChange(Number(idStr));
                        form.setValue('locationType', type as 'outlet' | 'warehouse' | 'headoffice');
                        form.setValue('lineItems', [{ itemId: 0, quantity: 1, unitPrice: 0, unitDiscount: 0, taxable: customerHasGstin, taxableTouched: false }]);
                      }}
                      value={field.value && field.value > 0 ? `${form.watch('locationType')}:${field.value}` : ''}
                    >
                      <FormControl><SelectTrigger><SelectValue placeholder={outletsEnabled ? 'Select outlet or warehouse' : 'Select warehouse'} /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="headoffice:1">🏢 Head Office</SelectItem>
                        {(warehouses as any[]).length > 0 && (
                          <SelectGroup>
                            <SelectLabel>Warehouses</SelectLabel>
                            {(warehouses as any[]).map((w: any) => (
                              <SelectItem key={w.id} value={`warehouse:${w.id}`}>🏭 {w.name}</SelectItem>
                            ))}
                          </SelectGroup>
                        )}
                        {/* No new bill can be raised at a retired outlet; past
                            outlet bills stay listed and editable-in-place. */}
                        {outletsEnabled && outlets.length > 0 && (
                          <SelectGroup>
                            <SelectLabel>Outlets</SelectLabel>
                            {outlets.map(o => (
                              <SelectItem key={o.id} value={`outlet:${o.id}`}>🏪 {o.name}</SelectItem>
                            ))}
                          </SelectGroup>
                        )}
                      </SelectContent>
                    </Select>
                    )}<FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="saleDate" render={({ field }) => (
                  <FormItem><FormLabel>Date <span className="text-destructive">*</span></FormLabel><FormControl><Input type="date" {...field} {...(forceLocationId ? { 'data-kbd-first': '1' } : {})} /></FormControl><FormMessage /></FormItem>
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
                          onClick={() => { setNewCustomerName(''); setShowNewCustomer(true); }}>
                          <UserPlus className="w-3 h-3" /> New
                        </Button>
                      </div>
                      <Popover open={customerOpen} onOpenChange={v => { setCustomerOpen(v); if (!v) setCustomerSearch(''); }}>
                        <PopoverTrigger asChild>
                          <Button type="button" variant="outline" role="combobox" data-field="customerId"
                            className={cn('w-full justify-between font-normal h-10 px-3', !selected && 'text-muted-foreground')}>
                            <span className="truncate">{selected ? `${selected.name}${(selected as any).state ? ` (${(selected as any).state})` : ''}` : 'Walk-in Customer'}</span>
                            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent align="start" className="p-0" style={{ width: 'var(--radix-popover-trigger-width)', minWidth: '240px' }} data-kbd-ignore>
                          <Command shouldFilter={false}>
                            <CommandInput placeholder="Search customer…" value={customerSearch} onValueChange={setCustomerSearch} />
                            <CommandEmpty>No customers found. <button type="button" className="text-primary underline ml-1" onClick={() => { setCustomerOpen(false); setNewCustomerName(customerSearch); setCustomerSearch(''); setShowNewCustomer(true); }}>Create "{customerSearch}"?</button></CommandEmpty>
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
                        {paymentModeOptions.map(m => (
                          <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {field.value === 'credit' && !watchCustomerId && (
                      <p className="text-xs text-amber-500 mt-1">Credit sales need a registered customer</p>
                    )}
                    <FormMessage />
                  </FormItem>
                )} />
              </div>

              {/* Advance adjustment — a customer with money parked beyond their
                  bills can have it auto-applied to this invoice. Create only:
                  edits never touch the advance. */}
              {!editItem && (customerAdvance?.available ?? 0) > 0.004 && (
                <label className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm cursor-pointer">
                  <Checkbox checked={applyAdvance} onCheckedChange={v => setApplyAdvance(v === true)} />
                  <span>
                    Apply available advance of <span className="font-mono font-semibold">₹{Number(customerAdvance!.available).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span> to this sale
                  </span>
                </label>
              )}

              {/* Coupon code — hidden while coupons are off in Settings; a
                  historical code on an edited sale stays visible read-only */}
              {!couponsEnabled && watchCouponCode ? (
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-medium">Coupon Code</span>
                  <span className="font-mono uppercase tracking-wider text-sm text-muted-foreground">
                    {watchCouponCode} <span className="normal-case font-sans">(applied when this sale was created — coupon entry is turned off in Settings)</span>
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

              {/* Line items */}
              <div>
                {!watchLocationId || watchLocationId === 0 ? (
                  <div className="p-6 border border-dashed border-border rounded-lg text-center text-muted-foreground">Select a selling location above to load available stock</div>
                ) : availableItems.length === 0 && !editItem ? (
                  /* Create mode only: an EDITED sale must stay saveable (discount,
                     customer, qty reductions) even when the shelf is empty — its
                     own lines carry the allowance. */
                  <div className="p-6 border border-dashed border-amber-500/40 rounded-lg text-center text-amber-500 bg-amber-500/5 flex flex-col items-center gap-2">
                    <PackageOpen className="w-8 h-8 opacity-60" />
                    <p className="font-medium">No stock available at this outlet</p>
                    <p className="text-xs text-muted-foreground">Transfer stock to this outlet before recording a sale</p>
                  </div>
                ) : (
                  <>
                    <div className="flex justify-between items-center mb-3">
                      <p className="font-semibold">Cart Items <span className="text-xs text-muted-foreground font-normal ml-1">({availableItems.length} in stock)</span></p>
                    </div>
                    <div className="overflow-x-auto"><div className="min-w-[720px] space-y-2">
                      {fields.map((field, index) => {
                        const itemId   = form.watch(`lineItems.${index}.itemId`);
                        const qty      = form.watch(`lineItems.${index}.quantity`);
                        const unitPrice = Number(form.watch(`lineItems.${index}.unitPrice`) ?? 0);
                        // The per-item ceiling is shared across every line that
                        // holds the same item: what other lines have already
                        // claimed is not available to this one. Without the
                        // subtraction, two lines of one item each advertise the
                        // full ceiling and only the server catches the sum.
                        const allLines = form.watch('lineItems') ?? [];
                        const claimedElsewhere = allLines.reduce((s: number, l: any, i2: number) =>
                          i2 !== index && Number(l?.itemId) === Number(itemId) ? s + Math.max(0, Number(l?.quantity) || 0) : s, 0);
                        const maxQty   = Math.max(0, getMaxQty(itemId) - claimedElsewhere);
                        const taxRate  = Number((getItem(itemId) as any)?.taxRate ?? 0);
                        // Item discount is PER UNIT: ₹10 off MRP ₹100 × qty 10
                        // = ₹100 off the line, not ₹10. The line figures here
                        // are pre-bill-discount; the summary below carries the
                        // final post-allocation taxable/GST.
                        const unitDisc = Math.min(Math.max(0, Number(form.watch(`lineItems.${index}.unitDiscount`) ?? 0)), unitPrice);
                        const disc     = Math.round(unitDisc * qty * 100) / 100;
                        const taxable  = !!form.watch(`lineItems.${index}.taxable`);
                        // Same paise-rounded base the server taxes (fractional
                        // qty would otherwise keep sub-paisa fractions).
                        const gst      = computeLineGst(1, Math.max(0, Math.round((qty * unitPrice - disc) * 100) / 100), taxRate, isInterState, 0, taxable);
                        const lineTotal = gst.lineGross; // final line total (GST-inclusive, either mode)

                        return (
                          <div key={field.id} data-kbd-row={index} className="p-3 bg-muted/20 rounded-lg border border-border space-y-2">
                            {/* Row 1: Item selector */}
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
                                    // Auto-fill from Item Master MRP — read-only in sale
                                    form.setValue(`lineItems.${index}.unitPrice`, getPrice(id));
                                  }}
                                /></FormControl>
                              </FormItem>
                            )} />

                            {/* Row 2: Qty + MRP display (read-only) + Discount + Line total */}
                            <div className="grid grid-cols-12 gap-2 items-end">
                              <div className="col-span-2">
                                <FormField control={form.control} name={`lineItems.${index}.quantity`} render={({ field: f }) => (
                                  <FormItem>
                                    <FormLabel className="text-xs">Qty {itemId > 0 && <span className="text-muted-foreground">(max {maxQty})</span>}</FormLabel>
                                    <FormControl><Input type="number" min={1} max={itemId > 0 ? maxQty : undefined} className="h-8 text-xs" {...f} /></FormControl>
                                  </FormItem>
                                )} />
                              </div>

                              {/* MRP — editable UPWARD only. Floor = Item Master
                                  MRP (or, on an old invoice, the line's saved
                                  price if the master rose since). Anything below
                                  is rejected and snapped back; reductions go
                                  through Discount. */}
                              <div className="col-span-3">
                                <FormField control={form.control} name={`lineItems.${index}.unitPrice`} render={({ field: f }) => {
                                  const floor = getMrpFloor(itemId);
                                  return (
                                    <FormItem>
                                      <FormLabel className="text-xs">
                                        MRP (₹) {floor > 0 && <span className="text-[10px] text-muted-foreground font-normal">min ₹{floor.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>}
                                      </FormLabel>
                                      <FormControl>
                                        <Input
                                          type="number"
                                          step="0.01"
                                          min={floor > 0 ? floor : 0}
                                          className="h-8 text-xs font-mono"
                                          data-testid={`input-line-mrp-${index}`}
                                          data-field={`line-mrp-${index}`}
                                          data-last-field={!discountsEnabled && index === fields.length - 1 ? '1' : undefined}
                                          {...f}
                                          onBlur={e => {
                                            f.onBlur();
                                            const v = Number(e.target.value);
                                            if (floor > 0 && (!Number.isFinite(v) || v < floor)) {
                                              toast.error(MRP_FLOOR_MESSAGE);
                                              form.setValue(`lineItems.${index}.unitPrice`, floor);
                                            }
                                          }}
                                        />
                                      </FormControl>
                                    </FormItem>
                                  );
                                }} />
                                {itemId > 0 && getPrice(itemId) <= 0 && (
                                  <p className="mt-1 text-[10px] text-amber-500">Set MRP in Item Master</p>
                                )}
                                {/* Taxable: checked → price is the taxable base, GST added on top;
                                    unchecked → price is final, GST extracted from it. */}
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

                              {/* Item discount — ₹ off EVERY unit's MRP.
                                  Entry hidden while discounts are off; an
                                  existing amount on an edited historical sale
                                  stays visible read-only and is resubmitted
                                  unchanged. */}
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
                    <Button type="button" variant="outline" size="sm" className="mt-3 w-full border-dashed" onClick={() => append({ itemId: 0, quantity: 1, unitPrice: 0, unitDiscount: 0, taxable: customerHasGstin, taxableTouched: false })}>
                      <Plus className="w-3 h-3 mr-1" /> Add Item
                    </Button>
                  </>
                )}
              </div>

              {/* ── Tax Summary + Footer ── */}
              <DialogFooter className="flex-col gap-0 sm:flex-col w-full pt-2 border-t border-border max-md:sticky max-md:bottom-0 max-md:z-20 max-md:-mx-4 max-md:-mb-4 max-md:px-4 max-md:pb-4 max-md:bg-background/95 max-md:backdrop-blur">
                {hasItems && (
                  <div className="w-full mb-3 rounded-lg border border-border overflow-hidden text-sm">
                    {/* Header */}
                    <div className="px-3 py-1.5 bg-muted/30 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                      Invoice Summary
                    </div>
                    <div className="px-3 py-2 space-y-1.5">
                      {/* Gross → item discounts → bill discount → taxable.
                          Both discounts are PRE-tax and already netted into the
                          taxable/GST figures below — shown here so the cashier
                          can follow the arithmetic, never deducted twice. */}
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
                      {/* Bill discount — ONE pre-tax amount on the whole invoice,
                          split across lines in proportion to their value.
                          Entry hidden while discounts are off; an existing
                          amount on an edited historical sale shows read-only. */}
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
                            {watchCouponCode ? <>Coupon <span className="font-mono text-xs ml-1">{watchCouponCode}</span></> : 'Flat Discount (post-tax)'}
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
                  <Button type="submit" disabled={(editItem ? updateMutation.isPending : createMutation.isPending) || !watchLocationId || (!editItem && availableItems.length === 0) || totals.finalAmount === 0}>
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

      {/* ── Quick Create Customer — THE shared form (identical to Customers page) ── */}
      <CustomerFormDialog
        open={showNewCustomer}
        onOpenChange={setShowNewCustomer}
        prefillName={newCustomerName}
        defaultLocationValue={forceLocationType ? locationValueOf(forceLocationType, forceLocationId) : undefined}
        onSaved={created => {
          // Select the new customer and keep the sale entry flowing — the
          // shared dialog already closed itself and refreshed customer lists.
          if (created?.id) form.setValue('customerId', created.id);
        }}
      />

      {/* Invoice View Sheet */}
      <Sheet open={!!viewItem} onOpenChange={v => !v && setViewItem(null)}>
        <SheetContent className="overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <div className="flex items-start justify-between gap-2">
              <div>
                <SheetTitle className="flex items-center gap-2"><Receipt className="w-5 h-5 text-primary" />{viewItem?.invoiceNumber}</SheetTitle>
                <SheetDescription>{viewItem?.outletName} · {viewItem && new Date(viewItem.saleDate).toLocaleDateString('en-IN')}</SheetDescription>
                {viewItem?.quotationNumber && (
                  <p className="text-xs text-violet-600 font-medium mt-1">
                    Converted From: <span className="font-mono">{viewItem.quotationNumber}</span>
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {perm.canDownload && viewItem && (
                  <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void handleDownloadPDF(viewItem)} title="Download PDF">
                    <FileDown className="w-3.5 h-3.5" /> PDF
                  </Button>
                )}
                {perm.canDownload && viewItem && (
                  <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void handlePrintPDF(viewItem)} title="Print invoice">
                    <Printer className="w-3.5 h-3.5" /> Print
                  </Button>
                )}
                {perm.canDownload && viewItem && (
                  <Button
                    variant="outline" size="sm"
                    className="gap-1.5 border-[#25D366] text-[#25D366] hover:bg-[#25D366]/10 hover:text-[#128C7E]"
                    disabled={!(viewItem as any).customerPhone}
                    onClick={() => void handleWhatsApp(viewItem)}
                    title={(viewItem as any).customerPhone
                      ? `Send invoice to ${(viewItem as any).customerPhone} via WhatsApp`
                      : NO_PHONE_MESSAGE}
                  >
                    <WhatsAppIcon className="w-3.5 h-3.5" /> WhatsApp
                  </Button>
                )}
                {perm.canEdit && viewItem && (
                  <Button variant="outline" size="sm" className="gap-1.5" onClick={() => { setViewItem(null); openEdit(viewItem); }}>
                    <Pencil className="w-3.5 h-3.5" /> Edit
                  </Button>
                )}
              </div>
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

              {/* ── Payment Status ───────────────────────────────────────────
                  Every figure here is the server's derived position, not the
                  stored payment mode: 'credit' is an arrangement, not a status. */}
              <div className={`p-3 rounded-lg border text-sm ${
                ((viewItem as any).paymentStatus === 'cancelled')
                  ? 'bg-muted border-border'
                  : ((viewItem as any).paymentStatus === 'paid')
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
                    if (ps === 'cancelled') return <Badge variant="outline" className="text-muted-foreground">Cancelled</Badge>;
                    if (ps === 'paid') return <Badge className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20">Fully Paid</Badge>;
                    if (ps === 'partially_paid') return <Badge className="bg-amber-500/10 text-amber-600 border-amber-500/20">Partially Paid</Badge>;
                    return <Badge className="bg-red-500/10 text-red-600 border-red-500/20">Unpaid</Badge>;
                  })()}
                </div>
                <div className="space-y-1 text-xs text-muted-foreground">
                  <div className="flex justify-between">
                    <span>Invoice Total</span>
                    <span className="font-mono font-semibold text-foreground">₹{Number(viewItem.totalAmount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Amount Received</span>
                    <span className="font-mono text-emerald-600">₹{Number((viewItem as any).amountReceived ?? (viewItem as any).amountPaid ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                  </div>
                  {(Number((viewItem as any).creditAdjustments ?? 0) > 0) && (
                    <div className="flex justify-between text-sky-600">
                      <span>Less Credit Notes</span>
                      <span className="font-mono">−₹{Number((viewItem as any).creditAdjustments).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                    </div>
                  )}
                  {(viewItem as any).paymentStatus === 'cancelled' ? (
                    <div className="flex justify-between font-semibold text-muted-foreground">
                      <span>Balance Due</span>
                      <span className="font-mono">Nil — invoice cancelled</span>
                    </div>
                  ) : (Number((viewItem as any).balanceDue ?? 0) > 0) ? (
                    <div className="flex justify-between font-semibold text-red-600">
                      <span>Balance Due</span>
                      <span className="font-mono">₹{Number((viewItem as any).balanceDue ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                    </div>
                  ) : (
                    <div className="flex justify-between font-semibold text-emerald-600">
                      <span>Balance Due</span>
                      <span className="font-mono">₹0.00 — settled in full</span>
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
                          <span>{p.receivedInLedgerName ?? paymentModeLabel(p.method)}</span>
                          {p.referenceNumber && <span className="font-mono ml-1.5 text-muted-foreground text-[10px]">#{p.referenceNumber}</span>}
                          <span className="ml-1.5 text-muted-foreground">{p.paymentDate}</span>
                        </div>
                        <span className="font-mono font-semibold">₹{Number(p.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Collect payment — supports split payments across multiple methods */}
                {/* Offered on what is actually owed — a bill settled by a credit
                    note has nothing left to collect, whatever its stored mode. */}
                {Number((viewItem as any).balanceDue ?? 0) > 0.004 && (viewItem as any).paymentStatus !== 'cancelled' && perm.canAdd && (
                  <div className="mt-3">
                    {!showPaymentForm ? (
                      <Button size="sm" className="w-full h-8" onClick={() => {
                        const bal = Number((viewItem as any).balanceDue ?? 0).toFixed(2);
                        setPaymentRows([{ id: Date.now(), ledgerId: 0, amount: bal, ref: '' }]);
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
                                    <p className="text-[10px] text-muted-foreground mb-1">Receive Into</p>
                                    <ReceiveIntoSelect
                                      locationType={(viewItem as any)?.locationType}
                                      locationId={(viewItem as any)?.locationId}
                                      value={row.ledgerId}
                                      onChange={v => setPaymentRows(rs => rs.map(r => r.id === row.id ? { ...r, ledgerId: v } : r))}
                                      className="h-7 text-xs"
                                    />
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
                              {row.ledgerId > 0 && !isCashOption(optionFor(row.ledgerId)) && (
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
                              onClick={() => setPaymentRows(rs => [...rs, { id: Date.now(), ledgerId: 0, amount: remaining.toFixed(2), ref: '' }])}
                              className="flex items-center gap-1 text-xs text-primary hover:underline"
                            >
                              <Plus className="w-3 h-3" /> Split into another account
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
                        {paymentRows.some(r => r.ledgerId > 0 && !isCashOption(optionFor(r.ledgerId))) && (
                          <div className="text-[10px] text-amber-600 bg-amber-500/5 rounded px-2 py-1">
                            Bank/UPI collections into accounts with reconciliation turned on appear in Reconciliation until matched.
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

              {/* ── Payment request / receipt ─────────────────────────────────
                  The QR is built by the SERVER, for exactly the amount still
                  outstanding, and it is offered on the invoice itself — not only
                  while a collection is being keyed in. Nothing outstanding means
                  no QR at all: a settled or cancelled invoice shows what happened
                  instead of asking to be paid again. */}
              {(viewItem as any).paymentStatus === 'cancelled' ? (
                <div className="rounded-lg border border-border bg-muted p-3 text-xs text-muted-foreground">
                  <p className="font-semibold text-foreground">Invoice cancelled</p>
                  <p className="mt-0.5">Nothing is due on a cancelled invoice, so no payment QR or bank detail is issued.</p>
                </div>
              ) : Number((viewItem as any).balanceDue ?? 0) <= 0.004 ? (
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
                  <p className="text-xs font-bold text-emerald-600 uppercase tracking-widest mb-2">✓ Payment Received</p>
                  <div className="flex justify-between text-sm font-semibold">
                    <span>Paid in full</span>
                    <span className="font-mono">₹{Number((viewItem as any).amountReceived ?? (viewItem as any).amountPaid ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                  </div>
                  {viewItemPayments.length > 0 ? (
                    <p className="text-[11px] text-muted-foreground mt-1">
                      Last receipt: {viewItemPayments[viewItemPayments.length - 1].receivedInLedgerName ?? paymentModeLabel(viewItemPayments[viewItemPayments.length - 1].method)} on {viewItemPayments[viewItemPayments.length - 1].paymentDate}
                      {viewItemPayments[viewItemPayments.length - 1].referenceNumber ? ` · #${viewItemPayments[viewItemPayments.length - 1].referenceNumber}` : ''}
                    </p>
                  ) : (
                    <p className="text-[11px] text-muted-foreground mt-1">
                      Settled at the counter by {paymentModeLabel(viewItem.paymentMode) || 'cash'} on {new Date(viewItem.saleDate).toLocaleDateString('en-IN')}.
                    </p>
                  )}
                  <p className="text-[11px] text-muted-foreground mt-1">Nothing further is due, so no payment QR is shown.</p>
                </div>
              ) : (viewItem as any).upiQrUri ? (
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
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide mt-1">Amount Due</p>
                  <p className="text-base font-bold">₹{Number((viewItem as any).upiQrAmount ?? (viewItem as any).balanceDue ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</p>
                  <p className="text-xs text-muted-foreground">{viewItem.invoiceNumber}</p>
                  {/* A part collection being keyed in gets its own, smaller QR so
                      it can never be mistaken for the invoice's balance. */}
                  {showPaymentForm && paymentMethod === 'upi' && collectQrUrl && (
                    <div className="mt-3 pt-3 border-t border-teal-500/20">
                      <p className="text-[10px] font-semibold text-teal-700 dark:text-teal-400 uppercase tracking-wide">Or collect this part payment now</p>
                      <img src={collectQrUrl} alt="UPI QR for part payment" className="w-32 h-32 mx-auto rounded-lg border border-border shadow-sm mt-2" />
                      <p className="text-sm font-bold mt-1">₹{Math.min(Number(paymentAmount) || 0, Number((viewItem as any).balanceDue ?? 0)).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</p>
                      <p className="text-[10px] text-muted-foreground">Asks for the amount entered above, not the full balance.</p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-400">
                  <p className="font-semibold">UPI payment QR not available</p>
                  <p className="mt-0.5 opacity-80">
                    ₹{Number((viewItem as any).balanceDue ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })} is outstanding, but{' '}
                    {(viewItem as any).outletUpiId
                      ? <>the invoice QR is switched off in Company Settings → Invoice Payments.</>
                      : <>no UPI ID is set for <strong>{viewItem.outletName}</strong> or in Company Settings → Invoice Payments.</>}
                    {' '}The invoice still carries bank details for payment.
                  </p>
                </div>
              )}

              <div className="flex flex-col gap-3">
                {/* Sharing is link management, not a one-shot button: the same link
                    can be copied, replaced or cut off long after it was sent, so the
                    invoice shows the link's live state rather than just a Send. */}
                <InvoiceShareLinkPanel
                  saleId={viewItem.id}
                  canShare={perm.canDownload}
                  customerPhone={(viewItem as any).customerPhone}
                  onShareWhatsApp={() => handleWhatsApp(viewItem)}
                />
                {perm.canDownload && (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    {perm.canDownload && (
                      <Button variant="outline" onClick={() => void handlePreviewPDF(viewItem)}>
                        <Eye className="w-4 h-4 mr-2" /> Preview
                      </Button>
                    )}
                    {perm.canDownload && (
                      <Button variant="outline" onClick={() => void handleDownloadPDF(viewItem)}>
                        <FileDown className="w-4 h-4 mr-2" /> Download
                      </Button>
                    )}
                    {perm.canDownload && (
                      <Button variant="outline" onClick={() => void handlePrintPDF(viewItem)}>
                        <Printer className="w-4 h-4 mr-2" /> Print
                      </Button>
                    )}
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
