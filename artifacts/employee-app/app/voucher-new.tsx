import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import {
  useCashBankLedgersFlat,
  useCreatePayment,
  useCreateReceipt,
  useListAccountsFlat,
  useVoucherEmployees,
  useVoucherLocations,
  type AccountFlat,
  type VoucherLocationOption,
} from '@workspace/api-client-react';
import { FormScreen } from '@/components/ui/FormScreen';
import { SearchablePicker, type PickerItem } from '@/components/ui/SearchablePicker';
import { formatMoney } from '@/components/ui/MoneyText';
import { notify } from '@/lib/dialogs';
import { isMoneyString } from '@/lib/saleMath';
import { localYmd, shiftYmd } from '@/lib/localDate';
import { openMoneyVoucherPdf, type MoneyVoucherKind } from '@/lib/voucherPdf';
import { PAGE, useErpPermissions } from '@/hooks/useErpPermissions';
import { useLocationContext } from '@/contexts/LocationContext';
import { useColors } from '@/hooks/useColors';

/**
 * New Receipt / Payment voucher — one form for both kinds (?kind=receipt|payment).
 *
 * The client mirrors the web MoneyVoucherPage's picker rules (party-type code
 * prefixes, foreign-ledger hiding, employee eligibility) purely as UX — the
 * SERVER stays authoritative: it infers the party from the ledger, resolves
 * the voucher's location from the chosen cash/bank ledger, enforces month
 * locks and employee-ledger rules, and its exact error text is surfaced
 * as-is. No silent retries; a sync submit lock prevents double-taps.
 */

const CONFIG = {
  receipt: {
    title: 'New Receipt Voucher',
    subtitle: 'Money received',
    permKey: PAGE.receiptVoucher,
    partyLabel: 'Received from',
    cashLabel: 'Received into',
    dateField: 'receiptDate',
    cashField: 'receivedInLedgerId',
    partyField: 'receivedFromLedgerId',
    submitLabel: 'Save Receipt',
  },
  payment: {
    title: 'New Payment Voucher',
    subtitle: 'Money paid out',
    permKey: PAGE.paymentVoucher,
    partyLabel: 'Paid to',
    cashLabel: 'Paid from',
    dateField: 'paymentDate',
    cashField: 'paidFromLedgerId',
    partyField: 'paidToLedgerId',
    submitLabel: 'Save Payment',
  },
} as const;

// Party pickers filter the chart by ledger-code prefix — the prefixes the
// server stamps when it auto-provisions party ledgers (mirrors the web page).
const PARTY_TYPES = [
  { value: 'customer', label: 'Customer', match: (c: string) => c.startsWith('CUST-') },
  { value: 'vendor', label: 'Vendor', match: (c: string) => c.startsWith('VEND-') },
  // Exactly two ledgers per employee: Salary Expense (SAL-EMP-) and Salary
  // Payable (SAL-PAY-). Advance ledgers (ADV-EMP-) are payroll-owned and
  // never offered — the server refuses them too.
  { value: 'employee', label: 'Employee', match: (c: string) => c.startsWith('SAL-EMP-') || c.startsWith('SAL-PAY-') },
  { value: 'ledger', label: 'Other Ledger', match: (_c: string) => true },
] as const;
type PartyType = (typeof PARTY_TYPES)[number]['value'];

/** Module-owned ledgers that must never appear in MANUAL voucher pickers
 * (mirror of the web's systemLedgers.ts — payroll, GST, transfers, SYS-). */
function isSystemLedger(code?: string | null): boolean {
  if (!code) return false;
  const c = code.toUpperCase();
  return (
    c.startsWith('SYS-') ||
    c.startsWith('SAL-EMP-') ||
    c.startsWith('SAL-PAY-') ||
    c.startsWith('ADV-EMP-') ||
    c.startsWith('GST-') ||
    c.startsWith('STD-BRANCH-')
  );
}

/** The flat chart rows carry isGroup, which the shared type under-declares. */
type FlatAccount = AccountFlat & { isGroup?: boolean };

const todayStr = () => localYmd();

