import { useQuery } from '@tanstack/react-query';
import { customFetch } from './custom-fetch';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LoginAttemptRow {
  id: number;
  username: string;
  employeeId: number | null;
  employeeName: string | null;
  success: boolean;
  ip: string | null;
  userAgent: string | null;
  reason: string | null;
  createdAt: string;
}

export interface LockedAccount {
  username: string;
  failures: number;
  lockedUntil: string;
}

export interface LoginHistoryResponse {
  total: number;
  page: number;
  limit: number;
  rows: LoginAttemptRow[];
  lockedAccounts: LockedAccount[];
}

export interface LoginHistoryParams {
  page?: number;
  limit?: number;
  username?: string;
  success?: 'true' | 'false' | '';
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

export function useLoginHistory(params?: LoginHistoryParams) {
  const qs = new URLSearchParams();
  qs.set('page', String(params?.page ?? 1));
  qs.set('limit', String(params?.limit ?? 25));
  if (params?.username) qs.set('username', params.username);
  if (params?.success) qs.set('success', params.success);
  const key = qs.toString();
  return useQuery({
    queryKey: ['/api/company/login-history', key] as const,
    queryFn: ({ signal }) =>
      customFetch<LoginHistoryResponse>(`/api/company/login-history?${key}`, { signal }),
    placeholderData: (prev) => prev,
  });
}
