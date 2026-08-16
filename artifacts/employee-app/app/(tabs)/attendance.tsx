import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { notify } from '@/lib/dialogs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Location from 'expo-location';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/contexts/AuthContext';
import { customFetch } from '@workspace/api-client-react';

const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];
const WEEK_DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

type AttendanceStatus =
  | 'present'
  | 'absent'
  | 'half_day'
  | 'leave'
  | 'company_holiday'
  | 'weekly_off';

/** The four statuses that count toward the monthly summary tiles. */
const CORE_STATS: AttendanceStatus[] = ['present', 'absent', 'half_day', 'leave'];

interface AttendancePunch {
  id: number;
  punchIn: string;
  punchOut: string | null;
}

interface AttendanceRow {
  id: number | null;
  employeeId: number;
  date: string;
  checkIn: string | null;
  checkOut: string | null;
  status: AttendanceStatus;
  hoursWorked: number | null;
  punches?: AttendancePunch[];
  workingHours?: number | null;
  lateMinutes?: number | null;
  overtimeHours?: number | null;
  openPunchIn?: string | null;
}

interface StatusConfig {
  bg: string;
  text: string;
  label: string;
}

function useStatusConfig(): Record<AttendanceStatus, StatusConfig> {
  const colors = useColors();
  return {
    present:         { bg: colors.success,     text: '#fff', label: 'Present' },
    absent:          { bg: colors.destructive, text: '#fff', label: 'Absent' },
    half_day:        { bg: colors.warning,     text: '#fff', label: 'Half Day' },
    leave:           { bg: colors.primary,     text: '#fff', label: 'Leave' },
    company_holiday: { bg: '#7c3aed',          text: '#fff', label: 'Holiday' },
    weekly_off:      { bg: '#64748b',          text: '#fff', label: 'Weekly Off' },
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

/**
 * Today in the COMPANY's operational timezone, never the handset's. A device
 * outside IST that uses its own calendar asks the register for the wrong day
 * around midnight — it can't see the open session the server is holding, and
 * a fresh check-in tap gets a 409. Falls back to the device date only if the
 * runtime lacks Intl timezone data.
 */
function companyTodayStr(timeZone?: string): string {
  try {
    return new Date().toLocaleDateString('en-CA', { timeZone: timeZone || 'Asia/Kolkata' });
  } catch {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }
}

/** Company timezone from the attendance config endpoint (cached; IST default). */
function useCompanyTimeZone(): string | undefined {
  const { token, employee } = useAuth();
  const { data } = useQuery<{ timeZone?: string }>({
    queryKey: ['attendance', 'config'],
    queryFn: () => customFetch<{ timeZone?: string }>(`/api/hr/attendance/config`),
    enabled: !!token && !!employee,
    staleTime: 60 * 60_000,
  });
  return data?.timeZone;
}

/** Closed-punch hours for a row (mirrors the server's total-punched-hours rule). */
function closedPunchHours(punches?: AttendancePunch[]): number {
  return (punches ?? []).reduce((s, p) =>
    p.punchOut ? s + Math.max(0, (new Date(p.punchOut).getTime() - new Date(p.punchIn).getTime()) / 3_600_000) : s, 0);
}

function formatDuration(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.floor((hours - h) * 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

/**
 * Today card — the check-in / check-out portal. Multi-punch: after checking
 * out, checking in again opens a new session; the day is paid on the total of
 * all sessions, so the ticker shows closed hours + the running session live.
 */
function TodayCard() {
  const colors = useColors();
  const { token, employee } = useAuth();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<null | 'in' | 'out'>(null);
  const [tick, setTick] = useState(0);

  const tz = useCompanyTimeZone();
  const todayStr = companyTodayStr(tz);
  const todayLabel = (() => {
    try {
      return new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz || 'Asia/Kolkata' });
    } catch {
      return new Date(`${todayStr}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
    }
  })();

  const { data: rows, isLoading } = useQuery<AttendanceRow[]>({
    queryKey: ['attendance', 'today', todayStr],
    queryFn: () => customFetch<AttendanceRow[]>(`/api/hr/attendance?date=${todayStr}`),
    enabled: !!token && !!employee,
    refetchInterval: 60_000,
  });
  const row = (rows ?? []).find((r) => r.employeeId === employee?.id) ?? null;
  const openPunchIn = row?.openPunchIn ?? null;

  // Live ticker only while a session is open.
  useEffect(() => {
    if (!openPunchIn) return;
    const t = setInterval(() => setTick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, [openPunchIn]);
  void tick;

  const closedHours = closedPunchHours(row?.punches);
  const liveHours = openPunchIn
    ? closedHours + Math.max(0, (Date.now() - new Date(openPunchIn).getTime()) / 3_600_000)
    : (row?.workingHours ?? closedHours);

  // Location is best-effort: an undecided permission prompt or a device with
  // no GPS fix must never block the punch itself, so the whole acquisition
  // races an 8-second deadline and the punch proceeds without coordinates.
  const getCoords = async (): Promise<{ lat: number; lng: number } | null> => {
    const acquire = async (): Promise<{ lat: number; lng: number } | null> => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return null;
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      return { lat: pos.coords.latitude, lng: pos.coords.longitude };
    };
    try {
      return await Promise.race([
        acquire(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
      ]);
    } catch {
      return null;
    }
  };

  const mark = useMutation({
    mutationFn: async (action: 'in' | 'out') => {
      const coords = await getCoords();
      return customFetch(`/api/hr/attendance/check-${action === 'in' ? 'in' : 'out'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employeeId: employee?.id, lat: coords?.lat ?? 0, lng: coords?.lng ?? 0 }),
      });
    },
    onSettled: () => {
      setBusy(null);
      queryClient.invalidateQueries({ queryKey: ['attendance'] });
    },
    onError: (e: any, action) => {
      notify(
        action === 'in' ? 'Check-in failed' : 'Check-out failed',
        e?.data?.error || e?.message || 'Something went wrong. Please try again.',
      );
    },
  });

  const handle = (action: 'in' | 'out') => {
    if (busy || mark.isPending) return;
    setBusy(action);
    mark.mutate(action);
  };

  const canIn = !openPunchIn && row?.status !== 'leave';
  const canOut = !!openPunchIn || !!(row?.checkIn && !row?.checkOut);

  const s = makeTodayStyles(colors);

  return (
    <View style={s.card}>
      <View style={s.headerRow}>
        <View>
          <Text style={s.title}>Today</Text>
          <Text style={s.subtitle}>
            {todayLabel}
          </Text>
        </View>
        {openPunchIn ? (
          <View style={s.livePill}>
            <View style={s.liveDot} />
            <Text style={s.livePillText}>Working</Text>
          </View>
        ) : null}
      </View>

      <View style={s.durationRow}>
        <Text style={[s.duration, openPunchIn ? { color: colors.success } : null]}>
          {formatDuration(liveHours)}
        </Text>
        <Text style={s.durationLabel}>worked today</Text>
      </View>

      {(row?.punches?.length ?? 0) > 0 && (
        <View style={s.punchList}>
          {row!.punches!.map((p) => (
            <View key={p.id} style={s.punchRow}>
              <Feather name="log-in" size={12} color={colors.success} />
              <Text style={s.punchText}>{formatTime(p.punchIn)}</Text>
              <Feather name="arrow-right" size={11} color={colors.mutedForeground} />
              {p.punchOut ? (
                <>
                  <Feather name="log-out" size={12} color={colors.destructive} />
                  <Text style={s.punchText}>{formatTime(p.punchOut)}</Text>
                </>
              ) : (
                <Text style={[s.punchText, { color: colors.success, fontFamily: 'Outfit_600SemiBold' }]}>now</Text>
              )}
            </View>
          ))}
        </View>
      )}

      {isLoading ? (
        <ActivityIndicator color={colors.primary} style={{ marginVertical: 8 }} />
      ) : (
        <View style={s.btnRow}>
          <Pressable
            onPress={() => handle('in')}
            disabled={!canIn || busy != null}
            style={[s.btn, { backgroundColor: canIn && !busy ? colors.success : colors.muted }]}
          >
            {busy === 'in' ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Feather name="log-in" size={16} color={canIn ? '#fff' : colors.mutedForeground} />
            )}
            <Text style={[s.btnText, { color: canIn && !busy ? '#fff' : colors.mutedForeground }]}>Check In</Text>
          </Pressable>
          <Pressable
            onPress={() => handle('out')}
            disabled={!canOut || busy != null}
            style={[s.btn, { backgroundColor: canOut && !busy ? colors.destructive : colors.muted }]}
          >
            {busy === 'out' ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Feather name="log-out" size={16} color={canOut ? '#fff' : colors.mutedForeground} />
            )}
            <Text style={[s.btnText, { color: canOut && !busy ? '#fff' : colors.mutedForeground }]}>Check Out</Text>
          </Pressable>
        </View>
      )}

      {row?.status === 'leave' && (
        <Text style={s.leaveNote}>You are on approved leave today.</Text>
      )}
      {row?.status === 'company_holiday' && (
        <Text style={s.leaveNote}>Today is a company holiday. You can still check in if you are working.</Text>
      )}
      {row?.status === 'weekly_off' && (
        <Text style={s.leaveNote}>Today is your weekly off. You can still check in if you are working.</Text>
      )}
    </View>
  );
}

