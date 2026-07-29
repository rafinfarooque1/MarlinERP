/**
 * Warehouse Rent Management.
 *
 * Rent is accrued daily by the server, so the client never computes money — it
 * reads accrued / paid / outstanding and displays them. Mutations are limited to
 * editing the agreement, approving a month, and recording a payment.
 */
import { useQuery, useMutation, UseQueryOptions } from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";

// ── Types ──────────────────────────────────────────────────────────────────

export interface RentAgreement {
  id: number | null;
  warehouseId: number;
  warehouseName: string;
  monthlyRent: number;
  securityDeposit: number;
  agreementNumber: string;
  landlordName: string;
  landlordPhone: string;
  landlordEmail: string;
  landlordAddress: string;
  startDate: string | null;
  endDate: string | null;
  dueDay: number;
  status: "active" | "inactive";
  inactiveFrom: string | null;
  expenseLedgerId: number | null;
  payableLedgerId: number | null;
  expenseLedgerName: string;
  payableLedgerName: string;
  totalAccrued: number;
  totalPaid: number;
  totalOutstanding: number;
}

export type RentAgreementPatch = Partial<
  Pick<
    RentAgreement,
    | "monthlyRent" | "securityDeposit" | "agreementNumber"
    | "landlordName" | "landlordPhone" | "landlordEmail" | "landlordAddress"
    | "startDate" | "endDate" | "dueDay" | "status"
  >
>;

export interface RentAccrual {
  id: number;
  warehouseId: number;
  warehouseName: string;
  accrualDate: string;
  year: number;
  month: number;
  amount: number;
  monthlyRent: number;
  daysInMonth: number;
}

export interface RentPeriod {
  warehouseId: number;
  warehouseName: string;
  year: number;
  month: number;
  accrued: number;
  paid: number;
  outstanding: number;
  daysAccrued: number;
  daysInMonth: number;
  status: "pending" | "approved" | "paid";
  approvedAt: string | null;
  approvedBy: string | null;
  dueDate: string;
  /** False while the month is still accruing — approval is blocked until it ends. */
  accrualComplete: boolean;
}

export interface RentPayment {
  id: number;
  warehouseId: number;
  warehouseName: string;
  year: number;
  month: number;
  paymentDate: string;
  amount: number;
  paymentMode: string;
  referenceNumber: string;
  remarks: string;
  voucherId: number | null;
  voucherNumber: string;
  createdBy: string;
  createdAt: string;
}

export interface RentDashboard {
  year: number;
  month: number;
  monthlyRentCommitted: number;
  activeAgreements: number;
  accruedThisMonth: number;
  paidThisMonth: number;
  totalOutstanding: number;
  pendingApprovals: number;
  warehouseWise: {
    warehouseId: number;
    warehouseName: string;
    monthAccrued: number;
    totalAccrued: number;
    totalPaid: number;
    outstanding: number;
  }[];
}

export interface RentLedgerPosting {
  date: string;
  warehouseName: string;
  kind: "accrual" | "payment";
  narration: string;
  voucherNumber: string;
  debitLedger: string;
  creditLedger: string;
  amount: number;
}

export interface RentFilters {
  warehouseId?: number;
  year?: number;
  month?: number;
  from?: string;
  to?: string;
  status?: string;
}

const qs = (f?: RentFilters) => {
  const p = new URLSearchParams();
  if (f?.warehouseId) p.set("warehouseId", String(f.warehouseId));
  if (f?.year) p.set("year", String(f.year));
  if (f?.month) p.set("month", String(f.month));
  if (f?.from) p.set("from", f.from);
  if (f?.to) p.set("to", f.to);
  if (f?.status) p.set("status", f.status);
  const s = p.toString();
  return s ? `?${s}` : "";
};

// ── Agreements ─────────────────────────────────────────────────────────────

export const getRentAgreementsQueryKey = () => ["/api/rent/agreements"];

export const useListRentAgreements = (
  options?: { query?: Omit<UseQueryOptions<RentAgreement[], Error>, 'queryKey'> },
) =>
  useQuery<RentAgreement[], Error>({
    queryKey: getRentAgreementsQueryKey(),
    queryFn: () => customFetch<RentAgreement[]>("/api/rent/agreements"),
    ...options?.query,
  });

