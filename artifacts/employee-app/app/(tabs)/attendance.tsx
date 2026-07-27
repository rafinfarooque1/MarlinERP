import React, { useMemo, useState } from 'react';
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
import { useQuery } from '@tanstack/react-query';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/contexts/AuthContext';
import { customFetch } from '@workspace/api-client-react';

const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];
const WEEK_DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

type AttendanceStatus = 'present' | 'absent' | 'half_day' | 'leave';

interface AttendanceRow {
  id: number | null;
  employeeId: number;
  date: string;
  checkIn: string | null;
  checkOut: string | null;
  status: AttendanceStatus;
  hoursWorked: number | null;
}

interface StatusConfig {
  bg: string;
  text: string;
  label: string;
}

function useStatusConfig(): Record<AttendanceStatus, StatusConfig> {
  const colors = useColors();
  return {
    present:  { bg: colors.success,     text: '#fff', label: 'Present' },
    absent:   { bg: colors.destructive, text: '#fff', label: 'Absent' },
    half_day: { bg: colors.warning,     text: '#fff', label: 'Half Day' },
    leave:    { bg: colors.primary,     text: '#fff', label: 'Leave' },
  };
}

function formatTime(ts: string | null | undefined): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  } catch { return '—'; }
}

function calcHours(checkIn: string | null | undefined, checkOut: string | null | undefined): string {
  if (!checkIn || !checkOut) return '—';
  try {
    const diff = (new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 3_600_000;
    if (diff <= 0) return '—';
    return `${diff.toFixed(1)}h`;
  } catch { return '—'; }
}

interface DayCellProps {
  day: number | null;
  status?: AttendanceStatus;
  isToday?: boolean;
}

function DayCell({ day, status, isToday }: DayCellProps) {
  const colors = useColors();
  const statusCfg = useStatusConfig();
  if (!day) return <View style={{ flex: 1, margin: 2, height: 40 }} />;
  const cfg = status ? statusCfg[status] : null;
  return (
    <View
      style={{
        flex: 1, margin: 2, height: 40,
        borderRadius: 8,
        backgroundColor: cfg ? cfg.bg : colors.muted,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: isToday ? 2 : 0,
        borderColor: isToday ? colors.primary : 'transparent',
      }}
    >
      <Text style={{
        fontSize: 13,
        fontWeight: isToday ? '700' : '400',
        color: cfg ? cfg.text : colors.mutedForeground,
        fontFamily: isToday ? 'Outfit_700Bold' : 'Outfit_400Regular',
      }}>
        {day}
      </Text>
    </View>
  );
}

export default function AttendanceScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const statusCfg = useStatusConfig();
  const { token } = useAuth();

  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth()); // 0-indexed

  // Fetch month-level attendance via the new year+month API
  const { data: records, isLoading, refetch } = useQuery<AttendanceRow[]>({
    queryKey: ['attendance', 'month', year, month + 1],
    queryFn: () =>
      customFetch<AttendanceRow[]>(`/api/hr/attendance?year=${year}&month=${month + 1}`),
    enabled: !!token,
  });

  const recordByDate = useMemo(() => {
    const map = new Map<string, AttendanceRow>();
    (records ?? []).forEach((r) => {
      const d = typeof r.date === 'string' ? r.date : '';
      map.set(d.substring(0, 10), r);
    });
    return map;
  }, [records]);

  // Summary stats
  const stats = useMemo(() => {
    const counts: Record<AttendanceStatus, number> = { present: 0, absent: 0, half_day: 0, leave: 0 };
    (records ?? []).forEach((r) => {
      const s = r.status as AttendanceStatus;
      if (s in counts) counts[s]++;
    });
    return counts;
  }, [records]);

  // Calendar grid
  const calendarDays = useMemo(() => {
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const grid: Array<number | null> = [];
    for (let i = 0; i < firstDay; i++) grid.push(null);
    for (let d = 1; d <= daysInMonth; d++) grid.push(d);
    while (grid.length % 7 !== 0) grid.push(null);
    return grid;
  }, [year, month]);

  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;

  const goToPrev = () => {
    if (month === 0) { setMonth(11); setYear((y) => y - 1); }
    else setMonth((m) => m - 1);
  };
  const goToNext = () => {
    if (month === 11) { setMonth(0); setYear((y) => y + 1); }
    else setMonth((m) => m + 1);
  };

  // Sorted records for detail list
  const sortedRecords = useMemo(
    () => [...(records ?? [])].sort((a, b) => {
      const da = typeof a.date === 'string' ? a.date : '';
      const db = typeof b.date === 'string' ? b.date : '';
      return db.localeCompare(da);
    }),
    [records],
  );

  const styles = makeStyles(colors, insets);

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={isLoading} onRefresh={refetch} tintColor={colors.primary} />
      }
    >
      {/* Month nav */}
      <View style={styles.monthNav}>
        <Pressable onPress={goToPrev} style={styles.navBtn} hitSlop={8}>
          <Feather name="chevron-left" size={22} color={colors.foreground} />
        </Pressable>
        <Text style={styles.monthTitle}>{MONTHS[month]} {year}</Text>
        <Pressable onPress={goToNext} style={styles.navBtn} hitSlop={8}>
          <Feather name="chevron-right" size={22} color={colors.foreground} />
        </Pressable>
      </View>

      {/* Stats summary */}
      <View style={styles.statsRow}>
        {(Object.keys(statusCfg) as AttendanceStatus[]).map((key) => (
          <View key={key} style={styles.statItem}>
            <View style={[styles.statDot, { backgroundColor: statusCfg[key].bg }]} />
            <Text style={styles.statCount}>{stats[key] ?? 0}</Text>
            <Text style={styles.statLabel}>{statusCfg[key].label}</Text>
          </View>
        ))}
      </View>

      {/* Calendar */}
      <View style={styles.calendar}>
        {/* Week day headers */}
        <View style={styles.weekRow}>
          {WEEK_DAYS.map((d) => (
            <View key={d} style={{ flex: 1, alignItems: 'center', paddingBottom: 8 }}>
              <Text style={styles.weekDayText}>{d}</Text>
            </View>
          ))}
        </View>
        {/* Day grid */}
        {isLoading ? (
          <ActivityIndicator color={colors.primary} style={{ marginVertical: 24 }} />
        ) : (
          Array.from({ length: calendarDays.length / 7 }, (_, wi) => (
            <View key={wi} style={styles.weekRow}>
              {calendarDays.slice(wi * 7, wi * 7 + 7).map((day, di) => {
                const dateStr = day
                  ? `${year}-${String(month + 1).padStart(2,'0')}-${String(day).padStart(2,'0')}`
                  : null;
                const rec = dateStr ? recordByDate.get(dateStr) : undefined;
                return (
                  <DayCell
                    key={di}
                    day={day}
                    status={rec?.status}
                    isToday={dateStr === todayStr}
                  />
                );
              })}
            </View>
          ))
        )}
      </View>

      {/* Legend */}
      <View style={styles.legend}>
        {(Object.keys(statusCfg) as AttendanceStatus[]).map((key) => (
          <View key={key} style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: statusCfg[key].bg }]} />
            <Text style={styles.legendText}>{statusCfg[key].label}</Text>
          </View>
        ))}
      </View>

      {/* Detail list */}
      {sortedRecords.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Check-in Log</Text>
          <View style={styles.logCard}>
            {sortedRecords.map((rec, idx) => {
              const dateStr = typeof rec.date === 'string' ? rec.date : '';
              const cfg = statusCfg[rec.status] ?? statusCfg.absent;
              return (
                <View
                  key={rec.id ?? dateStr}
                  style={[styles.logRow, idx < sortedRecords.length - 1 && styles.logBorder]}
                >
                  <View style={styles.logLeft}>
                    <View style={[styles.logDot, { backgroundColor: cfg.bg }]} />
                    <View>
                      <Text style={styles.logDate}>
                        {new Date(dateStr + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}
                      </Text>
                      <Text style={styles.logStatus}>{cfg.label}</Text>
                    </View>
                  </View>
                  <View style={styles.logRight}>
                    <Text style={styles.logTime}>{formatTime(rec.checkIn)} → {formatTime(rec.checkOut)}</Text>
                    <Text style={styles.logHours}>{calcHours(rec.checkIn, rec.checkOut)}</Text>
                  </View>
                </View>
              );
            })}
          </View>
        </View>
      ) : !isLoading ? (
        <View style={styles.emptyContainer}>
          <Feather name="calendar" size={36} color={colors.mutedForeground} />
          <Text style={styles.emptyText}>No attendance records for this month.</Text>
        </View>
      ) : null}
    </ScrollView>
  );
}

