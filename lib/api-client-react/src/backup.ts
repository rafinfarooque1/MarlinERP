/**
 * Backup & Restore.
 *
 * Every figure here is computed on the server — sizes, checksums, row counts,
 * verification results. The client never decides whether a backup is sound; it
 * displays the server's verdict. Restore in particular returns a step-by-step
 * account of what happened, because "it failed" is not useful when the question
 * is whether the data is still there.
 */
import { useQuery, useMutation, UseQueryOptions } from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";

// ── Types ──────────────────────────────────────────────────────────────────

export type BackupScope = "complete" | "database" | "files" | "settings";
export type BackupTrigger = "manual" | "scheduled" | "pre_restore" | "uploaded";
export type BackupFrequency = "daily" | "weekly" | "monthly" | "manual";
export type BackupRetention = "7" | "30" | "90" | "unlimited";
export type SignatureState = "valid" | "invalid" | "unverifiable";

export interface BackupRecord {
  id: number;
  filename: string;
  scope: BackupScope;
  trigger: BackupTrigger;
  status: "creating" | "ready" | "failed";
  sizeBytes: number;
  sizeLabel: string;
  checksum: string;
  erpVersion: string;
  databaseVersion: string;
  schemaVersion: string;
  gitCommit: string;
  tableCount: number;
  rowCount: number;
  fileCount: number;
  error: string;
  verifiedAt: string | null;
  verifyStatus: "" | "passed" | "failed";
  verifyDetail: string;
  downloadedAt: string | null;
  createdBy: string;
  createdAt: string;
}

export interface BackupAutomatic {
  frequency: BackupFrequency;
  retention: BackupRetention;
  includeFiles: boolean;
  lastRunAt: string | null;
  lastRunStatus: string;
  nextRunAt: string | null;
}

export interface BackupDashboard {
  totalBackups: number;
  failedBackups: number;
  totalSizeBytes: number;
  totalSizeLabel: string;
  latestBackup: BackupRecord | null;
  lastRestore: {
    id: number;
    filename: string;
    status: string;
    scope: string;
    performedBy: string;
    startedAt: string;
    finishedAt: string | null;
    error: string;
  } | null;
  automatic: BackupAutomatic;
  databaseVersion: string;
  databaseSizeBytes: number;
  databaseSizeLabel: string;
  erpVersion: string;
  gitCommit: string;
  fileStorageConfigured: boolean;
}

export interface CheckResult {
  check: string;
  ok: boolean;
  detail: string;
}

export interface RestoreStep {
  step: string;
  ok: boolean;
  detail: string;
}

export interface Finding {
  level: "error" | "warning" | "info";
  message: string;
}

export interface BackupManifest {
  formatVersion: number;
  scope: BackupScope;
  createdAt: string;
  createdBy: string;
  erpVersion: string;
  databaseVersion: string;
  schemaVersion: string;
  gitCommit: string;
  databaseName: string;
  tables?: { table: string; rows: number }[];
  files?: { count: number; bytes: number };
  signature?: { algorithm: string; value: string };
}

export interface CreateBackupResponse {
  id: number;
  filename: string;
  sizeBytes: number;
  sizeLabel: string;
  checksum: string;
  selfCheck: CheckResult[];
  manifest: BackupManifest;
}

export interface ValidationReport {
  ok: boolean;
  scope: BackupScope | null;
  signature: SignatureState;
  findings: Finding[];
  manifest: BackupManifest | null;
}

export interface VerifyReport {
  ok: boolean;
  checks: CheckResult[];
}

export interface RestoreOutcome {
  ok: boolean;
  eventId: number;
  safetyBackupId: number | null;
  steps: RestoreStep[];
  verification: CheckResult[];
  restartRequired: boolean;
}

/**
 * The body returned when a restore fails (HTTP 500), carried on `ApiError.data`.
 *
 * `dataUnchanged` is the field that matters and must never be assumed. The
 * database restore is one transaction, so a failure *there* genuinely changed
 * nothing — but the file and settings steps run after it commits, and a failure
 * after that point leaves part of the restore already applied. The server reports
 * which happened; the UI must not guess.
 */
export interface RestoreFailure {
  error: string;
  eventId: number | null;
  safetyBackupId: number | null;
  steps: RestoreStep[];
  dataUnchanged: boolean;
  restartRequired: boolean;
}

