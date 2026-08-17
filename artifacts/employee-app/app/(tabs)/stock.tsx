import React, { useEffect, useMemo, useState } from 'react';
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  useInfiniteStock,
  usePaginatedStock,
  useListStockBatches,
  type PaginatedStockRow,
  type StockBatch,
} from '@workspace/api-client-react';
import { LocationSelector } from '@/components/LocationSelector';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { formatMoney } from '@/components/ui/MoneyText';
import { PAGE, useErpPermissions } from '@/hooks/useErpPermissions';
import { useAuth } from '@/contexts/AuthContext';
import { useColors } from '@/hooks/useColors';

/**
 * Live Stock — read-only stock visibility on mobile.
 *
 * Location scoping rides the x-location headers (LocationContext), exactly
 * like every other list. Branch users are server-scoped to their own items;
 * the item-type chips are HO-only because the server filters branch callers
 * to finished items regardless.
 *
 * Valuation is the SERVER's call: money fields are absent from the payload
 * for roles without the inventory-valuation right, and `canViewValuation`
 * on the envelope says whether to render them — never inferred client-side,
 * never shown as an empty slot.
 *
 * The low-stock filter is client-side (the endpoint has no such param), so
 * it switches to the limit=0 "whole list" fetch — filtering loaded pages
 * would hide low items that simply hadn't been paged in yet.
 */

const TYPE_LABELS: Record<string, string> = {
  item: 'Item (SKU)',
  material: 'Raw Material',
  raw_material: 'Packing',
};

const TYPE_CHIPS = [
  { key: 'all', label: 'All Types' },
  { key: 'item', label: 'Items' },
  { key: 'material', label: 'Raw Mat.' },
  { key: 'raw_material', label: 'Packing' },
] as const;
type TypeKey = (typeof TYPE_CHIPS)[number]['key'];

/** Stable identity of one stock row across list/batches/detail. */
const rowKeyOf = (r: { materialType?: string; branchType: string; branchId: number; itemId: number }) =>
  `${r.materialType ?? 'item'}:${r.branchType}:${r.branchId}:${r.itemId}`;

const qtyIN = (n: number) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });

