import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";
import { getListVendorsQueryKey } from "./generated/api";
import { getPayablesAgingQueryKey } from "./returns";

// ── Customer / Vendor Ledger ───────────────────────────────────────────────────
export interface LedgerEntry {
  date: string;
  description: string;
  entryType: string;
  voucherNumber?: string | null;
  debit: number;
  credit: number;
  balance: number;
  paymentStatus?: string;
}
export interface PartyLedger {
  balance: number;
  totalBilled?: number;
  totalPaid?: number;
  totalPurchased?: number;
  entries: LedgerEntry[];
}

export function useGetCustomerLedger(customerId: number | undefined) {
  return useQuery<PartyLedger>({
    queryKey: ['customer-ledger', customerId],
    queryFn: () => customFetch<PartyLedger>(`/api/customers/${customerId}/ledger`),
    enabled: !!customerId,
  });
}

export function useGetVendorLedger(vendorId: number | undefined) {
  return useQuery<PartyLedger>({
    queryKey: ['vendor-ledger', vendorId],
    queryFn: () => customFetch<PartyLedger>(`/api/vendors/${vendorId}/ledger`),
    enabled: !!vendorId,
  });
}

export interface CashBankLedger {
  id: number;
  name: string;
  code: string | null;
  parentId: number | null;
  type: string;
}

export function useGetCashBankLedgers() {
  return useQuery<CashBankLedger[]>({
    queryKey: ['cash-bank-ledgers-list'],
    queryFn: () => customFetch('/api/accounts/cash-bank-ledgers'),
  });
}

export function useRecordVendorPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ vendorId, data }: { vendorId: number; data: { date: string; amount: number; cashBankLedgerId: number; narration?: string } }) =>
      customFetch<any>(`/api/vendors/${vendorId}/payment`, { method: 'POST', body: JSON.stringify(data) }),
    onSuccess: (_: any, vars) => {
      // Paying a vendor moves the vendor ledger, the payables control and the
      // cash/bank ledger it was paid from, so every surface that reports one of
      // those has to be refetched. The list key must be the generated one:
      // a hand-written ['vendors'] matches no query, which left the vendor list
      // showing the pre-payment balance until a full page reload.
      qc.invalidateQueries({ queryKey: ['vendor-ledger', vars.vendorId] });
      qc.invalidateQueries({ queryKey: getListVendorsQueryKey() });
      qc.invalidateQueries({ queryKey: getPayablesAgingQueryKey() });
      qc.invalidateQueries({ queryKey: ['/api/dashboard/bi'] });
      qc.invalidateQueries({ queryKey: ['/api/cash-in-outlet'] });
    },
  });
}

