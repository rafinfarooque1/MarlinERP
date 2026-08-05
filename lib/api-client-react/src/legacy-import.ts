/**
 * Legacy ERP Import (Company → Data Migration) — upload/analysis hooks.
 *
 * Uploads are sent as raw bodies (same pattern as the Excel import and backup
 * restore). Sessions are transient server-side (/tmp): a 410 means the server
 * restarted since the upload — the page should reset to the upload step.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";

// ── Types (mirrors api-server lib/legacyBackup.ts) ──────────────────────────

export type LegacyTableGuess =
  | "company" | "customers" | "vendors" | "items" | "ledgers" | "stock"
  | "sales" | "purchases" | "sales_returns" | "purchase_returns"
  | "receipts" | "payments" | "journal" | "opening_balances" | "unknown";

export interface LegacyDbfField { name: string; type: string; size: number; decimals: number }

export interface LegacyTableInfo {
  name: string;
  fileName: string;
  recordCount: number;
  lastUpdate: string | null;
  fields: LegacyDbfField[];
  guess: LegacyTableGuess;
  parseError?: string;
}

export interface LegacyAnalysis {
  companyName: string | null;
  backupDate: string | null;
  tables: LegacyTableInfo[];
  summary: Partial<Record<Exclude<LegacyTableGuess, "unknown" | "company">, number>>;
  unknownTables: number;
}

export interface LegacyUploadSession {
  uploadId: string;
  fileName: string;
  createdBy: string;
  createdAt: string;
  status: "password_required" | "ready" | "failed";
  analysis: LegacyAnalysis | null;
  error: string | null;
}

export interface LegacyTableRows {
  table: string;
  fields: LegacyDbfField[];
  rows: Array<Record<string, unknown>>;
}

// ── Keys ─────────────────────────────────────────────────────────────────────

export const legacyImportKeys = {
  all: ["legacy-import"] as const,
  upload: (id: string) => ["legacy-import", "upload", id] as const,
  rows: (id: string, file: string) => ["legacy-import", "rows", id, file] as const,
};

// ── Hooks ────────────────────────────────────────────────────────────────────

/** Upload a backup ZIP or a single DBF file and get the analysis (or a password prompt). */
export const useUploadLegacyBackup = () =>
  useMutation<LegacyUploadSession, Error, { file: File }>({
    mutationFn: ({ file }) =>
      customFetch<LegacyUploadSession>(
        `/api/legacy-import/uploads?filename=${encodeURIComponent(file.name)}`,
        { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file },
      ),
  });

/** Retry extraction of a password-protected ZIP. */
export const useUnlockLegacyUpload = () => {
  const qc = useQueryClient();
  return useMutation<LegacyUploadSession, Error, { uploadId: string; password: string }>({
    mutationFn: ({ uploadId, password }) =>
      customFetch<LegacyUploadSession>(`/api/legacy-import/uploads/${uploadId}/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      }),
    onSuccess: (data) => { qc.setQueryData(legacyImportKeys.upload(data.uploadId), data); },
  });
};

/** Add another DBF file to an existing session (multi-file legacy backups). */
export const useAddLegacyFile = () => {
  const qc = useQueryClient();
  return useMutation<LegacyUploadSession, Error, { uploadId: string; file: File }>({
    mutationFn: ({ uploadId, file }) =>
      customFetch<LegacyUploadSession>(
        `/api/legacy-import/uploads/${uploadId}/files?filename=${encodeURIComponent(file.name)}`,
        { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file },
      ),
    onSuccess: (data) => { qc.setQueryData(legacyImportKeys.upload(data.uploadId), data); },
  });
};

/** Re-read a session (e.g. after navigating back to the page). */
export const useLegacyUpload = (uploadId: string | null) =>
  useQuery<LegacyUploadSession, Error>({
    queryKey: legacyImportKeys.upload(uploadId ?? ""),
    queryFn: () => customFetch<LegacyUploadSession>(`/api/legacy-import/uploads/${uploadId}`, { method: "GET" }),
    enabled: uploadId != null,
    retry: false,
  });

/** Sample rows from one extracted table — for eyeballing real legacy values. */
export const useLegacyTableRows = (uploadId: string | null, fileName: string | null, limit = 20) =>
  useQuery<LegacyTableRows, Error>({
    queryKey: legacyImportKeys.rows(uploadId ?? "", fileName ?? ""),
    queryFn: () =>
      customFetch<LegacyTableRows>(
        `/api/legacy-import/uploads/${uploadId}/tables/${encodeURIComponent(fileName ?? "")}/rows?limit=${limit}`,
        { method: "GET" },
      ),
    enabled: uploadId != null && fileName != null,
    retry: false,
  });

/** Discard a session and its extracted files. */
export const useDiscardLegacyUpload = () =>
  useMutation<{ ok: boolean }, Error, { uploadId: string }>({
    mutationFn: ({ uploadId }) =>
      customFetch<{ ok: boolean }>(`/api/legacy-import/uploads/${uploadId}`, { method: "DELETE" }),
  });