export default function StockScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { employee } = useAuth();
  const { ready, perm } = useErpPermissions();
  const stockPerm = perm(PAGE.stock);
  const isHO = employee?.branchType === 'headoffice';

  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [type, setType] = useState<TypeKey>('all');
  const [lowOnly, setLowOnly] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  const materialType = type === 'all' ? undefined : type;

  // Normal mode: server pagination, accumulated. Low-stock mode: one full
  // fetch (limit=0 keeps the envelope) filtered client-side. Only the active
  // mode's query runs — the other stays disabled.
  const infiniteQ = useInfiniteStock(
    { q: q || undefined, materialType, limit: 50 },
    { enabled: !lowOnly },
  );
  const fullQ = usePaginatedStock(
    { q: q || undefined, materialType, limit: 0 },
    { enabled: lowOnly },
  );
  // Only the ACTIVE mode's query drives the screen; the other one is idle.
  const activeLoading = lowOnly ? fullQ.isLoading : infiniteQ.isLoading;
  const activeError = lowOnly ? fullQ.isError : infiniteQ.isError;
  const activeRefetching = lowOnly ? fullQ.isRefetching : infiniteQ.isRefetching;
  const refetchActive = () => (lowOnly ? fullQ.refetch() : infiniteQ.refetch());
  // Filter/search changed: the previous answer is showing as placeholder
  // while the new one loads — dim it so stale rows read as stale.
  const transitioning = lowOnly
    ? fullQ.isPlaceholderData && fullQ.isFetching
    : infiniteQ.isPlaceholderData && infiniteQ.isFetching;

  const rows: PaginatedStockRow[] = useMemo(() => {
    if (lowOnly) return (fullQ.data?.rows ?? []).filter(r => r.lowStock);
    return (infiniteQ.data?.pages ?? []).flatMap(p => p.rows);
  }, [lowOnly, fullQ.data, infiniteQ.data]);

  const canSeeValue = lowOnly
    ? fullQ.data?.canViewValuation === true
    : infiniteQ.data?.pages?.[0]?.canViewValuation === true;
  const total = lowOnly ? rows.length : (infiniteQ.data?.pages?.[0]?.total ?? 0);

  // MRP / item code / expiry flags live on batch lots, not stock rows — same
  // enrichment the web page does. One headers-scoped fetch, mapped by row key.
  const { data: batches = [] } = useListStockBatches();
  const batchInfo = useMemo(() => {
    const m = new Map<string, { mrp: number | null; itemCode: string | null; worst: 'expired' | 'near_expiry' | null }>();
    for (const b of batches as StockBatch[]) {
      const key = rowKeyOf(b);
      const cur = m.get(key) ?? { mrp: null, itemCode: null, worst: null };
      if (cur.mrp == null && b.mrp != null) cur.mrp = Number(b.mrp);
      if (!cur.itemCode && b.itemCode) cur.itemCode = b.itemCode;
      if (b.status === 'expired') cur.worst = 'expired';
      else if (b.status === 'near_expiry' && cur.worst !== 'expired') cur.worst = 'near_expiry';
      m.set(key, cur);
    }
    return m;
  }, [batches]);

  const styles = makeStyles(colors);

  const openDetail = (row: PaginatedStockRow) => {
    router.push({
      pathname: '/stock-item/[key]',
      params: {
        key: `${(row as any).materialType ?? 'item'}~${row.branchType}~${row.branchId}~${row.itemId}`,
        name: row.itemName,
      },
    });
  };

  const renderRow = ({ item: row }: { item: PaginatedStockRow }) => {
    const kind = ((row as any).materialType ?? 'item') as string;
    const info = batchInfo.get(rowKeyOf(row as any));
    const low = !!row.lowStock;
    const subBits = [
      info?.itemCode || null,
      isHO ? row.branchName || 'Head Office' : null,
      info?.mrp != null && info.mrp > 0 ? `MRP ${formatMoney(info.mrp, { showPaise: false })}` : null,
    ].filter(Boolean);

    return (
      <Pressable
        onPress={() => openDetail(row)}
        style={({ pressed }) => [styles.card, pressed && { opacity: 0.75 }, low && styles.cardLow]}
      >
        <View style={styles.cardMain}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.itemName} numberOfLines={2}>{row.itemName}</Text>
            {subBits.length ? (
              <Text style={styles.subLine} numberOfLines={1}>{subBits.join(' · ')}</Text>
            ) : null}
            <View style={styles.badgeRow}>
              {kind !== 'item' ? <StatusBadge label={TYPE_LABELS[kind] ?? kind} tone="muted" /> : null}
              {low ? <StatusBadge label={`Low (<${qtyIN(row.reorderLevel)})`} tone="destructive" /> : null}
              {info?.worst === 'expired' ? <StatusBadge label="Expired batch" tone="destructive" /> : null}
              {info?.worst === 'near_expiry' ? <StatusBadge label="Expiring" tone="warning" /> : null}
            </View>
          </View>
          <View style={styles.qtyBox}>
            <Text style={[styles.qtyText, low && { color: colors.destructive }]}>
              {qtyIN(row.available)} <Text style={styles.unitText}>{row.unit}</Text>
            </Text>
            {Number(row.reserved) > 0 ? (
              <Text style={styles.reservedText}>{qtyIN(row.reserved)} reserved</Text>
            ) : null}
            {canSeeValue && row.stockValue != null && Number(row.stockValue) > 0 ? (
              <Text style={styles.valueText}>{formatMoney(Number(row.stockValue), { showPaise: false })}</Text>
            ) : null}
          </View>
        </View>
      </Pressable>
    );
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.background, paddingTop: insets.top + 12 }]}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.foreground }]}>Stock</Text>
        <LocationSelector />
        <View style={styles.searchBox}>
          <Feather name="search" size={16} color={colors.mutedForeground} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search items…"
            placeholderTextColor={colors.mutedForeground}
            value={search}
            onChangeText={setSearch}
            autoCapitalize="none"
            returnKeyType="search"
          />
          {search ? (
            <Pressable onPress={() => setSearch('')} hitSlop={8}>
              <Feather name="x" size={16} color={colors.mutedForeground} />
            </Pressable>
          ) : null}
        </View>
        <View style={styles.chips}>
          {isHO
            ? TYPE_CHIPS.map(t => (
                <Pressable
                  key={t.key}
                  onPress={() => setType(t.key)}
                  style={[styles.chip, type === t.key && styles.chipActive]}
                >
                  <Text style={[styles.chipText, type === t.key && styles.chipTextActive]}>{t.label}</Text>
                </Pressable>
              ))
            : null}
          <Pressable
            onPress={() => setLowOnly(v => !v)}
            style={[styles.chip, lowOnly && styles.chipLowActive]}
          >
            <Text style={[styles.chipText, lowOnly && { color: colors.destructive }]}>Low stock</Text>
          </Pressable>
          {transitioning ? (
            <ActivityIndicator size="small" color={colors.primary} style={{ marginLeft: 'auto' }} />
          ) : !activeLoading && total > 0 ? (
            <Text style={styles.count}>{total} entries</Text>
          ) : null}
        </View>
      </View>

      {!ready || activeLoading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 48 }} />
      ) : !stockPerm.canView ? (
        <View style={styles.emptyBox}>
          <Feather name="lock" size={28} color={colors.mutedForeground} />
          <Text style={styles.emptyText}>You don't have permission to view stock.</Text>
        </View>
      ) : activeError ? (
        <View style={styles.emptyBox}>
          <Feather name="alert-circle" size={28} color={colors.destructive} />
          <Text style={styles.emptyText}>Could not load stock.</Text>
          <Pressable onPress={refetchActive} style={styles.retryBtn}>
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r, i) => `${rowKeyOf(r as any)}:${i}`}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl refreshing={activeRefetching} onRefresh={refetchActive} tintColor={colors.primary} />
          }
          onEndReachedThreshold={0.4}
          onEndReached={() => {
            if (!lowOnly && infiniteQ.hasNextPage && !infiniteQ.isFetchingNextPage) infiniteQ.fetchNextPage();
          }}
          ListFooterComponent={
            infiniteQ.isFetchingNextPage ? (
              <ActivityIndicator color={colors.primary} style={{ paddingVertical: 16 }} />
            ) : null
          }
          ListEmptyComponent={
            <View style={styles.emptyBox}>
              <Feather name="package" size={28} color={colors.mutedForeground} />
              <Text style={styles.emptyText}>
                {q || type !== 'all' || lowOnly
                  ? 'No stock matches this filter.'
                  : 'No stock recorded for this location yet.'}
              </Text>
            </View>
          }
          renderItem={renderRow}
        />
      )}
    </View>
  );
}

