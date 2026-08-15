import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useRoute } from 'wouter';
import { SearchableItemSelect } from '@/components/ui/searchable-item-select';
import {
  useCreatePurchase, useListVendors, useListMaterials, useListRawMaterials, useListItems,
  getListPurchasesQueryKey, useUpdatePurchase, useGetCompanySettings, useGetPurchase,
  useListWarehouses, useListOutlets, usePartyAdvance, useListAccountsFlat,
} from '@workspace/api-client-react';
import { isSystemLedger } from '@/lib/systemLedgers';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Plus, ShoppingCart, X, ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { Checkbox } from '@/components/ui/checkbox';
import { usePermission } from '@/lib/usePermission';
import { activeProductsWithSelection } from '@/lib/productStatus';
import { useActingLocations, decodeLocation, encodeLocation } from '@/lib/useActingLocation';
import { Separator } from '@/components/ui/separator';
// The same arithmetic the server posts with. Imported rather than re-typed so
// the preview in this form and the figures written to the books cannot drift.
import { calcPurchaseBill, calcPurchaseLine, type PriceMode } from '@workspace/purchase-pricing';
import { useQueryClient } from '@tanstack/react-query';
import { useEntryShortcuts } from '@/lib/keyboard-entry';
import { PageHeader } from '@/components/app/page-header';
import { inr } from '@/lib/currency';

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

/** Other Purchase Charges — freight, loading, transport… Posted Dr Direct
 *  Expense ledger / Cr vendor, so they add to what the vendor is owed but
 *  NEVER touch stock cost, item rates or GST (the server enforces the same
 *  rule; legacy ledgers already stored on a bill stay valid on edit). */
const otherChargeSchema = z.object({
  ledgerId: z.coerce.number().min(1, 'Pick a Direct Expense ledger'),
  amount: z.coerce.number().gt(0, 'Amount must be above zero'),
});

const schema = z.object({
  vendorId: z.coerce.number().min(1, 'Vendor required'),
  purchaseDate: z.string().min(1, 'Date required'),
  invoiceNumber: z.string().optional(),
  // The date printed on the VENDOR's invoice — distinct from purchaseDate (our
  // booking date). Required for a NEW bill (see createSchema); optional on edit
  // so a historical bill recorded before the field existed can still be
  // corrected without inventing a date (absent ≠ zero, no fake backfill).
  vendorInvoiceDate: z.string().optional(),
  location: z.string().min(1, 'Location required'),
  // Whether the rates below include GST. Recorded with the bill, never guessed
  // from the amounts: at 5%, a rate of 105 is a valid inclusive line and an
  // equally valid exclusive one.
  priceMode: z.enum(['exclusive', 'inclusive']).default('exclusive'),
  lineItems: z.array(lineSchema).min(1, 'Add at least one item'),
  otherCharges: z.array(otherChargeSchema).default([]),
  notes: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

/** New bills must carry the vendor's invoice date. */
const createSchema = schema.superRefine((v, ctx) => {
  if (!v.vendorInvoiceDate?.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['vendorInvoiceDate'], message: 'Vendor invoice date required' });
  }
});

const defaultLine = { materialType: 'raw_material' as const, materialId: 0, hsnCode: '', quantity: 1, unitCost: 0, discount: 0, gstRate: 5, taxType: 'intra' as const, taxTypeOverride: false, batchNumber: '', mfgDate: '', expiryDate: '' };

/** One shared column template for the item grid header and every ≥lg row, so
 *  the columns can never drift out of alignment. Below lg the same cells wrap
 *  into a labelled 2/3-column grid instead — no horizontal scrolling at any
 *  breakpoint. The two class strings MUST stay identical. */
const GRID_LG = 'lg:grid-cols-[minmax(230px,1fr)_100px_76px_96px_76px_84px_110px_32px]';

/** Two-letter state code out of a GSTIN, for the intra/inter hint. */
const gstinState = (g: unknown) => {
  const s = String(g ?? '').trim();
  return /^\d{2}[A-Za-z0-9]{13}$/.test(s) ? s.slice(0, 2) : null;
};
const plainState = (s: unknown) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Tiny label shown above each line field below lg, where the header row is
 *  hidden. Plain <label>, not FormLabel — these are register()-driven inputs. */
