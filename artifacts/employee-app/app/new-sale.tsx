import React, { useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  createSaleFull,
  useCashBankLedgersFlat,
  useListCustomers,
  useListItems,
  useListOutlets,
  useListWarehouses,
  useVoucherLocations,
  type CreatedSale,
  type CreateSalePayload,
} from '@workspace/api-client-react';
import { FormScreen } from '@/components/ui/FormScreen';
import { SearchablePicker, type PickerItem } from '@/components/ui/SearchablePicker';
import { formatMoney } from '@/components/ui/MoneyText';
import { PriceHistorySheet } from '@/components/PriceHistorySheet';
import { confirmDialog, notify } from '@/lib/dialogs';
import {
  computeCartTotals,
  isMoneyString,
  isQtyString,
  newRequestId,
  type DraftLine,
} from '@/lib/saleMath';
import { localYmd, shiftYmd } from '@/lib/localDate';
import { PAGE, useErpPermissions } from '@/hooks/useErpPermissions';
import { useLocationContext } from '@/contexts/LocationContext';
import { useColors } from '@/hooks/useColors';

/**
 * New Sale — full-screen stepped billing flow:
 *   1 Details (location, customer, date) → 2 Items → 3 Summary → 4 Payment
 * then a success screen with the invoice number.
 *
 * The client previews the money math (lib/saleMath mirrors the server) and
 * pre-checks the obvious rejections (MRP floor, walk-in partials), but the
 * SERVER stays authoritative — its exact error messages are surfaced as-is.
 * One clientRequestId per logical sale makes retries idempotent.
 */

type SaleLocation = {
  locationType: 'warehouse' | 'outlet' | 'headoffice';
  locationId: number;
  name: string;
};

type Line = DraftLine & { taxableTouched: boolean };

const STEPS = ['Details', 'Items', 'Summary', 'Payment'] as const;

type PayMode = 'cash' | 'bank' | 'upi' | 'credit';

/** Best client-side guess at an account's class — display grouping only, the
 * server re-derives the stored mode from the picked ledger. */
function accountClass(a: { accountType?: string | null; code?: string | null }): 'cash' | 'bank' | 'upi' {
  if (a.accountType === 'cash') return 'cash';
  if (a.accountType === 'upi') return 'upi';
  if (a.accountType === 'bank') return 'bank';
  return (a.code ?? '').toUpperCase().includes('CASH') ? 'cash' : 'bank';
}

const todayStr = () => localYmd();
const shiftDate = shiftYmd;

