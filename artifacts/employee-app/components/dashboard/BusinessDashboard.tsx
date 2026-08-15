import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useErpPermissions, PAGE } from '@/hooks/useErpPermissions';
import { useLocationContext } from '@/contexts/LocationContext';
import { localYmd, shiftYmd } from '@/lib/localDate';
import { formatMoney } from '@/components/ui/MoneyText';
import {
  useGetDashboardBi,
  useDispatchQueue,
  type DashboardBiFilters,
} from '@workspace/api-client-react';

/**
 * Business dashboard for the mobile Home screen.
 *
 * Mirrors the web dashboard (marlin-erp/src/pages/dashboard/Dashboard.tsx)
 * figure-for-figure — every KPI reads the SAME field of the same
 * GET /api/dashboard/bi response the web tiles read, so the two can never
 * disagree for the same period and location:
 *   • Sales/Purchases    → sales.total / purchases.total (document totals)
 *   • Receipts/Payments  → moneyFlows.totalIn/.totalOut (cash+bank ledger flows)
 *   • Receivables        → receivables.total (Sundry Debtors, ledger basis)
 *   • Payables           → payables.allPayables (suppliers + salary + rent)
 *   • Cash/Bank          → cash.balance / bank.balance (posting balances)
 *   • Inventory          → inventory.valuation (ABSENT without the valuation
 *                          right — the card is hidden, never shown as zero)
 *   • GP/NP              → profit.gross/.net (same P&L build as the report)
 * Accounting figures are null when the server has no honest figure for the
 * current scope; those cards show an em-dash, matching the web.
 *
 * Period presets mirror the web RangeBar: Today, Week = last 7 days,
 * Month = 1st of this month → today. Location comes from the global
 * LocationContext; warehouse/outlet selections are passed as explicit query
 * params (exactly like the web's locationFilterParams) so the react-query key
 * changes — and the figures refetch — whenever the scope changes.
 *
 * Permission gating here is display-only; the backend re-checks every call.
 */

type Period = 'today' | 'week' | 'month';

const PERIODS: { value: Period; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
];