function formatDateLong(d: string): string {
  const dt = new Date(`${d}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
}

const locKeyOf = (l: { locationType: string; locationId: number }) =>
  `${l.locationType}:${l.locationId}`;

export default function NewVoucherScreen() {
  const params = useLocalSearchParams<{ kind?: string }>();
  const kind: MoneyVoucherKind = params.kind === 'payment' ? 'payment' : 'receipt';
  const C = CONFIG[kind];
  const isReceipt = kind === 'receipt';

  const colors = useColors();
  const { ready, perm } = useErpPermissions();
  const rights = perm(C.permKey);
  const { location: globalLoc } = useLocationContext();

  // `kind` is fixed for a mounted route, so exactly one create mutation runs
  // per mount — same pattern as the web page.
  const createM = (isReceipt ? useCreateReceipt : useCreatePayment)();

  const { data: voucherLocs } = useVoucherLocations();
  const { data: allAccounts = [] } = useListAccountsFlat();
  const { data: cashBankAccounts = [] } = useCashBankLedgersFlat();
  const { data: voucherEmployees = [] } = useVoucherEmployees();

  // ── Form state ─────────────────────────────────────────────────────────────
  const [locKey, setLocKey] = useState('');
  const [date, setDate] = useState(todayStr());
  const [partyType, setPartyType] = useState<PartyType>('customer');
  const [partyId, setPartyId] = useState(0);
  const [cashId, setCashId] = useState(0);
  const [amountStr, setAmountStr] = useState('');
  const [reference, setReference] = useState('');
  const [narration, setNarration] = useState('');
  const [saved, setSaved] = useState<{ id: number; voucherNumber: string; amount: number; party: string } | null>(null);
  const [locPickerOpen, setLocPickerOpen] = useState(false);
  const [partyPickerOpen, setPartyPickerOpen] = useState(false);
  const [cashPickerOpen, setCashPickerOpen] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const submitLockRef = useRef(false);

  const locations: VoucherLocationOption[] = voucherLocs?.locations ?? [];

  // Default location: the global "working as" selection when it's one of the
  // offered posting locations, else the first offered (branch users have
  // exactly their own). "All Locations" is a view, never a posting location.
  useEffect(() => {
    if (locKey || !locations.length) return;
    if (globalLoc.locationType !== 'all') {
      const gid = globalLoc.locationType === 'headoffice' ? 0 : Number(globalLoc.locationId ?? 0);
      const hit = locations.find(l => l.locationType === globalLoc.locationType && Number(l.locationId) === gid);
      if (hit) { setLocKey(locKeyOf(hit)); return; }
    }
    setLocKey(locKeyOf(locations[0]));
  }, [locKey, locations, globalLoc]);

  const selLoc = locations.find(l => locKeyOf(l) === locKey);

  // Accounts owned by a DIFFERENT location are hidden, plus Head Office's own
  // cash/bank when a branch is selected (mirror of useVoucherLocationChoice;
  // a mirror location's shared till is owned by both identities and stays).
  const foreignLedgerIds = useMemo(() => {
    const set = new Set<number>();
    if (!voucherLocs || !selLoc) return set;
    for (const o of voucherLocs.ownedLedgers) {
      if (!(o.locationType === selLoc.locationType && o.locationId === selLoc.locationId)) set.add(o.ledgerId);
    }
    for (const o of voucherLocs.ownedLedgers) {
      if (o.locationType === selLoc.locationType && o.locationId === selLoc.locationId) set.delete(o.ledgerId);
    }
    if (selLoc.locationType !== 'headoffice') {
      for (const id of voucherLocs.headOfficeCashBankLedgerIds) set.add(id);
    }
    return set;
  }, [voucherLocs, selLoc]);

  // Employee party type narrows to ACTIVE employees of the selected location
  // (Head-Office-stamped employees are company-wide — matches the server).
  const eligibleEmployeeIds = useMemo(() => {
    const ids = new Set<number>();
    for (const e of voucherEmployees) {
      if (!e.isActive) continue;
      const empType = e.branchType ?? 'headoffice';
      if (selLoc && selLoc.locationType !== 'headoffice' && (empType === 'warehouse' || empType === 'outlet')) {
        if (empType !== selLoc.locationType || Number(e.branchId) !== Number(selLoc.locationId)) continue;
      }
      ids.add(Number(e.id));
    }
    return ids;
  }, [voucherEmployees, selLoc]);

  const partyTypeDef = PARTY_TYPES.find(t => t.value === partyType) ?? PARTY_TYPES[3];

  const partyOptions = useMemo(
    () => (allAccounts as FlatAccount[]).filter(a => {
      if (a.isSystemGroup || a.isGroup || !partyTypeDef.match(a.code ?? '') || foreignLedgerIds.has(a.id)) return false;
      if (partyTypeDef.value === 'employee') {
        const m = /^(?:SAL-EMP|SAL-PAY)-(\d+)$/.exec(a.code ?? '');
        return !!m && eligibleEmployeeIds.has(Number(m[1]));
      }
      return !isSystemLedger(a.code);
    }),
    [allAccounts, partyTypeDef, foreignLedgerIds, eligibleEmployeeIds],
  );

  // Till picker — only the selected location's own cash/bank/UPI accounts.
  const tillOptions = useMemo(
    () => (cashBankAccounts as FlatAccount[]).filter(a => !selLoc || selLoc.cashBankLedgerIds.includes(a.id)),
    [cashBankAccounts, selLoc],
  );

  // A single offered till (branch users) preselects itself.
  useEffect(() => {
    if (!cashId && tillOptions.length === 1) setCashId(Number(tillOptions[0].id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tillOptions.length]);

  // Switching location narrows the pickers — clear selections that just
  // became foreign so a hidden value can't ride along into the submit.
  useEffect(() => {
    if (cashId && !tillOptions.some(a => Number(a.id) === cashId)) setCashId(0);
    if (partyId && !partyOptions.some(a => Number(a.id) === partyId)) setPartyId(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locKey, tillOptions, partyOptions]);

  const partyName = (id: number) => partyOptions.find(a => Number(a.id) === id)?.name
    ?? (allAccounts as FlatAccount[]).find(a => Number(a.id) === id)?.name ?? '';
  const tillName = (id: number) => tillOptions.find(a => Number(a.id) === id)?.name ?? '';

  const locItems: PickerItem[] = locations.map(l => ({
    key: locKeyOf(l),
    label: l.name,
    sublabel: l.locationType === 'headoffice' ? 'Head Office' : l.locationType === 'warehouse' ? 'Warehouse' : 'Outlet',
  }));
  const partyItems: PickerItem[] = partyOptions.map(a => ({
    key: String(a.id),
    label: a.name,
    sublabel: a.code ?? undefined,
  }));
  const tillItems: PickerItem[] = tillOptions.map(a => ({
    key: String(a.id),
    label: a.name,
    sublabel: a.accountType ? a.accountType.toUpperCase() : a.code ?? undefined,
  }));

  // ── Submit ─────────────────────────────────────────────────────────────────
  const validationProblem = (): string | null => {
    if (!selLoc) return 'Choose a location first.';
    if (!cashId) return `Choose the "${C.cashLabel}" account.`;
    if (!partyId) return `Choose the "${C.partyLabel}" account.`;
    if (!isMoneyString(amountStr) || Number(amountStr) <= 0) {
      return 'Enter an amount greater than 0, with at most 2 decimals.';
    }
    return null;
  };

  const submit = async () => {
    // Sync lock: isPending flips a render later — a fast double-tap would
    // POST twice and create two vouchers (mobile-billing lesson).
    if (submitLockRef.current) return;
    const problem = validationProblem();
    if (problem) { notify('Almost there', problem); return; }
    submitLockRef.current = true;
    try {
      const body = {
        [C.dateField]: date,
        [C.cashField]: cashId,
        [C.partyField]: partyId,
        amount: Number(amountStr),
        referenceNumber: reference.trim(),
        narration: narration.trim(),
        // The FORM-chosen posting location (never the session's view
        // selection) — the server validates it against the chosen ledgers.
        locationType: selLoc!.locationType,
        locationId: selLoc!.locationId,
      };
      // locationType/locationId are accepted by the server but absent from
      // the shared Receipt/Payment types (same shape the web page posts).
      const created = await createM.mutateAsync(body as never) as { id: number; voucherNumber?: string };
      setSaved({
        id: Number(created.id),
        voucherNumber: created.voucherNumber || `#${created.id}`,
        amount: Number(amountStr),
        party: partyName(partyId),
      });
    } catch (e: unknown) {
      // Month locks (423), ledger rules, employee restrictions — the server's
      // exact reason, surfaced once. Never retried silently.
      const err = e as { data?: { error?: string }; message?: string };
      notify('Voucher not saved', err?.data?.error || err?.message || 'Please try again.');
    } finally {
      submitLockRef.current = false;
    }
  };

  const openPdf = async () => {
    if (!saved || pdfBusy) return;
    setPdfBusy(true);
    try {
      await openMoneyVoucherPdf(kind, saved.id, saved.voucherNumber);
    } catch (e: unknown) {
      const err = e as { data?: { error?: string }; message?: string };
      notify('Could not open PDF', err?.data?.error || err?.message || 'Please try again.');
    } finally {
      setPdfBusy(false);
    }
  };

  const resetForAnother = () => {
    setSaved(null);
    setPartyId(0);
    setAmountStr('');
    setReference('');
    setNarration('');
    setDate(todayStr());
    // Location, party type and till survive — the common case is a clerk
    // recording several vouchers against the same till in one sitting.
  };

  const styles = makeStyles(colors);

  if (!ready) {
    return (
      <FormScreen title={C.title} subtitle={C.subtitle}>
        <View style={styles.centerBox}><ActivityIndicator color={colors.primary} /></View>
      </FormScreen>
    );
  }

  if (!rights.canAdd) {
    return (
      <FormScreen title={C.title} subtitle={C.subtitle}>
        <View style={styles.centerBox}>
          <Feather name="lock" size={28} color={colors.mutedForeground} />
          <Text style={styles.centerText}>You don't have permission to record vouchers.</Text>
        </View>
      </FormScreen>
    );
  }

  // ── Success screen ─────────────────────────────────────────────────────────
  if (saved) {
    return (
      <FormScreen title={C.title} subtitle={C.subtitle} onBack={() => router.back()}>
        <View style={styles.successBox}>
          <View style={[styles.successIcon, { backgroundColor: colors.success + '18' }]}>
            <Feather name="check" size={30} color={colors.success} />
          </View>
          <Text style={styles.successTitle}>{isReceipt ? 'Receipt recorded' : 'Payment recorded'}</Text>
          <Text style={styles.successVoucher}>{saved.voucherNumber}</Text>
          <Text style={styles.successMeta}>
            {formatMoney(saved.amount)}{saved.party ? ` · ${saved.party}` : ''}
          </Text>

          <View style={{ gap: 10, width: '100%', marginTop: 24 }}>
            {rights.canDownload ? (
              <Pressable
                onPress={openPdf}
                disabled={pdfBusy}
                style={({ pressed }) => [styles.secondaryBtn, pressed && { opacity: 0.8 }]}
              >
                {pdfBusy ? (
                  <ActivityIndicator size="small" color={colors.primary} />
                ) : (
                  <>
                    <Feather name="file-text" size={16} color={colors.primary} />
                    <Text style={styles.secondaryBtnText}>Voucher PDF</Text>
                  </>
                )}
              </Pressable>
            ) : null}
            <Pressable
              onPress={resetForAnother}
              style={({ pressed }) => [styles.secondaryBtn, pressed && { opacity: 0.8 }]}
            >
              <Feather name="plus" size={16} color={colors.primary} />
              <Text style={styles.secondaryBtnText}>Record another</Text>
            </Pressable>
            <Pressable
              onPress={() => router.back()}
              style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.85 }]}
            >
              <Text style={styles.primaryBtnText}>Done</Text>
            </Pressable>
          </View>
        </View>
      </FormScreen>
    );
  }

  // ── Form ───────────────────────────────────────────────────────────────────
  const busy = createM.isPending;

  return (
    <FormScreen
      title={C.title}
      subtitle={C.subtitle}
      footer={
        <Pressable
          onPress={submit}
          disabled={busy}
          style={({ pressed }) => [styles.primaryBtn, (pressed || busy) && { opacity: 0.7 }]}
        >
          {busy ? (
            <ActivityIndicator size="small" color={colors.primaryForeground} />
          ) : (
            <Text style={styles.primaryBtnText}>{C.submitLabel}</Text>
          )}
        </Pressable>
      }
    >
      {/* Location — the chosen location OWNS the voucher's accounting. */}
      <Text style={styles.label}>Location</Text>
      {locations.length > 1 ? (
        <Pressable style={styles.selectBox} onPress={() => setLocPickerOpen(true)}>
          <Text style={selLoc ? styles.selectValue : styles.selectPlaceholder}>
            {selLoc?.name ?? 'Choose location…'}
          </Text>
          <Feather name="chevron-down" size={18} color={colors.mutedForeground} />
        </Pressable>
      ) : (
        <View style={styles.selectBox}>
          <Text style={styles.selectValue}>{selLoc?.name ?? '…'}</Text>
          <Feather name="lock" size={14} color={colors.mutedForeground} />
        </View>
      )}

      {/* Date — server enforces month locks; future dates make no sense. */}
      <Text style={styles.label}>Date</Text>
      <View style={styles.dateRow}>
        <Pressable onPress={() => setDate(d => shiftYmd(d, -1))} hitSlop={8} style={styles.dateArrow}>
          <Feather name="chevron-left" size={20} color={colors.foreground} />
        </Pressable>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text style={styles.selectValue}>{formatDateLong(date)}</Text>
          {date !== todayStr() ? (
            <Pressable onPress={() => setDate(todayStr())} hitSlop={6}>
              <Text style={[styles.mutedText, { color: colors.primary }]}>Back to today</Text>
            </Pressable>
          ) : null}
        </View>
        <Pressable
          onPress={() => setDate(d => (d < todayStr() ? shiftYmd(d, 1) : d))}
          hitSlop={8}
          style={[styles.dateArrow, date >= todayStr() && { opacity: 0.3 }]}
        >
          <Feather name="chevron-right" size={20} color={colors.foreground} />
        </Pressable>
      </View>

      {/* Party type + party ledger */}
      <Text style={styles.label}>{C.partyLabel}</Text>
      <View style={styles.chipRow}>
        {PARTY_TYPES.map(t => {
          const active = t.value === partyType;
          return (
            <Pressable
              key={t.value}
              onPress={() => { setPartyType(t.value); setPartyId(0); }}
              style={[styles.chip, active && styles.chipActive]}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>{t.label}</Text>
            </Pressable>
          );
        })}
      </View>
      <Pressable style={styles.selectBox} onPress={() => setPartyPickerOpen(true)}>
        <Text style={partyId ? styles.selectValue : styles.selectPlaceholder} numberOfLines={1}>
          {partyId ? partyName(partyId) : `Choose ${partyTypeDef.label.toLowerCase()}…`}
        </Text>
        <Feather name="chevron-down" size={18} color={colors.mutedForeground} />
      </Pressable>

      {/* Cash / bank account */}
      <Text style={styles.label}>{C.cashLabel}</Text>
      {tillOptions.length === 0 ? (
        <View style={[styles.selectBox, { borderColor: colors.warning }]}>
          <Text style={[styles.mutedText, { flex: 1 }]}>
            No cash or bank account is set up for this location yet — ask Head Office.
          </Text>
        </View>
      ) : (
        <Pressable style={styles.selectBox} onPress={() => setCashPickerOpen(true)}>
          <Text style={cashId ? styles.selectValue : styles.selectPlaceholder} numberOfLines={1}>
            {cashId ? tillName(cashId) : 'Choose account…'}
          </Text>
          <Feather name="chevron-down" size={18} color={colors.mutedForeground} />
        </Pressable>
      )}

      {/* Amount */}
      <Text style={styles.label}>Amount (₹)</Text>
      <TextInput
        style={[
          styles.input,
          amountStr.length > 0 && !(isMoneyString(amountStr) && Number(amountStr) > 0) && { borderColor: colors.destructive },
        ]}
        value={amountStr}
        onChangeText={setAmountStr}
        keyboardType="decimal-pad"
        placeholder="0.00"
        placeholderTextColor={colors.mutedForeground}
      />

      {/* Reference + narration */}
      <Text style={styles.label}>Reference (optional)</Text>
      <TextInput
        style={styles.input}
        value={reference}
        onChangeText={setReference}
        maxLength={100}
        placeholder="Cheque / UTR / Txn no."
        placeholderTextColor={colors.mutedForeground}
        autoCapitalize="characters"
        autoCorrect={false}
      />
      <Text style={styles.label}>Narration (optional)</Text>
      <TextInput
        style={[styles.input, styles.multiline]}
        value={narration}
        onChangeText={setNarration}
        multiline
        numberOfLines={3}
        placeholder="What is this voucher for?"
        placeholderTextColor={colors.mutedForeground}
      />
      <View style={{ height: 12 }} />

      <SearchablePicker
        visible={locPickerOpen}
        onClose={() => setLocPickerOpen(false)}
        title="Location"
        items={locItems}
        selectedKey={locKey || null}
        onSelect={i => setLocKey(i.key)}
      />
      <SearchablePicker
        visible={partyPickerOpen}
        onClose={() => setPartyPickerOpen(false)}
        title={C.partyLabel}
        items={partyItems}
        selectedKey={partyId ? String(partyId) : null}
        onSelect={i => setPartyId(Number(i.key))}
        emptyText={
          partyType === 'employee'
            ? 'No eligible employees for this location.'
            : 'No matching accounts.'
        }
      />
      <SearchablePicker
        visible={cashPickerOpen}
        onClose={() => setCashPickerOpen(false)}
        title={C.cashLabel}
        items={tillItems}
        selectedKey={cashId ? String(cashId) : null}
        onSelect={i => setCashId(Number(i.key))}
        emptyText="No cash or bank accounts for this location."
      />
    </FormScreen>
  );
}

