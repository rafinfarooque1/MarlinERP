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
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  useDispatchQueue,
  useSetDispatchStatus,
  type DispatchQueueEntry,
  type DispatchStatus,
} from '@workspace/api-client-react';
import { LocationSelector } from '@/components/LocationSelector';
import { StatusBadge, type BadgeTone } from '@/components/ui/StatusBadge';
import { formatMoney } from '@/components/ui/MoneyText';
import { confirmDialog, notify } from '@/lib/dialogs';
import { PAGE, useErpPermissions } from '@/hooks/useErpPermissions';
import { useColors } from '@/hooks/useColors';

/**
 * Dispatch queue — billed sales awaiting physical fulfilment.
 *
 * A pure status layer over sales (server writes only sale_dispatch_status):
 * marking READY / DISPATCHED never touches amounts, stock or the books.
 * Cards lead with customer + items; money is deliberately de-emphasized.
 *
 * Forward-only transitions: PENDING → READY → DISPATCHED. A 409 means someone
 * else moved the bill (or it was cancelled) — we tell the user and refetch so
 * the card resyncs to the server's real status.
 */

const STATUS_META: Record<DispatchStatus, { label: string; tone: BadgeTone }> = {
  PENDING: { label: 'Pending', tone: 'warning' },
  READY: { label: 'Ready', tone: 'info' },
  DISPATCHED: { label: 'Dispatched', tone: 'success' },
};

type StatusFilter = 'all' | DispatchStatus;

const TABS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'PENDING', label: 'Pending' },
  { key: 'READY', label: 'Ready' },
  { key: 'DISPATCHED', label: 'Dispatched' },
];

