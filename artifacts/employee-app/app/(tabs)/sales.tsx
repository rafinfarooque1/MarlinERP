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
import { useInfiniteSales, type PaginatedSaleRow } from '@workspace/api-client-react';
import { LocationSelector } from '@/components/LocationSelector';
import { StatusBadge, type BadgeTone } from '@/components/ui/StatusBadge';
import { formatMoney } from '@/components/ui/MoneyText';
import { localYmd, shiftYmd } from '@/lib/localDate';
import { PAGE, useErpPermissions } from '@/hooks/useErpPermissions';
import { useLocationContext } from '@/contexts/LocationContext';
import { useColors } from '@/hooks/useColors';

/** Payment-status pill: same vocabulary as the web sales list. */
function statusBadge(row: PaginatedSaleRow): { label: string; tone: BadgeTone } {
  if ((row as any).isCancelled || (row as any).cancelledAt) {
    return { label: 'Cancelled', tone: 'muted' };
  }
  switch (row.paymentStatus) {
    case 'paid': return { label: 'Paid', tone: 'success' };
    case 'partially_paid': return { label: 'Partial', tone: 'warning' };
    case 'unpaid': return { label: 'Unpaid', tone: 'destructive' };
    case 'cancelled': return { label: 'Cancelled', tone: 'muted' };
    default: return { label: row.paymentStatus ?? '—', tone: 'muted' };
  }
}

function formatDate(d?: string | null): string {
  if (!d) return '';
  const dt = new Date(`${String(d).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' });
}

const RANGES = [
  { key: 'all', label: 'All' },
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
] as const;
type RangeKey = (typeof RANGES)[number]['key'];

function rangeFrom(key: RangeKey): string | undefined {
  if (key === 'all') return undefined;
  const days = key === 'today' ? 0 : key === '7d' ? 6 : 29;
  return shiftYmd(localYmd(), -days);
}

export default function SalesScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { location } = useLocationContext();
  const { ready, perm } = useErpPermissions();
  const salesPerm = perm(PAGE.sales);

  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [range, setRange] = useState<RangeKey>('all');

  // Debounce typing → one server query per pause, not per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  // Location scoping rides the x-location headers (LocationContext snapshot),
  // exactly like every other list in the app — no explicit params here.
  const from = useMemo(() => rangeFrom(range), [range]);
  const {
    data,
    isLoading,
    isRefetching,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteSales({ q: q || undefined, from, limit: 25 });

  const rows = useMemo(() => (data?.pages ?? []).flatMap(p => p.rows), [data]);
  const total = data?.pages?.[0]?.total ?? 0;

  const styles = makeStyles(colors);

  return (
    <View style={[styles.root, { backgroundColor: colors.background, paddingTop: insets.top + 12 }]}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Text style={[styles.title, { color: colors.foreground }]}>Sales</Text>
          {ready && salesPerm.canAdd ? (
            <Pressable
              onPress={() => router.push('/new-sale')}
              style={({ pressed }) => [styles.newBtn, pressed && { opacity: 0.8 }]}
            >
              <Feather name="plus" size={16} color={colors.primaryForeground} />
              <Text style={styles.newBtnText}>New Sale</Text>
            </Pressable>
          ) : null}
        </View>
        <LocationSelector />
        <View style={styles.searchBox}>
          <Feather name="search" size={16} color={colors.mutedForeground} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search invoice or customer…"
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
          {RANGES.map(r => (
            <Pressable
              key={r.key}
              onPress={() => setRange(r.key)}
              style={[styles.chip, range === r.key && styles.chipActive]}
            >
              <Text style={[styles.chipText, range === r.key && styles.chipTextActive]}>
                {r.label}
              </Text>
            </Pressable>
          ))}
          {total > 0 ? <Text style={styles.count}>{total} bills</Text> : null}
        </View>
      </View>

      {!ready || isLoading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 48 }} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={r => String(r.id)}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching && !isFetchingNextPage}
              onRefresh={refetch}
              tintColor={colors.primary}
            />
          }
          onEndReachedThreshold={0.4}
          onEndReached={() => {
            if (hasNextPage && !isFetchingNextPage) fetchNextPage();
          }}
          ListEmptyComponent={
            <View style={styles.emptyBox}>
              <Feather name="shopping-cart" size={28} color={colors.mutedForeground} />
              <Text style={styles.emptyText}>
                {q || range !== 'all' ? 'No sales match this filter.' : 'No sales yet.'}
              </Text>
            </View>
          }
          ListFooterComponent={
            isFetchingNextPage ? (
              <ActivityIndicator color={colors.primary} style={{ marginVertical: 16 }} />
            ) : null
          }
          renderItem={({ item: row }) => {
            const badge = statusBadge(row);
            return (
              <Pressable
                onPress={() => router.push(`/sale/${row.id}`)}
                style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}
              >
                <View style={{ flex: 1, gap: 3 }}>
                  <Text style={styles.invoice} numberOfLines={1}>
                    {(row as any).invoiceNumber ?? `#${row.id}`}
                  </Text>
                  <Text style={styles.customer} numberOfLines={1}>
                    {(row as any).customerName || 'Walk-in customer'}
                  </Text>
                  <Text style={styles.date}>{formatDate((row as any).saleDate)}</Text>
                </View>
                <View style={{ alignItems: 'flex-end', gap: 6 }}>
                  <Text style={styles.amount}>
                    {formatMoney(Number((row as any).totalAmount ?? 0), { showPaise: true })}
                  </Text>
                  <StatusBadge label={badge.label} tone={badge.tone} />
                </View>
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}

const makeStyles = (colors: ReturnType<typeof useColors>) =>
  StyleSheet.create({
    root: { flex: 1 },
    header: { paddingHorizontal: 20, gap: 10 },
    titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    title: { fontSize: 24, fontFamily: 'Outfit_700Bold' },
    newBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      backgroundColor: colors.primary,
      borderRadius: 999,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    newBtnText: {
      color: colors.primaryForeground,
      fontSize: 13,
      fontFamily: 'Outfit_600SemiBold',
    },
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
    chips: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    chip: {
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 12,
      paddingVertical: 5,
    },
    chipActive: { backgroundColor: colors.primary + '22', borderColor: colors.primary },
    chipText: { fontSize: 12, fontFamily: 'Outfit_500Medium', color: colors.mutedForeground },
    chipTextActive: { color: colors.primary },
    count: {
      marginLeft: 'auto',
      fontSize: 12,
      fontFamily: 'Outfit_400Regular',
      color: colors.mutedForeground,
    },
    listContent: { padding: 20, paddingTop: 12, gap: 10, flexGrow: 1 },
    card: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      backgroundColor: colors.card,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 14,
    },
    invoice: { fontSize: 15, fontFamily: 'Outfit_600SemiBold', color: colors.foreground },
    customer: { fontSize: 13, fontFamily: 'Outfit_400Regular', color: colors.mutedForeground },
    date: { fontSize: 12, fontFamily: 'Outfit_400Regular', color: colors.mutedForeground },
    amount: { fontSize: 15, fontFamily: 'Outfit_700Bold', color: colors.foreground },
    emptyBox: { alignItems: 'center', gap: 10, marginTop: 60 },
    emptyText: { fontSize: 14, fontFamily: 'Outfit_400Regular', color: colors.mutedForeground },
  });
