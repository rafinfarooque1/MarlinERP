import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { confirmDialog, notify } from '@/lib/dialogs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/contexts/AuthContext';
import { useListLeaves, useApplyLeave, useCancelLeave } from '@workspace/api-client-react';
import type { LeaveApplication } from '@workspace/api-client-react';

const LEAVE_TYPES = [
  { value: 'sick',    label: 'Sick Leave' },
  { value: 'casual',  label: 'Casual Leave' },
  { value: 'annual',  label: 'Annual Leave' },
  { value: 'other',   label: 'Other' },
] as const;

type LeaveType = typeof LEAVE_TYPES[number]['value'];

function StatusBadge({ status }: { status: string }) {
  const colors = useColors();
  const cfg: Record<string, { bg: string; text: string; label: string }> = {
    approved:  { bg: colors.success + '20', text: colors.success, label: 'Approved' },
    pending:   { bg: colors.warning + '20', text: colors.warning, label: 'Pending' },
    rejected:  { bg: colors.destructive + '20', text: colors.destructive, label: 'Rejected' },
    cancelled: { bg: colors.mutedForeground + '20', text: colors.mutedForeground, label: 'Cancelled' },
  };
  const c = cfg[status] ?? cfg.pending;
  return (
    <View style={{ backgroundColor: c.bg, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
      <Text style={{ fontSize: 11, fontWeight: '600' as const, color: c.text, fontFamily: 'Outfit_600SemiBold' }}>
        {c.label}
      </Text>
    </View>
  );
}

function formatDate(d: string | undefined | null): string {
  if (!d) return '—';
  try {
    const date = new Date(d + 'T00:00:00');
    return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return d; }
}

/** For ISO timestamps (approvedAt / cancelledAt) rather than plain dates. */
function formatTimestamp(ts: string | undefined | null): string {
  if (!ts) return '—';
  try {
    const date = new Date(ts);
    if (isNaN(date.getTime())) return '—';
    return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return '—'; }
}

function daysBetween(from: string, to: string): number {
  try {
    const a = new Date(from + 'T00:00:00');
    const b = new Date(to + 'T00:00:00');
    return Math.max(1, Math.round((b.getTime() - a.getTime()) / 86_400_000) + 1);
  } catch { return 1; }
}

function getTodayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface ApplyModalProps {
  visible: boolean;
  onClose: () => void;
  onSuccess: () => void;
  employeeId: number;
}

function ApplyModal({ visible, onClose, onSuccess, employeeId }: ApplyModalProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { mutateAsync: applyLeave, isPending } = useApplyLeave();

  const today = getTodayStr();
  const [fromDate, setFromDate] = useState(today);
  const [toDate, setToDate] = useState(today);
  const [leaveType, setLeaveType] = useState<LeaveType>('casual');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const validate = (): string | null => {
    if (!fromDate.match(/^\d{4}-\d{2}-\d{2}$/)) return 'From date must be YYYY-MM-DD';
    if (!toDate.match(/^\d{4}-\d{2}-\d{2}$/)) return 'To date must be YYYY-MM-DD';
    if (toDate < fromDate) return 'End date must be on or after start date';
    return null;
  };

  const handleSubmit = async () => {
    const err = validate();
    if (err) { setError(err); return; }
    setError(null);
    try {
      await applyLeave({
        data: {
          employeeId,
          fromDate,
          toDate,
          leaveType,
          reason: reason.trim() || undefined,
        },
      });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onSuccess();
    } catch (e: any) {
      const msg = e?.payload?.error ?? e?.message ?? 'Could not apply for leave';
      setError(msg);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  const styles = StyleSheet.create({
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
    sheet: {
      backgroundColor: colors.background,
      borderTopLeftRadius: 24, borderTopRightRadius: 24,
      paddingBottom: insets.bottom + 24,
      maxHeight: '90%',
    },
    handle: {
      width: 40, height: 4, borderRadius: 2,
      backgroundColor: colors.border,
      alignSelf: 'center',
      marginTop: 12, marginBottom: 8,
    },
    header: {
      flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
      paddingHorizontal: 20, paddingBottom: 12,
      borderBottomWidth: 1, borderBottomColor: colors.border,
    },
    title: { fontSize: 18, fontWeight: '700' as const, color: colors.foreground, fontFamily: 'Outfit_700Bold' },
    scrollContent: { padding: 20 },
    errorBox: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      backgroundColor: colors.destructive + '12',
      borderRadius: 8, padding: 12, marginBottom: 16,
      borderWidth: 1, borderColor: colors.destructive + '30',
    },
    errorText: { fontSize: 13, color: colors.destructive, flex: 1, fontFamily: 'Outfit_400Regular' },
    label: {
      fontSize: 13, fontWeight: '600' as const,
      color: colors.foreground, marginBottom: 8, fontFamily: 'Outfit_600SemiBold',
    },
    fieldGroup: { marginBottom: 16 },
    inputWrapper: {
      borderWidth: 1, borderColor: colors.border, borderRadius: 8,
      backgroundColor: colors.card, paddingHorizontal: 12, height: 48,
      justifyContent: 'center',
    },
    input: { fontSize: 15, color: colors.foreground, fontFamily: 'Outfit_400Regular' },
    typeRow: { flexDirection: 'row', flexWrap: 'wrap' as const, gap: 8 },
    typeChip: {
      paddingHorizontal: 14, paddingVertical: 8,
      borderRadius: 20, borderWidth: 1, borderColor: colors.border,
      backgroundColor: colors.card,
    },
    typeChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
    typeChipText: { fontSize: 13, color: colors.mutedForeground, fontFamily: 'Outfit_500Medium' },
    typeChipTextActive: { color: colors.primaryForeground, fontWeight: '600' as const },
    textarea: {
      borderWidth: 1, borderColor: colors.border, borderRadius: 8,
      backgroundColor: colors.card, padding: 12,
      fontSize: 15, color: colors.foreground,
      fontFamily: 'Outfit_400Regular',
      minHeight: 80, textAlignVertical: 'top' as const,
    },
    previewBox: {
      backgroundColor: colors.muted,
      borderRadius: 10, padding: 14, marginBottom: 20,
      flexDirection: 'row', justifyContent: 'center', gap: 6, alignItems: 'center',
    },
    previewText: { fontSize: 14, color: colors.foreground, fontFamily: 'Outfit_500Medium' },
    submitBtn: {
      backgroundColor: colors.primary, borderRadius: 12, height: 52,
      alignItems: 'center', justifyContent: 'center',
    },
    submitBtnDisabled: { opacity: 0.6 },
    submitBtnText: {
      color: colors.primaryForeground, fontSize: 16,
      fontWeight: '600' as const, fontFamily: 'Outfit_600SemiBold',
    },
  });

  const days = fromDate && toDate && toDate >= fromDate ? daysBetween(fromDate, toDate) : 0;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <Text style={styles.title}>Apply for Leave</Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <Feather name="x" size={20} color={colors.mutedForeground} />
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
            {error ? (
              <View style={styles.errorBox}>
                <Feather name="alert-circle" size={14} color={colors.destructive} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Leave Type</Text>
              <View style={styles.typeRow}>
                {LEAVE_TYPES.map((t) => (
                  <Pressable
                    key={t.value}
                    style={[styles.typeChip, leaveType === t.value && styles.typeChipActive]}
                    onPress={() => setLeaveType(t.value)}
                  >
                    <Text style={[styles.typeChipText, leaveType === t.value && styles.typeChipTextActive]}>
                      {t.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>From Date</Text>
              <View style={styles.inputWrapper}>
                <TextInput
                  style={styles.input}
                  value={fromDate}
                  onChangeText={(v) => { setFromDate(v); setError(null); }}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={colors.mutedForeground}
                  keyboardType="numbers-and-punctuation"
                  maxLength={10}
                />
              </View>
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>To Date</Text>
              <View style={styles.inputWrapper}>
                <TextInput
                  style={styles.input}
                  value={toDate}
                  onChangeText={(v) => { setToDate(v); setError(null); }}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={colors.mutedForeground}
                  keyboardType="numbers-and-punctuation"
                  maxLength={10}
                />
              </View>
            </View>

            {days > 0 && (
              <View style={styles.previewBox}>
                <Feather name="calendar" size={16} color={colors.primary} />
                <Text style={styles.previewText}>
                  {days} day{days !== 1 ? 's' : ''} leave
                </Text>
              </View>
            )}

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Reason (optional)</Text>
              <TextInput
                style={styles.textarea}
                value={reason}
                onChangeText={setReason}
                placeholder="Describe the reason for leave..."
                placeholderTextColor={colors.mutedForeground}
                multiline
                numberOfLines={3}
              />
            </View>

            <Pressable
              style={[styles.submitBtn, isPending && styles.submitBtnDisabled]}
              onPress={handleSubmit}
              disabled={isPending}
            >
              {isPending ? (
                <ActivityIndicator color={colors.primaryForeground} size="small" />
              ) : (
                <Text style={styles.submitBtnText}>Submit Application</Text>
              )}
            </Pressable>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export default function LeavesScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { employee } = useAuth();
  const [applyVisible, setApplyVisible] = useState(false);

  const { token } = useAuth();
  const { data: leaves, isLoading, refetch } = useListLeaves(
    {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { query: { enabled: !!token } as any },
  );
  const { mutateAsync: cancelLeave, isPending: cancelling } = useCancelLeave();

  const myLeaves = (leaves ?? []).filter((l) => l.employeeId === employee?.id);
  const sorted = [...myLeaves].sort((a, b) => b.id - a.id);

  const styles = makeStyles(colors, insets);

  const leaveTypeLabel: Record<string, string> = {
    sick: 'Sick Leave', casual: 'Casual Leave', annual: 'Annual Leave', other: 'Other',
  };

  const handleCancel = (item: LeaveApplication) => {
    confirmDialog({
      title: 'Cancel leave request?',
      message: `${leaveTypeLabel[item.leaveType] ?? item.leaveType} · ${formatDate(item.fromDate)}${item.fromDate !== item.toDate ? ` → ${formatDate(item.toDate)}` : ''}\n\nThis withdraws the request before it is reviewed.`,
      confirmText: 'Cancel request',
      cancelText: 'Keep request',
      destructive: true,
      onConfirm: async () => {
        try {
          await cancelLeave({ id: item.id });
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          refetch();
        } catch (e: any) {
          const msg = e?.payload?.error ?? e?.message ?? 'Could not cancel the request';
          notify('Cancel failed', msg);
          refetch();
        }
      },
    });
  };

  const renderItem = ({ item }: { item: LeaveApplication }) => (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View>
          <Text style={styles.cardTitle}>{leaveTypeLabel[item.leaveType] ?? item.leaveType}</Text>
          <Text style={styles.cardDates}>
            {formatDate(item.fromDate)}
            {item.fromDate !== item.toDate ? ` → ${formatDate(item.toDate)}` : ''}
            {' · '}{daysBetween(item.fromDate, item.toDate)} day{daysBetween(item.fromDate, item.toDate) !== 1 ? 's' : ''}
          </Text>
        </View>
        <StatusBadge status={item.status} />
      </View>
      {item.reason ? (
        <Text style={styles.cardReason}>{item.reason}</Text>
      ) : null}
      {(item.status === 'approved' || item.status === 'rejected') && item.approverName ? (
        <View style={styles.metaRow}>
          <Feather name="user-check" size={12} color={colors.mutedForeground} />
          <Text style={styles.metaText}>
            {item.status === 'approved' ? 'Approved' : 'Rejected'} by {item.approverName}
            {item.approvedAt ? ` · ${formatTimestamp(item.approvedAt)}` : ''}
          </Text>
        </View>
      ) : null}
      {item.status === 'cancelled' ? (
        <View style={styles.metaRow}>
          <Feather name="slash" size={12} color={colors.mutedForeground} />
          <Text style={styles.metaText}>
            Cancelled by you{item.cancelledAt ? ` · ${formatTimestamp(item.cancelledAt)}` : ''}
          </Text>
        </View>
      ) : null}
      {item.approvalNote ? (
        <View style={styles.noteBox}>
          <Feather name="message-square" size={12} color={colors.mutedForeground} />
          <Text style={styles.noteText}>
            {item.status === 'rejected' ? 'Reason: ' : ''}{item.approvalNote}
          </Text>
        </View>
      ) : null}
      {item.status === 'pending' ? (
        <Pressable
          style={({ pressed }) => [styles.cancelBtn, (pressed || cancelling) && { opacity: 0.7 }]}
          onPress={() => handleCancel(item)}
          disabled={cancelling}
        >
          <Feather name="x-circle" size={14} color={colors.destructive} />
          <Text style={styles.cancelBtnText}>Cancel request</Text>
        </Pressable>
      ) : null}
    </View>
  );

  return (
    <>
      <View style={styles.root}>
        {/* Apply button */}
        <View style={styles.topBar}>
          <Text style={styles.topBarTitle}>My Leaves</Text>
          <Pressable
            style={({ pressed }) => [styles.applyBtn, pressed && { opacity: 0.85 }]}
            onPress={() => { setApplyVisible(true); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
          >
            <Feather name="plus" size={16} color={colors.primaryForeground} />
            <Text style={styles.applyBtnText}>Apply</Text>
          </Pressable>
        </View>

        {isLoading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator color={colors.primary} size="large" />
          </View>
        ) : (
          <FlatList
            data={sorted}
            keyExtractor={(l) => String(l.id)}
            renderItem={renderItem}
            scrollEnabled={sorted.length > 0}
            refreshControl={
              <RefreshControl refreshing={isLoading} onRefresh={refetch} tintColor={colors.primary} />
            }
            contentContainerStyle={styles.listContent}
            ListEmptyComponent={
              <View style={styles.emptyContainer}>
                <Feather name="clock" size={40} color={colors.mutedForeground} />
                <Text style={styles.emptyTitle}>No leave applications</Text>
                <Text style={styles.emptySub}>Tap "Apply" above to request time off.</Text>
              </View>
            }
          />
        )}
      </View>

      <ApplyModal
        visible={applyVisible}
        onClose={() => setApplyVisible(false)}
        onSuccess={() => { setApplyVisible(false); refetch(); }}
        employeeId={employee?.id ?? 0}
      />
    </>
  );
}

function makeStyles(colors: ReturnType<typeof useColors>, insets: { top: number; bottom: number }) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    topBar: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingTop: Platform.OS === 'web' ? insets.top + 67 + 16 : 16,
      paddingBottom: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    topBarTitle: { fontSize: 22, fontWeight: '700' as const, color: colors.foreground, fontFamily: 'Outfit_700Bold' },
    applyBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      backgroundColor: colors.primary, borderRadius: 20,
      paddingHorizontal: 16, paddingVertical: 8,
    },
    applyBtnText: {
      color: colors.primaryForeground, fontSize: 14,
      fontWeight: '600' as const, fontFamily: 'Outfit_600SemiBold',
    },
    loadingContainer: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    listContent: {
      paddingHorizontal: 16, paddingTop: 12,
      paddingBottom: insets.bottom + (Platform.OS === 'web' ? 34 : 100),
      flexGrow: 1,
    },
    card: {
      backgroundColor: colors.card,
      borderRadius: 14, padding: 16,
      marginBottom: 10,
      borderWidth: 1, borderColor: colors.border,
    },
    cardHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      marginBottom: 8,
    },
    cardTitle: {
      fontSize: 15, fontWeight: '600' as const,
      color: colors.foreground, fontFamily: 'Outfit_600SemiBold',
    },
    cardDates: {
      fontSize: 12, color: colors.mutedForeground,
      fontFamily: 'Outfit_400Regular', marginTop: 3,
    },
    cardReason: {
      fontSize: 13, color: colors.foreground,
      fontFamily: 'Outfit_400Regular',
      lineHeight: 18,
    },
    noteBox: {
      flexDirection: 'row', alignItems: 'flex-start', gap: 6,
      backgroundColor: colors.muted, borderRadius: 8, padding: 10, marginTop: 10,
    },
    metaRow: {
      flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8,
    },
    metaText: {
      fontSize: 12, color: colors.mutedForeground,
      fontFamily: 'Outfit_400Regular', flex: 1,
    },
    cancelBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
      marginTop: 12, paddingVertical: 9, borderRadius: 8,
      borderWidth: 1, borderColor: colors.destructive + '40',
      backgroundColor: colors.destructive + '0D',
    },
    cancelBtnText: {
      fontSize: 13, color: colors.destructive,
      fontWeight: '600' as const, fontFamily: 'Outfit_600SemiBold',
    },
    noteText: {
      fontSize: 12, color: colors.mutedForeground,
      fontFamily: 'Outfit_400Regular', flex: 1,
    },
    emptyContainer: {
      flex: 1, alignItems: 'center', justifyContent: 'center',
      paddingTop: 80, gap: 10,
    },
    emptyTitle: {
      fontSize: 18, fontWeight: '600' as const,
      color: colors.foreground, fontFamily: 'Outfit_600SemiBold',
    },
    emptySub: {
      fontSize: 14, color: colors.mutedForeground,
      fontFamily: 'Outfit_400Regular', textAlign: 'center',
    },
  });
}