function formatDateLong(d: string): string {
  const dt = new Date(`${d}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
}

export default function NewSaleScreen() {
  const colors = useColors();
  const queryClient = useQueryClient();
  const { location: globalLoc, locked } = useLocationContext();
  const { ready, perm } = useErpPermissions();
  const salesPerm = perm(PAGE.sales);

  // ── Wizard state ───────────────────────────────────────────────────────────
  const [step, setStep] = useState(0);
  const [created, setCreated] = useState<CreatedSale | null>(null);

  // Step 1 — details
  const [saleLoc, setSaleLoc] = useState<SaleLocation | null>(() =>
    globalLoc.locationType === 'warehouse' || globalLoc.locationType === 'outlet'
      ? {
          locationType: globalLoc.locationType,
          locationId: globalLoc.locationId ?? 0,
          name: globalLoc.locationName,
        }
      : null,
  );
  const [customer, setCustomer] = useState<{ id: number; name: string; hasGstin: boolean } | null>(null);
  const [saleDate, setSaleDate] = useState(todayStr());

  // Step 2 — items
  const [lines, setLines] = useState<Line[]>([]);
  const [historyFor, setHistoryFor] = useState<{ itemId: number; itemName: string } | null>(null);

  // Step 3 — summary
  const [billDiscount, setBillDiscount] = useState('');

  // Step 4 — payment
  const [payMode, setPayMode] = useState<PayMode>('cash');
  const [receiveLedgerId, setReceiveLedgerId] = useState<number | null>(null);
  const [amountReceived, setAmountReceived] = useState('');
  const [amountTouched, setAmountTouched] = useState(false);
  const [reference, setReference] = useState('');

  // Pickers
  const [locPickerOpen, setLocPickerOpen] = useState(false);
  const [customerPickerOpen, setCustomerPickerOpen] = useState(false);
  const [itemPickerOpen, setItemPickerOpen] = useState(false);
  const [accountPickerOpen, setAccountPickerOpen] = useState(false);

  // Submit
  const requestIdRef = useRef(newRequestId());
  const submitLockRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);

  // ── Data ───────────────────────────────────────────────────────────────────
  const { data: warehouses } = useListWarehouses();
  const { data: outlets } = useListOutlets();
  const { data: customers, isLoading: customersLoading } = useListCustomers();
  const { data: items, isLoading: itemsLoading } = useListItems();
  const {
    data: cashBank,
    isLoading: cashBankLoading,
    isError: cashBankError,
  } = useCashBankLedgersFlat();
  const {
    data: voucherLocs,
    isLoading: voucherLocsLoading,
    isError: voucherLocsError,
  } = useVoucherLocations();

  // An unresolved account query must NOT look like "this location has no
  // accounts" — that state legitimately submits via the legacy plain-cash
  // fallback, so it may only appear after both queries actually resolved.
  const accountsLoading = cashBankLoading || voucherLocsLoading;
  const accountsFailed = cashBankError || voucherLocsError;
  const accountsResolved = !accountsLoading && !accountsFailed;

  // A branch user's pinned location can land after this screen mounts
  // (startup restore) — follow it so they are never stranded location-less.
  React.useEffect(() => {
    if (!locked) return;
    if (globalLoc.locationType !== 'warehouse' && globalLoc.locationType !== 'outlet') return;
    setSaleLoc(prev =>
      prev && prev.locationType === globalLoc.locationType && prev.locationId === globalLoc.locationId
        ? prev
        : {
            locationType: globalLoc.locationType as 'warehouse' | 'outlet',
            locationId: globalLoc.locationId ?? 0,
            name: globalLoc.locationName,
          },
    );
  }, [locked, globalLoc.locationType, globalLoc.locationId, globalLoc.locationName]);

  const totals = useMemo(() => computeCartTotals(lines, billDiscount), [lines, billDiscount]);

  // Receive-into accounts of the SALE's location. HO uses the head-office set;
  // its placeholder id differs per table, so HO is matched on type alone.
  const receiveOptions = useMemo(() => {
    if (!saleLoc || !cashBank || !voucherLocs) return [];
    let ids: number[];
    if (saleLoc.locationType === 'headoffice') {
      ids = voucherLocs.headOfficeCashBankLedgerIds ?? [];
    } else {
      const entry = (voucherLocs.locations ?? []).find(
        l => l.locationType === saleLoc.locationType && Number(l.locationId) === saleLoc.locationId,
      );
      ids = entry?.cashBankLedgerIds ?? [];
    }
    const allow = new Set(ids.map(Number));
    return (cashBank as any[])
      .filter(l => allow.has(Number(l.id)))
      .map(l => ({
        id: Number(l.id),
        name: String(l.name),
        code: (l.code ?? null) as string | null,
        cls: accountClass(l),
      }));
  }, [saleLoc, cashBank, voucherLocs]);

  const modeOptions = useMemo(
    () => receiveOptions.filter(o => payMode !== 'credit' && o.cls === payMode),
    [receiveOptions, payMode],
  );

  // Once on the Payment step with resolved accounts, land on a mode this
  // location actually has an account for, with its first account pre-picked
  // (most tills have exactly one cash account). Runs on resolution too, so a
  // slow query can't leave the step selection-less.
  React.useEffect(() => {
    if (step !== 3 || !accountsResolved || payMode === 'credit' || receiveOptions.length === 0) return;
    const cls = receiveOptions.some(o => o.cls === payMode) ? payMode : receiveOptions[0].cls;
    const opts = receiveOptions.filter(o => o.cls === cls);
    if (cls !== payMode) setPayMode(cls as PayMode);
    setReceiveLedgerId(prev => (opts.some(o => o.id === prev) ? prev : opts[0]?.id ?? null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, accountsResolved, payMode, receiveOptions]);

  const styles = makeStyles(colors);

  // ── Derived validation ─────────────────────────────────────────────────────
  const lineProblems = (l: Line): string | null => {
    if (!isQtyString(l.quantity)) return 'Enter a quantity of at least 1.';
    if (!isMoneyString(l.unitPrice)) return 'Enter a valid rate (max 2 decimals).';
    if (l.mrp > 0 && Number(l.unitPrice) < l.mrp) {
      return `Rate can't go below MRP ${formatMoney(l.mrp, { showPaise: true })} — use the discount instead.`;
    }
    if (l.unitDiscount !== '' && !isMoneyString(l.unitDiscount)) {
      return 'Enter a valid discount (max 2 decimals).';
    }
    if (Number(l.unitDiscount || 0) > Number(l.unitPrice || 0)) {
      return 'Discount cannot exceed the rate.';
    }
    return null;
  };

  const stepValid = (): string | null => {
    if (step === 0) {
      if (!saleLoc) return 'Pick the selling location.';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(saleDate)) return 'Pick the sale date.';
      return null;
    }
    if (step === 1) {
      if (lines.length === 0) return 'Add at least one item.';
      for (const l of lines) {
        const p = lineProblems(l);
        if (p) return `${l.itemName}: ${p}`;
      }
      return null;
    }
    if (step === 2) {
      if (billDiscount !== '' && !isMoneyString(billDiscount)) {
        return 'Enter a valid bill discount (max 2 decimals).';
      }
      return null;
    }
    if (step === 3) {
      if (payMode === 'credit') {
        if (!customer) return 'Credit sales need a registered customer.';
        return null;
      }
      if (accountsLoading) return 'Still loading this location\u2019s payment accounts — one moment.';
      if (accountsFailed) {
        return 'Could not load this location\u2019s payment accounts. Check your connection and try again.';
      }
      if (receiveOptions.length > 0) {
        if (!receiveLedgerId) return 'Pick the account the money went into.';
        if (amountReceived !== '' && !isMoneyString(amountReceived)) {
          return 'Enter a valid amount (max 2 decimals).';
        }
        if (amountReceived !== '' && Number(amountReceived) <= 0) {
          return 'Amount received must be above zero.';
        }
        const amt = amountReceived === '' ? totals.grandTotal : Number(amountReceived);
        if (amt < totals.grandTotal - 0.004 && !customer) {
          return 'Partial payment needs a registered customer — collect the full amount or pick a customer.';
        }
      }
      return null;
    }
    return null;
  };

  // ── Actions ────────────────────────────────────────────────────────────────
  const addItem = (pi: PickerItem) => {
    const it = (items as any[] | undefined)?.find(i => Number(i.id) === Number(pi.key));
    if (!it) return;
    if (lines.some(l => l.itemId === Number(it.id))) {
      notify('Already added', `${it.name} is already in the bill — change its quantity instead.`);
      return;
    }
    setLines(ls => [
      ...ls,
      {
        itemId: Number(it.id),
        itemName: String(it.name),
        unit: String(it.unit ?? ''),
        taxRate: Number(it.taxRate ?? 0),
        mrp: Number(it.mrp ?? 0),
        quantity: '1',
        unitPrice: Number(it.mrp ?? 0) > 0 ? String(it.mrp) : '',
        unitDiscount: '',
        taxable: customer?.hasGstin ?? false,
        taxableTouched: false,
      },
    ]);
  };

  const patchLine = (idx: number, patch: Partial<Line>) =>
    setLines(ls => ls.map((l, i) => (i === idx ? { ...l, ...patch } : l)));

  const pickCustomer = (c: { id: number; name: string; hasGstin: boolean } | null) => {
    setCustomer(c);
    // Untouched lines follow the customer's GSTIN default, like the web POS.
    setLines(ls =>
      ls.map(l => (l.taxableTouched ? l : { ...l, taxable: c?.hasGstin ?? false })),
    );
  };

  const resetAll = () => {
    setStep(0);
    setCreated(null);
    setCustomer(null);
    setSaleDate(todayStr());
    setLines([]);
    setBillDiscount('');
    setPayMode('cash');
    setReceiveLedgerId(null);
    setAmountReceived('');
    setAmountTouched(false);
    setReference('');
    requestIdRef.current = newRequestId();
  };

  const buildPayload = (extra?: Partial<CreateSalePayload>): CreateSalePayload => {
    const loc = saleLoc!;
    const payNow = payMode !== 'credit' && receiveOptions.length > 0;
    return {
      locationType: loc.locationType,
      locationId: loc.locationType === 'headoffice' ? 1 : loc.locationId,
      outletId: loc.locationType === 'outlet' ? loc.locationId : 1,
      ...(customer ? { customerId: customer.id } : {}),
      saleDate,
      paymentMode: payMode === 'credit' ? 'credit' : 'cash',
      lineItems: lines.map(l => ({
        itemId: l.itemId,
        quantity: Number(l.quantity),
        unitPrice: Number(l.unitPrice),
        unitDiscount: Math.max(0, Number(l.unitDiscount || 0)),
        priceMode: l.taxable ? ('exclusive' as const) : ('inclusive' as const),
        taxAmount: 0 as const,
      })),
      billDiscount: totals.billDiscount,
      discountTotal: 0,
      otherCharges: [],
      ...(payNow
        ? {
            receivedInLedgerId: receiveLedgerId!,
            ...(amountReceived !== '' ? { amountReceived: Number(amountReceived) } : {}),
            ...(reference.trim() ? { referenceNumber: reference.trim() } : {}),
          }
        : {}),
      clientRequestId: requestIdRef.current,
      ...extra,
    };
  };

  const submit = (extra?: Partial<CreateSalePayload>) => {
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    setSubmitting(true);
    createSaleFull(buildPayload(extra))
      .then(sale => {
        // Books, stock and customer dues all moved — refetch everything sales.
        queryClient.invalidateQueries({
          predicate: q => {
            const k = String(q.queryKey[0] ?? '');
            return k.startsWith('/api/sales') || k.startsWith('/api/customers');
          },
        });
        setCreated(sale);
      })
      .catch((e: any) => {
        const code = e?.data?.code;
        const message = e?.data?.error || e?.message || 'The sale could not be recorded.';
        // Defer confirmed retries a tick: on web confirmDialog resolves
        // SYNCHRONOUSLY (window.confirm), so an immediate submit() would run
        // while submitLockRef is still held by THIS attempt and be silently
        // dropped. The macrotask runs after .finally() releases the lock.
        // The retry reuses the same clientRequestId, so it stays idempotent.
        if (code === 'CREDIT_LIMIT_EXCEEDED') {
          confirmDialog({
            title: 'Credit limit exceeded',
            message: `${message}\n\nRecord the sale anyway?`,
            confirmText: 'Record anyway',
            cancelText: 'Go back',
            onConfirm: () => setTimeout(() => submit({ ...extra, creditOverride: true }), 0),
          });
          return;
        }
        if (code === 'EXCEEDS_OUTSTANDING') {
          confirmDialog({
            title: 'Amount exceeds the bill',
            message: `${message}\n\nKeep the extra as the customer's advance?`,
            confirmText: 'Keep as advance',
            cancelText: 'Go back',
            onConfirm: () => setTimeout(() => submit({ ...extra, allowOverpayment: true }), 0),
          });
          return;
        }
        notify('Sale not recorded', message);
      })
      .finally(() => {
        submitLockRef.current = false;
        setSubmitting(false);
      });
  };

  const onPrimary = () => {
    const problem = stepValid();
    if (problem) {
      notify('Almost there', problem);
      return;
    }
    if (step < 3) {
      if (step === 2) {
        // Prefill the collection with the bill total when entering Payment.
        if (!amountTouched && amountReceived === '') {
          setAmountReceived(totals.grandTotal > 0 ? totals.grandTotal.toFixed(2) : '');
        }
      }
      setStep(step + 1);
      return;
    }
    // Overpayment pre-confirmation, mirroring the server's gate: a registered
    // customer may keep the excess as advance; a walk-in has nowhere to hold it.
    const payNow = payMode !== 'credit' && receiveOptions.length > 0;
    if (payNow && amountReceived !== '') {
      const excess = Number(amountReceived) - totals.grandTotal;
      if (excess > 0.004) {
        if (!customer) {
          notify(
            'Amount exceeds the bill',
            'A walk-in sale cannot hold extra money as advance. Collect the exact amount or pick a customer.',
          );
          return;
        }
        confirmDialog({
          title: 'Amount exceeds the bill',
          message: `You entered ${formatMoney(Number(amountReceived), { showPaise: true })} for a ${formatMoney(totals.grandTotal, { showPaise: true })} bill. Keep ${formatMoney(Math.round(excess * 100) / 100, { showPaise: true })} as ${customer.name}'s advance?`,
          confirmText: 'Keep as advance',
          cancelText: 'Go back',
          onConfirm: () => submit({ allowOverpayment: true }),
        });
        return;
      }
    }
    submit();
  };

  const confirmLeave = () => {
    if (created || (lines.length === 0 && !customer)) {
      router.back();
      return;
    }
    confirmDialog({
      title: 'Discard this sale?',
      message: 'Nothing has been recorded yet. The bill you started will be lost.',
      confirmText: 'Discard',
      cancelText: 'Keep billing',
      destructive: true,
      onConfirm: () => router.back(),
    });
  };

  // ── Permission gate (display only — the backend re-checks) ────────────────
  if (ready && !salesPerm.canAdd) {
    return (
      <FormScreen title="New Sale">
        <View style={styles.card}>
          <Text style={styles.mutedText}>
            Your role can view sales but not record new ones. Ask an administrator for access.
          </Text>
        </View>
      </FormScreen>
    );
  }

  // ── Success screen ─────────────────────────────────────────────────────────
  if (created) {
    return (
      <FormScreen title="Sale recorded" onBack={() => router.back()}>
        <View style={[styles.card, { alignItems: 'center', gap: 10, paddingVertical: 28 }]}>
          <View style={styles.successIcon}>
            <Feather name="check" size={30} color={colors.successForeground} />
          </View>
          <Text style={styles.successInvoice}>{created.invoiceNumber}</Text>
          <Text style={styles.successAmount}>
            {formatMoney(Number(created.totalAmount ?? 0), { showPaise: true })}
          </Text>
          <Text style={styles.mutedText}>
            {created.customerName || 'Walk-in customer'} · {formatDateLong(created.saleDate)}
          </Text>
          {Number(created.balanceDue ?? 0) > 0 ? (
            <Text style={[styles.mutedText, { color: colors.warning }]}>
              Balance due {formatMoney(Number(created.balanceDue), { showPaise: true })}
            </Text>
          ) : null}
          {created.idempotentReplay ? (
            <Text style={styles.mutedText}>This bill was already recorded — showing the original.</Text>
          ) : null}
        </View>

        <View style={{ gap: 10, marginTop: 16 }}>
          <Pressable
            onPress={() => router.replace(`/sale/${created.id}`)}
            style={({ pressed }) => [styles.bigBtn, { backgroundColor: colors.primary }, pressed && { opacity: 0.8 }]}
          >
            <Feather name="file-text" size={17} color={colors.primaryForeground} />
            <Text style={[styles.bigBtnText, { color: colors.primaryForeground }]}>
              View invoice · PDF & share
            </Text>
          </Pressable>
          <Pressable
            onPress={resetAll}
            style={({ pressed }) => [styles.bigBtn, styles.bigBtnOutline, pressed && { opacity: 0.8 }]}
          >
            <Feather name="plus" size={17} color={colors.primary} />
            <Text style={[styles.bigBtnText, { color: colors.primary }]}>New sale</Text>
          </Pressable>
        </View>
      </FormScreen>
    );
  }

  // ── Wizard ─────────────────────────────────────────────────────────────────
  const customerItems: PickerItem[] = ((customers as any[]) ?? []).map(c => ({
    key: String(c.id),
    label: String(c.name ?? `Customer #${c.id}`),
    sublabel: [c.phone, (c.gstNumber ?? c.gst_number) ? 'GSTIN' : null].filter(Boolean).join(' · ') || undefined,
  }));

  const itemPickerItems: PickerItem[] = ((items as any[]) ?? [])
    .filter(i => (i.status ?? 'active') === 'active')
    .map(i => ({
      key: String(i.id),
      label: String(i.name),
      sublabel:
        [i.itemCode || null, Number(i.mrp ?? 0) > 0 ? `MRP ${formatMoney(Number(i.mrp))}` : null, `GST ${Number(i.taxRate ?? 0)}%`]
          .filter(Boolean)
          .join(' · ') || undefined,
    }));

  const locationItems: PickerItem[] = [
    ...(((warehouses as any[]) ?? []).map(w => ({
      key: `warehouse:${w.id}`,
      label: String(w.name),
      sublabel: 'Warehouse',
    }))),
    ...(((outlets as any[]) ?? []).map(o => ({
      key: `outlet:${o.id}`,
      label: String(o.name),
      sublabel: 'Outlet',
    }))),
    { key: 'headoffice:1', label: 'Head Office', sublabel: 'Head Office' },
  ];

  const payNow = payMode !== 'credit' && receiveOptions.length > 0;
  const amountNum = amountReceived === '' ? null : Number(amountReceived);
  const isPartial =
    payNow && amountNum !== null && isMoneyString(amountReceived) && amountNum < totals.grandTotal - 0.004;
  const selectedAccount = receiveOptions.find(o => o.id === receiveLedgerId) ?? null;

  return (
    <FormScreen
      title="New Sale"
      subtitle={`Step ${step + 1} of 4 — ${STEPS[step]}`}
      onBack={confirmLeave}
      footer={
        <View style={styles.footerRow}>
          {step > 0 ? (
            <Pressable
              onPress={() => setStep(step - 1)}
              disabled={submitting}
              style={({ pressed }) => [styles.footerBtn, styles.bigBtnOutline, pressed && { opacity: 0.8 }]}
            >
              <Text style={[styles.bigBtnText, { color: colors.primary }]}>Back</Text>
            </Pressable>
          ) : null}
          <Pressable
            onPress={onPrimary}
            disabled={submitting}
            style={({ pressed }) => [
              styles.footerBtn,
              { backgroundColor: colors.primary, flex: 2 },
              (pressed || submitting) && { opacity: 0.8 },
            ]}
          >
            {submitting ? (
              <ActivityIndicator size="small" color={colors.primaryForeground} />
            ) : (
              <Text style={[styles.bigBtnText, { color: colors.primaryForeground }]}>
                {step < 3 ? 'Continue' : 'Record sale'}
              </Text>
            )}
          </Pressable>
        </View>
      }
    >
      {/* Progress dots */}
      <View style={styles.dots}>
        {STEPS.map((s, i) => (
          <View key={s} style={[styles.dot, i <= step && { backgroundColor: colors.primary }]} />
        ))}
      </View>

      {step === 0 ? (
        <View style={{ gap: 12 }}>
          <Text style={styles.fieldLabel}>Selling location</Text>
          {locked ? (
            <View style={styles.card}>
              <Text style={styles.valueText}>{saleLoc?.name ?? globalLoc.locationName}</Text>
              <Text style={styles.mutedText}>Sales are billed under your branch.</Text>
            </View>
          ) : (
            <Pressable onPress={() => setLocPickerOpen(true)} style={({ pressed }) => [styles.selectBox, pressed && { opacity: 0.8 }]}>
              <Text style={saleLoc ? styles.valueText : styles.placeholderText}>
                {saleLoc ? saleLoc.name : 'Pick warehouse / outlet'}
              </Text>
              <Feather name="chevron-down" size={18} color={colors.mutedForeground} />
            </Pressable>
          )}

          <Text style={styles.fieldLabel}>Customer</Text>
          <Pressable onPress={() => setCustomerPickerOpen(true)} style={({ pressed }) => [styles.selectBox, pressed && { opacity: 0.8 }]}>
            <Text style={customer ? styles.valueText : styles.placeholderText}>
              {customer ? customer.name : 'Walk-in customer'}
            </Text>
            <Feather name="chevron-down" size={18} color={colors.mutedForeground} />
          </Pressable>
          <Text style={styles.mutedText}>
            Credit and partial payments need a registered customer.
          </Text>

          <Text style={styles.fieldLabel}>Sale date</Text>
          <View style={styles.dateRow}>
            <Pressable onPress={() => setSaleDate(d => shiftDate(d, -1))} hitSlop={8} style={styles.dateArrow}>
              <Feather name="chevron-left" size={20} color={colors.foreground} />
            </Pressable>
            <View style={{ flex: 1, alignItems: 'center' }}>
              <Text style={styles.valueText}>{formatDateLong(saleDate)}</Text>
              {saleDate !== todayStr() ? (
                <Pressable onPress={() => setSaleDate(todayStr())} hitSlop={6}>
                  <Text style={[styles.mutedText, { color: colors.primary }]}>Back to today</Text>
                </Pressable>
              ) : null}
            </View>
            <Pressable
              onPress={() => setSaleDate(d => (d < todayStr() ? shiftDate(d, 1) : d))}
              hitSlop={8}
              style={[styles.dateArrow, saleDate >= todayStr() && { opacity: 0.3 }]}
            >
              <Feather name="chevron-right" size={20} color={colors.foreground} />
            </Pressable>
          </View>
        </View>
      ) : null}

      {step === 1 ? (
        <View style={{ gap: 12 }}>
          {lines.map((l, idx) => {
            const problem = lineProblems(l);
            const computed = totals.perLine[idx];
            const lineOk = !problem && !!computed;
            return (
              <View key={l.itemId} style={styles.card}>
                <View style={styles.rowBetween}>
                  <Text style={styles.lineName} numberOfLines={2}>{l.itemName}</Text>
                  <View style={{ flexDirection: 'row', gap: 14 }}>
                    {customer ? (
                      <Pressable onPress={() => setHistoryFor({ itemId: l.itemId, itemName: l.itemName })} hitSlop={8}>
                        <Feather name="clock" size={18} color={colors.primary} />
                      </Pressable>
                    ) : null}
                    <Pressable
                      onPress={() => setLines(ls => ls.filter((_, j) => j !== idx))}
                      hitSlop={8}
                    >
                      <Feather name="trash-2" size={18} color={colors.destructive} />
                    </Pressable>
                  </View>
                </View>
                <View style={styles.inputRow}>
                  <LabeledInput
                    label={`Qty${l.unit ? ` (${l.unit})` : ''}`}
                    value={l.quantity}
                    onChangeText={v => patchLine(idx, { quantity: v })}
                    styles={styles}
                  />
                  <LabeledInput
                    label="Rate ₹"
                    value={l.unitPrice}
                    onChangeText={v => patchLine(idx, { unitPrice: v })}
                    styles={styles}
                  />
                  <LabeledInput
                    label="Disc ₹/unit"
                    value={l.unitDiscount}
                    onChangeText={v => patchLine(idx, { unitDiscount: v })}
                    placeholder="0"
                    styles={styles}
                  />
                </View>
                <View style={styles.rowBetween}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Switch
                      value={l.taxable}
                      onValueChange={v => patchLine(idx, { taxable: v, taxableTouched: true })}
                      trackColor={{ true: colors.primary }}
                    />
                    <Text style={styles.mutedText}>
                      {l.taxable ? `+ GST ${l.taxRate}% on top` : `GST ${l.taxRate}% included`}
                    </Text>
                  </View>
                  {lineOk && computed ? (
                    <Text style={styles.lineTotal}>
                      {formatMoney(computed.lineGross, { showPaise: true })}
                    </Text>
                  ) : null}
                </View>
                {problem ? <Text style={styles.errorText}>{problem}</Text> : null}
              </View>
            );
          })}

          <Pressable
            onPress={() => setItemPickerOpen(true)}
            style={({ pressed }) => [styles.addItemBtn, pressed && { opacity: 0.8 }]}
          >
            <Feather name="plus" size={18} color={colors.primary} />
            <Text style={[styles.bigBtnText, { color: colors.primary }]}>Add item</Text>
          </Pressable>

          {lines.length > 0 ? (
            <Text style={[styles.mutedText, { textAlign: 'right' }]}>
              {lines.length} item{lines.length > 1 ? 's' : ''} · {formatMoney(totals.grandTotal, { showPaise: true })}
            </Text>
          ) : null}
        </View>
      ) : null}

      {step === 2 ? (
        <View style={{ gap: 12 }}>
          <View style={styles.card}>
            {lines.map((l, i) => (
              <View key={l.itemId} style={[styles.rowBetween, i > 0 && styles.summaryRowBorder]}>
                <Text style={styles.mutedText} numberOfLines={1}>
                  {l.itemName} × {l.quantity}
                </Text>
                <Text style={styles.valueText}>
                  {totals.perLine[i] ? formatMoney(totals.perLine[i].lineGross, { showPaise: true }) : '—'}
                </Text>
              </View>
            ))}
          </View>

          <Text style={styles.fieldLabel}>Bill discount (₹, before GST)</Text>
          <TextInput
            style={styles.input}
            value={billDiscount}
            onChangeText={setBillDiscount}
            placeholder="0"
            placeholderTextColor={colors.mutedForeground}
            keyboardType="decimal-pad"
          />

          <View style={styles.card}>
            <SummaryRow label="Items value" value={totals.grossItemValue} styles={styles} />
            {totals.itemDiscountTotal > 0 ? (
              <SummaryRow label="Item discounts" value={-totals.itemDiscountTotal} styles={styles} />
            ) : null}
            {totals.billDiscount > 0 ? (
              <SummaryRow label="Bill discount" value={-totals.billDiscount} styles={styles} />
            ) : null}
            <SummaryRow label="Taxable value" value={totals.subtotal} styles={styles} />
            <SummaryRow label="GST" value={totals.taxTotal} styles={styles} />
            <View style={styles.divider} />
            <SummaryRow label="Grand total" value={totals.grandTotal} bold styles={styles} />
          </View>
          <Text style={styles.mutedText}>
            GST split (CGST/SGST or IGST) is worked out on the invoice itself.
          </Text>
        </View>
      ) : null}

      {step === 3 ? (
        <View style={{ gap: 12 }}>
          <View style={[styles.card, { alignItems: 'center' }]}>
            <Text style={styles.mutedText}>To collect</Text>
            <Text style={styles.successAmount}>{formatMoney(totals.grandTotal, { showPaise: true })}</Text>
          </View>

          <Text style={styles.fieldLabel}>Payment</Text>
          <View style={styles.chips}>
            {(['cash', 'bank', 'upi', 'credit'] as PayMode[]).map(m => {
              const disabled =
                m === 'credit'
                  ? !customer
                  : receiveOptions.length > 0 && !receiveOptions.some(o => o.cls === m);
              return (
                <Pressable
                  key={m}
                  disabled={disabled}
                  onPress={() => {
                    setPayMode(m);
                    if (m !== 'credit') {
                      const opts = receiveOptions.filter(o => o.cls === m);
                      setReceiveLedgerId(opts.length >= 1 ? opts[0].id : null);
                    }
                  }}
                  style={[styles.chip, payMode === m && styles.chipActive, disabled && { opacity: 0.35 }]}
                >
                  <Text style={[styles.chipText, payMode === m && { color: colors.primary }]}>
                    {m === 'upi' ? 'UPI' : m[0].toUpperCase() + m.slice(1)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {!customer ? (
            <Text style={styles.mutedText}>Credit needs a registered customer.</Text>
          ) : null}

          {payMode === 'credit' ? (
            <View style={styles.card}>
              <Text style={styles.mutedText}>
                The full amount goes on {customer?.name}'s account as dues — nothing is collected now.
              </Text>
            </View>
          ) : accountsLoading ? (
            <View style={[styles.card, { alignItems: 'center', paddingVertical: 24 }]}>
              <ActivityIndicator color={colors.primary} />
              <Text style={styles.mutedText}>Loading this location's payment accounts…</Text>
            </View>
          ) : accountsFailed ? (
            <View style={styles.card}>
              <Text style={styles.errorText}>
                Could not load this location's payment accounts. Check your connection and go back a
                step, then try again.
              </Text>
            </View>
          ) : receiveOptions.length === 0 ? (
            <View style={styles.card}>
              <Text style={styles.mutedText}>
                This location has no Cash & Bank accounts assigned — the sale is recorded as fully
                paid in cash.
              </Text>
            </View>
          ) : (
            <View style={{ gap: 12 }}>
              <Text style={styles.fieldLabel}>Received into</Text>
              {modeOptions.length > 1 ? (
                <Pressable onPress={() => setAccountPickerOpen(true)} style={({ pressed }) => [styles.selectBox, pressed && { opacity: 0.8 }]}>
                  <Text style={selectedAccount ? styles.valueText : styles.placeholderText}>
                    {selectedAccount ? selectedAccount.name : 'Pick account'}
                  </Text>
                  <Feather name="chevron-down" size={18} color={colors.mutedForeground} />
                </Pressable>
              ) : (
                <View style={styles.selectBox}>
                  <Text style={selectedAccount ? styles.valueText : styles.placeholderText}>
                    {selectedAccount?.name ?? 'No account for this mode'}
                  </Text>
                </View>
              )}

              <Text style={styles.fieldLabel}>Amount received</Text>
              <TextInput
                style={styles.input}
                value={amountReceived}
                onChangeText={v => {
                  setAmountReceived(v);
                  setAmountTouched(true);
                }}
                placeholder={totals.grandTotal.toFixed(2)}
                placeholderTextColor={colors.mutedForeground}
                keyboardType="decimal-pad"
              />
              {isPartial ? (
                <Text style={[styles.mutedText, { color: colors.warning }]}>
                  Partial payment — {formatMoney(Math.round((totals.grandTotal - (amountNum ?? 0)) * 100) / 100, { showPaise: true })} stays as
                  {customer ? ` ${customer.name}'s dues.` : ' dues (needs a registered customer).'}
                </Text>
              ) : null}

              {payMode !== 'cash' ? (
                <>
                  <Text style={styles.fieldLabel}>Reference (optional)</Text>
                  <TextInput
                    style={styles.input}
                    value={reference}
                    onChangeText={setReference}
                    placeholder="UTR / transaction reference"
                    placeholderTextColor={colors.mutedForeground}
                    autoCapitalize="characters"
                  />
                </>
              ) : null}
            </View>
          )}
        </View>
      ) : null}

      {/* ── Pickers ── */}
      <SearchablePicker
        visible={locPickerOpen}
        onClose={() => setLocPickerOpen(false)}
        title="Selling location"
        items={locationItems}
        selectedKey={saleLoc ? `${saleLoc.locationType}:${saleLoc.locationId}` : null}
        onSelect={pi => {
          const [lt, id] = String(pi.key).split(':');
          setSaleLoc({
            locationType: lt as SaleLocation['locationType'],
            locationId: Number(id),
            name: pi.label,
          });
          setReceiveLedgerId(null);
          setLocPickerOpen(false);
        }}
      />
      <SearchablePicker
        visible={customerPickerOpen}
        onClose={() => setCustomerPickerOpen(false)}
        title="Customer"
        items={customerItems}
        loading={customersLoading}
        selectedKey={customer ? String(customer.id) : null}
        clearLabel="Walk-in customer (no account)"
        onClear={() => {
          pickCustomer(null);
          setCustomerPickerOpen(false);
        }}
        onSelect={pi => {
          const c = ((customers as any[]) ?? []).find(x => String(x.id) === pi.key);
          if (c) {
            pickCustomer({
              id: Number(c.id),
              name: String(c.name),
              hasGstin: !!String(c.gstNumber ?? c.gst_number ?? '').trim(),
            });
          }
          setCustomerPickerOpen(false);
        }}
      />
      <SearchablePicker
        visible={itemPickerOpen}
        onClose={() => setItemPickerOpen(false)}
        title="Add item"
        items={itemPickerItems}
        loading={itemsLoading}
        onSelect={pi => {
          addItem(pi);
          setItemPickerOpen(false);
        }}
      />
      <SearchablePicker
        visible={accountPickerOpen}
        onClose={() => setAccountPickerOpen(false)}
        title="Received into"
        items={modeOptions.map(o => ({ key: String(o.id), label: o.name, sublabel: o.code ?? undefined }))}
        selectedKey={receiveLedgerId ? String(receiveLedgerId) : null}
        onSelect={pi => {
          setReceiveLedgerId(Number(pi.key));
          setAccountPickerOpen(false);
        }}
      />
      <PriceHistorySheet
        visible={!!historyFor}
        onClose={() => setHistoryFor(null)}
        customerId={customer?.id ?? null}
        itemId={historyFor?.itemId ?? null}
        itemName={historyFor?.itemName ?? ''}
      />
    </FormScreen>
  );
}

function LabeledInput({
  label, value, onChangeText, placeholder, styles,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  styles: any;
}) {
  return (
    <View style={{ flex: 1, gap: 4 }}>
      <Text style={styles.inputLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#8896b3"
        keyboardType="decimal-pad"
      />
    </View>
  );
}

function SummaryRow({
  label, value, bold, styles,
}: { label: string; value: number; bold?: boolean; styles: any }) {
  return (
    <View style={styles.rowBetween}>
      <Text style={[styles.mutedText, bold && styles.boldLabel]}>{label}</Text>
      <Text style={bold ? styles.boldValue : styles.valueText}>
        {formatMoney(Math.round(value * 100) / 100, { showPaise: true })}
      </Text>
    </View>
  );
}

const makeStyles = (colors: ReturnType<typeof useColors>) =>
  StyleSheet.create({
    card: {
      backgroundColor: colors.card,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 14,
      gap: 8,
    },
    dots: { flexDirection: 'row', gap: 6, marginBottom: 16, justifyContent: 'center' },
    dot: { width: 26, height: 4, borderRadius: 2, backgroundColor: colors.border },
    fieldLabel: { fontSize: 13, fontFamily: 'Outfit_600SemiBold', color: colors.foreground },
    selectBox: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 13,
      gap: 8,
    },
    valueText: { fontSize: 14, fontFamily: 'Outfit_500Medium', color: colors.foreground, flexShrink: 1 },
    placeholderText: { fontSize: 14, fontFamily: 'Outfit_400Regular', color: colors.mutedForeground },
    mutedText: { fontSize: 13, fontFamily: 'Outfit_400Regular', color: colors.mutedForeground },
    errorText: { fontSize: 12, fontFamily: 'Outfit_500Medium', color: colors.destructive },
    dateRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      paddingVertical: 10,
      paddingHorizontal: 6,
      gap: 6,
    },
    dateArrow: { padding: 6 },
    rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
    lineName: { flex: 1, fontSize: 15, fontFamily: 'Outfit_600SemiBold', color: colors.foreground },
    lineTotal: { fontSize: 15, fontFamily: 'Outfit_700Bold', color: colors.foreground },
    inputRow: { flexDirection: 'row', gap: 10 },
    inputLabel: { fontSize: 11, fontFamily: 'Outfit_500Medium', color: colors.mutedForeground },
    input: {
      backgroundColor: colors.background,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 14,
      fontFamily: 'Outfit_500Medium',
      color: colors.foreground,
    },
    addItemBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      borderWidth: 1,
      borderColor: colors.primary,
      borderStyle: 'dashed',
      borderRadius: 12,
      paddingVertical: 14,
    },
    summaryRowBorder: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
      paddingTop: 8,
      marginTop: 2,
    },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: 4 },
    boldLabel: { fontFamily: 'Outfit_600SemiBold', color: colors.foreground },
    boldValue: { fontSize: 16, fontFamily: 'Outfit_700Bold', color: colors.foreground },
    chips: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
    chip: {
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 16,
      paddingVertical: 8,
      backgroundColor: colors.card,
    },
    chipActive: { borderColor: colors.primary, backgroundColor: colors.primary + '22' },
    chipText: { fontSize: 13, fontFamily: 'Outfit_600SemiBold', color: colors.mutedForeground },
    footerRow: { flexDirection: 'row', gap: 10 },
    footerBtn: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 12,
      paddingVertical: 14,
    },
    bigBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      borderRadius: 12,
      paddingVertical: 14,
    },
    bigBtnOutline: { borderWidth: 1, borderColor: colors.primary },
    bigBtnText: { fontSize: 14, fontFamily: 'Outfit_600SemiBold' },
    successIcon: {
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: colors.success,
      alignItems: 'center',
      justifyContent: 'center',
    },
    successInvoice: { fontSize: 20, fontFamily: 'Outfit_700Bold', color: colors.foreground },
    successAmount: { fontSize: 26, fontFamily: 'Outfit_700Bold', color: colors.foreground },
  });
