import React, { useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/contexts/AuthContext';
import { ChangePasswordModal } from '@/components/ChangePasswordModal';
import { customFetch, useListEnrichedPayroll, useListAdvances } from '@workspace/api-client-react';

const MONTHS = [
  'Jan','Feb','Mar','Apr','May','Jun',
  'Jul','Aug','Sep','Oct','Nov','Dec',
];

function StatusBadge({ status }: { status: string }) {
  const colors = useColors();
  const cfg: Record<string, { bg: string; text: string; label: string }> = {
    paid:     { bg: colors.success + '20', text: colors.success, label: 'Paid' },
    approved: { bg: colors.primary + '20', text: colors.primary, label: 'Approved' },
    draft:    { bg: colors.warning + '20', text: colors.warning, label: 'Draft' },
  };
  const c = cfg[status] ?? cfg.draft;
  return (
    <View style={{ backgroundColor: c.bg, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
      <Text style={{ fontSize: 11, fontWeight: '600' as const, color: c.text, fontFamily: 'Outfit_600SemiBold' }}>
        {c.label}
      </Text>
    </View>
  );
}

interface LeaveBalance {
  tracked: boolean;
  casual: { allowed: number; taken: number; remaining: number };
  sick: { allowed: number; taken: number; remaining: number };
}

export default function HomeScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { employee, logout, markPasswordChanged } = useAuth();
  const [showPasswordModal, setShowPasswordModal] = useState(false);

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  const { token } = useAuth();

  const { data: payrollRecords, isLoading: payrollLoading, refetch: refetchPayroll } = useListEnrichedPayroll(
    { year: currentYear, month: currentMonth },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { query: { enabled: !!token } as any },
  );
  const { data: advances, isLoading: advLoading, refetch: refetchAdv } = useListAdvances(
    undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { query: { enabled: !!token } as any },
  );

  // This month's paid-leave balance (casual + sick remaining).
  const { data: leaveBal } = useQuery<LeaveBalance>({
    queryKey: ['leave-balance', currentYear, currentMonth],
    queryFn: () => customFetch<LeaveBalance>(`/api/hr/leave-balance?year=${currentYear}&month=${currentMonth}`),
    enabled: !!token,
    staleTime: 60_000,
  });
  const leavesLeft = leaveBal ? leaveBal.casual.remaining + leaveBal.sick.remaining : null;

  const myPayroll = payrollRecords?.[0] ?? null;

  // Live "Days Present" fallback: a payroll record only exists once payroll is
  // generated (usually at month end), so mid-month the tile would show a dash
  // for everyone. When there is no payroll yet, count this month's attendance
  // directly — same endpoint and query key as the Attendance tab, so the
  // cache is shared.
  const { data: monthAttendance } = useQuery<Array<{ status: string }>>({
    queryKey: ['attendance', 'month', currentYear, currentMonth],
    queryFn: () =>
      customFetch<Array<{ status: string }>>(`/api/hr/attendance?year=${currentYear}&month=${currentMonth}`),
    enabled: !!token && !payrollLoading && !myPayroll,
    staleTime: 60_000,
  });
  const livePresentDays = monthAttendance
    ? monthAttendance.filter((r) => r.status === 'present').length
    : null;
  const pendingAdvances = advances?.filter((a) => !a.isDeducted) ?? [];
  const pendingAdvTotal = pendingAdvances.reduce((s, a) => s + a.amount, 0);

  const onRefresh = () => { refetchPayroll(); refetchAdv(); };

  const styles = makeStyles(colors, insets);

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={payrollLoading || advLoading}
          onRefresh={onRefresh}
          tintColor={colors.primary}
        />
      }
    >
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.greeting}>
            Hello, {employee?.name?.split(' ')[0] ?? 'there'} 👋
          </Text>
          <Text style={styles.role}>
            {employee?.hierarchyName} · {employee?.branchName}
          </Text>
        </View>
        <Pressable
          style={({ pressed }) => [styles.logoutBtn, pressed && { opacity: 0.7 }]}
          onPress={logout}
          hitSlop={8}
        >
          <Feather name="log-out" size={20} color={colors.mutedForeground} />
        </Pressable>
      </View>

      {/* Password change warning — tappable, opens the in-app change flow */}
      {employee?.mustChangePassword ? (
        <Pressable
          style={({ pressed }) => [styles.warningBanner, pressed && { opacity: 0.8 }]}
          onPress={() => setShowPasswordModal(true)}
        >
          <Feather name="alert-triangle" size={14} color={colors.warning} />
          <Text style={styles.warningText}>
            Your password needs to be changed. Tap here to update it now.
          </Text>
          <Feather name="chevron-right" size={14} color={colors.warning} />
        </Pressable>
      ) : null}

      <ChangePasswordModal
        visible={showPasswordModal}
        onClose={() => setShowPasswordModal(false)}
        onChanged={markPasswordChanged}
      />

      {/* Current month payslip card */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>
          {MONTHS[currentMonth - 1]} {currentYear} Payslip
        </Text>
        {payrollLoading ? (
          <View style={styles.loadingCard}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : myPayroll ? (
          <Pressable
            style={({ pressed }) => [styles.payslipCard, pressed && { opacity: 0.92 }]}
            onPress={() => router.push('/(tabs)/payslips')}
          >
            <View style={styles.payslipRow}>
              <Text style={styles.payslipLabel}>Net Pay</Text>
              <StatusBadge status={myPayroll.status} />
            </View>
            <Text style={styles.payslipAmount}>
              ₹{myPayroll.netPay.toLocaleString('en-IN', { minimumFractionDigits: 0 })}
            </Text>
            <View style={styles.payslipMeta}>
              <Text style={styles.metaText}>
                {myPayroll.presentDays}/{myPayroll.workingDays} days present
              </Text>
              {myPayroll.lopDays > 0 && (
                <Text style={[styles.metaText, { color: colors.destructive }]}>
                  · {myPayroll.lopDays} LOP
                </Text>
              )}
            </View>
            <View style={styles.payslipDivider} />
            <View style={styles.payslipFooter}>
              <View style={styles.payslipStat}>
                <Text style={styles.statLabel}>Basic</Text>
                <Text style={styles.statValue}>
                  ₹{myPayroll.baseSalary.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                </Text>
              </View>
              <View style={styles.payslipStat}>
                <Text style={styles.statLabel}>Allowances</Text>
                <Text style={styles.statValue}>
                  +₹{myPayroll.allowancesTotal.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                </Text>
              </View>
              <View style={styles.payslipStat}>
                <Text style={styles.statLabel}>Deductions</Text>
                <Text style={[styles.statValue, { color: colors.destructive }]}>
                  −₹{myPayroll.deductions.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                </Text>
              </View>
            </View>
            <View style={styles.viewMoreRow}>
              <Text style={styles.viewMoreText}>View all payslips</Text>
              <Feather name="chevron-right" size={14} color={colors.primary} />
            </View>
          </Pressable>
        ) : (
          <View style={styles.emptyCard}>
            <Feather name="file-text" size={28} color={colors.mutedForeground} />
            <Text style={styles.emptyText}>No payslip for this month yet.</Text>
          </View>
        )}
      </View>

      {/* Quick stats */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Quick Info</Text>
        <View style={styles.statsRow}>
          <Pressable
            style={({ pressed }) => [styles.statCard, pressed && { opacity: 0.9 }]}
            onPress={() => router.push('/(tabs)/attendance')}
          >
            <View style={[styles.statIcon, { backgroundColor: colors.primary + '18' }]}>
              <Feather name="calendar" size={20} color={colors.primary} />
            </View>
            <Text style={styles.statCardValue}>{myPayroll?.presentDays ?? livePresentDays ?? '—'}</Text>
            <Text style={styles.statCardLabel}>Days Present</Text>
          </Pressable>

          <Pressable
            style={({ pressed }) => [styles.statCard, pressed && { opacity: 0.9 }]}
            onPress={() => router.push('/(tabs)/leaves')}
          >
            <View style={[styles.statIcon, { backgroundColor: colors.success + '18' }]}>
              <Feather name="clock" size={20} color={colors.success} />
            </View>
            <Text style={styles.statCardValue}>{leavesLeft ?? '—'}</Text>
            <Text style={styles.statCardLabel}>Paid Leaves Left</Text>
          </Pressable>

          <View style={styles.statCard}>
            <View style={[styles.statIcon, { backgroundColor: colors.warning + '18' }]}>
              <Feather name="trending-down" size={20} color={colors.warning} />
            </View>
            <Text style={styles.statCardValue}>
              {pendingAdvTotal > 0
                ? `₹${(pendingAdvTotal / 1000).toFixed(1)}k`
                : '₹0'}
            </Text>
            <Text style={styles.statCardLabel}>Advance Due</Text>
          </View>
        </View>
      </View>

      {/* Employee details */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>My Details</Text>
        <View style={styles.detailsCard}>
          {[
            { icon: 'user' as const, label: 'Name', value: employee?.name ?? '—' },
            { icon: 'tag' as const, label: 'Username', value: employee?.username ?? '—' },
            { icon: 'briefcase' as const, label: 'Role', value: employee?.hierarchyName ?? '—' },
            { icon: 'map-pin' as const, label: 'Branch', value: employee?.branchName ?? '—' },
            { icon: 'calendar' as const, label: 'Joined', value: employee?.joinDate ? new Date(employee.joinDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—' },
          ].map((item, idx, arr) => (
            <View key={item.label} style={[styles.detailRow, idx < arr.length - 1 && styles.detailBorder]}>
              <View style={styles.detailLeft}>
                <Feather name={item.icon} size={14} color={colors.mutedForeground} />
                <Text style={styles.detailLabel}>{item.label}</Text>
              </View>
              <Text style={styles.detailValue}>{item.value}</Text>
            </View>
          ))}
        </View>
      </View>
    </ScrollView>
  );
}

function makeStyles(colors: ReturnType<typeof useColors>, insets: { top: number; bottom: number }) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    content: {
      paddingTop: Platform.OS === 'web' ? insets.top + 67 : insets.top + 16,
      paddingBottom: insets.bottom + (Platform.OS === 'web' ? 34 : 100),
      paddingHorizontal: 16,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      marginBottom: 20,
    },
    greeting: {
      fontSize: 24,
      fontWeight: '700' as const,
      color: colors.foreground,
      fontFamily: 'Outfit_700Bold',
    },
    role: {
      fontSize: 13,
      color: colors.mutedForeground,
      marginTop: 3,
      fontFamily: 'Outfit_400Regular',
    },
    logoutBtn: {
      padding: 8,
      borderRadius: 8,
      backgroundColor: colors.muted,
      marginTop: 4,
    },
    warningBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: colors.warning + '18',
      borderRadius: 10,
      padding: 12,
      marginBottom: 16,
      borderWidth: 1,
      borderColor: colors.warning + '30',
    },
    warningText: {
      fontSize: 13,
      color: colors.warning,
      flex: 1,
      fontFamily: 'Outfit_400Regular',
    },
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
    loadingCard: {
      backgroundColor: colors.card,
      borderRadius: 16,
      padding: 32,
      alignItems: 'center',
      borderWidth: 1,
      borderColor: colors.border,
    },
    payslipCard: {
      backgroundColor: colors.card,
      borderRadius: 16,
      padding: 20,
      borderWidth: 1,
      borderColor: colors.border,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.05,
      shadowRadius: 8,
      elevation: 2,
    },
    payslipRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
    payslipLabel: { fontSize: 13, color: colors.mutedForeground, fontFamily: 'Outfit_400Regular' },
    payslipAmount: {
      fontSize: 36,
      fontWeight: '700' as const,
      color: colors.foreground,
      fontFamily: 'Outfit_700Bold',
      letterSpacing: -1,
      marginBottom: 4,
    },
    payslipMeta: { flexDirection: 'row', marginBottom: 16 },
    metaText: { fontSize: 13, color: colors.mutedForeground, fontFamily: 'Outfit_400Regular' },
    payslipDivider: { height: 1, backgroundColor: colors.border, marginBottom: 16 },
    payslipFooter: { flexDirection: 'row', justifyContent: 'space-between' },
    payslipStat: { alignItems: 'center' },
    statLabel: { fontSize: 11, color: colors.mutedForeground, fontFamily: 'Outfit_400Regular', marginBottom: 2 },
    statValue: { fontSize: 13, fontWeight: '600' as const, color: colors.foreground, fontFamily: 'Outfit_600SemiBold' },
    viewMoreRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: 4,
      marginTop: 16,
    },
    viewMoreText: { fontSize: 12, color: colors.primary, fontFamily: 'Outfit_500Medium' },
    emptyCard: {
      backgroundColor: colors.card,
      borderRadius: 16,
      padding: 32,
      alignItems: 'center',
      gap: 8,
      borderWidth: 1,
      borderColor: colors.border,
    },
    emptyText: { fontSize: 14, color: colors.mutedForeground, fontFamily: 'Outfit_400Regular' },
    statsRow: { flexDirection: 'row', gap: 12 },
    statCard: {
      flex: 1,
      backgroundColor: colors.card,
      borderRadius: 14,
      padding: 16,
      alignItems: 'center',
      gap: 6,
      borderWidth: 1,
      borderColor: colors.border,
    },
    statIcon: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 2,
    },
    statCardValue: {
      fontSize: 18,
      fontWeight: '700' as const,
      color: colors.foreground,
      fontFamily: 'Outfit_700Bold',
    },
    statCardLabel: {
      fontSize: 11,
      color: colors.mutedForeground,
      textAlign: 'center',
      fontFamily: 'Outfit_400Regular',
    },
    detailsCard: {
      backgroundColor: colors.card,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.border,
      overflow: 'hidden',
    },
    detailRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: 14,
    },
    detailBorder: { borderBottomWidth: 1, borderBottomColor: colors.border },
    detailLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    detailLabel: { fontSize: 13, color: colors.mutedForeground, fontFamily: 'Outfit_400Regular' },
    detailValue: { fontSize: 13, fontWeight: '500' as const, color: colors.foreground, fontFamily: 'Outfit_500Medium', maxWidth: '55%', textAlign: 'right' },
  });
}
