/**
 * Manual hooks for payroll enhancements (pay components + payroll generation + advances).
 * These supplement the auto-generated hooks in generated/api.ts.
 */
import { useQuery, useMutation, UseQueryOptions } from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";

// ── Types ──────────────────────────────────────────────────────────────────

export interface PayComponent {
  name: string;
  type: "fixed" | "percent_of_basic" | "percent_of_gross";
  value: number;
  enabled?: boolean;
}

export interface PayComponents {
  id?: number;
  employeeId: number;
  workingDaysPerMonth: number;
  allowances: PayComponent[];
  deductions: PayComponent[];
}

export interface GeneratePayrollBody {
  month: number;
  year: number;
  employeeId?: number;
  forceRegenerate?: boolean;
}

export interface EnrichedPayrollRecord {
  id: number;
  employeeId: number;
  employeeName: string;
  branchName: string;
  month: number;
  year: number;
  workingDays: number;
  presentDays: number;
  lopDays: number;
  lopDeduction: number;
  baseSalary: number;
  grossPay: number;
  allowancesTotal: number;
  allowancesBreakdown: { name: string; amount: number }[];
  deductions: number;
  deductionsBreakdown: { name: string; amount: number }[];
  netPay: number;
  bonus: number;
  totalAmount: number;
  notes?: string;
  isPaid: boolean;
  paidDate?: string | null;
  // workflow
  status: 'draft' | 'approved' | 'paid';
  approvedAt?: string | null;
  extraAmount: number;
  extraNote?: string | null;
  paidAmount: number;
  paymentMode?: string | null;
  advanceDeduction: number;
  // Leave-policy snapshot (Aug 2026 LOP change). Null on payroll rows
  // generated before it — UIs must omit the leave line then, never show 0.
  paidLeaveUsed?: number | null;
  paidLeaveAllowed?: number | null;
  // Sick-leave snapshot (Aug 2026 casual/sick split). Null on runs generated
  // before the split — same omit-never-zero rule.
  sickLeaveUsed?: number | null;
  sickLeaveAllowed?: number | null;
}

export interface EmployeeAdvance {
  id: number;
  employeeId: number;
  employeeName: string;
  amount: number;
  date: string;
  note?: string | null;
  isDeducted: boolean;
  deductedPayrollId?: number | null;
  /**
   * Payment voucher that disbursed this advance (Dr Salary Payable / Cr till).
   * NULL = legacy row from the retired Employee-Advance-ledger flow; pending
   * legacy rows are locked for edit/delete (their balance was moved to Salary
   * Payable by a one-time migration), so hide those buttons when this is null.
   */
  paymentVoucherId?: number | null;
  createdAt: string;
}

// ── Pay Components ─────────────────────────────────────────────────────────

export const getPayComponentsQueryKey = (employeeId: number) => [
  "/api/hr/pay-components",
  employeeId,
];

export const useGetPayComponents = (
  employeeId: number,
  options?: { query?: UseQueryOptions<PayComponents, Error> }
) =>
  useQuery<PayComponents, Error>({
    queryKey: getPayComponentsQueryKey(employeeId),
    queryFn: async () =>
      customFetch<PayComponents>(`/api/hr/pay-components/${employeeId}`),
    enabled: !!employeeId,
    ...options?.query,
  });

export const useSetPayComponents = () =>
  useMutation<PayComponents, Error, { employeeId: number; data: Omit<PayComponents, "id" | "employeeId"> }>({
    mutationFn: ({ employeeId, data }) =>
      customFetch<PayComponents>(`/api/hr/pay-components/${employeeId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
  });

// ── Payroll Generation ─────────────────────────────────────────────────────

export const getEnrichedPayrollQueryKey = (params?: { year?: number; month?: number }) => [
  "/api/hr/payroll/enriched",
  params,
];

export const useGeneratePayroll = () =>
  useMutation<EnrichedPayrollRecord[], Error, GeneratePayrollBody>({
    mutationFn: (body) =>
      customFetch<EnrichedPayrollRecord[]>("/api/hr/payroll/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
  });

export const useListEnrichedPayroll = (
  params?: { year?: number; month?: number },
  options?: { query?: UseQueryOptions<EnrichedPayrollRecord[], Error> }
) =>
  useQuery<EnrichedPayrollRecord[], Error>({
    queryKey: getEnrichedPayrollQueryKey(params),
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (params?.year) qs.set("year", String(params.year));
      if (params?.month) qs.set("month", String(params.month));
      const q = qs.toString();
      return customFetch<EnrichedPayrollRecord[]>(`/api/hr/payroll${q ? "?" + q : ""}`);
    },
    ...options?.query,
  });

// ── Payroll Workflow ────────────────────────────────────────────────────────

export const useEditPayroll = () =>
  useMutation<EnrichedPayrollRecord, Error, { id: number; extraAmount: number; extraNote?: string }>({
    mutationFn: ({ id, extraAmount, extraNote }) =>
      customFetch<EnrichedPayrollRecord>(`/api/hr/payroll/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extraAmount, extraNote }),
      }),
  });

/**
 * Approve a payroll row. If the month still has unclassified absent days the
 * server refuses with 409 code UNCLASSIFIED_ABSENCES and the dates; re-approve
 * with `confirmLop: true` once the manager explicitly accepts the loss of pay
 * (or classify each day via the attendance correction route instead).
 */