function makeStyles(colors: ReturnType<typeof useColors>, insets: { top: number; bottom: number }) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    content: {
      paddingTop: Platform.OS === 'web' ? insets.top + 67 + 16 : 16,
      paddingBottom: insets.bottom + (Platform.OS === 'web' ? 34 : 100),
      paddingHorizontal: 16,
    },
    monthNav: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 16,
    },
    navBtn: { padding: 8, borderRadius: 8, backgroundColor: colors.muted },
    monthTitle: {
      fontSize: 20, fontWeight: '700' as const,
      color: colors.foreground, fontFamily: 'Outfit_700Bold',
    },
    statsRow: {
      flexDirection: 'row',
      backgroundColor: colors.card,
      borderRadius: 14,
      padding: 14,
      marginBottom: 16,
      borderWidth: 1,
      borderColor: colors.border,
      justifyContent: 'space-around',
    },
    statItem: { alignItems: 'center', gap: 4 },
    statDot: { width: 10, height: 10, borderRadius: 5 },
    statCount: {
      fontSize: 20, fontWeight: '700' as const,
      color: colors.foreground, fontFamily: 'Outfit_700Bold',
    },
    statLabel: { fontSize: 11, color: colors.mutedForeground, fontFamily: 'Outfit_400Regular' },
    calendar: {
      backgroundColor: colors.card,
      borderRadius: 16,
      padding: 12,
      borderWidth: 1,
      borderColor: colors.border,
      marginBottom: 12,
    },
    weekRow: { flexDirection: 'row' },
    weekDayText: {
      fontSize: 11, fontWeight: '600' as const,
      color: colors.mutedForeground, fontFamily: 'Outfit_600SemiBold',
    },
    legend: {
      flexDirection: 'row',
      flexWrap: 'wrap' as const,
      gap: 12,
      marginBottom: 24,
      paddingHorizontal: 4,
    },
    legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    legendDot: { width: 10, height: 10, borderRadius: 5 },
    legendText: { fontSize: 12, color: colors.mutedForeground, fontFamily: 'Outfit_400Regular' },
    section: { marginBottom: 24 },
    sectionTitle: {
      fontSize: 13, fontWeight: '600' as const, color: colors.mutedForeground,
      textTransform: 'uppercase' as const, letterSpacing: 0.6, marginBottom: 10,
      fontFamily: 'Outfit_600SemiBold',
    },
    logCard: {
      backgroundColor: colors.card, borderRadius: 14,
      borderWidth: 1, borderColor: colors.border, overflow: 'hidden',
    },
    logRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 14 },
    logBorder: { borderBottomWidth: 1, borderBottomColor: colors.border },
    logLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    logDot: { width: 10, height: 10, borderRadius: 5 },
    logDate: { fontSize: 14, fontWeight: '500' as const, color: colors.foreground, fontFamily: 'Outfit_500Medium' },
    logStatus: { fontSize: 12, color: colors.mutedForeground, fontFamily: 'Outfit_400Regular', marginTop: 1 },
    logRight: { alignItems: 'flex-end' },
    logTime: { fontSize: 12, color: colors.foreground, fontFamily: 'Outfit_500Medium' },
    logHours: { fontSize: 11, color: colors.mutedForeground, fontFamily: 'Outfit_400Regular', marginTop: 2 },
    emptyContainer: { alignItems: 'center', gap: 10, paddingVertical: 40 },
    emptyText: { fontSize: 14, color: colors.mutedForeground, fontFamily: 'Outfit_400Regular', textAlign: 'center' },
  });
}