export interface RestoreEvent {
  id: number;
  backupId: number | null;
  source: "stored" | "uploaded";
  filename: string;
  scope: string;
  status: "started" | "completed" | "failed";
  steps: RestoreStep[];
  verification: CheckResult[];
  error: string;
  safetyBackupId: number | null;
  safetyFilename: string;
  performedBy: string;
  ip: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface UploadResponse {
  id: number;
  filename: string;
  sizeBytes: number;
  sizeLabel: string;
  ok: boolean;
  findings: Finding[];
  manifest: BackupManifest;
}

// ── Queries ────────────────────────────────────────────────────────────────

export const getBackupDashboardQueryKey = () => ["/api/backup/dashboard"];

export const useBackupDashboard = (
  options?: { query?: Omit<UseQueryOptions<BackupDashboard, Error>, "queryKey"> },
) =>
  useQuery<BackupDashboard, Error>({
    queryKey: getBackupDashboardQueryKey(),
    queryFn: () => customFetch<BackupDashboard>("/api/backup/dashboard"),
    ...options?.query,
  });

export const getBackupListQueryKey = () => ["/api/backup/list"];

export const useListBackups = (
  options?: { query?: Omit<UseQueryOptions<{ backups: BackupRecord[] }, Error>, "queryKey"> },
) =>
  useQuery<{ backups: BackupRecord[] }, Error>({
    queryKey: getBackupListQueryKey(),
    queryFn: () => customFetch<{ backups: BackupRecord[] }>("/api/backup/list"),
    ...options?.query,
  });

export const getRestoreHistoryQueryKey = () => ["/api/backup/history"];

export const useRestoreHistory = (
  options?: { query?: Omit<UseQueryOptions<{ events: RestoreEvent[] }, Error>, "queryKey"> },
) =>
  useQuery<{ events: RestoreEvent[] }, Error>({
    queryKey: getRestoreHistoryQueryKey(),
    queryFn: () => customFetch<{ events: RestoreEvent[] }>("/api/backup/history"),
    ...options?.query,
  });

export const getBackupSettingsQueryKey = () => ["/api/backup/settings"];

export const useBackupSettings = (
  options?: { query?: Omit<UseQueryOptions<BackupAutomatic, Error>, "queryKey"> },
) =>
  useQuery<BackupAutomatic, Error>({
    queryKey: getBackupSettingsQueryKey(),
    queryFn: () => customFetch<BackupAutomatic>("/api/backup/settings"),
    ...options?.query,
  });

/**
 * The pre-restore validation report. Enabled explicitly, because it is only
 * wanted at the moment the administrator opens a specific archive — fetching it
 * for every row in the list would download and unzip every archive on the server.
 */
export const useValidateBackup = (
  id: number | null,
  options?: { query?: Omit<UseQueryOptions<ValidationReport, Error>, "queryKey"> },
) =>
  useQuery<ValidationReport, Error>({
    queryKey: ["/api/backup/validate", id],
    queryFn: () => customFetch<ValidationReport>(`/api/backup/${id}/validate`),
    enabled: id !== null,
    ...options?.query,
  });

// ── Mutations ──────────────────────────────────────────────────────────────

export const useCreateBackup = () =>
  useMutation<CreateBackupResponse, Error, { scope: BackupScope }>({
    mutationFn: ({ scope }) =>
      customFetch<CreateBackupResponse>("/api/backup/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope }),
      }),
  });

export const useVerifyBackup = () =>
  useMutation<VerifyReport, Error, { id: number }>({
    mutationFn: ({ id }) => customFetch<VerifyReport>(`/api/backup/${id}/verify`, { method: "POST" }),
  });

export const useDeleteBackup = () =>
  useMutation<void, Error, { id: number }>({
    mutationFn: ({ id }) => customFetch<void>(`/api/backup/${id}`, { method: "DELETE" }),
  });

export const useRestoreBackup = () =>
  useMutation<RestoreOutcome, Error, { id: number; password: string; scope: BackupScope }>({
    mutationFn: ({ id, password, scope }) =>
      customFetch<RestoreOutcome>(`/api/backup/${id}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, scope }),
      }),
  });

export const useUpdateBackupSettings = () =>
  useMutation<BackupAutomatic, Error, Partial<Pick<BackupAutomatic, "frequency" | "retention" | "includeFiles">>>({
    mutationFn: (data) =>
      customFetch<BackupAutomatic>("/api/backup/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
  });

/**
 * Upload an archive from the administrator's machine.
 *
 * The file goes STRAIGHT to object storage via a presigned URL rather than
 * through the API server: the published app's front-end rejects any request
 * body over 32 MB with its own bare 413 before the app sees a byte, and a real
 * backup archive is routinely bigger than that. The server issues the
 * destination (an opaque key), the browser PUTs the bytes to the bucket, and
 * the finalize call makes the server pull, inspect and catalogue the archive —
 * so validation is identical to a direct upload.
 */
export const useUploadBackup = () =>
  useMutation<UploadResponse, Error, { file: File }>({
    mutationFn: async ({ file }) => {
      const { key, uploadURL } = await customFetch<{ key: string; uploadURL: string }>(
        "/api/backup/upload-url",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: file.name, size: file.size }),
        },
      );
      const put = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": "application/zip" },
        body: file,
      });
      if (!put.ok) {
        throw new Error(
          "The file could not be uploaded to storage. Check your connection and try again.",
        );
      }
      return customFetch<UploadResponse>("/api/backup/upload/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, filename: file.name }),
      });
    },
  });

/**
 * Download an archive.
 *
 * Fetched with the auth header and turned into a blob rather than pointed at with
 * a plain link: the endpoint is authenticated, so a bare href would arrive without
 * a token and fail. Returns nothing — the browser save dialog is the result.
 */
export async function downloadBackupArchive(id: number, filename: string): Promise<void> {
  const blob = await customFetch<Blob>(`/api/backup/${id}/download`, {
    method: "GET",
    responseType: "blob",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next tick so the click has already been handled.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