export const useApprovePayroll = () =>
  useMutation<EnrichedPayrollRecord, Error, { id: number; confirmLop?: boolean }>({
    mutationFn: ({ id, confirmLop }) =>
      customFetch<EnrichedPayrollRecord>(`/api/hr/payroll/${id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(confirmLop ? { confirmLop: true } : {}),
      }),
  });

export const usePayPayroll = () =>
  useMutation<EnrichedPayrollRecord, Error, { id: number; amount?: number; paymentMode: string; payLedgerId?: number }>({
    mutationFn: ({ id, amount, paymentMode, payLedgerId }) =>
      customFetch<EnrichedPayrollRecord>(`/api/hr/payroll/${id}/pay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount, paymentMode, payLedgerId }),
      }),
  });

// ── Unclassified absences ───────────────────────────────────────────────────
//
// Days absent only by omission — no attendance row, no holiday, no weekly off —
// which price as loss of pay without a manager ever deciding so. Approval
// refuses a month that still has them, so the payroll page surfaces them for
// classification (casual/sick leave, paid off, or explicit absent) through the
// attendance correction route.

export interface UnclassifiedAbsences {
  employeeId: number;
  employeeName: string;
  /** YYYY-MM-DD, ascending; only days up to the business today. */
  dates: string[];
}

export const getUnclassifiedAbsencesQueryKey = (params: { year: number; month: number }) => [
  "/api/hr/payroll/unclassified-absences",
  params,
];

export const useUnclassifiedAbsences = (
  params: { year: number; month: number },
  options?: { query?: Partial<UseQueryOptions<UnclassifiedAbsences[], Error>> }
) =>
  useQuery<UnclassifiedAbsences[], Error>({
    queryKey: getUnclassifiedAbsencesQueryKey(params),
    queryFn: async () =>
      customFetch<UnclassifiedAbsences[]>(
        `/api/hr/payroll/unclassified-absences?year=${params.year}&month=${params.month}`),
    ...options?.query,
  });

// ── Salary Accrual Register ────────────────────────────────────────────────
//
// What daily accrual has already recognised in the books, by employee-month.
// Salary reaches the P&L a day at a time as it is earned, so approval is a
// true-up on this figure rather than the moment the expense appears.

export interface SalaryAccrualSummary {
  employeeId: number;
  employeeName: string;
  year: number;
  month: number;
  days: number;
  accrued: number;
  monthlySalary: number;
  daysInMonth: number;
  dailyAccrual: number;
  firstDay: string;
  lastDay: string;
  payrollStatus: 'none' | 'draft' | 'approved' | 'paid';
  /** Approved and paid months are financially final: no further accrual, no recalculation. */
  locked: boolean;
}

export const getSalaryAccrualsQueryKey = (params?: { employeeId?: number; year?: number; month?: number }) => [
  "/api/hr/salary-accruals",
  params,
];

export const useListSalaryAccruals = (
  params?: { employeeId?: number; year?: number; month?: number },
  options?: { query?: UseQueryOptions<SalaryAccrualSummary[], Error> }
) =>
  useQuery<SalaryAccrualSummary[], Error>({
    queryKey: getSalaryAccrualsQueryKey(params),
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (params?.employeeId) qs.set("employeeId", String(params.employeeId));
      if (params?.year) qs.set("year", String(params.year));
      if (params?.month) qs.set("month", String(params.month));
      const q = qs.toString();
      return customFetch<SalaryAccrualSummary[]>(`/api/hr/salary-accruals${q ? "?" + q : ""}`);
    },
    ...options?.query,
  });

// ── Employee Advances ──────────────────────────────────────────────────────

export const getAdvancesQueryKey = (employeeId?: number) => [
  "/api/hr/advances",
  employeeId,
];

export const useListAdvances = (
  params?: { employeeId?: number },
  options?: { query?: UseQueryOptions<EmployeeAdvance[], Error> }
) =>
  useQuery<EmployeeAdvance[], Error>({
    queryKey: getAdvancesQueryKey(params?.employeeId),
    queryFn: async () => customFetch<EmployeeAdvance[]>(`/api/hr/advances`),
    ...options?.query,
  });

export const useAddAdvance = () =>
  useMutation<EmployeeAdvance, Error, { employeeId: number; amount: number; date?: string; note?: string; payLedgerId?: number }>({
    mutationFn: (body) =>
      customFetch<EmployeeAdvance>("/api/hr/advances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
  });

// The cash "Recover Advance" flow is retired (Aug 2026): an advance now lives
// as a debit on the employee's Salary Payable ledger and payroll settles it —
// one settlement path. Historical cash recoveries stay visible in the list.

/**
 * Edit a pending advance (amount / date / note). The server refuses advances
 * a payroll run has reserved or already settled — and legacy rows from the
 * retired Employee-Advance-ledger flow — and keeps the linked payment voucher
 * in sync automatically.
 */
export const useUpdateAdvance = () =>
  useMutation<EmployeeAdvance, Error, { id: number; amount?: number | string; date?: string; note?: string | null }>({
    mutationFn: ({ id, ...body }) =>
      customFetch<EmployeeAdvance>(`/api/hr/advances/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
  });

/**
 * Delete an advance recorded in error. Pending and cash-recovered advances can
 * go (their journal entries are removed with them); payroll-settled ones cannot.
 */
export const useDeleteAdvance = () =>
  useMutation<{ success: boolean; vouchersRemoved: string[] }, Error, { id: number }>({
    mutationFn: ({ id }) =>
      customFetch<{ success: boolean; vouchersRemoved: string[] }>(`/api/hr/advances/${id}`, {
        method: "DELETE",
      }),
  });
