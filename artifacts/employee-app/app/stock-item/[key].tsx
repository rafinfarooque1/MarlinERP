import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import {
  useItemTracking,
  useListStockBatches,
  usePaginatedStock,
  type ItemTrackingResponse,
  type StockBatch,
} from '@workspace/api-client-react';
import { FormScreen } from '@/components/ui/FormScreen';
import { StatusBadge, type BadgeTone } from '@/components/ui/StatusBadge';
import { formatMoney } from '@/components/ui/MoneyText';
import { PAGE, useErpPermissions } from '@/hooks/useErpPermissions';
import { useColors } from '@/hooks/useColors';

/**
 * Stock item detail — one product at one location: quantities, lots (with
 * manufacture/expiry), storage placements, and the tracking timeline.
 *
 * Entirely read-only. Route key = `materialType~branchType~branchId~itemId`
 * (a stable identity, never a row snapshot) so the screen always renders
 * from fresh queries. Valuation renders only when the server's envelope says
 * the caller holds the right; absent fields stay absent — never zero, never
 * an empty slot.
 */

const TYPE_LABELS: Record<string, string> = {
  item: 'Item (SKU)',
  material: 'Raw Material',
  raw_material: 'Packing Material',
};

const qtyIN = (n: number) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });

function formatDate(d?: string | null): string {
  if (!d) return '—';
  const dt = new Date(`${String(d).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' });
}

function batchTone(status: StockBatch['status']): BadgeTone {
  if (status === 'expired') return 'destructive';
  if (status === 'near_expiry') return 'warning';
  return 'muted';
}

// ── Tracking timeline ────────────────────────────────────────────────────────

type TimelineEvent = {
  id: string;
  date: string;
  icon: keyof typeof Feather.glyphMap;
  title: string;
  sub: string;
  /** Signed quantity delta; null for neutral rows (transfers, cancelled). */
  delta: number | null;
  /** Company-wide stock AFTER this event — derived backwards from
   *  summary.currentStock, so the newest row always reconciles to live stock. */
  balance?: number;
  tone: BadgeTone;
  flags: string[];
};

/** Flatten the tracking response into one newest-first event list.
 *
 * Cancelled documents moved nothing, and branch-transfer twins are already
 * represented by their neutral Transferred row — both render WITHOUT a
 * signed delta so the timeline never overstates live stock movement. */
function buildTimeline(t: ItemTrackingResponse): TimelineEvent[] {
  const ev: TimelineEvent[] = [];
  for (const p of t.purchaseHistory) {
    const neutral = !!p.cancelled || !!p.isBranchTransfer;
    ev.push({
      id: `pur:${p.purchaseId}:${p.batchNumber}`,
      date: p.purchaseDate,
      icon: 'shopping-cart',
      title: 'Purchased',
      sub: `${p.vendorName} · ${p.invoiceNumber}${p.batchNumber ? ` · ${p.batchNumber}` : ''} · ${p.location}`,
      delta: neutral ? null : Number(p.quantity),
      tone: 'success',
      flags: [p.cancelled ? 'Cancelled' : '', p.isBranchTransfer ? 'Branch transfer' : ''].filter(Boolean),
    });
  }
  for (const s of t.salesHistory) {
    const neutral = !!s.cancelled || !!s.isBranchTransfer;
    ev.push({
      id: `sale:${s.saleId}`,
      date: s.saleDate,
      icon: 'shopping-bag',
      title: 'Sold',
      sub: `${s.customerName || 'Walk-in customer'} · ${s.invoiceNumber} · ${s.location}`,
      delta: neutral ? null : -Number(s.quantity),
      tone: 'info',
      flags: [s.cancelled ? 'Cancelled' : '', s.isBranchTransfer ? 'Branch transfer' : ''].filter(Boolean),
    });
  }
  for (const r of t.salesReturns) {
    ev.push({
      id: `sret:${r.returnId}`,
      date: r.returnDate,
      icon: 'corner-up-left',
      title: 'Sales return',
      sub: `${r.customerName || 'Walk-in customer'} · against ${r.againstInvoice} · ${r.location}`,
      delta: Number(r.quantity),
      tone: 'warning',
      flags: [],
    });
  }
  for (const r of t.purchaseReturns) {
    ev.push({
      id: `pret:${r.returnId}`,
      date: r.returnDate,
      icon: 'corner-up-right',
      title: 'Purchase return',
      sub: `${r.vendorName} · against ${r.againstInvoice} · ${r.location}`,
      delta: -Number(r.quantity),
      tone: 'warning',
      flags: [],
    });
  }
  for (const tr of t.transfers) {
    ev.push({
      id: `tr:${tr.transferId}`,
      date: tr.transferDate,
      icon: 'repeat',
      title: 'Transferred',
      sub: `${tr.from} → ${tr.to} · ${tr.challanNumber} · ${tr.status}`,
      delta: null,
      tone: 'muted',
      flags: [],
    });
  }
  for (const pr of t.production) {
    ev.push({
      id: `prod:${pr.productionId}:${pr.role}`,
      date: pr.productionDate,
      icon: pr.role === 'produced' ? 'plus-circle' : 'tool',
      title: pr.role === 'produced' ? 'Produced' : 'Used in production',
      sub: `Batch ${pr.batchNumber} · ${pr.location}`,
      delta: pr.role === 'produced' ? Number(pr.quantity) : -Number(pr.quantity),
      tone: pr.role === 'produced' ? 'success' : 'info',
      flags: [],
    });
  }
  for (const a of t.adjustments) {
    ev.push({
      id: `adj:${a.verificationId}`,
      date: a.verifyDate,
      icon: 'edit-3',
      title: 'Stock adjustment',
      sub: `${a.location}${a.reason ? ` · ${a.reason}` : ''}${a.createdBy ? ` · by ${a.createdBy}` : ''}`,
      delta: Number(a.variance),
      tone: Number(a.variance) < 0 ? 'destructive' : 'success',
      flags: [],
    });
  }
  // Newest first; same-day rows keep source-array grouping (stable sort).
  ev.sort((a, b) => String(b.date).localeCompare(String(a.date)));

  // Running balance, walked BACKWARDS from today's live stock: the newest
  // row's balance IS summary.currentStock, each older row's balance backs
  // out the newer deltas. Neutral rows (transfers, cancelled docs) carry the
  // balance unchanged. When the server truncated the history, the oldest
  // visible balance is NOT an opening balance — older documents exist.
  let bal = Number(t.summary?.currentStock);
  if (Number.isFinite(bal)) {
    for (const e of ev) {
      e.balance = Math.round(bal * 1000) / 1000;
      if (e.delta != null) bal -= e.delta;
    }
  }
  return ev;
}

const PAGE_SIZE = 25;

export default function StockItemDetailScreen() {
  const colors = useColors();
  const params = useLocalSearchParams<{ key: string; name?: string }>();
  const { ready, perm } = useErpPermissions();
  const canView = perm(PAGE.stock).canView;

  // Route identity: materialType~branchType~branchId~itemId
  const [materialType, branchType, branchIdRaw, itemIdRaw] = String(params.key ?? '').split('~');
  const branchId = Number(branchIdRaw) || 0;
  const itemId = Number(itemIdRaw) || 0;
  const valid =
    ['item', 'material', 'raw_material'].includes(materialType ?? '') &&
    !!branchType && branchId >= 0 && itemId > 0;

  // The stock endpoint has no single-row read: fetch the (already scoped)
  // location slice with limit=0 and pick the row. Branch params only accept
  // warehouse/outlet — headoffice rows come back on the unfiltered read.
  const stockParams =
    branchType === 'warehouse' || branchType === 'outlet'
      ? { branchType: branchType as 'warehouse' | 'outlet', branchId, materialType: materialType as any, limit: 0 }
      : { materialType: materialType as any, limit: 0 };
  const stockQ = usePaginatedStock(stockParams, { enabled: valid && ready && canView });
  const row = useMemo(
    () =>
      (stockQ.data?.rows ?? []).find(
        r =>
          ((r as any).materialType ?? 'item') === materialType &&
          r.branchType === branchType &&
          Number(r.branchId) === branchId &&
          Number(r.itemId) === itemId,
      ) ?? null,
    [stockQ.data, materialType, branchType, branchId, itemId],
  );
  const canSeeValue = stockQ.data?.canViewValuation === true;

  const batchesQ = useListStockBatches(
    { branchType, branchId, itemId, materialType: materialType as any },
    { enabled: valid && ready && canView },
  );
  const batches = batchesQ.data ?? [];

  const trackingQ = useItemTracking(valid && ready && canView ? { materialType, itemId } : null);
  const tracking = trackingQ.data;

  const timeline = useMemo(() => (tracking ? buildTimeline(tracking) : []), [tracking]);
  const [shown, setShown] = useState(PAGE_SIZE);

  const styles = makeStyles(colors);

  const title = row?.itemName || tracking?.item?.name || String(params.name ?? 'Stock item');
  const unit = row?.unit || tracking?.item?.unit || '';
  const mrp = tracking?.item?.mrp != null ? Number(tracking.item.mrp) : (batches[0]?.mrp != null ? Number(batches[0].mrp) : null);
  const itemCode = tracking?.item?.itemCode || batches[0]?.itemCode || null;

  // Storage placements ride on warehouse stock rows; Unassigned is DERIVED
  // (site total − Σ placed), never stored. Negative = over-assigned map.
  const placements: Array<{ name: string; quantity: number }> = Array.isArray((row as any)?.storageLocations)
    ? (row as any).storageLocations
    : [];
  const placedTotal = placements.reduce((s, p) => s + Number(p.quantity), 0);
  const unassigned = row ? Math.round((Number(row.quantity) - placedTotal) * 1000) / 1000 : 0;

  const loading = !ready || stockQ.isLoading;

  return (
    <FormScreen
      title={title}
      subtitle={row ? `${row.branchName || 'Head Office'}${unit ? ` · ${unit}` : ''}` : undefined}
    >
      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 48 }} />
      ) : !valid || !canView ? (
        <View style={styles.emptyBox}>
          <Feather name="lock" size={28} color={colors.mutedForeground} />
          <Text style={styles.emptyText}>
            {!valid ? 'This stock link is not valid.' : "You don't have permission to view stock."}
          </Text>
        </View>
      ) : stockQ.isError ? (
        <View style={styles.emptyBox}>
          <Feather name="alert-circle" size={28} color={colors.destructive} />
          <Text style={styles.emptyText}>Could not load this item.</Text>
          <Pressable onPress={() => stockQ.refetch()} style={styles.retryBtn}>
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : !row ? (
        <View style={styles.emptyBox}>
          <Feather name="package" size={28} color={colors.mutedForeground} />
          <Text style={styles.emptyText}>
            No stock entry found here any more — it may have moved or been consumed.
          </Text>
        </View>
      ) : (
        <View style={{ gap: 16 }}>
          {/* Status flags */}
          {(row.lowStock || batches.some(b => b.status === 'expired' || b.status === 'near_expiry')) && (
            <View style={styles.flagRow}>
              {row.lowStock ? <StatusBadge label={`Low stock (below ${qtyIN(row.reorderLevel)})`} tone="destructive" /> : null}
              {batches.some(b => b.status === 'expired') ? <StatusBadge label="Has expired batches" tone="destructive" /> : null}
              {batches.some(b => b.status === 'near_expiry') ? <StatusBadge label="Batches expiring soon" tone="warning" /> : null}
            </View>
          )}

          {/* Overview */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Overview</Text>
            <View style={styles.statGrid}>
              <Stat styles={styles} label="Quantity" value={`${qtyIN(Number(row.quantity))} ${unit}`} />
              <Stat
                styles={styles}
                label="Reserved"
                value={Number(row.reserved) > 0 ? `${qtyIN(Number(row.reserved))} ${unit}` : '—'}
              />
              <Stat
                styles={styles}
                label="Available"
                value={`${qtyIN(Number(row.available))} ${unit}`}
                color={row.lowStock ? colors.destructive : colors.success}
              />
              {((row as any).materialType ?? 'item') === 'item' ? (
                <Stat styles={styles} label="Reorder level" value={qtyIN(Number(row.reorderLevel))} />
              ) : null}
              {mrp != null && mrp > 0 ? (
                <Stat styles={styles} label="MRP" value={formatMoney(mrp, { showPaise: true })} />
              ) : null}
              {itemCode ? <Stat styles={styles} label="Item code" value={itemCode} /> : null}
            </View>
            <View style={styles.badgeRow}>
              <StatusBadge label={TYPE_LABELS[materialType] ?? materialType} tone="muted" />
              {row.hsnCode ? <StatusBadge label={`HSN ${row.hsnCode}`} tone="muted" /> : null}
            </View>
          </View>

          {/* Valuation — only when the server's envelope grants it */}
          {canSeeValue && (row.avgCost != null || row.stockValue != null) ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Valuation</Text>
              <View style={styles.statGrid}>
                {row.avgCost != null ? (
                  <Stat styles={styles} label="Avg cost" value={formatMoney(Number(row.avgCost), { showPaise: true })} />
                ) : null}
                {row.stockValue != null ? (
                  <Stat styles={styles} label="Stock value" value={formatMoney(Number(row.stockValue), { showPaise: false })} />
                ) : null}
              </View>
            </View>
          ) : null}

          {/* Batches */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Batches</Text>
            {batchesQ.isLoading ? (
              <ActivityIndicator color={colors.primary} style={{ paddingVertical: 12 }} />
            ) : batches.length === 0 ? (
              <Text style={styles.mutedText}>No batch lots tracked for this stock.</Text>
            ) : (
              <View style={{ gap: 10 }}>
                {batches.map(b => (
                  <View key={b.id} style={styles.batchRow}>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={styles.batchName}>{b.batchNumber}</Text>
                      <Text style={styles.mutedSmall}>
                        Mfg {formatDate(b.mfgDate)} · Exp {formatDate(b.expiryDate)}
                      </Text>
                      {b.status !== 'ok' && b.status !== 'no_expiry' ? (
                        <StatusBadge label={b.bucketLabel || b.status} tone={batchTone(b.status)} />
                      ) : null}
                    </View>
                    <View style={{ alignItems: 'flex-end', gap: 2 }}>
                      <Text style={styles.batchQty}>
                        {qtyIN(b.quantity)} <Text style={styles.mutedSmall}>{b.unit}</Text>
                      </Text>
                      {Number(b.reserved) > 0 ? (
                        <Text style={styles.reservedSmall}>{qtyIN(b.reserved)} reserved</Text>
                      ) : null}
                    </View>
                  </View>
                ))}
              </View>
            )}
          </View>

          {/* Storage placements — warehouse rows only */}
          {row.branchType === 'warehouse' ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Storage</Text>
              {placements.length === 0 && unassigned <= 0 ? (
                <Text style={styles.mutedText}>No storage placements recorded.</Text>
              ) : (
                <View style={{ gap: 8 }}>
                  {placements.map((p, i) => (
                    <View key={`${p.name}:${i}`} style={styles.storageRow}>
                      <View style={styles.storageIcon}>
                        <Feather name="archive" size={14} color={colors.primary} />
                      </View>
                      <Text style={styles.storageName} numberOfLines={2}>{p.name}</Text>
                      <Text style={styles.storageQty}>{qtyIN(p.quantity)} {unit}</Text>
                    </View>
                  ))}
                  {unassigned > 0 ? (
                    <View style={styles.storageRow}>
                      <View style={[styles.storageIcon, { backgroundColor: colors.muted }]}>
                        <Feather name="help-circle" size={14} color={colors.mutedForeground} />
                      </View>
                      <Text style={[styles.storageName, { color: colors.mutedForeground }]}>Unassigned</Text>
                      <Text style={styles.storageQty}>{qtyIN(unassigned)} {unit}</Text>
                    </View>
                  ) : null}
                  {unassigned < 0 ? (
                    <Text style={styles.overAssigned}>
                      Storage map is over-assigned by {qtyIN(Math.abs(unassigned))} {unit} — more is placed than the
                      warehouse holds. Ask a manager to true it up on the web app.
                    </Text>
                  ) : null}
                </View>
              )}
            </View>
          ) : null}

          {/* Tracking timeline — the item's company-wide lifecycle (every
              location the caller may see), NOT just this stock row's site. */}
          <View style={styles.card}>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
              <Text style={styles.cardTitle}>History</Text>
              <Text style={styles.mutedSmall}>all locations</Text>
            </View>
            {trackingQ.isLoading ? (
              <ActivityIndicator color={colors.primary} style={{ paddingVertical: 12 }} />
            ) : trackingQ.isError ? (
              <Text style={styles.mutedText}>
                {(trackingQ.error as any)?.status === 403
                  ? 'Your role cannot view item history.'
                  : 'Could not load item history.'}
              </Text>
            ) : timeline.length === 0 ? (
              <Text style={styles.mutedText}>No recorded movements for this product yet.</Text>
            ) : (
              <View style={{ gap: 2 }}>
                {tracking?.summary ? (
                  <View style={[styles.badgeRow, { marginBottom: 10 }]}>
                    <StatusBadge label={`Bought ${qtyIN(tracking.summary.purchasedQty)}`} tone="muted" />
                    <StatusBadge label={`Sold ${qtyIN(tracking.summary.soldQty)}`} tone="muted" />
                    {tracking.summary.producedQty > 0 ? (
                      <StatusBadge label={`Produced ${qtyIN(tracking.summary.producedQty)}`} tone="muted" />
                    ) : null}
                    {tracking.summary.consumedQty > 0 ? (
                      <StatusBadge label={`Consumed ${qtyIN(tracking.summary.consumedQty)}`} tone="muted" />
                    ) : null}
                    <StatusBadge label={`Now ${qtyIN(tracking.summary.currentStock)}`} tone="info" />
                  </View>
                ) : null}
                {tracking?.summary?.truncated ? (
                  <Text style={[styles.mutedSmall, { marginBottom: 8 }]}>
                    Long history — only the most recent documents are shown, so the oldest
                    balance below is not an opening balance.
                  </Text>
                ) : null}
                {timeline.slice(0, shown).map(e => (
                  <View key={e.id} style={styles.eventRow}>
                    <View style={styles.eventIcon}>
                      <Feather name={e.icon} size={14} color={colors.mutedForeground} />
                    </View>
                    <View style={{ flex: 1, gap: 1 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <Text style={styles.eventTitle}>{e.title}</Text>
                        {e.flags.map(f => (
                          <StatusBadge key={f} label={f} tone="muted" />
                        ))}
                      </View>
                      <Text style={styles.mutedSmall} numberOfLines={2}>{e.sub}</Text>
                    </View>
                    <View style={{ alignItems: 'flex-end', gap: 1 }}>
                      {e.delta != null ? (
                        <Text
                          style={[
                            styles.eventQty,
                            { color: e.delta >= 0 ? colors.success : colors.destructive },
                          ]}
                        >
                          {e.delta >= 0 ? '+' : '−'}{qtyIN(Math.abs(e.delta))}
                        </Text>
                      ) : null}
                      {e.balance != null ? (
                        <Text style={styles.mutedSmall}>Bal {qtyIN(e.balance)}</Text>
                      ) : null}
                      <Text style={styles.mutedSmall}>{formatDate(e.date)}</Text>
                    </View>
                  </View>
                ))}
                {timeline.length > shown ? (
                  <Pressable onPress={() => setShown(s => s + PAGE_SIZE)} hitSlop={6} style={{ paddingTop: 8 }}>
                    <Text style={styles.moreLink}>Show {Math.min(PAGE_SIZE, timeline.length - shown)} more</Text>
                  </Pressable>
                ) : null}
              </View>
            )}
          </View>
        </View>
      )}
    </FormScreen>
  );
}

function Stat({
  styles,
  label,
  value,
  color,
}: {
  styles: ReturnType<typeof makeStyles>;
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, color ? { color } : null]}>{value}</Text>
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
      gap: 10,
    },
    cardTitle: { fontSize: 15, fontFamily: 'Outfit_600SemiBold', color: colors.foreground },
    flagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    stat: {
      minWidth: '30%',
      flexGrow: 1,
      backgroundColor: colors.muted,
      borderRadius: 10,
      paddingHorizontal: 10,
      paddingVertical: 8,
      gap: 2,
    },
    statLabel: {
      fontSize: 10,
      fontFamily: 'Outfit_500Medium',
      color: colors.mutedForeground,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    statValue: { fontSize: 14, fontFamily: 'Outfit_600SemiBold', color: colors.foreground },
    mutedText: { fontSize: 13, fontFamily: 'Outfit_400Regular', color: colors.mutedForeground },
    mutedSmall: { fontSize: 11, fontFamily: 'Outfit_400Regular', color: colors.mutedForeground },
    batchRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      paddingBottom: 8,
    },
    batchName: { fontSize: 13, fontFamily: 'Outfit_600SemiBold', color: colors.foreground },
    batchQty: { fontSize: 14, fontFamily: 'Outfit_700Bold', color: colors.foreground },
    reservedSmall: { fontSize: 10, fontFamily: 'Outfit_500Medium', color: colors.warning },
    storageRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    storageIcon: {
      width: 28,
      height: 28,
      borderRadius: 8,
      backgroundColor: colors.primary + '15',
      alignItems: 'center',
      justifyContent: 'center',
    },
    storageName: { flex: 1, fontSize: 13, fontFamily: 'Outfit_500Medium', color: colors.foreground },
    storageQty: { fontSize: 13, fontFamily: 'Outfit_600SemiBold', color: colors.foreground },
    overAssigned: { fontSize: 12, fontFamily: 'Outfit_400Regular', color: colors.destructive },
    eventRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 10,
      paddingVertical: 7,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    eventIcon: {
      width: 26,
      height: 26,
      borderRadius: 13,
      backgroundColor: colors.muted,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 1,
    },
    eventTitle: { fontSize: 13, fontFamily: 'Outfit_600SemiBold', color: colors.foreground },
    eventQty: { fontSize: 13, fontFamily: 'Outfit_700Bold' },
    moreLink: { fontSize: 13, fontFamily: 'Outfit_600SemiBold', color: colors.primary },
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