function makeStyles(colors: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    centerBox: { alignItems: 'center', paddingVertical: 48, gap: 10 },
    centerText: {
      fontSize: 14,
      color: colors.mutedForeground,
      fontFamily: 'Outfit_400Regular',
      textAlign: 'center',
    },
    label: {
      fontSize: 13,
      color: colors.mutedForeground,
      fontFamily: 'Outfit_500Medium',
      marginTop: 16,
      marginBottom: 6,
    },
    selectBox: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.card,
      borderRadius: 10,
      paddingHorizontal: 14,
      minHeight: 48,
      paddingVertical: 12,
    },
    selectValue: { fontSize: 15, color: colors.foreground, fontFamily: 'Outfit_500Medium', flexShrink: 1 },
    selectPlaceholder: { fontSize: 15, color: colors.mutedForeground, fontFamily: 'Outfit_400Regular' },
    mutedText: { fontSize: 12, color: colors.mutedForeground, fontFamily: 'Outfit_400Regular' },
    dateRow: {
      flexDirection: 'row',
      alignItems: 'center',
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.card,
      borderRadius: 10,
      paddingVertical: 10,
      paddingHorizontal: 6,
    },
    dateArrow: { padding: 6 },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
    chip: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 999,
      paddingHorizontal: 14,
      paddingVertical: 7,
      backgroundColor: colors.card,
    },
    chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
    chipText: { fontSize: 13, color: colors.foreground, fontFamily: 'Outfit_500Medium' },
    chipTextActive: { color: colors.primaryForeground },
    input: {
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.card,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 15,
      color: colors.foreground,
      fontFamily: 'Outfit_400Regular',
    },
    multiline: { minHeight: 84, textAlignVertical: 'top' },
    primaryBtn: {
      backgroundColor: colors.primary,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 15,
      flexDirection: 'row',
      gap: 8,
    },
    primaryBtnText: { color: colors.primaryForeground, fontSize: 16, fontFamily: 'Outfit_600SemiBold' },
    secondaryBtn: {
      borderWidth: 1,
      borderColor: colors.primary + '50',
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 14,
      flexDirection: 'row',
      gap: 8,
    },
    secondaryBtnText: { color: colors.primary, fontSize: 15, fontFamily: 'Outfit_600SemiBold' },
    successBox: { alignItems: 'center', paddingTop: 40, paddingHorizontal: 8 },
    successIcon: {
      width: 64,
      height: 64,
      borderRadius: 32,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 16,
    },
    successTitle: { fontSize: 18, color: colors.foreground, fontFamily: 'Outfit_600SemiBold' },
    successVoucher: {
      fontSize: 22,
      color: colors.primary,
      fontFamily: 'Outfit_700Bold',
      marginTop: 6,
    },
    successMeta: {
      fontSize: 14,
      color: colors.mutedForeground,
      fontFamily: 'Outfit_400Regular',
      marginTop: 4,
    },
  });
}
