/**
 * Manual hooks for the Audit Log API.
 * The generated client doesn't cover this endpoint, so we use customFetch.
 */
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";

export interface AuditLogEntry {
  id: number;
  action: string;
  module: string;
  entityType: string;
  entityId: number | null;
  description: string;
  user: string;
  type: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface AuditLogsResponse {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  logs: AuditLogEntry[];
}

export interface AuditLogParams {
  page?: number;
  limit?: number;
  module?: string;
  action?: string;
  user?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
}

function buildAuditUrl(params: AuditLogParams): string {
  const qs = new URLSearchParams();
  if (params.page)     qs.set("page",     String(params.page));
  if (params.limit)    qs.set("limit",    String(params.limit));
  if (params.module)   qs.set("module",   params.module);
  if (params.action)   qs.set("action",   params.action);
  if (params.user)     qs.set("user",     params.user);
  if (params.dateFrom) qs.set("dateFrom", params.dateFrom);
  if (params.dateTo)   qs.set("dateTo",   params.dateTo);
  if (params.search)   qs.set("search",   params.search);
  const str = qs.toString();
  return `/api/audit/logs${str ? `?${str}` : ""}`;
}

export function useListAuditLogs(params: AuditLogParams = {}) {
  return useQuery<AuditLogsResponse>({
    queryKey: ["audit-logs", params],
    queryFn: () => customFetch<AuditLogsResponse>(buildAuditUrl(params)),
    staleTime: 30_000,
  });
}
