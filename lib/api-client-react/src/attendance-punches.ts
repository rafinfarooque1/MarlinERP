/**
 * Multi-punch attendance.
 *
 * A day is no longer one check-in and one check-out: each work session is a
 * punch pair, and the day is paid on the TOTAL punched hours, not the
 * first-in → last-out span (the span would include the breaks between
 * sessions). The attendance row still carries first-in / last-out and status,
 * so everything that predates punches keeps working; these types add the punch
 * detail plus the register's derived figures, all computed server-side so this
 * client can never disagree with what the day is actually worth.
 *
 * Keyed under '/api/hr/attendance' so the correction mutation's prefix
 * invalidation refreshes these views too.
 */
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";
import type { AttendanceStatus } from "./attendance-correction";

export interface AttendancePunch {
  id: number;
  punchIn: string;
  punchOut: string | null;
  inLat: number | null;
  inLng: number | null;
  outLat: number | null;
  outLng: number | null;
}

/** The derived fields every attendance row now carries. */
export interface AttendanceDerived {
  punches: AttendancePunch[];
  /** Total closed-punch hours; span fallback for pre-punch rows. Null until priceable. */
  workingHours: number | null;
  /** Minutes past day-start + grace that the FIRST punch-in arrived. 0 = on time. */
  lateMinutes: number | null;
  /** Hours beyond the standard day. Null while a session is still open. */
  overtimeHours: number | null;
  /** Punch-in time of the currently open session, if any. */
  openPunchIn: string | null;
}

/** One register row (single-date mode: every active employee, synthetic absents included). */
export interface AttendanceRegisterRow extends AttendanceDerived {
  id: number | null;
  employeeId: number;
  employeeName: string;
  date: string;
  checkIn: string | null;
  checkOut: string | null;
  checkInLat: number | null;
  checkInLng: number | null;
  checkOutLat: number | null;
  checkOutLng: number | null;
  status: AttendanceStatus;
  hoursWorked: number | null;
}

/** Daily register — all active employees for one date. */
export function useAttendanceRegister(date: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["/api/hr/attendance", "register", date] as const,
    queryFn: ({ signal }) =>
      customFetch<AttendanceRegisterRow[]>(`/api/hr/attendance?date=${date}`, { signal }),
    enabled: options?.enabled ?? Boolean(date),
    placeholderData: (prev) => prev,
  });
}

/** Month rows (records only, no synthetic absents; non-HO callers see their own). */
export function useAttendanceMonth(
  year: number, month: number, options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: ["/api/hr/attendance", "month", year, month] as const,
    queryFn: ({ signal }) =>
      customFetch<Array<Omit<AttendanceRegisterRow, "employeeName">>>(
        `/api/hr/attendance?year=${year}&month=${month}`, { signal }),
    enabled: options?.enabled ?? true,
    placeholderData: (prev) => prev,
  });
}

/** Pay thresholds + register display settings, from company general settings. */
export interface AttendanceConfig {
  fullDayHours: number;
  halfDayHours: number;
  dayStartTime: string;      // "HH:MM"
  lateGraceMinutes: number;
  standardWorkHours: number; // overtime beyond this
  timeZone: string;
  /** The company's CURRENT operational date (YYYY-MM-DD in `timeZone`). Key
   * "today" views on this or on `timeZone` — never on the device calendar. */
  today: string;
}

export function useAttendanceConfig() {
  return useQuery({
    queryKey: ["/api/hr/attendance/config"] as const,
    queryFn: ({ signal }) => customFetch<AttendanceConfig>("/api/hr/attendance/config", { signal }),
    staleTime: 5 * 60_000,
  });
}