function makeTodayStyles(colors: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    card: {
      backgroundColor: colors.card,
      borderRadius: 16,
      padding: 16,
      borderWidth: 1,
      borderColor: colors.border,
      marginBottom: 16,
    },
    headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
    title: { fontSize: 18, fontWeight: '700' as const, color: colors.foreground, fontFamily: 'Outfit_700Bold' },
    subtitle: { fontSize: 12, color: colors.mutedForeground, fontFamily: 'Outfit_400Regular', marginTop: 2 },
    livePill: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      backgroundColor: colors.success + '22',
      paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999,
    },
    liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.success },
    livePillText: { fontSize: 12, color: colors.success, fontFamily: 'Outfit_600SemiBold' },
    durationRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 14 },
    duration: { fontSize: 32, fontWeight: '700' as const, color: colors.foreground, fontFamily: 'Outfit_700Bold' },
    durationLabel: { fontSize: 12, color: colors.mutedForeground, fontFamily: 'Outfit_400Regular' },
    punchList: { marginTop: 10, gap: 4 },
    punchRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    punchText: { fontSize: 13, color: colors.foreground, fontFamily: 'Outfit_500Medium' },
    btnRow: { flexDirection: 'row', gap: 10, marginTop: 16 },
    btn: {
      flex: 1, flexDirection: 'row', gap: 8,
      alignItems: 'center', justifyContent: 'center',
      paddingVertical: 12, borderRadius: 12,
    },
    btnText: { fontSize: 14, fontWeight: '600' as const, fontFamily: 'Outfit_600SemiBold' },
    leaveNote: { marginTop: 10, fontSize: 12, color: colors.primary, fontFamily: 'Outfit_400Regular' },
  });
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

  // Summary stats (holiday / weekly-off rows exist but don't get a tile)
  const stats = useMemo(() => {
    const counts: Record<AttendanceStatus, number> = {
      present: 0, absent: 0, half_day: 0, leave: 0, company_holiday: 0, weekly_off: 0,
    };
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

  const companyTz = useCompanyTimeZone();
  const todayStr = companyTodayStr(companyTz);

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
      {/* Check-in / check-out portal */}
      <TodayCard />

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
        {CORE_STATS.map((key) => (
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
                    <Text style={styles.logTime}>
                      {formatTime(rec.checkIn)} → {rec.openPunchIn ? 'now' : formatTime(rec.checkOut)}
                    </Text>
                    <Text style={styles.logHours}>
                      {rec.workingHours != null
                        ? `${Number(rec.workingHours).toFixed(1)}h`
                        : calcHours(rec.checkIn, rec.checkOut)}
                      {(rec.punches?.length ?? 0) > 1 ? `  ·  ${rec.punches!.length} sessions` : ''}
                    </Text>
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
      paddingTop: Platform.OS === 'web' ? insets.top + 67 + 16 : insets.top + 16,
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
