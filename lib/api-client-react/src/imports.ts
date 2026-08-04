/**
 * Data Import (Company › Import Data).
 *
 * Migration of old-ERP masters: sample template download, upload → validate →
 * preview, commit, history and per-batch rollback. All verdicts (valid /
 * warning / error, per-row reason + suggestion, rollback eligibility) are
 * computed on the server; the client displays them.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";

// ── Types ──────────────────────────────────────────────────────────────────

export type ImportModule = "customers" | "vendors" | "ledgers";

export type ImportBatchStatus = "validated" | "committing" | "committed" | "rolled_back";

export type ImportRowStatus =
  | "valid" | "warning" | "error"
  | "imported" | "updated" | "skipped" | "failed" | "rolled_back";

export interface ImportBatch {
  id: number;
  module: ImportModule;
  filename: string;
  status: ImportBatchStatus;
  totalRows: number;
  validRows: number;
  warningRows: number;
  errorRows: number;
  importedRows: number;
  updatedRows: number;
  skippedRows: number;
  failedRows: number;
  createdBy: string;
  createdAt: string;
  committedAt: string | null;
  committedBy: string | null;
  rolledBackAt: string | null;
  rolledBackBy: string | null;
  rollbackAvailable: boolean;
}

export interface ImportRow {
  id: number;
  rowNumber: number;
  status: ImportRowStatus;
  reason: string | null;
  suggestion: string | null;
  duplicateOfId: number | null;
  values: Record<string, string>;
  createdRecordType: string | null;
  createdRecordId: number | null;
  createdLedgerId: number | null;
}

export interface ImportParseResponse {
  batch: ImportBatch;
  rows: ImportRow[];
}

export interface ImportCommitResponse {
  batch: ImportBatch;
  summary: { imported: number; updated: number; skipped: number; failed: number };
  failures: Array<{ rowNumber: number; name: string; reason: string }>;
}

export interface ImportRollbackResponse {
  batch: ImportBatch;
  removed: number;
}

/** 409 payload when rollback refuses because records have since been used. */
export interface ImportRollbackBlocked {
  error: string;
  blocked: Array<{ rowNumber: number; name: string; reason: string }>;
}

// ── Query keys ─────────────────────────────────────────────────────────────

export const importKeys = {
  batches: ["imports", "batches"] as const,
  batch: (id: number) => ["imports", "batches", id] as const,
};

// ── Hooks ──────────────────────────────────────────────────────────────────

export const useImportBatches = () =>
  useQuery<{ batches: ImportBatch[] }, Error>({
    queryKey: importKeys.batches,
    queryFn: () => customFetch<{ batches: ImportBatch[] }>("/api/imports/batches", { method: "GET" }),
  });

export const useImportBatch = (id: number | null) =>
  useQuery<{ batch: ImportBatch; rows: ImportRow[] }, Error>({
    queryKey: importKeys.batch(id ?? 0),
    queryFn: () => customFetch<{ batch: ImportBatch; rows: ImportRow[] }>(`/api/imports/batches/${id}`, { method: "GET" }),
    enabled: id != null,
  });

/**
 * Upload a filled template for validation. Sent as a raw body (same pattern as
 * the backup upload) — the server parses the workbook and answers with the
 * batch preview.
 */
export const useParseImportFile = () => {
  const qc = useQueryClient();
  return useMutation<ImportParseResponse, Error, { module: ImportModule; file: File }>({
    mutationFn: ({ module, file }) =>
      customFetch<ImportParseResponse>(
        `/api/imports/parse?module=${module}&filename=${encodeURIComponent(file.name)}`,
        { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file },
      ),
    onSuccess: () => { qc.invalidateQueries({ queryKey: importKeys.batches }); },
  });
};

export const useCommitImportBatch = () => {
  const qc = useQueryClient();
  return useMutation<ImportCommitResponse, Error, { id: number; skipRowIds?: number[]; duplicateAction?: "skip" | "update" }>({
    mutationFn: ({ id, skipRowIds, duplicateAction }) =>
      customFetch<ImportCommitResponse>(`/api/imports/batches/${id}/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skipRowIds: skipRowIds ?? [], duplicateAction: duplicateAction ?? "skip" }),
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: importKeys.batches });
      qc.invalidateQueries({ queryKey: importKeys.batch(vars.id) });
    },
  });
};

export const useRollbackImportBatch = () => {
  const qc = useQueryClient();
  return useMutation<ImportRollbackResponse, Error, { id: number }>({
    mutationFn: ({ id }) =>
      customFetch<ImportRollbackResponse>(`/api/imports/batches/${id}/rollback`, { method: "POST" }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: importKeys.batches });
      qc.invalidateQueries({ queryKey: importKeys.batch(vars.id) });
    },
  });
};

/**
 * Download the pre-filled sample template. Fetched with the auth header and
 * saved as a blob — a bare link would arrive without a token and fail.
 */
export async function downloadImportTemplate(module: ImportModule): Promise<void> {
  const blob = await customFetch<Blob>(`/api/imports/templates/${module}`, {
    method: "GET",
    responseType: "blob",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${module}-import-sample.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