/** Rounded-rupee figure for the small breakdown lines (web's `rup`). */
function rup(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

type Tone = 'default' | 'pos' | 'neg' | 'warn' | 'info';

interface KpiCard {
  key: string;
  label: string;
  icon: React.ComponentProps<typeof Feather>['name'];
  value: string;
  tone: Tone;
  /** Small secondary line under the value (e.g. counts or a Cash/Bank split). */
  sub?: string;
  /** Present only when the target module exists on mobile AND the user may view it. */
  onPress?: () => void;
}

export function BusinessDashboard() {
  const { ready, canView } = useErpPermissions();
  // Employee-only users (and anyone without the dashboard page right) keep
  // the plain Home — the section, and its BI fetch, never mount.
  if (!ready || !canView(PAGE.dashboard)) return null;
  return <DashboardInner />;
}

function DashboardInner() {
  const colors = useColors();
  const { perm, canView } = useErpPermissions();
  const { location } = useLocationContext();
  const [period, setPeriod] = useState<Period>('today');

  const filters = useMemo<DashboardBiFilters>(() => {
    const today = localYmd();
    const f: DashboardBiFilters =
      period === 'today'
        ? { fromDate: today, toDate: today }
        : period === 'week'
          ? { fromDate: shiftYmd(today, -6), toDate: today }
          : { fromDate: `${today.slice(0, 7)}-01`, toDate: today };
    // Mirror of the web's locationFilterParams: explicit params (not just the
    // ambient headers) so the query key — and therefore the cache slot —
    // tracks the selected location. Head Office matches on type alone.
    if ((location.locationType === 'warehouse' || location.locationType === 'outlet') && location.locationId) {
      f.locationType = location.locationType;
      f.locationId = location.locationId;
    } else if (location.locationType === 'headoffice') {
      f.locationType = 'headoffice';
    }
    return f;
  }, [period, location.locationType, location.locationId]);

  const { data: bi, isLoading, isError } = useGetDashboardBi(filters);

  const styles = makeStyles(colors);

  const toneColor = (t: Tone): string =>
    t === 'pos' ? colors.success
    : t === 'neg' ? colors.destructive
    : t === 'warn' ? colors.warning
    : t === 'info' ? colors.primary
    : colors.foreground;

  const s = bi?.sales;
  const mf = bi?.moneyFlows;
  const pf = bi?.profit;
  // allPayables/salaryPayable/rentPayable exist on the wire but not yet in the
  // generated type — same cast the web dashboard uses.
  const pay = bi?.payables as (typeof bi extends undefined ? never : NonNullable<typeof bi>['payables'] & {
    allPayables?: number | null; salaryPayable?: number | null; rentPayable?: number | null;
  }) | undefined;

  const canSeeSales = canView(PAGE.sales);
  const canSeeStock = canView(PAGE.stock);
  const canSeeDispatch = canView(PAGE.dispatch);
  const canSeeReceipts = canView(PAGE.receiptVoucher);
  const canSeePayments = canView(PAGE.paymentVoucher);

  const cards: KpiCard[] = bi
    ? [
        {
          key: 'sales', label: 'Sales', icon: 'trending-up',
          value: formatMoney(s?.total ?? 0), tone: 'pos',
          sub: `${s?.count ?? 0} invoice${(s?.count ?? 0) === 1 ? '' : 's'}`,
          onPress: canSeeSales ? () => router.push('/(tabs)/sales') : undefined,
        },
        {
          key: 'purchases', label: 'Purchases', icon: 'shopping-cart',
          value: formatMoney(bi.purchases.total), tone: 'default',
          sub: `${bi.purchases.count} bill${bi.purchases.count === 1 ? '' : 's'}`,
        },
        {
          key: 'receipts', label: 'Receipts', icon: 'arrow-down-circle',
          value: mf == null ? '—' : formatMoney(mf.totalIn),
          tone: mf != null && mf.totalIn > 0 ? 'pos' : 'default',
          sub: mf == null ? undefined : `Cash ${rup(mf.cashIn)} · Bank ${rup(mf.bankIn)}`,
          onPress: canSeeReceipts ? () => router.push('/receipt-vouchers') : undefined,
        },
        {
          key: 'payments', label: 'Payments', icon: 'arrow-up-circle',
          value: mf == null ? '—' : formatMoney(mf.totalOut),
          tone: mf != null && mf.totalOut > 0 ? 'neg' : 'default',
          sub: mf == null ? undefined : `Cash ${rup(mf.cashOut)} · Bank ${rup(mf.bankOut)}`,
          onPress: canSeePayments ? () => router.push('/payment-vouchers') : undefined,
        },
        {
          key: 'receivables', label: 'Receivables', icon: 'download',
          value: bi.receivables.total == null ? '—' : formatMoney(bi.receivables.total),
          tone: bi.receivables.total == null ? 'default' : (bi.receivables.overdue ?? 0) > 0 ? 'warn' : 'info',
          sub: (bi.receivables.overdue ?? 0) > 0 ? `${rup(bi.receivables.overdue)} overdue` : undefined,
        },
        {
          key: 'payables', label: 'Payables', icon: 'upload',
          value: pay?.allPayables == null ? '—' : formatMoney(pay.allPayables),
          tone: pay?.allPayables == null ? 'default' : 'neg',
          sub: pay?.salaryPayable != null
            ? `Suppliers ${rup(bi.payables.total ?? 0)} · Salary ${rup(pay.salaryPayable)}`
            : undefined,
        },
        {
          key: 'cash', label: 'Cash', icon: 'dollar-sign',
          value: bi.cash.balance == null ? '—' : formatMoney(bi.cash.balance),
          tone: bi.cash.balance == null ? 'default' : bi.cash.balance >= 0 ? 'pos' : 'neg',
        },
        {
          key: 'bank', label: 'Bank', icon: 'credit-card',
          value: bi.bank.balance == null ? '—' : formatMoney(bi.bank.balance),
          tone: bi.bank.balance == null ? 'default' : bi.bank.balance >= 0 ? 'pos' : 'neg',
        },
        // Inventory valuation is ABSENT (not zero) without the right — hide the card.
        ...(bi.canViewValuation && bi.inventory.valuation != null
          ? [{
              key: 'inventory', label: 'Inventory Value', icon: 'box' as const,
              value: formatMoney(bi.inventory.valuation), tone: 'info' as Tone,
              sub: `${bi.inventory.itemCount} items in stock`,
              onPress: canSeeStock ? () => router.push('/(tabs)/stock') : undefined,
            }]
          : []),
        // GP/NP always render; a null figure (no honest number for this
        // scope) shows an em-dash — matching the web dashboard tiles.
        {
          key: 'gp', label: 'Gross Profit', icon: 'pie-chart',
          value: pf?.gross == null ? '—' : formatMoney(pf.gross),
          tone: pf?.gross == null ? 'default' : pf.gross >= 0 ? 'pos' : 'neg',
        },
        {
          key: 'np', label: 'Net Profit', icon: 'bar-chart-2',
          value: pf?.net == null ? '—' : formatMoney(pf.net),
          tone: pf?.net == null ? 'default' : pf.net >= 0 ? 'pos' : 'neg',
        },
      ]
    : [];

  interface QuickAction { key: string; label: string; icon: React.ComponentProps<typeof Feather>['name']; onPress: () => void }
  const actions: QuickAction[] = [
    ...(perm(PAGE.sales).canAdd
      ? [{ key: 'new-sale', label: 'New Sale', icon: 'plus-circle' as const, onPress: () => router.push('/new-sale') }] : []),
    ...(canSeeStock
      ? [{ key: 'stock', label: 'Stock', icon: 'box' as const, onPress: () => router.push('/(tabs)/stock') }] : []),
    ...(canSeeDispatch
      ? [{ key: 'dispatch', label: 'Dispatch', icon: 'truck' as const, onPress: () => router.push('/(tabs)/dispatch') }] : []),
    ...(perm(PAGE.receiptVoucher).canAdd
      ? [{ key: 'receipt', label: 'Receipt', icon: 'arrow-down-circle' as const,
          onPress: () => router.push({ pathname: '/voucher-new', params: { kind: 'receipt' } }) }] : []),
    ...(perm(PAGE.paymentVoucher).canAdd
      ? [{ key: 'payment', label: 'Payment', icon: 'arrow-up-circle' as const,
          onPress: () => router.push({ pathname: '/voucher-new', params: { kind: 'payment' } }) }] : []),
  ];

  const topItems = (bi?.topItems ?? []).slice(0, 5);
  const topItemMax = Math.max(1, ...topItems.map(i => i.revenue));

  return (
    <View style={styles.section}>
      {/* ── Header: title + scope + period chips ── */}
      <Text style={styles.sectionTitle}>Business Dashboard</Text>
      <View style={styles.headerRow}>
        <View style={styles.scopeRow}>
          <Feather name="map-pin" size={12} color={colors.mutedForeground} />
          <Text style={styles.scopeText} numberOfLines={1}>
            {bi?.scope.label ?? location.locationName}
          </Text>
        </View>
        <View style={styles.chipRow}>
          {PERIODS.map(p => (
            <Pressable
              key={p.value}
              onPress={() => setPeriod(p.value)}
              style={[styles.chip, period === p.value && { backgroundColor: colors.primary }]}
            >
              <Text style={[styles.chipText, period === p.value && { color: colors.primaryForeground }]}>
                {p.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {isError ? (
        <View style={styles.errorCard}>
          <Feather name="alert-circle" size={16} color={colors.destructive} />
          <Text style={styles.errorText}>Could not load dashboard figures. Pull down to retry.</Text>
        </View>
      ) : isLoading || !bi ? (
        <View style={styles.loadingCard}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : (
        <>
          {/* ── KPI cards, two per row ── */}
          <View style={styles.grid}>
            {cards.map(c => {
              const inner = (
                <>
                  <View style={styles.cardHead}>
                    <Feather name={c.icon} size={14} color={colors.mutedForeground} />
                    <Text style={styles.cardLabel}>{c.label}</Text>
                    {c.onPress ? (
                      <Feather name="chevron-right" size={13} color={colors.mutedForeground} style={{ marginLeft: 'auto' }} />
                    ) : null}
                  </View>
                  <Text style={[styles.cardValue, { color: toneColor(c.tone) }]} numberOfLines={1} adjustsFontSizeToFit>
                    {c.value}
                  </Text>
                  {c.sub ? <Text style={styles.cardSub} numberOfLines={1}>{c.sub}</Text> : null}
                </>
              );
              return c.onPress ? (
                <Pressable
                  key={c.key}
                  onPress={c.onPress}
                  style={({ pressed }) => [styles.card, pressed && { opacity: 0.88 }]}
                >
                  {inner}
                </Pressable>
              ) : (
                <View key={c.key} style={styles.card}>{inner}</View>
              );
            })}
          </View>

          {/* ── Quick actions ── */}
          {actions.length > 0 && (
            <View style={styles.actionsRow}>
              {actions.map(a => (
                <Pressable
                  key={a.key}
                  onPress={a.onPress}
                  style={({ pressed }) => [styles.actionBtn, pressed && { opacity: 0.85 }]}
                >
                  <Feather name={a.icon} size={16} color={colors.primary} />
                  <Text style={styles.actionText}>{a.label}</Text>
                </Pressable>
              ))}
            </View>
          )}

          {/* ── Business insights ── */}
          <View style={styles.insightsCard}>
            <Text style={styles.insightsTitle}>Business Insights</Text>

            <View style={styles.insightRowGroup}>
              <InsightStat
                icon="alert-triangle"
                color={bi.inventory.lowStockCount > 0 ? colors.warning : colors.mutedForeground}
                value={bi.inventory.lowStockCount}
                label="Low stock"
                onPress={canSeeStock ? () => router.push('/(tabs)/stock') : undefined}
              />
              <InsightStat
                icon="clock"
                color={bi.inventory.expiringSoonCount > 0 ? colors.warning : colors.mutedForeground}
                value={bi.inventory.expiringSoonCount}
                label="Expiring ≤ 30d"
                onPress={canSeeStock ? () => router.push('/(tabs)/stock') : undefined}
              />
              {canSeeDispatch ? <PendingDispatchStat /> : null}
            </View>

            {topItems.length > 0 && (
              <View style={styles.topItemsBlock}>
                <Text style={styles.topItemsTitle}>Top items</Text>
                {topItems.map(item => (
                  <View key={item.itemId} style={styles.topItemRow}>
                    <Text style={styles.topItemName} numberOfLines={1}>{item.name}</Text>
                    <Text style={styles.topItemRevenue}>{rup(item.revenue)}</Text>
                    <View style={styles.topItemBarTrack}>
                      <View
                        style={[styles.topItemBarFill, {
                          backgroundColor: colors.primary,
                          width: `${Math.max(3, Math.round((item.revenue / topItemMax) * 100))}%`,
                        }]}
                      />
                    </View>
                  </View>
                ))}
              </View>
            )}
          </View>
        </>
      )}
    </View>
  );
}

/**
 * Pending-dispatch count — its own component so the queue fetch only runs for
 * users who may view the dispatch module. Server-filtered to PENDING, same
 * endpoint the Dispatch tab reads.
 */
function PendingDispatchStat() {
  const colors = useColors();
  const { data: queue } = useDispatchQueue({ status: 'PENDING' });
  const count = queue?.length ?? 0;
  return (
    <InsightStat
      icon="truck"
      color={count > 0 ? colors.primary : colors.mutedForeground}
      value={queue == null ? '—' : count}
      label="To dispatch"
      onPress={() => router.push('/(tabs)/dispatch')}
    />
  );
}

function InsightStat({ icon, color, value, label, onPress }: {
  icon: React.ComponentProps<typeof Feather>['name'];
  color: string;
  value: number | string;
  label: string;
  onPress?: () => void;
}) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const body = (
    <>
      <Feather name={icon} size={16} color={color} />
      <Text style={styles.insightValue}>{value}</Text>
      <Text style={styles.insightLabel}>{label}</Text>
    </>
  );
  return onPress ? (
    <Pressable style={({ pressed }) => [styles.insightStat, pressed && { opacity: 0.85 }]} onPress={onPress}>
      {body}
    </Pressable>
  ) : (
    <View style={styles.insightStat}>{body}</View>
  );
}

function makeStyles(colors: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    section: { marginBottom: 24 },
    sectionTitle: {
      fontSize: 13,
      fontWeight: '600' as const,
      color: colors.mutedForeground,
      marginBottom: 10,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
      fontFamily: 'Outfit_600SemiBold',
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
      marginBottom: 10,
    },
    scopeRow: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1 },
    scopeText: { fontSize: 12, color: colors.mutedForeground, fontFamily: 'Outfit_400Regular', flexShrink: 1 },
    chipRow: {
      flexDirection: 'row',
      backgroundColor: colors.muted,
      borderRadius: 10,
      padding: 3,
      gap: 2,
    },
    chip: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 8 },
    chipText: { fontSize: 12, color: colors.mutedForeground, fontFamily: 'Outfit_600SemiBold' },
    loadingCard: {
      backgroundColor: colors.card,
      borderRadius: 16,
      padding: 32,
      alignItems: 'center',
      borderWidth: 1,
      borderColor: colors.border,
    },
    errorCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: colors.destructive + '10',
      borderWidth: 1,
      borderColor: colors.destructive + '30',
      borderRadius: 12,
      padding: 14,
    },
    errorText: { fontSize: 13, color: colors.destructive, flex: 1, fontFamily: 'Outfit_400Regular' },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
    card: {
      flexBasis: '47%',
      flexGrow: 1,
      backgroundColor: colors.card,
      borderRadius: 14,
      padding: 14,
      borderWidth: 1,
      borderColor: colors.border,
      gap: 4,
    },
    cardHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    cardLabel: { fontSize: 12, color: colors.mutedForeground, fontFamily: 'Outfit_500Medium' },
    cardValue: {
      fontSize: 20,
      fontWeight: '700' as const,
      fontFamily: 'Outfit_700Bold',
      letterSpacing: -0.4,
    },
    cardSub: { fontSize: 11, color: colors.mutedForeground, fontFamily: 'Outfit_400Regular' },
    actionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
    actionBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: colors.primary + '12',
      borderWidth: 1,
      borderColor: colors.primary + '25',
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    actionText: { fontSize: 13, color: colors.primary, fontFamily: 'Outfit_600SemiBold' },
    insightsCard: {
      backgroundColor: colors.card,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 14,
      marginTop: 12,
    },
    insightsTitle: {
      fontSize: 12,
      color: colors.mutedForeground,
      fontFamily: 'Outfit_600SemiBold',
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginBottom: 10,
    },
    insightRowGroup: { flexDirection: 'row', gap: 10 },
    insightStat: {
      flex: 1,
      alignItems: 'center',
      gap: 3,
      backgroundColor: colors.muted,
      borderRadius: 10,
      paddingVertical: 10,
      paddingHorizontal: 6,
    },
    insightValue: { fontSize: 16, fontWeight: '700' as const, color: colors.foreground, fontFamily: 'Outfit_700Bold' },
    insightLabel: { fontSize: 10, color: colors.mutedForeground, fontFamily: 'Outfit_400Regular', textAlign: 'center' },
    topItemsBlock: { marginTop: 14 },
    topItemsTitle: {
      fontSize: 12,
      color: colors.mutedForeground,
      fontFamily: 'Outfit_600SemiBold',
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginBottom: 8,
    },
    topItemRow: { marginBottom: 8 },
    topItemName: { fontSize: 13, color: colors.foreground, fontFamily: 'Outfit_500Medium' },
    topItemRevenue: {
      position: 'absolute',
      right: 0,
      top: 0,
      fontSize: 12,
      color: colors.mutedForeground,
      fontFamily: 'Outfit_600SemiBold',
    },
    topItemBarTrack: {
      height: 5,
      backgroundColor: colors.muted,
      borderRadius: 3,
      marginTop: 4,
      overflow: 'hidden',
    },
    topItemBarFill: { height: 5, borderRadius: 3 },
  });
}
