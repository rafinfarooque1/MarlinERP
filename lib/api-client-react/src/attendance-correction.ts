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
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";

export type AttendanceStatus =
  | "present" | "half_day" | "absent" | "leave"
  | "company_holiday" | "weekly_off";

/** Which allowance a 'leave' day draws on. NULL/legacy rows count as casual. */
export type AttendanceLeaveType = "casual" | "sick";

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