// ── Update Sale ────────────────────────────────────────────────────────────────
export function useUpdateSale() {
  return useMutation({
    mutationFn: ({ saleId, data }: { saleId: number; data: any }) =>
      customFetch<any>(`/api/sales/${saleId}`, { method: "PUT", body: JSON.stringify(data) }),
  });
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SalePayment {
  id: number;
  saleId: number;
  paymentDate: string;
  method: string;
  amount: number;
  referenceNumber: string | null;
  notes: string | null;
  reconciliationStatus: string | null;
  clearingReceiptId: number | null;
  outletId: number;
  createdBy: string | null;
  createdAt: string;
  batchReference: string | null;
  reconciledOn: string | null;
  /** The Cash & Bank account the money actually landed in (via the receipt). */
  receivedInLedgerId: number | null;
  /** Null on old rows without a receipt — display falls back to the method label. */
  receivedInLedgerName: string | null;
}

export interface ReconciliationBatch {
  id: number;
  batchReference: string;
  settlementDate: string;
  grossAmount: number;
  charges: number;
  netAmount: number;
  destinationBankLedgerId: number;
  bankLedgerName: string;
  externalReference: string | null;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
  status: string;
  itemCount: number;
}

export interface ReconciliationBatchDetail extends ReconciliationBatch {
  items: {
    id: number;
    salePaymentId: number;
    amount: number;
    method: string;
    paymentDate: string;
    referenceNumber: string | null;
    invoiceNumber: string;
    saleId: number;
    locationName: string;
    customerName: string | null;
  }[];
}

export interface PendingPayment {
  id: number;
  saleId: number;
  paymentDate: string;
  method: string;
  amount: number;
  referenceNumber: string | null;
  notes: string | null;
  reconciliationStatus: string;
  /** The sale's own location — 'outlet' or 'warehouse'. */
  locationType: string;
  locationId: number;
  createdAt: string;
  invoiceNumber: string;
  locationName: string;
  customerName: string | null;
}

export interface BankLedger {
  id: number;
  name: string;
  code: string | null;
  bankDetails: string | null;
}

export interface OutletCashBalance {
  /** 'outlet' or 'warehouse' */
  locationType: string;
  locationId: number;
  locationName: string;
  /** null for warehouses — kept for backward compat with deposit flow */
  outletId: number | null;
  outletName: string | null;
  cashLedgerId: number | null;
  cashBalance: number;
  pendingDeposits: number;
  availableBalance: number;
}

export interface CashDeposit {
  id: number;
  outletId: number;
  outletName: string;
  sourceCashLedgerId: number;
  amount: number;
  depositDate: string;
  depositReference: string | null;
  destinationBankLedgerId: number | null;
  bankLedgerName: string | null;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
  status: string;
  transitPaymentId: number | null;
  bankReceiptId: number | null;
}

// ── Query Keys ────────────────────────────────────────────────────────────────

export const getSalePaymentsQueryKey = (saleId: number) => ["sale-payments", saleId];
export const getPendingPaymentsQueryKey = (params?: object) => ["reconciliation-pending", params];
export const getReconciliationBatchesQueryKey = () => ["reconciliation-batches"];
export const getReconciliationBatchDetailQueryKey = (id: number) => ["reconciliation-batch", id];
export const getBankLedgersQueryKey = () => ["bank-ledgers"];
export const getCashInOutletQueryKey = () => ["cash-in-outlet"];
export const getCashDepositsQueryKey = (params?: object) => ["cash-deposits", params];

// ── Hooks: Sale Payments ──────────────────────────────────────────────────────

export function useGetSalePayments(saleId: number, options?: { enabled?: boolean }) {
  return useQuery<SalePayment[]>({
    queryKey: getSalePaymentsQueryKey(saleId),
    queryFn: () => customFetch(`/api/sales/${saleId}/payments`),
    enabled: options?.enabled !== false && saleId > 0,
  });
}

export function useCreateSalePayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ saleId, data }: { saleId: number; data: { method?: string; receivedInLedgerId?: number; amount: number; referenceNumber?: string; notes?: string; paymentDate?: string } }) =>
      customFetch(`/api/sales/${saleId}/payments`, { method: "POST", body: JSON.stringify(data), headers: { "Content-Type": "application/json" } }),
    onSuccess: (_result: any, vars) => {
      qc.invalidateQueries({ queryKey: getSalePaymentsQueryKey(vars.saleId) });
      // Invalidate sales list so payment_status badge updates
      qc.invalidateQueries({ queryKey: ["sales"] });
    },
  });
}

// ── Hooks: Reconciliation ─────────────────────────────────────────────────────

export function useGetPendingPayments(params?: { locationType?: string; locationId?: number; method?: string; fromDate?: string; toDate?: string; search?: string }) {
  return useQuery<PendingPayment[]>({
    queryKey: getPendingPaymentsQueryKey(params),
    queryFn: () => {
      const qs = new URLSearchParams();
      // Filter by the sale's own location, so warehouse receipts are reachable.
      if (params?.locationType && params?.locationId) {
        qs.set("locationType", params.locationType);
        qs.set("locationId", String(params.locationId));
      }
      if (params?.method)   qs.set("method", params.method);
      if (params?.fromDate) qs.set("fromDate", params.fromDate);
      if (params?.toDate)   qs.set("toDate", params.toDate);
      if (params?.search)   qs.set("search", params.search);
      const q = qs.toString();
      return customFetch(`/api/reconciliation/pending${q ? `?${q}` : ""}`);
    },
  });
}

