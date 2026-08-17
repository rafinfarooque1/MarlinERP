import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import {
  useListPayments,
  useListReceipts,
  useVoucherLocations,
  type Payment,
  type Receipt,
} from '@workspace/api-client-react';
import { FormScreen } from '@/components/ui/FormScreen';
import { formatMoney } from '@/components/ui/MoneyText';
import { notify } from '@/lib/dialogs';
import { openMoneyVoucherPdf, type MoneyVoucherKind } from '@/lib/voucherPdf';
import { PAGE, useErpPermissions } from '@/hooks/useErpPermissions';
import { useColors } from '@/hooks/useColors';

/**
 * Shared Receipt / Payment voucher register — read + PDF only. Editing and
 * deleting stay web-only (admin-gated); mobile records new vouchers via
 * /voucher-new. Lists come back whole from the server (LBAC + the global
 * location view already applied), so search and paging are client-side.
 */

const PAGE_SIZE = 50;

const CONFIG = {
  receipt: {
    title: 'Receipt Vouchers',
    subtitle: 'Money received',
    permKey: PAGE.receiptVoucher,
    partyPrefix: 'From',
    accountPrefix: 'Into',
    emptyText: 'No receipt vouchers yet.',
  },
  payment: {
    title: 'Payment Vouchers',
    subtitle: 'Money paid out',
    permKey: PAGE.paymentVoucher,
    partyPrefix: 'To',
    accountPrefix: 'Paid from',
    emptyText: 'No payment vouchers yet.',
  },
} as const;

/** One shape for both kinds so the card renders identically. */
interface Row {
  id: number;
  voucherNumber: string;
  date: string;
  party: string;
  account: string;
  amount: number;
  narration: string;
  reference: string;
  origin: 'manual' | 'system';
  locationType?: string | null;
  locationId?: number | null;
}

function normalize(kind: MoneyVoucherKind, raw: (Receipt | Payment)[]): Row[] {
  return raw.map((r: any) => ({
    id: Number(r.id),
    voucherNumber: r.voucherNumber || r.legacyVoucherNumber || `#${r.id}`,
    date: String(kind === 'receipt' ? r.receiptDate : r.paymentDate ?? '').split('T')[0],
    party: (kind === 'receipt' ? r.receivedFromName : r.paidToName) || '—',
    account: (kind === 'receipt' ? r.receivedInName : r.paidFromName) || '—',
    amount: Number(r.amount) || 0,
    narration: r.narration ?? '',
    reference: r.referenceNumber ?? '',
    origin: r.origin === 'system' ? 'system' : 'manual',
    locationType: r.locationType,
    locationId: r.locationId,
  }));
}

