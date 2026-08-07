/**
 * Company holidays & leave balances.
 *
 * Holidays are admin-defined paid days: every employee's tracked month pays
 * them with no attendance row and no leave consumed. A stored attendance row
 * for the date (a worked day, or a Fix Attendance correction) outvotes the
 * calendar per employee — that is the override mechanism. Creating or deleting
 * a holiday re-prices every open salary accrual on the server, so the money
 * screens are stale the moment either mutation lands.
 *
 * The leave balance is computed by the SAME month summary payroll prices on —
 * these hooks never hand-roll a count.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";

export interface CompanyHoliday {
  id: number;
  /** YYYY-MM-DD */
  date: string;
  name: string;
}

export function useCompanyHolidays(params?: { year?: number }) {
  const qs = params?.year ? `?year=${params.year}` : "";
  return useQuery({
    queryKey: ["/api/hr/holidays", params?.year ?? "all"] as const,
    queryFn: ({ signal }) => customFetch<CompanyHoliday[]>(`/api/hr/holidays${qs}`, { signal }),
  });
}

/** Everything a holiday write staled: the calendar, plus every money screen. */
function invalidateHolidayReaders(qc: ReturnType<typeof useQueryClient>) {
  const stale = [
    "/api/hr/holidays", "/api/hr/attendance", "/api/hr/leave-balance",
    "/api/hr/salary-accruals", "/api/hr/payroll", "/api/dashboard",
  ];
  qc.invalidateQueries({
    predicate: (query) => {
      const head = String((query.queryKey as readonly unknown[])[0] ?? "");
      return stale.some((s) => head.startsWith(s));
    },
  });
}

export function useCreateCompanyHoliday() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { date: string; name: string }) =>
      customFetch<CompanyHoliday>("/api/hr/holidays", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    onSuccess: () => invalidateHolidayReaders(qc),
  });
}

export function useDeleteCompanyHoliday() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      customFetch<{ ok: true }>(`/api/hr/holidays/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateHolidayReaders(qc),
  });
}

export interface LeaveBalanceSide {
  allowed: number;
  taken: number;
  remaining: number;
}

export interface LeaveBalance {
  employeeId: number;
  year: number;
  month: number;
  /** false = the month has no attendance rows yet (treated as full attendance). */
  tracked: boolean;
  casual: LeaveBalanceSide;
  sick: LeaveBalanceSide;
}

/**
 * Casual + sick allocated / taken / remaining for one employee-month. Non-Head
 * Office callers always receive their own balance whatever id they pass.
 */
export function useLeaveBalance(params: { employeeId?: number; year?: number; month?: number }) {
  const qs = new URLSearchParams();
  if (params.employeeId) qs.set("employeeId", String(params.employeeId));
  if (params.year) qs.set("year", String(params.year));
  if (params.month) qs.set("month", String(params.month));
  const key = qs.toString();
  return useQuery({
    queryKey: ["/api/hr/leave-balance", key] as const,
    queryFn: ({ signal }) =>
      customFetch<LeaveBalance>(`/api/hr/leave-balance${key ? `?${key}` : ""}`, { signal }),
  });
}
