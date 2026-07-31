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
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";

export type AttendanceStatus = "present" | "half_day" | "absent" | "leave";

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