export const useUpdateRentAgreement = () =>
  useMutation<RentAgreement, Error, { warehouseId: number; data: RentAgreementPatch }>({
    mutationFn: ({ warehouseId, data }) =>
      customFetch<RentAgreement>(`/api/rent/agreements/${warehouseId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
  });

// ── Accruals ───────────────────────────────────────────────────────────────

export const getRentAccrualsQueryKey = (f?: RentFilters) => ["/api/rent/accruals", f];

export const useListRentAccruals = (
  f?: RentFilters,
  options?: { query?: Omit<UseQueryOptions<RentAccrual[], Error>, 'queryKey'> },
) =>
  useQuery<RentAccrual[], Error>({
    queryKey: getRentAccrualsQueryKey(f),
    queryFn: () => customFetch<RentAccrual[]>(`/api/rent/accruals${qs(f)}`),
    ...options?.query,
  });

export const useRunRentAccrual = () =>
  useMutation<{ daysAccrued: number; warehousesTouched: number; totalAmount: number }, Error, void>({
    mutationFn: () => customFetch("/api/rent/accrue", { method: "POST" }),
  });

// ── Periods, approval and payment ──────────────────────────────────────────

export const getRentPeriodsQueryKey = (f?: RentFilters) => ["/api/rent/periods", f];

export const useListRentPeriods = (
  f?: RentFilters,
  options?: { query?: Omit<UseQueryOptions<RentPeriod[], Error>, 'queryKey'> },
) =>
  useQuery<RentPeriod[], Error>({
    queryKey: getRentPeriodsQueryKey(f),
    queryFn: () => customFetch<RentPeriod[]>(`/api/rent/periods${qs(f)}`),
    ...options?.query,
  });

export const useApproveRentPeriod = () =>
  useMutation<
    { warehouseId: number; year: number; month: number; status: string; amount: number },
    Error,
    { warehouseId: number; year: number; month: number }
  >({
    mutationFn: ({ warehouseId, year, month }) =>
      customFetch(`/api/rent/periods/${warehouseId}/${year}/${month}/approve`, { method: "POST" }),
  });

export interface RentPayBody {
  amount?: number;
  paymentMode: string;
  paymentDate?: string;
  referenceNumber?: string;
  remarks?: string;
}

export const usePayRentPeriod = () =>
  useMutation<
    { id: number; warehouseId: number; year: number; month: number; amount: number; status: string },
    Error,
    { warehouseId: number; year: number; month: number; data: RentPayBody }
  >({
    mutationFn: ({ warehouseId, year, month, data }) =>
      customFetch(`/api/rent/periods/${warehouseId}/${year}/${month}/pay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
  });

// ── Payments ───────────────────────────────────────────────────────────────

export const getRentPaymentsQueryKey = (f?: RentFilters) => ["/api/rent/payments", f];

export const useListRentPayments = (
  f?: RentFilters,
  options?: { query?: Omit<UseQueryOptions<RentPayment[], Error>, 'queryKey'> },
) =>
  useQuery<RentPayment[], Error>({
    queryKey: getRentPaymentsQueryKey(f),
    queryFn: () => customFetch<RentPayment[]>(`/api/rent/payments${qs(f)}`),
    ...options?.query,
  });

// ── Dashboard ──────────────────────────────────────────────────────────────

export const getRentDashboardQueryKey = () => ["/api/rent/dashboard"];

export const useRentDashboard = (
  options?: { query?: Omit<UseQueryOptions<RentDashboard, Error>, 'queryKey'> },
) =>
  useQuery<RentDashboard, Error>({
    queryKey: getRentDashboardQueryKey(),
    queryFn: () => customFetch<RentDashboard>("/api/rent/dashboard"),
    ...options?.query,
  });

// ── Ledger posting report ──────────────────────────────────────────────────

export const getRentLedgerPostingsQueryKey = (f?: RentFilters) => ["/api/rent/ledger-postings", f];

export const useListRentLedgerPostings = (
  f?: RentFilters,
  options?: { query?: Omit<UseQueryOptions<RentLedgerPosting[], Error>, 'queryKey'> },
) =>
  useQuery<RentLedgerPosting[], Error>({
    queryKey: getRentLedgerPostingsQueryKey(f),
    queryFn: () => customFetch<RentLedgerPosting[]>(`/api/rent/ledger-postings${qs(f)}`),
    ...options?.query,
  });
