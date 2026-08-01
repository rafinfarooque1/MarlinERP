/**
 * Attendance correction.
 *
 * Attendance now decides how much salary a day earns, so a wrong attendance row
 * is a wrong number in the books. This is the only way to fix one: check-in and
 * check-out can create a row but never revise it, and an absent day has no row
 * at all — the list synthesises it for display.
 *
 * The server upserts on (employee, date) for that reason, and re-prices the
 * employee's open salary accruals afterwards, so a correction reaches the ledger
 * without anybody re-running payroll.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";

export type AttendanceStatus = "present" | "half_day" | "absent" | "leave";

export interface AttendanceRangeRow {
  id: number;
  employeeId: number;
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

/**
 * Attendance rows for an arbitrary date range (?from/?to, YYYY-MM-DD,
 * inclusive). Same row shape as the month mode (?year/?month) — records only,
 * no synthetic absent rows. Keyed under '/api/hr/attendance' so the
 * correction mutation's prefix invalidation refreshes range views too.
 */
export function useAttendanceRange(params: { from?: string; to?: string }) {
  const qs = new URLSearchParams();
  if (params.from) qs.set("from", params.from);
  if (params.to) qs.set("to", params.to);
  const key = qs.toString();
  return useQuery({
    queryKey: ["/api/hr/attendance", "range", key] as const,
    queryFn: ({ signal }) =>
      customFetch<AttendanceRangeRow[]>(`/api/hr/attendance?${key}`, { signal }),
    enabled: Boolean(params.from || params.to),
    placeholderData: (prev) => prev,
  });
}

export interface AttendanceCorrection {
  employeeId: number;
  date: string;
  status: AttendanceStatus;
  /** ISO timestamps. Omit to leave as-is; null to clear. */
  checkIn?: string | null;
  checkOut?: string | null;
}

export interface CorrectedAttendance {
  id: number;
  employeeId: number;
  employeeName: string;
  date: string;
  status: AttendanceStatus;
  checkIn: string | null;
  checkOut: string | null;
}

export function useCorrectAttendance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AttendanceCorrection) =>
      customFetch<CorrectedAttendance>("/api/hr/attendance", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      // A correction moves attendance AND money, so the accrual and payroll
      // screens are as stale as the attendance list itself. Matching on the
      // key's URL prefix catches every date/branch-filtered variant — a
      // hand-written key would match no live query and fail silently.
      const stale = [
        "/api/hr/attendance", "/api/hr/salary-accruals",
        "/api/hr/payroll", "/api/dashboard",
      ];
      qc.invalidateQueries({
        predicate: (query) => {
          const head = String((query.queryKey as readonly unknown[])[0] ?? "");
          return stale.some((s) => head.startsWith(s));
        },
      });
    },
  });
}