function formatDate(d: string): string {
  const dt = new Date(`${d}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return d || '—';
  return dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function VoucherListScreen({ kind }: { kind: MoneyVoucherKind }) {
  const C = CONFIG[kind];
  const colors = useColors();
  const { ready, perm } = useErpPermissions();
  const rights = perm(C.permKey);

  // `kind` is fixed for a mounted route (two separate screens), so exactly
  // one list hook runs per mount — same pattern as the web page.
  const listQ = (kind === 'receipt' ? useListReceipts : useListPayments)();
  const { data: voucherLocs } = useVoucherLocations();

  const [search, setSearch] = useState('');
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [pdfBusyId, setPdfBusyId] = useState<number | null>(null);

  const rows = useMemo(
    () => normalize(kind, (listQ.data as (Receipt | Payment)[] | undefined) ?? []),
    [kind, listQ.data],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r =>
      r.voucherNumber.toLowerCase().includes(q) ||
      r.party.toLowerCase().includes(q) ||
      r.account.toLowerCase().includes(q) ||
      r.reference.toLowerCase().includes(q) ||
      r.narration.toLowerCase().includes(q) ||
      r.date.includes(q),
    );
  }, [rows, search]);

  const shown = filtered.slice(0, visible);

  // Location tag only helps callers who can see more than one location.
  const showLocation = (voucherLocs?.locations.length ?? 0) > 1;
  const locationName = (r: Row): string => {
    if (!r.locationType) return '';
    if (r.locationType === 'headoffice') return 'Head Office';
    const hit = voucherLocs?.locations.find(
      l => l.locationType === r.locationType && Number(l.locationId) === Number(r.locationId),
    );
    return hit?.name ?? '';
  };

  const openPdf = async (r: Row) => {
    if (pdfBusyId !== null) return;
    setPdfBusyId(r.id);
    try {
      await openMoneyVoucherPdf(kind, r.id, r.voucherNumber);
    } catch (e: any) {
      notify('Could not open PDF', e?.data?.error || e?.message || 'Please try again.');
    } finally {
      setPdfBusyId(null);
    }
  };

  const styles = makeStyles(colors);

  if (!ready || (listQ.isLoading && rights.canView)) {
    return (
      <FormScreen title={C.title} subtitle={C.subtitle}>
        <View style={styles.centerBox}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </FormScreen>
    );
  }

  if (!rights.canView) {
    return (
      <FormScreen title={C.title} subtitle={C.subtitle}>
        <View style={styles.centerBox}>
          <Feather name="lock" size={28} color={colors.mutedForeground} />
          <Text style={styles.centerText}>You don't have access to {C.title.toLowerCase()}.</Text>
        </View>
      </FormScreen>
    );
  }

  return (
    <FormScreen
      title={C.title}
      subtitle={C.subtitle}
      headerRight={
        rights.canAdd ? (
          <Pressable
            onPress={() => router.push(`/voucher-new?kind=${kind}`)}
            style={({ pressed }) => [styles.newBtn, pressed && { opacity: 0.8 }]}
          >
            <Feather name="plus" size={16} color={colors.primaryForeground ?? '#fff'} />
            <Text style={styles.newBtnText}>New</Text>
          </Pressable>
        ) : undefined
      }
    >
      {listQ.isError ? (
        <View style={styles.centerBox}>
          <Feather name="alert-circle" size={28} color={colors.destructive} />
          <Text style={styles.centerText}>Couldn't load vouchers.</Text>
          <Pressable onPress={() => listQ.refetch()} style={styles.retryBtn}>
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <View style={styles.searchBox}>
            <Feather name="search" size={16} color={colors.mutedForeground} />
            <TextInput
              style={styles.searchInput}
              value={search}
              onChangeText={t => { setSearch(t); setVisible(PAGE_SIZE); }}
              placeholder="Search voucher no, party, account…"
              placeholderTextColor={colors.mutedForeground}
              autoCorrect={false}
              autoCapitalize="none"
            />
            {search.length > 0 && (
              <Pressable onPress={() => setSearch('')} hitSlop={8}>
                <Feather name="x-circle" size={16} color={colors.mutedForeground} />
              </Pressable>
            )}
          </View>

          {filtered.length > 0 ? (
            <Text style={styles.countText}>
              {filtered.length} voucher{filtered.length === 1 ? '' : 's'}
            </Text>
          ) : null}

          <FlatList
            data={shown}
            keyExtractor={r => String(r.id)}
            scrollEnabled={false}
            refreshControl={
              <RefreshControl refreshing={listQ.isRefetching} onRefresh={() => listQ.refetch()} />
            }
            ListEmptyComponent={
              <View style={styles.centerBox}>
                <Feather name="inbox" size={28} color={colors.mutedForeground} />
                <Text style={styles.centerText}>
                  {search ? 'No vouchers match your search.' : C.emptyText}
                </Text>
              </View>
            }
            renderItem={({ item: r }) => {
              const loc = showLocation ? locationName(r) : '';
              return (
                <View style={styles.card}>
                  <View style={styles.cardTop}>
                    <View style={{ flex: 1, marginRight: 8 }}>
                      <Text style={styles.voucherNo}>{r.voucherNumber}</Text>
                      <Text style={styles.dateText}>
                        {formatDate(r.date)}{loc ? ` · ${loc}` : ''}
                      </Text>
                    </View>
                    <Text style={styles.amount}>{formatMoney(r.amount)}</Text>
                  </View>
                  <Text style={styles.partyLine} numberOfLines={1}>
                    {C.partyPrefix}: <Text style={styles.partyName}>{r.party}</Text>
                  </Text>
                  <Text style={styles.accountLine} numberOfLines={1}>
                    {C.accountPrefix}: {r.account}
                  </Text>
                  {r.reference ? (
                    <Text style={styles.metaLine} numberOfLines={1}>Ref: {r.reference}</Text>
                  ) : null}
                  {r.narration ? (
                    <Text style={styles.metaLine} numberOfLines={2}>{r.narration}</Text>
                  ) : null}
                  <View style={styles.cardBottom}>
                    {r.origin === 'system' ? (
                      <View style={styles.systemBadge}>
                        <Text style={styles.systemBadgeText}>System</Text>
                      </View>
                    ) : <View />}
                    {rights.canDownload ? (
                      <Pressable
                        onPress={() => openPdf(r)}
                        disabled={pdfBusyId !== null}
                        style={({ pressed }) => [styles.pdfBtn, pressed && { opacity: 0.7 }]}
                        hitSlop={6}
                      >
                        {pdfBusyId === r.id ? (
                          <ActivityIndicator size="small" color={colors.primary} />
                        ) : (
                          <>
                            <Feather name="file-text" size={14} color={colors.primary} />
                            <Text style={styles.pdfBtnText}>PDF</Text>
                          </>
                        )}
                      </Pressable>
                    ) : null}
                  </View>
                </View>
              );
            }}
          />

          {filtered.length > visible ? (
            <Pressable
              onPress={() => setVisible(v => v + PAGE_SIZE)}
              style={({ pressed }) => [styles.moreBtn, pressed && { opacity: 0.8 }]}
            >
              <Text style={styles.moreBtnText}>
                Show more ({filtered.length - visible} remaining)
              </Text>
            </Pressable>
          ) : null}
        </>
      )}
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
    retryBtn: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderRadius: 8,
      backgroundColor: colors.primary + '15',
    },
    retryText: { color: colors.primary, fontFamily: 'Outfit_600SemiBold', fontSize: 14 },
    newBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      backgroundColor: colors.primary,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 7,
    },
    newBtnText: {
      color: colors.primaryForeground ?? '#fff',
      fontSize: 13,
      fontFamily: 'Outfit_600SemiBold',
    },
    searchBox: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: colors.muted,
      borderRadius: 10,
      paddingHorizontal: 12,
      height: 44,
      marginBottom: 8,
    },
    searchInput: {
      flex: 1,
      fontSize: 14,
      color: colors.foreground,
      fontFamily: 'Outfit_400Regular',
      paddingVertical: 0,
    },
    countText: {
      fontSize: 12,
      color: colors.mutedForeground,
      fontFamily: 'Outfit_400Regular',
      marginBottom: 8,
    },
    card: {
      backgroundColor: colors.card,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 14,
      marginBottom: 10,
    },
    cardTop: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 6 },
    voucherNo: { fontSize: 15, color: colors.foreground, fontFamily: 'Outfit_600SemiBold' },
    dateText: {
      fontSize: 12,
      color: colors.mutedForeground,
      fontFamily: 'Outfit_400Regular',
      marginTop: 1,
    },
    amount: { fontSize: 16, color: colors.foreground, fontFamily: 'Outfit_700Bold' },
    partyLine: {
      fontSize: 13,
      color: colors.mutedForeground,
      fontFamily: 'Outfit_400Regular',
      marginBottom: 2,
    },
    partyName: { color: colors.foreground, fontFamily: 'Outfit_500Medium' },
    accountLine: { fontSize: 13, color: colors.mutedForeground, fontFamily: 'Outfit_400Regular' },
    metaLine: {
      fontSize: 12,
      color: colors.mutedForeground,
      fontFamily: 'Outfit_400Regular',
      marginTop: 3,
    },
    cardBottom: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: 8,
    },
    systemBadge: {
      backgroundColor: colors.muted,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    systemBadgeText: {
      fontSize: 11,
      color: colors.mutedForeground,
      fontFamily: 'Outfit_600SemiBold',
    },
    pdfBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      borderWidth: 1,
      borderColor: colors.primary + '50',
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 6,
      minWidth: 64,
      justifyContent: 'center',
    },
    pdfBtnText: { fontSize: 13, color: colors.primary, fontFamily: 'Outfit_600SemiBold' },
    moreBtn: {
      alignItems: 'center',
      paddingVertical: 12,
      borderRadius: 10,
      backgroundColor: colors.muted,
      marginBottom: 16,
    },
    moreBtnText: { fontSize: 14, color: colors.foreground, fontFamily: 'Outfit_500Medium' },
  });
}
