import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { customFetch } from './custom-fetch';

// ── Query keys ────────────────────────────────────────────────────────────────
export const getJournalVouchersQueryKey = (params?: Record<string, string>) =>
  params && Object.keys(params).length
    ? (['/api/accounts/journal-vouchers', params] as const)
    : (['/api/accounts/journal-vouchers'] as const);
/**
 * Optional location slice for the books endpoints. Matches the global
 * location selector: a concrete warehouse/outlet, 'headoffice', or 'company'
 * (postings with no location dimension). Omit for the consolidated view.
 */
export interface BooksLocationParams {
  locationType?: 'warehouse' | 'outlet' | 'headoffice' | 'company';
  locationId?: number;
}

const locKey = (loc?: BooksLocationParams) =>
  loc?.locationType ? `${loc.locationType}:${loc.locationId ?? ''}` : '';

const locQs = (qs: URLSearchParams, loc?: BooksLocationParams) => {
  if (loc?.locationType) {
    qs.set('locationType', loc.locationType);
    if (loc.locationId != null) qs.set('locationId', String(loc.locationId));
  }
};

export const getDayBookQueryKey = (date?: string, loc?: BooksLocationParams) =>
  ['/api/accounts/day-book', date ?? 'today', locKey(loc)] as const;
export const getCashBankBookQueryKey = (ledgerId: number, fromDate?: string, toDate?: string, loc?: BooksLocationParams) =>
  ['/api/accounts/cash-bank-book', ledgerId, fromDate ?? '', toDate ?? '', locKey(loc)] as const;
export const getCashBankBookLedgersQueryKey = (kind: 'cash' | 'bank') =>
  ['/api/accounts/cash-bank-book/ledgers', kind] as const;
export const getTrialBalanceQueryKey = (fromDate?: string, toDate?: string, loc?: BooksLocationParams) =>
  ['/api/accounts/trial-balance', fromDate ?? '', toDate ?? '', locKey(loc)] as const;

// ── Types ─────────────────────────────────────────────────────────────────────
export type JournalVoucherType = 'journal' | 'contra' | 'credit_note' | 'debit_note';

export interface JournalVoucherLine {
  id: number;
  ledgerId: number;
  ledgerName: string;
  ledgerCode?: string | null;
  debit: number;
  credit: number;
}

export interface JournalVoucher {
  id: number;
  voucherType: JournalVoucherType;
  voucherNumber: string;
  voucherDate: string;
  narration?: string | null;
  reason?: string | null;
  partyLedgerId?: number | null;
  partyName?: string | null;
  /** Customer/vendor id behind partyLedgerId, for pre-selecting an edit form. */
  partyId?: number | null;
  totalAmount: number;
  createdBy?: string | null;
  createdAt?: string;
  /**
   * How this voucher came to exist. 'manual' = a person entered it on the
   * Vouchers screen; 'system' = another module generated it; null = predates
   * provenance tracking. Only 'manual' may be edited.
   */
  origin?: 'manual' | 'system' | null;
  /** For system vouchers, the module that owns it (payroll, production, …). */
  sourceModule?: string | null;
  /** Server's verdict on editability — never re-derive this in the UI. */
  editable?: boolean;
  /** When not editable, the reason to show the user. */
  lockedReason?: string | null;
  updatedAt?: string | null;
  updatedBy?: string | null;
  /** Concurrency token; echo back as expectedRev when editing. */
  rev?: string | null;
  lines: JournalVoucherLine[];
}

export interface CreateJournalVoucherBody {
  voucherType: JournalVoucherType;
  voucherDate: string;
  narration?: string;
  reason?: string;
  /** journal only */
  lines?: { ledgerId: number; debit: number; credit: number }[];
  /** contra only */
  fromLedgerId?: number;
  toLedgerId?: number;
  /** contra / notes */
  amount?: number;
  /** notes only */
  partyId?: number;
  counterLedgerId?: number;
}

export interface DayBookEntry {
  id: string;
  refId: number;
  source: string;
  voucherNumber?: string | null;
  particulars: string;
  narration?: string | null;
  amount: number;
}

export interface DayBookResponse {
  date: string;
  entries: DayBookEntry[];
  totals: {
    count: number;
    amount: number;
    byType: Record<string, { count: number; amount: number }>;
  };
}

export interface CashBankBookEntry {
  date: string;
  source: string;
  voucherNumber?: string | null;
  description: string;
  debit: number;
  credit: number;
  balance: number;
}

export interface CashBankBookResponse {
  ledger: { id: number; name: string; code?: string | null };
  openingBalance: number;
  entries: CashBankBookEntry[];
  totalDebit: number;
  totalCredit: number;
  closingBalance: number;
}

export interface BookLedgerOption {
  id: number;
  name: string;
  code?: string | null;
  isGroup: boolean;
}

export interface TrialBalanceRow {
  ledgerId: number;
  name: string;
  code?: string | null;
  type?: string | null;
  groupName?: string | null;
  debit: number;
  credit: number;
}