export function useGetReconciliationBatches() {
  return useQuery<ReconciliationBatch[]>({
    queryKey: getReconciliationBatchesQueryKey(),
    queryFn: () => customFetch("/api/reconciliation/batches"),
  });
}

export function useGetReconciliationBatch(id: number, options?: { enabled?: boolean }) {
  return useQuery<ReconciliationBatchDetail>({
    queryKey: getReconciliationBatchDetailQueryKey(id),
    queryFn: () => customFetch(`/api/reconciliation/batches/${id}`),
    enabled: options?.enabled !== false && id > 0,
  });
}

export function useGetBankLedgers() {
  return useQuery<BankLedger[]>({
    queryKey: getBankLedgersQueryKey(),
    queryFn: () => customFetch("/api/reconciliation/bank-ledgers"),
  });
}

export function useCreateBankAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; bankName?: string; accountNumber?: string; ifscCode?: string; branch?: string }) =>
      customFetch<BankLedger>("/api/reconciliation/bank-accounts", {
        method: "POST", body: JSON.stringify(data), headers: { "Content-Type": "application/json" },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getBankLedgersQueryKey() });
      qc.invalidateQueries({ queryKey: ["cash-bank-ledgers-list"] });
      qc.invalidateQueries({ queryKey: ["chart-of-accounts"] });
    },
  });
}

export function useCreateReconciliationBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { salePaymentIds: number[]; charges: number; settlementDate: string; destinationBankLedgerId: number; externalReference?: string; notes?: string }) =>
      customFetch("/api/reconciliation/batches", { method: "POST", body: JSON.stringify(data), headers: { "Content-Type": "application/json" } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getReconciliationBatchesQueryKey() });
      qc.invalidateQueries({ queryKey: getPendingPaymentsQueryKey() });
    },
  });
}

// ── Hooks: Cash in Outlet ─────────────────────────────────────────────────────

export function useGetCashInOutlet() {
  return useQuery<OutletCashBalance[]>({
    queryKey: getCashInOutletQueryKey(),
    queryFn: () => customFetch("/api/cash-in-outlet"),
  });
}

export function useGetCashDeposits(params?: { status?: string; outletId?: number }) {
  return useQuery<CashDeposit[]>({
    queryKey: getCashDepositsQueryKey(params),
    queryFn: () => {
      const qs = new URLSearchParams();
      if (params?.status)   qs.set("status", params.status);
      if (params?.outletId) qs.set("outletId", String(params.outletId));
      const q = qs.toString();
      return customFetch(`/api/cash-in-outlet/deposits${q ? `?${q}` : ""}`);
    },
  });
}

export function useCreateCashDeposit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { outletId?: number; warehouseId?: number; amount: number; depositDate: string; depositReference?: string; destinationBankLedgerId?: number; notes?: string }) =>
      customFetch("/api/cash-in-outlet/deposits", { method: "POST", body: JSON.stringify(data), headers: { "Content-Type": "application/json" } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getCashInOutletQueryKey() });
      qc.invalidateQueries({ queryKey: getCashDepositsQueryKey() });
    },
  });
}

export function useReconcileCashDeposit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: { destinationBankLedgerId: number; bankReference?: string; charges?: number; settlementDate: string } }) =>
      customFetch(`/api/cash-in-outlet/deposits/${id}/reconcile`, { method: "POST", body: JSON.stringify(data), headers: { "Content-Type": "application/json" } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getCashInOutletQueryKey() });
      qc.invalidateQueries({ queryKey: getCashDepositsQueryKey() });
    },
  });
}