/** Coarse "time since billing" — the queue cares about hours, not seconds. */
function timeSince(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function fmtStamp(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

/** How many item lines a collapsed card shows before "Show all". */
const COLLAPSED_LINES = 4;

export default function DispatchScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { ready, perm } = useErpPermissions();
  const dispatchPerm = perm(PAGE.dispatch);

  const [tab, setTab] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // One fetch for the whole recent window (server default); status tabs and
  // search filter client-side so switching tabs never refetches — same
  // behavior as the web dispatch board. Location scoping rides the
  // x-location headers automatically.
  const queueQ = useDispatchQueue();
  const rows = useMemo(() => queueQ.data ?? [], [queueQ.data]);
  const setStatusM = useSetDispatchStatus();
  // Which card's button is in flight — only that one shows a spinner.
  const [pendingSaleId, setPendingSaleId] = useState<number | null>(null);
  // Synchronous double-tap guard: isPending is render-time state and lags a
  // fast second tap, so the real lock is this ref (state is display-only).
  const transitionLockRef = React.useRef(false);

  const counts = useMemo(() => {
    const c: Record<DispatchStatus, number> = { PENDING: 0, READY: 0, DISPATCHED: 0 };
    for (const r of rows) c[r.status] += 1;
    return c;
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => {
      if (tab !== 'all' && r.status !== tab) return false;
      if (
        q &&
        !(
          r.invoiceNumber?.toLowerCase().includes(q) ||
          (r.customerName ?? '').toLowerCase().includes(q) ||
          r.itemsSummary.toLowerCase().includes(q) ||
          r.locationName.toLowerCase().includes(q)
        )
      )
        return false;
      return true;
    });
  }, [rows, tab, search]);

  const transition = (row: DispatchQueueEntry, target: 'READY' | 'DISPATCHED') => {
    if (transitionLockRef.current) return;
    transitionLockRef.current = true;
    setPendingSaleId(row.saleId);
    setStatusM.mutate(
      { saleId: row.saleId, status: target },
      {
        onSuccess: () => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        },
        onError: (e: any) => {
          const msg = e?.data?.error || e?.message || 'Could not update the status.';
          // 409 = someone else already moved this bill, or it was cancelled —
          // refetch so the card snaps back to the server's current status.
          if (e?.status === 409) {
            notify('Already updated elsewhere', msg);
            void queueQ.refetch();
          } else {
            notify('Could not update', msg);
          }
        },
        onSettled: () => {
          transitionLockRef.current = false;
          setPendingSaleId(null);
        },
      },
    );
  };

  const onMarkDispatched = (row: DispatchQueueEntry) => {
    confirmDialog({
      title: 'Mark dispatched?',
      message: `${row.invoiceNumber} · ${row.customerName ?? 'Walk-in customer'}\n\nThis is the final step — a dispatched bill cannot be moved back.`,
      confirmText: 'Mark dispatched',
      cancelText: 'Not yet',
      onConfirm: () => transition(row, 'DISPATCHED'),
    });
  };

  const toggleExpanded = (saleId: number) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(saleId)) next.delete(saleId);
      else next.add(saleId);
      return next;
    });

  const styles = makeStyles(colors);

  const renderCard = ({ item: row }: { item: DispatchQueueEntry }) => {
    const meta = STATUS_META[row.status];
    const isExpanded = expanded.has(row.saleId);
    const lines = isExpanded ? row.lines : row.lines.slice(0, COLLAPSED_LINES);
    const hiddenCount = row.lines.length - COLLAPSED_LINES;
    const busy = pendingSaleId === row.saleId && setStatusM.isPending;

    return (
      <View style={styles.card}>
        {/* Customer first — this is a packing screen, not a billing screen */}
        <View style={styles.cardTop}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.customer} numberOfLines={1}>
              {row.customerName ?? 'Walk-in customer'}
            </Text>
            <Text style={styles.subLine} numberOfLines={1}>
              {row.invoiceNumber} · {row.locationName || '—'}
            </Text>
          </View>
          <StatusBadge label={meta.label} tone={meta.tone} />
        </View>

        {/* Item lines with quantities — the actual picking list */}
        <View style={styles.linesBox}>
          {row.lines.length === 0 ? (
            <Text style={styles.lineQty}>No items on this bill.</Text>
          ) : (
            lines.map((line, i) => (
              <View key={i} style={styles.lineRow}>
                <Text style={styles.lineName} numberOfLines={2}>
                  {line.name}
                </Text>
                <Text style={styles.lineQty}>
                  {line.quantity} {line.unit}
                </Text>
              </View>
            ))
          )}
          {hiddenCount > 0 ? (
            <Pressable onPress={() => toggleExpanded(row.saleId)} hitSlop={6}>
              <Text style={styles.moreLink}>
                {isExpanded ? 'Show less' : `Show all ${row.lines.length} items`}
              </Text>
            </Pressable>
          ) : null}
        </View>

        {/* De-emphasized footer: when billed, tiny amount, who/when stamps */}
        <View style={styles.metaRow}>
          <Text style={styles.metaText}>{timeSince(row.createdAt)}</Text>
          <Text style={styles.metaText}>{formatMoney(row.totalAmount, { showPaise: false })}</Text>
        </View>
        {row.status === 'READY' && row.readyBy ? (
          <Text style={styles.stampText}>Ready · {row.readyBy} · {fmtStamp(row.readyAt)}</Text>
        ) : null}
        {row.status === 'DISPATCHED' ? (
          <Text style={styles.stampText}>
            {row.readyBy ? `Ready · ${row.readyBy} · ${fmtStamp(row.readyAt)}\n` : ''}
            Dispatched · {row.dispatchedBy ?? '—'} · {fmtStamp(row.dispatchedAt)}
          </Text>
        ) : null}

        {/* View opens the full bill; the transition button (when allowed)
            always shows the one forward move for this card. */}
        <View style={styles.btnRow}>
          <Pressable
            style={({ pressed }) => [styles.actionBtn, styles.viewBtn, pressed && { opacity: 0.7 }]}
            onPress={() => router.push(`/sale/${row.saleId}`)}
          >
            <Feather name="eye" size={15} color={colors.foreground} />
            <Text style={[styles.actionBtnText, { color: colors.foreground }]}>View</Text>
          </Pressable>
          {dispatchPerm.canEdit && row.status === 'PENDING' ? (
            <Pressable
              style={({ pressed }) => [styles.actionBtn, styles.growBtn, styles.readyBtn, (pressed || busy) && { opacity: 0.7 }]}
              onPress={() => transition(row, 'READY')}
              disabled={setStatusM.isPending}
            >
              {busy ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : (
                <>
                  <Feather name="check-square" size={15} color={colors.primary} />
                  <Text style={[styles.actionBtnText, { color: colors.primary }]}>Mark Ready</Text>
                </>
              )}
            </Pressable>
          ) : null}
          {dispatchPerm.canEdit && row.status === 'READY' ? (
            <Pressable
              style={({ pressed }) => [styles.actionBtn, styles.growBtn, styles.dispatchBtn, (pressed || busy) && { opacity: 0.7 }]}
              onPress={() => onMarkDispatched(row)}
              disabled={setStatusM.isPending}
            >
              {busy ? (
                <ActivityIndicator size="small" color={colors.primaryForeground} />
              ) : (
                <>
                  <Feather name="truck" size={15} color={colors.primaryForeground} />
                  <Text style={[styles.actionBtnText, { color: colors.primaryForeground }]}>Mark Dispatched</Text>
                </>
              )}
            </Pressable>
          ) : null}
        </View>
      </View>
    );
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.background, paddingTop: insets.top + 12 }]}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.foreground }]}>Dispatch</Text>
        <LocationSelector />
        <View style={styles.searchBox}>
          <Feather name="search" size={16} color={colors.mutedForeground} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search invoice, customer or items…"
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
          {TABS.map(t => (
            <Pressable
              key={t.key}
              onPress={() => setTab(t.key)}
              style={[styles.chip, tab === t.key && styles.chipActive]}
            >
              <Text style={[styles.chipText, tab === t.key && styles.chipTextActive]}>
                {t.label}
                {t.key !== 'all' ? ` (${counts[t.key as DispatchStatus]})` : ''}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {!ready || queueQ.isLoading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 48 }} />
      ) : queueQ.isError ? (
        <View style={styles.emptyBox}>
          <Feather name="alert-circle" size={28} color={colors.destructive} />
          <Text style={styles.emptyText}>Could not load the dispatch queue.</Text>
          <Pressable onPress={() => queueQ.refetch()} style={styles.retryBtn}>
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={r => String(r.saleId)}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={queueQ.isRefetching}
              onRefresh={queueQ.refetch}
              tintColor={colors.primary}
            />
          }
          ListEmptyComponent={
            <View style={styles.emptyBox}>
              <Feather name="truck" size={28} color={colors.mutedForeground} />
              <Text style={styles.emptyText}>
                {search || tab !== 'all'
                  ? 'No bills match this filter.'
                  : 'Sales billed in the recent window will appear here for dispatch.'}
              </Text>
            </View>
          }
          renderItem={renderCard}
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
    chipText: { fontSize: 12, fontFamily: 'Outfit_500Medium', color: colors.mutedForeground },
    chipTextActive: { color: colors.primary },
    listContent: { padding: 20, paddingTop: 12, gap: 10, flexGrow: 1, paddingBottom: 120 },
    card: {
      backgroundColor: colors.card,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 14,
      gap: 10,
    },
    cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
    customer: { fontSize: 16, fontFamily: 'Outfit_600SemiBold', color: colors.foreground },
    subLine: { fontSize: 12, fontFamily: 'Outfit_400Regular', color: colors.mutedForeground },
    linesBox: {
      borderRadius: 10,
      backgroundColor: colors.muted,
      paddingHorizontal: 12,
      paddingVertical: 8,
      gap: 6,
    },
    lineRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
    lineName: { flex: 1, fontSize: 14, fontFamily: 'Outfit_400Regular', color: colors.foreground },
    lineQty: { fontSize: 13, fontFamily: 'Outfit_600SemiBold', color: colors.mutedForeground },
    moreLink: { fontSize: 12, fontFamily: 'Outfit_600SemiBold', color: colors.primary, paddingTop: 2 },
    metaRow: { flexDirection: 'row', justifyContent: 'space-between' },
    metaText: { fontSize: 12, fontFamily: 'Outfit_400Regular', color: colors.mutedForeground },
    stampText: { fontSize: 11, fontFamily: 'Outfit_400Regular', color: colors.mutedForeground },
    btnRow: { flexDirection: 'row', gap: 8 },
    actionBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
      borderRadius: 10,
      height: 44,
      flex: 1,
    },
    growBtn: { flex: 1.7 },
    viewBtn: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
    readyBtn: { borderWidth: 1.5, borderColor: colors.primary, backgroundColor: colors.primary + '10' },
    dispatchBtn: { backgroundColor: colors.primary },
    actionBtnText: { fontSize: 14, fontFamily: 'Outfit_600SemiBold' },
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