const makeStyles = (colors: ReturnType<typeof useColors>) =>
  StyleSheet.create({
    root: { flex: 1 },
    header: { paddingHorizontal: 20, gap: 10 },
    title: { fontSize: 24, fontFamily: 'Outfit_700Bold' },
    searchBox: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: colors.card,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 12,
      paddingVertical: 2,
    },
    searchInput: {
      flex: 1,
      paddingVertical: 9,
      fontSize: 14,
      fontFamily: 'Outfit_400Regular',
      color: colors.foreground,
    },
    chips: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
    chip: {
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 12,
      paddingVertical: 5,
    },
    chipActive: { backgroundColor: colors.primary + '22', borderColor: colors.primary },
    chipLowActive: { backgroundColor: colors.destructive + '18', borderColor: colors.destructive },
    chipText: { fontSize: 12, fontFamily: 'Outfit_500Medium', color: colors.mutedForeground },
    chipTextActive: { color: colors.primary },
    count: { fontSize: 12, fontFamily: 'Outfit_400Regular', color: colors.mutedForeground, marginLeft: 'auto' },
    listContent: { padding: 20, paddingTop: 12, gap: 8, flexGrow: 1, paddingBottom: 120 },
    card: {
      backgroundColor: colors.card,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 14,
    },
    cardLow: { borderColor: colors.destructive + '55' },
    cardMain: { flexDirection: 'row', gap: 12 },
    itemName: { fontSize: 15, fontFamily: 'Outfit_600SemiBold', color: colors.foreground },
    subLine: { fontSize: 12, fontFamily: 'Outfit_400Regular', color: colors.mutedForeground },
    badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
    qtyBox: { alignItems: 'flex-end', gap: 2, justifyContent: 'center' },
    qtyText: { fontSize: 16, fontFamily: 'Outfit_700Bold', color: colors.foreground },
    unitText: { fontSize: 12, fontFamily: 'Outfit_400Regular', color: colors.mutedForeground },
    reservedText: { fontSize: 11, fontFamily: 'Outfit_500Medium', color: colors.warning },
    valueText: { fontSize: 11, fontFamily: 'Outfit_400Regular', color: colors.mutedForeground },
    emptyBox: { alignItems: 'center', gap: 10, marginTop: 60, paddingHorizontal: 32 },
    emptyText: {
      fontSize: 14,
      fontFamily: 'Outfit_400Regular',
      color: colors.mutedForeground,
      textAlign: 'center',
    },
    retryBtn: {
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 16,
      paddingVertical: 8,
    },
    retryText: { fontSize: 13, fontFamily: 'Outfit_600SemiBold', color: colors.primary },
  });