/**
 * Present on filtered books responses: how much of the same window is
 * company-level (no location dimension) and therefore lives outside every
 * location slice. Null when the filter IS the company slice.
 */
export interface CompanyLevelSummary {
  entries: number;
  debit: number;
  credit: number;
}

export interface TrialBalanceResponse {
  fromDate?: string | null;
  toDate?: string | null;
  rows: TrialBalanceRow[];
  totalDebit: number;
  totalCredit: number;
  difference: number;
  balanced: boolean;
  /** Echoed only when a location filter was applied. */
  location?: { type: string; id: number | null };
  companyLevel?: CompanyLevelSummary | null;
}

// ── Books invalidation (anything that changes postings) ──────────────────────
const BOOK_KEYS = [
  '/api/accounts/journal-vouchers',
  '/api/accounts/day-book',
  '/api/accounts/cash-bank-book',
  '/api/accounts/trial-balance',
];

function invalidateBooks(qc: ReturnType<typeof useQueryClient>) {
  for (const key of BOOK_KEYS) qc.invalidateQueries({ queryKey: [key] });
}

// ── Journal vouchers ──────────────────────────────────────────────────────────
export function useListJournalVouchers(params?: { type?: JournalVoucherType; fromDate?: string; toDate?: string }) {
  const clean: Record<string, string> = {};
  if (params?.type) clean.type = params.type;
  if (params?.fromDate) clean.fromDate = params.fromDate;
  if (params?.toDate) clean.toDate = params.toDate;
  const qs = new URLSearchParams(clean).toString();
  return useQuery({
    queryKey: getJournalVouchersQueryKey(clean),
    queryFn: ({ signal }) =>
      customFetch<JournalVoucher[]>(`/api/accounts/journal-vouchers${qs ? `?${qs}` : ''}`, { signal }),
  });
}

export function useCreateJournalVoucher() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateJournalVoucherBody) =>
      customFetch<JournalVoucher>('/api/accounts/journal-vouchers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => invalidateBooks(qc),
  });
}

/**
 * Body for editing a manually created voucher. The voucher type is fixed by the
 * stored row (it is implied by the voucher number, which is preserved), so it is
 * not sent. `expectedRev` is the `rev` read with the voucher — the server
 * rejects the write if the row changed in the meantime.
 */
export type UpdateJournalVoucherBody = Omit<CreateJournalVoucherBody, 'voucherType'> & {
  expectedRev: string;
};

export function useUpdateJournalVoucher() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: UpdateJournalVoucherBody & { id: number }) =>
      customFetch<JournalVoucher>(`/api/accounts/journal-vouchers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => invalidateBooks(qc),
  });
}

export function useDeleteJournalVoucher() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      customFetch<void>(`/api/accounts/journal-vouchers/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidateBooks(qc),
  });
}

// ── Day Book ──────────────────────────────────────────────────────────────────
export function useDayBook(date?: string, loc?: BooksLocationParams) {
  const qs = new URLSearchParams();
  if (date) qs.set('date', date);
  locQs(qs, loc);
  const s = qs.toString();
  return useQuery({
    queryKey: getDayBookQueryKey(date, loc),
    queryFn: ({ signal }) =>
      customFetch<DayBookResponse>(`/api/accounts/day-book${s ? `?${s}` : ''}`, { signal }),
  });
}

// ── Cash Book / Bank Book ─────────────────────────────────────────────────────
export function useCashBankBookLedgers(kind: 'cash' | 'bank') {
  return useQuery({
    queryKey: getCashBankBookLedgersQueryKey(kind),
    queryFn: ({ signal }) =>
      customFetch<BookLedgerOption[]>(`/api/accounts/cash-bank-book/ledgers?kind=${kind}`, { signal }),
  });
}

export function useCashBankBook(ledgerId: number, fromDate?: string, toDate?: string, loc?: BooksLocationParams) {
  const qs = new URLSearchParams({ ledgerId: String(ledgerId) });
  if (fromDate) qs.set('fromDate', fromDate);
  if (toDate) qs.set('toDate', toDate);
  locQs(qs, loc);
  return useQuery({
    queryKey: getCashBankBookQueryKey(ledgerId, fromDate, toDate, loc),
    queryFn: ({ signal }) =>
      customFetch<CashBankBookResponse>(`/api/accounts/cash-bank-book?${qs.toString()}`, { signal }),
    enabled: ledgerId > 0,
  });
}

// ── Trial Balance ─────────────────────────────────────────────────────────────
export function useTrialBalance(fromDate?: string, toDate?: string, loc?: BooksLocationParams) {
  const qs = new URLSearchParams();
  if (fromDate) qs.set('fromDate', fromDate);
  if (toDate) qs.set('toDate', toDate);
  locQs(qs, loc);
  const s = qs.toString();
  return useQuery({
    queryKey: getTrialBalanceQueryKey(fromDate, toDate, loc),
    queryFn: ({ signal }) =>
      customFetch<TrialBalanceResponse>(`/api/accounts/trial-balance${s ? `?${s}` : ''}`, { signal }),
  });
}