const CellLabel = ({ children, className = '' }: { children: React.ReactNode; className?: string }) => (
  <span className={`lg:hidden text-[10px] uppercase tracking-wide text-muted-foreground font-medium ${className}`}>{children}</span>
);

export default function PurchaseEntry() {
  const perm = usePermission('page:/production/purchase');
  const [, navigate] = useLocation();
  const [, editParams] = useRoute('/production/purchase/:id/edit');
  const editingId = editParams?.id ? Number(editParams.id) : null;
  const isEdit = editingId !== null;

  const { data: vendors = [] } = useListVendors();
  const { data: materials = [] } = useListMaterials();
  const { data: rawMaterials = [] } = useListRawMaterials();
  const { data: finishedItems = [] } = useListItems();
  const locations = useActingLocations();
  const queryClient = useQueryClient();

  // The bill being edited — fetched by id so a deep link straight to
  // /production/purchase/7/edit works without visiting the list first.
  const { data: editBill, isLoading: editLoading, error: editError } =
    useGetPurchase(editingId ?? 0, { query: { enabled: isEdit } as any });

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

  const { data: companySettings } = useGetCompanySettings();
  // Branch registrations, for the intra/inter hint on the entry form.
  const { data: warehouses = [] } = useListWarehouses();
  const { data: outlets = [] } = useListOutlets();

  const form = useForm<FormValues>({
    resolver: zodResolver(isEdit ? schema : createSchema),
    defaultValues: { vendorId: 0, purchaseDate: new Date().toISOString().split('T')[0], invoiceNumber: '', vendorInvoiceDate: '', location: 'headoffice:1', priceMode: 'exclusive', lineItems: [defaultLine], otherCharges: [], notes: '' },
  });

  // A fresh bill starts at the caller's own location once the location list
  // resolves. reset (not setValue) so the seeded value becomes the pristine
  // default — the unsaved-changes guard must not fire on it.
  const seededLocation = useRef(false);
  useEffect(() => {
    if (isEdit || seededLocation.current || !locations.defaultValue) return;
    seededLocation.current = true;
    form.reset({ ...form.getValues(), location: locations.defaultValue });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locations.defaultValue, isEdit]);

  // Edit: prefill from the fetched bill, exactly as stored.
  const prefilled = useRef(false);
  useEffect(() => {
    if (!isEdit || !editBill || prefilled.current) return;
    prefilled.current = true;
    const p: any = editBill;
    form.reset({
      vendorId: p.vendorId,
      purchaseDate: (p.purchaseDate ?? '').substring(0, 10) || new Date().toISOString().split('T')[0],
      invoiceNumber: p.invoiceNumber || '',
      // Absent on historical bills — left blank, never fabricated.
      vendorInvoiceDate: (p.vendorInvoiceDate ?? '').substring(0, 10),
      location: encodeLocation(p.locationType ?? 'headoffice', Number(p.locationId ?? 1)),
      // The bill's own rate mode, not a fresh default: re-opening an inclusive
      // bill as exclusive would restate every figure on it.
      priceMode: (p.priceMode === 'inclusive' ? 'inclusive' : 'exclusive'),
      notes: p.notes || '',
      lineItems: ((p.lineItems as any[]) || []).map((li: any) => ({
        materialType: li.materialType || 'raw_material',
        materialId: li.materialId,
        hsnCode: li.hsnCode || '',
        quantity: Number(li.quantity),
        unitCost: Number(li.unitCost),
        discount: Number(li.discount || 0),
        gstRate: Number(li.gstRate || 0),
        taxType: li.taxType || 'intra',
        // An existing line keeps the GST type it was saved with unless the
        // user changes it again.
        taxTypeOverride: li.taxTypeSource === 'override',
        batchNumber: li.batchNumber || '',
        mfgDate: (li.mfgDate ?? '').substring(0, 10),
        expiryDate: (li.expiryDate ?? '').substring(0, 10),
      })),
      otherCharges: ((p.otherCharges as any[]) ?? []).map((c: any) => ({
        ledgerId: Number(c.ledgerId), amount: Number(c.amount),
      })),
    });
  }, [isEdit, editBill, form]);

  // Direct Expense ledgers offered for Other Charges — postable, non-internal,
  // strictly under SYS-DIREXP, mirroring the server's validation. Historical
  // bills could charge any expense ledger: when EDITING such a bill its stored
  // ledgers stay selectable (the server grandfathers them), labelled
  // "(legacy)" so the mixed-legacy state is visible, never silently rewritten.
  const { data: allAccounts = [] } = useListAccountsFlat();
  const expenseLedgers = useMemo(() => {
    const byId = new Map((allAccounts as any[]).map((a: any) => [Number(a.id), a]));
    const underGroupCode = (a: any, code: string): boolean => {
      const seen = new Set<number>();
      for (let cur = a.parentId != null ? byId.get(Number(a.parentId)) : undefined;
           cur && !seen.has(Number(cur.id));
           cur = cur.parentId != null ? byId.get(Number(cur.parentId)) : undefined) {
        seen.add(Number(cur.id));
        if (String(cur.code ?? '').toUpperCase() === code) return true;
      }
      return false;
    };
    const direct = (allAccounts as any[])
      .filter((a: any) => a.type === 'expense' && !a.isGroup && !a.isSystemGroup && !isSystemLedger(a.code) && underGroupCode(a, 'SYS-DIREXP'))
      .sort((x: any, y: any) => String(x.name).localeCompare(String(y.name)))
      .map((a: any) => ({ id: Number(a.id), name: String(a.name), legacy: false }));
    const inList = new Set(direct.map(d => d.id));
    const storedIds = new Set(
      ((((editBill as any)?.otherCharges) ?? []) as any[])
        .map((c: any) => Number(c?.ledgerId))
        .filter((n: number) => Number.isInteger(n) && n > 0),
    );
    const legacy = (allAccounts as any[])
      .filter((a: any) => storedIds.has(Number(a.id)) && !inList.has(Number(a.id)))
      .map((a: any) => ({ id: Number(a.id), name: String(a.name), legacy: true }));
    return [...direct, ...legacy];
  }, [allAccounts, editBill]);

  // Advance adjustment: does the selected vendor hold money we paid beyond
  // their bills? Create only — edits never touch the advance.
  const watchVendorId = form.watch('vendorId');
  const { data: vendorAdvance } = usePartyAdvance('vendor', isEdit ? null : (Number(watchVendorId) || null));
  const [applyAdvance, setApplyAdvance] = useState(true);
  useEffect(() => { setApplyAdvance(true); }, [watchVendorId]);
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'lineItems' });
  const { fields: chargeFields, append: appendCharge, remove: removeCharge } = useFieldArray({ control: form.control, name: 'otherCharges' });
  const watchLines = form.watch('lineItems');
  const watchCharges = form.watch('otherCharges');
  // What the vendor is actually owed: goods total + other charges. Charges
  // never enter `bill` — that is the goods/GST arithmetic the server stores.
  const otherTotal = Math.round((watchCharges ?? []).reduce((t, c) => t + (Number(c?.amount) || 0), 0) * 100) / 100;
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
  // What the vendor is actually owed on this bill: goods + other charges.
  const grandPayable = Math.round((bill.totalAmount + otherTotal) * 100) / 100;

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

  // ── Unsaved-changes guard (full page) ─────────────────────────────────────
  // The dialog version got this from TransactionDialog; on a page the browser
  // navigation is guarded with beforeunload and the in-app Cancel/Back buttons
  // with a confirm dialog.
  const dirty = form.formState.isDirty;
  const [confirmLeave, setConfirmLeave] = useState(false);
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);
  const goBack = () => navigate('/production/purchase');
  const requestLeave = () => { if (dirty) setConfirmLeave(true); else goBack(); };

  /** data-testid of the ONE category trigger auto-opened by Add Line (null =
   *  none): when THAT select closes (Enter pick, re-pick of the default, or
   *  Escape), focus hops on to its row's Item picker. Row-scoped and set only
   *  after a VERIFIED open, so a failed open or a manual mouse edit of another
   *  row's category can never hijack focus. */
  const autoAdvanceCatRef = useRef<string | null>(null);

  /** Radix triggers open on different gestures: the category <Select> listens
   *  for pointerdown, the item picker's Popover for click. Each helper sends
   *  exactly the one its target reacts to — sending both would toggle twice. */
  const openCategorySelect = (el?: HTMLButtonElement | null): boolean => {
    if (!el) return false;
    el.focus();
    // Radix versions differ in which gesture opens a Select trigger, so try
    // pointerdown → ArrowDown → click, checking aria-expanded between attempts
    // (discrete events flush synchronously) so nothing toggles twice.
    const isOpenNow = () => el.getAttribute('aria-expanded') === 'true';
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }));
    if (isOpenNow()) return true;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    if (isOpenNow()) return true;
    el.click();
    return isOpenNow();
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
   *  the appended row is always the LAST trigger on the page. */
  const addLine = () => {
    append({ ...defaultLine, taxType: billTaxType, taxTypeOverride: billTaxTypeOverridden });
    setTimeout(() => {
      const triggers = document.querySelectorAll<HTMLButtonElement>('[data-testid^="purchase-line-cat-"]');
      const el = triggers[triggers.length - 1];
      autoAdvanceCatRef.current = el && openCategorySelect(el) ? el.getAttribute('data-testid') : null;
    }, 0);
  };

  /** Delete a line for the keyboard workflow — mirrors the row X button, which
   *  is disabled while only one line remains, so the minimum-row rule holds. */
  const deleteLine = (index: number) => {
    if (fields.length <= 1) return;
    remove(index);
  };

  /** Enter inside a line-item text input must never fall through to the form's
   *  implicit submission (half-typed bills were one Enter away from saving).
   *  On the row's LAST field (Expiry) Enter acts as Add Line; on every other
   *  input it walks to the next field in the row's tab order, like Tab. Radix
   *  selects and the item picker handle Enter themselves and are left alone. */
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

  // Document-level Ctrl+S / Ctrl+Enter (save) and F4 (Add Line) — active for
  // the whole life of the page.
  useEntryShortcuts(true, {
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
    const { location, vendorInvoiceDate, ...rest } = form0;
    // A user who cannot choose is always pinned to their own location, even if
    // the picker had not resolved `me` yet when the page opened.
    const data = {
      ...rest,
      // Blank on an EDIT means the bill keeps having none (legacy bills are
      // never force-backfilled); the create schema requires a value.
      vendorInvoiceDate: vendorInvoiceDate?.trim() ? vendorInvoiceDate.trim() : (isEdit ? null : undefined),
      ...decodeLocation(locations.canChoose ? location : locations.defaultValue),
      // Advance adjustment — opt-in; the server caps at what the books hold.
      ...(!isEdit && applyAdvance && (vendorAdvance?.available ?? 0) > 0.004
        ? { useAdvance: true } : {}),
    };
    const done = () => {
      queryClient.invalidateQueries({ queryKey: getListPurchasesQueryKey() });
      invalidateStockDashboards();
      // reset() so the beforeunload guard stands down before navigation.
      form.reset(form.getValues());
      goBack();
    };
    if (isEdit) {
      updateMutation.mutate({ id: editingId!, data: data as any }, {
        onSuccess: (resp: any) => { toast.success('Purchase bill updated'); showWarnings(resp); done(); },
        onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
      });
    } else {
      createMutation.mutate({ data: data as any }, {
        onSuccess: (resp: any) => {
          const lots = ((resp?.lineItems ?? []) as any[]).map(l => l?.batchNumber).filter(Boolean);
          toast.success(lots.length ? `Purchase bill created · batch ${lots.join(', ')}` : 'Purchase bill created');
          showWarnings(resp);
          done();
        },
        onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
      });
    }
  };

  // ── Permission / load states ───────────────────────────────────────────────
  const denied = !perm.isLoading && (!perm.canView || (isEdit ? !perm.canEdit : !perm.canAdd));
  if (denied) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center py-32 text-muted-foreground gap-3">
          <ShoppingCart className="w-10 h-10 text-destructive/50" />
          <p className="text-lg font-medium">Access Denied</p>
          <p className="text-sm">You don't have permission to {isEdit ? 'edit' : 'record'} purchase bills.</p>
          <Button variant="outline" size="sm" onClick={goBack}><ArrowLeft className="w-4 h-4 mr-2" />Back to Purchases</Button>
        </div>
      </AppLayout>
    );
  }
  if (isEdit && (editLoading || (!editBill && !editError))) {
    return (
      <AppLayout>
        <div className="space-y-4">
          <div className="h-8 w-64 bg-muted/40 rounded animate-pulse" />
          <div className="h-40 bg-muted/30 rounded-xl animate-pulse" />
          <div className="h-64 bg-muted/20 rounded-xl animate-pulse" />
        </div>
      </AppLayout>
    );
  }
  if (isEdit && editError) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center py-32 text-muted-foreground gap-3">
          <ShoppingCart className="w-10 h-10 text-destructive/50" />
          <p className="text-lg font-medium">Bill not found</p>
          <p className="text-sm">Purchase bill #{editingId} could not be loaded — it may have been deleted.</p>
          <Button variant="outline" size="sm" onClick={goBack}><ArrowLeft className="w-4 h-4 mr-2" />Back to Purchases</Button>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-6 pb-24">
        <PageHeader
          title={isEdit ? `Edit Purchase Bill #${String(editingId).padStart(4, '0')}` : 'New Purchase Bill'}
          description="Enter purchase details with HSN, GST rate and discount per item"
          icon={ShoppingCart}
          actions={
            <Button variant="outline" size="sm" onClick={requestLeave}>
              <ArrowLeft className="w-4 h-4 mr-2" /> Back to Purchases
            </Button>
          }
        />

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            {/* ── Bill header ── */}
            <div className="bg-card border border-border rounded-xl shadow-sm p-4 sm:p-6">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 items-start">
                <FormField control={form.control} name="vendorId" render={({ field }) => (
                  <FormItem><FormLabel>Vendor <span className="text-destructive">*</span></FormLabel>
                    {/* Searchable, scrollable picker — a plain dropdown outgrows
                        the screen once the vendor master grows. */}
                    <FormControl><SearchableItemSelect
                      items={(vendors as any[]).map((v: any) => ({ id: Number(v.id), name: String(v.name ?? '') }))}
                      value={field.value}
                      onChange={id => field.onChange(id)}
                      placeholder="Select vendor"
                      emptyLabel="No vendors found"
                      data-testid="input-purchase-vendor"
                    /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="purchaseDate" render={({ field }) => (
                  <FormItem><FormLabel>Purchase Date <span className="text-destructive">*</span></FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="invoiceNumber" render={({ field }) => (
                  <FormItem><FormLabel>Vendor Invoice #</FormLabel><FormControl><Input placeholder="Vendor's invoice no." {...field} /></FormControl></FormItem>
                )} />
                {/* The date printed on the vendor's own invoice — distinct from
                    the purchase (booking) date above. Mandatory on new bills;
                    a historical bill without one is never force-backfilled. */}
                <FormField control={form.control} name="vendorInvoiceDate" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Vendor Invoice Date {!isEdit && <span className="text-destructive">*</span>}</FormLabel>
                    <FormControl><Input type="date" data-testid="input-vendor-invoice-date" {...field} /></FormControl>
                    {isEdit && !field.value && (
                      <p className="text-[10px] text-muted-foreground">Not recorded on this bill — optional to add now.</p>
                    )}
                    <FormMessage />
                  </FormItem>
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
                          {isEdit
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
                {!isEdit && (vendorAdvance?.available ?? 0) > 0.004 && (
                  <label className="sm:col-span-2 lg:col-span-3 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm cursor-pointer">
                    <Checkbox checked={applyAdvance} onCheckedChange={v => setApplyAdvance(v === true)} />
                    <span>
                      Adjust available advance of <span className="font-mono font-semibold">{inr(Number(vendorAdvance!.available))}</span> against this bill
                    </span>
                  </label>
                )}
              </div>
            </div>

            {/* ── Line Items ── */}
            <div className="bg-card border border-border rounded-xl shadow-sm p-4 sm:p-6">
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
              <div className="border border-border rounded-lg overflow-hidden">
                {/* One Enter handler for every line input: next field, or Add
                    Line from the row's last field. See handleLineKeyDown.
                    Below lg the grid wraps into labelled cells instead of
                    scrolling sideways — no horizontal scroll at any width. */}
                <div data-kbd-scope onKeyDown={handleLineKeyDown}>
                <div className={`hidden lg:grid gap-2 bg-muted/30 text-xs font-medium text-muted-foreground uppercase tracking-wide px-3 py-2.5 ${GRID_LG}`}>
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
                    <div data-kbd-row={index} className={`grid items-end lg:items-center gap-2 px-3 py-2.5 border-t border-border grid-cols-2 sm:grid-cols-4 ${GRID_LG}`}>
                      {/* Item type + item selector combined. Full row below lg
                          so long names have the whole width and wrap the grid
                          vertically instead of scrolling sideways. */}
                      <div className="col-span-2 sm:col-span-4 lg:col-span-1 space-y-1 min-w-0">
                        <CellLabel>Item</CellLabel>
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
                            className="h-9 text-xs flex-1 min-w-0"
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
                              barcode: m.barcode || null,
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
                          {/* Row delete lives beside the picker below lg (the
                              trailing grid cell is hidden there). */}
                          <Button type="button" variant="ghost" size="icon" tabIndex={-1} className="lg:hidden h-9 w-8 shrink-0 text-destructive" onClick={() => remove(index)} disabled={fields.length === 1}>
                            <X className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                        {/* Unit + MRP straight from the master — display only,
                            nothing here feeds the costing arithmetic. */}
                        {Number(li.materialId) > 0 && (() => {
                          const kind = form.watch(`lineItems.${index}.materialType`);
                          const arr: any[] = kind === 'raw_material' ? rawMaterials : kind === 'item' ? finishedItems : materials;
                          const m: any = arr.find((x: any) => Number(x.id) === Number(li.materialId));
                          return m ? (
                            <p className="text-[10px] text-muted-foreground">
                              Unit <span className="font-mono">{m.unit || '—'}</span>
                              {Number(m.mrp ?? 0) > 0 && <> · MRP {inr(Number(m.mrp))}</>}
                            </p>
                          ) : null;
                        })()}
                      </div>
                      {/* HSN fills itself from the Item Master; it is out of
                          the tab order (still mouse-editable) so Tab goes
                          Item → Qty as billed. */}
                      <div className="space-y-1 min-w-0">
                        <CellLabel>HSN</CellLabel>
                        <Input className="h-9 text-xs font-mono" placeholder="HSN" tabIndex={-1} {...form.register(`lineItems.${index}.hsnCode`)} />
                      </div>
                      <div className="space-y-1 min-w-0">
                        <CellLabel>Qty</CellLabel>
                        <Input className="h-9 text-xs text-right" type="number" min={0} step="0.001" {...form.register(`lineItems.${index}.quantity`)} />
                      </div>
                      <div className="space-y-1 min-w-0">
                        <CellLabel>Rate ₹</CellLabel>
                        <Input className="h-9 text-xs text-right" type="number" min={0} step="0.01" {...form.register(`lineItems.${index}.unitCost`)} />
                      </div>
                      <div className="space-y-1 min-w-0">
                        <CellLabel>Disc %</CellLabel>
                        <Input className="h-9 text-xs text-right" type="number" min={0} max={100} step="0.1" placeholder="0" {...form.register(`lineItems.${index}.discount`)} />
                      </div>
                      {/* GST % only — the intra/inter choice is bill-level,
                          above the table. */}
                      <div className="space-y-1 min-w-0">
                        <CellLabel>GST %</CellLabel>
                        <Select onValueChange={v => form.setValue(`lineItems.${index}.gstRate`, Number(v))} value={String(form.watch(`lineItems.${index}.gstRate`) ?? 5)}>
                          <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>{GST_RATES.map(r => <SelectItem key={r} value={String(r)}>{r}%</SelectItem>)}</SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1 min-w-0 sm:col-span-2 lg:col-span-1">
                        <CellLabel>Total ₹</CellLabel>
                        <div className="h-9 flex items-center justify-end text-sm font-mono font-medium tabular-nums whitespace-nowrap">{inr(calc.lineTotal)}</div>
                      </div>
                      <Button type="button" variant="ghost" size="icon" tabIndex={-1} className="hidden lg:inline-flex h-8 w-8 text-destructive justify-self-end" onClick={() => remove(index)} disabled={fields.length === 1}>
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                    {/* Batch identity. Frozen food cannot be traced or
                        expiry-checked without dates, so those stay required;
                        the number is issued by the server when left blank.
                        Wraps naturally on narrow screens. */}
                    <div data-kbd-row={index} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-1.5 bg-emerald-500/[0.03]">
                      <div className="flex items-center gap-2 min-w-0 grow basis-56">
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground shrink-0">Batch</span>
                        <Input className="h-8 text-xs font-mono min-w-0" placeholder="Auto on save (or vendor lot no.)" {...form.register(`lineItems.${index}.batchNumber`)} />
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground shrink-0">
                          Mfg <span className="text-destructive">*</span>
                        </span>
                        <Input className="h-8 text-xs w-[150px]" type="date" {...form.register(`lineItems.${index}.mfgDate`)} />
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground shrink-0">
                          Expiry <span className="text-destructive">*</span>
                        </span>
                        <Input className="h-8 text-xs w-[150px]" type="date" data-last-field="1" {...form.register(`lineItems.${index}.expiryDate`)} />
                      </div>
                      {(form.formState.errors.lineItems?.[index] as any) ? (
                        <span className="text-[10px] text-destructive">
                          {(form.formState.errors.lineItems?.[index] as any)?.mfgDate?.message
                            ?? (form.formState.errors.lineItems?.[index] as any)?.expiryDate?.message
                            ?? (form.formState.errors.lineItems?.[index] as any)?.hsnCode?.message}
                        </span>
                      ) : null}
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

            {/* ── Other Purchase Charges — freight, loading, transport and the
                like. Posted to the chosen Direct Expense ledger and owed to
                the vendor; kept OUT of stock cost, item rates and GST. ── */}
            <div className="bg-card border border-border rounded-xl shadow-sm p-4 sm:p-6">
              <h3 className="text-sm font-semibold mb-2">
                Other Charges{' '}
                <span className="text-xs font-normal text-muted-foreground">(freight, loading, transport… — booked as Direct Expenses, never into stock cost)</span>
              </h3>
              {chargeFields.length > 0 && (
                <div className="space-y-2">
                  {chargeFields.map((cf, ci) => (
                    <div key={cf.id} className="grid grid-cols-[minmax(0,1fr)_130px_32px] gap-2 items-start">
                      <FormField control={form.control} name={`otherCharges.${ci}.ledgerId`} render={({ field }) => (
                        <FormItem>
                          <Select value={field.value ? String(field.value) : ''} onValueChange={v => field.onChange(Number(v))}>
                            <FormControl><SelectTrigger className="h-9 text-xs"><SelectValue placeholder="Direct Expense ledger" /></SelectTrigger></FormControl>
                            <SelectContent>
                              {expenseLedgers.length === 0 && <div className="px-3 py-2 text-xs text-muted-foreground">No Direct Expense ledgers — create one (e.g. Freight Inward) under Accounts → Chart of Accounts, inside Direct Expense</div>}
                              {expenseLedgers.map((l: any) => <SelectItem key={l.id} value={String(l.id)}>{l.name}{l.legacy ? ' (legacy)' : ''}</SelectItem>)}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={form.control} name={`otherCharges.${ci}.amount`} render={({ field }) => (
                        <FormItem>
                          <FormControl><Input className="h-9 text-xs text-right font-mono" type="number" step="0.01" min="0" placeholder="Amount" {...field} value={(field.value as any) === 0 ? '' : (field.value as any) ?? ''} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <Button type="button" variant="ghost" size="icon" tabIndex={-1} className="h-9 w-8 text-destructive justify-self-end" onClick={() => removeCharge(ci)}>
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => appendCharge({ ledgerId: 0, amount: 0 } as any)}>
                <Plus className="w-3.5 h-3.5 mr-1" /> Add Charge
              </Button>
            </div>

            {/* ── Notes + Bill Summary — side by side on wide screens. ── */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="bg-card border border-border rounded-xl shadow-sm p-4 sm:p-6">
                <FormField control={form.control} name="notes" render={({ field }) => (
                  <FormItem><FormLabel>Notes</FormLabel><FormControl><Textarea rows={3} placeholder="Optional notes" {...field} /></FormControl></FormItem>
                )} />
              </div>
              <div className="bg-card border border-border rounded-xl shadow-sm p-4 sm:p-6 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Subtotal {priceMode === 'inclusive' ? '(GST incl.)' : ''}</span>
                  <span className="font-mono">{inr(bill.subtotal)}</span>
                </div>
                {bill.discountTotal > 0 && (
                  <div className="flex justify-between"><span className="text-muted-foreground">(-) Discount</span><span className="font-mono text-red-500">-{inr(bill.discountTotal)}</span></div>
                )}
                <div className="flex justify-between"><span className="text-muted-foreground">Taxable Amount</span><span className="font-mono">{inr(bill.taxableTotal)}</span></div>
                <Separator />
                {bill.cgstTotal > 0 && <div className="flex justify-between"><span className="text-muted-foreground">CGST</span><span className="font-mono">{inr(bill.cgstTotal)}</span></div>}
                {bill.sgstTotal > 0 && <div className="flex justify-between"><span className="text-muted-foreground">SGST</span><span className="font-mono">{inr(bill.sgstTotal)}</span></div>}
                {bill.igstTotal > 0 && <div className="flex justify-between"><span className="text-muted-foreground">IGST</span><span className="font-mono">{inr(bill.igstTotal)}</span></div>}
                {Math.abs(bill.roundOff) > 0.001 && <div className="flex justify-between"><span className="text-muted-foreground">Round Off</span><span className="font-mono">{bill.roundOff > 0 ? '+' : ''}{inr(Math.abs(bill.roundOff))}</span></div>}
                <Separator />
                <div className="flex justify-between font-bold text-base pt-1"><span>{otherTotal > 0 ? 'Goods Total' : 'Grand Total'}</span><span className="font-mono text-primary">{inr(bill.totalAmount)}</span></div>
                {otherTotal > 0 && (
                  <>
                    <div className="flex justify-between"><span className="text-muted-foreground">(+) Other Charges</span><span className="font-mono">{inr(otherTotal)}</span></div>
                    <Separator />
                    <div className="flex justify-between font-bold text-base"><span>Total Payable</span><span className="font-mono text-primary">{inr(grandPayable)}</span></div>
                  </>
                )}
                {priceMode === 'inclusive' && (
                  <p className="text-[10px] text-muted-foreground pt-1">
                    GST is worked back out of the rates, so the total equals the rates you keyed in (plus round-off).
                  </p>
                )}
              </div>
            </div>

            {/* ── Sticky action bar — the running total and Save stay in view
                however long the line-item list grows, at every width. ── */}
            <div className="fixed bottom-0 left-0 right-0 z-20 border-t border-border bg-background/95 backdrop-blur">
              <div className="flex items-center justify-between gap-3 px-4 py-2.5 md:px-8">
                <div className="text-sm font-bold flex items-baseline gap-2 min-w-0">
                  <span className="text-muted-foreground font-medium text-xs uppercase tracking-wide shrink-0">{otherTotal > 0 ? 'Total Payable' : 'Grand Total'}</span>
                  <span className="font-mono text-primary text-base truncate">{inr(grandPayable)}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button variant="outline" type="button" onClick={requestLeave}>Cancel</Button>
                  <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending} data-testid="button-save-purchase">
                    {(createMutation.isPending || updateMutation.isPending) ? 'Saving…' : isEdit ? 'Save Changes' : 'Save Purchase Bill'}
                  </Button>
                </div>
              </div>
            </div>
          </form>
        </Form>
      </div>

      {/* ── Discard confirmation — the page-level analogue of the transaction
          dialog's dirty guard. ── */}
      <Dialog open={confirmLeave} onOpenChange={setConfirmLeave}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>This bill has unsaved changes. Leaving now will discard them.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmLeave(false)}>Keep editing</Button>
            <Button variant="destructive" onClick={() => { setConfirmLeave(false); goBack(); }}>Discard & leave</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
